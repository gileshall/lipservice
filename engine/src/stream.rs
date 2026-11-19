// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Streaming synthesis. After the text is encoded and its durations fixed, the score and the
//! vocoder (or the mel route, or the latent voice) run a few frames at a time, each layer keeping
//! only the rows its neighbours still need, and audio comes out as soon as no later frame can
//! change it: the same samples, bit for bit, as the whole-utterance path (ScoreModel::infer, then
//! Vocoder::render; or inflect::plan, then MelDec::forward and Vocos::render, or Vox::render).

use crate::dsp::{MinPhase, Ola, Source, HOP, NBIN, NFFT};
use crate::fft::C;
use crate::inflect::{Contour, Delivery, Edits, Inflection};
use crate::melvoc::{vocos_frames, Istft, MelDec, MelVoc, Vocos, N_MEL, VBIN};
use crate::release::Release;
use crate::nn::{Conv1d, ConvNeXt, Linear};
use crate::pause::{self, PauseBank, Pauses};
use crate::pitchflow::{self, PitchFlow, Sampling};
use crate::rng::Rng;
use crate::score::{semitones, unvoiced_frames, Pitch, ScoreModel};
use crate::sharpen::{self, Sharpen};
use crate::sing::{self, Plan, Voicing};
use crate::vocoder::{Vocoder, N_AP, N_ENV};
use crate::vox::{self, Vox};
use crate::weights::{err, Result};

/// Rows of a (T, dim) track, from `base` on.
struct Track {
    dim: usize,
    base: usize,
    data: Vec<f32>,
}

impl Track {
    fn new(dim: usize) -> Track {
        Track {
            dim,
            base: 0,
            data: Vec::new(),
        }
    }

    fn end(&self) -> usize {
        self.base + self.data.len() / self.dim
    }

    fn rows(&self, a: usize, b: usize) -> &[f32] {
        assert!(
            self.base <= a && a <= b && b <= self.end(),
            "rows {a}..{b} of {}..{}",
            self.base,
            self.end()
        );
        &self.data[(a - self.base) * self.dim..(b - self.base) * self.dim]
    }

    fn push(&mut self, rows: &[f32]) {
        assert_eq!(rows.len() % self.dim, 0);
        self.data.extend_from_slice(rows);
    }

    /// Forgets the rows before `from`.
    fn trim(&mut self, from: usize) {
        let from = from.min(self.end());
        if from > self.base {
            self.data.drain(..(from - self.base) * self.dim);
            self.base = from;
        }
    }
}

/// For a layer of radius r that has made `done` rows, with its input made to `avail` of `total`
/// rows: the input window [wa, wb) to read and the row g it can make up to.
fn window(done: usize, r: usize, avail: usize, total: usize) -> Option<(usize, usize, usize)> {
    let g = if avail == total {
        total
    } else {
        avail.saturating_sub(r)
    };
    (g > done).then(|| (done.saturating_sub(r), (g + r).min(avail), g))
}

/// A chain of ConvNeXt blocks and each one's output so far.
struct Blocks {
    out: Vec<Track>,
}

impl Blocks {
    fn new(blocks: &[ConvNeXt]) -> Blocks {
        Blocks {
            out: blocks.iter().map(|b| Track::new(b.dim())).collect(),
        }
    }

    fn end(&self) -> usize {
        self.out.last().unwrap().end()
    }

    fn last(&self) -> &Track {
        self.out.last().unwrap()
    }

    /// Runs each block as far as its input allows.
    fn advance(&mut self, blocks: &[ConvNeXt], input: &Track, total: usize) {
        for (i, b) in blocks.iter().enumerate() {
            let (prev, rest) = self.out.split_at_mut(i);
            let inp = if i == 0 { input } else { &prev[i - 1] };
            let out = &mut rest[0];
            let done = out.end();
            if let Some((wa, wb, g)) = window(done, b.radius(), inp.end(), total) {
                let mut y = vec![0.0; (g - done) * b.dim()];
                b.forward_rows(inp.rows(wa, wb), wb - wa, done - wa, g - done, &mut y);
                out.push(&y);
            }
        }
        for i in 1..blocks.len() {
            let keep = self.out[i].end().saturating_sub(blocks[i].radius());
            self.out[i - 1].trim(keep);
        }
    }

    /// The first input row the first block still needs.
    fn needs(&self, blocks: &[ConvNeXt]) -> usize {
        self.out[0].end().saturating_sub(blocks[0].radius())
    }
}

/// The pitch flow under way: each evaluation's input, blocks and track (evaluation i makes
/// xs[i + 1]), and how it is drawn.
struct Flow<'m> {
    f: &'m PitchFlow,
    s: Sampling,
    evals: Vec<pitchflow::Eval>,
    te: Vec<Vec<f32>>,
    place: Vec<f32>,
    cond: Track,
    ys: Vec<Track>,
    bs: Vec<Blocks>,
    xs: Vec<Track>,
}

