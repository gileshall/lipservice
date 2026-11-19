// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The break model against PyTorch: testdata/breaks-a[-i8]-test.lsw.

use lipservice::breaks::Breaks;
use lipservice::score::TextEncoder;
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

fn against(weights: &str, test: &str, enc_db: f64, out_db: f64) {
    let ws = read(weights);
    let t = read(test);
    let tok: Vec<usize> = t.get("tokens").unwrap().data.iter().map(|&x| x as usize).collect();
    let h = TextEncoder::load(&ws, "enc").unwrap().forward(&tok).unwrap();
    let s = snr_db(&t.get("encoded").unwrap().data, &h);
    println!("{weights}: encoded {s:.1} dB");
    assert!(s > enc_db);
    let got = Breaks::load(&ws).unwrap().logits(&tok).unwrap();
    let want = &t.get("logits").unwrap().data;
    let s = snr_db(want, &got);
    println!("logits {s:.1} dB");
    assert!(s > out_db);
}

#[test]
fn breaks_match_torch() {
    against("breaks-a.lsw", "breaks-a-test.lsw", 80.0, 70.0);
}

/// Int8 layers against torch's simulation of them.
#[test]
fn breaks_int8_match_simulation() {
    against("breaks-a-i8.lsw", "breaks-a-i8-test.lsw", 45.0, 40.0);
}

#[test]
fn cuts_follow_the_rate() {
    let b = Breaks::load(&read("breaks-a-i8.lsw")).unwrap();
    let (lo, hi) = (b.cut(0.02).unwrap(), b.cut(0.10).unwrap());
    assert!(lo > hi, "a smaller share needs a higher logit: {lo} {hi}");
    assert!(b.cut(0.0).is_err());
    assert!(b.cut(0.9).is_err());
}
