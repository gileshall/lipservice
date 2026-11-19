// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Signal pieces of the source-filter vocoder.

use crate::fft::{RealFft, C};
use std::f64::consts::PI;

pub const SR: usize = 24000;
pub const HOP: usize = 240;
pub const NFFT: usize = 1024;
pub const WIN: usize = 960;
pub const NBIN: usize = NFFT / 2 + 1;
pub const F0_FLOOR: f64 = 50.0;

/// Frame track to samples, linear between frame centres, the last frame held.
pub fn upsample(track: &[f32], j: usize) -> f32 {
    let i = j / HOP;
    let a = (j % HOP) as f32 / HOP as f32;
    let x0 = track[i];
    let x1 = if i + 1 < track.len() { track[i + 1] } else { x0 };
    x0 + (x1 - x0) * a
}

/// Band-limited harmonic train at f0 (Hz, per frame) with flat unit power density: harmonic k
/// has amplitude 2 sqrt(f0 / sr), faded over the last 10% below Nyquist. Unvoiced is silent.
/// Phase is accumulated in f64 cycles and wrapped. Returns frames * HOP samples.
pub fn harmonic_source(f0: &[f32], vuv: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(f0.len() * HOP);
    Source::new().run(f0, vuv, f0.len() * HOP, &mut out);
    out
}

/// The harmonic source's state, so it can be run in pieces.
pub struct Source {
    cyc: f64,
    j: usize,
}

impl Source {
    pub fn new() -> Source {
        Source { cyc: 0.0, j: 0 }
    }

    /// The source as `run` leaves it at the start of f0's last frame, its samples counted from
    /// there: for a part picked up at that frame, on its own frames from it on.
    pub fn after(f0: &[f32]) -> Source {
        let mut cyc = 0.0f64;
        for j in 0..(f0.len().max(1) - 1) * HOP {
            cyc += upsample(f0, j) as f64 / SR as f64;
            cyc -= cyc.floor();
        }
        Source { cyc, j: 0 }
    }

    /// Samples made so far.
    pub fn len(&self) -> usize {
        self.j
    }

    pub fn is_empty(&self) -> bool {
        self.j == 0
    }

    /// Appends samples up to `upto`. f0 and vuv are the utterance's frames so far: every sample
    /// before `upto` needs its frame and the next, unless f0 holds the utterance's last frame.
    /// Pieces after the first start on a multiple of 4 samples, so the result is the same
    /// however the utterance is cut.
    pub fn run(&mut self, f0: &[f32], vuv: &[f32], upto: usize, out: &mut Vec<f32>) {
        assert_eq!(f0.len(), vuv.len());
        assert!(upto <= f0.len() * HOP && self.j % 4 == 0);
        let nyq = SR as f64 / 2.0;
        let max_harm = (nyq / F0_FLOOR) as usize;
        let inv_fade = 1.0 / (0.1 * nyq);
        const L: usize = 4;
        let mut j0 = self.j;
        while j0 < upto {
            let lanes = L.min(upto - j0);
            let mut fs = [0.0f64; L];
            let mut c1 = [1.0f64; L];
            let mut kmax = 0usize;
            for l in 0..lanes {
                let f = upsample(f0, j0 + l) as f64;
                self.cyc += f / SR as f64;
                self.cyc -= self.cyc.floor();
                fs[l] = f;
                c1[l] = (2.0 * PI * self.cyc).cos();
                kmax = kmax.max(((nyq / f).ceil() as usize).min(max_harm));
            }
            // cos(k theta) by the Chebyshev recurrence, four samples interleaved. Below the fade
            // in every lane a harmonic's weight is 1, so it is added as it is (the same sum).
            let one = |k: usize| (0..L).all(|l| ((nyq - k as f64 * fs[l]) * inv_fade).clamp(0.0, 1.0) == 1.0);
            let fmax = fs.iter().fold(0.0f64, |m, &f| m.max(f));
            let mut k1 = ((0.9 * nyq / fmax) as usize).min(kmax);
            while k1 < kmax && one(k1 + 1) {
                k1 += 1;
            }
            while k1 > 0 && !one(k1) {
                k1 -= 1;
            }
            let mut prev = [1.0f64; L];
            let mut cur = c1;
            let mut sum = [0.0f64; L];
            for _ in 1..=k1 {
                for l in 0..L {
                    sum[l] += cur[l];
                    let next = 2.0 * c1[l] * cur[l] - prev[l];
                    prev[l] = cur[l];
                    cur[l] = next;
                }
            }
            for k in k1 + 1..=kmax {
                for l in 0..L {
                    let w = ((nyq - k as f64 * fs[l]) * inv_fade).clamp(0.0, 1.0);
                    sum[l] += w * cur[l];
                    let next = 2.0 * c1[l] * cur[l] - prev[l];
                    prev[l] = cur[l];
                    cur[l] = next;
                }
            }
            for l in 0..lanes {
                let v = upsample(vuv, j0 + l) as f64;
                out.push((sum[l] * 2.0 * (fs[l] / SR as f64).sqrt() * v) as f32);
            }
            j0 += lanes;
        }
        self.j = upto;
    }
}

