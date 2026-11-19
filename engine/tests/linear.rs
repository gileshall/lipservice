// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! One row at a time through a Linear: the same bits as the row in a batch.

use lipservice::nn::Linear;
use lipservice::rng::Rng;

fn check(m: &Linear, rows: usize, rng: &mut Rng) {
    let x = rng.gaussian(rows * m.cin);
    let mut all = vec![0.0; rows * m.cout];
    m.forward(&x, rows, &mut all);
    for r in 0..rows {
        let mut one = vec![0.0; m.cout];
        m.forward(&x[r * m.cin..(r + 1) * m.cin], 1, &mut one);
        let same = one.iter().zip(&all[r * m.cout..(r + 1) * m.cout]).all(|(a, b)| a.to_bits() == b.to_bits());
        assert!(same, "int8 {} {}x{} row {r}", m.is_int8(), m.cout, m.cin);
    }
}

#[test]
fn one_row_matches_batch() {
    let mut rng = Rng::new(3);
    for (cout, cin) in [(72, 256), (256, 1024), (1024, 256), (16, 8), (5, 12)] {
        let w = rng.gaussian(cout * cin);
        let b = rng.gaussian(cout);
        check(&Linear::new(&w, &b, cout, cin), 7, &mut rng);
        let q: Vec<i8> = w.iter().map(|v| (v * 40.0).round().clamp(-127.0, 127.0) as i8).collect();
        let s: Vec<f32> = (0..cout).map(|o| 0.01 + o as f32 * 1e-4).collect();
        check(&Linear::new_i8(&q, &s, &b, cout, cin).unwrap(), 7, &mut rng);
    }
}
