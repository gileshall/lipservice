// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Streaming against the whole-utterance path: the same samples, bit for bit, however the
//! frames are fed.

use lipservice::dsp::HOP;
use lipservice::front::Phonemizer;
use lipservice::g2p::G2p;
use lipservice::lexicon::Lexicon;
use lipservice::pitchflow::{PitchFlow, Sampling, Solver, Widen, WIDEN};
use lipservice::rng::Rng;
use lipservice::score::{semitones, Pitch, ScoreModel};
use lipservice::sharpen::Sharpen;
use lipservice::stream::{Render, Stream};
use lipservice::vocoder::{Vocoder, N_ENV};
use lipservice::weights::Weights;

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// With `flow`, the pitch from that flow file drawn as `draw` asks (its seed aside); with
/// `sharpen`, the envelope sharpened about a made-up mean shape.
fn check(score: &str, voc: &str, flow: Option<&str>, sharpen: bool) {
    check_drawn(score, voc, flow, Sampling::default(), sharpen)
}

fn check_drawn(score: &str, voc: &str, flow: Option<&str>, draw: Sampling, sharpen: bool) {
    let (s, v) = (ScoreModel::load(&read(score)).unwrap(), Vocoder::load(&read(voc)).unwrap());
    let f = flow.map(|p| PitchFlow::load(&read(p)).unwrap());
    let sh = sharpen.then(|| {
        let mu = Rng::new(3).gaussian(s.speakers() * N_ENV).iter().map(|v| 0.5 * v).collect();
        Sharpen::new(mu, vec![1.0; s.speakers()], 1.3, 1.0, 1.0).unwrap()
    });
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    for (text, rate, shift, seed) in [("Streaming should change nothing, not one sample.", 1.0, 0.0, 0), ("Hi.", 1.3, 2.0, 7)] {
        let tok = ph.encode(text).unwrap();
        let pitch = match &f {
            Some(f) => Pitch::Flow(f, Sampling { seed, ..draw }),
            None => Pitch::Head,
        };
        let mut sc = s.infer(&tok, 0, rate, shift, pitch).unwrap();
        if let Some(sh) = &sh {
            sc.frames.env = sh.apply(0, &sc.frames.env);
        }
        let want = v.render(&sc.frames, &Rng::new(seed).gaussian(sc.frames.len() * HOP)).unwrap();
        for step in [1, 2, 7, 50, 100000] {
            let mut st = Stream::new(&s, Render::Voc(&v), &tok, 0, rate, shift, pitch, seed, sh.as_ref()).unwrap();
            assert_eq!(st.durations(), &sc.durations[..]);
            let mut got = Vec::new();
            let mut first = None;
            while !st.done() {
                assert!(st.fed() < st.frames() || got.len() < want.len(), "stalled at {}", got.len());
                st.step(step, &mut got);
                first.get_or_insert_with(|| (!got.is_empty()).then_some(st.fed()));
                if first == Some(None) {
                    first = None;
                }
            }
            assert_eq!(got.len(), want.len(), "{score} step {step}");
            let (lf0, vuv) = st.pitch();
            for (i, (a, b)) in lf0.iter().zip(&sc.frames.lf0).enumerate() {
                assert_eq!(a.to_bits(), b.to_bits(), "lf0 frame {i} of {}", lf0.len());
            }
            assert_eq!(vuv, &sc.frames.vuv[..]);
            let bad: Vec<usize> = (0..want.len()).filter(|&k| got[k].to_bits() != want[k].to_bits()).collect();
            if !bad.is_empty() {
                let m = got.iter().zip(&want).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
                panic!("{score} {text:?} step {step}: {} samples differ, {} to {} of {}, max {m}", bad.len(), bad[0], bad[bad.len() - 1], want.len());
            }
            println!("{score} {flow:?} {text:?} step {step}: {} samples, first audio after {} of {} frames", got.len(), first.flatten().unwrap(), st.frames());
        }
    }
}

#[test]
fn stream_matches_whole_float() {
    check("score-a.lsw", "voc-a.lsw", None, false);
}

#[test]
fn stream_matches_whole_flow_float() {
    check("score-a.lsw", "voc-a.lsw", Some("pitch-a.lsw"), false);
}

#[test]
fn stream_matches_whole_flow_int8() {
    check("score-a-i8.lsw", "voc-a-i8.lsw", Some("pitch-a-i8.lsw"), false);
}

#[test]
fn stream_matches_whole_flow_both_solvers() {
    for solver in [Solver::Euler, Solver::Midpoint] {
        let draw = Sampling { solver, steps: 3, ..Default::default() };
        check_drawn("score-a-i8.lsw", "voc-a-i8.lsw", Some("pitch-a-i8.lsw"), draw, false);
    }
}

#[test]
fn stream_matches_whole_flow_widened() {
    let draw = Sampling { widen: Some(Widen { by: WIDEN, centre: 4.9 }), ..Default::default() };
    check_drawn("score-a-i8.lsw", "voc-a-i8.lsw", Some("pitch-a-i8.lsw"), draw, false);
}

#[test]
fn widening_scales_log_f0_about_the_shifted_centre() {
    let s = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let f = PitchFlow::load(&read("pitch-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let tok = ph.encode("Widening keeps the voicing and the centre.").unwrap();
    let (centre, shift) = (4.9, 2.0);
    let plain = s.infer(&tok, 0, 1.0, shift, Pitch::Flow(&f, Sampling { seed: 3, ..Default::default() })).unwrap();
    let draw = Sampling { seed: 3, widen: Some(Widen { by: WIDEN, centre }), ..Default::default() };
    let wide = s.infer(&tok, 0, 1.0, shift, Pitch::Flow(&f, draw)).unwrap();
    assert_eq!(wide.frames.vuv, plain.frames.vuv);
    let c = centre + semitones(shift);
    let mut moved = 0;
    for (i, (w, p)) in wide.frames.lf0.iter().zip(&plain.frames.lf0).enumerate() {
        assert!((w - c - WIDEN * (p - c)).abs() < 1e-5, "frame {i}: {w} from {p}");
        moved += ((w - p).abs() > 1e-3) as usize;
    }
    assert!(moved * 2 > plain.frames.lf0.len(), "{moved} of {} frames moved", plain.frames.lf0.len());
}

#[test]
fn stream_matches_whole_int8() {
    check("score-a-i8.lsw", "voc-a-i8.lsw", None, false);
}

#[test]
fn stream_matches_whole_sharpened_int8() {
    check("score-a-i8.lsw", "voc-a-i8.lsw", Some("pitch-a-i8.lsw"), true);
}

#[test]
fn stream_matches_whole_sharpened_float() {
    check("score-a.lsw", "voc-a.lsw", None, true);
}
