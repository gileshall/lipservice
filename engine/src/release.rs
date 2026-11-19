// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The release channel: every voiceless stop at a word's end told a
//! strong release on its frames, and a voiced one at a sentence's end a weaker one, through a 3-wide convolution added to the mel decoder's input
//! beside the pitch's. It has no bias, so an untold frame is the decoder's own. One for every voice,
//! in the mel route's file under rel.; a voice's own decoder takes it.

use crate::front;
use crate::nn::Conv1d;
use crate::weights::{err, Result, Weights};

/// The release told, dB, and its scale on the channel.
const TOLD: f32 = 45.0;
const SCALE: f32 = 20.0;
const STOPS: [&str; 3] = ["P", "T", "K"];
const VOICED: [&str; 3] = ["B", "D", "G"];
const VOICED_TOLD: f32 = 20.0;

/// Whether the tokens after `i` reach a sentence's end ('.', '?', '!' or the end) before the next phone.
fn at_end(tok: &[usize], i: usize) -> bool {
    let first_phone = 4 + front::STOPS.len();
    for &n in &tok[i + 1..] {
        if n >= first_phone {
            return false;
        }
        if n == front::EOS || [".", "?", "!"].contains(&front::symbol(n)) {
            return true;
        }
    }
    true
}

pub struct Release {
    emb: Conv1d,
}

impl Release {
    /// The channel from its tensors, the rel. prefix taken off: emb (dim, 2, 3) and a zero bias.
    pub fn load(ws: &Weights, dim: usize) -> Result<Release> {
        if ws.shaped("emb.bias", &[dim])?.iter().any(|&b| b != 0.0) {
            return err("rel.emb.bias: not zero; the channel must leave untold frames alone");
        }
        let emb = Conv1d::load(ws, "emb", dim, 2, 3)?;
        Ok(Release { emb })
    }

    pub fn dim(&self) -> usize {
        self.emb.cout()
    }

    /// Its input rows, two a frame: 1 and TOLD / SCALE on a word-final voiceless stop's frames
    /// (the next token not a phone), 1 and VOICED_TOLD / SCALE on a word-final voiced stop's at a
    /// sentence's end, 0 elsewhere.
    pub fn told(tok: &[usize], durations: &[usize]) -> Vec<f32> {
        assert_eq!(tok.len(), durations.len());
        let first_phone = 4 + front::STOPS.len();
        let mut out = Vec::with_capacity(2 * durations.iter().sum::<usize>());
        for (i, &d) in durations.iter().enumerate() {
            let s = front::symbol(tok[i]);
            let fin = tok.get(i + 1).map_or(true, |&n| n < first_phone);
            let row = if fin && STOPS.contains(&s) {
                [1.0, TOLD / SCALE]
            } else if fin && VOICED.contains(&s) && at_end(tok, i) {
                [1.0, VOICED_TOLD / SCALE]
            } else {
                [0.0, 0.0]
            };
            for _ in 0..d {
                out.extend_from_slice(&row);
            }
        }
        out
    }

    /// Adds the channel's output rows [from, from + n) of `told` (t rows) onto x.
    pub(crate) fn add_rows(&self, told: &[f32], t: usize, from: usize, n: usize, x: &mut [f32]) {
        let mut e = vec![0.0; x.len()];
        self.emb.forward_rows(told, t, from, n, &mut e);
        for (a, b) in x.iter_mut().zip(&e) {
            *a += b;
        }
    }

    pub fn radius(&self) -> usize {
        self.emb.radius()
    }
}

#[cfg(test)]
mod tests {
    use super::Release;
    use crate::front::{symbol_id, BOS, EOS, SPACE};

    #[test]
    fn a_word_final_voiceless_stop_is_told() {
        let id = |s: &str| symbol_id(s).unwrap();
        // ^ K AE1 T ' ' S T AA1 P , ' ' T $ : cat stop, t
        let tok = [BOS, id("K"), id("AE1"), id("T"), SPACE, id("S"), id("T"), id("AA1"), id("P"), id(","), SPACE, id("T"), EOS];
        let durations = [1, 2, 3, 2, 1, 2, 2, 3, 2, 1, 1, 2, 1];
        let told = Release::told(&tok, &durations);
        let got: String = told.chunks_exact(2).map(|r| if r[0] == 1.0 { 'x' } else { '.' }).collect();
        assert_eq!(got, "......xx........xx..xx.");
        assert!(told.chunks_exact(2).all(|r| r[1] == if r[0] == 1.0 { 45.0 / 20.0 } else { 0.0 }));
    }

    #[test]
    fn a_voiced_stop_is_told_only_at_a_sentences_end() {
        let id = |s: &str| symbol_id(s).unwrap();
        // ^ B AE1 D , ' ' G UH1 D ' ' D AO1 G . ' ' B IH1 G ? $ : bad, good dog. big?
        let tok = [
            BOS, id("B"), id("AE1"), id("D"), id(","), SPACE, id("G"), id("UH1"), id("D"), SPACE, id("D"), id("AO1"), id("G"), id("."),
            SPACE, id("B"), id("IH1"), id("G"), id("?"), EOS,
        ];
        let durations = [1; 20];
        let told = Release::told(&tok, &durations);
        let got: String = told.chunks_exact(2).map(|r| if r[0] == 1.0 { 'x' } else { '.' }).collect();
        assert_eq!(got, "............x....x..");
        assert!(told.chunks_exact(2).all(|r| r[1] == if r[0] == 1.0 { 20.0 / 20.0 } else { 0.0 }));
    }
}
