// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! How far a voice's pitch flow drawn in a few steps of each solver lands from one drawn in many,
//! from the same noise: RMS semitones over frames voiced in both, voicing disagreement, and the
//! voiced pitch's spread, a line of TEXT at a time over seeds:
//!   cargo run --release --example flow_steps VOICE.lsw G2P.lsw LEXICON.lsw SEEDS < TEXT
use lipservice::front::Phonemizer;
use lipservice::g2p::G2p;
use lipservice::inflect::{self, Inflection};
use lipservice::lexicon::Lexicon;
use lipservice::pitchflow::{Sampling, Solver};
use lipservice::score::Pitch;
use lipservice::ssml;
use lipservice::voice::Voice;
use lipservice::weights::Weights;
use std::io::BufRead;

const REF: usize = 64;
const RUNS: [(Solver, usize); 10] = [
    (Solver::Euler, 2),
    (Solver::Euler, 4),
    (Solver::Euler, 8),
    (Solver::Euler, 16),
    (Solver::Midpoint, 1),
    (Solver::Midpoint, 2),
    (Solver::Midpoint, 3),
    (Solver::Midpoint, 4),
    (Solver::Midpoint, 6),
    (Solver::Midpoint, 8),
];

fn st(l: f32) -> f32 {
    l * 12.0 / std::f32::consts::LN_2
}

fn spread(lf0: &[f32], vuv: &[f32]) -> f32 {
    let v: Vec<f32> = (0..lf0.len())
        .filter(|&i| vuv[i] > 0.5)
        .map(|i| st(lf0[i]))
        .collect();
    let m = v.iter().sum::<f32>() / v.len() as f32;
    (v.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / v.len() as f32).sqrt()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let v = Voice::load(Weights::read(&a[1]).unwrap(), None).unwrap();
    let flow = v.flow.as_ref().expect("the voice has no pitch flow");
    let mut ph = Phonemizer::new(
        Lexicon::load(&Weights::read(&a[3]).unwrap()).unwrap(),
        G2p::load(&Weights::read(&a[2]).unwrap()).unwrap(),
    )
    .unwrap();
    let seeds: u64 = a[4].parse().unwrap();
    // per run: squared semitones, frames, voicing disagreements, frames, spread sum, draws
    let mut acc = vec![(0.0f64, 0usize, 0usize, 0usize, 0.0f64, 0usize); RUNS.len()];
    let mut ref_spread = (0.0f64, 0usize);
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let inf = Inflection::new(&mut ph, &ssml::plain(&line).unwrap()).unwrap();
        for seed in 0..seeds {
            let draw = |solver, steps| {
                let s = Sampling {
                    solver,
                    steps,
                    temp: 1.0,
                    seed,
                    ..Default::default()
                };
                let (s, _) =
                    inflect::infer(&v.score, &inf, 0, 1.0, 0.0, Pitch::Flow(flow, s)).unwrap();
                s.frames
            };
            let r = draw(Solver::Midpoint, REF);
            ref_spread.0 += spread(&r.lf0, &r.vuv) as f64;
            ref_spread.1 += 1;
            for (k, &(solver, n)) in RUNS.iter().enumerate() {
                let d = draw(solver, n);
                assert_eq!(d.lf0.len(), r.lf0.len());
                let e = &mut acc[k];
                for i in 0..r.lf0.len() {
                    let (vr, vd) = (r.vuv[i] > 0.5, d.vuv[i] > 0.5);
                    e.2 += (vr != vd) as usize;
                    e.3 += 1;
                    if vr && vd {
                        let x = (st(d.lf0[i]) - st(r.lf0[i])) as f64;
                        e.0 += x * x;
                        e.1 += 1;
                    }
                }
                e.4 += spread(&d.lf0, &d.vuv) as f64;
                e.5 += 1;
            }
        }
    }
    println!("solver    steps  evals  rms st vs {REF}  voicing differs  spread st");
    println!(
        "{:<8}  {REF:>5}  {:>5}  {:>12}  {:>15}  {:>9.2}",
        "midpoint",
        2 * REF,
        "",
        "",
        ref_spread.0 / ref_spread.1 as f64
    );
    for (k, &(solver, n)) in RUNS.iter().enumerate() {
        let e = acc[k];
        let evals = if solver == Solver::Midpoint { 2 * n } else { n };
        println!(
            "{:<8}  {n:>5}  {evals:>5}  {:>12.2}  {:>14.1}%  {:>9.2}",
            format!("{solver:?}").to_lowercase(),
            (e.0 / e.1 as f64).sqrt(),
            100.0 * e.2 as f64 / e.3 as f64,
            e.4 / e.5 as f64
        );
    }
}
