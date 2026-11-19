// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Each tensor's name, shape and type: cargo run --release --example lsw_shapes FILE.lsw [PREFIX]
use lipservice::weights::Weights;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let ws = Weights::read(&a[1]).unwrap();
    let mut names: Vec<String> = ws.names().cloned().collect();
    names.sort();
    for n in names.iter().filter(|n| a.len() < 3 || n.starts_with(&a[2])) {
        let t = ws.get(n).unwrap();
        println!("{n}\t{:?}\t{}", t.shape, if t.q.is_empty() { "f32" } else { "i8" });
    }
}
