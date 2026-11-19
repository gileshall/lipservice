// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A passage said a part at a time: each part the stream of that part alone, its seed and pitch
//! seed moved by its index, the breaks between them ramped silence (passage::gap), bit for bit.

use lipservice::dsp::SR;
use lipservice::front::Phonemizer;
use lipservice::g2p::G2p;
use lipservice::inflect::Inflection;
use lipservice::lexicon::Lexicon;
use lipservice::melvoc::MelVoc;
use lipservice::passage::{cut, gap, Passage};
use lipservice::pitchflow::{PitchFlow, Sampling, Widen, WIDEN};
use lipservice::score::{Pitch, ScoreModel};
use lipservice::ssml::{self, Piece};
use lipservice::stream::{Render, Stream};
use lipservice::vocoder::Vocoder;
use lipservice::weights::Weights;

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn same(want: &[f32], got: &[f32], what: &str) {
    assert_eq!(got.len(), want.len(), "{what}");
    let bad = want.iter().zip(got).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
    assert_eq!(bad, 0, "{what}: {bad} samples differ");
}

#[test]
fn parts_are_their_streams() {
    let score = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let voc = Vocoder::load(&read("voc-a-i8.lsw")).unwrap();
    let mel = MelVoc::load(read("melvoc-h-i8.lsw")).unwrap();
    let flow = PitchFlow::load(&read("pitch-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let texts: [(Vec<Piece>, usize); 4] = [
        (ssml::plain("Is this the same?").unwrap(), 1),
        (ssml::plain("One two three.\n\nIs it four?\n\nFive").unwrap(), 3),
        (ssml::pieces("<speak><p>One <emphasis>two</emphasis>.</p><p>Three,<break time=\"2s\"/>four.<break time=\"1s\"/></p></speak>").unwrap(), 2),
        (ssml::pieces("<speak><s>One.</s><break time=\"1200ms\"/><prosody rate=\"slow\">Two</prosody>.</speak>").unwrap(), 2),
    ];
    for (render, name) in [(Render::Voc(&voc), "vocoder"), (Render::mel(&mel, None), "mel route")] {
        for pitch in [Pitch::Flow(&flow, Sampling { seed: 5, widen: Some(Widen { by: WIDEN, centre: 4.9 }), ..Default::default() }), Pitch::Head] {
            for (pieces, n) in &texts {
                let parts = cut(pieces);
                assert_eq!(parts.len(), *n);
                let mut want: Vec<f32> = Vec::new();
                for (k, (ms, p)) in parts.into_iter().enumerate() {
                    let mut y = Vec::new();
                    let inf = Inflection::new(&mut ph, p).unwrap();
                    let pk = match pitch {
                        Pitch::Flow(f, s) => Pitch::Flow(f, Sampling { seed: s.seed + k as u64, ..s }),
                        Pitch::Head => Pitch::Head,
                    };
                    let mut st = Stream::inflected(&score, render, &inf, 0, 1.1, -1.0, pk, 7 + k as u64, None).unwrap();
                    while !st.done() {
                        st.step(100000, &mut y);
                    }
                    if k > 0 {
                        want.extend(gap((ms * SR as f32 / 1000.0).round() as usize, want[want.len() - 1], y[0]));
                    }
                    want.extend(y);
                }
                for step in [1, 7, 100000] {
                    let mut st = Passage::new(&score, render, &mut ph, pieces, 0, 1.1, -1.0, pitch, 7, None, None, 1.0).unwrap();
                    assert_eq!(st.parts(), *n);
                    let mut got = Vec::new();
                    while !st.done() {
                        st.step(step, &mut got).unwrap();
                    }
                    assert_eq!(st.part(), n - 1);
                    same(&want, &got, &format!("{name}, {n} parts, step {step}"));
                }
            }
        }
    }
}

#[test]
fn gaps_ramp() {
    let g = gap(1000, 0.5, -0.25);
    assert_eq!(g.len(), 1000);
    assert!((g[0] - 0.5).abs() < 0.5 * 1e-3 && (g[999] + 0.25).abs() < 0.25 * 1e-3);
    assert!(g[191..=808].iter().all(|&v| v.abs() < 1e-4) && g[200..800].iter().all(|&v| v == 0.0));
    let step = |a: &[f32]| a.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
    assert!(step(&[&[0.5][..], &g, &[-0.25]].concat()) < 0.5 * std::f32::consts::PI / 192.0);
}
