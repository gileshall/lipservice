// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! GEMM throughput, f32 and int8: cargo run --release --example gemm
use lipservice::nn::{gelu_slice, Linear};
use std::time::Instant;

fn bench(label: &str, l: &Linear, t: usize) {
    let x: Vec<f32> = (0..t * l.cin).map(|i| ((i * 104729) % 1000) as f32 * 1e-3 - 0.5).collect();
    let mut y = vec![0.0; t * l.cout];
    l.forward(&x, t, &mut y);
    let reps = 50;
    let t0 = Instant::now();
    for _ in 0..reps {
        l.forward(&x, t, &mut y);
    }
    let dt = t0.elapsed().as_secs_f64() / reps as f64;
    println!("{label} {t}x{}x{}: {:.3} ms, {:.1} GMAC/s", l.cin, l.cout, dt * 1e3, (t * l.cin * l.cout) as f64 / dt / 1e9);
}

fn main() {
    let t = 731;
    for &(cin, cout) in &[(384, 1152), (1152, 384), (256, 1026)] {
        let w: Vec<f32> = (0..cin * cout).map(|i| ((i * 7919) % 1000) as f32 * 1e-3 - 0.5).collect();
        let b = vec![0.1; cout];
        bench("f32 ", &Linear::new(&w, &b, cout, cin), t);
        let q: Vec<i8> = w.iter().map(|v| (v * 254.0) as i8).collect();
        bench("int8", &Linear::new_i8(&q, &vec![1.0 / 254.0; cout], &b, cout, cin).unwrap(), t);
    }
    let mut y: Vec<f32> = (0..t * 1152).map(|i| (i % 1000) as f32 / 250.0 - 2.0).collect();
    let reps = 50;
    let t0 = Instant::now();
    for _ in 0..reps {
        gelu_slice(&mut y);
        std::hint::black_box(&y);
    }
    let dt = t0.elapsed().as_secs_f64() / reps as f64;
    println!("gelu {} values: {:.3} ms, {:.2} ns each", y.len(), dt * 1e3, dt * 1e9 / y.len() as f64);
}
