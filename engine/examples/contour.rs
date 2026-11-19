// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A sentence's planned pitch, inflection included, semitones about its voiced median, a token
//! at a time: cargo run --release --example contour VOICE.lsw G2P.lsw LEXICON.lsw TEXT|SSML [SEED]
use lipservice::front::{self, Phonemizer};
use lipservice::g2p::G2p;
use lipservice::inflect::{self, Inflection};
use lipservice::lexicon::Lexicon;
use lipservice::pitchflow::Sampling;
use lipservice::score::Pitch;
use lipservice::ssml;
use lipservice::voice::Voice;
use lipservice::weights::Weights;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let v = Voice::load(Weights::read(&a[1]).unwrap(), None).unwrap();
    let mut ph = Phonemizer::new(
        Lexicon::load(&Weights::read(&a[3]).unwrap()).unwrap(),
        G2p::load(&Weights::read(&a[2]).unwrap()).unwrap(),
    )
    .unwrap();
    let seed = a.get(5).map_or(0, |s| s.parse().unwrap());
    let pieces = if a[4].starts_with("<speak") {
        ssml::pieces(&a[4])
    } else {
        ssml::plain(&a[4])
    }
    .unwrap();
    let inf = Inflection::new(&mut ph, &pieces).unwrap();
    let tok = &inf.tokens;
    let pitch = match &v.flow {
        Some(f) => Pitch::Flow(
            f,
            Sampling {
                seed,
                ..Default::default()
            },
        ),
        None => Pitch::Head,
    };
    let (s, _) = inflect::infer(&v.score, &inf, 0, 1.0, 0.0, pitch).unwrap();
    let f = &s.frames;
    let mut voiced: Vec<f32> = (0..f.len())
        .filter(|&i| f.vuv[i] > 0.5)
        .map(|i| f.lf0[i])
        .collect();
    voiced.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let med = voiced[voiced.len() / 2];
    let st = |l: f32| (l - med) * 12.0 / std::f32::consts::LN_2;
    let mut at = 0;
    for (&t, &d) in tok.iter().zip(&s.durations) {
        let row: Vec<String> = (at..at + d)
            .filter(|&i| f.vuv[i] > 0.5)
            .map(|i| format!("{:+.1}", st(f.lf0[i])))
            .collect();
        println!("{:>4} {:>3} {}", front::symbol(t), d, row.join(" "));
        at += d;
    }
}
