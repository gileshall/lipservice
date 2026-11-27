// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Singing: the notes' timing and pitch reach the frames.

use lipservice::diction::Rules;
use lipservice::front::Phonemizer;
use lipservice::g2p::G2p;
use lipservice::lexicon::Lexicon;
use lipservice::score::ScoreModel;
use lipservice::sing::{louden, midi, plan, ring, sing, Held, Lane, Motion, Song, Style, Voicing};
use lipservice::vocoder::{N_AP, N_ENV};
use lipservice::weights::Weights;

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn style(vibrato: f32) -> Style {
    Style { shift: 12.0, vibrato, vibrato_hz: 5.5, vibrato_delay: 0.25, vibrato_ramp: 0.2, glide: 9, dynamics: 0.0, consonants: 1.0, breathiness: 1.0, who: Default::default(), motion: None, motion_scale: 1.0, seed: 0 }
}

/// Every song's rules: PLAIN and SUNG, a singer's vowels.
fn sung_rules() -> Rules {
    Rules::default()
}

/// The song spoken: its vowels as the dictionary has them, a %diction spoken after its first line.
fn spoken(text: &str) -> Song {
    let (head, rest) = text.split_once('\n').unwrap();
    Song::parse(&format!("{head}\n%diction spoken\n{rest}")).unwrap()
}

/// A song under the sets plain and sung.
fn sung(text: &str) -> Song {
    Song::parse_under(text, sung_rules()).unwrap()
}

const SONG: &str = "# a test\n%bpm 120\n%rest 0.5\nhum D3:2\nW F#3:0.5 E3:0.5 D3:0.5\n%rest 1\nO A3:0.5\nR F#3:1\nT D4:2\n%rest 0.25\n";

#[test]
fn notes() {
    assert_eq!(midi("C4").unwrap(), 60.0);
    assert_eq!(midi("F#3").unwrap(), 54.0);
    assert_eq!(midi("Bb2").unwrap(), 46.0);
    assert_eq!(midi("61.5").unwrap(), 61.5);
    assert!(midi("H2").is_err() && midi("C").is_err() && midi("200").is_err());
}

#[test]
fn song_refusals() {
    assert!(Song::parse("hum D3:1\n").is_err()); // no bpm
    assert!(Song::parse("%bpm 90\nhum D3\n").is_err());
    assert!(Song::parse("%bpm 90\nhum D3:0\n").is_err());
    assert!(Song::parse("%bpm 90\n%bpm 80\nhum D3:1\n").is_err());
    assert!(Song::parse("%bpm 90\n%rest 1\n").is_err());
    assert!(Song::parse("%bpm 90\nhum D3:1+\n").is_err());
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let e = sing(&m, &mut ph, &Song::parse("%bpm 90\nhello C4:1\n").unwrap(), 0, &style(0.0)).err().unwrap();
    assert!(e.0.contains("2 syllables"), "{}", e.0);
    assert!(sing(&m, &mut ph, &Song::parse("%bpm 400\nstrengths C4:0.1\n").unwrap(), 0, &style(0.0)).is_err());
}

#[test]
fn vowels_on_the_beats_at_the_notes() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = Song::parse(SONG).unwrap();
    let flat = sing(&m, &mut ph, &song, 0, &style(0.0)).unwrap();
    let s = &flat.notes;
    // 50 frames a beat; the first vowel after its onset, every later one on its beat
    let beats = [0.0, 2.0, 2.5, 3.0, 4.5, 5.0, 6.0];
    let first = s[0].2.start;
    for ((w, m, r), b) in s.iter().zip(beats) {
        assert_eq!(r.start, first + (b * 50.0) as usize, "{w} {m}");
    }
    assert_eq!(s.iter().map(|x| x.1).collect::<Vec<_>>(), [62.0, 66.0, 64.0, 62.0, 69.0, 66.0, 74.0]);
    assert_eq!(s[6].2.end - s[6].2.start, 100); // the last note holds its two beats
    let f = &flat.score.frames;
    assert_eq!(flat.score.durations.iter().sum::<usize>(), f.lf0.len());
    for (w, n, r) in s {
        let mid = (r.start + r.end) / 2;
        let semi = (f.lf0[mid] - 440f32.ln()) * 12.0 / std::f32::consts::LN_2 + 69.0;
        assert!((semi - n).abs() < 0.01, "{w} {n}: {semi}");
    }
    assert_eq!(flat.vowel_frames, s.iter().map(|x| x.2.len()).sum::<usize>());
    assert!(s.iter().all(|x| x.2.clone().all(|i| f.vuv[i] == 1.0)));
    // hum's HH and T's T are sung unvoiced
    let (mut at, mut voiceless) = (0, 0);
    for (&t, &d) in flat.tokens.iter().zip(&flat.score.durations) {
        if ["HH", "T"].contains(&lipservice::front::symbol(t)) {
            assert!(f.vuv[at..at + d].iter().all(|&v| v == 0.0));
            voiceless += d;
        }
        at += d;
    }
    assert!(voiceless > 0 && voiceless == flat.voiceless_frames, "{voiceless} {}", flat.voiceless_frames);

    let vib = sing(&m, &mut ph, &song, 0, &style(0.5)).unwrap();
    let r = &vib.notes[6].2;
    let semi: Vec<f32> = vib.score.frames.lf0[r.clone()].iter().map(|l| (l - 440f32.ln()) * 12.0 / std::f32::consts::LN_2 + 69.0).collect();
    let (lo, hi) = semi[5..].iter().fold((f32::MAX, f32::MIN), |(a, b), &v| (a.min(v), b.max(v)));
    assert!(hi - 74.0 > 0.45 && 74.0 - lo > 0.45 && hi - 74.0 < 0.51 && 74.0 - lo < 0.51, "{lo} {hi}");
    assert!(semi[5..20].iter().all(|v| (v - 74.0).abs() < 0.01)); // none before the delay, the glide over
}

// a singer whose every note is a vibrato of `hz` and `depth` semitones, grown over its first 0.3 s,
// each note starting somewhere else in its cycle
fn singer(hz: f32, depth: f32) -> Held {
    let note = |len: usize, ph: f32, from: usize| -> Vec<f32> {
        (from..from + len).map(|i| depth * (i as f32 / 30.0).min(1.0) * (2.0 * std::f32::consts::PI * hz * i as f32 / 100.0 + ph).sin()).collect()
    };
    Held { heads: (0..9).map(|k| note(55 + 5 * k, k as f32 * 0.7, 0)).collect(), tails: (0..3).map(|k| note(45, k as f32 * 2.1, 40)).collect() }
}