/// The STFT window: a periodic Hann of WIN samples centred in NFFT.
pub fn window() -> Vec<f32> {
    let mut w = vec![0.0f32; NFFT];
    let off = (NFFT - WIN) / 2;
    for i in 0..WIN {
        w[off + i] = (0.5 - 0.5 * (2.0 * PI * i as f64 / WIN as f64).cos()) as f32;
    }
    w
}

pub struct Stft {
    fft: RealFft,
    win: Vec<f32>,
}

impl Stft {
    pub fn new() -> Stft {
        Stft { fft: RealFft::new(NFFT), win: window() }
    }

    /// The first `frames` frames of a centred, reflect-padded STFT: frame t is centred on t * HOP.
    pub fn forward(&self, x: &[f32], frames: usize) -> Vec<C> {
        let mut out = vec![C::default(); frames * NBIN];
        let mut buf = vec![0.0f32; NFFT];
        for t in 0..frames {
            self.frame(x, 0, x.len(), t, &mut buf, &mut out[t * NBIN..(t + 1) * NBIN]);
        }
        out
    }

    /// Frame t of the STFT of a signal of n samples, of which x holds those from `base` on.
    pub fn frame(&self, x: &[f32], base: usize, n: usize, t: usize, buf: &mut [f32], out: &mut [C]) {
        assert!(n > NFFT / 2, "signal shorter than half a frame");
        let (n, pad) = (n as isize, (NFFT / 2) as isize);
        for i in 0..NFFT {
            let mut s = (t * HOP) as isize + i as isize - pad;
            if s < 0 {
                s = -s;
            }
            if s >= n {
                s = 2 * (n - 1) - s;
            }
            buf[i] = x[s as usize - base] * self.win[i];
        }
        self.fft.forward(buf, out);
    }

    /// The energy a frame's spectrum lays down in an overlap-add: its samples through the window.
    pub fn laid(&self, spec: &[C], buf: &mut [f32]) -> f32 {
        self.fft.inverse(spec, buf);
        buf.iter().zip(&self.win).map(|(v, w)| (v * w) * (v * w)).sum()
    }

    /// Inverse of a centred STFT by weighted overlap-add, `length` samples.
    pub fn inverse(&self, spec: &[C], length: usize) -> Vec<f32> {
        let frames = spec.len() / NBIN;
        let mut ola = Ola::new(frames, length);
        let mut y = Vec::with_capacity(length);
        for t in 0..frames {
            ola.add(self, &spec[t * NBIN..(t + 1) * NBIN], &mut y);
        }
        assert_eq!(y.len(), length, "{length} samples from {frames} frames");
        y
    }
}

/// Weighted overlap-add of a centred STFT's frames, in order, giving each sample once no later
/// frame can reach it.
pub struct Ola {
    frames: usize,
    length: usize,
    added: usize,
    done: usize, // samples given
    base: usize, // padded index of y[0]
    y: Vec<f32>,
    env: Vec<f32>,
    buf: Vec<f32>,
}

impl Ola {
    pub fn new(frames: usize, length: usize) -> Ola {
        assert!(NFFT / 2 + length <= NFFT + HOP * (frames.max(1) - 1), "{length} samples from {frames} frames");
        Ola { frames, length, added: 0, done: 0, base: 0, y: Vec::new(), env: Vec::new(), buf: vec![0.0; NFFT] }
    }

    pub fn added(&self) -> usize {
        self.added
    }

