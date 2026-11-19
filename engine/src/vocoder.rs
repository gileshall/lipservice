// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The pitch-exact source-filter vocoder.

use crate::dsp::{self, MinPhase, Stft, HOP, NBIN};
use crate::fft::C;
use crate::nn::{Conv1d, ConvNeXt, LayerNorm, Linear};
use crate::weights::{err, Result, Weights};

pub const N_ENV: usize = 80;
pub const N_AP: usize = 8;
pub const LF0_MU: f32 = 5.0;
pub const LF0_SD: f32 = 0.5;

/// One utterance of frame features, row-major.
pub struct Frames {
    pub env: Vec<f32>, // (T, N_ENV) log envelope
    pub bap: Vec<f32>, // (T, N_AP) band aperiodicity
    pub lf0: Vec<f32>, // (T) log F0, interpolated through unvoiced frames
    pub vuv: Vec<f32>, // (T) voicing, 0 or 1
}

impl Frames {
    pub fn len(&self) -> usize {
        self.lf0.len()
    }

    pub fn check(&self) -> Result<()> {
        let t = self.len();
        if self.env.len() != t * N_ENV || self.bap.len() != t * N_AP || self.vuv.len() != t {
            return err(format!("frame tracks disagree: env {}, bap {}, lf0 {}, vuv {}", self.env.len(), self.bap.len(), t, self.vuv.len()));
        }
        if t < 3 {
            return err(format!("{t} frames: too short to render"));
        }
        Ok(())
    }
}

pub(crate) struct Net {
    pub(crate) dim: usize,
    pub(crate) inp: Conv1d,
    pub(crate) blocks: Vec<ConvNeXt>,
    norm: LayerNorm,
    out: Linear,
}

pub struct Vocoder {
    wenv: Linear,
    wap: Linear,
    env_mu: Vec<f32>,
    env_sd: Vec<f32>,
    gain: f32,
    pub(crate) net: Option<Net>,
    pub(crate) stft: Stft,
}

fn transpose_linear(w: &[f32], rows: usize, cols: usize) -> Linear {
    // w is (rows=cin, cols=cout); Linear wants (cout, cin).
    let mut wt = vec![0.0; rows * cols];
    for r in 0..rows {
        for c in 0..cols {
            wt[c * rows + r] = w[r * cols + c];
        }
    }
    Linear::new(&wt, &vec![0.0; cols], cols, rows)
}

impl Vocoder {
    pub fn load(ws: &Weights) -> Result<Vocoder> {
        let net = if ws.has("inp.weight") {
            let dim = ws.get("inp.weight")?.shape[0];
            let mut blocks = Vec::new();
            while ws.has(&format!("blocks.{}.gamma", blocks.len())) {
                blocks.push(ConvNeXt::load(ws, &format!("blocks.{}", blocks.len()), dim, 3, 7)?);
            }
            Some(Net {
                dim,
                inp: Conv1d::load(ws, "inp", dim, N_ENV + N_AP + 2, 7)?,
                blocks,
                norm: LayerNorm::load(ws, "norm", dim)?,
                out: Linear::load(ws, "out", 2 * NBIN, dim)?,
            })
        } else {
            None
        };
        Ok(Vocoder {
            wenv: transpose_linear(ws.shaped("Wenv", &[N_ENV, NBIN])?, N_ENV, NBIN),
            wap: transpose_linear(ws.shaped("Wap", &[N_AP, NBIN])?, N_AP, NBIN),
            env_mu: ws.shaped("env_mu", &[N_ENV])?.to_vec(),
            env_sd: ws.shaped("env_sd", &[N_ENV])?.to_vec(),
            gain: ws.shaped("gain", &[])?[0],
            net,
            stft: Stft::new(),
        })
    }

    pub fn layers(&self) -> usize {
        self.net.as_ref().map_or(0, |n| n.blocks.len())
    }

    /// Log magnitudes of the harmonic and noise filters, each (T, NBIN).
    pub fn shapes(&self, f: &Frames) -> Result<(Vec<f32>, Vec<f32>)> {
        f.check()?;
        let t = f.len();
        let (mut lh, mut ln) = self.base_shapes(&f.env, &f.bap, t);
        if let Some(net) = &self.net {
            let x = self.net_input(&f.env, &f.bap, &f.lf0, &f.vuv);
            let mut h = vec![0.0; t * net.dim];
            net.inp.forward(&x, t, &mut h);
            for b in &net.blocks {
                b.forward(&mut h, t);
            }
            self.net_head(&mut h, t, &mut lh, &mut ln);
        }
        Ok((lh, ln))
    }

