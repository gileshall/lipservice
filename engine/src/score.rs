// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The score model at inference: tokens to durations, pitch and
//! vocoder frames.

use crate::attn::EncoderLayer;
use crate::front;
use crate::nn::{Conv1d, ConvNeXt, LayerNorm, Linear};
use crate::pitchflow::{PitchFlow, Sampling};
use crate::vocoder::{Frames, LF0_MU, LF0_SD, N_AP, N_ENV};
use crate::weights::{err, Result, Weights};
use std::sync::Arc;

/// Consonants said without voice that the pitch voices: it learned a tracker that calls three in
/// four of their frames voiced. Not HH, voiced between vowels.
const UNVOICED: [&str; 8] = ["P", "T", "K", "F", "TH", "S", "SH", "CH"];
/// Frames left as the pitch voices them at an unvoiced consonant's edge beside another sound, and at
/// either end of a pause.
const UNVOICED_EDGE: usize = 2;

/// Each frame's voicing taken off: an unvoiced consonant's frames but UNVOICED_EDGE at each edge
/// beside another sound, the sound across a word gap; a word gap's between two unvoiced consonants
/// (the hiss of "not saying" falls in it); a pause's (the space after a stop), which the pitch
/// voices as a word gap and the decoder then sounds, but UNVOICED_EDGE at either end.
pub(crate) fn unvoiced_frames(tok: &[usize], durations: &[usize]) -> Vec<bool> {
    assert_eq!(tok.len(), durations.len());
    let un = |i: usize| UNVOICED.contains(&front::symbol(tok[i]));
    let pause = |i: usize| i > 0 && tok[i] == front::SPACE && matches!(front::symbol(tok[i - 1]), "," | "." | "?" | "!" | ";" | ":");
    let gap = |i: usize| tok[i] == front::SPACE && !pause(i);
    let before = |i: usize| (0..i).rev().find(|&j| !gap(j));
    let after = |i: usize| (i + 1..tok.len()).find(|&j| !gap(j));
    let mut out = Vec::with_capacity(durations.iter().sum());
    for (i, &d) in durations.iter().enumerate() {
        if pause(i) {
            out.extend((0..d).map(|f| f >= UNVOICED_EDGE && f + UNVOICED_EDGE < d));
            continue;
        }
        if gap(i) && before(i).is_some_and(un) && after(i).is_some_and(un) {
            out.extend((0..d).map(|_| true));
            continue;
        }
        let lead = if before(i).is_some_and(|j| !un(j)) { UNVOICED_EDGE } else { 0 };
        let tail = if after(i).is_some_and(|j| !un(j)) { UNVOICED_EDGE } else { 0 };
        let u = un(i);
        out.extend((0..d).map(|f| u && f >= lead && f + tail < d));
    }
    out
}

/// The text encoder under a prefix: tokens to states, no speaker.
pub struct TextEncoder {
    dim: usize,
    n_sym: usize,
    emb: Vec<f32>,
    convs: Vec<ConvNeXt>,
    attn: Vec<EncoderLayer>,
    norm: LayerNorm,
}

/// What names the text encoder under a prefix: FNV-1a over each of its tensors' name (the prefix
/// off) and values, in the names' order.
pub fn enc_digest(ws: &Weights, prefix: &str) -> Result<u64> {
    let at = format!("{prefix}.");
    let mut names: Vec<&String> = ws.names().filter(|n| n.starts_with(&at)).collect();
    names.sort();
    let mut h = 0xcbf29ce484222325u64;
    let mut eat = |b: &[u8]| b.iter().for_each(|&c| h = (h ^ c as u64).wrapping_mul(0x100000001b3));
    for n in names {
        let t = ws.get(n)?;
        eat(n[at.len()..].as_bytes());
        t.data.iter().for_each(|v| eat(&v.to_le_bytes()));
        t.q.iter().for_each(|v| eat(&[*v as u8]));
    }
    Ok(h)
}