#[test]
fn motion_in_place_of_vibrato() {
    let flat = |n: usize| Held { heads: vec![vec![0.3; n]], tails: vec![] };
    assert!(Motion::new(vec![]).is_err() && Motion::new(vec![Held::default()]).is_err());
    // a piece too short to fade, a singer with no note's start, one with nothing to carry a note on with
    assert!(Motion::new(vec![flat(29)]).is_err());
    assert!(Motion::new(vec![Held { heads: vec![], tails: vec![vec![0.0; 60]] }]).is_err());
    assert!(Motion::new(vec![flat(49)]).is_err() && Motion::new(vec![flat(50)]).is_ok());
    assert!(Motion::new(vec![Held { heads: vec![vec![f32::NAN; 60]], tails: vec![] }]).is_err());
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = Song::parse(SONG).unwrap();
    let plain = sing(&m, &mut ph, &song, 0, &style(0.0)).unwrap();
    let semis = |s: &lipservice::sing::Sung| -> Vec<f32> { s.score.frames.lf0.iter().map(|l| (l - 440f32.ln()) * 12.0 / std::f32::consts::LN_2 + 69.0).collect() };
    let base = semis(&plain);
    let mut sung = |singers: Vec<Held>, seed: u64, scale: f32| {
        let st = Style { motion: Some(Motion::new(singers).unwrap()), motion_scale: scale, seed, ..style(0.5) };
        let s = sing(&m, &mut ph, &song, 0, &st).unwrap();
        (s.notes.clone(), semis(&s))
    };
    // a motion off its note by a constant is centred away: the notes as sung with neither vibrato nor motion
    let (_, held) = sung(vec![flat(400)], 1, 1.0);
    for (f, (v, p)) in held.iter().zip(&base).enumerate() {
        assert!((v - p).abs() < 1e-3, "frame {f}: {v} against {p}");
    }
    // the vibrato (0.5) is gone: inside a note's fades it is the note and the singer's motion, centred
    let one = || vec![singer(5.0, 0.3)];
    let (notes, a) = sung(one(), 1, 1.0);
    let mut moved = 0;
    for (w, n, r) in &notes {
        for &v in &a[r.start + 10..r.end.saturating_sub(10).max(r.start + 10)] {
            assert!((v - n).abs() < 0.45, "{w} {n}: {v}");
            moved += ((v - n).abs() > 0.1) as usize;
        }
    }
    assert!(moved > 50, "{moved}");
    assert_eq!(sung(one(), 1, 1.0).1, a);
    assert!((2..8).any(|seed| sung(one(), seed, 1.0).1 != a));
    // its size: none of it is the plain notes, twice it is twice as far from them
    assert_eq!(sung(one(), 1, 0.0).1, base);
    for ((x, y), p) in sung(one(), 1, 2.0).1.iter().zip(&a).zip(&base) {
        assert!((x - p - 2.0 * (y - p)).abs() < 1e-3, "{x} {y} {p}");
    }
}

// the times a second the motion on a note's middle crosses the note upward
fn rate(semi: &[f32], note: f32) -> f32 {
    let ups = semi.windows(2).filter(|w| w[0] < note && w[1] >= note).count();
    ups as f32 * 100.0 / semi.len() as f32
}

#[test]
fn a_voice_keeps_one_singer() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    // notes longer than any the singers hold (95 frames at most): each is several joined
    let song = Song::parse("%bpm 60\nla A3:3\nla C4:4\nla D4:3\n").unwrap();
    let motion = Motion::new(vec![singer(4.5, 0.3), singer(6.5, 0.3)]).unwrap();
    let mut rates = |seed: u64, hz: f32| -> Vec<f32> {
        let st = Style { motion: Some(motion.clone()), seed, ..style(0.0) };
        let s = sing(&m, &mut ph, &song, 0, &st).unwrap();
        let semi: Vec<f32> = s.score.frames.lf0.iter().map(|l| (l - 440f32.ln()) * 12.0 / std::f32::consts::LN_2 + 69.0).collect();
        s.notes.iter().map(|(_, n, r)| {
            assert!(r.len() > 250, "{r:?}");
            let mid = &semi[r.start + 40..r.end - 15];
            // joined in phase: nowhere does the pitch bend more than a vibrato of this depth and rate can
            let bend = mid.windows(3).map(|w| (w[0] - 2.0 * w[1] + w[2]).abs()).fold(0.0, f32::max);
            assert!(bend < 0.3 * (2.0 * std::f32::consts::PI * hz / 100.0).powi(2) * 1.5, "seed {seed}: a bend of {bend} semitones");
            rate(mid, *n)
        }).collect()
    };
    // seeds in a row are singers in a row, and every note of a voice is its singer's
    for seed in 0..6 {
        let want = if seed % 2 == 0 { 4.5 } else { 6.5 };
        for r in rates(seed, want) {
            assert!((r - want).abs() < 0.5, "seed {seed}: a note at {r} a second, its singer's {want}");
        }
    }
}

#[test]
fn a_lane_is_written_on_the_beat() {
    let song = |lines: &str| Song::parse(&format!("%bpm 60\n{lines}")).unwrap();
    // none written: the voice's own all along
    let s = song("la A3:2\n");
    assert_eq!(s.vibrato, Lane::default());
    assert_eq!(s.vibrato.at(0.0), 1.0);
    // a jump holds; a glide starts where the line is and ends its beats on; the line takes no time
    let s = song("la A3:2\n%vibrato 0\nla A3:2 A3:1+B3:1\n%vibrato 2:2 2:1 0.5\nla A3:4\n");
    let at = |b: f32| s.vibrato.at(b);
    assert_eq!([at(0.0), at(1.99), at(2.0), at(5.0)], [1.0, 1.0, 0.0, 0.0]);
    assert_eq!([at(6.0), at(7.0), at(8.0), at(8.5), at(8.99), at(9.0), at(40.0)], [0.0, 1.0, 2.0, 2.0, 2.0, 0.5, 0.5]);
    // a line written while a glide is under way takes over from where the glide has got to
    let s = song("%vibrato 0 2:4\nla A3:1\n%vibrato 1:2\nla A3:6\n");
    assert_eq!([s.vibrato.at(0.5), s.vibrato.at(1.0), s.vibrato.at(2.0), s.vibrato.at(3.0), s.vibrato.at(4.0)], [0.25, 0.5, 0.75, 1.0, 1.0]);
    // in a rest it is where the rest has got to
    let s = song("la A3:1\n%rest 1\n%vibrato 0:2\n%rest 1\nla A3:1\n");
    assert_eq!([s.vibrato.at(2.0), s.vibrato.at(3.0), s.vibrato.at(4.0)], [1.0, 0.5, 0.0]);
    for bad in ["%vibrato\n", "%vibrato -1\n", "%vibrato 1:0\n", "%vibrato 1:-2\n", "%vibrato much\n", "%vibrato 1:\n", "%vibrato inf\n", "%vibrato nan:1\n"] {
        let e = Song::parse(&format!("%bpm 60\n{bad}la A3:2\n")).err().unwrap_or_else(|| panic!("{bad}"));
        assert!(e.0.starts_with("line 2: "), "{bad}: {}", e.0);
    }
}

#[test]
fn the_vibrato_follows_its_lane() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let semis = |s: &lipservice::sing::Sung| -> Vec<f32> { s.score.frames.lf0.iter().map(|l| (l - 440f32.ln()) * 12.0 / std::f32::consts::LN_2 + 69.0).collect() };
    let far = |x: &[f32], n: f32| x.iter().map(|v| (v - n).abs()).fold(0.0, f32::max);
    // the engine's vibrato, half a semitone: as sung, then none, then grown from none to twice it
    // over two beats (100 frames a beat) and held
    let lines = ["la A3:4\n", "la A3:4\n", "la A3:4\n"];
    let written = Song::parse(&format!("%bpm 60\n{}%vibrato 0\n{}%vibrato 0 2:2\n{}", lines[0], lines[1], lines[2])).unwrap();
    let s = sing(&m, &mut ph, &written, 0, &style(0.5)).unwrap();
    let v = semis(&s);
    let (a, b, c) = (&s.notes[0].2, &s.notes[1].2, &s.notes[2].2);
    assert_eq!((b.start - a.start, c.start - b.start), (400, 400));
    let n = s.notes[0].1;
    let d = far(&v[a.start + 50..a.end - 20], n);
    assert!(d > 0.45 && d < 0.51, "as sung: {d}");
    assert!(far(&v[b.start + 10..b.end], n) < 0.01, "none: {}", far(&v[b.start + 10..b.end], n));
    let d = far(&v[c.start..c.start + 100], n);
    assert!(d > 0.3 && d < 0.51, "a beat into the glide: {d}");
    let d = far(&v[c.start + 220..c.end - 20], n);
    assert!(d > 0.9 && d < 1.01, "twice: {d}");
    // the same notes with no lane, or with the voice's own written, are the notes as they were
    let plain = Song::parse(&format!("%bpm 60\n{}", lines.concat())).unwrap();
    let own = Song::parse(&format!("%bpm 60\n%vibrato 1\n{}", lines.concat())).unwrap();
    let (p, o) = (semis(&sing(&m, &mut ph, &plain, 0, &style(0.5)).unwrap()), semis(&sing(&m, &mut ph, &own, 0, &style(0.5)).unwrap()));
    assert_eq!(p.len(), v.len());
    // (the jump to none is eased over the glide's frames about its beat)
    assert!(p[..b.start - 5] == v[..b.start - 5]);
    assert!(p.iter().zip(&o).all(|(x, y)| (x - y).abs() < 1e-4));
}

