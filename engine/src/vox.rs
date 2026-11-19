// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The latent voice's sound from a plan:
//! the loudness model draws each frame's loudness, the prior draws the code z, the generator
//! renders z on the plan's pitch, and the plan's loudness and tilt edits go on the samples.
//!
//! A model file holds the loudness model under loud., the prior under prior.,
//! the generator under gen., `draw`: the prior's temperature and the loudness model's, and `reads`:
//! the digest of the text encoder whose token states it was trained on (score::enc_digest), a score
//! model's own, which it has no copy of. A flow's `ada` (steps, blocks, 3 dim) is what its time
//! layers give each block at each of its Euler steps. A voice's parts are in
//! its voice file under vox.: for each of prior. and loud. its vector `spk`, its low-rank updates of
//! the model's layers (lora.LAYER.A and .B; none, or one for every layer a voice may update) and
//! `digest`, the model's it was fitted for. The models are loaded once (Model) and each voice wears
//! them (Vox) with its parts alone.
//!
//! A part is rendered a stretch of frames at a time (Stream), on its pitch as far as that is made.
//! A layer's output takes in its radius of input either side, so every layer of every Euler step
//! keeps its input from the first row a later output needs (Act) and each row of each layer is made
//! once; the samples are the same however the part is cut and however its pitch comes. What a stream
//! holds of the part's frames (its conditions, its draws, z, the noise, the source, the samples its
//! edits read) is held the same way, from the first row still to be read, so a part costs what its
//! reach does and not what its length does.

use crate::dsp::{MinPhase, Ola, Source, Stft, HOP, NBIN, NFFT, SR};
use crate::fft::C;
use crate::front::{self, SPACE};
use crate::inflect;
use crate::nn::{gelu_slice, Conv1d, ConvNeXt, DwConv, LayerNorm, Linear};
use crate::rng::{Gaussian, Rng};
use crate::vocoder::{LF0_MU, LF0_SD};
use crate::weights::{err, Result, Weights};
use std::rc::Rc;

/// The band of pitch, Hz, in which the prior is told the octave below (said): C#5 to D#5, to the
/// quarter tone either side.
const FOLD_HZ: (f32, f32) = (540.0, 640.0);
/// The frames either side of a frame whose pitch says whether it is in the band: a fifth of a
/// second in all, a turn of a vibrato and more.
pub const FOLD_SPAN: usize = 10;

/// The log F0 the prior is told for frames a to b of a part of t, `pitch` the part's from its start
/// as far as frame b + FOLD_SPAN or its end: the octave below where the pitch is in FOLD_HZ. Its
/// description of a voice thins to a bare fundamental there and holds again above; an octave down,
/// the harmonics it describes fall on the sung ones. A frame is in the band by the mean pitch of
/// the frames FOLD_SPAN either side of it, so that a note is told one way through its vibrato, and
/// by nothing further off, so that a part picked up is told as the whole is. The loudness model is
/// told the pitch as it is, and the generator sings it. `close`: whether each of the part's frames
/// is a close vowel's (closes), or none; such a frame is told its pitch as it is, since the octave
/// below a close vowel is described as little but its fundamental, which the sung note has not.
fn said(pitch: &[f32], close: &[bool], a: usize, b: usize, t: usize) -> Vec<f32> {
    let (lo, hi) = (FOLD_HZ.0.ln(), FOLD_HZ.1.ln());
    (a..b)
        .map(|i| {
            let w = &pitch[i.saturating_sub(FOLD_SPAN)..(i + FOLD_SPAN + 1).min(t)];
            let mean = w.iter().sum::<f32>() / w.len() as f32;
            if mean > lo && mean <= hi && !close.get(i).copied().unwrap_or(false) {
                pitch[i] - std::f32::consts::LN_2
            } else {
                pitch[i]
            }
        })
        .collect()
}

/// The generator's parts a frame, NBIN each: the harmonic filter's log magnitude and phase residual,
/// the noise filter's log magnitude, and the residual's log magnitude and phase.
const PARTS: usize = 5;
/// The most the filters' and the residual's log magnitudes may be.
const FILTER_TOP: f32 = 8.0;
const RESID_TOP: f32 = 6.0;
/// Frames of the generator's head run at once.
const HEAD_ROWS: usize = 32;

/// A voice's low-rank update of a Linear, W + B A, run in float beside it.
struct Up {
    /// A, the Linear's input to the rank r.
    down: Linear,
    /// B's columns (r, cout).
    cols: Vec<f32>,
}

impl Up {
    /// The voice's update of the Linear `name`, cin to cout.
    fn load(voice: &Weights, name: &str, cout: usize, cin: usize) -> Result<Up> {
        let (an, bn) = (format!("lora.{name}.A"), format!("lora.{name}.B"));
        let r = voice.get(&an)?.shape.first().copied().unwrap_or(0);
        let (a, b) = (voice.shaped(&an, &[r, cin])?, voice.shaped(&bn, &[cout, r])?);
        Ok(Up { down: Linear::new(a, &vec![0.0; r], r, cin), cols: (0..r * cout).map(|i| b[(i % cout) * r + i / cout]).collect() })
    }

    /// B A x onto the Linear's output of x (t rows).
    fn add(&self, x: &[f32], t: usize, out: &mut [f32]) {
        let (r, cout) = (self.down.cout, self.cols.len() / self.down.cout.max(1));
        let mut low = vec![0.0; t * r];
        self.down.forward(x, t, &mut low);
        for (lr, or) in low.chunks_exact(r).zip(out.chunks_exact_mut(cout)) {
            for (l, col) in lr.iter().zip(self.cols.chunks_exact(cout)) {
                or.iter_mut().zip(col).for_each(|(o, c)| *o += l * c);
            }
        }
    }
}

/// A voice's parts for a flow: its vector, and its update of every layer a voice may update (cin,
/// then each block's pw1 and pw2) or of none.
struct Wear {
    spk: Vec<f32>,
    ups: Vec<Up>,
}

impl Wear {
    /// Layer i's output of x with the voice's update of it.
    fn forward(&self, i: usize, lin: &Linear, x: &[f32], t: usize, out: &mut [f32]) {
        lin.forward(x, t, out);
        if let Some(u) = self.ups.get(i) {
            u.add(x, t, out);
        }
    }
}

/// Rows over time (a layer's input, or a part's frames or samples), known to row `done` and held
/// from row `base`, the first still to be read.
struct Act {
    dim: usize,
    base: usize,
    done: usize,
    rows: Vec<f32>,
}

impl Act {
    fn new(dim: usize) -> Act {
        Act { dim, base: 0, done: 0, rows: Vec::new() }
    }

    /// Rows known from the first to the last.
    fn whole(dim: usize, rows: Vec<f32>) -> Act {
        Act { dim, base: 0, done: rows.len() / dim, rows }
    }

    fn push(&mut self, rows: &[f32]) {
        self.rows.extend_from_slice(rows);
        self.done += rows.len() / self.dim;
    }

    /// Rows [a, b).
    fn span(&self, a: usize, b: usize) -> &[f32] {
        assert!(self.base <= a && a <= b && b <= self.done, "rows {a}..{b} of {}..{}", self.base, self.done);
        &self.rows[(a - self.base) * self.dim..(b - self.base) * self.dim]
    }

