// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The packed lexicon against the dictionary it was packed from: testdata/lexicon.lsw, packed from
//! testdata/cmudict.dict with the project's own entries and fixes.

use lipservice::front::Phonemizer;
use lipservice::g2p::G2p;
use lipservice::lexicon::Lexicon;
use lipservice::weights::Weights;
use std::collections::BTreeMap;

fn read_dict(path: &str) -> BTreeMap<Vec<u8>, Vec<String>> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut first = BTreeMap::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap().trim();
        if line.is_empty() {
            continue;
        }
        let mut it = line.split_whitespace();
        let head = it.next().unwrap();
        let word = match head.rfind('(') {
            Some(k) if head.ends_with(')') => &head[..k],
            _ => head,
        };
        first.entry(word.as_bytes().to_vec()).or_insert_with(|| it.map(String::from).collect());
    }
    first
}

/// CMU's dictionary, the words it lacks and the words it has wrong, as the lexicons were packed from.
fn dict() -> BTreeMap<Vec<u8>, Vec<String>> {
    let mut d = read_dict(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/cmudict.dict"));
    for (w, p) in read_dict(concat!(env!("CARGO_MANIFEST_DIR"), "/../train/lexicon.dict")) {
        assert!(d.insert(w.clone(), p).is_none(), "{} is in both", String::from_utf8_lossy(&w));
    }
    for (w, p) in read_dict(concat!(env!("CARGO_MANIFEST_DIR"), "/../train/lexicon-fixes.dict")) {
        let was = d.insert(w.clone(), p.clone()).unwrap_or_else(|| panic!("{} is not in CMU's", String::from_utf8_lossy(&w)));
        assert_ne!(was, p, "{} already said so", String::from_utf8_lossy(&w));
    }
    d
}

#[test]
fn lexicon_matches_dictionary() {
    let lex = Lexicon::load(&Weights::read(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/lexicon.lsw")).unwrap()).unwrap();
    let d = dict();
    assert_eq!(lex.len(), d.len());
    let entries = lex.entries();
    for ((w, p), (dw, dp)) in entries.iter().zip(&d) {
        assert_eq!(w.as_bytes(), dw.as_slice());
        assert_eq!(p, dp);
    }
    for (w, p) in &d {
        let w = std::str::from_utf8(w).unwrap();
        assert_eq!(lex.get(w).map(|v| v.iter().map(|s| s.to_string()).collect::<Vec<_>>()).as_ref(), Some(p), "{w}");
        // neighbours that are not words: a letter more and a letter less
        for probe in [format!("{w}q"), w[..w.len() - 1].to_string()] {
            assert_eq!(lex.get(&probe).is_some(), d.contains_key(probe.as_bytes()), "{probe}");
        }
    }
    for absent in ["", "\u{1}", "zzzzzzzzzz", "~"] {
        assert_eq!(lex.get(absent), None);
    }
    println!("{} words", lex.len());
}

/// testdata/lexicon-g2p-i8.lsw, pruned against testdata/g2p-i8.lsw: every word
/// with no phones comes from that G2P as the dictionary has it; every word, through the
/// Phonemizer, as the dictionary has it.
#[test]
fn pruned_lexicon_gives_the_dictionary() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let lex = Lexicon::load(&Weights::read(&format!("{dir}/testdata/lexicon-g2p-i8.lsw")).unwrap()).unwrap();
    let g2p_ws = Weights::read(&format!("{dir}/testdata/g2p-i8.lsw")).unwrap();
    assert_eq!(lex.g2p(), Some(g2p_ws.digest));
    let d = dict();
    assert_eq!(lex.len(), d.len());
    let entries = lex.entries();
    let mut left = Vec::new();
    for ((w, p), (dw, dp)) in entries.iter().zip(&d) {
        assert_eq!(w.as_bytes(), dw.as_slice());
        if p.is_empty() {
            left.push((w.clone(), dp.clone()));
        } else {
            assert_eq!(p, dp, "{w}");
        }
    }
    let g2p = G2p::load(&g2p_ws).unwrap();
    let check = |part: &[(String, Vec<String>)]| {
        for (w, want) in part {
            assert_eq!(&g2p.phones(w).unwrap(), want, "{w}");
        }
    };
    // one thread where there are no others to spawn (wasm)
    let threads = std::thread::available_parallelism().unwrap().get();
    if threads == 1 {
        check(&left);
    } else {
        std::thread::scope(|s| {
            for part in left.chunks(left.len().div_ceil(threads)) {
                s.spawn(move || check(part));
            }
        });
    }
    let mut ph = Phonemizer::new(lex, G2p::load(&g2p_ws).unwrap()).unwrap();
    for (w, want) in d.iter().step_by(31) {
        let w = std::str::from_utf8(w).unwrap();
        if lipservice::front::is_lower(w) {
            assert_eq!(&ph.phones(w).unwrap(), want, "{w}");
        }
    }
    assert!(ph.guessed.is_empty());
    println!("{} of {} words from the G2P", left.len(), d.len());
}

#[test]
fn pruned_lexicon_refuses_another_g2p() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let lex = Lexicon::load(&Weights::read(&format!("{dir}/testdata/lexicon-g2p-i8.lsw")).unwrap()).unwrap();
    let g2p = G2p::load(&Weights::read(&format!("{dir}/testdata/g2p.lsw")).unwrap()).unwrap();
    let e = Phonemizer::new(lex, g2p).err().expect("a float G2P under a lexicon pruned for int8");
    assert!(e.0.contains("digest"), "{}", e.0);
}
