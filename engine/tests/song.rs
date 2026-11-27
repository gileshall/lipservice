// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The song reader against tests/songs.json: songs, and what the reader makes of each (as data,
//! or its refusal word for word). web/perform_test.mjs holds the page's reader to the same file.
use lipservice::json::Json;
use lipservice::song;

#[test]
fn songs_read_as_the_file_says() {
    let text = std::fs::read_to_string(format!("{}/tests/songs.json", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let cases = Json::parse(&text).unwrap();
    let cases = cases.arr().unwrap();
    assert!(cases.len() >= 60);
    for c in cases {
        let (name, text) = (c.get("name").unwrap().str().unwrap(), c.get("text").unwrap().str().unwrap());
        match (song::read(text), c.get("refused")) {
            (Err(e), Ok(want)) => assert_eq!(e.0, want.str().unwrap(), "{name}"),
            (Ok(s), Err(_)) => assert_eq!(Json::parse(&s.json()).unwrap(), *c.get("song").unwrap(), "{name}"),
            (Ok(_), Ok(want)) => panic!("{name}: read, the file says refused: {}", want.str().unwrap()),
            (Err(e), Err(_)) => panic!("{name}: refused, the file says read: {}", e.0),
        }
    }
}
