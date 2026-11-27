// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A part performed (part.rs: the song read, its timing loosened, breaths planned into its rests and
//! fitted to where the engine puts them), against a stand-in for the engine's plan; and a song's
//! vibrato sized (choir.rs). These were web/perform_test.mjs's checks of web/perform.js, the page's
//! copy of this, which the page no longer has.

use std::collections::HashMap;
use std::ops::Range;

use lipservice::choir::sized;
use lipservice::part::{deficits, jitter, parse, perform, perform_as, plan, Breathing, Clip, Library, Manner, Part, Phrase, Req, Rnd, Timing, Written, BREATH_PRE, FPS, LEAD, MIN_NOTE, ONSET_MARGIN, SR};

const SONG: &str = "%bpm 90\n# a test\n%rest 2\nla C4:1 D4:0.5+E4:0.5\nlee G4:2\n%rest 1\n%rest 1\nla A4:0.75 G4:0.25\n%rest 0.5\nloo F4:3\n%rest 0.25\nla C4:2\n%rest 1\n";

fn beats(ph: &Phrase) -> Vec<f64> {
    ph.words.iter().flat_map(|w| w.groups.iter().flatten()).map(|t| t.beats).collect()
}

fn len(ph: &Phrase) -> f64 {
    beats(ph).iter().sum()
}

/// sing.rs plan()'s silent spans, frames: the lead-in (LEAD and the song's start), each rest up to
/// the next word's onset (`on` frames a word, fitted into the rest less a frame), the tail;
/// everything after the lead-in later by the first onset. Refuses a rest too short for an onset of
/// two sounds, as the engine does.
fn rests(text: &str, on: usize) -> lipservice::weights::Result<Vec<Range<usize>>> {
    let s = parse(text)?;
    let fpb = FPS * 60.0 / s.bpm;
    let f = |b: f64| (b * fpb).round() as usize;
    let lead = (LEAD * FPS).round() as usize;
    let t0 = lead + on;
    let mut out = vec![0..lead + f(s.phrases[0].start)];
    for k in 1..s.phrases.len() {
        let (a, b) = (f(s.phrases[k - 1].end()), f(s.phrases[k].start));
        if b - a < 3 {
            return lipservice::weights::err(format!("a rest of {} frames before {}", b - a, s.phrases[k].words[0].word));
        }
        out.push(t0 + a..t0 + b - on.min(b - a - 1));
    }
    if s.tail > 0.0 {
        let last = s.phrases.last().unwrap().end();
        out.push(t0 + f(last)..t0 + f(last + s.tail));
    }
    Ok(out)
}

/// The stand-in's singer: the songs it was opened on, in order.
fn opener(on: usize, opened: &mut Vec<String>) -> impl FnMut(&str, f64) -> lipservice::weights::Result<(String, Vec<Range<usize>>)> + '_ {
    move |text, _shift| {
        opened.push(text.to_string());
        Ok((text.to_string(), rests(text, on)?))
    }
}

fn library() -> Library {
    let mut clips = Vec::new();
    for sex in ['F', 'M'] {
        for d in [0.12, 0.2, 0.26, 0.31, 0.38, 0.45, 0.6, 0.75] {
            clips.push(Clip { id: format!("{sex}{d}"), sex, at: 0, n: (d * SR).round() as usize });
        }
    }
    Library::new(clips).unwrap()
}

fn breathing<'a>(lib: Option<&'a Library>, want: &'a dyn Fn(usize) -> bool, deck: &'a dyn Fn(usize) -> String, turn: i64) -> Breathing<'a> {
    Breathing { sex: 'F', lib, want, deck, turn, give: None }
}

fn planned(s: &Written, b: &Breathing) -> (String, Vec<Req>) {
    plan(s, b, &HashMap::new(), &mut HashMap::new()).unwrap()
}

