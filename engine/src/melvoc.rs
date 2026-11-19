// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The mel route: a mel decoder beside the score model's envelope
//! decoder, from the same frames to a 100-band log-mel, and Vocos (charactr/vocos-mel-24khz, MIT),
//! which renders it as audio. One file holds both, under mel. and vocos., and
//! the bands' scaling into Vocos's mel as off. A decoder may carry the harmonic template
//! (meldec.comb_table, mel.table, and its depth, mel.depth): the log-mel of an ideal harmonic
//! series at each frame's pitch, less its 5-band mean, added at the output, each band's depth
//! a linear function of the last block's states. A voice file may carry a decoder of its own
//! under mel., which speaks it in the route's place. The route's file may
//! carry the release channel under rel. (release.rs), which whichever decoder speaks takes.

use crate::dsp::HOP;
use crate::fft::{RealFft, C};
use crate::nn::{Conv1d, ConvNeXt, LayerNorm, Linear};
use crate::release::Release;
use crate::score::ScoreModel;
use crate::weights::{err, Result, Weights};

pub const N_MEL: usize = 100;
pub const VOCOS_HOP: usize = 256;
pub const VOCOS_NFFT: usize = 1024;
pub(crate) const VBIN: usize = VOCOS_NFFT / 2 + 1;
const VOCOS_EPS: f32 = 1e-6;
const F0_LO: f32 = 50.0;
const F0_STEP: f32 = 0.5;

/// The harmonic template: a table of N_MEL rows over pitch from F0_LO by F0_STEP Hz, and the
/// layer giving each band's depth.
struct Harmonic {
    table: Vec<f32>,
    rows: usize,
    depth: Linear,
}

impl Harmonic {
    /// The template row for log F0 and voicing, as meldec.template.
    fn row(&self, lf0: f32, vuv: f32, o: &mut [f32]) {
        let i = ((lf0.exp() - F0_LO) / F0_STEP).clamp(0.0, self.rows as f32 - 1.001);
        let a = i.floor() as usize;
        let w = i - a as f32;
        let (r0, r1) = (&self.table[a * N_MEL..(a + 1) * N_MEL], &self.table[(a + 1) * N_MEL..(a + 2) * N_MEL]);
        for c in 0..N_MEL {
            o[c] = (r0[c] * (1.0 - w) + r1[c] * w) * vuv;
        }
    }
}

pub struct MelDec {
    pub(crate) dim: usize,
    cin: usize,
    pub(crate) f0_emb: Conv1d,
    pub(crate) dec_in: Linear,
    pub(crate) dec: Vec<ConvNeXt>,
    out: Linear,
    mu: Vec<f32>,
    sd: Vec<f32>,
    harmonic: Option<Harmonic>,
}

pub struct Vocos {
    pub(crate) dim: usize,
    pub(crate) embed: Conv1d,
    pub(crate) norm: LayerNorm,
    pub(crate) blocks: Vec<ConvNeXt>,
    fin: LayerNorm,
    out: Linear,
    off: Vec<f32>,
    fft: RealFft,
    win: Vec<f32>,
}

pub struct MelVoc {
    pub mel: MelDec,
    pub vocos: Vocos,
    pub release: Option<Release>,
}

fn blocks(ws: &Weights, prefix: &str, dim: usize, eps: f32) -> Result<Vec<ConvNeXt>> {
    let mut v = Vec::new();
    while ws.has(&format!("{prefix}.{}.gamma", v.len())) {
        v.push(ConvNeXt::load_eps(ws, &format!("{prefix}.{}", v.len()), dim, 3, 7, eps)?);
    }
    if v.is_empty() {
        return err(format!("no blocks under {prefix}"));
    }
    Ok(v)
}

/// Vocos frames for t decoder frames: the last falls on or before the decoder's last.
pub fn vocos_frames(t: usize) -> usize {
    (t - 1) * HOP / VOCOS_HOP + 1
}

