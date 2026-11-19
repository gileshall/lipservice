// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A long text said a part at a time. Its pieces are cut after a sentence's stop (full stop,
//! question or exclamation) that breaks of CUT_MS or more follow before more words: a `<p>`'s end in
//! SSML, a blank line in plain text (ssml::plain). Each part is its own utterance, streamed in turn
//! (Stream::inflected), the breaks between them silence (`gap`). The whole text is read first, so an
//! error anywhere comes before any sound; the score model takes one part at a time, so the first
//! sound comes as soon for a long passage as for a short one, and each part is an utterance of the
//! length the models know. Part k draws with seed + k, its pitch too. Given a break model and a
//! rate, each part is phrased (Inflection::phrase). A passage of one part is Stream::inflected,
//! sample for sample.

use std::collections::VecDeque;

use crate::breaks::Breaks;
use crate::dsp::SR;
use crate::front::Phonemizer;
use crate::inflect::Inflection;
use crate::score::{Pitch, ScoreModel};
use crate::sharpen::Sharpen;
use crate::ssml::Piece;
use crate::stream::{Render, Stream};
use crate::weights::{err, Result};

/// The least break, in milliseconds, that cuts a passage.
pub const CUT_MS: f32 = 700.0;
/// Samples over which a gap leaves a part's last sample and meets the next's first: neither need
/// be 0, and a step clicks.
pub const RAMP: usize = 192;

/// n samples of silence between a part ending on `from` and one starting at `to`: raised-cosine
/// ramps of RAMP samples from `from` down to 0 and from 0 up to `to`.
pub fn gap(n: usize, from: f32, to: f32) -> Vec<f32> {
    assert!(n >= 2 * RAMP, "a gap of {n} samples is too short for its ramps");
    let w = |i: usize| 0.5 + 0.5 * (std::f32::consts::PI * (i + 1) as f32 / (RAMP + 1) as f32).cos();
    let mut g = vec![0.0; n];
    for i in 0..RAMP {
        g[i] = from * w(i);
        g[n - 1 - i] = to * w(i);
    }
    g
}

/// The pieces cut into parts, at least one, each with the milliseconds of silence before it (0 for
/// the first).
pub fn cut(pieces: &[Piece]) -> Vec<(f32, &[Piece])> {
    let mut out = Vec::new();
    let (mut start, mut gap, mut i) = (0, 0.0, 0);
    while i < pieces.len() {
        if matches!(pieces[i], Piece::Stop("." | "?" | "!")) {
            let mut j = i + 1;
            let mut ms = 0.0;
            while let Some(Piece::Break(b)) = pieces.get(j) {
                ms += b;
                j += 1;
            }
            if ms >= CUT_MS && pieces[j..].iter().any(|p| matches!(p, Piece::Word { .. })) {
                out.push((gap, &pieces[start..=i]));
                (start, gap, i) = (j, ms, j);
                continue;
            }
        }
        i += 1;
    }
    out.push((gap, &pieces[start..]));
    out
}

pub struct Passage<'m> {
    score: &'m ScoreModel,
    render: Render<'m>,
    speaker: usize,
    rate: f32,
    shift: f32,
    pitch: Pitch<'m>,
    seed: u64,
    sharpen: Option<&'m Sharpen>,
    todo: VecDeque<(f32, Inflection)>,
    started: usize,
    cur: Stream<'m>,
    /// The part being said, and the samples of silence before it.
    inf: Inflection,
    gap: usize,
    last: f32,
}

