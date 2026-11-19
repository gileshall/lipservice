// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The flow-matching pitch and voicing predictor: a track of
//! (normalized log F0, voicing as -1 or 1) per frame, from noise by a few steps of an ODE solver,
//! conditioned on the expanded token states and each frame's place in its phone.

use crate::nn::{ConvNeXt, Linear};
use crate::rng::Rng;
use crate::vocoder::{LF0_MU, LF0_SD};
use crate::weights::{err, Result, Weights};
use std::sync::Arc;

/// A pitch flow, which its clones share.
#[derive(Clone)]
pub struct PitchFlow(Arc<Parts>);

impl std::ops::Deref for PitchFlow {
    type Target = Parts;

    fn deref(&self) -> &Parts {
        &self.0
    }
}

pub struct Parts {
    pub(crate) cond_dim: usize,
    pub(crate) dim: usize,
    pub(crate) cond: Linear,
    pub(crate) x_in: Linear,
    t_freq: Vec<f32>,
    t_in: [Linear; 2],
    pub(crate) blocks: Vec<ConvNeXt>,
    out: Linear,
}

/// How a track is drawn: the solver and its steps, the noise's scale and its seed, the frames
/// over which the log F0 noise's mean is taken out (0, none), and its widening (None, none).
#[derive(Clone, Copy, Debug)]
pub struct Sampling {
    pub solver: Solver,
    pub steps: usize,
    pub temp: f32,
    pub seed: u64,
    pub slow: usize,
    pub widen: Option<Widen>,
}

/// The drawn log F0 scaled `by` times about `centre`, frame by frame: big shape and fine movement
/// alike, the median kept where the centre is the voice's.
#[derive(Clone, Copy, Debug)]
pub struct Widen {
    pub by: f32,
    /// Natural log Hz, before any shift: the median of the voice's drawn voiced log F0
    /// (voice.centre).
    pub centre: f32,
}

/// How far the voices' draws are widened: with the noise's mean over SLOW frames taken out, this
/// brings a draw's slow part to the readers' spread (the span lines' slow SD), the same for every voice.
pub const WIDEN: f32 = 1.85;

/// The frames over which the log F0 noise's mean is taken out by default: the draw keeps its fine
/// movement and its slow shape and its glides inside vowels come near the flow's mean.
pub const SLOW: usize = 10;