    /// The filters' log magnitudes from the envelope and aperiodicity alone, n frames.
    pub(crate) fn base_shapes(&self, env: &[f32], bap: &[f32], n: usize) -> (Vec<f32>, Vec<f32>) {
        let mut log_env = vec![0.0; n * NBIN];
        self.wenv.forward(env, n, &mut log_env);
        let mut ap = vec![0.0; n * NBIN];
        self.wap.forward(bap, n, &mut ap);
        let mut lh = vec![0.0; n * NBIN];
        let mut ln = vec![0.0; n * NBIN];
        for i in 0..n * NBIN {
            let a = ap[i].clamp(1e-4, 1.0 - 1e-4);
            lh[i] = 0.5 * log_env[i] + 0.5 * (-a).ln_1p() + self.gain;
            ln[i] = 0.5 * log_env[i] + 0.5 * a.ln() + self.gain;
        }
        (lh, ln)
    }

    /// The net's input rows: normalized envelope, aperiodicity, normalized log F0, voicing.
    pub(crate) fn net_input(&self, env: &[f32], bap: &[f32], lf0: &[f32], vuv: &[f32]) -> Vec<f32> {
        let (t, cin) = (lf0.len(), N_ENV + N_AP + 2);
        let mut x = vec![0.0; t * cin];
        for i in 0..t {
            let row = &mut x[i * cin..(i + 1) * cin];
            for c in 0..N_ENV {
                row[c] = (env[i * N_ENV + c] - self.env_mu[c]) / self.env_sd[c];
            }
            row[N_ENV..N_ENV + N_AP].copy_from_slice(&bap[i * N_AP..(i + 1) * N_AP]);
            row[N_ENV + N_AP] = (lf0[i] - LF0_MU) / LF0_SD;
            row[N_ENV + N_AP + 1] = vuv[i];
        }
        x
    }

    /// The net's last blocks' output h (n rows, normed in place) added to the shapes as deltas.
    pub(crate) fn net_head(&self, h: &mut [f32], n: usize, lh: &mut [f32], ln: &mut [f32]) {
        let net = self.net.as_ref().expect("a vocoder with a net");
        net.norm.forward(h);
        let mut d = vec![0.0; n * 2 * NBIN];
        net.out.forward(h, n, &mut d);
        for i in 0..n {
            for k in 0..NBIN {
                lh[i * NBIN + k] += d[i * 2 * NBIN + k];
                ln[i * NBIN + k] += d[i * 2 * NBIN + NBIN + k];
            }
        }
    }

    /// One frame's output spectrum: the source through the minimum-phase harmonic filter plus
    /// the noise shaped by the noise filter.
    pub(crate) fn synth_frame(mp: &mut MinPhase, hh: &mut [C], lh: &[f32], ln: &[f32], eh: &[C], en: &[C], y: &mut [C]) {
        mp.run(lh, hh);
        for k in 0..NBIN {
            let a = hh[k].mul(eh[k]);
            let b = en[k].scale(ln[k].exp());
            y[k] = a.add(b);
        }
    }

    /// T * HOP samples. `noise` is white with unit variance, T * HOP samples.
    pub fn render(&self, f: &Frames, noise: &[f32]) -> Result<Vec<f32>> {
        f.check()?;
        let t = f.len();
        let n = t * HOP;
        if noise.len() != n {
            return err(format!("noise has {} samples, need {n}", noise.len()));
        }
        let f0: Vec<f32> = f.lf0.iter().map(|v| v.exp()).collect();
        let src = dsp::harmonic_source(&f0, &f.vuv);
        let eh = self.stft.forward(&src, t);
        let en = self.stft.forward(noise, t);
        let (lh, ln) = self.shapes(f)?;
        let mut mp = MinPhase::new();
        let mut hh = vec![C::default(); NBIN];
        let mut y = vec![C::default(); (t + 1) * NBIN];
        for i in 0..t {
            let r = i * NBIN..(i + 1) * NBIN;
            Self::synth_frame(&mut mp, &mut hh, &lh[r.clone()], &ln[r.clone()], &eh[r.clone()], &en[r.clone()], &mut y[r]);
        }
        Ok(self.stft.inverse(&y, n))
    }
}
