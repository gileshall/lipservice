// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A song's tokens as sung: frames each, and the envelope's mean log power a frame, dB about the
//! loudest frame: cargo run --release --example sung_tokens VOICE.lsw G2P.lsw LEXICON.lsw SONG.txt
use lipservice::front::{self, Phonemizer};
use lipservice::g2p::G2p;
use lipservice::lexicon::Lexicon;
use lipservice::sing::{self, Song, Style};
use lipservice::vocoder::N_ENV;
use lipservice::voice::Voice;
use lipservice::weights::Weights;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let v = Voice::load(Weights::read(&a[1]).unwrap(), None).unwrap();
    let mut ph = Phonemizer::new(
        Lexicon::load(&Weights::read(&a[3]).unwrap()).unwrap(),
        G2p::load(&Weights::read(&a[2]).unwrap()).unwrap(),
    )
    .unwrap();
    let song = Song::parse(&std::fs::read_to_string(&a[4]).unwrap()).unwrap();
    let st = Style {
        shift: 0.0,
        vibrato: 0.25,
        vibrato_hz: 5.5,
        vibrato_delay: 0.25,
        vibrato_ramp: 0.2,
        glide: 9,
        dynamics: 0.0,
        consonants: 1.0,
        breathiness: 1.0,
        who: Default::default(),
        motion: None, motion_scale: 1.0,
        seed: 0,
    };
    let s = sing::sing(&v.score, &mut ph, &song, 0, &st).unwrap();
    let f = &s.score.frames;
    // the envelope is log power a band: a frame's mean, natural log to dB
    let db: Vec<f32> = f
        .env
        .chunks_exact(N_ENV)
        .map(|r| r.iter().map(|&e| e.exp()).sum::<f32>() / N_ENV as f32)
        .map(|p| 10.0 * p.log10())
        .collect();
    let top = db.iter().cloned().fold(f32::MIN, f32::max);
    let mut at = 0;
    for (&t, &d) in s.tokens.iter().zip(&s.score.durations) {
        let row: Vec<String> = db[at..at + d].iter().map(|x| format!("{:.0}", x - top)).collect();
        println!("{:>4} {:>3} {}", front::symbol(t), d, row.join(" "));
        at += d;
    }
}