#[test]
fn a_lane_sizes_a_singers_vibrato_and_keeps_the_drift() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let semis = |s: &lipservice::sing::Sung| -> Vec<f32> { s.score.frames.lf0.iter().map(|l| (l - 440f32.ln()) * 12.0 / std::f32::consts::LN_2 + 69.0).collect() };
    // singers of notes long enough to sing these whole: one drifting (half a cycle a second), one
    // drifting the same with a 5.5 Hz vibrato on it
    let note = |k: usize, vib: f32| -> Vec<f32> {
        (0..400).map(|i| {
            let t = i as f32 / 100.0;
            0.3 * (std::f32::consts::PI * t + k as f32).sin() + vib * (2.0 * std::f32::consts::PI * 5.5 * t + k as f32 * 0.7).sin()
        }).collect()
    };
    let singer = |vib: f32| Motion::new(vec![Held { heads: (0..5).map(|k| note(k, vib)).collect(), tails: vec![] }]).unwrap();
    let notes = "la A3:3\nla C4:3\nla D4:3\n";
    let mut sung = |lane: &str, vib: f32| {
        let song = Song::parse(&format!("%bpm 60\n{lane}{notes}")).unwrap();
        let s = sing(&m, &mut ph, &song, 0, &Style { motion: Some(singer(vib)), seed: 3, ..style(0.5) }).unwrap();
        (s.notes.clone(), semis(&s))
    };
    let (spans, drift) = sung("", 0.0);
    let (_, both) = sung("", 0.2);
    let (_, none) = sung("%vibrato 0\n", 0.2);
    let (_, twice) = sung("%vibrato 2\n", 0.2);
    let (mut gone, mut kept, mut drifted) = (0.0f32, 0.0f32, 0.0f32);
    for (_, n, r) in &spans {
        assert!(r.len() > 250, "{r:?}");
        for f in r.start + 30..r.end - 30 {
            gone = gone.max((both[f] - drift[f]).abs());
            kept = kept.max((none[f] - drift[f]).abs());
            drifted = drifted.max((drift[f] - n).abs());
            // twice the vibrato on the same drift
            assert!((twice[f] - none[f] - 2.0 * (both[f] - none[f])).abs() < 1e-3, "frame {f}");
        }
    }
    assert!(gone > 0.15, "the vibrato as sung: {gone}");
    assert!(drifted > 0.15, "the drift: {drifted}");
    assert!(kept < 0.04, "none of the vibrato, the drift kept: {kept}");
}

#[test]
fn consonants_scaled_but_closures() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = Song::parse(SONG).unwrap();
    let john = Song::parse("%bpm 90\njohn G4:2\n").unwrap();
    let mut of = |x: f32, sym: &str| {
        let song = if sym == "JH" { &john } else { &song };
        let s = sing(&m, &mut ph, song, 0, &Style { consonants: x, ..style(0.0) }).unwrap();
        let k = s.tokens.iter().position(|&t| lipservice::front::symbol(t) == sym).unwrap();
        s.score.durations[k]
    };
    let (hh, t) = (of(1.0, "HH"), of(1.0, "T"));
    assert_eq!(of(2.0, "HH"), 2 * hh);
    assert_eq!(of(2.0, "T"), t);
    let jh = of(1.0, "JH");
    assert_eq!(of(2.0, "JH"), jh);
    // lengthened consonants leave a vowel 8 frames (or half its note) on quick notes
    let quick = Song::parse("%bpm 240\nmerrily C5:1 C5:1 C5:1\nlife G4:2\nis F4:1\nstrengths E4:1\n").unwrap();
    for x in [4.0, 6.0] {
        let s = sing(&m, &mut ph, &quick, 0, &Style { consonants: x, ..style(0.0) }).unwrap();
        for (w, _, r) in &s.notes[..s.notes.len() - 1] {
            assert!(r.len() >= 8, "{x} {w}: {} frames", r.len());
        }
    }
}

#[test]
fn word_initial_consonants_keep_their_space() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let s = sing(&m, &mut ph, &spoken("%bpm 90\nrow C4:1\nso D4:1\na C4:1\nboat E4:2\n"), 0, &style(0.0)).unwrap();
    let sym: Vec<&str> = s.tokens.iter().map(|&t| lipservice::front::symbol(t)).collect();
    let at = |x: &str| sym.iter().position(|&y| y == x).unwrap();
    let d = &s.score.durations;
    assert!(d[at("B") - 1] > 0 && d[at("S") - 1] > 0, "{sym:?} {d:?}"); // the spaces before B and S
    assert_eq!(d[at("AH0") - 1], 0, "{sym:?} {d:?}"); // and none before a vowel
}

#[test]
fn a_voiced_stop_dips_and_rises_inside_a_phrase() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let s = sing(&m, &mut ph, &Song::parse("%bpm 90\nrow C4:1\nyour C4:1\nboat C4:2\n%rest 1\nboat C4:2\n").unwrap(), 0, &style(0.0)).unwrap();
    let sym: Vec<&str> = s.tokens.iter().map(|&t| lipservice::front::symbol(t)).collect();
    let d = &s.score.durations;
    let at: Vec<usize> = std::iter::once(0).chain(d.iter().scan(0, |a, &x| { *a += x; Some(*a) })).collect();
    let semi: Vec<f32> = s.score.frames.lf0.iter().map(|&l| (l - 440f32.ln()) * 12.0 / std::f32::consts::LN_2 + 69.0 - 72.0).collect();
    let bs: Vec<usize> = (0..sym.len()).filter(|&i| sym[i] == "B").collect();
    assert_eq!(bs.len(), 2, "{sym:?}");
    // after "your": the closure (the space and the stop) dips, its last frame is up, the vowel settles
    let (i, j) = (bs[0], bs[1]);
    assert!(d[i - 1] >= 3, "{sym:?} {d:?}");
    let low = semi[at[i - 1]..at[i + 1]].iter().cloned().fold(f32::MAX, f32::min);
    assert!((-2.75..-2.3).contains(&low), "{low}");
    assert!((semi[at[i + 1] - 1] - 1.55).abs() < 0.01, "{}", semi[at[i + 1] - 1]);
    assert!((semi[at[i + 1]] - 0.98).abs() < 0.01 && semi[at[i + 1] + 8].abs() < 0.01, "{:?}", &semi[at[i + 1]..at[i + 1] + 9]);
    // after a rest there is no sound to close on: the line as written
    assert!(semi[at[j - 1]..at[j + 1] + 9].iter().all(|x| x.abs() < 0.01), "{:?}", &semi[at[j - 1]..at[j + 1] + 9]);
}