impl TextEncoder {
    pub fn load(ws: &Weights, prefix: &str) -> Result<TextEncoder> {
        let e = ws.get(&format!("{prefix}.emb.weight"))?;
        let (n_sym, dim) = (e.shape[0], e.shape[1]);
        let mut attn = Vec::new();
        while ws.has(&format!("{prefix}.attn.layers.{}.norm1.weight", attn.len())) {
            attn.push(EncoderLayer::load(ws, &format!("{prefix}.attn.layers.{}", attn.len()), dim, 4)?);
        }
        Ok(TextEncoder {
            dim,
            n_sym,
            emb: e.data.clone(),
            convs: blocks(ws, &format!("{prefix}.convs.blocks"), dim, 5)?,
            attn,
            norm: LayerNorm::load(ws, &format!("{prefix}.norm"), dim)?,
        })
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    /// Token states (N, dim).
    pub fn forward(&self, tok: &[usize]) -> Result<Vec<f32>> {
        let (d, n) = (self.dim, tok.len());
        let mut h = vec![0.0; n * d];
        for (i, &t) in tok.iter().enumerate() {
            if t >= self.n_sym {
                return err(format!("token {t} outside the {} symbols", self.n_sym));
            }
            h[i * d..(i + 1) * d].copy_from_slice(&self.emb[t * d..(t + 1) * d]);
        }
        for b in &self.convs {
            b.forward(&mut h, n);
        }
        for l in &self.attn {
            l.forward(&mut h, n);
        }
        self.norm.forward(&mut h);
        Ok(h)
    }
}

/// A score model: its speakers, and the rest (Core), which models that differ only in their
/// speakers share (with_speakers).
pub struct ScoreModel {
    core: Arc<Core>,
    spk: Vec<f32>,
    /// The clock singers keep together (common_durations): the model this one was loaded as, or the
    /// base a voice was written against (timed_by), with the mean of its speakers.
    clock: Arc<Clock>,
}

struct Clock {
    core: Arc<Core>,
    row: Vec<f32>,
}

impl std::ops::Deref for ScoreModel {
    type Target = Core;

    fn deref(&self) -> &Core {
        &self.core
    }
}

/// A score model but for its speakers.
pub struct Core {
    pub(crate) dim: usize,
    pub(crate) dec_dim: usize,
    enc: TextEncoder,
    dur: [Conv1d; 3],
    pub(crate) pitch_in: Linear,
    pub(crate) pitch: Vec<ConvNeXt>,
    pitch_out: Linear,
    pub(crate) f0_emb: Conv1d,
    pub(crate) dec_in: Linear,
    pub(crate) dec: Vec<ConvNeXt>,
    dec_out: Linear,
    env_mu: Vec<f32>,
    env_sd: Vec<f32>,
    /// Added to a spelled word's token states before the duration head (dur.spelled), where the model has one.
    spelled: Option<Vec<f32>>,
}

fn blocks(ws: &Weights, prefix: &str, dim: usize, k: usize) -> Result<Vec<ConvNeXt>> {
    let mut v = Vec::new();
    while ws.has(&format!("{prefix}.{}.gamma", v.len())) {
        v.push(ConvNeXt::load(ws, &format!("{prefix}.{}", v.len()), dim, 3, k)?);
    }
    if v.is_empty() {
        return err(format!("no blocks under {prefix}"));
    }
    Ok(v)
}

/// h's rows of `dim` with v added where `spelled` is true; none changed without v.
fn marked(h: &[f32], dim: usize, v: Option<&[f32]>, spelled: &[bool]) -> Vec<f32> {
    let mut m = h.to_vec();
    if let Some(v) = v {
        for (row, _) in m.chunks_exact_mut(dim).zip(spelled).filter(|(_, &s)| s) {
            row.iter_mut().zip(v).for_each(|(x, a)| *x += a);
        }
    }
    m
}

/// A pitch shift in semitones as natural log units.
pub fn semitones(shift: f32) -> f32 {
    shift * std::f32::consts::LN_2 / 12.0
}

/// Where the pitch and voicing come from: the score model's own head, or the flow.
#[derive(Clone, Copy)]
pub enum Pitch<'a> {
    Head,
    Flow(&'a PitchFlow, Sampling),
}

impl Pitch<'_> {
    /// That the flow fits this score model and its sampling makes sense.
    pub fn check(&self, score: &ScoreModel) -> Result<()> {
        if let Pitch::Flow(f, s) = self {
            if f.cond_dim() != score.dim {
                return err(format!("the pitch flow takes token states of {}, the score model gives {}", f.cond_dim(), score.dim));
            }
            s.check()?;
        }
        Ok(())
    }
}

/// Prediction for one utterance.
pub struct Score {
    pub durations: Vec<usize>, // frames per token
    pub frames: Frames,
}

