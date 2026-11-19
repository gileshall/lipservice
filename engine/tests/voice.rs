// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A voice file against its parts loaded one by one, and one written against a
//! base against the whole: the same samples. A voice cut into its parts
//! (tools/split.py) joined again: the same tensors.

use lipservice::dsp::HOP;
use lipservice::front::Phonemizer;
use lipservice::g2p::G2p;
use lipservice::lexicon::Lexicon;
use lipservice::pitchflow::{PitchFlow, Sampling};
use lipservice::rng::Rng;
use lipservice::score::{Pitch, ScoreModel};
use lipservice::sharpen::Sharpen;
use lipservice::vocoder::Vocoder;
use lipservice::voice::Voice;
use lipservice::weights::Weights;

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn render(score: &ScoreModel, flow: Option<&PitchFlow>, sharpen: Option<&Sharpen>, shift: f32, voc: &Vocoder) -> Vec<f32> {
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let tok = ph.encode("A voice in one file should change nothing.").unwrap();
    let pitch = match flow {
        Some(f) => Pitch::Flow(f, Sampling { seed: 5, ..Default::default() }),
        None => Pitch::Head,
    };
    let mut s = score.infer(&tok, 0, 1.0, shift, pitch).unwrap();
    if let Some(sh) = sharpen {
        s.frames.env = sh.apply(0, &s.frames.env);
    }
    voc.render(&s.frames, &Rng::new(5).gaussian(s.frames.len() * HOP)).unwrap()
}

fn same(a: &[f32], b: &[f32]) {
    assert_eq!(a.len(), b.len());
    assert!(a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits()));
}

#[test]
fn voice_matches_its_parts() {
    let voc = Vocoder::load(&read("voc-a-i8.lsw")).unwrap();
    let (score, flow) = (ScoreModel::load(&read("score-a-i8.lsw")).unwrap(), PitchFlow::load(&read("pitch-a-i8.lsw")).unwrap());
    // the file's widening (0.85), then another in its place
    for (widen, w) in [(None, 0.85), (Some(1.3), 1.3)] {
        let v = Voice::load(read("voice-a-i8.lsw"), widen).unwrap();
        assert_eq!((v.name.as_str(), v.shift), ("a", 1.5));
        assert!(v.sharpen.is_some() && v.flow.is_some());
        let sh = Sharpen::load(&read("shape-a.lsw"), 1, w, 1.0, 1.0).unwrap();
        let want = render(&score, Some(&flow), Some(&sh), 1.5, &voc);
        same(&render(&v.score, v.flow.as_ref(), v.sharpen.as_ref(), v.shift, &voc), &want);
    }

    let h = Voice::load(read("voice-a-head.lsw"), None).unwrap();
    assert_eq!((h.name.as_str(), h.shift), ("a head", -2.0));
    assert!(h.flow.is_none() && h.sharpen.is_none());
    same(&render(&h.score, None, None, h.shift, &voc), &render(&ScoreModel::load(&read("score-a.lsw")).unwrap(), None, None, -2.0, &voc));
}

#[test]
fn score_file_is_not_a_voice() {
    assert!(!Voice::is(&read("score-a-i8.lsw")));
    assert!(Voice::load(read("score-a-i8.lsw"), None).is_err());
}

#[test]
fn voice_on_a_base() {
    let voc = Vocoder::load(&read("voc-a-i8.lsw")).unwrap();
    let on = read("voice-a-on-head.lsw");
    assert!(on.needs_base() && Voice::is(&on));
    assert!(Voice::load(read("voice-a-on-head.lsw"), None).is_err());
    assert!(read("voice-a-on-head.lsw").on_base(&read("voice-a-i8.lsw")).is_err());
    assert!(read("voice-a-i8.lsw").on_base(&read("voice-a-head.lsw")).is_err());
    let v = Voice::load(on.on_base(&read("voice-a-head.lsw")).unwrap(), None).unwrap();
    let w = Voice::load(read("voice-a-i8.lsw"), None).unwrap();
    assert_eq!((v.name.as_str(), v.shift), (w.name.as_str(), w.shift));
    same(&render(&v.score, v.flow.as_ref(), v.sharpen.as_ref(), v.shift, &voc), &render(&w.score, w.flow.as_ref(), w.sharpen.as_ref(), w.shift, &voc));
}