#[test]
fn parse_reads_phrases_between_rests() {
    let s = parse(SONG).unwrap();
    assert!(s.bpm == 90.0 && s.tail == 1.0 && s.phrases.len() == 4);
    assert_eq!(s.phrases.iter().map(|p| p.start).collect::<Vec<_>>(), [2.0, 8.0, 9.5, 12.75]);
    assert_eq!(s.phrases.iter().map(len).collect::<Vec<_>>(), [4.0, 1.0, 3.0, 2.0]);
    for bad in ["la C4:1\n", "%bpm 90\n%bpm 80\nla C4:1\n", "%bpm 90\nla C4\n", "%bpm 90\nla C4:0\n", "%bpm 90\nrest\nla C4:1\n", "%bpm 90\n%rest 1\n", "%bpm 90\nla\n"] {
        assert!(parse(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn jitter_moves_boundaries_a_little_and_keeps_every_phrase_and_rest() {
    let s = parse(SONG).unwrap();
    let mut r = Rnd::new("j");
    let (same, lag) = jitter(&s, Timing::Own(&mut r), 0.0);
    assert!(same == s && lag == 0.0, "none at 0 frames");
    let fpb = FPS * 60.0 / s.bpm;
    let mut moved = false;
    for seed in 0..300 {
        let jf = 1.0 + (seed % 4) as f64;
        let mut r = Rnd::new(&format!("j {seed}"));
        let (j, lag) = jitter(&s, Timing::Own(&mut r), jf);
        assert!(lag.abs() <= jf / FPS + 1e-12, "the lag within jf frames");
        for (k, ph) in j.phrases.iter().enumerate() {
            let o = &s.phrases[k];
            let (a, b) = (beats(o), beats(ph));
            assert!((len(ph) - len(o)).abs() < 1e-9 && b.iter().all(|&x| x > 0.0));
            assert!(((ph.start - o.start) * fpb).abs() <= 2.0 * jf + 1e-9);
            // each boundary within jf frames of where it was, and within a fifth of the notes beside it
            let (mut ca, mut cb) = (0.0, 0.0);
            for i in 0..a.len().saturating_sub(1) {
                ca += a[i];
                cb += b[i];
                let q = (0.2 * a[i].min(a[i + 1]) * fpb).floor();
                assert!((cb - ca).abs() * fpb <= jf.min(q) + 1e-9);
                moved |= (cb - ca).abs() > 1e-9;
            }
            if k > 0 {
                assert!((ph.start - j.phrases[k - 1].end()) * fpb >= 1.0 - 1e-9, "every rest keeps a frame");
            }
        }
    }
    assert!(moved);
    let tight = parse("%bpm 120\nla C4:1\n%rest 0.04\nla D4:1\n").unwrap(); // a rest of 2 frames
    for seed in 0..200 {
        let mut r = Rnd::new(&format!("t {seed}"));
        let (j, _) = jitter(&tight, Timing::Own(&mut r), 4.0);
        assert!((j.phrases[1].start - j.phrases[0].end()) * 50.0 >= 1.0 - 1e-9, "a two-frame rest keeps a frame");
    }
}

#[test]
fn plan_with_no_breaths_keeps_the_song_and_holds_a_short_rest() {
    let s = parse(SONG).unwrap();
    let (text, reqs) = planned(&s, &breathing(None, &|_| true, &|_| "p".into(), 0));
    assert!(reqs.is_empty() && parse(&text).unwrap() == s);
    let short = parse("%bpm 120\nla C4:1\n%rest 0.1\nla D4:1\n%rest 0.12\nla E4:1\n").unwrap(); // 5 and 6 frames
    let q = parse(&planned(&short, &breathing(None, &|_| true, &|_| "p".into(), 0)).0).unwrap();
    assert!(q.phrases.len() == 2 && (len(&q.phrases[0]) - 2.1).abs() < 1e-9 && (q.phrases[1].start - 2.22).abs() < 1e-9, "a rest under 6 frames is held by the note before");
}

#[test]
fn the_library_picks_a_clip_that_fits() {
    let lib = library();
    assert!(Library::new(vec![Clip { id: "x".into(), sex: 'X', at: 0, n: 10 }]).is_err() && lib.pick('X', 1.0, "x", 0).is_err());
    let dur = |c: usize| lib.clips[c].dur();
    for i in 0..200 {
        let c = lib.pick('M', 0.5, &format!("m{}", i >> 3), i).unwrap().unwrap();
        assert!(lib.clips[c].sex == 'M' && dur(c) <= 0.5 && dur(c) >= 0.3, "0.3 s or more when there is one");
    }
    assert!(dur(lib.pick('F', 0.25, "a", 3).unwrap().unwrap()) <= 0.25 && lib.pick('F', 0.1, "a", 3).unwrap().is_none());
    let five: Vec<usize> = (0..5).map(|k| lib.pick('M', 1.0, "now", 40 + k).unwrap().unwrap()).collect();
    let mut seen = five.clone();
    seen.sort();
    seen.dedup();
    assert!(seen.len() == 5 && lib.pick('M', 1.0, "now", 41).unwrap() == Some(five[1]), "singers a turn apart at one moment draw different clips");
}

#[test]
fn plan_makes_room_for_each_breath_and_moves_no_phrase() {
    let lib = library();
    let s = parse(SONG).unwrap();
    let spb = 60.0 / s.bpm;
    let deck = |j: usize| format!("b{j}");
    let (text, reqs) = planned(&s, &breathing(Some(&lib), &|_| true, &deck, 2));
    let back = parse(&text).unwrap();
    let total = |x: &Written| x.phrases.last().unwrap().end() + x.tail;
    assert!((total(&back) - total(&s)).abs() < 1e-5, "the song keeps its length");
    // the third phrase's rest is half a beat after a quarter-beat note: no room for a breath
    assert_eq!(reqs.iter().map(|q| (q.j, q.rest)).collect::<Vec<_>>(), [(0, 0), (1, 1), (3, 3)]);
    for q in &reqs {
        let d = lib.clips[q.clip].dur();
        if q.j == 0 {
            assert!(d <= (0.8f64).min(back.phrases[0].start * spb + LEAD - BREATH_PRE - ONSET_MARGIN) + 1e-9);
        } else {
            assert!((back.phrases[q.j].start - back.phrases[q.j - 1].end()) * spb >= d + BREATH_PRE + ONSET_MARGIN - 1e-5, "a breath's rest holds it");
        }
    }
    let was: Vec<f64> = s.phrases.iter().flat_map(beats).collect();
    let now: Vec<f64> = back.phrases.iter().flat_map(beats).collect();
    let cut: Vec<f64> = now.iter().zip(&was).filter(|(n, w)| **n < **w - 1e-9).map(|(n, _)| *n).collect();
    assert!(!cut.is_empty() && cut.iter().all(|&b| b >= MIN_NOTE - 1e-6) && now.iter().zip(&was).all(|(n, w)| *n <= w + 1e-9), "notes shortened keep MIN_NOTE beats, none lengthened");
    assert_eq!(back.phrases.iter().map(|p| p.start).collect::<Vec<_>>(), s.phrases.iter().map(|p| p.start).collect::<Vec<_>>(), "every phrase starts where it did");
    let spans: Vec<(f64, f64)> = rests(&text, 4).unwrap().iter().map(|r| (r.start as f64 / FPS, r.end as f64 / FPS)).collect();
    assert!(deficits(&spans, &reqs, &lib).unwrap().is_empty(), "no deficits where the onsets fit the margin");
    let three = lib.clips.iter().position(|c| c.sex == 'F' && (c.dur() - 0.31).abs() < 1e-3).unwrap();
    let d = deficits(&[(0.0, 0.5), (1.0, 1.2)], &[Req { rest: 0, clip: three, j: 0, room: 0.0 }, Req { rest: 1, clip: three, j: 5, room: 0.0 }], &lib).unwrap();
    assert!(d.len() == 1 && (d[&5] - (lib.clips[three].dur() + BREATH_PRE + 0.03 - 0.2)).abs() < 1e-12, "deficits by phrase: what a rest is short of its breath");
}

#[test]
fn a_lanes_lines_stay_with_their_words() {
    let laned = "%bpm 90\n%vibrato 0\n%rest 2\nla C4:1 D4:0.5+E4:0.5\n%vibrato 1:2\nlee G4:2\n%vibrato 0\n%rest 1\n%vibrato 0.5 2:3\n%rest 1\nla A4:0.75 G4:0.25\n%rest 0.5\nloo F4:3\n%rest 0.25\nla C4:2\n%vibrato 0.3\n%rest 1\n";
    let s = parse(laned).unwrap();
    let plain = parse(SONG).unwrap();
    let bare = |x: &Written| Written { after: Vec::new(), phrases: x.phrases.iter().map(|ph| Phrase { start: ph.start, words: ph.words.iter().map(|w| lipservice::part::Word { lane: Vec::new(), ..w.clone() }).collect() }).collect(), ..x.clone() };
    assert!(bare(&s) == plain && !s.after.is_empty(), "the notes are the song's without the lines");
    let lane = |line: &str, back: f64| lipservice::part::Laned { line: line.into(), back };
    assert_eq!(s.phrases[0].words[0].lane, [lane("%vibrato 0", 2.0)]);
    assert_eq!(s.phrases[0].words[1].lane, [lane("%vibrato 1:2", 0.0)]);
    assert_eq!(s.phrases[1].words[0].lane, [lane("%vibrato 0", 2.0), lane("%vibrato 0.5 2:3", 1.0)]);
    assert!(s.phrases[2].words[0].lane.is_empty() && s.phrases[3].words[0].lane.is_empty() && s.after == ["%vibrato 0.3"], "a line stays with the word after it, the beats of rest between them counted");
    assert!(parse("%bpm 90\nvibrato\nla C4:1\n").is_err(), "a line with no sizes");
    let (text, _) = planned(&s, &breathing(None, &|_| true, &|_| "p".into(), 0));
    assert_eq!(text, laned, "planned with no breaths, the song as it was written");
    let lanes = |x: &Written| (x.phrases.iter().map(|ph| ph.words.iter().map(|w| w.lane.clone()).collect::<Vec<_>>()).collect::<Vec<_>>(), x.after.clone());
    let mut r = Rnd::new("j 3");
    let (j, _) = jitter(&s, Timing::Own(&mut r), 3.0);
    assert!(lanes(&j) == lanes(&s) && j != s, "loosened, each line is still with its word");
    // a breath's room is taken from the note before: the lines in that rest stay their beats before the word
    let lib = library();
    let deck = |k: usize| format!("b{k}");
    let (q, reqs) = planned(&parse("%bpm 90\nla C4:3\n%vibrato 0\n%rest 0.25\n%vibrato 2:1\nla D4:2\n").unwrap(), &breathing(Some(&lib), &|k| k == 1, &deck, 2));
    let ls: Vec<&str> = q.trim().split('\n').collect();
    let num = |l: &str| l.rsplit([' ', ':']).next().unwrap().parse::<f64>().unwrap();
    assert!(reqs.len() == 1 && ls.len() == 7 && ls[3..].join("|") == "%vibrato 0|%rest 0.25|%vibrato 2:1|la D4:2" && ls[1].starts_with("la C4:") && ls[2].starts_with("%rest "), "{ls:?}");
    assert!(num(ls[1]) < 3.0 && (num(ls[1]) + num(ls[2]) - 3.0).abs() < 1e-5, "a line after a note that gives room is where the note was written to end");
    let (b, reqs) = planned(&s, &breathing(Some(&lib), &|_| true, &deck, 2));
    let back = parse(&b).unwrap();
    assert!(reqs.len() > 1 && lanes(&back) == lanes(&s) && (back.phrases[1].start - s.phrases[1].start).abs() < 1e-9, "planned with breaths and read back, every line where it was");
    // a rest the note before holds: the line is at the word
    let (held, _) = planned(&parse("%bpm 120\nla C4:1\n%vibrato 0\n%rest 0.1\nla D4:1\n%vibrato 2\n").unwrap(), &breathing(None, &|_| true, &|_| "p".into(), 0));
    assert_eq!(held, "%bpm 120\nla C4:1.1\n%vibrato 0\nla D4:1\n%vibrato 2\n");
    // sized: every size written, and the voice's own they start from
    assert_eq!(sized(laned, 1.0).unwrap(), laned);
    assert_eq!(
        sized(laned, 0.5).unwrap(),
        laned.replace("%bpm 90\n", "%bpm 90\n%vibrato 0.5\n").replace("%vibrato 1:2", "%vibrato 0.5:2").replace("%vibrato 0.5 2:3", "%vibrato 0.25 1:3").replace("%vibrato 0.3", "%vibrato 0.15")
    );
    assert_eq!(sized(SONG, 0.6).unwrap(), SONG.replace("%bpm 90\n", "%bpm 90\n%vibrato 0.6\n"));
    assert!(sized(SONG, -1.0).is_err() && sized("%bpm 90\n%vibrato x\nla C4:1\n", 0.5).is_err() && sized("la C4:1\n", 0.5).is_err());
}

fn part(song: &str, seed: u64, breath: f64, jitter: f64, spread: f64) -> Part<'_> {
    Part { song, sex: 'F', seed, at: 3.0, shift: -12.0, jitter, detune: 3.0, spread, breath }
}

/// Each breath inside its rest, after its silence and before the onset's margin.
fn fits(breaths: &[(usize, i64)], lib: &Library, rests: &[Range<usize>]) -> bool {
    breaths.iter().all(|&(c, at)| {
        let n = lib.clips[c].n as f64;
        rests.iter().any(|r| at as f64 / SR >= r.start as f64 / FPS + BREATH_PRE - 1e-9 && (at as f64 + n) / SR <= r.end as f64 / FPS - 0.03 + 1e-9)
    })
}

#[test]
fn a_part_breathes_in_its_rests_once_they_fit() {
    let lib = library();
    let p = part(SONG, 7, 1.0, 2.0, 0.02);
    let mut opened = Vec::new();
    let out = perform(&p, Some(&lib), opener(4, &mut opened)).unwrap();
    assert!(opened.len() == 1 && out.text == opened[0], "one try when the breaths fit");
    assert!(out.breaths.len() == 3 && fits(&out.breaths, &lib, &rests(&out.text, 4).unwrap()), "{} breaths", out.breaths.len());
    assert!((out.shift - -12.0).abs() <= 0.03 && out.lag.abs() <= 2.0 / FPS + 0.02, "the pitch a few cents off, the start a little late or early");
    let again = perform(&p, Some(&lib), opener(4, &mut Vec::new())).unwrap();
    assert!(again.text == out.text && again.shift == out.shift && again.lag == out.lag && again.breaths == out.breaths, "the same seed, the same performance");
    let other = perform(&part(SONG, 8, 1.0, 2.0, 0.02), Some(&lib), opener(4, &mut Vec::new())).unwrap();
    assert_ne!(other.text, out.text, "another seed, another performance");
}

#[test]
fn a_part_is_planned_again_when_its_rests_come_out_short() {
    let lib = library();
    // the engine's onsets longer than the margin: the rests come out short, the margin widens, it tries again
    let mut opened = Vec::new();
    let out = perform(&part(SONG, 7, 1.0, 2.0, 0.02), Some(&lib), opener(35, &mut opened)).unwrap();
    assert!(opened.len() > 1 && !out.breaths.is_empty() && fits(&out.breaths, &lib, &rests(&out.text, 35).unwrap()));
    // a rest written longer than its breath needs, the onset taking most of it: a wider margin moves
    // no note, so the margin goes at once to what the onset took
    let one = Library::new(vec![Clip { id: "f".into(), sex: 'F', at: 0, n: (0.6 * SR) as usize }]).unwrap();
    let song = "%bpm 120\nla C4:4\n%rest 3\nla C4:4\n%rest 3\nla C4:4\n";
    let mut opened = Vec::new();
    let out = perform(&part(song, 7, 1.0, 0.0, 0.02), Some(&one), opener(82, &mut opened)).unwrap();
    assert!(opened.len() == 2 && out.breaths.len() == 2 && fits(&out.breaths, &one, &rests(&out.text, 82).unwrap()));
}

#[test]
fn parts_that_start_a_phrase_together_breathe_together() {
    let lib = library();
    let go = |p: &Part| perform(p, Some(&lib), opener(4, &mut Vec::new())).unwrap();
    let a = go(&part(SONG, 7, 0.5, 0.0, 0.0));
    let b = go(&Part { seed: 99, sex: 'M', ..part(SONG, 7, 0.5, 0.0, 0.0) });
    // each in its own rests: a longer clip takes more of the note before
    let which = |o: &lipservice::part::Performed<String>| {
        let rs = rests(&o.text, 4).unwrap();
        o.breaths.iter().map(|&(_, at)| rs.iter().position(|r| at as f64 / SR >= r.start as f64 / FPS && (at as f64 / SR) < r.end as f64 / FPS)).collect::<Vec<_>>()
    };
    assert!(which(&a) == which(&b) && !a.breaths.is_empty() && a.breaths.len() < 3, "{:?} {:?}", which(&a), which(&b));
    assert!(go(&part(SONG, 7, 0.0, 2.0, 0.02)).breaths.is_empty(), "no breaths at a chance of 0");
    assert!(perform(&part(SONG, 7, 1.0, 2.0, 0.02), None, opener(4, &mut Vec::new())).unwrap().breaths.is_empty(), "no breaths with no library");
    // a breath marked: always or never, whatever the chance
    let marked = perform_as(&part(SONG, 7, 0.0, 2.0, 0.02), Manner { wants: &[None, Some(true)], ..Manner::default() }, Some(&lib), opener(4, &mut Vec::new())).unwrap();
    assert_eq!(marked.breaths.len(), 1, "a breath marked is taken at a chance of 0");
    let refused = perform_as(&part(SONG, 7, 1.0, 2.0, 0.02), Manner { wants: &[Some(false), Some(false), Some(false), Some(false)], ..Manner::default() }, Some(&lib), opener(4, &mut Vec::new())).unwrap();
    assert!(refused.breaths.is_empty(), "every breath marked never");
    let tight = "%bpm 120\nla C4:1\n%rest 0.1\nla D4:1\n";
    let e = perform_as(&part(tight, 7, 0.0, 0.0, 0.0), Manner { wants: &[None, Some(true)], ..Manner::default() }, Some(&lib), opener(4, &mut Vec::new())).err().expect("a breath marked that does not fit");
    assert!(e.0.starts_with("phrase 1 (from 0): the breath marked does not fit"), "{}", e.0);
}