impl ScoreModel {
    pub fn load(ws: &Weights) -> Result<ScoreModel> {
        let enc = TextEncoder::load(ws, "enc")?;
        let dim = enc.dim;
        let dec_dim = ws.get("dec_in.weight")?.shape[0];
        let core = Core {
            dim,
            dec_dim,
            enc,
            dur: [Conv1d::load(ws, "dur.0", dim, dim, 3)?, Conv1d::load(ws, "dur.2", dim, dim, 3)?, Conv1d::load(ws, "dur.4", 1, dim, 1)?],
            pitch_in: Linear::load(ws, "pitch_in", dim, dim)?,
            pitch: blocks(ws, "pitch.blocks", dim, 7)?,
            pitch_out: Linear::load(ws, "pitch_out", 2, dim)?,
            f0_emb: Conv1d::load(ws, "f0_emb", dec_dim, 2, 3)?,
            dec_in: Linear::load(ws, "dec_in", dec_dim, dim)?,
            dec: blocks(ws, "dec.blocks", dec_dim, 7)?,
            dec_out: Linear::load(ws, "dec_out", N_ENV + N_AP, dec_dim)?,
            env_mu: ws.shaped("env_mu", &[N_ENV])?.to_vec(),
            env_sd: ws.shaped("env_sd", &[N_ENV])?.to_vec(),
            spelled: if ws.has("dur.spelled") { Some(ws.shaped("dur.spelled", &[dim])?.to_vec()) } else { None },
        };
        let spk = ws.get("spk.weight")?.data.clone();
        if spk.is_empty() || spk.len() % dim != 0 {
            return err(format!("spk.weight of {} values, not speakers of {dim}", spk.len()));
        }
        let n = (spk.len() / dim) as f32;
        let row = (0..dim).map(|c| spk.chunks_exact(dim).map(|r| r[c]).sum::<f32>() / n).collect();
        let core = Arc::new(core);
        Ok(ScoreModel { core: core.clone(), spk, clock: Arc::new(Clock { core, row }) })
    }

    /// The model with the speakers ws holds (spk.weight), the rest shared with this one.
    pub fn with_speakers(&self, ws: &Weights) -> Result<ScoreModel> {
        let spk = ws.get("spk.weight")?;
        if spk.shape.len() != 2 || spk.shape[1] != self.dim || spk.data.len() != spk.shape[0] * self.dim {
            return err(format!("spk.weight is {:?}, not speakers of {}", spk.shape, self.dim));
        }
        Ok(ScoreModel { core: self.core.clone(), spk: spk.data.clone(), clock: self.clock.clone() })
    }

    /// The token states' width.
    pub fn dim(&self) -> usize {
        self.dim
    }

    pub fn speakers(&self) -> usize {
        self.spk.len() / self.dim
    }

    /// Token states (N, dim).
    pub fn encode(&self, tok: &[usize], speaker: usize) -> Result<Vec<f32>> {
        self.spoken(self.states(tok)?, speaker)
    }

    /// The text encoder's token states (N, dim), no speaker in them.
    pub fn states(&self, tok: &[usize]) -> Result<Vec<f32>> {
        self.enc.forward(tok)
    }

    /// This model keeping `base`'s clock: a voice written against a base keeps the base's, whatever
    /// of the score model is its own.
    pub fn timed_by(mut self, base: &ScoreModel) -> ScoreModel {
        self.clock = base.clock.clone();
        self
    }

    /// Frames per token by the clock (the clock's model as the mean of its speakers): the same for
    /// every voice that keeps it, so that singers' consonants land as one.
    pub fn common_durations(&self, tok: &[usize]) -> Result<Vec<usize>> {
        let m = ScoreModel { core: self.clock.core.clone(), spk: self.clock.row.clone(), clock: self.clock.clone() };
        m.durations(&m.encode(tok, 0)?, tok.len(), 1.0)
    }

    /// states() as a speaker's token states.
    pub fn spoken(&self, mut h: Vec<f32>, speaker: usize) -> Result<Vec<f32>> {
        let d = self.dim;
        if speaker >= self.speakers() {
            return err(format!("speaker {speaker} of {}", self.speakers()));
        }
        let s = &self.spk[speaker * d..(speaker + 1) * d];
        for row in h.chunks_exact_mut(d) {
            for c in 0..d {
                row[c] += s[c];
            }
        }
        Ok(h)
    }

    /// Token states for the duration head: dur.spelled added at the tokens of spelled words.
    pub fn marked(&self, h: &[f32], spelled: &[bool]) -> Vec<f32> {
        marked(h, self.dim, self.spelled.as_deref(), spelled)
    }