impl MelVoc {
    /// Whether a file is a mel route's rather than a vocoder's.
    pub fn is(ws: &Weights) -> bool {
        ws.has("vocos.embed.weight")
    }

    pub fn load(mut ws: Weights) -> Result<MelVoc> {
        let (m, v, off, rel) = (ws.split("mel."), ws.split("vocos."), ws.split("off"), ws.split("rel."));
        if let Some(n) = ws.names().next() {
            return err(format!("{n}: not part of a mel route"));
        }
        let mel = MelDec::load(&m)?;
        let release = if rel.is_empty() { None } else { Some(Release::load(&rel, mel.dim)?) };
        let vdim = v.get("embed.weight")?.shape[0];
        let win = (0..VOCOS_NFFT)
            .map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / VOCOS_NFFT as f64).cos()) as f32)
            .collect();
        let vocos = Vocos {
            dim: vdim,
            embed: Conv1d::load(&v, "embed", vdim, N_MEL, 7)?,
            norm: LayerNorm::load_eps(&v, "norm", vdim, VOCOS_EPS)?,
            blocks: blocks(&v, "blocks", vdim, VOCOS_EPS)?,
            fin: LayerNorm::load_eps(&v, "final", vdim, VOCOS_EPS)?,
            out: Linear::load(&v, "out", 2 * VBIN, vdim)?,
            off: off.shaped("", &[N_MEL])?.to_vec(),
            fft: RealFft::new(VOCOS_NFFT),
            win,
        };
        Ok(MelVoc { mel, vocos, release })
    }
}

impl MelDec {
    /// A decoder from its tensors, the mel. prefix taken off.
    pub fn load(m: &Weights) -> Result<MelDec> {
        let (dim, cin) = (m.get("dec_in.weight")?.shape[0], m.get("dec_in.weight")?.shape[1]);
        let harmonic = match (m.has("table"), m.has("depth.weight")) {
            (false, false) => None,
            (true, true) => {
                let t = m.get("table")?;
                if t.shape.len() != 2 || t.shape[1] != N_MEL || t.shape[0] < 2 {
                    return err(format!("mel.table: shape {:?}, want (rows, {N_MEL})", t.shape));
                }
                Some(Harmonic { table: t.data.clone(), rows: t.shape[0], depth: Linear::load(m, "depth", N_MEL, dim)? })
            }
            _ => return err("mel.table and mel.depth go together"),
        };
        Ok(MelDec {
            dim,
            cin,
            f0_emb: Conv1d::load(m, "f0_emb", dim, 2, 3)?,
            dec_in: Linear::load(m, "dec_in", dim, cin)?,
            dec: blocks(m, "dec.blocks", dim, 1e-5)?,
            out: Linear::load(m, "out", N_MEL, dim)?,
            mu: m.shaped("mu", &[N_MEL])?.to_vec(),
            sd: m.shaped("sd", &[N_MEL])?.to_vec(),
            harmonic,
        })
    }

    /// The token states a frame it takes.
    pub fn cin(&self) -> usize {
        self.cin
    }

    /// Log-mel (t, N_MEL) for t frames of expanded token states hx, log F0 and voicing, and the
    /// release channel with its rows (Release::told) if given.
    pub fn forward(&self, hx: &[f32], lf0: &[f32], vuv: &[f32], release: Option<(&Release, &[f32])>) -> Result<Vec<f32>> {
        let (t, d) = (lf0.len(), self.dim);
        if hx.len() != t * self.cin || vuv.len() != t {
            return err(format!("mel decoder: {} token state values, {t} pitch, {} voicing; {} a frame", hx.len(), vuv.len(), self.cin));
        }
        if let Some((r, told)) = release {
            if r.dim() != d || told.len() != 2 * t {
                return err(format!("release channel: {} wide, {} values; the decoder is {d} wide, {t} frames", r.dim(), told.len()));
            }
        }
        let f = ScoreModel::f0_feat(lf0, vuv);
        let mut x = vec![0.0; t * d];
        self.dec_in.forward(hx, t, &mut x);
        let mut fe = vec![0.0; t * d];
        self.f0_emb.forward(&f, t, &mut fe);
        for (a, b) in x.iter_mut().zip(&fe) {
            *a += b;
        }
        if let Some((r, told)) = release {
            r.add_rows(told, t, 0, t, &mut x);
        }
        for b in &self.dec {
            b.forward(&mut x, t);
        }
        Ok(self.head(&x, lf0, vuv))
    }