#[test]
fn a_vowel_after_a_vowel_is_dipped_into() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let s = sing(&m, &mut ph, &spoken("%bpm 90\nhow C4:1\nI C4:1\n%rest 1\nI C4:2\n"), 0, &style(0.0)).unwrap();
    let sym: Vec<&str> = s.tokens.iter().map(|&t| lipservice::front::symbol(t)).collect();
    let d = &s.score.durations;
    let at: Vec<usize> = std::iter::once(0).chain(d.iter().scan(0, |a, &x| { *a += x; Some(*a) })).collect();
    let semi: Vec<f32> = s.score.frames.lf0.iter().map(|&l| (l - 440f32.ln()) * 12.0 / std::f32::consts::LN_2 + 69.0 - 72.0).collect();
    let is: Vec<usize> = (0..sym.len()).filter(|&i| sym[i] == "AY1").collect();
    assert_eq!(is.len(), 2, "{sym:?}");
    // after "how": the six frames before the vowel dip, 1.5 st at the most, and the vowel is on its note
    let b = at[is[0]];
    let low = semi[b - 6..b].iter().cloned().fold(f32::MAX, f32::min);
    assert!((-1.5..-1.3).contains(&low), "{:?}", &semi[b - 8..b + 2]);
    assert!(semi[b - 7].abs() < 0.01 && semi[b].abs() < 0.01, "{:?}", &semi[b - 8..b + 2]);
    // after a rest: as written
    let b = at[is[1]];
    assert!(semi[b - 6..b + 6].iter().all(|x| x.abs() < 0.01), "{:?}", &semi[b - 6..b + 6]);
}

#[test]
fn a_vowel_through_its_notes() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = Song::parse("%bpm 120\n%rest 0.5\nhum D3:1+E3:0.5+F#3:1.5\ngo G3:0.5\n%rest 0.5\n").unwrap();
    let s = sing(&m, &mut ph, &song, 0, &style(0.0)).unwrap();
    let n = &s.notes;
    assert_eq!(n.iter().map(|x| (x.0.as_str(), x.1)).collect::<Vec<_>>(), [("hum", 62.0), ("hum", 64.0), ("hum", 66.0), ("go", 67.0)]);
    let first = n[0].2.start;
    for (k, b) in [0.0, 1.0, 1.5].into_iter().enumerate() {
        assert_eq!(n[k].2.start, first + (b * 50.0) as usize, "note {k}");
    }
    assert_eq!(n[0].2.end, n[1].2.start);
    assert_eq!(n[1].2.end, n[2].2.start);
    assert_eq!(n[3].2.start, first + 150);
    let f = &s.score.frames;
    for (w, m, r) in &n[..3] {
        let mid = (r.start + r.end) / 2;
        let semi = (f.lf0[mid] - 440f32.ln()) * 12.0 / std::f32::consts::LN_2 + 69.0;
        assert!((semi - m).abs() < 0.01, "{w} {m}: {semi}");
    }
    assert!(sing(&m, &mut ph, &Song::parse("%bpm 120\nhum D3:1+E3:0.01\n").unwrap(), 0, &style(0.0)).is_err());
}

#[test]
fn dynamics() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = Song::parse(SONG).unwrap();
    let flat = sing(&m, &mut ph, &song, 0, &style(0.25)).unwrap();
    assert!(flat.gain.iter().all(|&g| g == 0.0));
    let s = sing(&m, &mut ph, &song, 0, &Style { dynamics: 1.0, ..style(0.25) }).unwrap();
    assert_eq!(s.gain.len(), s.score.frames.lf0.len());
    assert_eq!(s.score.frames.lf0, flat.score.frames.lf0);
    assert_eq!(s.score.frames.env, flat.score.frames.env); // the gain goes on after sharpening
    let at = |k: usize, x: f32| {
        let r = &s.notes[k].2;
        s.gain[r.start + (x * r.len() as f32) as usize]
    };
    // the phrase's highest note, D4 (its last), is up at its middle and falls away to its end
    assert!(at(6, 0.4) > 1.5, "{}", at(6, 0.4));
    assert!(at(6, 0.4) - at(6, 0.97) > 2.0, "{} {}", at(6, 0.4), at(6, 0.97));
    // in the first phrase hum D3 (two beats) swells
    assert!(at(0, 0.5) - at(0, 0.1) > 1.0, "{} {}", at(0, 0.5), at(0, 0.1));
    assert!(s.gain.iter().all(|g| g.abs() < 10.0));

    let mut env = vec![0.0; 2 * N_ENV];
    louden(&mut env, &[10.0, -10.0]);
    let k = std::f32::consts::LN_10 / 10.0;
    assert!((env[0] - 5.0 * k).abs() < 1e-5 && (env[N_ENV - 1] - 15.0 * k).abs() < 1e-5);
    assert!((env[N_ENV] + 5.0 * k).abs() < 1e-5 && (env[2 * N_ENV - 1] + 15.0 * k).abs() < 1e-5);
}

#[test]
fn ring_on_vowels() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let s = sing(&m, &mut ph, &Song::parse(SONG).unwrap(), 0, &style(0.25)).unwrap();
    assert_eq!(s.sung.len(), s.score.frames.lf0.len());
    assert!(s.sung.iter().all(|&v| (0.0..=1.0 + 1e-6).contains(&v)));
    for (_, _, r) in &s.notes {
        let mid = (r.start + r.end) / 2;
        assert!(s.sung[mid] > 0.99, "{}", s.sung[mid]);
    }

    // full on the first frame, half on the second, none on the third
    let mut env = vec![0.0; 3 * N_ENV];
    ring(&mut env, &[1.0, 0.5, 0.0], 10.0);
    let k = std::f32::consts::LN_10 / 10.0;
    let (c, top) = (0..N_ENV).map(|c| (c, env[c])).fold((0, f32::MIN), |a, b| if b.1 > a.1 { b } else { a });
    // the peak band is the one nearest 3 kHz (about band 47 of 80 on the mel scale to 12 kHz), 10 dB less a little
    assert!((44..=50).contains(&c), "{c}");
    assert!(top > 9.0 * k && top <= 10.0 * k, "{}", top / k);
    assert!(env[0].abs() < 1e-3 * k && env[N_ENV - 1].abs() < 0.5 * k, "{} {}", env[0] / k, env[N_ENV - 1] / k);
    for b in 0..N_ENV {
        assert!((env[N_ENV + b] - 0.5 * env[b]).abs() < 1e-6 && env[2 * N_ENV + b] == 0.0);
    }
}

#[test]
fn breathiness() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = Song::parse(SONG).unwrap();
    let a = sing(&m, &mut ph, &song, 0, &style(0.25)).unwrap();
    let b = sing(&m, &mut ph, &song, 0, &Style { breathiness: 0.25, ..style(0.25) }).unwrap();
    let (fa, fb) = (&a.score.frames, &b.score.frames);
    assert_eq!((&fa.env, &fa.lf0, &fa.vuv), (&fb.env, &fb.lf0, &fb.vuv));
    let mut held = vec![false; fa.lf0.len()];
    for (_, _, r) in &a.notes {
        held[r.clone()].iter_mut().for_each(|h| *h = true);
    }
    let (mut full, mut eased) = (0, 0);
    for (f, &h) in held.iter().enumerate() {
        let (x, y) = (&fa.bap[f * N_AP..(f + 1) * N_AP], &fb.bap[f * N_AP..(f + 1) * N_AP]);
        if !h {
            assert_eq!(x, y, "frame {f}, outside the vowels");
            continue;
        }
        let k = 1.0 - 0.75 * a.sung[f];
        x.iter().zip(y).for_each(|(&x, &y)| assert!((y - k * x).abs() < 1e-6, "frame {f}: {y} against {k} x {x}"));
        full += (a.sung[f] > 0.999) as usize;
        eased += (a.sung[f] < 0.9) as usize;
    }
    assert!(full > 50 && eased > 5, "{full} {eased}");
}