    /// log(1 + frames) per token.
    pub fn log_durations(&self, h: &[f32], n: usize) -> Vec<f32> {
        let d = self.dim;
        let mut a = vec![0.0; n * d];
        let mut b = vec![0.0; n * d];
        self.dur[0].forward(h, n, &mut a);
        a.iter_mut().for_each(|v| *v = v.max(0.0));
        self.dur[1].forward(&a, n, &mut b);
        b.iter_mut().for_each(|v| *v = v.max(0.0));
        let mut out = vec![0.0; n];
        self.dur[2].forward(&b, n, &mut out);
        out
    }

    /// Token states repeated over their frames.
    pub fn expand(&self, h: &[f32], dur: &[usize]) -> Vec<f32> {
        let d = self.dim;
        let mut hx = Vec::with_capacity(dur.iter().sum::<usize>() * d);
        for (i, &k) in dur.iter().enumerate() {
            for _ in 0..k {
                hx.extend_from_slice(&h[i * d..(i + 1) * d]);
            }
        }
        hx
    }

    /// Normalized log F0 and voicing logits per frame.
    pub fn pitch(&self, hx: &[f32], t: usize) -> (Vec<f32>, Vec<f32>) {
        let mut x = vec![0.0; t * self.dim];
        self.pitch_in.forward(hx, t, &mut x);
        for b in &self.pitch {
            b.forward(&mut x, t);
        }
        self.pitch_head(&x, t)
    }

    pub(crate) fn pitch_head(&self, x: &[f32], t: usize) -> (Vec<f32>, Vec<f32>) {
        let mut p = vec![0.0; t * 2];
        self.pitch_out.forward(x, t, &mut p);
        ((0..t).map(|i| p[2 * i]).collect(), (0..t).map(|i| p[2 * i + 1]).collect())
    }

    /// Log F0 (shifted by sh, in natural log units) and voicing from the pitch head's outputs,
    /// none where `unvoiced` (unvoiced_frames).
    pub(crate) fn to_lf0_vuv(plf0: &[f32], pv: &[f32], sh: f32, unvoiced: &[bool]) -> (Vec<f32>, Vec<f32>) {
        assert_eq!(pv.len(), unvoiced.len());
        (
            plf0.iter().map(|v| v * LF0_SD + LF0_MU + sh).collect(),
            pv.iter().zip(unvoiced).map(|(&v, &u)| if v > 0.0 && !u { 1.0 } else { 0.0 }).collect(),
        )
    }

    /// The decoder's pitch input rows.
    pub(crate) fn f0_feat(lf0: &[f32], vuv: &[f32]) -> Vec<f32> {
        (0..lf0.len()).flat_map(|i| [(lf0[i] - LF0_MU) / LF0_SD, vuv[i]]).collect()
    }

    /// Envelope and aperiodicity for frames driven by lf0 and vuv.
    pub fn decode(&self, hx: &[f32], lf0: &[f32], vuv: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let (t, dd) = (lf0.len(), self.dec_dim);
        let f = Self::f0_feat(lf0, vuv);
        let mut x = vec![0.0; t * dd];
        self.dec_in.forward(hx, t, &mut x);
        let mut fe = vec![0.0; t * dd];
        self.f0_emb.forward(&f, t, &mut fe);
        for (a, b) in x.iter_mut().zip(&fe) {
            *a += b;
        }
        for b in &self.dec {
            b.forward(&mut x, t);
        }
        self.dec_head(&x, t)
    }

    pub(crate) fn dec_head(&self, x: &[f32], t: usize) -> (Vec<f32>, Vec<f32>) {
        let k = N_ENV + N_AP;
        let mut y = vec![0.0; t * k];
        self.dec_out.forward(x, t, &mut y);
        let mut env = vec![0.0; t * N_ENV];
        let mut bap = vec![0.0; t * N_AP];
        for i in 0..t {
            for c in 0..N_ENV {
                env[i * N_ENV + c] = y[i * k + c] * self.env_sd[c] + self.env_mu[c];
            }
            for c in 0..N_AP {
                bap[i * N_AP + c] = 1.0 / (1.0 + (-y[i * k + N_ENV + c]).exp());
            }
        }
        (env, bap)
    }

    /// Frames per token: rate scales speed (2 is twice as fast).
    pub fn durations(&self, h: &[f32], n: usize, rate: f32) -> Result<Vec<usize>> {
        if !(rate > 0.0) {
            return err(format!("rate {rate} must be positive"));
        }
        let logd = self.log_durations(h, n);
        Ok(logd.iter().map(|&l| ((l.max(0.0).exp_m1() / rate).round_ties_even().max(1.0)) as usize).collect())
    }

