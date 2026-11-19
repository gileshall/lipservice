// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A song streamed against the whole-song path (sing, Sharpen::apply, louden, ring, then
//! Vocoder::render): the same samples, bit for bit, however the frames are fed.

use lipservice::dsp::HOP;
use lipservice::front::Phonemizer;
use lipservice::g2p::G2p;
use lipservice::lexicon::Lexicon;
use lipservice::rng::Rng;
use lipservice::score::ScoreModel;
use lipservice::sharpen::Sharpen;
use lipservice::sing::{louden, plan, ring, sing, Held, Motion, Song, Style};
use lipservice::stream::{Render, Stream};
use lipservice::vocoder::{Vocoder, N_ENV};
use lipservice::weights::Weights;

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

const SONG: &str = "# a test\nbpm 120\nrest 0.5\nhum D3:2\nW F#3:0.5 E3:0.5 D3:0.5\nrest 1\nO A3:0.5\nR F#3:1\nT D4:2\nrest 0.25\n";
const SHORT: &str = "bpm 150\nsing A3:1\nsong C4:2+D4:1\n";

fn style(seed: u64) -> Style {
    Style { shift: 12.0, vibrato: 0.25, vibrato_hz: 5.5, vibrato_delay: 0.25, vibrato_ramp: 0.2, glide: 9, dynamics: 0.0, consonants: 1.0, breathiness: 1.0, diction: false, motion: None, motion_scale: 1.0, seed }
}

fn motion() -> Motion {
    let note = |k: f32| (0..60).map(|i| 0.3 * (i as f32 * 0.4 + k).sin()).collect::<Vec<f32>>();
    Motion::new(vec![Held { heads: vec![note(0.0), note(1.0)], tails: vec![note(2.0)] }]).unwrap()
}

fn check(score: &str, voc: &str, sharpen: bool) {
    let (m, v) = (ScoreModel::load(&read(score)).unwrap(), Vocoder::load(&read(voc)).unwrap());
    let sh = sharpen.then(|| {
        let mu = Rng::new(3).gaussian(m.speakers() * N_ENV).iter().map(|v| 0.5 * v).collect();
        Sharpen::new(mu, vec![1.0; m.speakers()], 1.3, 1.0, 1.0).unwrap()
    });
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let variants: Vec<(&str, &str, Style, Option<f32>)> = vec![
        ("plain", SONG, style(0), None),
        ("dressed", SONG, Style { dynamics: 1.0, breathiness: 0.4, consonants: 1.3, ..style(5) }, Some(3.0)),
        ("diction and ring 0", SONG, Style { diction: true, shift: 0.0, ..style(9) }, Some(0.0)),
        ("motion", SHORT, Style { motion: Some(motion()), dynamics: 0.5, ..style(2) }, None),
        ("short", SHORT, Style { vibrato: 0.0, glide: 0, ..style(1) }, Some(2.0)),
    ];
    for (name, text, st, ringdb) in &variants {
        let song = Song::parse(text).unwrap();
        let seed = st.seed;
        let mut whole = sing(&m, &mut ph, &song, 0, st).unwrap();
        let f = &mut whole.score.frames;
        if let Some(sh) = &sh {
            f.env = sh.apply(0, &f.env);
        }
        louden(&mut f.env, &whole.gain);
        if let Some(db) = ringdb {
            ring(&mut f.env, &whole.sung, *db);
        }
        let want = v.render(f, &Rng::new(seed).gaussian(f.len() * HOP)).unwrap();
        for step in [1, 2, 7, 50, 100000] {
            let p = plan(&m, &mut ph, &song, 0, st).unwrap();
            assert_eq!(p.durations, whole.score.durations);
            let mut s = Stream::sung(&m, Render::Voc(&v), p, 0, *ringdb, seed, sh.as_ref()).unwrap();
            let mut got = Vec::new();
            while !s.done() {
                assert!(s.fed() < s.frames() || got.len() < want.len(), "stalled at {}", got.len());
                s.step(step, &mut got);
            }
            assert_eq!(got.len(), want.len(), "{score} {name} step {step}");
            let (lf0, vuv) = s.pitch();
            for (i, (a, b)) in lf0.iter().zip(&whole.score.frames.lf0).enumerate() {
                assert_eq!(a.to_bits(), b.to_bits(), "{name} lf0 frame {i}");
            }
            assert_eq!(vuv, &whole.score.frames.vuv[..], "{name} voicing");
            let bad: Vec<usize> = (0..want.len()).filter(|&k| got[k].to_bits() != want[k].to_bits()).collect();
            if !bad.is_empty() {
                let d = got.iter().zip(&want).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
                panic!("{score} {name} step {step}: {} samples differ, {} to {} of {}, max {d}", bad.len(), bad[0], bad[bad.len() - 1], want.len());
            }
            println!("{score} {name} step {step}: {} samples", got.len());
        }
    }
}