impl<'m> Flow<'m> {
    fn new(f: &'m PitchFlow, s: &Sampling, durations: &[usize]) -> Flow<'m> {
        let evals = s.evals();
        let n = evals.len();
        let mut xs: Vec<Track> = (0..=n).map(|_| Track::new(2)).collect();
        xs[0].push(&s.noise(durations.iter().sum()));
        Flow {
            f,
            s: *s,
            te: evals.iter().map(|e| f.time(e.time)).collect(),
            evals,
            place: pitchflow::place(durations),
            cond: Track::new(f.dim),
            ys: (0..n).map(|_| Track::new(f.dim)).collect(),
            bs: (0..n).map(|_| Blocks::new(&f.blocks)).collect(),
            xs,
        }
    }

    /// Runs every evaluation as far as the token states let in allow; the frames of the last
    /// one's track from `from` on.
    fn advance(&mut self, hx: &Track, total: usize, from: usize) -> &[f32] {
        let f = self.f;
        let a = self.cond.end();
        if hx.end() > a {
            let c = f.condition(
                hx.rows(a, hx.end()),
                &self.place[a * 2..hx.end() * 2],
                hx.end() - a,
            );
            self.cond.push(&c);
        }
        let n = self.evals.len();
        for i in 0..n {
            let (a, b) = (self.ys[i].end(), self.cond.end().min(self.xs[i].end()));
            if b > a {
                let y = f.input(
                    self.cond.rows(a, b),
                    self.xs[i].rows(a, b),
                    &self.te[i],
                    b - a,
                );
                self.ys[i].push(&y);
            }
            self.bs[i].advance(&f.blocks, &self.ys[i], total);
            self.ys[i].trim(self.bs[i].needs(&f.blocks));
            let a = self.xs[i + 1].end();
            if self.bs[i].end() > a {
                let m = self.bs[i].end() - a;
                let base = if self.evals[i].from_prev { i - 1 } else { i };
                let mut x = self.xs[base].rows(a, a + m).to_vec();
                f.update(
                    self.bs[i].last().rows(a, a + m),
                    m,
                    self.evals[i].div,
                    &mut x,
                );
                self.xs[i + 1].push(&x);
                self.bs[i]
                    .out
                    .last_mut()
                    .unwrap()
                    .trim(self.xs[i + 1].end());
            }
            let mut keep = self.xs[i + 1].end().min(self.ys[i].end());
            if i + 1 < n && self.evals[i + 1].from_prev {
                keep = keep.min(self.xs[i + 2].end());
            }
            self.xs[i].trim(keep);
        }
        let keep = self.ys.iter().map(|y| y.end()).min().unwrap();
        self.cond.trim(keep);
        let last = &mut self.xs[n];
        last.trim(from);
        last.rows(from, last.end())
    }

    /// The first token state row it still needs.
    fn needs(&self) -> usize {
        self.cond.end()
    }
}


/// What renders the score: the vocoder from the envelope decoder's frames; the mel route, a mel
/// decoder and Vocos, with a speaker's pauses if given (pause.rs) and the route's release channel if
/// it has one (release.rs); or the latent voice (vox.rs), from the text encoder's states, the
/// durations, the edited pitch and the loudness and tilt edits.
#[derive(Clone, Copy)]
pub enum Render<'m> {
    Voc(&'m Vocoder),
    Mel(&'m MelDec, &'m Vocos, Option<&'m PauseBank>, Option<&'m Release>),
    Vox(&'m Vox),
}

impl<'m> Render<'m> {
    /// The mel route through a voice's own decoder when it has one, else the route's.
    pub fn mel(mv: &'m MelVoc, own: Option<&'m MelDec>) -> Render<'m> {
        Render::Mel(own.unwrap_or(&mv.mel), &mv.vocos, None, mv.release.as_ref())
    }

    /// The mel route with a speaker's pauses (Voice::pause) in its pauses; the vocoder as it is.
    pub fn with_pauses(self, bank: Option<&'m PauseBank>) -> Render<'m> {
        match self {
            Render::Mel(md, vc, _, rel) => Render::Mel(md, vc, bank, rel),
            r => r,
        }
    }
}

/// The expanded token states and the pitch, as far as let in.
struct Front<'m> {
    score: &'m ScoreModel,
    total: usize,
    durations: Vec<usize>,
    h: Vec<f32>,
    cursor: (usize, usize), // the next frame's token, and frames of it already given
    sh: f32,
    hx: Track,
    pin: Track,
    pblocks: Blocks,
    flow: Option<Flow<'m>>,
    edits: Edits,
    model_lf0: Vec<f32>, // before the edits, for the envelope decoder
    lf0: Vec<f32>,
    vuv: Vec<f32>,
    sung: Option<(Vec<f32>, Vec<Voicing>)>, // a song's own log F0 and how each frame's voicing is made
    told: Vec<f32>, // a song's log F0 as the latent voice's loudness model and prior are told it, or none
    unvoiced: Vec<bool>,
}

impl Front<'_> {
    /// Lets in up to n more frames of token states and makes what pitch they allow.
    fn advance(&mut self, n: usize) {
        let s = self.score;
        let total = self.total;
        let (d, upto) = (s.dim, (self.hx.end() + n).min(total));
        let mut rows = Vec::with_capacity((upto - self.hx.end()) * d);
        for _ in self.hx.end()..upto {
            let (mut i, mut used) = self.cursor;
            while used == self.durations[i] {
                i += 1;
                used = 0;
            }
            rows.extend_from_slice(&self.h[i * d..(i + 1) * d]);
            self.cursor = (i, used + 1);
        }
        self.hx.push(&rows);

        let a = self.lf0.len();
        let (plf0, pv) = match &mut self.flow {
            Some(fl) => {
                let sp = fl.s;
                let x = fl.advance(&self.hx, total, a);
                let m = x.len() / 2;
                (
                    (0..m).map(|i| sp.spread(x[2 * i])).collect(),
                    (0..m).map(|i| x[2 * i + 1]).collect(),
                )
            }
            None => {
                let b = self.pin.end();
                if self.hx.end() > b {
                    let m = self.hx.end() - b;
                    let mut y = vec![0.0; m * d];
                    s.pitch_in
                        .forward(self.hx.rows(b, self.hx.end()), m, &mut y);
                    self.pin.push(&y);
                }
                self.pblocks.advance(&s.pitch, &self.pin, total);
                self.pin.trim(self.pblocks.needs(&s.pitch));
                let m = self.pblocks.end().saturating_sub(a);
                let p = s.pitch_head(self.pblocks.last().rows(a, a + m), m);
                self.pblocks.out.last_mut().unwrap().trim(a + m);
                p
            }
        };
        if let (false, Some((slf0, voicing))) = (plf0.is_empty(), &self.sung) {
            let vuv: Vec<f32> = pv.iter().enumerate().map(|(i, &v)| voicing[a + i].vuv(v)).collect();
            self.model_lf0.extend_from_slice(&slf0[a..a + pv.len()]);
            self.lf0.extend_from_slice(&slf0[a..a + pv.len()]);
            self.vuv.extend_from_slice(&vuv);
        } else if !plf0.is_empty() {
            let (model, vuv) = ScoreModel::to_lf0_vuv(&plf0, &pv, self.sh, &self.unvoiced[a..a + pv.len()]);
            let lf0: Vec<f32> = model.iter().map(|&v| self.edits.contour.apply(v)).collect();
            self.model_lf0.extend_from_slice(&model);
            self.lf0.extend_from_slice(&lf0);
            self.vuv.extend_from_slice(&vuv);
        }
    }

