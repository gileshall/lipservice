// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A voice's pauses as its speaker's. A mel decoder's pause is its mean, too steady, and Vocos rings
//! on a steady mel: tonal lines and roughness that recordings' pauses lack. The quiet frames of
//! non-word tokens (under the voice's speech level less GATE dB, and no brighter than the speaker's
//! quiet frames, so that a sibilant's or a burst's tail is not quiet; in runs of MIN or more) take a
//! loop of the speaker's own quiet frames, read from an offset drawn per run
//! on the seed, eased in and out over EASE frames, or SHORT_EASE in runs under SHORT.

use crate::front::{PAD, STOPS};
use crate::melvoc::N_MEL;
use crate::weights::{err, Result, Weights};

/// dB under the voice's speech level that a pause frame is quiet below.
pub const GATE: f32 = 25.0;
/// The least quiet frames in a run that take the loop.
pub const MIN: usize = 3;
/// Runs under SHORT frames ease in and out over SHORT_EASE frames, the rest over EASE.
pub const SHORT: usize = 8;
pub const SHORT_EASE: usize = 1;
pub const EASE: usize = 3;
/// Frames past a frame that settle it: whether its run is MIN or SHORT long, and its end if within
/// its ease.
pub const LOOK: usize = SHORT - 1;
/// Mel bands a group. A quiet frame's groups from FROM up (776 Hz up: the lowest holds no sibilant or
/// burst) each stand over its level by no more than the loop's frames' do at their CEIL quantile.
pub const GROUP: usize = 25;
pub const FROM: usize = 1;
pub const CEIL: f32 = 0.9;
const _: () = assert!(MIN <= SHORT && LOOK >= EASE && SHORT_EASE <= EASE && N_MEL % GROUP == 0 && FROM < N_MEL / GROUP);

/// A loop of a speaker's quiet frames (ln magnitude mel), its speech level and its ceilings.
pub struct PauseBank {
    frames: Vec<f32>,
    n: usize,
    level: f32,
    ceil: Vec<f32>,
}

impl PauseBank {
    /// From a voice file's pause. tensors: loop (int8, frames by N_MEL), lo and step (per band;
    /// a frame is lo + step * (q + 128)), level (dB, mel::level of its speech, the median over its
    /// recordings of their 95th percentile).
    pub fn load(ws: &Weights) -> Result<PauseBank> {
        let shape = &ws.get("loop")?.shape;
        if shape.len() != 2 || shape[1] != N_MEL || shape[0] < 2 * (EASE + 1) {
            return err(format!("pause.loop: shape {shape:?}, expected at least {} frames by {N_MEL}", 2 * (EASE + 1)));
        }
        let n = shape[0];
        let q = ws.shaped_i8("loop", &[n, N_MEL])?;
        let (lo, step) = (ws.shaped("lo", &[N_MEL])?, ws.shaped("step", &[N_MEL])?);
        let speech = ws.shaped("level", &[1])?[0];
        if !speech.is_finite() || lo.iter().any(|v| !v.is_finite()) || step.iter().any(|&s| !(s > 0.0 && s.is_finite())) {
            return err("pause.level, lo and step must be finite, step above 0");
        }
        let frames: Vec<f32> = q
            .chunks_exact(N_MEL)
            .flat_map(|r| r.iter().zip(lo).zip(step).map(|((&q, &l), &s)| l + s * (q as f32 + 128.0)))
            .collect();
        // nearest rank
        let k = (CEIL * (n - 1) as f32).round() as usize;
        let ceil = (FROM..N_MEL / GROUP)
            .map(|g| {
                let mut lv: Vec<f32> = frames.chunks_exact(N_MEL).map(|r| level(&r[g * GROUP..(g + 1) * GROUP]) - level(r)).collect();
                lv.sort_by(f32::total_cmp);
                lv[k]
            })
            .collect();
        Ok(PauseBank { frames, n, level: speech, ceil })
    }

    /// Whether a mel row is quiet: under the speech level less GATE, and each group of bands from
    /// FROM up over the row's level by no more than the group's ceiling.
    pub fn quiet(&self, row: &[f32]) -> bool {
        let lv = level(row);
        lv < self.level - GATE && row.chunks_exact(GROUP).skip(FROM).zip(&self.ceil).all(|(g, &c)| level(g) - lv <= c)
    }