    /// The whole score: rate scales speed (2 is twice as fast); shift is in semitones.
    pub fn infer(&self, tok: &[usize], speaker: usize, rate: f32, shift: f32, pitch: Pitch) -> Result<Score> {
        pitch.check(self)?;
        let h = self.encode(tok, speaker)?;
        let durations = self.durations(&h, tok.len(), rate)?;
        let hx = self.expand(&h, &durations);
        let t = durations.iter().sum();
        let (plf0, pv) = match pitch {
            Pitch::Head => self.pitch(&hx, t),
            Pitch::Flow(f, s) => {
                let x = f.sample(&h, &durations, &s)?;
                ((0..t).map(|i| s.spread(x[2 * i])).collect(), (0..t).map(|i| x[2 * i + 1]).collect())
            }
        };
        let (lf0, vuv) = Self::to_lf0_vuv(&plf0, &pv, semitones(shift), &unvoiced_frames(tok, &durations));
        let (env, bap) = self.decode(&hx, &lf0, &vuv);
        Ok(Score { durations, frames: Frames { env, bap, lf0, vuv } })
    }
}

#[cfg(test)]
mod tests {
    use super::{marked, unvoiced_frames};
    use crate::front::{symbol_id, BOS, EOS, SPACE};

    #[test]
    fn a_spelled_word_s_states_take_the_vector_and_no_other() {
        let h: Vec<f32> = (0..9).map(|i| i as f32).collect();
        let mask = [true, false, true];
        assert_eq!(marked(&h, 3, None, &mask), h);
        assert_eq!(marked(&h, 3, Some(&[1.0, 2.0, 3.0]), &mask), vec![1.0, 3.0, 5.0, 3.0, 4.0, 5.0, 7.0, 9.0, 11.0]);
    }

    #[test]
    fn unvoiced_keep_their_edges_beside_other_sounds() {
        let tok: Vec<usize> = ["S", "T", "AA1", "P", "HH", "AA1", "F"]
            .iter()
            .map(|s| symbol_id(s).unwrap())
            .collect();
        let tok = [&[BOS][..], &tok, &[SPACE, EOS]].concat();
        let durations = [3, 5, 5, 6, 5, 4, 3, 6, 2, 3];
        let got: String = unvoiced_frames(&tok, &durations).iter().map(|&u| if u { 'x' } else { '.' }).collect();
        let want = ["...", "..xxx", "xxx..", "......", "..x..", "....", "...", "..xx..", "..", "..."].concat();
        assert_eq!(got, want);
    }

    #[test]
    fn a_pause_is_unvoiced_but_its_ends() {
        let tok: Vec<usize> = ["M", "IY1", ",", " ", "M", "IH1", "S", " ", "AH0", "?", " ", "N", "OW1", "."]
            .iter()
            .map(|&s| if s == " " { SPACE } else { symbol_id(s).unwrap() })
            .collect();
        let tok = [&[BOS][..], &tok, &[EOS]].concat();
        let durations = [3, 3, 8, 4, 9, 2, 3, 7, 4, 3, 4, 3, 2, 5, 4, 3];
        let got: String = unvoiced_frames(&tok, &durations).iter().map(|&u| if u { 'x' } else { '.' }).collect();
        let want = ["...", "...", "........", "....", "..xxxxx..", "..", "...", "..xxx..", "....", "...", "....", "...", "..", ".....", "....", "..."].concat();
        assert_eq!(got, want);
    }

    #[test]
    fn a_word_gap_between_unvoiced_consonants_is_unvoiced_and_lends_them_no_edge() {
        // "not saying", "it's a"
        let tok: Vec<usize> = ["N", "AA1", "T", " ", "S", "EY1", "IH0", "T", "S", " ", "AH0"]
            .iter()
            .map(|&s| if s == " " { SPACE } else { symbol_id(s).unwrap() })
            .collect();
        let tok = [&[BOS][..], &tok, &[EOS]].concat();
        let durations = [3, 3, 8, 5, 15, 5, 10, 4, 4, 5, 3, 6, 3];
        let got: String = unvoiced_frames(&tok, &durations).iter().map(|&u| if u { 'x' } else { '.' }).collect();
        let want = ["...", "...", "........", "..xxx", "xxxxxxxxxxxxxxx", "xxx..", "..........", "....", "..xx", "xxx..", "...", "......", "..."].concat();
        assert_eq!(got, want);
    }
}