    /// Lets go of the rows before `to`.
    fn trim(&mut self, to: usize) {
        let to = to.min(self.done);
        if to > self.base {
            self.rows.drain(..(to - self.base) * self.dim);
            self.base = to;
        }
    }

    /// Unit noise times `scale` drawn onto the rows, to row `to`.
    fn draw(&mut self, g: &mut Gaussian, scale: f32, to: usize) {
        let n = to.saturating_sub(self.done) * self.dim;
        let mut v = Vec::with_capacity(n);
        g.draw(n, &mut v);
        v.iter_mut().for_each(|x| *x *= scale);
        self.push(&v);
    }
}

/// Each frame's token, for tokens of these frames.
fn frame_tokens(dur: &[usize]) -> Vec<u32> {
    dur.iter().enumerate().flat_map(|(i, &k)| std::iter::repeat(i as u32).take(k)).collect()
}

/// run_stack's layer.
type Layer<'a> = &'a dyn Fn(usize, &[f32], usize, usize, &mut [f32]);

/// The input rows of t that layers of these radii take in for output rows up to `top`.
fn reach(radii: &[usize], top: usize, t: usize) -> usize {
    (top + radii.iter().sum::<usize>()).min(t)
}

/// Layers over time, one on the next, run until the last's output is known to row `top` of t; its
/// new rows, from row `done` on. acts[i] is layer i's input, the first's there to reach(); radii[i]
/// its radius; layer(i, x, rows, from, out) puts its output rows from `from` on of x (`rows` rows,
/// nothing outside them) into `out`, of `wide` a row for the last.
fn run_stack(acts: &mut [Act], done: &mut usize, radii: &[usize], t: usize, top: usize, wide: usize, layer: Layer) -> Vec<f32> {
    let nl = acts.len();
    let mut need = vec![top.min(t); nl + 1];
    for i in (0..nl).rev() {
        need[i] = (need[i + 1] + radii[i]).min(t);
    }
    assert!(acts[0].done >= need[0], "input to row {} for output to {top}, not {}", acts[0].done, need[0]);
    let mut out = Vec::new();
    for i in 0..nl {
        let (inp, rest) = acts[i..].split_first_mut().unwrap();
        let (a, b) = (rest.first().map_or(*done, |n| n.done), need[i + 1]);
        if a >= b {
            continue;
        }
        // the rows held end at the part's ends or a radius beyond the new output
        assert!((inp.base == 0 || a - inp.base >= radii[i]) && inp.done >= (b + radii[i]).min(t));
        let mut y = vec![0.0; (b - a) * rest.first().map_or(wide, |n| n.dim)];
        layer(i, &inp.rows, inp.done - inp.base, a - inp.base, &mut y);
        let keep = b.saturating_sub(radii[i]).max(inp.base);
        inp.rows.drain(..(keep - inp.base) * inp.dim);
        inp.base = keep;
        match rest.first_mut() {
            Some(n) => n.push(&y),
            None => (out, *done) = (y, b),
        }
    }
    out
}

struct Block {
    dw: DwConv,
    pw1: Linear,
    pw2: Linear,
}

/// A flow-matching net over (T, zdim) on frame conditions: the prior over z,
/// told each frame's loudness, and the loudness model over one dim.
struct Flow {
    dim: usize,
    zdim: usize,
    cdim: usize,
    loud: bool,
    cin: Linear,
    xin: Linear,
    /// (steps, blocks, 3 dim): at each Euler step, each block's norm's scale less 1, its shift and
    /// its residual's gate.
    ada: Vec<f32>,
    steps: usize,
    blocks: Vec<Block>,
    norm: LayerNorm,
    out: Linear,
    zmu: Vec<f32>,
    zsd: Vec<f32>,
    /// What a voice fitted for it says it was fitted for.
    digest: Vec<i8>,
}

fn named<T>(what: &str, r: Result<T>) -> Result<T> {
    r.map_err(|e| crate::weights::Error(format!("{what}: {}", e.0)))
}

impl Flow {
    /// The model's tensors, without their prefix, of a net told loudness or not.
    fn load(ws: &Weights, loud: bool) -> Result<Flow> {
        let (x, c) = (ws.get("xin.weight")?, ws.get("cin.weight")?);
        let told = 2 + loud as usize;
        if x.shape.len() != 2 || c.shape.len() != 2 || c.shape[0] != x.shape[0] || c.shape[1] <= told {
            return err(format!("xin {:?}, cin {:?}", x.shape, c.shape));
        }
        let (dim, zdim) = (x.shape[0], x.shape[1]);
        let ada = ws.get("ada")?;
        if ada.shape.len() != 3 || ada.shape[0] == 0 || ada.shape[2] != 3 * dim {
            return err(format!("ada {:?} for a width of {dim}", ada.shape));
        }
        let (steps, depth) = (ada.shape[0], ada.shape[1]);
        let mult = ws.get("blocks.0.pw1.weight")?.shape[0] / dim;
        let mut blocks = Vec::new();
        for i in 0..depth {
            let p = format!("blocks.{i}");
            let k = ws.get(&format!("{p}.dw.weight"))?.shape[2];
            blocks.push(Block {
                dw: DwConv::load(ws, &format!("{p}.dw"), dim, k)?,
                pw1: Linear::load(ws, &format!("{p}.pw1"), dim * mult, dim)?,
                pw2: Linear::load(ws, &format!("{p}.pw2"), dim, dim * mult)?,
            });
        }
        Ok(Flow {
            dim,
            zdim,
            cdim: c.shape[1] - told,
            loud,
            cin: Linear::load(ws, "cin", dim, c.shape[1])?,
            xin: Linear::load(ws, "xin", dim, zdim)?,
            ada: ada.data.clone(),
            steps,
            blocks,
            norm: LayerNorm::load(ws, "norm", dim)?,
            out: Linear::load(ws, "out", zdim, dim)?,
            zmu: ws.shaped("zmu", &[zdim])?.to_vec(),
            zsd: ws.shaped("zsd", &[zdim])?.to_vec(),
            digest: ws.shaped_i8("digest", &[8])?.to_vec(),
        })
    }

    /// The layers a voice may update, as a voice's file names them, and each one's output and input.
    fn layers(&self) -> Vec<(String, usize, usize)> {
        let one = |n: String, l: &Linear| (n, l.cout, l.cin);
        std::iter::once(one("cin".to_string(), &self.cin))
            .chain(self.blocks.iter().enumerate().flat_map(|(i, b)| [one(format!("blocks.{i}.pw1"), &b.pw1), one(format!("blocks.{i}.pw2"), &b.pw2)]))
            .collect()
    }

    /// A voice's tensors for the net, without their prefix.
    fn wear(&self, voice: &Weights) -> Result<Wear> {
        let spk = voice.get("spk")?.data.clone();
        if spk.len() != self.cdim {
            return err(format!("the voice's vector of {}, states of {}", spk.len(), self.cdim));
        }
        if self.digest != voice.shaped_i8("digest", &[8])? {
            return err("the voice was fitted for another model");
        }
        let layers = self.layers();
        let updates = voice.names().filter(|n| n.starts_with("lora.")).count();
        if updates != 0 && updates != 2 * layers.len() {
            return err(format!("the voice updates {updates} tensors, not none or the {} of every layer", 2 * layers.len()));
        }
        if let Some(n) = voice.names().find(|n| {
            !matches!(n.as_str(), "spk" | "digest") && !layers.iter().any(|(l, ..)| **n == format!("lora.{l}.A") || **n == format!("lora.{l}.B"))
        }) {
            return err(format!("{n}: not part of a voice"));
        }
        let ups = if updates == 0 { Vec::new() } else { layers.iter().map(|(l, o, i)| Up::load(voice, l, *o, *i)).collect::<Result<_>>()? };
        Ok(Wear { spk, ups })
    }