    /// Adds the next frame's spectrum; appends the samples it finishes to `out`.
    pub fn add(&mut self, stft: &Stft, spec: &[C], out: &mut Vec<f32>) {
        assert!(self.added < self.frames);
        stft.fft.inverse(spec, &mut self.buf);
        let o = self.added * HOP - self.base;
        if self.y.len() < o + NFFT {
            self.y.resize(o + NFFT, 0.0);
            self.env.resize(o + NFFT, 0.0);
        }
        for i in 0..NFFT {
            self.y[o + i] += self.buf[i] * stft.win[i];
            self.env[o + i] += stft.win[i] * stft.win[i];
        }
        self.added += 1;
        // padded samples before the next frame's start are final
        let fin = if self.added == self.frames { self.length } else { (self.added * HOP).saturating_sub(NFFT / 2).min(self.length) };
        for j in self.done..fin {
            let p = j + NFFT / 2 - self.base;
            let e = self.env[p];
            assert!(e > 1e-11, "window envelope vanishes at sample {j}");
            out.push(self.y[p] / e);
        }
        self.done = self.done.max(fin);
        // keep from the next sample to give or the next frame's start, whichever is first
        let keep = (self.done + NFFT / 2).min(self.added * HOP);
        if keep > self.base {
            self.y.drain(..keep - self.base);
            self.env.drain(..keep - self.base);
            self.base = keep;
        }
    }
}

/// Minimum-phase response from a log magnitude over NBIN bins, by folding the real cepstrum.
pub struct MinPhase {
    fft: RealFft,
    cep: Vec<f32>,
    spec: Vec<C>,
}

impl MinPhase {
    pub fn new() -> MinPhase {
        MinPhase { fft: RealFft::new(NFFT), cep: vec![0.0; NFFT], spec: vec![C::default(); NBIN] }
    }

    pub fn run(&mut self, logmag: &[f32], out: &mut [C]) {
        for k in 0..NBIN {
            self.spec[k] = C::new(logmag[k], 0.0);
        }
        self.fft.inverse(&self.spec, &mut self.cep);
        for i in 1..NFFT / 2 {
            self.cep[i] *= 2.0;
        }
        for i in NFFT / 2 + 1..NFFT {
            self.cep[i] = 0.0;
        }
        self.fft.forward(&self.cep, out);
        for c in out.iter_mut() {
            let m = c.re.exp();
            let (s, co) = c.im.sin_cos();
            *c = C::new(m * co, m * s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Source::run as first written: every harmonic weighted.
    fn source_plain(f0: &[f32], vuv: &[f32]) -> Vec<f32> {
        let nyq = SR as f64 / 2.0;
        let max_harm = (nyq / F0_FLOOR) as usize;
        let inv_fade = 1.0 / (0.1 * nyq);
        const L: usize = 4;
        let (mut cyc, mut out, upto) = (0.0f64, Vec::new(), f0.len() * HOP);
        let mut j0 = 0;
        while j0 < upto {
            let lanes = L.min(upto - j0);
            let (mut fs, mut c1, mut kmax) = ([0.0f64; L], [1.0f64; L], 0usize);
            for l in 0..lanes {
                let f = upsample(f0, j0 + l) as f64;
                cyc += f / SR as f64;
                cyc -= cyc.floor();
                fs[l] = f;
                c1[l] = (2.0 * PI * cyc).cos();
                kmax = kmax.max(((nyq / f).ceil() as usize).min(max_harm));
            }
            let (mut prev, mut cur, mut sum) = ([1.0f64; L], c1, [0.0f64; L]);
            for k in 1..=kmax {
                for l in 0..L {
                    let w = ((nyq - k as f64 * fs[l]) * inv_fade).clamp(0.0, 1.0);
                    sum[l] += w * cur[l];
                    let next = 2.0 * c1[l] * cur[l] - prev[l];
                    prev[l] = cur[l];
                    cur[l] = next;
                }
            }
            for l in 0..lanes {
                out.push((sum[l] * 2.0 * (fs[l] / SR as f64).sqrt() * upsample(vuv, j0 + l) as f64) as f32);
            }
            j0 += lanes;
        }
        out
    }

    #[test]
    fn source_matches_plain() {
        // glides from 40 Hz to 3 kHz and back, some frames unvoiced, a frame count not a multiple of 4
        let n = 403;
        let f0: Vec<f32> = (0..n).map(|i| if i % 37 < 3 { 0.0 } else { 40.0 * 75f32.powf(((i as f32 / 60.0).sin() + 1.0) / 2.0) }).collect();
        let vuv: Vec<f32> = f0.iter().map(|&f| if f > 0.0 { 1.0 } else { 0.0 }).collect();
        let got = harmonic_source(&f0, &vuv);
        let want = source_plain(&f0, &vuv);
        assert_eq!(got.len(), want.len());
        for (j, (a, b)) in got.iter().zip(&want).enumerate() {
            assert_eq!(a.to_bits(), b.to_bits(), "sample {j}");
        }
    }
}