#[test]
fn a_voice_with_its_speakers_timing() {
    let voc = Vocoder::load(&read("voc-a-i8.lsw")).unwrap();
    let (t, w) = (Voice::load(read("voice-a-timed.lsw"), None).unwrap(), Voice::load(read("voice-a-i8.lsw"), None).unwrap());
    assert_eq!((t.pace, t.phrase, w.pace, w.phrase), (1.06, Some(0.02), 1.0, None));
    same(&render(&t.score, t.flow.as_ref(), t.sharpen.as_ref(), t.shift, &voc), &render(&w.score, w.flow.as_ref(), w.sharpen.as_ref(), w.shift, &voc));
}

#[test]
fn a_voice_with_its_pitch_centre() {
    let (c, w) = (Voice::load(read("voice-a-centred.lsw"), None).unwrap(), Voice::load(read("voice-a-i8.lsw"), None).unwrap());
    assert_eq!((c.centre, w.centre), (Some(4.9), None));
    assert!(c.flow.is_some());
}

/// Every tensor of `a` and `b`, the same names and the same values.
fn same_tensors(a: &Weights, b: &Weights) {
    let mut names: Vec<&String> = a.names().collect();
    let mut other: Vec<&String> = b.names().collect();
    names.sort();
    other.sort();
    assert_eq!(names, other);
    for n in names {
        let (x, y) = (a.get(n).unwrap(), b.get(n).unwrap());
        assert!(x.shape == y.shape && x.q == y.q && x.data.len() == y.data.len() && x.data.iter().zip(&y.data).all(|(p, q)| p.to_bits() == q.to_bits()), "{n}");
    }
}

#[test]
fn a_voice_cut_into_its_parts() {
    let cut = |name: &str| read(&format!("vox-split/{name}"));
    let whole = read("vox-voice.lsw").on_base(&read("vox-base.lsw")).unwrap();
    let route = read("vox-melvoc.lsw").under("mel.");
    let apart = |ws: &Weights| ws.names().any(|n| n == "voice.apart");

    // both parts joined, on the base without its mel decoder: the whole voice's tensors
    let mut v = cut("voices/vox-voice.lsw");
    assert!(v.needs_base() && Voice::is(&v) && apart(&v) && !v.is_part());
    assert!(v.has_parts(&[]).is_ok() && v.has_parts(&["vox"]).is_err() && v.has_parts(&["mel"]).is_err());
    assert!(cut("voices/vox-voice.vox.lsw").is_part() && cut("voices/vox-voice.mel.lsw").is_part());
    v.join(cut("voices/vox-voice.vox.lsw"), None).unwrap();
    assert!(v.has_parts(&["vox"]).is_ok() && v.has_parts(&["vox", "mel"]).is_err());
    v.join(cut("voices/vox-voice.mel.lsw"), Some(&route)).unwrap();
    v.has_parts(&["vox", "mel"]).unwrap();
    let mut v = v.on_base(&cut("base.lsw")).unwrap();
    assert!(apart(&v));
    v.split("voice.apart");
    same_tensors(&v, &whole);

    // the latent voice's route: nothing of the mel decoder, the rest the whole voice's
    let mut v = cut("voices/vox-voice.lsw");
    v.join(cut("voices/vox-voice.vox.lsw"), None).unwrap();
    let mut v = v.on_base(&cut("base.lsw")).unwrap();
    assert!(!v.names().any(|n| n.starts_with("mel.")));
    v.split("voice.apart");
    let mut rest = read("vox-voice.lsw").on_base(&read("vox-base.lsw")).unwrap();
    rest.split("mel.");
    same_tensors(&v, &rest);
    let v = Voice::load(v, None).unwrap();
    assert!(v.vox.is_some() && v.mel.is_none());

    // refused: the base before the cut, a part twice, a part of no voice, a mel decoder with no
    // mel route or another's, a part on another voice
    assert!(cut("voices/vox-voice.lsw").on_base(&read("vox-base.lsw")).is_err());
    assert!(read("vox-voice.lsw").on_base(&cut("base.lsw")).is_err());
    let mut v = cut("voices/vox-voice.lsw");
    v.join(cut("voices/vox-voice.vox.lsw"), None).unwrap();
    assert!(v.join(cut("voices/vox-voice.vox.lsw"), None).is_err());
    assert!(cut("voices/vox-voice.lsw").join(read("vox-voice.lsw"), None).is_err());
    assert!(cut("voices/vox-voice.lsw").join(cut("voices/vox-voice.mel.lsw"), None).is_err());
    assert!(cut("voices/vox-voice.lsw").join(cut("voices/vox-voice.mel.lsw"), Some(&read("melvoc-h-i8.lsw").under("mel."))).is_err());
    assert!(read("voice-a-on-head.lsw").join(cut("voices/vox-voice.vox.lsw"), None).is_err());
}
