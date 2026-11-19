// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The front end against testdata/front.tsv.

use lipservice::front::words_and_stops;

#[test]
fn front_cases() {
    let cases = std::fs::read_to_string(format!("{}/testdata/front.tsv", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let mut bad = 0;
    let mut n = 0;
    for line in cases.lines().filter(|l| !l.starts_with('#')) {
        let (text, want) = line.split_once('\t').unwrap();
        let text = text.replace("\\n", "\n");
        n += 1;
        let got = match words_and_stops(&text) {
            Ok(w) => {
                assert!(w.iter().all(|t| !t.is_empty() && !t.contains(' ')), "a word with a space in {w:?}");
                w.join(" ")
            }
            Err(_) => "!error".into(),
        };
        if got != want {
            bad += 1;
            println!("FAIL {text:?}\n  want {want}\n  got  {got}");
        }
    }
    println!("{}/{n} cases", n - bad);
    assert_eq!(bad, 0);
}
