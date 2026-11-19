// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Where the score model's time goes: cargo run --release --example score_profile
use lipservice::nn::gelu;
use lipservice::score::{Pitch, ScoreModel};
use lipservice::weights::Weights;
use std::time::Instant;

fn main() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let name = std::env::args().nth(1).unwrap_or("score-a.lsw".into());
    let m = ScoreModel::load(&Weights::read(&format!("{dir}/testdata/{name}")).unwrap()).unwrap();
    let tok: Vec<usize> = (0..90).map(|i| 10 + (i * 37) % 69).collect();
    let reps = 20;
    let t0 = Instant::now();
    let mut frames = 0;
    for _ in 0..reps {
        frames = m.infer(&tok, 0, 1.0, 0.0, Pitch::Head).unwrap().frames.len();
    }
    let total = t0.elapsed().as_secs_f64() / reps as f64;
    let h = m.encode(&tok, 0).unwrap();
    let t = Instant::now();
    for _ in 0..reps {
        std::hint::black_box(m.encode(&tok, 0).unwrap());
    }
    let enc = t.elapsed().as_secs_f64() / reps as f64;
    let d: usize = 384;
    let hx: Vec<f32> = (0..frames).flat_map(|i| h[(i % 90) * 256..(i % 90 + 1) * 256].to_vec()).collect();
    let t = Instant::now();
    for _ in 0..reps {
        std::hint::black_box(m.pitch(&hx, frames));
    }
    let pitch = t.elapsed().as_secs_f64() / reps as f64;
    let (lf0, vuv) = (vec![5.0f32; frames], vec![1.0f32; frames]);
    let t = Instant::now();
    for _ in 0..reps {
        std::hint::black_box(m.decode(&hx, &lf0, &vuv));
    }
    let dec = t.elapsed().as_secs_f64() / reps as f64;
    let mut g: Vec<f32> = (0..frames * d * 3).map(|i| (i % 1000) as f32 / 250.0 - 2.0).collect();
    let t = Instant::now();
    for _ in 0..reps {
        for v in g.iter_mut() {
            *v = gelu(*v);
        }
        std::hint::black_box(&g);
    }
    let gl = t.elapsed().as_secs_f64() / reps as f64;
    let secs = frames as f64 * 0.01;
    println!("{frames} frames ({secs:.2} s): total {:.1} ms rtf {:.4}", total * 1e3, total / secs);
    println!("encode {:.2} ms, pitch {:.2} ms, decode {:.2} ms; one decoder block's gelu {:.2} ms (x6 in decode, pitch has 4 at 2/3 size)", enc * 1e3, pitch * 1e3, dec * 1e3, gl * 1e3);
}