    /// Forgets the token states before the pitch's and `decoder`'s first needed row.
    fn trim_hx(&mut self, decoder: usize) {
        let pitch_needs = self.flow.as_ref().map_or(self.pin.end(), |f| f.needs());
        self.hx.trim(pitch_needs.min(decoder));
    }

    /// The decoder's input rows (its dec_in on the token states plus its f0_emb on the pitch)
    /// as far as the pitch allows, onto `din`.
    /// With the release channel and its rows (Release::told, every frame's) when given.
    fn decoder_input(&self, dec_in: &Linear, f0_emb: &Conv1d, lf0: &[f32], release: Option<(&Release, &[f32])>, din: &mut Track) {
        let done = din.end();
        if let Some((wa, wb, g)) = window(done, f0_emb.radius(), lf0.len(), self.total) {
            let (m, dd) = (g - done, din.dim);
            let mut x = vec![0.0; m * dd];
            dec_in.forward(self.hx.rows(done, g), m, &mut x);
            let f = ScoreModel::f0_feat(&lf0[wa..wb], &self.vuv[wa..wb]);
            let mut fe = vec![0.0; m * dd];
            f0_emb.forward_rows(&f, wb - wa, done - wa, m, &mut fe);
            for (a, b) in x.iter_mut().zip(&fe) {
                *a += b;
            }
            if let Some((r, told)) = release {
                r.add_rows(&told[2 * wa..2 * wb], wb - wa, done - wa, m, &mut x);
            }
            din.push(&x);
        }
    }
}

/// A song's per-frame dressing of the decoder's frames (sing::plan).
struct Dress {
    quiet: Vec<f32>,
    breath: Vec<f32>,
    gain: Vec<f32>,
    sung: Vec<f32>,
    ring: Option<f32>,
}

impl Dress {
    /// Loudness and ring on envelope rows from frame `from` on.
    fn loud(&self, env: &mut [f32], from: usize) {
        let to = from + env.len() / N_ENV;
        sing::louden(env, &self.gain[from..to]);
        if let Some(db) = self.ring {
            sing::ring(env, &self.sung[from..to], db);
        }
    }
}

/// The envelope decoder, the sharpening and the vocoder under way.
struct VocTail<'m> {
    voc: &'m Vocoder,
    samples: usize,
    f0: Vec<f32>,
    din: Track,
    dblocks: Blocks,
    sharp: Option<(&'m Sharpen, usize)>, // and the speaker
    dress: Option<Dress>,
    dec_env: Track,                      // the decoder's envelope, before sharpening
    env: Track,
    bap: Track,
    vin: Track,
    vblocks: Option<Blocks>,
    lh: Track,
    ln: Track,
    src: Source,
    source: Track,
    noise: Track,
    rng: Rng,
    ola: Ola,
    mp: MinPhase,
    buf: Vec<f32>,
    spec: [Vec<C>; 4], // eh, en, hh, y
}

