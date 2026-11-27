// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The choir's room and mastering (engine/web/room.js),
//! sample for sample: a ping-pong echo at half a beat, a hall on the send and the echo,
//! then the mastering: a second hall on the 200 Hz to 5 kHz band, a 30 Hz high-pass, a compressor
//! and a look-ahead limiter to -1.5 dBFS. Every setting is fixed; nothing is measured. The level is
//! made where the parts enter the mix; the compressor and limiter are nets a piece at its level
//! does not touch. Streamed in blocks of BLOCK samples.

use std::collections::VecDeque;
use std::f64::consts::{PI, SQRT_2};

use crate::dsp::SR;
use crate::part::Rnd;
use crate::weights::{err, Result};

pub const BLOCK: usize = 2048; // samples a convolution block
pub const TAIL: f64 = 4.0; // seconds the room rings after the last sample of the mix

/// A room's amounts (barbershop-human ROOMS): the mix's echo and hall, and the mastering hall.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Amounts {
    pub echo: f64,
    pub wet: f64,
    pub rt: f64,
    pub rt_hi: f64,
    pub mwet: f64,
    pub mrt: f64,
    pub mrt_hi: f64,
}

const fn amounts(echo: f64, wet: f64, rt: f64, rt_hi: f64, mwet: f64, mrt: f64, mrt_hi: f64) -> Amounts {
    Amounts { echo, wet, rt, rt_hi, mwet, mrt, mrt_hi }
}

pub const ROOMS: [(&str, Amounts); 4] = [
    ("card", amounts(0.10, 0.20, 1.5, 0.8, 0.12, 2.0, 1.0)),
    ("drier", amounts(0.05, 0.10, 1.2, 0.7, 0.06, 1.5, 0.8)),
    ("driest", amounts(0.02, 0.05, 1.0, 0.6, 0.03, 1.2, 0.7)),
    ("bare", amounts(0.0, 0.0, 0.25, 0.25, 0.0, 0.25, 0.25)),
];

pub fn room(name: &str) -> Result<Amounts> {
    match ROOMS.iter().find(|(n, _)| *n == name) {
        Some((_, a)) => Ok(*a),
        None => err(format!("no room {name}: {}", ROOMS.map(|(n, _)| n).join(", "))),
    }
}

/// Where a piece's loud passages sit in the mix, dBFS (room.js LOUD).
pub const LOUD: f64 = -18.0;
/// All of a piece's singers at once at their fullest, where its loud passages are not measured.
pub const FULL_CHOIR: f64 = 0.57;
const COMP_THRESH: f64 = LOUD + 4.0;
const COMP_RATIO: f64 = 2.0;
const COMP_KNEE: f64 = 4.0;
const COMP_ATTACK: f64 = 0.030;
const COMP_RELEASE: f64 = 0.400;
const CEILING_DB: f64 = -1.5;
const LIMIT_WINDOW: f64 = 0.012; // seconds

/// room.js rng(key).normal(): Box-Muller over part::Rnd, room.js's generator.
pub fn normal(r: &mut Rnd) -> f64 {
    let u = 1.0 - r.uniform();
    let v = r.uniform();
    (-2.0 * u.ln()).sqrt() * (2.0 * PI * v).cos()
}

// ---------------------------------------------------------------- filters

/// Butterworth sections by the bilinear transform with the cutoff prewarped, as
/// scipy.signal.butter: [b0, b1, b2, a1, a2] (a0 = 1). Order 1 low, or order 2 low or high.
pub fn butter(order: u32, fc: f64, high: bool) -> [f64; 5] {
    let k = (PI * fc / SR as f64).tan();
    match (order, high) {
        (1, false) => [k / (1.0 + k), k / (1.0 + k), 0.0, (k - 1.0) / (k + 1.0), 0.0],
        (2, _) => {
            let n = 1.0 / (1.0 + SQRT_2 * k + k * k);
            let a1 = 2.0 * (k * k - 1.0) * n;
            let a2 = (1.0 - SQRT_2 * k + k * k) * n;
            if high {
                [n, -2.0 * n, n, a1, a2]
            } else {
                [k * k * n, 2.0 * k * k * n, k * k * n, a1, a2]
            }
        }
        _ => panic!("butter: no order {order} {}", if high { "high" } else { "low" }),
    }
}

/// One section over a stream, as scipy.signal.lfilter from rest.
#[derive(Clone)]
pub struct Biquad {
    c: [f64; 5],
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    pub fn new(c: [f64; 5]) -> Self {
        Biquad { c, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 }
    }

