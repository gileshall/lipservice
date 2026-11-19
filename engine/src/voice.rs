// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A voice file: one speaker's score model, and its pitch flow, mean shape (with
//! its widening), register shift, pitch centre, the share of word gaps its speaker breaks at, its
//! speaker's pace, its own mel decoder, its speaker's pauses and its parts of the latent voice
//! (vox.rs), under score., flow., shape., voice., mel., pause. and vox.
//! Its parts of the latent voice and its mel decoder may be files of their own (tools/split.py),
//! joined to it before it is loaded (Weights::join), so a route fetches only what it speaks through.

use crate::melvoc::MelDec;
use crate::pause::PauseBank;
use crate::pitchflow::PitchFlow;
use crate::score::{enc_digest, ScoreModel};
use crate::sharpen::Sharpen;
use crate::vox::Wearer;
use crate::weights::{err, Error, Result, Weights};

pub struct Voice {
    pub name: String,
    pub score: ScoreModel,
    pub flow: Option<PitchFlow>,
    pub sharpen: Option<Sharpen>,
    /// Semitones, added to the pitch before the decoder (say --shift).
    pub shift: f32,
    /// The median of its pitch flow's voiced log F0 on its speaker's lines, natural log Hz before
    /// the shift: what its draws are widened about (pitchflow::Widen).
    pub centre: Option<f32>,
    /// Of the word gaps with no stop, the share its speaker breaks at (Inflection::phrase).
    pub phrase: Option<f32>,
    /// Its speaker's phone frames over the model's (Inflection::pace); 1 without voice.pace.
    pub pace: f32,
    /// Its own mel decoder, which the mel route speaks it through.
    pub mel: Option<MelDec>,
    /// Its speaker's pauses, which the mel route puts in its pauses.
    pub pause: Option<PauseBank>,
    /// Its parts of the latent voice, which a model of it speaks it through.
    pub vox: Option<Wearer>,
}

/// A base that voices are written against, and what its voices share where
/// they leave it as it is, built once: its score model but for the speakers, with its text encoder's
/// digest, and its pitch flow.
pub struct Base {
    ws: Weights,
    score: ScoreModel,
    enc: u64,
    flow: Option<PitchFlow>,
}

impl Base {
    pub fn load(ws: Weights) -> Result<Base> {
        let (score, flow) = (ws.under("score."), ws.under("flow."));
        Ok(Base { score: ScoreModel::load(&score)?, enc: enc_digest(&score, "enc")?, flow: if flow.is_empty() { None } else { Some(PitchFlow::load(&flow)?) }, ws })
    }
}

impl Voice {
    pub fn is(ws: &Weights) -> bool {
        ws.has("voice.shift")
    }

    /// The sharpening, if the voice has a shape, widened as the file says or `widen` times.
    pub fn load(ws: Weights, widen: Option<f32>) -> Result<Voice> {
        if ws.needs_base() {
            return err("the voice is written against a base: Weights::on_base or Voice::load_on");
        }
        Voice::build(ws, widen, None, None)
    }

    /// A voice written against a base, as load() gives it on_base(). A score
    /// model that is the base's but for the speakers, and a pitch flow that is the base's, are the
    /// base's own, shared. `mel`: whether its mel decoder and pauses are built; only the mel route
    /// speaks through them.
    pub fn load_on(ws: Weights, base: &Base, widen: Option<f32>, mel: bool) -> Result<Voice> {
        let score = ws.names().filter(|n| n.starts_with("score.")).all(|n| n == "score.spk.weight");
        let flow = !ws.names().any(|n| n.starts_with("flow."));
        let built = |n: &str| mel || !(n.starts_with("mel.") || n.starts_with("pause."));
        let mut ws = ws.on_base_where(&base.ws, |n| built(n) && !(score && n.starts_with("score.") && n != "score.spk.weight") && !(flow && n.starts_with("flow.")))?;
        if !Voice::is(&ws) {
            return err("not a voice file");
        }
        if !mel {
            ws.split("mel.");
            ws.split("pause.");
        }
        let mut v = Voice::build(ws, widen, score.then_some((&base.score, base.enc)), flow.then(|| base.flow.clone()))?;
        v.score = v.score.timed_by(&base.score);
        Ok(v)
    }