/// The mel decoder and Vocos under way.
struct MelTail<'m> {
    md: &'m MelDec,
    vc: &'m Vocos,
    release: Option<(&'m Release, Vec<f32>)>,
    din: Track,
    dblocks: Blocks,
    dec: Track, // the decoder's, with the gain, before the pauses
    pauses: Option<Pauses<'m>>,
    mel: Track,
    vtotal: usize,
    vin: Track,
    emb: Track,
    vblocks: Blocks,
    ola: Istft,
}

enum Tail<'m> {
    Voc(Box<VocTail<'m>>),
    Mel(Box<MelTail<'m>>),
    Vox(Box<vox::Stream<'m>>),
}

pub struct Stream<'m> {
    front: Front<'m>,
    tail: Tail<'m>,
    /// A song picked up part way (sung_from): the song's frames before the stream's first, and the
    /// samples of its run-up still to drop.
    base: usize,
    skip: usize,
}

/// Frames from an STFT's start that its end shapes, through the generator's and the edits' after it.
const EDGE: usize = 12;

impl<'m> Stream<'m> {
    /// Encodes the tokens and fixes their durations; nothing is rendered yet. rate, shift and
    /// pitch are as for ScoreModel::infer, seed as for the vocoder's noise Rng; with `sharpen`,
    /// the envelope is sharpened (Sharpen::apply on the whole-utterance path), which the mel
    /// route has none of.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        score: &'m ScoreModel,
        render: Render<'m>,
        tok: &[usize],
        speaker: usize,
        rate: f32,
        shift: f32,
        pitch: Pitch<'m>,
        seed: u64,
        sharpen: Option<&'m Sharpen>,
    ) -> Result<Stream<'m>> {
        Self::check(score, render, speaker, pitch, sharpen)?;
        let states = score.states(tok)?;
        let h = score.spoken(states.clone(), speaker)?;
        let durations = score.durations(&h, tok.len(), rate)?;
        Self::start(
            score,
            render,
            tok,
            &vox::hisses(tok),
            &states,
            h,
            Edits {
                durations,
                contour: Contour::none(),
                gain: Vec::new(),
                tilt: Vec::new(),
            },
            speaker,
            shift,
            pitch,
            seed,
            0,
            sharpen,
        )
    }

    /// As new, with the inflection's edits (inflect::infer, or inflect::plan for the mel route,
    /// on the whole-utterance path).
    #[allow(clippy::too_many_arguments)]
    pub fn inflected(
        score: &'m ScoreModel,
        render: Render<'m>,
        inf: &Inflection,
        speaker: usize,
        rate: f32,
        shift: f32,
        pitch: Pitch<'m>,
        seed: u64,
        sharpen: Option<&'m Sharpen>,
    ) -> Result<Stream<'m>> {
        Self::check(score, render, speaker, pitch, sharpen)?;
        if inf.delivery != Delivery::default() {
            return err("--word-pitch and --pauses need the whole utterance; they do not stream");
        }
        let states = score.states(&inf.tokens)?;
        let h = score.spoken(states.clone(), speaker)?;
        let edits = inf.edits(score, &h, rate)?;
        Self::start(score, render, &inf.tokens, &vox::hisses(&inf.tokens), &states, h, edits, speaker, shift, pitch, seed, 0, sharpen)
    }

    /// A song's frames (sing::plan), pitched as it says: the voicing it fixes, the pitch head's
    /// where it leaves it. Through a vocoder, dressed as sing::sing, Sharpen::apply, sing::louden
    /// and, with `ring` (dB), sing::ring do on the whole path; through the latent voice, its
    /// dynamics and the silence of its rests as the edits sing::loudness makes of them, its breath
    /// on the generator's noise and residual.
    pub fn sung(
        score: &'m ScoreModel,
        render: Render<'m>,
        plan: Plan,
        speaker: usize,
        ring: Option<f32>,
        seed: u64,
        sharpen: Option<&'m Sharpen>,
    ) -> Result<Stream<'m>> {
        Self::check(score, render, speaker, Pitch::Head, sharpen)?;
        let edits = Self::song_edits(render, &plan, ring)?;
        let hiss = vox::hisses(&plan.tokens);
        Self::song(score, render, plan, hiss, edits, Source::new(), 0, speaker, ring, seed, sharpen)
    }

    /// As sung, picked up at frame `from` of the song: step gives the song's samples from
    /// from * HOP on, the same as the whole song's there. The stream starts early by every layer's
    /// reach back (or at the song's start) on the song's own plan, noise and source phase, and
    /// drops what that makes; frames(), pitch() and fed() count from base().
    #[allow(clippy::too_many_arguments)]
    pub fn sung_from(
        score: &'m ScoreModel,
        render: Render<'m>,
        plan: &Plan,
        speaker: usize,
        ring: Option<f32>,
        seed: u64,
        sharpen: Option<&'m Sharpen>,
        from: usize,
    ) -> Result<Stream<'m>> {
        Self::check(score, render, speaker, Pitch::Head, sharpen)?;
        if from > plan.lf0.len() {
            return err(format!("frame {from} of a song of {}", plan.lf0.len()));
        }
        let (eg, et) = Self::song_edits(render, plan, ring)?;
        let at = from.saturating_sub(Self::past(score, render, sharpen.is_some()));
        let cut = |v: Vec<f32>| if v.is_empty() { v } else { v[at..].to_vec() };
        let f0: Vec<f32> = plan.lf0[..(at + 1).min(plan.lf0.len())].iter().map(|v| v.exp()).collect();
        let tail = plan.tail(at);
        // a token is told a hiss by its neighbours in the whole song
        let hiss = vox::hisses(&plan.tokens)[plan.tokens.len() - tail.tokens.len()..].to_vec();
        let mut st = Self::song(score, render, tail, hiss, (cut(eg), cut(et)), Source::after(&f0), at, speaker, ring, seed, sharpen)?;
        st.skip = (from - at) * HOP;
        Ok(st)
    }

    /// Frames before a frame that its samples take in through a song's layers and STFTs.
    fn past(score: &ScoreModel, render: Render, sharpen: bool) -> usize {
        let blocks = |b: &[ConvNeXt]| b.iter().map(|b| b.radius()).sum::<usize>();
        let sound = match render {
            Render::Voc(v) => {
                score.f0_emb.radius()
                    + blocks(&score.dec)
                    + if sharpen { sharpen::RADIUS } else { 0 }
                    + v.net.as_ref().map_or(0, |n| n.inp.radius() + blocks(&n.blocks))
            }
            Render::Vox(v) => v.ahead(),
            Render::Mel(..) => 0,
        };
        blocks(&score.pitch) + sound + EDGE
    }

    /// The loudness and tilt edits a song's plan asks of the latent voice (sing::loudness); none
    /// through a vocoder, which dresses its envelope.
    fn song_edits(render: Render, plan: &Plan, ring: Option<f32>) -> Result<(Vec<f32>, Vec<f32>)> {
        match render {
            Render::Voc(_) => Ok((Vec::new(), Vec::new())),
            Render::Vox(_) if ring.is_some() => err("the latent voice has no envelope to ring"),
            Render::Vox(_) => Ok(sing::loudness(&plan.gain, &plan.quiet)),
            Render::Mel(..) => err("a song goes through a vocoder or the latent voice, not the mel route"),
        }
    }

    /// A song's stream on `plan`, the song's from frame `at` on, with its edits from there, the
    /// harmonic source as the frames before leave it, and whether each token sings a hiss
    /// (vox::hisses) in the whole song.
    #[allow(clippy::too_many_arguments)]
    fn song(
        score: &'m ScoreModel,
        render: Render<'m>,
        plan: Plan,
        hiss: Vec<bool>,
        edits: (Vec<f32>, Vec<f32>),
        src: Source,
        at: usize,
        speaker: usize,
        ring: Option<f32>,
        seed: u64,
        sharpen: Option<&'m Sharpen>,
    ) -> Result<Stream<'m>> {
        let Plan { tokens, states, h, durations, lf0, told, voicing, quiet, breath, gain, sung, .. } = plan;
        if !(told.is_empty() || told.len() == lf0.len()) {
            return err(format!("{} frames of told pitch for a song of {}", told.len(), lf0.len()));
        }
        let edits = Edits { durations, contour: Contour::none(), gain: edits.0, tilt: edits.1 };
        let mut st = Self::start(score, render, &tokens, &hiss, &states, h, edits, speaker, 0.0, Pitch::Head, seed, at, sharpen)?;
        st.front.sung = Some((lf0, voicing));
        st.front.told = told;
        match &mut st.tail {
            Tail::Voc(t) => {
                t.dress = Some(Dress { quiet, breath, gain, sung, ring });
                t.src = src;
            }
            Tail::Vox(t) => {
                t.breathe(&breath)?;
                t.pick_up(src);
            }
            Tail::Mel(_) => unreachable!(),
        }
        Ok(st)
    }

    fn check(
        score: &ScoreModel,
        render: Render,
        speaker: usize,
        pitch: Pitch,
        sharpen: Option<&Sharpen>,
    ) -> Result<()> {
        pitch.check(score)?;
        if let Render::Mel(md, _, _, rel) = render {
            if let Some(r) = rel {
                if r.dim() != md.dim || r.radius() != md.f0_emb.radius() {
                    return err(format!("the release channel is {} wide, the mel decoder {}", r.dim(), md.dim));
                }
            }
            if sharpen.is_some() {
                return err("the mel route has no envelope to sharpen");
            }
            if md.cin() != score.dim {
                return err(format!(
                    "the mel decoder takes token states of {}, the score model gives {}",
                    md.cin(),
                    score.dim
                ));
            }
        }
        if let Render::Vox(v) = render {
            if sharpen.is_some() {
                return err("the latent voice has no envelope to sharpen");
            }
            if v.dim() != score.dim {
                return err(format!("the latent voice reads token states of {}, the score model gives {}", v.dim(), score.dim));
            }
        }
        if let Some(sh) = sharpen {
            if sh.speakers() != score.speakers() {
                return err(format!(
                    "the sharpening has {} speakers, the score model {}",
                    sh.speakers(),
                    score.speakers()
                ));
            }
            sh.check(speaker)?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    /// `tok` the tokens `edits` time, for the voicing and the mel route's pauses; `hiss` whether each
    /// sings a hiss (vox::hisses), which the latent voice alone is told; `states` the text encoder's
    /// for them, no speaker in them, which it alone reads; `h` the speaker's.
    /// `at`: the frames of noise the seed has given before these (a song picked up there), else 0.
    fn start(
        score: &'m ScoreModel,
        render: Render<'m>,
        tok: &[usize],
        hiss: &[bool],
        states: &[f32],
        h: Vec<f32>,
        edits: Edits,
        speaker: usize,
        shift: f32,
        pitch: Pitch<'m>,
        seed: u64,
        at: usize,
        sharpen: Option<&'m Sharpen>,
    ) -> Result<Stream<'m>> {
        let durations = edits.durations.clone();
        let total: usize = durations.iter().sum();
        if total < 3 {
            return err(format!("{total} frames: too short to render"));
        }
        let flow = match pitch {
            Pitch::Head => None,
            Pitch::Flow(f, s) => Some(Flow::new(f, &s, &durations)),
        };
        let unvoiced = unvoiced_frames(tok, &durations);
        let front = Front {
            score,
            total,
            durations,
            h,
            cursor: (0, 0),
            sh: semitones(shift),
            hx: Track::new(score.dim),
            pin: Track::new(score.dim),
            pblocks: Blocks::new(&score.pitch),
            flow,
            edits,
            model_lf0: Vec::with_capacity(total),
            lf0: Vec::with_capacity(total),
            vuv: Vec::with_capacity(total),
            sung: None,
            told: Vec::new(),
            unvoiced,
        };
        let mut rng = Rng::new(seed);
        rng.skip(at * HOP);
        let tail = match render {
            Render::Voc(voc) => Tail::Voc(Box::new(VocTail {
                voc,
                samples: total * HOP,
                f0: Vec::with_capacity(total),
                din: Track::new(score.dec_dim),
                dblocks: Blocks::new(&score.dec),
                sharp: sharpen.map(|sh| (sh, speaker)),
                dress: None,
                dec_env: Track::new(N_ENV),
                env: Track::new(N_ENV),
                bap: Track::new(N_AP),
                vin: Track::new(voc.net.as_ref().map_or(1, |n| n.dim)),
                vblocks: voc.net.as_ref().map(|n| Blocks::new(&n.blocks)),
                lh: Track::new(NBIN),
                ln: Track::new(NBIN),
                src: Source::new(),
                source: Track::new(1),
                noise: Track::new(1),
                rng,
                ola: Ola::new(total + 1, total * HOP),
                mp: MinPhase::new(),
                buf: vec![0.0; NFFT],
                spec: std::array::from_fn(|_| vec![C::default(); NBIN]),
            })),
            Render::Mel(md, vc, bank, rel) => {
                let vtotal = vocos_frames(total);
                let pauses = bank.map(|b| Pauses::new(b, pause::pause_frames(tok, &front.durations), seed));
                Tail::Mel(Box::new(MelTail {
                    md,
                    vc,
                    release: rel.map(|r| (r, Release::told(tok, &front.durations))),
                    din: Track::new(md.dim),
                    dblocks: Blocks::new(&md.dec),
                    dec: Track::new(N_MEL),
                    pauses,
                    mel: Track::new(N_MEL),
                    vtotal,
                    vin: Track::new(N_MEL),
                    emb: Track::new(vc.dim),
                    vblocks: Blocks::new(&vc.blocks),
                    ola: Istft::new(vtotal),
                }))
            }
            Render::Vox(v) => {
                let mut st = v.begin_from(states, &front.durations, &front.edits.gain, &front.edits.tilt, seed, at)?;
                st.hiss(hiss)?;
                st.close(&vox::closes(tok))?;
                Tail::Vox(Box::new(st))
            }
        };
        Ok(Stream { front, tail, base: at, skip: 0 })
    }

    /// The song's frames before the stream's first: 0 but for a song picked up part way.
    pub fn base(&self) -> usize {
        self.base
    }

    /// Frames in the utterance.
    pub fn frames(&self) -> usize {
        self.front.total
    }

    pub fn durations(&self) -> &[usize] {
        &self.front.durations
    }

    /// Log F0 and voicing per frame, as far as made.
    pub fn pitch(&self) -> (&[f32], &[f32]) {
        (&self.front.lf0, &self.front.vuv)
    }

    /// The edits' added loudness and tilt per frame, each empty when none (the vocoder does not tilt).
    pub fn loudness(&self) -> (&[f32], &[f32]) {
        (&self.front.edits.gain, &self.front.edits.tilt)
    }

    /// Frames of the score let in so far.
    pub fn fed(&self) -> usize {
        self.front.hx.end()
    }

    /// All audio given.
    pub fn done(&self) -> bool {
        match &self.tail {
            Tail::Voc(t) => t.ola.added() == self.front.total + 1,
            Tail::Mel(t) => t.ola.done(),
            Tail::Vox(t) => t.done() == self.front.total,
        }
    }

    /// Lets in up to n more frames of the score and appends the audio they finish to `out`.
    pub fn step(&mut self, n: usize, out: &mut Vec<f32>) {
        let a = out.len();
        self.front.advance(n);
        match &mut self.tail {
            Tail::Voc(t) => t.step(&mut self.front, out),
            Tail::Mel(t) => t.step(&mut self.front, out),
            Tail::Vox(t) => {
                let (fr, a) = (&mut self.front, t.fed());
                let told = if fr.told.is_empty() { &fr.lf0[a..] } else { &fr.told[a..fr.lf0.len()] };
                t.feed_told(&fr.lf0[a..], told, &fr.vuv[a..]);
                fr.trim_hx(usize::MAX);
                out.extend(t.next(usize::MAX));
            }
        }
        let k = self.skip.min(out.len() - a);
        out.drain(a..a + k);
        self.skip -= k;
    }
}