    /// The conditions' rows (cin's width) for frames a on, as many as lf0 holds: each frame's token's
    /// state (h (N, cdim), `tok` each frame's token) plus the voice's vector, its log F0 and voicing
    /// and, in a net told loudness, that.
    #[allow(clippy::too_many_arguments)]
    fn rows(&self, w: &Wear, h: &[f32], tok: &[u32], a: usize, lf0: &[f32], vuv: &[f32], loud: &[f32]) -> Vec<f32> {
        let d = self.cdim;
        assert!(vuv.len() == lf0.len() && loud.len() == if self.loud { lf0.len() } else { 0 }, "a net told loudness or not");
        let mut x = Vec::with_capacity(lf0.len() * self.cin.cin);
        for (i, (l, v)) in lf0.iter().zip(vuv).enumerate() {
            let row = &h[tok[a + i] as usize * d..][..d];
            x.extend(row.iter().zip(&w.spk).map(|(p, q)| p + q));
            x.extend([(l - LF0_MU) / LF0_SD, *v]);
            x.extend(loud.get(i));
        }
        x
    }

    /// The conditions' rows x projected, onto their projection cc (dim a row).
    fn project(&self, w: &Wear, x: &[f32], cc: &mut Act) {
        let n = x.len() / self.cin.cin;
        let mut out = vec![0.0; n * self.dim];
        w.forward(0, &self.cin, x, n, &mut out);
        cc.push(&out);
    }

    /// Each block's radius.
    fn radii(&self) -> Vec<usize> {
        self.blocks.iter().map(|b| b.dw.radius()).collect()
    }

    /// Frames either side the whole draw takes in.
    fn radius(&self) -> usize {
        self.steps * self.radii().iter().sum::<usize>()
    }

    /// A draw of t frames from x (zdim a row), no step taken: x given whole, or as far as it has
    /// come with the unit noise and the scale on it that the rest is drawn from as it is needed.
    fn begin(&self, t: usize, x: Act, src: Option<(Gaussian, f32)>) -> Drawing {
        assert!(x.dim == self.zdim && (src.is_some() || x.done == t));
        let x = std::iter::once(x).chain((0..self.steps).map(|_| Act::new(self.zdim))).collect();
        let acts = (0..self.steps).map(|_| self.blocks.iter().map(|_| Act::new(self.dim)).collect()).collect();
        Drawing { t, x, src, acts }
    }

    /// Euler's last level known to frame `to`, on the conditions' projection cc (dim a row), its rows
    /// there to `to` + radius(). Each level but the last, and cc, is let go of as far as it is read.
    fn advance(&self, wear: &Wear, cc: &mut Act, dr: &mut Drawing, to: usize) {
        let (d, z, steps, radii) = (self.dim, self.zdim, self.steps, self.radii());
        let t = dr.t;
        let mut need = vec![to.min(t); steps + 1];
        for k in (0..steps).rev() {
            need[k] = reach(&radii, need[k + 1], t);
        }
        if let Some((g, scale)) = &mut dr.src {
            dr.x[0].draw(g, *scale, need[0]);
        }
        for k in 0..steps {
            let (from, into) = dr.x.split_at_mut(k + 1);
            let (x, next) = (&mut from[k], &mut into[0]);
            // the blocks' input for the level's new rows
            let (a, b) = (dr.acts[k][0].done, need[k]);
            if b > a {
                let mut h = vec![0.0; (b - a) * d];
                self.xin.forward(x.span(a, b), b - a, &mut h);
                h.iter_mut().zip(cc.span(a, b)).for_each(|(p, c)| *p += c);
                dr.acts[k][0].push(&h);
            }
            let block = |i: usize, h: &[f32], rows: usize, from: usize, out: &mut [f32]| {
                let (bl, n) = (&self.blocks[i], out.len() / d);
                let ada = &self.ada[(k * self.blocks.len() + i) * 3 * d..][..3 * d];
                let mut w = vec![0.0; n * bl.pw1.cout];
                bl.dw.forward_rows(h, rows, from, n, out);
                LayerNorm::new(ada[..d].iter().map(|s| 1.0 + s).collect(), ada[d..2 * d].to_vec()).forward(out);
                wear.forward(1 + 2 * i, &bl.pw1, out, n, &mut w);
                gelu_slice(&mut w);
                wear.forward(2 + 2 * i, &bl.pw2, &w, n, out);
                let gate = &ada[2 * d..];
                for (or, hr) in out.chunks_exact_mut(d).zip(h[from * d..].chunks_exact(d)) {
                    for c in 0..d {
                        or[c] = hr[c] + gate[c] * or[c];
                    }
                }
            };
            let (a, mut made) = (next.done, next.done);
            let mut h = run_stack(&mut dr.acts[k], &mut made, &radii, t, need[k + 1], d, &block);
            let n = h.len() / d;
            let mut v = vec![0.0; n * z];
            self.norm.forward(&mut h);
            self.out.forward(&h, n, &mut v);
            v.iter_mut().zip(x.span(a, a + n)).for_each(|(q, x)| *q = x + *q / steps as f32);
            next.push(&v);
            assert_eq!(next.done, made);
            x.trim(next.done);
        }
        cc.trim(dr.acts.iter().map(|a| a[0].done).min().unwrap_or(0));
    }
}

/// A flow's draw a stretch at a time: x (zdim a row) at each Euler level, each held from the first
/// row the next level has still to be made from, the last from the first not let go (Drawing::trim);
/// the noise level 0 is drawn from, if it is not given whole; and each step's blocks' inputs.
struct Drawing {
    /// The part's frames.
    t: usize,
    x: Vec<Act>,
    src: Option<(Gaussian, f32)>,
    acts: Vec<Vec<Act>>,
}

impl Drawing {
    /// The last level.
    fn last(&self) -> &Act {
        self.x.last().unwrap()
    }

    /// Lets go of the last level's rows before `to`.
    fn trim(&mut self, to: usize) {
        self.x.last_mut().unwrap().trim(to);
    }
}

/// z, log F0 and voicing to the sound's STFT as filters on a harmonic source and on noise, plus a
/// free residual (resid, long noise, every block).
///
/// The residual alone makes a hiss, and with the phase the model gives it there a frame's sound
/// gathers at one instant: a needle a few samples wide, the same place in every frame and every
/// voice, which singers on one clock add up, and which one voice's hiss beats with a hundred times
/// a second (a zipper under a Z's note). So in a frame of a token that sings a hiss (hisses) the
/// residual keeps its spectrum's shape and takes a phase drawn for the frame (Phases), at the
/// level that lays down the energy the model's did: the needle falls where the frame's window is
/// low, and the same magnitudes spread over the frame would be some 4 dB louder. An unvoiced
/// frame's whole residual takes it; a voiced frame's (a Z, the space a hiss ends in) from HISS_FROM
/// up, where the residual leads the harmonics, and below it keeps the model's.
pub struct Gen {
    dim: usize,
    zdim: usize,
    inp: Conv1d,
    norm0: LayerNorm,
    blocks: Vec<ConvNeXt>,
    norm: LayerNorm,
    head: Linear,
    stft: Stft,
}