#[test]
fn diction() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let text = "%bpm 100\nthe C4:1\nwonder D4:1 E4:2\n%rest 0.5\n";
    let said = |s: &lipservice::sing::Sung| s.tokens.iter().map(|&t| lipservice::front::symbol(t)).collect::<Vec<_>>().join(" ");
    let plain = sing(&m, &mut ph, &spoken(text), 0, &style(0.0)).unwrap();
    let sung = sing(&m, &mut ph, &sung(text), 0, &style(0.0)).unwrap();
    assert!(said(&plain).contains("DH AH0   W AH1 N D ER0"), "{}", said(&plain));
    assert!(said(&sung).contains("DH AH1   W AH1 N D AH1 R"), "{}", said(&sung));
    // the R after a held vowel takes its own frames, and the notes keep their frames
    assert_eq!(plain.notes.iter().map(|n| n.2.start).collect::<Vec<_>>(), sung.notes.iter().map(|n| n.2.start).collect::<Vec<_>>());
}

#[test]
fn rests_are_silent() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = Song::parse("%bpm 120\n%rest 2\nhum D3:2\n%rest 4\nhum A3:2\n%rest 1\n").unwrap();
    let s = sing(&m, &mut ph, &song, 0, &style(0.0)).unwrap();
    let f = &s.score.frames;
    let power = |r: std::ops::Range<usize>| r.map(|i| f.env[i * N_ENV..(i + 1) * N_ENV].iter().map(|e| e.exp()).sum::<f32>()).fold(0.0f32, f32::max);
    let sung = s.notes.iter().map(|n| power(n.2.clone())).fold(0.0f32, f32::max);
    let mut at = 0;
    let mut pauses = 0;
    for (&t, &d) in s.tokens.iter().zip(&s.score.durations) {
        let sym = lipservice::front::symbol(t);
        if ["^", ",", "$"].contains(&sym) {
            // the lead-in silent from its start, a rest and the end after the voice's release
            let from = if sym == "^" { at } else { at + 8 };
            if from < at + d {
                assert!(power(from..at + d) < sung * 1e-6, "{sym} at {at}: {} of {sung}", power(from..at + d));
                assert!(f.vuv[from..at + d].iter().all(|&v| v == 0.0), "{sym} at {at} voiced");
                pauses += 1;
            }
        }
        at += d;
    }
    assert_eq!(pauses, 4);
}

#[test]
fn a_phrases_last_voiceless_consonant_ends_in_its_rest() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let p = plan(&m, &mut ph, &Song::parse("%bpm 120\nnight D3:2\n%rest 2\nhum A3:2\n%rest 2\npeace A3:2\n").unwrap(), 0, &style(0.0)).unwrap();
    let total: usize = p.durations.iter().sum();
    let mut at = 0;
    let mut seen = Vec::new();
    for (i, (&t, &d)) in p.tokens.iter().zip(&p.durations).enumerate() {
        let sym = lipservice::front::symbol(t);
        if i > 0 && [",", "$"].contains(&sym) {
            let before = lipservice::front::symbol(p.tokens[i - 1]);
            // after T and S the pause's first 12 frames sound, unvoiced; after M none does
            let n = if before == "M" { 0 } else { 12 };
            assert!(p.quiet[at..at + n].iter().all(|&q| q == 0.0), "{before}: {:?}", &p.quiet[at..at + n]);
            assert!(p.voicing[at..at + n].iter().all(|&v| v == Voicing::Voiceless), "{before}");
            assert!(p.quiet[at + n] > 0.0 && p.quiet[at + n] < 1.0, "{before}: {}", p.quiet[at + n]);
            assert!(p.quiet[at + n + 8..at + d.min(60)].iter().all(|&q| q == 80.0), "{before}");
            seen.push((before, d));
        }
        at += d;
    }
    assert_eq!(seen.iter().map(|s| s.0).collect::<Vec<_>>(), ["T", "M", "S"]);
    // the song ends after the last consonant's release
    assert_eq!(seen[2].1, 22);
    assert_eq!(at, total);
    // a singer breathes from the release's end
    let r = p.rests();
    let rest = |k: usize| (0..p.tokens.len()).filter(|&i| lipservice::front::symbol(p.tokens[i]) == ",").map(|i| p.durations[..i].iter().sum::<usize>()).nth(k).unwrap();
    assert_eq!((r[1].start, r[2].start), (rest(0) + 12, rest(1)));
}

#[test]
fn rests_where_a_singer_can_breathe() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    // 50 frames a beat, a lead of 10 frames before the song and after it
    let p = plan(&m, &mut ph, &Song::parse("%bpm 120\n%rest 1\n%rest 1\nhum D3:2\n%rest 4\nhum A3:2\nwe A3:1\n%rest 0.5\n%rest 0.5\n").unwrap(), 0, &style(0.0)).unwrap();
    let r = p.rests();
    let n = &p.notes;
    let total: usize = p.durations.iter().sum();
    assert_eq!(r.len(), 3, "{r:?}");
    // the lead-in to the first word's onset, the rest to the next onset, merged rests one span, the tail;
    // the first word's vowel on its beat, its onset out of the lead-in
    assert_eq!(n[0].2.start, 110);
    let onset = n[0].2.start - r[0].end;
    assert_eq!(r[0].start, 0);
    assert!(onset > 0 && r[1].start > n[0].2.end, "{r:?} {n:?}");
    let next = n[1].2.start - r[1].end; // the next word's onset, its space before it
    assert!(next > 0 && next <= 10, "{next}");
    assert_eq!(n[1].2.start - n[0].2.start, 300);
    assert_eq!(r[2].len(), 50);
    assert_eq!(r[2].end + 10, total);
    // each a lead-in or a rest of the plan's own
    let mut at = 0;
    let mut spans = Vec::new();
    for (&t, &d) in p.tokens.iter().zip(&p.durations) {
        if ["^", ","].contains(&lipservice::front::symbol(t)) {
            spans.push(at..at + d);
        }
        at += d;
    }
    assert_eq!(spans, r);
    // no rest written: the lead-in alone, less the first word's onset, its vowel on frame 10
    let p = plan(&m, &mut ph, &Song::parse("%bpm 120\nhum D3:2\nhum A3:2\n").unwrap(), 0, &style(0.0)).unwrap();
    assert_eq!(p.notes[0].2.start, 10);
    assert_eq!(p.rests(), vec![0..p.durations[0]]);
    assert!(p.durations[0] < 10, "{}", p.durations[0]);
}

#[test]
fn sung_together_a_word_has_one_length_and_starts_on_its_beat() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    // two parts with "sleeves" on the same beat (beat 5 of the second is beat 5 of the first), other words about it
    let a = "%bpm 120\n%together\ngreen D4:3\n%rest 2\nsleeves D4:2\nwas D4:1\n";
    let b = "%bpm 120\n%together\nla D4:1\nla D4:2\nmy D4:2\nsleeves D4:2\nall D4:1\n";
    let mut frames = |text: &str, speaker: usize| {
        let p = plan(&m, &mut ph, &Song::parse(text).unwrap(), speaker, &style(0.0)).unwrap();
        let mut at = 0;
        let mut s = Vec::new();
        for (&t, &d) in p.tokens.iter().zip(&p.durations) {
            if lipservice::front::symbol(t) == "S" {
                s.push((at, d));
            }
            at += d;
        }
        (p.notes.iter().map(|n| n.2.start).collect::<Vec<_>>(), s)
    };
    let (na, sa) = frames(a, 0);
    let (nb, sb) = frames(b, m.speakers() - 1);
    // the first word's vowel on its beat though it opens on consonants: frame 10, the lead-in
    assert_eq!(na[0], 10);
    assert_eq!(nb[0], 10);
    // "sleeves" on beat 5 of both: its vowel on the same frame, and its S from the same frame for as long
    assert_eq!(na[1], 10 + 250);
    assert_eq!(nb[3], 10 + 250);
    assert_eq!(sa[0], sb[0], "{sa:?} {sb:?}");
    // without the line each sings its own
    let plain = Song::parse(&a.replace("%together\n", "")).unwrap();
    assert!(!plain.together && Song::parse(a).unwrap().together);
}