impl Default for Sampling {
    fn default() -> Sampling {
        Sampling { solver: Solver::Euler, steps: 8, temp: 1.0, seed: 0, slow: SLOW, widen: None }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Solver {
    /// x + v(x, t) / steps a step, as the flow was trained.
    Euler,
    /// x + v(x + v(x, t) / 2 steps, t + 1 / 2 steps) / steps: two evaluations a step, its error
    /// falling with the square of the steps.
    Midpoint,
}

/// One velocity evaluation of a draw: its time, whether its update starts from the evaluation
/// before's input in place of its own, and what its velocity is divided by.
pub(crate) struct Eval {
    pub time: f32,
    pub from_prev: bool,
    pub div: f32,
}

impl Sampling {
    pub fn check(&self) -> Result<()> {
        if self.steps == 0 {
            return err("the pitch flow needs at least one step");
        }
        if !(self.temp >= 0.0 && self.temp.is_finite()) {
            return err(format!("pitch temperature {} must be finite and not negative", self.temp));
        }
        if let Some(w) = self.widen {
            if !(w.by > 0.0 && w.by.is_finite()) {
                return err(format!("pitch widening {}: finite and over 0", w.by));
            }
            if !(3.0..7.0).contains(&w.centre) {
                return err(format!("pitch centre {}: a natural log of Hz, 3 to 7", w.centre));
            }
        }
        Ok(())
    }

    /// A drawn (normalized) log F0, widened.
    pub fn spread(&self, v: f32) -> f32 {
        match self.widen {
            None => v,
            Some(w) => {
                let c = (w.centre - LF0_MU) / LF0_SD;
                c + w.by * (v - c)
            }
        }
    }

    /// The starting noise (T, 2), scaled by temp; its own stream, apart from the vocoder's. With
    /// slow, each frame's log F0 noise less its mean over the slow frames centred on it (fewer at
    /// the ends).
    pub fn noise(&self, t: usize) -> Vec<f32> {
        let mut x = Rng::stream(self.seed, 1).gaussian(t * 2);
        if self.slow > 0 {
            let mut sum = vec![0.0f64; t + 1];
            for f in 0..t {
                sum[f + 1] = sum[f] + x[2 * f] as f64;
            }
            for f in 0..t {
                let (a, b) = (f.saturating_sub(self.slow / 2), (f + self.slow / 2 + 1).min(t));
                x[2 * f] -= ((sum[b] - sum[a]) / (b - a) as f64) as f32;
            }
        }
        x.iter_mut().for_each(|v| *v *= self.temp);
        x
    }

    /// Step i's time, as torch has it: i / steps in double, then single.
    pub(crate) fn time(&self, i: usize) -> f32 {
        (i as f64 / self.steps as f64) as f32
    }

    /// The evaluations of a draw, in order.
    pub(crate) fn evals(&self) -> Vec<Eval> {
        let n = self.steps as f32;
        let half = |i: usize| ((i as f64 + 0.5) / self.steps as f64) as f32;
        (0..self.steps)
            .flat_map(|i| match self.solver {
                Solver::Euler => vec![Eval { time: self.time(i), from_prev: false, div: n }],
                Solver::Midpoint => vec![
                    Eval { time: self.time(i), from_prev: false, div: 2.0 * n },
                    Eval { time: half(i), from_prev: true, div: n },
                ],
            })
            .collect()
    }
}

/// Each frame's place in its phone, 0 to 1, and log(1 + the phone's frames): (T, 2).
pub fn place(dur: &[usize]) -> Vec<f32> {
    let mut out = Vec::with_capacity(dur.iter().sum::<usize>() * 2);
    for &n in dur {
        for j in 0..n {
            out.push((j as f32 + 0.5) / n as f32);
            out.push((n as f32).ln_1p());
        }
    }
    out
}

impl PitchFlow {
    pub fn load(ws: &Weights) -> Result<PitchFlow> {
        let c = ws.get("cond.weight")?;
        if c.shape.len() != 2 || c.shape[1] < 3 {
            return err(format!("cond.weight is {:?}, not (dim, cond_dim + 2)", c.shape));
        }
        let (dim, cond_dim) = (c.shape[0], c.shape[1] - 2);
        let k = ws.get("blocks.blocks.0.dw.weight")?.shape.last().copied().unwrap_or(0);
        let mut blocks = Vec::new();
        while ws.has(&format!("blocks.blocks.{}.gamma", blocks.len())) {
            blocks.push(ConvNeXt::load(ws, &format!("blocks.blocks.{}", blocks.len()), dim, 3, k)?);
        }
        if blocks.is_empty() {
            return err("no blocks under blocks.blocks");
        }
        let t_freq = ws.get("t_freq")?;
        let nf = t_freq.data.len();
        Ok(PitchFlow(Arc::new(Parts {
            cond_dim,
            dim,
            cond: Linear::load(ws, "cond", dim, cond_dim + 2)?,
            x_in: Linear::load(ws, "x_in", dim, 2)?,
            t_freq: ws.shaped("t_freq", &[1, nf])?.to_vec(),
            t_in: [Linear::load(ws, "t_in.0", dim, 2 * nf)?, Linear::load(ws, "t_in.2", dim, dim)?],
            blocks,
            out: Linear::load(ws, "out", 2, dim)?,
        })))
    }

    /// The width of the token states it was trained on.
    pub fn cond_dim(&self) -> usize {
        self.cond_dim
    }

    /// The embedding of time t (dim).
    pub(crate) fn time(&self, t: f32) -> Vec<f32> {
        let a: Vec<f32> = self.t_freq.iter().map(|f| t * f).collect();
        let x: Vec<f32> = a.iter().map(|v| v.sin()).chain(a.iter().map(|v| v.cos())).collect();
        let mut h = vec![0.0; self.dim];
        self.t_in[0].forward(&x, 1, &mut h);
        h.iter_mut().for_each(|v| *v /= 1.0 + (-*v).exp());
        let mut out = vec![0.0; self.dim];
        self.t_in[1].forward(&h, 1, &mut out);
        out
    }

    /// The condition's projection (T, dim) from expanded token states hx (T, cond_dim) and place (T, 2).
    pub(crate) fn condition(&self, hx: &[f32], place: &[f32], t: usize) -> Vec<f32> {
        let cd = self.cond_dim;
        let mut c = Vec::with_capacity(t * (cd + 2));
        for i in 0..t {
            c.extend_from_slice(&hx[i * cd..(i + 1) * cd]);
            c.extend_from_slice(&place[i * 2..i * 2 + 2]);
        }
        let mut out = vec![0.0; t * self.dim];
        self.cond.forward(&c, t, &mut out);
        out
    }

    /// The blocks' input: cond + x_in(x) + te, (T, dim).
    pub(crate) fn input(&self, cond: &[f32], x: &[f32], te: &[f32], t: usize) -> Vec<f32> {
        let mut y = vec![0.0; t * self.dim];
        self.x_in.forward(x, t, &mut y);
        for i in 0..t {
            for c in 0..self.dim {
                let k = i * self.dim + c;
                y[k] = cond[k] + y[k] + te[c];
            }
        }
        y
    }

    /// The update x + v / div from the blocks' last rows, in place on x (T, 2).
    pub(crate) fn update(&self, h: &[f32], t: usize, div: f32, x: &mut [f32]) {
        let mut v = vec![0.0; t * 2];
        self.out.forward(h, t, &mut v);
        for (a, b) in x.iter_mut().zip(&v) {
            *a += b / div;
        }
    }

    /// A track (T, 2) from token states h (N, cond_dim) and durations, from x0 (T, 2), the noise
    /// already scaled by temp.
    pub fn sample_from(&self, h: &[f32], dur: &[usize], x0: &[f32], s: &Sampling) -> Result<Vec<f32>> {
        s.check()?;
        let t: usize = dur.iter().sum();
        if h.len() != dur.len() * self.cond_dim {
            return err(format!("{} token state values for {} tokens of {}", h.len(), dur.len(), self.cond_dim));
        }
        if x0.len() != t * 2 {
            return err(format!("{} noise values for {t} frames", x0.len()));
        }
        let cd = self.cond_dim;
        let mut hx = Vec::with_capacity(t * cd);
        for (i, &k) in dur.iter().enumerate() {
            for _ in 0..k {
                hx.extend_from_slice(&h[i * cd..(i + 1) * cd]);
            }
        }
        let cond = self.condition(&hx, &place(dur), t);
        let (mut x, mut prev) = (x0.to_vec(), x0.to_vec());
        for e in s.evals() {
            let mut y = self.input(&cond, &x, &self.time(e.time), t);
            for b in &self.blocks {
                b.forward(&mut y, t);
            }
            let mut next = if e.from_prev { prev } else { x.clone() };
            self.update(&y, t, e.div, &mut next);
            prev = std::mem::replace(&mut x, next);
        }
        Ok(x)
    }

    /// A track (T, 2), its noise from s.
    pub fn sample(&self, h: &[f32], dur: &[usize], s: &Sampling) -> Result<Vec<f32>> {
        self.sample_from(h, dur, &s.noise(dur.iter().sum()), s)
    }
}

#[cfg(test)]
mod tests {
    use super::{Sampling, Widen};

    #[test]
    fn slow_takes_the_log_f0_noise_mean_out_and_leaves_the_voicing() {
        let t = 40;
        let raw = Sampling { slow: 0, temp: 0.5, seed: 7, ..Default::default() }.noise(t);
        let got = Sampling { slow: 5, temp: 0.5, seed: 7, ..Default::default() }.noise(t);
        for f in 0..t {
            let (a, b) = (f.saturating_sub(2), (f + 3).min(t));
            let m = (a..b).map(|g| raw[2 * g] as f64).sum::<f64>() / (b - a) as f64;
            assert!((got[2 * f] as f64 - (raw[2 * f] as f64 - m)).abs() < 1e-6, "frame {f}");
            assert_eq!(got[2 * f + 1], raw[2 * f + 1]);
        }
    }

    #[test]
    fn spread_scales_log_f0_about_the_centre() {
        let s = Sampling { widen: Some(Widen { by: 1.5, centre: 5.0 + 0.5 * 0.2 }), ..Default::default() };
        assert!((s.spread(0.2) - 0.2).abs() < 1e-6);
        assert!((s.spread(0.6) - (0.2 + 1.5 * 0.4)).abs() < 1e-6);
        assert!((s.spread(-0.4) - (0.2 - 1.5 * 0.6)).abs() < 1e-6);
        assert_eq!(Sampling::default().spread(0.6), 0.6);
        assert!(Sampling { widen: Some(Widen { by: 1.35, centre: 0.0 }), ..Default::default() }.check().is_err());
        assert!(Sampling { widen: Some(Widen { by: 0.0, centre: 5.0 }), ..Default::default() }.check().is_err());
    }
}