    /// The ceilings of the groups from FROM up: dB over a frame's level.
    pub fn ceilings(&self) -> &[f32] {
        &self.ceil
    }

    /// Frames in the loop.
    pub fn frames(&self) -> usize {
        self.n
    }

    /// The speech level the gate is under, dB.
    pub fn level(&self) -> f32 {
        self.level
    }

    /// The loop's frame k (k taken round the loop).
    pub fn row(&self, k: usize) -> &[f32] {
        &self.frames[(k % self.n) * N_MEL..][..N_MEL]
    }
}

/// A mel row's level, dB: 10 log10 of its mean power (the row is ln magnitude).
pub fn level(row: &[f32]) -> f32 {
    10.0 * (row.iter().map(|&m| (2.0 * m).exp()).sum::<f32>() / row.len() as f32).log10()
}

/// Per frame, whether it is in a non-word token (a stop, a word gap, the start or the end).
pub fn pause_frames(tokens: &[usize], durations: &[usize]) -> Vec<bool> {
    assert_eq!(tokens.len(), durations.len());
    tokens
        .iter()
        .zip(durations)
        .flat_map(|(&t, &d)| std::iter::repeat_n(t != PAD && t < 4 + STOPS.len(), d))
        .collect()
}

/// The loop's offset for a run starting at frame `start` (splitmix64).
fn offset(seed: u64, start: usize, n: usize) -> usize {
    let mut z = seed ^ (start as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    ((z ^ (z >> 31)) % n as u64) as usize
}

/// The bank on one utterance's mel, frames taken as they are decoded.
pub struct Pauses<'m> {
    bank: &'m PauseBank,
    pause: Vec<bool>,
    quiet: Vec<bool>,
    seed: u64,
}

impl<'m> Pauses<'m> {
    /// `pause` from pause_frames, a flag a frame of the utterance.
    pub fn new(bank: &'m PauseBank, pause: Vec<bool>, seed: u64) -> Pauses<'m> {
        let quiet = Vec::with_capacity(pause.len());
        Pauses { bank, pause, quiet, seed }
    }

    /// The next frames' rows, as decoded (after any gain).
    pub fn see(&mut self, rows: &[f32]) {
        for r in rows.chunks_exact(N_MEL) {
            let f = self.quiet.len();
            self.quiet.push(self.pause[f] && self.bank.quiet(r));
        }
    }

    /// Frames settled: those seen less LOOK, or all once the last is seen.
    pub fn ready(&self) -> usize {
        if self.quiet.len() == self.pause.len() {
            self.quiet.len()
        } else {
            self.quiet.len().saturating_sub(LOOK)
        }
    }

    /// Rows of settled frames from `from` on, with the loop in their quiet runs.
    pub fn apply(&self, rows: &mut [f32], from: usize) {
        let n = rows.len() / N_MEL;
        assert!(from + n <= self.ready(), "frames {from}..{} of {} settled", from + n, self.ready());
        for (i, r) in rows.chunks_exact_mut(N_MEL).enumerate() {
            let f = from + i;
            if !self.quiet[f] {
                continue;
            }
            let mut s = f;
            while s > 0 && self.quiet[s - 1] {
                s -= 1;
            }
            let mut e = f + 1;
            while e < self.quiet.len() && self.quiet[e] {
                e += 1;
            }
            if e - s < MIN {
                continue;
            }
            let ease = if e - s < SHORT { SHORT_EASE } else { EASE };
            let w = ((f - s + 1).min(e - f) as f32 / (ease + 1) as f32).min(1.0);
            let b = self.bank.row(offset(self.seed, s, self.bank.n) + f - s);
            for (x, &y) in r.iter_mut().zip(b) {
                *x += w * (y - *x);
            }
        }
    }
}

/// The bank on a whole utterance's mel: as Pauses frame by frame.
pub fn whole(bank: &PauseBank, tokens: &[usize], durations: &[usize], seed: u64, mel: &mut [f32]) -> Result<()> {
    let pause = pause_frames(tokens, durations);
    if pause.len() * N_MEL != mel.len() {
        return err(format!("{} frames of tokens, {} of mel", pause.len(), mel.len() / N_MEL));
    }
    let mut p = Pauses::new(bank, pause, seed);
    p.see(mel);
    p.apply(mel, 0);
    Ok(())
}