    /// A voice from its tensors, whole but for the score model `shared` gives (the speakers the
    /// voice's own, with its text encoder's digest) and the pitch flow `flowed` does.
    fn build(mut ws: Weights, widen: Option<f32>, shared: Option<(&ScoreModel, u64)>, flowed: Option<Option<PitchFlow>>) -> Result<Voice> {
        let (v, score, flow, shape, mel, pause, vox) =
            (ws.split("voice."), ws.split("score."), ws.split("flow."), ws.split("shape."), ws.split("mel."), ws.split("pause."), ws.split("vox."));
        if let Some(n) = ws.names().chain(v.names().filter(|n| !matches!(n.as_str(), "name" | "shift" | "centre" | "widen" | "phrase" | "pace" | "apart"))).next() {
            return err(format!("{n}: not part of a voice"));
        }
        let name = String::from_utf8(v.get("name")?.q.iter().map(|&b| b as u8).collect()).map_err(|_| Error("voice.name is not utf-8".into()))?;
        let enc = match (shared, vox.is_empty()) {
            (_, true) => None,
            (Some((_, d)), false) => Some(d),
            (None, false) => Some(enc_digest(&score, "enc")?),
        };
        let vox = enc.map(|enc| Wearer { enc, parts: vox });
        let score = match shared {
            Some((m, _)) => m.with_speakers(&score)?,
            None => ScoreModel::load(&score)?,
        };
        let flow = match flowed {
            Some(f) => f,
            None if flow.is_empty() => None,
            None => Some(PitchFlow::load(&flow)?),
        };
        if score.speakers() != 1 {
            return err(format!("the voice's score model has {} speakers, not 1", score.speakers()));
        }
        let mel = if mel.is_empty() { None } else { Some(MelDec::load(&mel)?) };
        if let Some(m) = &mel {
            if m.cin() != score.dim() {
                return err(format!("the voice's mel decoder takes token states of {}, its score model gives {}", m.cin(), score.dim()));
            }
        }
        let sharpen = if shape.is_empty() {
            if v.has("widen") {
                return err("voice.widen without a shape");
            }
            None
        } else {
            let w = match widen {
                Some(w) => w,
                None => v.shaped("widen", &[1])?[0],
            };
            let sh = Sharpen::load(&shape, 1, w, 1.0, 1.0)?;
            sh.check(0)?;
            Some(sh)
        };
        let phrase = if v.has("phrase") {
            let r = v.shaped("phrase", &[1])?[0];
            if !(r > 0.0 && r < 1.0) {
                return err(format!("voice.phrase {r}: a share, between 0 and 1"));
            }
            Some(r)
        } else {
            None
        };
        let pace = if v.has("pace") {
            let p = v.shaped("pace", &[1])?[0];
            if !(p > 0.5 && p < 2.0) {
                return err(format!("voice.pace {p}: from 0.5 to 2"));
            }
            p
        } else {
            1.0
        };
        let centre = if v.has("centre") {
            if flow.is_none() {
                return err("voice.centre without a pitch flow");
            }
            let c = v.shaped("centre", &[1])?[0];
            if !(3.0..7.0).contains(&c) {
                return err(format!("voice.centre {c}: a natural log of Hz, 3 to 7"));
            }
            Some(c)
        } else {
            None
        };
        Ok(Voice {
            centre,
            phrase,
            pace,
            name,
            score,
            flow,
            sharpen,
            shift: v.shaped("shift", &[1])?[0],
            mel,
            pause: if pause.is_empty() { None } else { Some(PauseBank::load(&pause)?) },
            vox,
        })
    }
}