impl Gen {
    fn load(ws: &Weights) -> Result<Gen> {
        let w = ws.get("inp.weight")?;
        if w.shape.len() != 3 || w.shape[1] < 3 {
            return err(format!("gen: inp {:?}", w.shape));
        }
        let (dim, zdim, k) = (w.shape[0], w.shape[1] - 2, w.shape[2]);
        let rows = ws.get("head.weight")?.shape[0];
        if rows != PARTS * NBIN {
            return err(format!("gen: a head of {rows} rows; a generator with a residual and long noise has {}", PARTS * NBIN));
        }
        let mut blocks = Vec::new();
        while ws.has(&format!("blocks.{}.gamma", blocks.len())) {
            let p = format!("blocks.{}", blocks.len());
            let (mult, bk) = (ws.get(&format!("{p}.pw1.weight"))?.shape[0] / dim, ws.get(&format!("{p}.dw.weight"))?.shape[2]);
            blocks.push(ConvNeXt::load(ws, &p, dim, mult, bk)?);
        }
        Ok(Gen {
            dim,
            zdim,
            inp: Conv1d::load(ws, "inp", dim, zdim + 2, k)?,
            norm0: LayerNorm::load(ws, "norm0", dim)?,
            blocks,
            norm: LayerNorm::load(ws, "norm", dim)?,
            head: Linear::load(ws, "head", PARTS * NBIN, dim)?,
            stft: Stft::new(),
        })
    }

    /// The radius of the conv on z and of each block.
    fn radii(&self) -> Vec<usize> {
        std::iter::once(self.inp.radius()).chain(self.blocks.iter().map(|b| b.radius())).collect()
    }

    /// Frames either side a frame's spectrum takes in.
    pub fn radius(&self) -> usize {
        self.radii().iter().sum()
    }

    /// T * HOP samples from z (T, zdim) on the pitch. `noise` is white with unit variance, T * HOP
    /// samples.
    pub fn render(&self, z: &[f32], lf0: &[f32], vuv: &[f32], noise: &[f32]) -> Result<Vec<f32>> {
        self.render_breathed(z, lf0, vuv, noise, &[])
    }

    /// As render, with each frame's factor on the noise and residual (Stream::breathe), or none.
    pub fn render_breathed(&self, z: &[f32], lf0: &[f32], vuv: &[f32], noise: &[f32], breath: &[f32]) -> Result<Vec<f32>> {
        let t = lf0.len();
        if z.len() != t * self.zdim || vuv.len() != t || noise.len() != t * HOP || !(breath.is_empty() || breath.len() == t) {
            return err(format!("{} of z, {t} of pitch, {} of voicing, {} of noise, {} of breath", z.len() / self.zdim, vuv.len(), noise.len(), breath.len()));
        }
        let mut r = self.begin(t, Act::whole(1, noise.to_vec()), None)?;
        r.breath = breath.to_vec();
        let mut y = Vec::with_capacity(t * HOP);
        self.advance(&mut r, &mut Act::whole(self.zdim, z.to_vec()), lf0, vuv, t, &mut y);
        Ok(y)
    }

    /// A render of t frames, none made, on white noise with unit variance (a sample a row): given
    /// whole, or as far as it has come with what the rest is drawn from as it is needed.
    fn begin(&self, t: usize, noise: Act, drawn: Option<Gaussian>) -> Result<Rendering> {
        if t * HOP <= NFFT / 2 {
            return err(format!("{t} frames: too short to render"));
        }
        assert!(noise.dim == 1 && (drawn.is_some() || noise.done == t * HOP));
        Ok(Rendering {
            t,
            f0: Vec::new(),
            source: Source::new(),
            src: Act::new(1),
            noise,
            drawn,
            ola: Ola::new(t + 1, t * HOP),
            mp: MinPhase::new(),
            done: 0,
            last: vec![0.0; PARTS * NBIN],
            acts: std::iter::once(Act::new(self.zdim + 2)).chain(self.blocks.iter().map(|_| Act::new(self.dim))).collect(),
            buf: vec![0.0; NFFT],
            lh: vec![0.0; NBIN],
            bins: [(); 5].map(|_| vec![C::default(); NBIN]),
            breath: Vec::new(),
            hiss: None,
        })
    }

    /// The frames up to `to` rendered from z (zdim a row) on the pitch so far, the frames lf0 and vuv
    /// hold: both there to `to` + radius() or the part's end, what was there before unchanged. The
    /// samples they finish go on y. z is let go of as far as it is read.
    fn advance(&self, r: &mut Rendering, z: &mut Act, lf0: &[f32], vuv: &[f32], to: usize, y: &mut Vec<f32>) {
        let (t, zd, d, radii) = (r.t, self.zdim, self.dim, self.radii());
        let fed = lf0.len();
        assert!(z.dim == zd && vuv.len() == fed && fed <= t);
        // the source: a sample needs its frame and the next
        r.f0.extend(lf0[r.f0.len()..].iter().map(|v| v.exp()));
        let upto = if fed == t { t * HOP } else { fed.saturating_sub(1) * HOP };
        if upto > r.src.done {
            let mut more = Vec::with_capacity(upto - r.src.done);
            r.source.run(&r.f0, vuv, upto, &mut more);
            r.src.push(&more);
        }
        let (a, b) = (r.done, to.min(t));
        if a >= b {
            return;
        }
        assert!(
            reach(&radii, b, t) <= fed && ((b - 1) * HOP + NFFT / 2).min(t * HOP) <= r.src.done && (b < t || fed == t),
            "frames to {b} of {t} on {fed} of pitch"
        );
        for i in r.acts[0].done..reach(&radii, b, t) {
            let mut row = z.span(i, i + 1).to_vec();
            row.extend([(lf0[i] - LF0_MU) / LF0_SD, vuv[i]]);
            r.acts[0].push(&row);
        }
        z.trim(r.acts[0].done);
        let layer = |i: usize, x: &[f32], rows: usize, from: usize, out: &mut [f32]| match i {
            0 => {
                self.inp.forward_rows(x, rows, from, out.len() / d, out);
                self.norm0.forward(out);
            }
            _ => self.blocks[i - 1].forward_rows(x, rows, from, out.len() / d, out),
        };
        let mut done = a;
        let mut h = run_stack(&mut r.acts, &mut done, &radii, t, b, d, &layer);
        self.norm.forward(&mut h);
        let w = PARTS * NBIN;
        let mut o = vec![0.0; HEAD_ROWS * w];
        // STFT frame i is centred on sample i * HOP, as feature frame i is; frame T takes the last row
        for i in (a..b).step_by(HEAD_ROWS) {
            let rows = HEAD_ROWS.min(b - i);
            self.head.forward(&h[(i - a) * d..(i - a + rows) * d], rows, &mut o[..rows * w]);
            for (j, p) in o[..rows * w].chunks_exact(w).enumerate() {
                self.frame(r, p, i + j, vuv[i + j] < 0.5, y);
            }
            r.last.copy_from_slice(&o[(rows - 1) * w..rows * w]);
        }
        if b == t {
            let last = std::mem::take(&mut r.last);
            self.frame(r, &last, t, vuv[t - 1] < 0.5, y);
        }
        r.done = b;
    }