    pub fn step(&mut self, x: f64) -> f64 {
        let [b0, b1, b2, a1, a2] = self.c;
        let y = b0 * x + b1 * self.x1 + b2 * self.x2 - a1 * self.y1 - a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

// ---------------------------------------------------------------- halls

/// A stereo impulse response: a channel's own
/// noise low-passed at 2.5 kHz decaying by 60 dB in rt s, plus half of it high-passed there decaying
/// in rt_hi s, behind predelay s of silence, at unit energy.
pub fn hall(seconds: f64, rt: f64, rt_hi: f64, predelay: f64, seed: i64) -> [Vec<f64>; 2] {
    let n = (seconds * SR as f64).round() as usize;
    let pre = (predelay * SR as f64).round() as usize;
    let mut r = Rnd::new(&format!("hall {seed}"));
    let mut one = || {
        let mut lo = Biquad::new(butter(2, 2500.0, false));
        let mut hi = Biquad::new(butter(2, 2500.0, true));
        let mut y = vec![0.0; pre + n];
        let mut e = 0.0;
        for i in 0..n {
            let z = normal(&mut r);
            let t = i as f64 / SR as f64;
            let v = lo.step(z) * (-6.91 * t / rt).exp() + 0.5 * hi.step(z) * (-6.91 * t / rt_hi).exp();
            y[pre + i] = v;
            e += v * v;
        }
        let g = 1.0 / e.sqrt();
        for v in &mut y {
            *v *= g;
        }
        y
    };
    let l = one();
    [l, one()]
}

// ---------------------------------------------------------------- convolution

/// An in-place radix-2 complex FFT of n points, unscaled (room.js FFT, its tables and its order).
struct Fft {
    n: usize,
    rev: Vec<usize>,
    cos: Vec<f64>,
    sin: Vec<f64>,
}

impl Fft {
    fn new(n: usize) -> Self {
        assert!(n.is_power_of_two(), "fft: {n} is not a power of 2");
        let bits = n.trailing_zeros();
        let rev = (0..n).map(|i| (0..bits).fold(0, |r, b| r | (((i >> b) & 1) << (bits - 1 - b)))).collect();
        let cos = (0..n / 2).map(|i| (2.0 * PI * i as f64 / n as f64).cos()).collect();
        let sin = (0..n / 2).map(|i| (2.0 * PI * i as f64 / n as f64).sin()).collect();
        Fft { n, rev, cos, sin }
    }

    fn run(&self, re: &mut [f64], im: &mut [f64], inverse: bool) {
        let n = self.n;
        let sg = if inverse { 1.0 } else { -1.0 };
        for i in 0..n {
            let j = self.rev[i];
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut size = 2;
        while size <= n {
            let half = size >> 1;
            let step = n / size;
            let mut i = 0;
            while i < n {
                let mut k = 0;
                for j in 0..half {
                    let (wr, wi) = (self.cos[k], sg * self.sin[k]);
                    let (a, b) = (i + j, i + j + half);
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                    k += step;
                }
                i += size;
            }
            size <<= 1;
        }
    }
}

/// Two channels each through its own impulse response, block by block (uniformly partitioned
/// overlap-save). The two real channels share one complex FFT, as real and imaginary parts.
struct Convolver {
    b: usize,
    n: usize,
    bins: usize,
    fft: Fft,
    p: usize,
    re: Vec<f64>,
    im: Vec<f64>,
    h: [Vec<f64>; 2],
    x: [Vec<f64>; 2], // past input spectra
    head: usize,
    prev: [Vec<f64>; 2],
    acc: [Vec<f64>; 2],
}

impl Convolver {
    fn new(ir: [Vec<f64>; 2]) -> Self {
        let b = BLOCK;
        let (n, bins) = (2 * b, b + 1);
        let p = ir[0].len().max(ir[1].len()).div_ceil(b);
        let mut c = Convolver {
            b,
            n,
            bins,
            fft: Fft::new(n),
            p,
            re: vec![0.0; n],
            im: vec![0.0; n],
            h: [vec![0.0; p * bins * 2], vec![0.0; p * bins * 2]],
            x: [vec![0.0; p * bins * 2], vec![0.0; p * bins * 2]],
            head: 0,
            prev: [vec![0.0; b], vec![0.0; b]],
            acc: [vec![0.0; bins * 2], vec![0.0; bins * 2]],
        };
        let mut h = [vec![0.0; p * bins * 2], vec![0.0; p * bins * 2]];
        for q in 0..p {
            c.re.fill(0.0);
            c.im.fill(0.0);
            for i in 0..b {
                c.re[i] = ir[0].get(q * b + i).copied().unwrap_or(0.0);
                c.im[i] = ir[1].get(q * b + i).copied().unwrap_or(0.0);
            }
            c.fft.run(&mut c.re, &mut c.im, false);
            let [h0, h1] = &mut h;
            c.split_into(h0, h1, q * bins * 2);
        }
        c.h = h;
        c
    }

    /// The half spectra of the two real signals in re (left) and im (right), to a and bb at o.
    fn split_into(&self, a: &mut [f64], bb: &mut [f64], o: usize) {
        let (re, im, n) = (&self.re, &self.im, self.n);
        for k in 0..self.bins {
            let (zr, zi, wr, wi) = (re[k], im[k], re[(n - k) % n], im[(n - k) % n]);
            a[o + 2 * k] = (zr + wr) / 2.0;
            a[o + 2 * k + 1] = (zi - wi) / 2.0;
            bb[o + 2 * k] = (zi + wi) / 2.0;
            bb[o + 2 * k + 1] = (wr - zr) / 2.0;
        }
    }

    /// b samples of each channel in, b out.
    fn run(&mut self, xl: &[f64], xr: &[f64], yl: &mut [f64], yr: &mut [f64]) {
        let (b, n, bins, p) = (self.b, self.n, self.bins, self.p);
        for i in 0..b {
            self.re[i] = self.prev[0][i];
            self.im[i] = self.prev[1][i];
            self.re[b + i] = xl[i];
            self.im[b + i] = xr[i];
        }
        self.prev[0].copy_from_slice(&xl[..b]);
        self.prev[1].copy_from_slice(&xr[..b]);
        self.fft.run(&mut self.re, &mut self.im, false);
        let slot = self.head * bins * 2;
        let mut x = std::mem::take(&mut self.x);
        {
            let [x0, x1] = &mut x;
            self.split_into(x0, x1, slot);
        }
        self.x = x;
        for c in 0..2 {
            let (acc, h, x) = (&mut self.acc[c], &self.h[c], &self.x[c]);
            acc.fill(0.0);
            for q in 0..p {
                let xo = ((self.head + p - q) % p) * bins * 2;
                let ho = q * bins * 2;
                let mut k = 0;
                while k < 2 * bins {
                    let (ar, ai, br, bi) = (x[xo + k], x[xo + k + 1], h[ho + k], h[ho + k + 1]);
                    acc[k] += ar * br - ai * bi;
                    acc[k + 1] += ar * bi + ai * br;
                    k += 2;
                }
            }
        }
        self.head = (self.head + 1) % p;
        let [a, bb] = &self.acc;
        for k in 0..bins {
            let (ar, ai, br, bi) = (a[2 * k], a[2 * k + 1], bb[2 * k], bb[2 * k + 1]);
            self.re[k] = ar - bi;
            self.im[k] = ai + br;
            if k > 0 && k < b {
                self.re[n - k] = ar + bi;
                self.im[n - k] = br - ai;
            }
        }
        self.fft.run(&mut self.re, &mut self.im, true);
        for i in 0..b {
            yl[i] = self.re[b + i] / n as f64;
            yr[i] = self.im[b + i] / n as f64;
        }
    }
}

// ---------------------------------------------------------------- echo, compressor, limiter

/// The ping-pong: four repeats at half a beat, each a third down in power, low-passed at 3 kHz once
/// more, and crossed to the other side.
struct Echo {
    d: usize,
    g: f64,
    lp: Vec<[Biquad; 2]>,
    line: Vec<[Vec<f64>; 2]>,
    at: usize,
}

impl Echo {
    fn new(bpm: f64) -> Self {
        let d = (60.0 / bpm / 2.0 * SR as f64).round() as usize;
        let lp = || Biquad::new(butter(1, 3000.0, false));
        Echo {
            d,
            g: (1.0f64 / 3.0).sqrt(),
            lp: (0..4).map(|_| [lp(), lp()]).collect(),
            line: (0..4).map(|_| [vec![0.0; d], vec![0.0; d]]).collect(),
            at: 0,
        }
    }

    fn step(&mut self, mut l: f64, mut r: f64) -> (f64, f64) {
        let (mut el, mut er) = (0.0, 0.0);
        for k in 0..4 {
            let a = self.lp[k][0].step(l) * self.g;
            let b = self.lp[k][1].step(r) * self.g;
            let [ll, rr] = &mut self.line[k];
            let (dl, dr) = (ll[self.at], rr[self.at]);
            ll[self.at] = a;
            rr[self.at] = b;
            l = dr; // crossed
            r = dl;
            el += l;
            er += r;
        }
        self.at = (self.at + 1) % self.d;
        (el, er)
    }
}

/// The compressor, streamed: the two channels' mean power over 10 ms about each millisecond's
/// point, a soft-knee gain reduction, smoothed (30 ms attack, 400 ms release) at 1 kHz and read
/// between the points. Gives each sample `delay` samples after it comes in.
struct Compressor {
    hop: usize,
    half: usize,
    delay: usize,
    q: Vec<f64>, // mean square, by sample
    x: [Vec<f64>; 2],
    gains: Vec<f64>, // by point, from point `first`
    first: usize,
    s: f64,
    i: usize,
    a_att: f64,
    a_rel: f64,
    gain: f64, // the gain of the sample given
}

const COMP_RING: usize = 1024;

impl Compressor {
    fn new() -> Self {
        let hop = SR / 1000;
        let half = 5 * hop; // the 10 ms window's half
        Compressor {
            hop,
            half,
            delay: hop + half - 1,
            q: vec![0.0; COMP_RING],
            x: [vec![0.0; COMP_RING], vec![0.0; COMP_RING]],
            gains: Vec::new(),
            first: 0,
            s: 0.0,
            i: 0,
            a_att: (-1.0 / (COMP_ATTACK * 1000.0)).exp(),
            a_rel: (-1.0 / (COMP_RELEASE * 1000.0)).exp(),
            gain: 1.0,
        }
    }

    fn step(&mut self, l: f64, r: f64) -> (f64, f64) {
        let (hop, half, i) = (self.hop, self.half, self.i);
        self.x[0][i % COMP_RING] = l;
        self.x[1][i % COMP_RING] = r;
        self.q[i % COMP_RING] = (l * l + r * r) / 2.0;
        // the point whose window this sample completes
        if i + 1 >= half && (i + 1 - half) % hop == 0 {
            let c = i + 1 - half;
            let mut p = 0.0;
            for j in c as i64 - half as i64..(c + half) as i64 {
                if j >= 0 {
                    p += self.q[j as usize % COMP_RING];
                }
            }
            let lvl = 10.0 * (p / (2 * half) as f64).max(1e-12).log10();
            let (over, k) = (lvl - COMP_THRESH, COMP_KNEE);
            let gr = if over <= -k / 2.0 {
                0.0
            } else if over >= k / 2.0 {
                over * (1.0 - 1.0 / COMP_RATIO)
            } else {
                let o = over + k / 2.0;
                o * o / (2.0 * k) * (1.0 - 1.0 / COMP_RATIO)
            };
            let a = if gr > self.s { self.a_att } else { self.a_rel };
            self.s = a * self.s + (1.0 - a) * gr;
            self.gains.push(10f64.powf(-self.s / 20.0));
        }
        self.i += 1;
        if i < self.delay {
            return (0.0, 0.0);
        }
        let n = i - self.delay;
        let m = n / hop;
        let f = n as f64 / hop as f64 - m as f64;
        let (g0, g1) = (self.gains[m - self.first], self.gains[m + 1 - self.first]);
        let g = g0 + (g1 - g0) * f;
        self.gain = g;
        let out = (self.x[0][n % COMP_RING] * g, self.x[1][n % COMP_RING] * g);
        if m - self.first > 4096 {
            // drop the points behind
            self.gains.drain(..m - self.first);
            self.first = m;
        }
        out
    }
}

const TAPS: usize = 8; // the quarter-sample reader's half length
const RING: usize = 2048;

/// The limiter at the stream's own rate: each sample's gain is what the highest point near it
/// needs (the signal read at quarter samples, linked over the channels), held at its least over 24
/// ms about it, averaged over 12 ms, and never above its own need. Gives each sample `delay`
/// samples late.
pub struct Limiter {
    read: [[f64; 2 * TAPS]; 3],
    ceiling: f64,
    w: usize,
    span: usize,
    pub delay: usize,
    x: [Vec<f64>; 2],
    g: Vec<f64>,
    v_prev: f64,
    // the least-of deque: index, gain
    dq: Vec<i64>,
    dv: Vec<f64>,
    dh: usize,
    dt: usize,
    // the last w held gains; those before the start are 1
    avg: Vec<f64>,
    sum: f64,
    navg: usize,
    i: i64,
    pub gain: f64, // the gain of the sample given
}

impl Default for Limiter {
    fn default() -> Self {
        Self::new()
    }
}

impl Limiter {
    pub fn new() -> Self {
        let mut read = [[0.0; 2 * TAPS]; 3];
        for (r, f) in read.iter_mut().zip([0.25, 0.5, 0.75]) {
            for (k, h) in r.iter_mut().enumerate() {
                let x = f - (k as f64 - TAPS as f64 + 1.0); // tap k reads sample n - TAPS + 1 + k for the point n + f
                let sinc = if x.abs() < 1e-12 { 1.0 } else { (PI * x).sin() / (PI * x) };
                let u = x / TAPS as f64; // Blackman over |x| < TAPS
                *h = sinc * (0.42 + 0.5 * (PI * u).cos() + 0.08 * (2.0 * PI * u).cos());
            }
        }
        let w = ((LIMIT_WINDOW * SR as f64).round() as usize) | 1;
        let hw = (w - 1) / 2;
        let span = w - 1;
        Limiter {
            read,
            ceiling: 10f64.powf(CEILING_DB / 20.0),
            w,
            span,
            delay: TAPS + span + hw,
            x: [vec![0.0; RING], vec![0.0; RING]],
            g: vec![1.0; RING],
            v_prev: 0.0,
            dq: vec![0; RING],
            dv: vec![0.0; RING],
            dh: 0,
            dt: 0,
            avg: vec![1.0; w],
            sum: hw as f64,
            navg: hw,
            i: 0,
            gain: 1.0,
        }
    }

    pub fn step(&mut self, l: f64, r: f64) -> (f64, f64) {
        let at = |j: i64| j as usize % RING;
        let i = self.i;
        self.x[0][at(i)] = l;
        self.x[1][at(i)] = r;
        let n = i - TAPS as i64; // the sample whose quarter points are known now
        if n >= 0 {
            let mut v: f64 = 0.0; // the highest quarter point between n and n + 1
            for h in &self.read {
                let (mut a, mut b) = (0.0, 0.0);
                for (k, hk) in h.iter().enumerate() {
                    let j = n - TAPS as i64 + 1 + k as i64;
                    if j < 0 {
                        continue;
                    }
                    a += self.x[0][at(j)] * hk;
                    b += self.x[1][at(j)] * hk;
                }
                v = v.max(a.abs()).max(b.abs());
            }
            let pk = self.x[0][at(n)].abs().max(self.x[1][at(n)].abs()).max(self.v_prev).max(v);
            self.v_prev = v;
            let g = (self.ceiling / pk.max(1e-9)).min(1.0);
            self.g[at(n)] = g;
            // least over [m - span, m + span] for m = n - span
            while self.dt > self.dh && self.dv[(self.dt - 1) % RING] >= g {
                self.dt -= 1;
            }
            self.dq[self.dt % RING] = n;
            self.dv[self.dt % RING] = g;
            self.dt += 1;
            let m = n - self.span as i64;
            while self.dq[self.dh % RING] < m - self.span as i64 {
                self.dh += 1;
            }
            if m >= 0 {
                let held = self.dv[self.dh % RING];
                self.sum += held - if self.navg >= self.w { self.avg[self.navg % self.w] } else { 0.0 };
                self.avg[self.navg % self.w] = held;
                self.navg += 1;
            }
        }
        let o = i - self.delay as i64; // = m - hw: its average is complete
        self.i += 1;
        if o < 0 {
            return (0.0, 0.0);
        }
        let s = (self.sum / self.w as f64).min(self.g[at(o)]);
        self.gain = s;
        (self.x[0][at(o)] * s, self.x[1][at(o)] * s)
    }
}

// ---------------------------------------------------------------- the room's trace

/// Frames of 10 ms, as room.js TRACE.
pub const TRACE: usize = 240;
/// What a room's trace keeps, a frame each: the mean power of each stage and the dB the compressor
/// and the limiter took off.
pub const STAGES: [&str; 8] = ["dry", "echo", "hall", "master", "mhall", "out", "comp", "lim"];
pub const TRACE_RING: usize = 1 << 15;
const DRY: usize = 0;
const ECHO: usize = 1;
const HALL: usize = 2;
const MASTER: usize = 3;
const MHALL: usize = 4;
const OUT: usize = 5;
const COMP: usize = 6;
const LIM: usize = 7;

/// A room's trace (room.js Trace): for each TRACE samples of its output, the mean power there of each
/// stage and the reduction, in dB, the compressor and the limiter gave a sample there, the last
/// TRACE_RING frames kept.
pub struct Trace {
    pub v: [Vec<f32>; 8],
    /// Frames whose output has all been given.
    pub frames: usize,
}

impl Default for Trace {
    fn default() -> Self {
        Trace { v: std::array::from_fn(|_| vec![0.0; TRACE_RING]), frames: 0 }
    }
}

impl Trace {
    fn open(&mut self, f: usize) {
        for v in &mut self.v {
            v[f % TRACE_RING] = 0.0;
        }
    }

    fn add(&mut self, k: usize, t: usize, x: f64) {
        let a = &mut self.v[k][(t / TRACE) % TRACE_RING];
        *a = (*a as f64 + x / TRACE as f64) as f32;
    }

    fn most(&mut self, k: usize, t: usize, db: f64) {
        let a = &mut self.v[k][(t / TRACE) % TRACE_RING];
        if db > *a as f64 {
            *a = db as f32;
        }
    }
}

fn db(g: f64) -> f64 {
    -20.0 * g.max(1e-9).log10()
}

// ---------------------------------------------------------------- the room

/// push(dry, send) with left and right of any length gives the finished output there is; end()
/// gives the rest and TAIL s of the room's ring. With a trace, trace is the room's. wet scales the
/// echo and both halls (1: as set). A room picked up in the middle of a piece: `at` is the sample of
/// the piece its first is (a whole number of TRACE), and it traces from `from` on, what comes before
/// being its run-up.
pub struct Room {
    r: Amounts,
    echo: Echo,
    hall: Option<Convolver>,
    mhall: Option<Convolver>,
    send: [Biquad; 2],
    send_lp: [Biquad; 2],
    hp: [Biquad; 2],
    comp: Compressor,
    lim: Limiter,
    delay: usize,
    pend: [VecDeque<f64>; 4], // dry l, r, send l, r not yet a block
    input: usize,             // samples of mix in
    out: usize,               // samples given
    fed: usize,               // samples of mix through the chain
    skip: usize,
    pub wet: f64,
    pub trace: Option<Trace>,
    t0: usize,
    tfrom: usize,
    buf: [Vec<f64>; 12],
}

impl Room {
    pub fn new(name: &str, bpm: f64, seed: i64, trace: bool, at: usize, from: usize) -> Result<Self> {
        let r = room(name)?;
        if !(bpm > 0.0 && bpm.is_finite()) {
            return err(format!("room: bpm {bpm}"));
        }
        if !at.is_multiple_of(TRACE) || !from.is_multiple_of(TRACE) || from < at {
            return err(format!("room: from sample {at}, traced from {from}"));
        }
        let comp = Compressor::new();
        let lim = Limiter::new();
        let delay = comp.delay + lim.delay;
        let hp = |hz, high| Biquad::new(butter(2, hz, high));
        Ok(Room {
            r,
            echo: Echo::new(bpm),
            hall: (r.wet != 0.0).then(|| Convolver::new(hall(3.5, r.rt, r.rt_hi, 0.03, seed))),
            mhall: (r.mwet != 0.0).then(|| Convolver::new(hall(5.5, r.mrt, r.mrt_hi, 0.04, seed + 6))),
            send: [hp(200.0, true), hp(200.0, true)],
            send_lp: [hp(5000.0, false), hp(5000.0, false)],
            hp: [hp(30.0, true), hp(30.0, true)],
            comp,
            lim,
            delay,
            pend: std::array::from_fn(|_| VecDeque::new()),
            input: 0,
            out: 0,
            fed: 0,
            skip: delay,
            wet: 1.0,
            trace: trace.then(Trace::default),
            t0: at,
            tfrom: from,
            buf: std::array::from_fn(|_| vec![0.0; BLOCK]),
        })
    }

    /// The mix's next samples, dry and send, left and right: the room's output there is, to out.
    pub fn push(&mut self, dry: [&[f32]; 2], send: [&[f32]; 2], out: &mut [Vec<f32>; 2]) -> Result<()> {
        let n = dry[0].len();
        if dry[1].len() != n || send[0].len() != n || send[1].len() != n {
            return err("room: the buses differ in length".to_string());
        }
        for (c, x) in [dry[0], dry[1], send[0], send[1]].into_iter().enumerate() {
            self.pend[c].extend(x.iter().map(|&v| v as f64));
        }
        self.input += n;
        while self.pend[0].len() >= BLOCK {
            self.block(usize::MAX, out);
        }
        Ok(())
    }

    /// The rest of the mix, then the ring, to TAIL s past the mix's end.
    pub fn end(&mut self, out: &mut [Vec<f32>; 2]) {
        let want = self.input + (TAIL * SR as f64).round() as usize;
        while self.out < want {
            let n = self.pend[0].len();
            if n < BLOCK {
                for p in &mut self.pend {
                    p.extend(std::iter::repeat_n(0.0, BLOCK - n));
                }
            }
            self.block(want, out);
        }
    }

    /// One block of the pending input through the room; the first `delay` samples out are dropped.
    fn block(&mut self, limit: usize, out: &mut [Vec<f32>; 2]) {
        let b = BLOCK;
        let mut buf = std::mem::take(&mut self.buf);
        for (d, p) in buf.iter_mut().zip(&mut self.pend) {
            for (d, s) in d.iter_mut().zip(p.drain(..b)) {
                *d = s;
            }
        }
        let [dl, dr, sl, sr, el, er, hl, hr, ml, mr, xl, xr] = &mut buf;
        let r = self.r;
        let (ec, we, mw) = (r.echo * self.wet, r.wet * self.wet, r.mwet * self.wet);
        for i in 0..b {
            let e = self.echo.step(sl[i], sr[i]);
            el[i] = e.0;
            er[i] = e.1;
            xl[i] = sl[i] + 0.5 * e.0;
            xr[i] = sr[i] + 0.5 * e.1;
        }
        match &mut self.hall {
            Some(h) => h.run(xl, xr, hl, hr),
            None => {
                hl.fill(0.0);
                hr.fill(0.0);
            }
        }
        for i in 0..b {
            ml[i] = dl[i] + ec * el[i] + we * hl[i];
            mr[i] = dr[i] + ec * er[i] + we * hr[i];
            let j = self.t0 + self.fed + i;
            if let Some(t) = self.trace.as_mut().filter(|_| j >= self.tfrom) {
                if j.is_multiple_of(TRACE) {
                    t.open(j / TRACE);
                }
                t.add(DRY, j, (dl[i] * dl[i] + dr[i] * dr[i]) / 2.0);
                t.add(ECHO, j, ec * ec * (el[i] * el[i] + er[i] * er[i]) / 2.0);
                t.add(HALL, j, we * we * (hl[i] * hl[i] + hr[i] * hr[i]) / 2.0);
                t.add(MASTER, j, (ml[i] * ml[i] + mr[i] * mr[i]) / 2.0);
            }
            xl[i] = self.send_lp[0].step(self.send[0].step(ml[i]));
            xr[i] = self.send_lp[1].step(self.send[1].step(mr[i]));
        }
        match &mut self.mhall {
            Some(h) => h.run(xl, xr, hl, hr),
            None => {
                hl.fill(0.0);
                hr.fill(0.0);
            }
        }
        for i in 0..b {
            let a = self.hp[0].step(ml[i] + mw * hl[i]);
            let c = self.hp[1].step(mr[i] + mw * hr[i]);
            let o = self.comp.step(a, c);
            let o = self.lim.step(o.0, o.1);
            let j = self.t0 + self.fed + i;
            if let Some(t) = self.trace.as_mut() {
                if j >= self.tfrom {
                    t.add(MHALL, j, mw * mw * (hl[i] * hl[i] + hr[i] * hr[i]) / 2.0);
                }
                if j >= self.comp.delay && j - self.comp.delay >= self.tfrom {
                    t.most(COMP, j - self.comp.delay, db(self.comp.gain));
                }
                if j >= self.delay && j - self.delay >= self.tfrom {
                    t.most(LIM, j - self.delay, db(self.lim.gain));
                }
            }
            if self.skip > 0 {
                self.skip -= 1;
                continue;
            }
            if self.out >= limit {
                break;
            }
            out[0].push(o.0 as f32);
            out[1].push(o.1 as f32);
            let t_out = self.t0 + self.out;
            if let Some(t) = self.trace.as_mut().filter(|_| t_out >= self.tfrom) {
                t.add(OUT, t_out, (o.0 * o.0 + o.1 * o.1) / 2.0);
            }
            self.out += 1;
        }
        self.fed += b;
        if let Some(t) = self.trace.as_mut() {
            t.frames = (self.t0 + self.out) / TRACE;
        }
        self.buf = buf;
    }

    /// Samples of the room's output given so far.
    pub fn given(&self) -> usize {
        self.out
    }

    /// Samples the room gives each sample late by, past the block it waits for.
    pub fn delay(&self) -> usize {
        self.delay
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn most_apart(a: &[f64], b: &[f64]) -> f64 {
        a.iter().zip(b).fold(0.0, |m, (x, y)| m.max((x - y).abs()))
    }

    #[test]
    fn the_filters_are_scipys() {
        // scipy.signal.butter(order, fc / 12000, type): [b0, b1, b2, a1, a2]
        let scipy: [(u32, f64, bool, [f64; 5]); 6] = [
            (1, 3000.0, false, [0.2928932188134525, 0.2928932188134525, 0.0, -0.4142135623730949, 0.0]),
            (2, 2500.0, false, [0.07223087532575319, 0.14446175065150638, 0.07223087532575319, -1.109228792618427, 0.39815229392143964]),
            (2, 2500.0, true, [0.6268452716349667, -1.2536905432699335, 0.6268452716349667, -1.109228792618427, 0.39815229392143964]),
            (2, 200.0, true, [0.9636527639641734, -1.9273055279283469, 0.9636527639641734, -1.9259839697318861, 0.9286270861248077]),
            (2, 5000.0, false, [0.22019470027295873, 0.44038940054591746, 0.22019470027295873, -0.30756635979220975, 0.18834516088404465]),
            (2, 30.0, true, [0.9944617889581948, -1.9889235779163896, 0.9944617889581948, -1.9888929058996532, 0.9889542499331266]),
        ];
        for (o, fc, high, want) in scipy {
            assert!(most_apart(&butter(o, fc, high), &want) < 1e-12, "butter {o} {fc} {high}");
        }
        // a section from rest: y[n] = b0 x[n] + b1 x[n-1] + b2 x[n-2] - a1 y[n-1] - a2 y[n-2]
        let c = butter(2, 2500.0, false);
        let mut f = Biquad::new(c);
        let mut r = Rnd::new("biquad");
        let x: Vec<f64> = (0..500).map(|_| normal(&mut r)).collect();
        let mut y: Vec<f64> = Vec::new();
        for n in 0..x.len() {
            let at = |v: &[f64], k: usize| if n >= k { v[n - k] } else { 0.0 };
            let v = c[0] * x[n] + c[1] * at(&x, 1) + c[2] * at(&x, 2) - c[3] * at(&y, 1) - c[4] * at(&y, 2);
            y.push(v);
        }
        let got: Vec<f64> = x.iter().map(|&v| f.step(v)).collect();
        assert!(most_apart(&got, &y) < 1e-12);
    }

    #[test]
    fn the_convolver_is_the_direct_sum() {
        let mut r = Rnd::new("conv");
        let (m, n) = (3 * BLOCK + 517, 5 * BLOCK);
        let ir = [(0..m).map(|_| normal(&mut r)).collect::<Vec<_>>(), (0..m - 900).map(|_| normal(&mut r)).collect::<Vec<_>>()];
        let x = [(0..n).map(|_| normal(&mut r)).collect::<Vec<_>>(), (0..n).map(|_| normal(&mut r)).collect::<Vec<_>>()];
        let mut c = Convolver::new(ir.clone());
        let mut y = [vec![0.0; n], vec![0.0; n]];
        let (mut ol, mut or) = (vec![0.0; BLOCK], vec![0.0; BLOCK]);
        for k in (0..n).step_by(BLOCK) {
            c.run(&x[0][k..k + BLOCK], &x[1][k..k + BLOCK], &mut ol, &mut or);
            y[0][k..k + BLOCK].copy_from_slice(&ol);
            y[1][k..k + BLOCK].copy_from_slice(&or);
        }
        let mut e: f64 = 0.0;
        for ch in 0..2 {
            for i in 0..n {
                let s: f64 = (i.saturating_sub(ir[ch].len() - 1)..=i).map(|j| x[ch][j] * ir[ch][i - j]).sum();
                e = e.max((s - y[ch][i]).abs());
            }
        }
        assert!(e < 1e-9, "{e}");
    }

    #[test]
    fn a_hall_waits_out_its_predelay_and_has_unit_energy() {
        let [l, r] = hall(3.5, 1.5, 0.8, 0.03, 1);
        assert_eq!(l.len(), (3.53 * SR as f64).round() as usize);
        assert!(l[..720].iter().all(|&v| v == 0.0) && l[720] != 0.0);
        let energy = |x: &[f64]| x.iter().map(|v| v * v).sum::<f64>();
        assert!((energy(&l) - 1.0).abs() < 1e-9 && (energy(&r) - 1.0).abs() < 1e-9);
        assert!(l.iter().zip(&r).any(|(a, b)| a != b));
    }

    #[test]
    fn the_echo_crosses_at_half_a_beat_four_times() {
        let mut e = Echo::new(75.0);
        let d = (60.0f64 / 75.0 / 2.0 * SR as f64).round() as usize;
        let (mut yl, mut yr) = (Vec::new(), Vec::new());
        for i in 0..5 * d + 100 {
            let o = e.step(if i == 0 { 1.0 } else { 0.0 }, 0.0);
            yl.push(o.0);
            yr.push(o.1);
        }
        let first = |x: &[f64], from: usize| (from..x.len()).find(|&i| x[i] != 0.0);
        assert_eq!(first(&yr, 0), Some(d));
        assert_eq!(first(&yl, 0), Some(2 * d));
        let peak = |x: &[f64], a: usize| x[a..a + d].iter().fold(0.0f64, |m, v| m.max(v.abs()));
        let p = [peak(&yr, d), peak(&yl, 2 * d), peak(&yr, 3 * d), peak(&yl, 4 * d)];
        assert!(p.windows(2).all(|w| w[1] < w[0]), "{p:?}");
        assert!(yl[5 * d..].iter().all(|v| v.abs() < 1e-3 * p[0]));
        assert!(yr[4 * d..5 * d].iter().all(|v| v.abs() < 1e-3 * p[0]));
    }

    #[test]
    fn a_room_gives_as_much_as_it_took_and_its_ring() {
        let mut room = Room::new("card", 90.0, 1, true, 0, 0).unwrap();
        let x: Vec<f32> = (0..10_000).map(|i| (i as f32 * 0.01).sin() * 0.1).collect();
        let mut out = [Vec::new(), Vec::new()];
        room.push([&x, &x], [&x, &x], &mut out).unwrap();
        room.end(&mut out);
        assert_eq!(out[0].len(), 10_000 + (TAIL * SR as f64).round() as usize);
        assert_eq!(out[0].len(), out[1].len());
        assert!(out[0].iter().all(|v| v.is_finite()));
    }

    #[test]
    fn no_room_by_another_name() {
        assert!(Room::new("hall", 90.0, 1, false, 0, 0).is_err());
    }
}