#[test]
fn sung_stream_matches_whole_float() {
    check("score-a.lsw", "voc-a.lsw", false);
}

#[test]
fn sung_stream_matches_whole_int8() {
    check("score-a-i8.lsw", "voc-a-i8.lsw", false);
}

#[test]
fn sung_stream_matches_whole_sharpened_int8() {
    check("score-a-i8.lsw", "voc-a-i8.lsw", true);
}

#[test]
fn sung_stream_matches_whole_sharpened_float() {
    check("score-a.lsw", "voc-a.lsw", true);
}

/// A song picked up at a frame is the whole song's samples from there, bit for bit, and its pitch.
fn picked_up(score: &str, voc: &str, sharpen: bool) {
    let (m, v) = (ScoreModel::load(&read(score)).unwrap(), Vocoder::load(&read(voc)).unwrap());
    let sh = sharpen.then(|| {
        let mu = Rng::new(3).gaussian(m.speakers() * N_ENV).iter().map(|v| 0.5 * v).collect();
        Sharpen::new(mu, vec![1.0; m.speakers()], 1.3, 1.0, 1.0).unwrap()
    });
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let text = format!("bpm 120\n{}", "rest 0.5\nhum D3:2\nW F#3:0.5 E3:0.5 D3:0.5\nrest 1\nO A3:0.5\nR F#3:1\nT D4:2+E4:1\n".repeat(3));
    let song = Song::parse(&text).unwrap();
    for (st, ringdb) in [(style(0), None), (Style { dynamics: 1.0, breathiness: 0.4, consonants: 1.3, motion: Some(motion()), ..style(5) }, Some(3.0))] {
        let seed = st.seed;
        let p = plan(&m, &mut ph, &song, 0, &st).unwrap();
        let total = p.lf0.len();
        let mut s = Stream::sung(&m, Render::Voc(&v), p.tail(0), 0, ringdb, seed, sh.as_ref()).unwrap();
        let mut want = Vec::new();
        while !s.done() {
            s.step(100000, &mut want);
        }
        assert_eq!(want.len(), total * HOP);
        let (wl, wv) = (s.pitch().0.to_vec(), s.pitch().1.to_vec());
        let mut late = 0;
        for from in [0, 1, 9, 60, 131, total / 3, total / 2, total / 2 + 77, total - 40, total - 2, total] {
            for step in [1, 7, 100000] {
                let mut s = Stream::sung_from(&m, Render::Voc(&v), &p, 0, ringdb, seed, sh.as_ref(), from).unwrap();
                let mut got = Vec::new();
                while !s.done() {
                    s.step(step, &mut got);
                }
                let b = s.base();
                assert!(b <= from && s.frames() == total - b);
                late += (b > 0) as usize;
                assert!(s.pitch().0 == &wl[b..] && s.pitch().1 == &wv[b..], "{score} from {from} step {step}: pitch");
                let w = &want[from * HOP..];
                assert_eq!(got.len(), w.len(), "{score} from {from} step {step}");
                let bad: Vec<usize> = (0..w.len()).filter(|&k| got[k].to_bits() != w[k].to_bits()).collect();
                assert!(bad.is_empty(), "{score} from {from} step {step} (base {b}): {} samples differ, {} to {} of {}", bad.len(), bad[0], bad[bad.len() - 1], w.len());
            }
        }
        assert!(late >= 12, "{late} streams started late");
        println!("{score} sharpen {sharpen} seed {seed}: {total} frames");
    }
    let p = plan(&m, &mut ph, &song, 0, &style(0)).unwrap();
    assert!(Stream::sung_from(&m, Render::Voc(&v), &p, 0, None, 0, sh.as_ref(), p.lf0.len() + 1).is_err());
}

#[test]
fn song_picked_up_float() {
    picked_up("score-a.lsw", "voc-a.lsw", false);
}

#[test]
fn song_picked_up_sharpened_int8() {
    picked_up("score-a-i8.lsw", "voc-a-i8.lsw", true);
}