    /// STFT frame i from the head's row p for it, the frames taken in order; `unvoiced` its frame's
    /// voicing (frame T's, the last's). The source and the noise are let go of as far as the next
    /// frame's window (held).
    fn frame(&self, r: &mut Rendering, p: &[f32], i: usize, unvoiced: bool, y: &mut Vec<f32>) {
        let Rendering { t, src, noise, drawn, ola, mp, buf, lh, bins: [hh, eh, en, res, spec], breath, hiss, .. } = r;
        let br = breath.get(i.min(*t - 1)).copied().unwrap_or(1.0);
        let n = *t * HOP;
        let mut free = hiss.as_ref().filter(|(told, _)| told[i.min(*t - 1)]).map(|(_, ph)| ph.frame(i));
        if let Some(g) = drawn {
            // the frame's window, and at the part's start the sample past it that it reflects
            noise.draw(g, 1.0, (i * HOP + NFFT / 2 + 1).min(n));
        }
        lh.iter_mut().zip(&p[..NBIN]).for_each(|(a, b)| *a = b.min(FILTER_TOP));
        mp.run(lh, hh);
        self.stft.frame(&src.rows, src.base, n, i, buf, eh);
        self.stft.frame(&noise.rows, noise.base, n, i, buf, en);
        src.trim(held(i + 1));
        noise.trim(held(i + 1));
        let resid = |k: usize, a: f32| {
            let (rm, (s, c)) = (br * p[3 * NBIN + k].min(RESID_TOP).exp(), a.sin_cos());
            C::new(rm * c, rm * s)
        };
        (0..NBIN).for_each(|k| res[k] = resid(k, p[4 * NBIN + k]));
        if let Some(g) = &mut free {
            let from = if unvoiced { 0 } else { HISS_FROM };
            (0..NBIN).for_each(|k| spec[k] = if k < from { C::new(0.0, 0.0) } else { res[k] });
            let model = self.stft.laid(spec, buf);
            for k in 0..NBIN {
                // a bin's draw is its own, whichever bins take theirs
                let a = (std::f64::consts::TAU * g.uniform()) as f32;
                if k >= from {
                    spec[k] = resid(k, a);
                }
            }
            let spread = self.stft.laid(spec, buf);
            // a residual of nothing (a breath factor of 0) stays nothing
            let level = if spread > 0.0 { (model / spread).sqrt() } else { 1.0 };
            (from..NBIN).for_each(|k| res[k] = spec[k].scale(level));
        }
        for k in 0..NBIN {
            let (s, c) = p[NBIN + k].sin_cos();
            let harm = hh[k].mul(C::new(c, s)).mul(eh[k]);
            spec[k] = harm.add(en[k].scale(br * p[2 * NBIN + k].min(FILTER_TOP).exp())).add(res[k]);
        }
        ola.add(&self.stft, spec, y);
    }
}

/// The first sample of a signal that its STFT's frame i, or a later one, takes in: a sample before
/// the frame's window, which the signal's last frame reflects onto.
fn held(i: usize) -> usize {
    (i * HOP).saturating_sub(NFFT / 2 + 1)
}

/// A generator's render a stretch of frames at a time.
struct Rendering {
    /// The part's frames.
    t: usize,
    /// F0 a frame and the harmonic source (a sample a row), as far as the pitch has come.
    f0: Vec<f32>,
    source: Source,
    src: Act,
    /// The noise (a sample a row), and what it is drawn from if it is not given whole.
    noise: Act,
    drawn: Option<Gaussian>,
    ola: Ola,
    mp: MinPhase,
    /// Frames rendered.
    done: usize,
    /// The head's row for the latest of them.
    last: Vec<f32>,
    /// The inputs of the conv on z and of each block.
    acts: Vec<Act>,
    buf: Vec<f32>,
    lh: Vec<f32>,
    bins: [Vec<C>; 5],
    /// Each frame's factor on the noise and the residual, or none.
    breath: Vec<f32>,
    /// Whether each frame's token sings a hiss, and what its residual's phases are drawn by; or none.
    hiss: Option<(Vec<bool>, Phases)>,
}

/// The first bin of a voiced frame's residual that a hiss's drawn phases take: 2 kHz, from where
/// a sung Z's residual is over its harmonics.
const HISS_FROM: usize = 2000 * NFFT / SR;

/// Whether each token sings a hiss: S and SH, the voiced Z and ZH, CH and JH, which end in one,
/// and a space beside any of them, which a word's first hiss starts in and its last ends in.
pub fn hisses(tok: &[usize]) -> Vec<bool> {
    let is = |i: usize| matches!(front::symbol(tok[i]), "S" | "SH" | "Z" | "ZH" | "CH" | "JH");
    (0..tok.len()).map(|i| is(i) || (tok[i] == SPACE && ((i > 0 && is(i - 1)) || (i + 1 < tok.len() && is(i + 1))))).collect()
}

/// Whether each token is a close vowel, IY or UW at any stress: the vowels the prior is told the
/// pitch of as it is in the band where the others are told the octave below (said).
pub fn closes(tok: &[usize]) -> Vec<bool> {
    tok.iter().map(|&k| matches!(front::symbol(k).trim_end_matches(|c: char| c.is_ascii_digit()), "IY" | "UW")).collect()
}

/// What a part's residual's phases in a hiss are drawn by: a seed's stream 5, each frame of the
/// whole part its own place in it, so a frame's are the same however the part is cut and wherever
/// it is picked up.
#[derive(Clone, Copy)]
pub struct Phases {
    key: u64,
    at: usize,
}

impl Phases {
    /// A seed's, for a part that is the whole's from its frame `at` on.
    pub fn of(seed: u64, at: usize) -> Phases {
        Phases { key: Rng::key(seed, 5), at }
    }

    fn frame(&self, i: usize) -> Rng {
        Rng::place(self.key, (self.at + i) as u64)
    }
}

/// One part of a plan: its tokens' states (N, dim) from the text encoder the model reads, no voice
/// in them; their frames; each frame's log F0 and voicing; the loudness (log power) and tilt
/// (log power an octave) its edits add, a frame each or none; each frame's factor on the
/// generator's noise and residual (Stream::breathe), or none; and whether each token sings a hiss
/// (hisses; Stream::hiss), or none; whether each is a close vowel (closes; Stream::close), or none.
/// `told`: each frame's log F0 as the loudness model and the prior
/// are told it where that is not the one sung (Stream::feed_told), or none.
pub struct Plan<'a> {
    pub h: &'a [f32],
    pub dur: &'a [usize],
    pub hiss: &'a [bool],
    pub close: &'a [bool],
    pub lf0: &'a [f32],
    pub told: &'a [f32],
    pub vuv: &'a [f32],
    pub gain: &'a [f32],
    pub tilt: &'a [f32],
    pub breath: &'a [f32],
}

impl Plan<'_> {
    pub fn frames(&self) -> usize {
        self.lf0.len()
    }

    /// The pitch the loudness model and the prior are told.
    fn pitch_told(&self) -> &[f32] {
        if self.told.is_empty() {
            self.lf0
        } else {
            self.told
        }
    }
}