impl MelTail<'_> {
    fn step(&mut self, fr: &mut Front, out: &mut Vec<f32>) {
        let (md, vc, total) = (self.md, self.vc, fr.total);

        // the mel decoder, on the edited pitch
        fr.decoder_input(&md.dec_in, &md.f0_emb, &fr.lf0, self.release.as_ref().map(|(r, t)| (*r, t.as_slice())), &mut self.din);
        fr.trim_hx(self.din.end());
        self.dblocks.advance(&md.dec, &self.din, total);
        self.din.trim(self.dblocks.needs(&md.dec));
        let a = self.dec.end();
        if self.dblocks.end() > a {
            let m = self.dblocks.end() - a;
            let mut mel = md.head(self.dblocks.last().rows(a, a + m), &fr.lf0[a..a + m], &fr.vuv[a..a + m]);
            fr.edits.gain_mel(&mut mel, a);
            if let Some(p) = &mut self.pauses {
                p.see(&mel);
            }
            self.dec.push(&mel);
            self.dblocks.out.last_mut().unwrap().trim(self.dec.end());
        }

        // the speaker's pauses, pause::LOOK frames behind
        let (a, b) = (self.mel.end(), self.pauses.as_ref().map_or(self.dec.end(), |p| p.ready()));
        if b > a {
            let mut rows = self.dec.rows(a, b).to_vec();
            if let Some(p) = &self.pauses {
                p.apply(&mut rows, a);
            }
            self.mel.push(&rows);
            self.dec.trim(b);
        }

        // Vocos's input: row j reads decoder frames i and i + 1
        let a = self.vin.end();
        let mut b = a;
        while b < self.vtotal && Vocos::source_row(b, total) + 2 <= self.mel.end() {
            b += 1;
        }
        if b > a {
            let x = vc.input_rows(&self.mel.data, self.mel.base, total, a, b);
            self.vin.push(&x);
            if b < self.vtotal {
                self.mel.trim(Vocos::source_row(b, total));
            }
        }

        // Vocos
        let done = self.emb.end();
        if let Some((wa, wb, g)) = window(done, vc.embed.radius(), self.vin.end(), self.vtotal) {
            let mut y = vec![0.0; (g - done) * vc.dim];
            vc.embed
                .forward_rows(self.vin.rows(wa, wb), wb - wa, done - wa, g - done, &mut y);
            vc.norm.forward(&mut y);
            self.emb.push(&y);
            self.vin.trim(g.saturating_sub(vc.embed.radius()));
        }
        self.vblocks.advance(&vc.blocks, &self.emb, self.vtotal);
        self.emb.trim(self.vblocks.needs(&vc.blocks));
        let a = self.ola.added();
        if self.vblocks.end() > a {
            let m = self.vblocks.end() - a;
            let mut h = self.vblocks.last().rows(a, a + m).to_vec();
            let spec = vc.head(&mut h, m);
            for i in 0..m {
                self.ola.add(vc, &spec[i * VBIN..(i + 1) * VBIN], out);
            }
            self.vblocks.out.last_mut().unwrap().trim(self.ola.added());
        }
    }
}

