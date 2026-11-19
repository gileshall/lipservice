// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Letters to phones: a transformer encoder-decoder, greedy.

use crate::attn::{DecoderLayer, EncoderLayer};
use crate::nn::{LayerNorm, Linear};
use crate::weights::{err, Result, Weights};

pub const LETTERS: &str = "abcdefghijklmnopqrstuvwxyz'-.";
pub const PHONES: [&str; 69] = [
    "AA0", "AA1", "AA2", "AE0", "AE1", "AE2", "AH0", "AH1", "AH2", "AO0", "AO1", "AO2", "AW0", "AW1", "AW2", "AY0", "AY1", "AY2", "B", "CH", "D", "DH", "EH0", "EH1",
    "EH2", "ER0", "ER1", "ER2", "EY0", "EY1", "EY2", "F", "G", "HH", "IH0", "IH1", "IH2", "IY0", "IY1", "IY2", "JH", "K", "L", "M", "N", "NG", "OW0", "OW1", "OW2",
    "OY0", "OY1", "OY2", "P", "R", "S", "SH", "T", "TH", "UH0", "UH1", "UH2", "UW0", "UW1", "UW2", "V", "W", "Y", "Z", "ZH",
];
const BOS: usize = 1;
const EOS: usize = 2;
const MAX_LEN: usize = 40;

pub struct G2p {
    /// The weights file's digest.
    pub digest: u64,
    d: usize,
    src: Vec<f32>,
    tgt: Vec<f32>,
    pe: Vec<f32>,
    max_pos: usize,
    enc: Vec<EncoderLayer>,
    enc_norm: LayerNorm,
    dec: Vec<DecoderLayer>,
    dec_norm: LayerNorm,
    out: Linear,
}

impl G2p {
    pub fn load(ws: &Weights) -> Result<G2p> {
        let s = ws.get("src.weight")?;
        let d = s.shape[1];
        if s.shape[0] != LETTERS.len() + 3 {
            return err(format!("G2P has {} source symbols, expected {}", s.shape[0], LETTERS.len() + 3));
        }
        let ntgt = PHONES.len() + 3;
        let pe = ws.get("pos.pe")?;
        if pe.shape.len() != 2 || pe.shape[0] < MAX_LEN || pe.shape[1] != d {
            return err(format!("pos.pe {:?}: needs at least {MAX_LEN} positions of {d}", pe.shape));
        }
        let mut enc = Vec::new();
        while ws.has(&format!("tf.encoder.layers.{}.norm1.weight", enc.len())) {
            enc.push(EncoderLayer::load(ws, &format!("tf.encoder.layers.{}", enc.len()), d, 4)?);
        }
        let mut dec = Vec::new();
        while ws.has(&format!("tf.decoder.layers.{}.norm1.weight", dec.len())) {
            dec.push(DecoderLayer::load(ws, &format!("tf.decoder.layers.{}", dec.len()), d, 4)?);
        }
        Ok(G2p {
            digest: ws.digest,
            d,
            src: s.data.clone(),
            tgt: ws.shaped("tgt.weight", &[ntgt, d])?.to_vec(),
            pe: pe.data.clone(),
            max_pos: pe.shape[0],
            enc,
            enc_norm: LayerNorm::load(ws, "tf.encoder.norm", d)?,
            dec,
            dec_norm: LayerNorm::load(ws, "tf.decoder.norm", d)?,
            out: Linear::load(ws, "out", ntgt, d)?,
        })
    }

    fn embed(&self, table: &[f32], ids: &[usize]) -> Vec<f32> {
        let d = self.d;
        let mut x = vec![0.0; ids.len() * d];
        for (i, &t) in ids.iter().enumerate() {
            self.embed_at(table, t, i, &mut x[i * d..(i + 1) * d]);
        }
        x
    }

    fn embed_at(&self, table: &[f32], t: usize, pos: usize, x: &mut [f32]) {
        let d = self.d;
        let s = (d as f32).sqrt();
        for c in 0..d {
            x[c] = table[t * d + c] * s + self.pe[pos * d + c];
        }
    }

    pub fn encode_word(word: &str) -> Result<Vec<usize>> {
        word.chars()
            .map(|c| LETTERS.find(c).map(|i| i + 3).ok_or_else(|| crate::weights::Error(format!("{word:?}: {c:?} is outside the G2P alphabet"))))
            .collect()
    }

    pub fn memory(&self, src: &[usize]) -> Vec<f32> {
        let mut m = self.embed(&self.src, src);
        for l in &self.enc {
            l.forward(&mut m, src.len());
        }
        self.enc_norm.forward(&mut m);
        m
    }

    /// Logits for the token after `ys`, from scratch (phones keeps each layer's keys instead).
    pub fn step(&self, mem: &[f32], tm: usize, ys: &[usize]) -> Vec<f32> {
        let t = ys.len();
        let mut x = self.embed(&self.tgt, ys);
        for l in &self.dec {
            l.forward(&mut x, t, mem, tm);
        }
        self.dec_norm.forward(&mut x);
        let mut logits = vec![0.0; self.out.cout];
        self.out.forward(&x[(t - 1) * self.d..], 1, &mut logits);
        logits
    }

    pub fn phones(&self, word: &str) -> Result<Vec<&'static str>> {
        let src = G2p::encode_word(word)?;
        if src.is_empty() || src.len() > self.max_pos {
            return err(format!("{word:?}: {} letters, the G2P takes 1 to {}", src.len(), self.max_pos));
        }
        let mem = self.memory(&src);
        let mut caches: Vec<_> = self.dec.iter().map(|l| l.cache(&mem, src.len())).collect();
        let (mut y, mut x) = (BOS, vec![0.0; self.d]);
        let mut logits = vec![0.0; self.out.cout];
        let mut out = Vec::new();
        for pos in 0..MAX_LEN {
            self.embed_at(&self.tgt, y, pos, &mut x);
            for (l, c) in self.dec.iter().zip(&mut caches) {
                l.step(&mut x, c);
            }
            self.dec_norm.forward(&mut x);
            self.out.forward(&x, 1, &mut logits);
            let l = &logits;
            let (best, _) = l.iter().enumerate().fold((0, f32::NEG_INFINITY), |a, (i, &v)| if v > a.1 { (i, v) } else { a });
            if best == EOS {
                return Ok(out);
            }
            if best < 3 {
                return err(format!("{word:?}: G2P produced special token {best}"));
            }
            out.push(PHONES[best - 3]);
            y = best;
        }
        err(format!("{word:?}: G2P gave no end within {MAX_LEN} phones"))
    }
}