/// A part's unit-variance noise: the prior's start (T, zdim), the generator's samples (T * HOP) and
/// the loudness model's start (T); and what its hisses' phases are drawn by.
#[derive(Clone)]
pub struct Noise {
    pub z: Vec<f32>,
    pub audio: Vec<f32>,
    pub loud: Vec<f32>,
    pub phases: Phases,
}

impl Noise {
    /// A seed's noise for a part of t frames: its streams 2, 3 and 4 (0 and 1 are the vocoder's and
    /// the pitch's), and 5 for the phases.
    pub fn draw(seed: u64, t: usize, zdim: usize) -> Noise {
        Noise::draw_after(seed, 0, t, zdim)
    }

    /// The noise draw(seed, at + t, zdim) gives after its first `at` frames.
    pub fn draw_after(seed: u64, at: usize, t: usize, zdim: usize) -> Noise {
        Noise {
            z: Rng::stream(seed, 2).gaussian_after(at * zdim, t * zdim),
            audio: Rng::stream(seed, 3).gaussian_after(at * HOP, t * HOP),
            loud: Rng::stream(seed, 4).gaussian_after(at, t),
            phases: Phases::of(seed, at),
        }
    }
}

/// A plan's loudness and tilt edits put on a part's samples as they come, as Edits::gain_mel puts
/// them on a mel: each frame's spectrum times exp(gain / 2), and exp(tilt / 2) an octave from the
/// mel bands' mean octave.
pub struct Editing {
    t: usize,
    ola: Ola,
    done: usize,
    octs: Vec<f32>,
    buf: Vec<f32>,
    spec: Vec<C>,
}

impl Editing {
    /// For a part of t frames.
    pub fn new(t: usize) -> Editing {
        Editing { t, ola: Ola::new(t + 1, t * HOP), done: 0, octs: inflect::bin_octaves(), buf: vec![0.0; NFFT], spec: vec![C::default(); NBIN] }
    }

    /// Every frame the part's samples so far hold is edited, y being those from sample `base` on, no
    /// later than held(the frames edited); the samples that finishes go on `out`. gain and tilt: a
    /// frame each or none.
    pub fn advance(&mut self, stft: &Stft, y: &[f32], base: usize, gain: &[f32], tilt: &[f32], out: &mut Vec<f32>) {
        let (t, n) = (self.t, self.t * HOP);
        assert!(base + y.len() <= n && base <= held(self.done) && [gain, tilt].iter().all(|v| v.is_empty() || v.len() == t));
        while self.done <= t && (self.done * HOP + NFFT / 2).min(n) <= base + y.len() {
            let r = self.done.min(t - 1);
            stft.frame(y, base, n, self.done, &mut self.buf, &mut self.spec);
            let (g, tl) = (gain.get(r).map_or(0.0, |v| 0.5 * v), tilt.get(r).map_or(0.0, |v| 0.5 * v));
            for (s, o) in self.spec.iter_mut().zip(&self.octs) {
                *s = s.scale((g + tl * o).exp());
            }
            self.ola.add(stft, &self.spec, out);
            self.done += 1;
        }
    }
}

/// The samples y, a whole part's, with a plan's loudness and tilt edits.
pub fn edit(stft: &Stft, y: &[f32], gain: &[f32], tilt: &[f32]) -> Vec<f32> {
    assert!(y.len() % HOP == 0);
    let (mut e, mut out) = (Editing::new(y.len() / HOP), Vec::with_capacity(y.len()));
    e.advance(stft, y, 0, gain, tilt, &mut out);
    out
}

/// A voice's parts of the latent voice (a voice file's tensors under vox., the prefix taken off)
/// and its score model's text encoder's digest (score::enc_digest).
pub struct Wearer {
    pub parts: Weights,
    pub enc: u64,
}

/// The latent voice's models, any voice's.
pub struct Model {
    loud: Flow,
    prior: Flow,
    gen: Gen,
    temp: f32,
    loud_temp: f32,
    reads: u64,
}

impl Model {
    pub fn load(mut model: Weights) -> Result<Model> {
        let reads = Vox::reads(&model)?;
        let (l, p, g) = (model.split("loud."), model.split("prior."), model.split("gen."));
        if let Some(n) = model.names().find(|n| !matches!(n.as_str(), "draw" | "reads")) {
            return err(format!("{n}: not part of the latent voice"));
        }
        let (loud, prior, gen) = (named("the loudness model", Flow::load(&l, false))?, named("the prior", Flow::load(&p, true))?, Gen::load(&g)?);
        if loud.zdim != 1 || prior.zdim != gen.zdim || loud.cdim != prior.cdim {
            return err(format!(
                "a loudness model over {}, a prior over {}, a generator of {}; states of {} and {}",
                loud.zdim, prior.zdim, gen.zdim, loud.cdim, prior.cdim
            ));
        }
        let d = model.shaped("draw", &[2])?;
        if !(d[0] >= 0.0 && d[1] >= 0.0) {
            return err(format!("draw {d:?}: the prior's temperature, the loudness model's"));
        }
        Ok(Model { loud, prior, gen, temp: d[0], loud_temp: d[1], reads })
    }
}

/// The latent voice's models as one voice wears them.
pub struct Vox {
    model: Rc<Model>,
    loud: Wear,
    prior: Wear,
}

impl Vox {
    /// Whether a file is the latent voice's models.
    pub fn is(ws: &Weights) -> bool {
        ws.has("draw")
    }

    /// The text encoder's digest a model file says it reads.
    pub fn reads(model: &Weights) -> Result<u64> {
        let d = model.shaped_i8("reads", &[8])?;
        Ok(u64::from_le_bytes(std::array::from_fn(|i| d[i] as u8)))
    }

    /// A model file as a voice wears it.
    pub fn load(model: Weights, voice: Wearer) -> Result<Vox> {
        Vox::wear(&Rc::new(Model::load(model)?), voice)
    }

    /// The models as a voice wears them.
    pub fn wear(model: &Rc<Model>, voice: Wearer) -> Result<Vox> {
        if model.reads != voice.enc {
            return err(format!("the latent voice reads the states of text encoder {:016x}, not the voice's ({:016x})", model.reads, voice.enc));
        }
        let mut voice = voice.parts;
        let (vl, vp) = (voice.split("loud."), voice.split("prior."));
        if let Some(n) = voice.names().next() {
            return err(format!("{n}: not part of the latent voice"));
        }
        Ok(Vox { model: model.clone(), loud: named("the loudness model", model.loud.wear(&vl))?, prior: named("the prior", model.prior.wear(&vp))? })
    }

    /// The Euler steps of the loudness model's draw and of the prior's.
    pub fn steps(&self) -> (usize, usize) {
        (self.model.loud.steps, self.model.prior.steps)
    }

    /// The width of the token states it reads.
    pub fn dim(&self) -> usize {
        self.model.prior.cdim
    }

    pub fn zdim(&self) -> usize {
        self.model.prior.zdim
    }

    pub fn generator(&self) -> &Gen {
        &self.model.gen
    }

    /// The frames of pitch past a frame that its samples take in: the generator's radius, the
    /// prior's draw's and the loudness model's, and what the prior is told its pitch by (said).
    pub fn ahead(&self) -> usize {
        self.model.gen.radius() + self.model.prior.radius() + self.model.loud.radius() + FOLD_SPAN
    }