    /// Log-mel rows from the last block's output for as many frames as lf0 and vuv hold.
    pub(crate) fn head(&self, x: &[f32], lf0: &[f32], vuv: &[f32]) -> Vec<f32> {
        let n = lf0.len();
        assert!(vuv.len() == n && x.len() == n * self.dim, "mel head: {} values, {n} pitch, {} voicing", x.len(), vuv.len());
        let mut y = vec![0.0; n * N_MEL];
        self.out.forward(x, n, &mut y);
        for row in y.chunks_exact_mut(N_MEL) {
            for c in 0..N_MEL {
                row[c] = row[c] * self.sd[c] + self.mu[c];
            }
        }
        if let Some(h) = &self.harmonic {
            let mut d = vec![0.0; n * N_MEL];
            h.depth.forward(x, n, &mut d);
            let mut tp = [0.0f32; N_MEL];
            for i in 0..n {
                h.row(lf0[i], vuv[i], &mut tp);
                let (row, di) = (&mut y[i * N_MEL..(i + 1) * N_MEL], &d[i * N_MEL..(i + 1) * N_MEL]);
                for c in 0..N_MEL {
                    row[c] += di[c] * tp[c];
                }
            }
        }
        y
    }
}

impl Vocos {
    /// Vocos's input (vocos_frames(t), N_MEL): the decoder's t frames at 100 a second resampled
    /// linearly to 93.75, its bands scaled.
    pub fn input(&self, mel: &[f32]) -> Result<Vec<f32>> {
        let t = mel.len() / N_MEL;
        if mel.len() != t * N_MEL || t < 2 {
            return err(format!("{} mel values: Vocos needs at least two frames of {N_MEL}", mel.len()));
        }
        Ok(self.input_rows(mel, 0, t, 0, vocos_frames(t)))
    }

    /// The decoder frames Vocos's input row j reads: i and i + 1.
    pub(crate) fn source_row(j: usize, t: usize) -> usize {
        (j * VOCOS_HOP / HOP).min(t - 2)
    }

    /// Rows [a, b) of Vocos's input for t decoder frames, of which mel holds those from `base` on.
    pub(crate) fn input_rows(&self, mel: &[f32], base: usize, t: usize, a: usize, b: usize) -> Vec<f32> {
        let mut x = vec![0.0; (b - a) * N_MEL];
        for j in a..b {
            let p = (j * VOCOS_HOP) as f64 / HOP as f64;
            let i = Self::source_row(j, t);
            let w = (p - i as f64) as f32;
            let k = i - base;
            let (r0, r1) = (&mel[k * N_MEL..(k + 1) * N_MEL], &mel[(k + 1) * N_MEL..(k + 2) * N_MEL]);
            let o = &mut x[(j - a) * N_MEL..(j - a + 1) * N_MEL];
            for c in 0..N_MEL {
                o[c] = (1.0 - w) * r0[c] + w * r1[c] + self.off[c];
            }
        }
        x
    }

    /// The complex spectrum (n, VBIN) for n frames of Vocos's input.
    pub fn spectrum(&self, x: &[f32], n: usize) -> Vec<C> {
        let d = self.dim;
        let mut h = vec![0.0; n * d];
        self.embed.forward(x, n, &mut h);
        self.norm.forward(&mut h);
        for b in &self.blocks {
            b.forward(&mut h, n);
        }
        self.head(&mut h, n)
    }