#[test]
fn sung_together_a_short_note_keeps_a_third_for_its_vowel() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    // half beats at 100 to the minute, 30 frames each, on words heavy with consonants
    let p = plan(&m, &mut ph, &Song::parse("%bpm 100\n%together\nmore D4:1\nthan D4:0.5\ntext D4:0.5\nto D4:0.5\nspeech D4:2\n").unwrap(), 0, &style(0.0)).unwrap();
    for (word, _, span) in &p.notes[1..4] {
        assert!(span.len() >= 10, "{word}: a vowel of {} frames", span.len());
    }
}

#[test]
fn a_rest_is_silent_to_the_next_consonant() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = "%bpm 60\nla D4:2\n%rest 2\nshe D4:2\n%rest 2\nstrong D4:2\n%rest 2\nshule D4:2\n%rest 2\nthree D4:2\n%rest 2\ntwo D4:2\n%rest 2\npay D4:2\n%rest 2\nchew D4:2\n%rest 2\ndo D4:2\n%rest 2\nbow D4:2\n%rest 2\njoy D4:2\n%rest 2\nno D4:2\n%rest 2\nlove D4:2\n%rest 2\nzoo D4:2\n%rest 0.06\nfree D4:2\n";
    let p = plan(&m, &mut ph, &Song::parse(song).unwrap(), 0, &style(0.0)).unwrap();
    let sym: Vec<&str> = p.tokens.iter().map(|&t| lipservice::front::symbol(t)).collect();
    let (rests, mut at, mut seen, mut long, mut voiced, mut cut) = (p.rests(), 0, 0, 0, 0, 0);
    for i in 0..sym.len() {
        let d = p.durations[i];
        if sym[i] == " " && i > 0 && sym[i - 1] == "," {
            let rest = p.durations[i - 1];
            let q = &p.quiet[at..at + d];
            // the space a rest's next word opens with: a voiceless closure's silent but for its last 3
            // frames, a voiceless fricative's but for its last 8, a voiced consonant's sung, or where
            // it is over 14 frames silent to its last 14, risen over 8 of them and the last 6 sung
            let rise = match sym[i + 1] {
                "T" | "P" | "CH" => Some(d.min(3)),
                "SH" | "S" | "TH" | "F" => Some(d.min(8)),
                "D" | "B" | "JH" | "N" | "L" | "Z" => None,
                c => panic!("{c} after a rest"),
            };
            if let Some(rise) = rise {
                for (f, &v) in q[..d - rise].iter().enumerate() {
                    assert!(rest + f < 8 || v == 80.0, "{} frames into the silence before {}: {v} dB", rest + f, sym[i + 1]);
                }
                if rest >= 8 {
                    assert!(q[d - rise..].windows(2).all(|w| w[1] < w[0]) && q[d - rise..].iter().all(|&v| v > 0.0 && v < 80.0), "{q:?}");
                    assert_eq!(rests[1 + seen].end, at + d - rise);
                }
                long += (d > rise) as usize;
            } else if d > 14 {
                assert!(rest >= 8 && q[..d - 14].iter().all(|&v| v == 80.0), "before {}: {q:?}", sym[i + 1]);
                assert!(q[d - 14..d - 6].windows(2).all(|w| w[1] < w[0]) && q[d - 14..d - 6].iter().all(|&v| v > 0.0 && v < 80.0), "{q:?}");
                assert!(q[d - 6..].iter().all(|&v| v == 0.0), "{q:?}");
                assert_eq!(rests[1 + seen].end, at + d - 14);
                cut += 1;
            } else {
                assert!(d > 0 && q.iter().all(|&v| v == 0.0), "before {}: {q:?}", sym[i + 1]);
                assert_eq!(rests[1 + seen].end, at);
                assert_eq!(p.quiet[at - 1], 80.0);
                voiced += 1;
            }
            assert_eq!(p.quiet[at + d], 0.0);
            seen += 1;
        }
        at += d;
    }
    assert!(seen == 14 && voiced + cut == 6 && voiced >= 1 && cut >= 1 && long >= 1, "{seen} spaces after rests, {voiced} sung, {cut} sung from their last 14 frames, {long} silent for longer than their rise");
    // a space inside a phrase is as it was: sound
    let q = plan(&m, &mut ph, &Song::parse("%bpm 60\nla D4:2\nshe D4:2\n").unwrap(), 0, &style(0.0)).unwrap();
    let n = q.durations.iter().sum::<usize>();
    assert!(q.quiet[10..n - 10].iter().all(|&v| v == 0.0));
}

#[test]
fn a_voiceless_consonant_is_unvoiced_from_its_space() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = "%bpm 60\nla D4:2\nso D4:2\nfa D4:2\ntwo D4:2\nshe D4:2\nla D4:2\nno D4:2\n%rest 2\nsee D4:2\n";
    let p = plan(&m, &mut ph, &Song::parse(song).unwrap(), 0, &style(0.0)).unwrap();
    let sym: Vec<&str> = p.tokens.iter().map(|&t| lipservice::front::symbol(t)).collect();
    let (mut at, mut inside, mut begun, mut voiced, mut rested, mut consonant) = (0, 0, 0, 0, 0, 0);
    for i in 0..sym.len() {
        let d = p.durations[i];
        let v = &p.voicing[at..at + d];
        if sym[i] == " " {
            assert!(d > 0, "no space before {}", sym[i + 1]);
            match (sym[i + 1], sym[i - 1] == ",") {
                // the sound before runs 2 frames in, as the pitch head has it; unvoiced from there
                ("S" | "F" | "T" | "SH", false) => {
                    let k = d.min(2);
                    assert!(v[..k].iter().all(|&x| x == Voicing::Head) && v[k..].iter().all(|&x| x == Voicing::Begun), "before {}: {v:?}", sym[i + 1]);
                    inside += 1;
                    begun += d - k;
                }
                // after a rest there is none: silent, or unvoiced where it sounds
                ("S", true) => {
                    assert!(v.iter().all(|&x| x == Voicing::Silent || x == Voicing::Begun) && v[d - 1] == Voicing::Begun, "{v:?}");
                    rested += 1;
                }
                ("L" | "N", false) => {
                    assert!(v.iter().all(|&x| x == Voicing::Head), "before {}: {v:?}", sym[i + 1]);
                    voiced += 1;
                }
                (c, r) => panic!("a space before {c} (after a rest: {r})"),
            }
        }
        if ["S", "F", "T", "SH"].contains(&sym[i]) {
            assert!(d > 0 && v.iter().all(|&x| x == Voicing::Voiceless));
            consonant += 1;
        }
        assert!(v.iter().all(|x| x.vuv(1.0) == (matches!(x, Voicing::Head | Voicing::Vowel) as u8 as f32)));
        at += d;
    }
    assert_eq!((inside, voiced, rested, consonant), (4, 2, 1, 5));
    assert!(begun > 0, "no space inside the phrase over 2 frames");
}