    /// Each frame's loudness, -1 to 1, drawn from the unit noise x (T).
    pub fn loudness(&self, p: &Plan, x: &[f32]) -> Result<Vec<f32>> {
        let (f, w, t) = (&self.model.loud, &self.loud, self.check(p)?);
        if x.len() != t {
            return err(format!("{} of noise for {t} frames of loudness", x.len()));
        }
        let mut cc = Act::new(f.dim);
        f.project(w, &f.rows(w, p.h, &frame_tokens(p.dur), 0, p.pitch_told(), p.vuv, &[]), &mut cc);
        let mut dr = f.begin(t, Act::whole(1, x.iter().map(|v| v * self.model.loud_temp).collect()), None);
        f.advance(w, &mut cc, &mut dr, t);
        Ok(dr.last().span(0, t).iter().map(|v| self.loud_of(*v)).collect())
    }

    /// The loudness, -1 to 1, of the loudness model's draw.
    fn loud_of(&self, v: f32) -> f32 {
        (v * self.model.loud.zsd[0] + self.model.loud.zmu[0]).clamp(-1.0, 1.0)
    }

    /// z (T, zdim) at the given loudness, drawn from the unit noise x (T, zdim).
    pub fn code(&self, p: &Plan, loud: &[f32], x: &[f32]) -> Result<Vec<f32>> {
        let (f, w, t) = (&self.model.prior, &self.prior, self.check(p)?);
        if x.len() != t * f.zdim || loud.len() != t {
            return err(format!("{} of noise and {} of loudness for {t} frames of z", x.len() / f.zdim, loud.len()));
        }
        let mut cc = Act::new(f.dim);
        if !(p.close.is_empty() || p.close.len() == p.dur.len()) {
            return err(format!("{} tokens told a close vowel or not for {}", p.close.len(), p.dur.len()));
        }
        let tok = frame_tokens(p.dur);
        let close: Vec<bool> = if p.close.is_empty() { Vec::new() } else { tok.iter().map(|k| p.close[*k as usize]).collect() };
        let pitch = said(p.pitch_told(), &close, 0, t, t);
        f.project(w, &f.rows(w, p.h, &tok, 0, &pitch, p.vuv, loud), &mut cc);
        let mut dr = f.begin(t, Act::whole(f.zdim, x.iter().map(|v| v * self.model.temp).collect()), None);
        f.advance(w, &mut cc, &mut dr, t);
        Ok(self.z_of(dr.last().span(0, t)))
    }

    /// z from whole rows of the prior's draw.
    fn z_of(&self, x: &[f32]) -> Vec<f32> {
        let f = &self.model.prior;
        let zd = f.zdim;
        x.iter().enumerate().map(|(i, v)| v * f.zsd[i % zd] + f.zmu[i % zd]).collect()
    }

    /// A plan's frames, if its parts agree.
    fn check(&self, p: &Plan) -> Result<usize> {
        let t = p.frames();
        if p.h.len() != p.dur.len() * self.dim() || p.dur.iter().sum::<usize>() != t || p.vuv.len() != t || !(p.told.is_empty() || p.told.len() == t) {
            return err(format!(
                "a plan of {} token states, {} durations summing to {}, {t} pitch, {} told pitch and {} voicing frames",
                p.h.len() / self.dim(),
                p.dur.len(),
                p.dur.iter().sum::<usize>(),
                p.told.len(),
                p.vuv.len()
            ));
        }
        Ok(t)
    }

    /// The part's samples, T * HOP, its edits on them.
    pub fn render(&self, p: &Plan, noise: Noise) -> Result<Vec<f32>> {
        self.check(p)?;
        let mut st = self.begin(p.h, p.dur, p.gain, p.tilt, noise)?;
        if !p.breath.is_empty() {
            st.breathe(p.breath)?;
        }
        if !p.hiss.is_empty() {
            st.hiss(p.hiss)?;
        }
        if !p.close.is_empty() {
            st.close(p.close)?;
        }
        st.feed_told(p.lf0, p.pitch_told(), p.vuv);
        Ok(st.next(p.frames()))
    }

    /// A part's render, no pitch fed and no frame made: its token states h (N, dim()), their frames,
    /// and its edits' loudness and tilt, a frame each or none. The noise is given whole.
    pub fn begin(&self, h: &[f32], dur: &[usize], gain: &[f32], tilt: &[f32], noise: Noise) -> Result<Stream<'_>> {
        let (t, zd) = (dur.iter().sum::<usize>(), self.zdim());
        if noise.z.len() != t * zd || noise.audio.len() != t * HOP || noise.loud.len() != t {
            return err(format!("noise of {}, {} and {} for {t} frames", noise.z.len() / zd, noise.audio.len(), noise.loud.len()));
        }
        let m = &*self.model;
        let whole = |dim: usize, v: Vec<f32>, scale: f32| (Act::whole(dim, v.iter().map(|x| x * scale).collect()), None);
        self.start(h, dur, gain, tilt, whole(zd, noise.z, m.temp), whole(1, noise.loud, m.loud_temp), (Act::whole(1, noise.audio), None), noise.phases)
    }

    /// begin() on the noise Noise::draw_after(seed, at, the part's frames, zdim()) gives, drawn as
    /// it is needed and not held.
    pub fn begin_from(&self, h: &[f32], dur: &[usize], gain: &[f32], tilt: &[f32], seed: u64, at: usize) -> Result<Stream<'_>> {
        let (m, zd) = (&*self.model, self.zdim());
        let drawn = |dim: usize, k: u64, per: usize, scale: f32| (Act::new(dim), Some((Gaussian::after(Rng::stream(seed, k), at * per), scale)));
        let (audio, src) = drawn(1, 3, HOP, 1.0);
        self.start(h, dur, gain, tilt, drawn(zd, 2, zd, m.temp), drawn(1, 4, 1, m.loud_temp), (audio, src.map(|(g, _)| g)), Phases::of(seed, at))
    }

    /// A part's render on the starts of the prior's draw and the loudness model's (each as
    /// Flow::begin takes it), the generator's noise (as Gen::begin does) and its hisses' phases.
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    fn start(
        &self,
        h: &[f32],
        dur: &[usize],
        gain: &[f32],
        tilt: &[f32],
        z: (Act, Option<(Gaussian, f32)>),
        loud: (Act, Option<(Gaussian, f32)>),
        audio: (Act, Option<Gaussian>),
        phases: Phases,
    ) -> Result<Stream<'_>> {
        let t = dur.iter().sum::<usize>();
        let whole = |v: &[f32]| v.is_empty() || v.len() == t;
        if h.len() != dur.len() * self.dim() || !whole(gain) || !whole(tilt) {
            return err(format!(
                "{} token states for {} durations summing to {t}, {} loudness and {} tilt frames",
                h.len() / self.dim(),
                dur.len(),
                gain.len(),
                tilt.len()
            ));
        }
        let (m, lf, pf) = (&*self.model, &self.model.loud, &self.model.prior);
        let edits = !(gain.is_empty() && tilt.is_empty());
        Ok(Stream {
            vox: self,
            t,
            h: h.to_vec(),
            tok: frame_tokens(dur),
            lf0: Vec::new(),
            pitch: Vec::new(),
            vuv: Vec::new(),
            close: Vec::new(),
            gain: gain.to_vec(),
            tilt: tilt.to_vec(),
            lcc: Act::new(lf.dim),
            ld: lf.begin(t, loud.0, loud.1),
            pcc: Act::new(pf.dim),
            told: 0,
            pd: pf.begin(t, z.0, z.1),
            z: Act::new(self.zdim()),
            r: m.gen.begin(t, audio.0, audio.1)?,
            phases,
            y: Act::new(1),
            e: edits.then(|| Editing::new(t)),
        })
    }
}

