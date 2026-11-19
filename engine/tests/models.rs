// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The score model and the G2P against PyTorch: testdata/{score,g2p}-test.lsw.

use lipservice::g2p::{G2p, PHONES};
use lipservice::pitchflow::{PitchFlow, Sampling, Solver};
use lipservice::score::{Pitch, ScoreModel};
use lipservice::weights::Weights;

fn snr_db(want: &[f32], got: &[f32]) -> f64 {
    assert_eq!(want.len(), got.len());
    let s: f64 = want.iter().map(|v| (*v as f64).powi(2)).sum();
    let e: f64 = want.iter().zip(got).map(|(a, b)| (*a as f64 - *b as f64).powi(2)).sum();
    10.0 * (s / e.max(1e-30)).log10()
}

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn ids(v: &[f32]) -> Vec<usize> {
    v.iter().map(|&x| x as usize).collect()
}

#[test]
fn score_matches_torch() {
    score_against("score-a.lsw", "score-test.lsw", 80.0, 70.0);
}

/// Int8 layers against torch's simulation of them.
#[test]
fn score_int8_matches_simulation() {
    score_against("score-a-i8.lsw", "score-test-i8.lsw", 80.0, 45.0);
}

fn score_against(weights: &str, test: &str, enc_db: f64, out_db: f64) {
    let m = ScoreModel::load(&read(weights)).unwrap();
    let t = read(test);
    let tok = ids(&t.get("tokens").unwrap().data);
    let n = tok.len();
    let h = m.encode(&tok, 0).unwrap();
    let s = snr_db(&t.get("encoded").unwrap().data, &h);
    println!("{weights}: encoded {s:.1} dB");
    assert!(s > enc_db);
    let logd = m.log_durations(&h, n);
    let s = snr_db(&t.get("logd").unwrap().data, &logd);
    println!("logd {s:.1} dB");
    assert!(s > enc_db);
    let out = m.infer(&tok, 0, 1.0, 0.0, Pitch::Head).unwrap();
    assert_eq!(out.durations, ids(&t.get("dur").unwrap().data));
    let plf0: Vec<f32> = out.frames.lf0.iter().map(|v| (v - 5.0) / 0.5).collect();
    for (name, got) in [("plf0", &plf0), ("env", &out.frames.env), ("bap", &out.frames.bap)] {
        let s = snr_db(&t.get(name).unwrap().data, got);
        println!("{name} {s:.1} dB");
        assert!(s > out_db, "{name} {s:.1} dB");
    }
    let pv = &t.get("pv").unwrap().data;
    let flips = pv.iter().zip(&out.frames.vuv).filter(|(p, v)| (**p > 0.0) != (**v > 0.5)).count();
    assert_eq!(flips, 0);
}

#[test]
fn pitch_matches_torch() {
    pitch_against("pitch-a.lsw", "pitch-test.lsw", 70.0, 60.0);
}

#[test]
fn pitch_int8_matches_simulation() {
    pitch_against("pitch-a-i8.lsw", "pitch-test-i8.lsw", 45.0, 35.0);
}

/// The first velocity (one Euler step from the same noise) and the whole sample.
fn pitch_against(weights: &str, test: &str, v_db: f64, x_db: f64) {
    let f = PitchFlow::load(&read(weights)).unwrap();
    let t = read(test);
    let (h, dur, x0) = (&t.get("h").unwrap().data, ids(&t.get("dur").unwrap().data), &t.get("x0").unwrap().data);
    let steps = t.get("steps").unwrap().data[0] as usize;
    let one = f.sample_from(h, &dur, x0, &Sampling { solver: Solver::Euler, steps: 1, ..Default::default() }).unwrap();
    let v: Vec<f32> = one.iter().zip(x0).map(|(a, b)| a - b).collect();
    let s = snr_db(&t.get("v0").unwrap().data, &v);
    println!("{weights}: first velocity {s:.1} dB");
    assert!(s > v_db, "first velocity {s:.1} dB");
    let x = f.sample_from(h, &dur, x0, &Sampling { solver: Solver::Euler, steps, ..Default::default() }).unwrap();
    let want = &t.get("sample").unwrap().data;
    let lf0: (Vec<f32>, Vec<f32>) = (0..x.len() / 2).map(|i| (want[2 * i], x[2 * i])).unzip();
    let s = snr_db(&lf0.0, &lf0.1);
    let flips = (0..x.len() / 2).filter(|&i| (want[2 * i + 1] > 0.0) != (x[2 * i + 1] > 0.0)).count();
    let near = (0..x.len() / 2).map(|i| want[2 * i + 1].abs()).fold(f32::INFINITY, f32::min);
    println!("{weights}: {steps}-step sample, log F0 {s:.1} dB, {flips} voicing flips of {} frames (closest to the line {near:.4})", x.len() / 2);
    assert!(s > x_db, "log F0 {s:.1} dB");
    assert_eq!(flips, 0);
}

#[test]
fn g2p_matches_torch() {
    g2p_against("g2p.lsw", "g2p-test.lsw", 80.0);
}

#[test]
fn g2p_int8_matches_simulation() {
    g2p_against("g2p-i8.lsw", "g2p-test-i8.lsw", 40.0);
}

fn g2p_against(weights: &str, test: &str, db: f64) {
    let m = G2p::load(&read(weights)).unwrap();
    let t = read(test);
    let mut i = 0;
    while t.has(&format!("{i}.src")) {
        let src = ids(&t.get(&format!("{i}.src")).unwrap().data);
        let mem = m.memory(&src);
        let s = snr_db(&t.get(&format!("{i}.memory")).unwrap().data, &mem);
        let l = m.step(&mem, src.len(), &[1]);
        let sl = snr_db(&t.get(&format!("{i}.logits0")).unwrap().data, &l);
        let word: String = src.iter().map(|&c| lipservice::g2p::LETTERS.as_bytes()[c - 3] as char).collect();
        let want: Vec<&str> = ids(&t.get(&format!("{i}.phones")).unwrap().data).iter().map(|&p| PHONES[p - 3]).collect();
        let got = m.phones(&word).unwrap();
        println!("{word}: memory {s:.1} dB, logits {sl:.1} dB, {}", got.join(" "));
        assert!(s > db && sl > db);
        assert_eq!(got, want);
        i += 1;
    }
    assert!(i > 0);
}

/// Greedy decoding with each step from scratch: phones() keeps keys and values instead.
fn phones_recomputed(m: &G2p, word: &str) -> Vec<&'static str> {
    let src = G2p::encode_word(word).unwrap();
    let mem = m.memory(&src);
    let mut ys = vec![1];
    for _ in 0..40 {
        let l = m.step(&mem, src.len(), &ys);
        let (best, _) = l.iter().enumerate().fold((0, f32::NEG_INFINITY), |a, (i, &v)| if v > a.1 { (i, v) } else { a });
        if best == 2 {
            break;
        }
        ys.push(best);
    }
    ys[1..].iter().map(|&p| PHONES[p - 3]).collect()
}

#[test]
fn g2p_cache_changes_nothing() {
    let dict = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/cmudict.dict")).unwrap();
    let words: Vec<&str> = dict.lines().map(|l| l.split(' ').next().unwrap()).filter(|w| G2p::encode_word(w).is_ok()).step_by(97).collect();
    for f in ["g2p.lsw", "g2p-i8.lsw"] {
        let m = G2p::load(&read(f)).unwrap();
        for w in &words {
            assert_eq!(m.phones(w).unwrap(), phones_recomputed(&m, w), "{f} {w}");
        }
        println!("{f}: {} words the same", words.len());
    }
}
