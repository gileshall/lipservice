// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Sharpening against its reference in PyTorch, and a row at a time against the whole.

use lipservice::sharpen::{Sharpen, RADIUS};
use lipservice::vocoder::N_ENV;
use lipservice::weights::Weights;

fn read() -> Weights {
    Weights::read(&format!("{}/testdata/sharpen-test.lsw", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn max_diff(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}

#[test]
fn matches_python() {
    let ws = read();
    let (env, mu) = (&ws.get("env").unwrap().data, ws.get("mu").unwrap().data.clone());
    for (want, widen, time, chan, frames) in [("want", 1.3, 1.0, 1.0, 300), ("want2", 1.7, 0.5, 2.0, 300), ("want_short", 1.3, 1.0, 1.0, 3)] {
        let sh = Sharpen::new(mu.clone(), vec![1.0], widen, time, chan).unwrap();
        let got = sh.apply(0, &env[..frames * N_ENV]);
        let d = max_diff(&got, &ws.get(want).unwrap().data);
        println!("{want}: max difference {d}");
        assert!(d < 1e-4, "{want}: max difference {d}");
    }
}

#[test]
fn rows_match_whole() {
    let ws = read();
    let (env, mu) = (&ws.get("env").unwrap().data, ws.get("mu").unwrap().data.clone());
    let sh = Sharpen::new(mu, vec![1.0], 1.3, 1.0, 1.0).unwrap();
    let t = env.len() / N_ENV;
    let whole = sh.apply(0, env);
    for step in [1, 2, 5, 64] {
        let mut got = Vec::new();
        let mut a = 0;
        while a < t {
            let b = (a + step).min(t);
            let lo = a.saturating_sub(RADIUS);
            let hi = (b + RADIUS).min(t);
            sh.rows(0, &env[lo * N_ENV..hi * N_ENV], lo, a, b, t, &mut got);
            a = b;
        }
        let bad = got.iter().zip(&whole).filter(|(x, y)| x.to_bits() != y.to_bits()).count();
        assert_eq!(bad, 0, "step {step}: {bad} values differ");
    }
}

#[test]
fn refuses_a_speaker_without_a_shape() {
    let sh = Sharpen::new(vec![0.0; 2 * N_ENV], vec![10.0, 0.0], 1.3, 1.0, 1.0).unwrap();
    assert!(sh.check(0).is_ok());
    assert!(sh.check(1).is_err());
    assert!(sh.check(2).is_err());
}