/// A part's render a stretch of frames at a time, on its pitch as it comes.
pub struct Stream<'a> {
    vox: &'a Vox,
    /// The part's frames.
    t: usize,
    /// The token states and each frame's token.
    h: Vec<f32>,
    tok: Vec<u32>,
    /// The pitch fed: the one sung, the one the loudness model and the prior are told, the voicing.
    lf0: Vec<f32>,
    pitch: Vec<f32>,
    vuv: Vec<f32>,
    /// Whether each frame is a close vowel's (closes), or none.
    close: Vec<bool>,
    gain: Vec<f32>,
    tilt: Vec<f32>,
    /// The loudness model's conditions' projection, as far as the pitch is fed, and its draw.
    lcc: Act,
    ld: Drawing,
    /// The prior's conditions' projection, to frame `told`, as far as its loudness is drawn, and its
    /// draw.
    pcc: Act,
    told: usize,
    pd: Drawing,
    /// z, as far as the prior has drawn it.
    z: Act,
    r: Rendering,
    phases: Phases,
    /// The generator's samples (a sample a row), kept for the edits.
    y: Act,
    e: Option<Editing>,
}

impl Stream<'_> {
    /// The part's frames.
    pub fn frames(&self) -> usize {
        self.t
    }

    /// Frames of pitch fed.
    pub fn fed(&self) -> usize {
        self.lf0.len()
    }

    /// Frames rendered.
    pub fn done(&self) -> usize {
        self.r.done
    }

    /// Each frame's factor on the generator's noise and residual, what is not the harmonics', as
    /// sing::breathe's on a vocoder's aperiodicity: before any frame is made.
    pub fn breathe(&mut self, breath: &[f32]) -> Result<()> {
        if breath.len() != self.t || self.r.done != 0 {
            return err(format!("{} breath factors for {} frames, {} made", breath.len(), self.t, self.r.done));
        }
        self.r.breath = breath.to_vec();
        Ok(())
    }

    /// Whether each token sings a hiss (hisses): before any frame is made.
    pub fn hiss(&mut self, tok: &[bool]) -> Result<()> {
        if tok.len() != self.h.len() / self.vox.dim() || self.r.done != 0 {
            return err(format!("{} tokens told a hiss or not for {}, {} frames made", tok.len(), self.h.len() / self.vox.dim(), self.r.done));
        }
        self.r.hiss = Some((self.tok.iter().map(|k| tok[*k as usize]).collect(), self.phases));
        Ok(())
    }

    /// Whether each token is a close vowel (closes), which the prior is told the pitch of as it is:
    /// before any pitch is fed.
    pub fn close(&mut self, tok: &[bool]) -> Result<()> {
        if tok.len() != self.h.len() / self.vox.dim() || !self.lf0.is_empty() {
            return err(format!("{} tokens told a close vowel or not for {}, {} frames of pitch fed", tok.len(), self.h.len() / self.vox.dim(), self.lf0.len()));
        }
        self.close = self.tok.iter().map(|k| tok[*k as usize]).collect();
        Ok(())
    }

    /// The harmonic source as the frames before the part's first leave it (Source::after), for a
    /// part that is the rest of a longer one: before any pitch is fed.
    pub fn pick_up(&mut self, source: Source) {
        assert!(self.lf0.is_empty() && source.is_empty(), "a source picked up after {} frames", self.lf0.len());
        self.r.source = source;
    }

    /// The part's next frames' log F0 and voicing.
    pub fn feed(&mut self, lf0: &[f32], vuv: &[f32]) {
        self.feed_told(lf0, lf0, vuv)
    }

    /// feed(), with the log F0 the loudness model and the prior are told for these frames, `told`,
    /// where it is not the one the generator sings: a move in the pitch that shapes the sound (a
    /// stop's closure, a vowel struck again) with the line sung as written.
    pub fn feed_told(&mut self, lf0: &[f32], told: &[f32], vuv: &[f32]) {
        let (v, m, a) = (self.vox, &*self.vox.model, self.lf0.len());
        let b = a + lf0.len();
        assert!(
            vuv.len() == lf0.len() && told.len() == lf0.len() && b <= self.t,
            "{} of pitch, {} of told pitch and {} of voicing after {a} of {}",
            lf0.len(),
            told.len(),
            vuv.len(),
            self.t
        );
        m.loud.project(&v.loud, &m.loud.rows(&v.loud, &self.h, &self.tok, a, told, vuv, &[]), &mut self.lcc);
        self.lf0.extend_from_slice(lf0);
        self.pitch.extend_from_slice(told);
        self.vuv.extend_from_slice(vuv);
    }

    /// Up to `frames` more frames rendered, as far as the pitch fed allows: each takes Vox::ahead()
    /// frames of it past itself, or all there is. The samples that finishes.
    pub fn next(&mut self, frames: usize) -> Vec<f32> {
        self.next_timed(frames, &mut |_| ())
    }

    /// next(), calling `lap` as each stage ends: 1 the loudness model, 2 the prior, 3 the generator,
    /// 4 the edits.
    pub fn next_timed(&mut self, frames: usize, lap: &mut dyn FnMut(usize)) -> Vec<f32> {
        let (v, m, t, fed) = (self.vox, &*self.vox.model, self.t, self.lf0.len());
        let reach = if fed == t { t } else { fed.saturating_sub(v.ahead()) };
        let to = self.r.done.saturating_add(frames).min(reach);
        let mut out = Vec::new();
        if to <= self.r.done {
            return out;
        }
        let zto = (to + m.gen.radius()).min(t);
        let cto = (zto + m.prior.radius()).min(t);
        m.loud.advance(&v.loud, &mut self.lcc, &mut self.ld, cto);
        lap(1);
        if cto > self.told {
            let a = self.told;
            let loud: Vec<f32> = self.ld.last().span(a, cto).iter().map(|x| v.loud_of(*x)).collect();
            let pitch = said(&self.pitch, &self.close, a, cto, t);
            m.prior.project(&v.prior, &m.prior.rows(&v.prior, &self.h, &self.tok, a, &pitch, &self.vuv[a..cto], &loud), &mut self.pcc);
            self.ld.trim(cto);
            self.told = cto;
        }
        m.prior.advance(&v.prior, &mut self.pcc, &mut self.pd, zto);
        if zto > self.z.done {
            let z = v.z_of(self.pd.last().span(self.z.done, zto));
            self.z.push(&z);
            self.pd.trim(zto);
        }
        lap(2);
        match &mut self.e {
            None => {
                m.gen.advance(&mut self.r, &mut self.z, &self.lf0, &self.vuv, to, &mut out);
                lap(3);
            }
            Some(e) => {
                let mut y = Vec::new();
                m.gen.advance(&mut self.r, &mut self.z, &self.lf0, &self.vuv, to, &mut y);
                self.y.push(&y);
                lap(3);
                e.advance(&m.gen.stft, &self.y.rows, self.y.base, &self.gain, &self.tilt, &mut out);
                self.y.trim(held(e.done));
            }
        }
        lap(4);
        out
    }
}