#[test]
fn a_held_diphthong_is_sung_in_two() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    // at 60 a beat is 100 frames: "night" and "joy" held, "my" and the second "night" 20 frames, "now" held
    let text = "%bpm 60\nmy D4:0.2\nnight D4:2\n%rest 1\njoy D4:1+E4:1\nnight D4:0.2\nnow D4:2\n%rest 1\n";
    let p = plan(&m, &mut ph, &sung(text), 0, &style(0.0)).unwrap();
    let sym: Vec<&str> = p.tokens.iter().map(|&t| lipservice::front::symbol(t)).collect();
    assert_eq!(sym.join(" "), "^ M AY1   N AA1 AY1 T ,   JH AO1 OY1   N AY1 T   N AW1 , $");
    let at: Vec<usize> = std::iter::once(0).chain(p.durations.iter().scan(0, |a, &x| { *a += x; Some(*a) })).collect();
    let i = sym.iter().position(|s| *s == "AA1").unwrap();
    // the open vowel on its beat, the close the last 20 frames of the two, and the note is both
    assert_eq!(at[i], 10 + 20);
    assert_eq!(p.durations[i + 1], 20);
    assert_eq!(p.notes[1].2, at[i]..at[i + 2]);
    assert!(p.durations[i] > 150, "{:?}", &p.durations[i - 1..i + 3]);
    // a syllable's later note starts on its beat within the two, and its last note holds the close
    let j = sym.iter().position(|s| *s == "AO1").unwrap();
    assert_eq!(p.durations[j + 1], 20);
    assert_eq!(p.notes[2].2.start, at[j]);
    assert_eq!(p.notes[3].2, at[j] + 100..at[j + 2]);
    assert!(p.voicing[at[j]..at[j + 2]].iter().all(|v| *v == Voicing::Vowel));
    // every frame is some token's, as before
    assert_eq!(*at.last().unwrap(), p.lf0.len());
    // a short close for a short note: a third of the two
    let short = plan(&m, &mut ph, &sung("%bpm 60\nmy D4:0.24\n"), 0, &style(0.0)).unwrap();
    let s: Vec<&str> = short.tokens.iter().map(|&t| lipservice::front::symbol(t)).collect();
    assert_eq!(s.join(" "), "^ M AA1 AY1 $");
    assert_eq!((short.durations[2], short.durations[3]), (16, 8));
    // before an L or R an AY is left as the model sings it, an OY is not
    let liquid = plan(&m, &mut ph, &sung("%bpm 60\nI'll D4:1\nsmile D4:1\noil D4:1\n"), 0, &style(0.0)).unwrap();
    let s: Vec<&str> = liquid.tokens.iter().map(|&t| lipservice::front::symbol(t)).collect();
    assert_eq!(s.join(" "), "^ AY1 L   S M AY1 L   AO1 OY1 L $");
    // before another vowel the close is the firm one, which is heard there
    let into = plan(&m, &mut ph, &sung("%bpm 60\ndenial D4:0.5 D4:1 D4:1\n"), 0, &style(0.0)).unwrap();
    let s: Vec<&str> = into.tokens.iter().map(|&t| lipservice::front::symbol(t)).collect();
    assert_eq!(s.join(" "), "^ D IH1 N AA1 IY1 AH1 L $");
    // spoken
    let plain = plan(&m, &mut ph, &spoken(text), 0, &style(0.0)).unwrap();
    assert!(!plain.tokens.iter().any(|&t| ["AA1", "AO1"].contains(&lipservice::front::symbol(t))));
}

fn said(p: &lipservice::sing::Plan) -> String {
    p.tokens.iter().map(|&t| lipservice::front::symbol(t)).collect::<Vec<_>>().join(" ")
}