impl VocTail<'_> {
    fn step(&mut self, fr: &mut Front, out: &mut Vec<f32>) {
        let (s, v, total) = (fr.score, self.voc, fr.total);
        let a = self.f0.len();
        self.f0.extend(fr.lf0[a..].iter().map(|v| v.exp()));

        // decoder, on the model's own pitch
        fr.decoder_input(&s.dec_in, &s.f0_emb, &fr.model_lf0, None, &mut self.din);
        fr.trim_hx(self.din.end());
        self.dblocks.advance(&s.dec, &self.din, total);
        self.din.trim(self.dblocks.needs(&s.dec));
        let dec_env = if self.sharp.is_some() {
            &mut self.dec_env
        } else {
            &mut self.env
        };
        let a = dec_env.end();
        if self.dblocks.end() > a {
            let m = self.dblocks.end() - a;
            let (mut env, mut bap) = s.dec_head(self.dblocks.last().rows(a, a + m), m);
            if let Some(d) = &self.dress {
                sing::quieten(&mut env, &d.quiet[a..a + m]);
                sing::breathe(&mut bap, &d.breath[a..a + m]);
            }
            if self.sharp.is_none() {
                fr.edits.gain(&mut env, a);
                if let Some(d) = &self.dress {
                    d.loud(&mut env, a);
                }
            }
            dec_env.push(&env);
            self.bap.push(&bap);
            self.dblocks.out.last_mut().unwrap().trim(dec_env.end());
        }

        // sharpening, sharpen::RADIUS frames behind the decoder
        if let Some((sh, speaker)) = self.sharp {
            let (a, d) = (self.env.end(), &self.dec_env);
            let g = if d.end() == total {
                total
            } else {
                d.end().saturating_sub(sharpen::RADIUS)
            };
            if g > a {
                let mut rows = Vec::with_capacity((g - a) * N_ENV);
                sh.rows(speaker, &d.data, d.base, a, g, total, &mut rows);
                fr.edits.gain(&mut rows, a);
                if let Some(d) = &self.dress {
                    d.loud(&mut rows, a);
                }
                self.env.push(&rows);
                self.dec_env.trim(g.saturating_sub(sharpen::RADIUS));
            }
        }

        // the vocoder's filters
        match (&v.net, &mut self.vblocks) {
            (Some(net), Some(vb)) => {
                let done = self.vin.end();
                if let Some((wa, wb, g)) = window(done, net.inp.radius(), self.env.end(), total) {
                    let x = v.net_input(
                        self.env.rows(wa, wb),
                        self.bap.rows(wa, wb),
                        &fr.lf0[wa..wb],
                        &fr.vuv[wa..wb],
                    );
                    let mut y = vec![0.0; (g - done) * net.dim];
                    net.inp
                        .forward_rows(&x, wb - wa, done - wa, g - done, &mut y);
                    self.vin.push(&y);
                }
                vb.advance(&net.blocks, &self.vin, total);
                self.vin.trim(vb.needs(&net.blocks));
                let a = self.lh.end();
                if vb.end() > a {
                    let m = vb.end() - a;
                    let (mut lh, mut ln) =
                        v.base_shapes(self.env.rows(a, a + m), self.bap.rows(a, a + m), m);
                    let mut h = vb.last().rows(a, a + m).to_vec();
                    v.net_head(&mut h, m, &mut lh, &mut ln);
                    self.lh.push(&lh);
                    self.ln.push(&ln);
                    vb.out.last_mut().unwrap().trim(self.lh.end());
                }
                self.env.trim(
                    self.lh
                        .end()
                        .min(self.vin.end().saturating_sub(net.inp.radius())),
                );
            }
            _ => {
                let a = self.lh.end();
                if self.env.end() > a {
                    let m = self.env.end() - a;
                    let (lh, ln) =
                        v.base_shapes(self.env.rows(a, a + m), self.bap.rows(a, a + m), m);
                    self.lh.push(&lh);
                    self.ln.push(&ln);
                }
                self.env.trim(self.lh.end());
            }
        }
        self.bap.trim(self.env.base);

        // the source and the noise: each sample needs its frame and the next
        let n_smp = self.samples;
        let upto = if self.f0.len() == total {
            n_smp
        } else {
            self.f0.len().saturating_sub(1) * HOP
        };
        if upto > self.src.len() {
            let mut x = Vec::with_capacity(upto - self.src.len());
            self.src.run(&self.f0, &fr.vuv, upto, &mut x);
            self.source.push(&x);
            let noise = self.rng.gaussian(upto - self.noise.end());
            self.noise.push(&noise);
        }

        // frames out: each needs its filters and the signals to half a window past its centre
        let [eh, en, hh, y] = &mut self.spec;
        while self.ola.added() < self.lh.end() {
            let t = self.ola.added();
            if !(t * HOP + NFFT / 2 <= self.source.end() || self.source.end() == n_smp) {
                break;
            }
            v.stft.frame(
                &self.source.data,
                self.source.base,
                n_smp,
                t,
                &mut self.buf,
                eh,
            );
            v.stft.frame(
                &self.noise.data,
                self.noise.base,
                n_smp,
                t,
                &mut self.buf,
                en,
            );
            Vocoder::synth_frame(
                &mut self.mp,
                hh,
                self.lh.rows(t, t + 1),
                self.ln.rows(t, t + 1),
                eh,
                en,
                y,
            );
            self.ola.add(&v.stft, y, out);
        }
        // as in training, a silent frame past the end
        if self.ola.added() == total {
            y.fill(C::default());
            self.ola.add(&v.stft, y, out);
        }
        let t = self.ola.added().min(total);
        self.lh.trim(t);
        self.ln.trim(t);
        self.source.trim((t * HOP).saturating_sub(NFFT / 2));
        self.noise.trim((t * HOP).saturating_sub(NFFT / 2));
    }
}