impl<'m> Passage<'m> {
    /// Reads every part and starts the first; the arguments as for Stream::inflected, `phrase` a
    /// break model and the share of word gaps to break at, and `pace` Inflection::pace.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        score: &'m ScoreModel,
        render: Render<'m>,
        ph: &mut Phonemizer,
        pieces: &[Piece],
        speaker: usize,
        rate: f32,
        shift: f32,
        pitch: Pitch<'m>,
        seed: u64,
        sharpen: Option<&'m Sharpen>,
        phrase: Option<(&Breaks, f32)>,
        pace: f32,
    ) -> Result<Passage<'m>> {
        let mut todo = cut(pieces)
            .into_iter()
            .map(|(ms, p)| {
                let mut inf = Inflection::new(ph, p)?;
                if let Some((b, rate)) = phrase {
                    inf.phrase(b, rate)?;
                }
                inf.pace = pace;
                Ok((ms, inf))
            })
            .collect::<Result<VecDeque<_>>>()?;
        let (_, first) = todo.pop_front().expect("cut gives a part");
        let cur = Stream::inflected(score, render, &first, speaker, rate, shift, pitch, seed, sharpen)?;
        Ok(Passage { score, render, speaker, rate, shift, pitch, seed, sharpen, todo, started: 1, cur, inf: first, gap: 0, last: 0.0 })
    }

    /// Parts in the passage.
    pub fn parts(&self) -> usize {
        self.started + self.todo.len()
    }

    /// The part being said, from 0.
    pub fn part(&self) -> usize {
        self.started - 1
    }

    /// The part being said.
    pub fn stream(&self) -> &Stream<'m> {
        &self.cur
    }

    /// The part being said, as read.
    pub fn inflection(&self) -> &Inflection {
        &self.inf
    }

    /// Samples of silence before the part being said (0 for the first).
    pub fn gap(&self) -> usize {
        self.gap
    }

    /// All audio given.
    pub fn done(&self) -> bool {
        self.todo.is_empty() && self.cur.done()
    }

    /// Lets in up to n more frames of the part being said and appends the audio they finish to
    /// `out`; once it is done, starts the next part and appends the gap before it and its first
    /// audio.
    pub fn step(&mut self, n: usize, out: &mut Vec<f32>) -> Result<()> {
        if !self.cur.done() {
            let at = out.len();
            self.cur.step(n, out);
            if out.len() > at {
                self.last = out[out.len() - 1];
            }
            return Ok(());
        }
        let Some((ms, inf)) = self.todo.pop_front() else {
            return Ok(());
        };
        let k = self.started as u64;
        let pitch = match self.pitch {
            Pitch::Flow(f, s) => Pitch::Flow(f, crate::pitchflow::Sampling { seed: s.seed.wrapping_add(k), ..s }),
            Pitch::Head => Pitch::Head,
        };
        self.cur = Stream::inflected(
            self.score,
            self.render,
            &inf,
            self.speaker,
            self.rate,
            self.shift,
            pitch,
            self.seed.wrapping_add(k),
            self.sharpen,
        )?;
        self.started += 1;
        self.inf = inf;
        self.gap = (ms * SR as f32 / 1000.0).round() as usize;
        let mut first = Vec::new();
        while first.is_empty() && !self.cur.done() {
            self.cur.step(n, &mut first);
        }
        if first.is_empty() {
            return err(format!("part {k} gave no audio"));
        }
        out.extend(gap(self.gap, self.last, first[0]));
        out.extend_from_slice(&first);
        self.last = first[first.len() - 1];
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssml::{pieces, plain};

    fn shape(ps: &[Piece]) -> Vec<(f32, String)> {
        cut(ps)
            .into_iter()
            .map(|(ms, p)| {
                let w: Vec<String> = p
                    .iter()
                    .map(|p| match p {
                        Piece::Word { text, .. } => text.clone(),
                        Piece::Stop(s) => s.to_string(),
                        Piece::Break(ms) => format!("<{ms}>"),
                    })
                    .collect();
                (ms, w.join(" "))
            })
            .collect()
    }

    #[test]
    fn cuts_at_paragraphs() {
        let s = |a: f32, b: &str| (a, b.to_string());
        assert_eq!(shape(&plain("One two.").unwrap()), [s(0.0, "one two .")]);
        assert_eq!(shape(&plain("One\ntwo").unwrap()), [s(0.0, "one two")]);
        assert_eq!(
            shape(&plain("\nOne two\n\n  \nThree? Four.\r\n\r\nFive\n\n").unwrap()),
            [s(0.0, "one two ."), s(700.0, "three ? four ."), s(700.0, "five")]
        );
        assert_eq!(
            shape(&pieces("<speak><p>One two.</p><p>Three, four</p></speak>").unwrap()),
            [s(0.0, "one two ."), s(700.0, "three , four . <700>")]
        );
        // a paragraph ending on a colon stays with the next
        assert_eq!(shape(&plain("Friends:\n\nHello.").unwrap()), [s(0.0, "friends : <700> hello .")]);
        // breaks after a sentence's stop add up; inside a sentence, or under 700 ms, no cut
        assert_eq!(
            shape(&pieces("<speak>One.<break time=\"500ms\"/><break time=\"1s\"/>Two,<break time=\"2s\"/>three.<break strength=\"medium\"/>Four.</speak>").unwrap()),
            [s(0.0, "one ."), s(1500.0, "two , <2000> three . <400> four .")]
        );
        assert_eq!(shape(&pieces("<speak><break time=\"1s\"/>One.</speak>").unwrap()), [s(0.0, "<1000> one .")]);
    }
}