    /// The spectrum from n rows of the last block's output, normed in place.
    pub(crate) fn head(&self, h: &mut [f32], n: usize) -> Vec<C> {
        self.fin.forward(h);
        let mut y = vec![0.0; n * 2 * VBIN];
        self.out.forward(h, n, &mut y);
        let mut s = vec![C::default(); n * VBIN];
        for i in 0..n {
            let r = &y[i * 2 * VBIN..(i + 1) * 2 * VBIN];
            for k in 0..VBIN {
                let (m, p) = (r[k].exp().min(1e2), r[VBIN + k]);
                s[i * VBIN + k] = C::new(m * p.cos(), m * p.sin());
            }
        }
        s
    }

    /// torch.istft, centred: (n - 1) * VOCOS_HOP samples.
    pub fn istft(&self, s: &[C], n: usize) -> Vec<f32> {
        let mut ola = Istft::new(n);
        let mut out = Vec::with_capacity((n - 1) * VOCOS_HOP);
        for i in 0..n {
            ola.add(self, &s[i * VBIN..(i + 1) * VBIN], &mut out);
        }
        out
    }

    /// Audio for the decoder's log-mel (t, N_MEL).
    pub fn render(&self, mel: &[f32]) -> Result<Vec<f32>> {
        let x = self.input(mel)?;
        let n = x.len() / N_MEL;
        Ok(self.istft(&self.spectrum(&x, n), n))
    }
}

/// torch.istft's overlap-add, centred, a frame at a time: each sample out once no later frame
/// reaches it.
pub(crate) struct Istft {
    frames: usize,
    added: usize,
    base: usize, // the full signal's sample y[0] and env[0] stand for
    y: Vec<f32>,
    env: Vec<f32>,
    buf: Vec<f32>,
}

impl Istft {
    pub(crate) fn new(frames: usize) -> Istft {
        Istft { frames, added: 0, base: 0, y: Vec::new(), env: Vec::new(), buf: vec![0.0; VOCOS_NFFT] }
    }

    pub(crate) fn added(&self) -> usize {
        self.added
    }

    pub(crate) fn done(&self) -> bool {
        self.added == self.frames
    }

    /// Adds the next frame's spectrum (VBIN bins) and appends the samples it finishes.
    pub(crate) fn add(&mut self, v: &Vocos, spec: &[C], out: &mut Vec<f32>) {
        assert!(self.added < self.frames, "all {} frames added", self.frames);
        v.fft.inverse(spec, &mut self.buf);
        let at = self.added * VOCOS_HOP;
        let need = at + VOCOS_NFFT - self.base;
        if self.y.len() < need {
            self.y.resize(need, 0.0);
            self.env.resize(need, 0.0);
        }
        for k in 0..VOCOS_NFFT {
            self.y[at - self.base + k] += self.buf[k] * v.win[k];
            self.env[at - self.base + k] += v.win[k] * v.win[k];
        }
        self.added += 1;
        // out sample k is the full signal's k + NFFT / 2; the full signal is final before the next frame's start
        let (p, len) = (VOCOS_NFFT / 2, (self.frames - 1) * VOCOS_HOP);
        let upto = if self.done() { len } else { (self.added * VOCOS_HOP).saturating_sub(p).min(len) };
        let from = out_len(self.base, p);
        if upto > from {
            for k in from..upto {
                let i = k + p - self.base;
                out.push(self.y[i] / self.env[i]);
            }
            let drop = upto + p - self.base;
            self.y.drain(..drop);
            self.env.drain(..drop);
            self.base += drop;
        }
    }
}

/// Samples out so far when the buffers start at full sample `base`.
fn out_len(base: usize, p: usize) -> usize {
    base.saturating_sub(p)
}
