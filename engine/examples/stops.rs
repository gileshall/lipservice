// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Each line's plan a token at a time, for measuring what a voice does at its stops: line, token,
//! symbol, frames, then the voiced frames' pitch in semitones about the line's voiced median.
//! Given a break model, phrased at RATE of the word gaps; at the voice's pace, or PACE.
//! cargo run --release --example stops VOICE.lsw G2P.lsw LEXICON.lsw [BASE.lsw|-] [BREAKS.lsw RATE|- -] [PACE] < LINES
use lipservice::breaks::Breaks;
use lipservice::front::{self, Phonemizer};
use lipservice::g2p::G2p;
use lipservice::inflect::{self, Inflection};
use lipservice::lexicon::Lexicon;
use lipservice::pitchflow::Sampling;
use lipservice::score::Pitch;
use lipservice::ssml;
use lipservice::voice::Voice;
use lipservice::weights::Weights;
use std::io::BufRead;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mut ws = Weights::read(&a[1]).unwrap();
    if ws.needs_base() {
        ws = ws.on_base(&Weights::read(&a[4]).unwrap()).unwrap();
    }
    let phrase = (a.len() > 5 && a[5] != "-").then(|| (Breaks::load(&Weights::read(&a[5]).unwrap()).unwrap(), a[6].parse::<f32>().unwrap()));
    let v = Voice::load(ws, None).unwrap();
    let pace = if a.len() > 7 { a[7].parse::<f32>().unwrap() } else { v.pace };
    let mut ph = Phonemizer::new(
        Lexicon::load(&Weights::read(&a[3]).unwrap()).unwrap(),
        G2p::load(&Weights::read(&a[2]).unwrap()).unwrap(),
    )
    .unwrap();
    for (n, line) in std::io::stdin().lock().lines().enumerate() {
        let line = line.unwrap();
        let pieces = if line.starts_with("<speak") {
            ssml::pieces(&line)
        } else {
            ssml::plain(&line)
        }
        .unwrap();
        let mut inf = Inflection::new(&mut ph, &pieces).unwrap();
        if let Some((b, r)) = &phrase {
            inf.phrase(b, *r).unwrap();
        }
        inf.pace = pace;
        let pitch = match &v.flow {
            Some(f) => Pitch::Flow(f, Sampling { seed: 0, ..Default::default() }),
            None => Pitch::Head,
        };
        let (s, _) = inflect::infer(&v.score, &inf, 0, 1.0, 0.0, pitch).unwrap();
        let f = &s.frames;
        let mut voiced: Vec<f32> = (0..f.len()).filter(|&i| f.vuv[i] > 0.5).map(|i| f.lf0[i]).collect();
        voiced.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let med = voiced[voiced.len() / 2];
        let mut at = 0;
        for (k, (&t, &d)) in inf.tokens.iter().zip(&s.durations).enumerate() {
            let row: Vec<String> = (at..at + d)
                .filter(|&i| f.vuv[i] > 0.5)
                .map(|i| format!("{:.2}", (f.lf0[i] - med) * 12.0 / std::f32::consts::LN_2))
                .collect();
            println!("{n}\t{k}\t{}\t{d}\t{}", front::symbol(t), row.join(" "));
            at += d;
        }
    }
}
