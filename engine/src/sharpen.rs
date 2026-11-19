// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Envelope sharpening after the score model's decoder:
//! each frame's shape about its level widened about the voice's mean shape, the difference
//! from a 5-point moving average added along frames and then along channels (edges repeated),
//! and each frame put back to its power as decoded. A row needs the decoded rows RADIUS either
//! side, so streaming runs RADIUS frames behind the decoder.

use crate::vocoder::N_ENV;
use crate::weights::{err, Result, Weights};

pub const RADIUS: usize = 2;
const WIDTH: f32 = (2 * RADIUS + 1) as f32;

pub struct Sharpen {
    shape: Vec<f32>,  // (speakers, N_ENV) each voice's mean shape
    frames: Vec<f32>, // (speakers) frames it was averaged over; 0: none
    pub widen: f32,
    pub time: f32,
    pub chan: f32,
}

fn lse(x: &[f32]) -> f32 {
    let m = x.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    m + x.iter().map(|v| (v - m).exp()).sum::<f32>().ln()
}

/// x[i] + b (x[i] - the 5-point mean about it, edges repeated).
fn hp(x: &[f32], b: f32, i: usize) -> f32 {
    let mut s = 0.0f32;
    for j in 0..2 * RADIUS + 1 {
        s += x[(i + j).saturating_sub(RADIUS).min(x.len() - 1)];
    }
    x[i] + b * (x[i] - s / WIDTH)
}

impl Sharpen {
    /// From a mean-shape file, for a score model of `speakers` speakers.
    pub fn load(ws: &Weights, speakers: usize, widen: f32, time: f32, chan: f32) -> Result<Sharpen> {
        Sharpen::new(ws.shaped("shape", &[speakers, N_ENV])?.to_vec(), ws.shaped("frames", &[speakers])?.to_vec(), widen, time, chan)
    }

    pub fn new(shape: Vec<f32>, frames: Vec<f32>, widen: f32, time: f32, chan: f32) -> Result<Sharpen> {
        if shape.len() != frames.len() * N_ENV {
            return err(format!("{} shape values for {} speakers", shape.len(), frames.len()));
        }
        for (name, v) in [("widen", widen), ("time", time), ("chan", chan)] {
            if !(v.is_finite() && v >= 0.0) {
                return err(format!("sharpen {name} {v}: a finite number, at least 0"));
            }
        }
        Ok(Sharpen { shape, frames, widen, time, chan })
    }

    pub fn speakers(&self) -> usize {
        self.frames.len()
    }

    /// That this speaker has a mean shape.
    pub fn check(&self, speaker: usize) -> Result<()> {
        match self.frames.get(speaker) {
            None => err(format!("speaker {speaker}: the sharpening has {} speakers", self.speakers())),
            Some(&f) if f <= 0.0 => err(format!("speaker {speaker}: the sharpening has no mean shape for it (the file has none of its frames)")),
            Some(_) => Ok(()),
        }
    }

    /// Appends rows a..b of the sharpened envelope of a `total`-frame utterance to `out`, from
    /// the decoded rows lo..lo + env.len() / N_ENV, which must cover a - RADIUS..b + RADIUS
    /// within 0..total.
    #[allow(clippy::too_many_arguments)]
    pub fn rows(&self, speaker: usize, env: &[f32], lo: usize, a: usize, b: usize, total: usize, out: &mut Vec<f32>) {
        let (wa, wb) = (a.saturating_sub(RADIUS), (b + RADIUS).min(total));
        assert!(lo <= wa && wb <= lo + env.len() / N_ENV && b <= total, "rows {a}..{b} of {total} need {wa}..{wb}, have {lo}..{}", lo + env.len() / N_ENV);
        let mu = &self.shape[speaker * N_ENV..(speaker + 1) * N_ENV];
        let n = wb - wa;
        let mut w = vec![0.0f32; n * N_ENV];
        for t in 0..n {
            let e = &env[(wa + t - lo) * N_ENV..(wa + t - lo + 1) * N_ENV];
            let lv = e.iter().sum::<f32>() / N_ENV as f32;
            for c in 0..N_ENV {
                w[t * N_ENV + c] = lv + mu[c] + self.widen * (e[c] - lv - mu[c]);
            }
        }
        let mut u = [0.0f32; N_ENV];
        for t in a..b {
            // rows clamped to the utterance, as the whole-utterance path sees them
            let i = t - wa;
            for c in 0..N_ENV {
                let mut s = 0.0f32;
                for j in 0..2 * RADIUS + 1 {
                    let k = (t + j).saturating_sub(RADIUS).min(total - 1) - wa;
                    s += w[k * N_ENV + c];
                }
                let v = w[i * N_ENV + c];
                u[c] = v + self.time * (v - s / WIDTH);
            }
            let start = out.len();
            for c in 0..N_ENV {
                out.push(hp(&u, self.chan, c));
            }
            let e = &env[(t - lo) * N_ENV..(t - lo + 1) * N_ENV];
            let d = lse(&out[start..]) - lse(e);
            for v in &mut out[start..] {
                *v -= d;
            }
        }
    }

    /// The whole utterance's envelope (T, N_ENV), sharpened.
    pub fn apply(&self, speaker: usize, env: &[f32]) -> Vec<f32> {
        let t = env.len() / N_ENV;
        let mut out = Vec::with_capacity(env.len());
        self.rows(speaker, env, 0, 0, t, t, &mut out);
        out
    }
}