#[test]
fn a_words_phones_as_written() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let st = style(0.0);
    // the phones as written under the set sung or without it, a vowel without its digit stressed,
    // the close its written frames at the end of the vowel's note
    for under in [sung_rules(), Rules::default()] {
        let p = plan(&m, &mut ph, &Song::parse_under("%bpm 60\nmy D4:1\nnight{N,AA,~IH:70,T} D4:2\nvirgin{V,AH0,JH,IH,N} D4:1 D4:1\n%rest 1\n", under).unwrap(), 0, &st).unwrap();
        assert!(said(&p).ends_with("  N AA1 IH1 T   V AH0 JH IH1 N , $"), "{}", said(&p));
        let i = p.tokens.iter().position(|&t| lipservice::front::symbol(t) == "IH1").unwrap();
        assert_eq!(p.durations[i], 7);
        let at: usize = p.durations[..i - 1].iter().sum();
        assert_eq!(p.notes[1].2, at..at + p.durations[i - 1] + 7);
        assert_eq!(p.notes[1].0, "night");
    }
    // the written word is its own: the same line without the phones is the rule's
    let p = plan(&m, &mut ph, &sung("%bpm 60\nnight D4:2\nnight{N,AY,T} D4:2\n"), 0, &st).unwrap();
    // each token's rule: the set's stress and held AY (lines 1 and 3 after plain's one), none for what is written
    assert_eq!(p.by.iter().map(|b| b.0).collect::<Vec<_>>(), [None, None, Some(3), Some(3), None, None, None, None, None, None]);
    assert_eq!(said(&p), "^ N AA1 AY1 T   N AY1 T $");
    // the plan says which tokens are closes, and its words as planned are the words written so
    assert_eq!(p.closes.iter().map(|&c| c as u8).collect::<Vec<_>>(), [0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    let planned = lipservice::timing::planned(&p.tokens, &p.durations, &p.closes, &p.by, &["night".to_string(), "night".to_string()]).unwrap();
    assert!(planned.starts_with(r#"[{"word":"night","phones":[["N",0,"#) && planned.contains(r#"["AY1",1,"#) && planned.contains(",3,null]") && planned.matches("\"word\"").count() == 2, "{planned}");
    assert!(lipservice::timing::planned(&p.tokens, &p.durations, &p.closes, &p.by, &["night".to_string()]).is_err());
    // a close with no length: CLOSE frames, at most a third
    let p = plan(&m, &mut ph, &sung("%bpm 60\nmy{M,AA,~AY} D4:2\nmy{M,AA,~AY} D4:0.24\n"), 0, &st).unwrap();
    assert_eq!(said(&p), "^ M AA1 AY1   M AA1 AY1 $");
    assert_eq!((p.durations[3], p.durations[7]), (20, 8));
    // a word's rule for every such word of the song, a line's own phones over it
    let p = plan(&m, &mut ph, &sung("%bpm 60\n%diction word=night -> N AA ~IY T\nNight D4:2\nnight{N,AY,T} D4:2\nnight{N,EH,T} D4:2\n"), 0, &st).unwrap();
    assert_eq!(said(&p), "^ N AA1 IY1 T   N AY1 T   N EH1 T $");
    // a rule for one who sings
    let text = "%bpm 60\n%diction for=ada word=night -> N AO T\nnight D4:2\n";
    let ada = Style { who: lipservice::diction::Who { voice: Some("Ada".into()), ..Default::default() }, ..style(0.0) };
    assert_eq!(said(&plan(&m, &mut ph, &sung(text), 0, &ada).unwrap()), "^ N AO1 T $");
    assert_eq!(said(&plan(&m, &mut ph, &sung(text), 0, &st).unwrap()), "^ N AA1 AY1 T $");
    // before a rest and not
    let p = plan(&m, &mut ph, &spoken("%bpm 60\n%diction T place=last before=rest -> none\nnight D4:1\nnight D4:1\n%rest 1\nnight D4:1\n"), 0, &st).unwrap();
    assert_eq!(said(&p), "^ N AY1 T   N AY1 ,   N AY1 $");
    // the word "diction" is still a word
    assert!(plan(&m, &mut ph, &sung("%bpm 60\ndiction D4:1 D4:1\n"), 0, &st).is_ok());
}

#[test]
fn written_phones_refused() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    for (bad, why) in [
        ("night{N,AX,T} D4:2", "AX: not an ARPAbet phone"),
        ("night{N,aa,T} D4:2", "aa: not an ARPAbet phone"),
        ("night{N AA T} D4:2", "written in one piece"),
        ("night{N,AA,T D4:2", "written in one piece"),
        ("{N,AA,T} D4:2", "written in one piece"),
        ("night{} D4:2", "written in one piece"),
        ("night{N,AA,~T} D4:2", "~T: a close is a vowel"),
        ("night{~AY,N,T} D4:2", "straight after the vowel"),
        ("night{N,AA,T,~AY} D4:2", "straight after the vowel"),
        ("night{N,AA,~AY,~IY,T} D4:2", "straight after the vowel"),
        ("night{N,AA,~AY:75,T} D4:2", "75: ms in steps of 10"),
        ("night{N,AA,~AY:0,T} D4:2", "0: ms in steps of 10"),
        ("night{N,AA:70,T} D4:2", "only a close (~) takes a length"),
        ("%diction held 240", "the length is each rule's own"),
        ("%diction AY -> AA IY", "only a word given whole"),
        ("%diction sung loudly", "no ->"),
    ] {
        let e = Song::parse(&format!("%bpm 60\n{bad}\nla D4:1\n")).err().unwrap_or_else(|| panic!("{bad}"));
        assert!(e.0.starts_with("line 2: ") && e.0.contains(why), "{bad}: {}", e.0);
    }
    let st = style(0.0);
    // the written phones' vowels are the notes'
    let e = plan(&m, &mut ph, &Song::parse("%bpm 60\nnight{N,AA,IY,T} D4:2\n").unwrap(), 0, &st).err().unwrap();
    assert_eq!(e.0, "night: 2 syllables (N AA1 IY1 T), 1 notes");
    let e = plan(&m, &mut ph, &Song::parse("%bpm 60\nnight{N,T} D4:2\n").unwrap(), 0, &st).err().unwrap();
    assert_eq!(e.0, "night: 0 syllables (N T), 1 notes");
    // a written close fits its vowel or the song is refused
    let e = plan(&m, &mut ph, &Song::parse("%bpm 60\nmy{M,AA,~AY:300} D4:0.3\n").unwrap(), 0, &st).err().unwrap();
    assert!(e.0.starts_with("my: a close of 300 ms in a vowel of "), "{}", e.0);
    // a word's rule's vowels too
    let e = plan(&m, &mut ph, &Song::parse("%bpm 60\n%diction word=night -> N AY IH T\nnight D4:2\n").unwrap(), 0, &st).err().unwrap();
    assert_eq!(e.0, "night: 2 syllables (N AY1 IH1 T), 1 notes");
}

#[test]
fn diction_lines_set_the_rules() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let text = "%bpm 60\nmy D4:0.2\nnight D4:2\n%rest 1\njoy D4:1+E4:1\nI'll D4:1\ndenial D4:0.5 D4:1 D4:1\nholy D4:2 D4:1\nyour D4:1\nboat D4:1\nada D4:1 D4:1\nmagic D4:1 D4:1\n";
    let mut go = |lines: &str, under: Rules| plan(&m, &mut ph, &Song::parse_under(&format!("{lines}{text}"), under).unwrap(), 0, &style(0.0)).unwrap();
    let base = go("", sung_rules());
    assert_eq!(said(&base), "^ M AY1   N AA1 AY1 T ,   JH AO1 OY1   AY1 L   D IH1 N AA1 IY1 AH1 L   HH OW1 L IY1   Y AO1 R   B OW1 T   EY1 D AH1   M AE1 JH IH1 K $");
    // sung is how every song is sung; spoken, its vowels as the dictionary has them
    let same = go("%diction spoken\n%diction sung\n", Rules::default());
    assert_eq!((&same.tokens, &same.durations, &same.lf0), (&base.tokens, &base.durations, &base.lf0));
    assert_eq!(said(&go("%diction spoken\n", Rules::default())), "^ M AY1   N AY1 T ,   JH OY1   AY1 L   D IH0 N AY1 AH0 L   HH OW1 L IY0   Y AO1 R   B OW1 T   EY1 D AH0   M AE1 JH IH0 K $");
    // a written rule before the set's: its close and its length, whatever is after the vowel
    let p = go("%diction AY held>=240 -> AA ~IH:<100\n", sung_rules());
    assert_eq!(said(&p), "^ M AY1   N AA1 IH1 T ,   JH AO1 OY1   AA1 IH1 L   D IH1 N AA1 IH1 AH1 L   HH OW1 L IY1   Y AO1 R   B OW1 T   EY1 D AH1   M AE1 JH IH1 K $");
    assert_eq!(p.durations[p.tokens.iter().position(|&t| lipservice::front::symbol(t) == "IH1").unwrap()], 10);
    // a vowel the set has no rule for takes one; no close holds the vowel alone; `same` is the set's rule off
    let p = go("%diction OW held>=240 -> AO ~OW:<120\n%diction EY held>=240 -> EH\n%diction OY -> same\n", sung_rules());
    assert_eq!(said(&p), "^ M AY1   N AA1 AY1 T ,   JH OY1   AY1 L   D IH1 N AA1 IY1 AH1 L   HH AO1 OW1 L IY1   Y AO1 R   B AO1 OW1 T   EH1 D AH1   M AE1 JH IH1 K $");
    assert_eq!(p.durations[p.tokens.iter().position(|&t| lipservice::front::symbol(t) == "OW1").unwrap()], 12);
    // the floor is each rule's: "my" of 20 frames is held at 200 ms; under 2500 nothing is
    assert!(said(&go("%diction AY held>=200 -> AA ~AY\n", sung_rules())).starts_with("^ M AA1 AY1  "));
    assert!(said(&go("%diction AY held<2500 -> same\n%diction OY held<2500 -> same\n", sung_rules())).contains("  N AY1 T ,   JH OY1  "));
    // a rules file under the song, the song's lines after it
    let rules = Rules::file("# choral\nAY held>=200 -> AA ~IH\n\n%diction word=boat -> B AO T\n").unwrap();
    let p = go("%diction AY held>=200 -> AA ~IY\n", rules);
    assert!(said(&p).starts_with("^ M AA1 IY1   N AA1 IY1 T ,") && said(&p).contains("  B AO1 T  "), "{}", said(&p));
    let e = Rules::file("AY held>=200 -> AA ~IH\nheld\n").err().unwrap();
    assert!(e.0.starts_with("line 2: held: "), "{}", e.0);
    // the stops' dip scaled, and none
    let semi = |p: &lipservice::sing::Plan| -> Vec<f32> { p.lf0.iter().map(|&l| (l - 440f32.ln()) * 12.0 / std::f32::consts::LN_2 + 69.0 - 74.0).collect() };
    let at = |p: &lipservice::sing::Plan, s: &str, k: usize| -> std::ops::Range<usize> {
        let i = (0..p.tokens.len()).filter(|&i| lipservice::front::symbol(p.tokens[i]) == s).nth(k).unwrap();
        let a: usize = p.durations[..i].iter().sum();
        a..a + p.durations[i]
    };
    let low = |p: &lipservice::sing::Plan, r: std::ops::Range<usize>| semi(p)[r].iter().cloned().fold(f32::MAX, f32::min);
    let b = at(&base, "B", 0);
    let b = b.start - 3..b.end;
    assert!((-2.75..-2.3).contains(&low(&base, b.clone())), "{}", low(&base, b.clone()));
    let half = go("%diction B,D,G place=first -> dip=0.5\n", sung_rules());
    assert!((low(&half, b.clone()) - 0.5 * low(&base, b.clone())).abs() < 0.01);
    let none = go("%diction B,D,G -> dip=0\n", sung_rules());
    assert!(low(&none, b.clone()).abs() < 0.01);
    // inside a word: no dip by the set, the dip through the stop's own frames by a rule for every one
    let d = at(&base, "JH", 1);
    assert!(d.len() >= 2 && low(&base, d.clone()) > -0.3, "{d:?} {}", low(&base, d.clone()));
    let inside = go("%diction B,D,G,JH -> dip=1\n", sung_rules());
    assert_eq!(inside.durations, base.durations);
    assert!(low(&inside, d.clone()) < -0.5, "{}", low(&inside, d.clone()));
    assert!((low(&inside, b.clone()) - low(&base, b.clone())).abs() < 0.01);
}
