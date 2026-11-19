// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A singer's part. `roll` writes a piano roll's notes and the words under them as a song (the
//! format sing.rs reads). `perform` sings a song as a person does, as web/perform.js: each phrase
//! a few frames off the beat and its notes pulled about inside it, the pitch a few cents off, and
//! breaths taken in the rests, room made for them by shortening the note before. It agrees with
//! perform.js to the letter (web/part_check.mjs checks the two on the page's choirs), so its
//! arithmetic is perform.js's, operation for operation, in f64.
//!
//! The words of a roll: a word takes a note a syllable, as the engine says it. Hyphens may split
//! a word into its syllables (`wa-ter`), and each `_` after a syllable holds it over one more
//! note (`wide__`, `wa_-ter`; a `_` standing alone holds the word before it). A note runs to the
//! next note's start inside a word, and no further than it between words; what is left between
//! words is a rest.

use std::collections::HashMap;

use crate::front::{self, Phonemizer};
use crate::json::Json;
use crate::sing;
use crate::weights::{err, Error, Result};

pub const SR: f64 = 24000.0;
pub const FPS: f64 = 100.0;
/// Seconds of silence between a note's end and the breath.
pub const BREATH_PRE: f64 = 0.07;
/// Seconds of a rest the next word's onset may take.
pub const ONSET_MARGIN: f64 = 0.25;
/// Beats a shortened note keeps.
pub const MIN_NOTE: f64 = 0.5;
/// Seconds the engine sets before a song's first sound.
pub const LEAD: f64 = 0.1;
const ENTRY: f64 = 0.8; // s, the longest breath before the first phrase
const NEAR: f64 = 0.3; // s, a breath at least this long is preferred
const ATTEMPTS: usize = 14;
const MIN_REST: f64 = 6.0; // frames: a space, three consonants and a frame of silence
const LANES: [&str; 1] = ["vibrato"];

/// room.js's rng(key): the same numbers for the same key.
pub struct Rnd(u32);

impl Rnd {
    pub fn new(key: &str) -> Rnd {
        let units: Vec<u16> = key.encode_utf16().collect();
        let mut h = 1779033703u32 ^ units.len() as u32;
        for &c in &units {
            h = (h ^ c as u32).wrapping_mul(3432918353);
            h = h.rotate_left(13);
        }
        h = (h ^ (h >> 16)).wrapping_mul(2246822507);
        h = (h ^ (h >> 13)).wrapping_mul(3266489909);
        Rnd(h ^ (h >> 16))
    }

    pub fn uniform(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }

    pub fn between(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.uniform()
    }

    /// lo..hi, both in.
    pub fn int(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (self.uniform() * (hi - lo + 1.0)).floor()
    }
}

/// A number as JS's toFixed(digits) writes it: the nearest, and of two as near the one further
/// from zero (a whole odd number of half places, so of 2^-(digits + 1)).
pub fn fixed(x: f64, digits: usize) -> String {
    let (a, sign) = (x.abs(), if x < 0.0 { "-" } else { "" });
    let m = a * 2f64.powi(digits as i32 + 1);
    if m.fract() == 0.0 && m % 2.0 == 1.0 && m < 9e15 {
        let n = (m as u128 * 5u128.pow(digits as u32) + 1) / 2;
        let s = 10u128.pow(digits as u32);
        return if digits == 0 { format!("{sign}{n}") } else { format!("{sign}{}.{:0digits$}", n / s, n % s) };
    }
    format!("{sign}{a:.digits$}")
}

/// JS's Math.round: a half goes up.
fn round(x: f64) -> f64 {
    let f = x.floor();
    if x - f < 0.5 { f } else { f + 1.0 }
}

/// Beats as the page writes them: six places, trailing zeros dropped.
pub fn fmt(b: f64) -> String {
    let s = fixed(b, 6);
    let s = s.trim_end_matches('0');
    s.strip_suffix('.').unwrap_or(s).to_string()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Tone {
    /// As written: a note name or a MIDI number.
    pub pitch: String,
    pub beats: f64,
}

/// A lane's line (a value written along the song) kept with the word it comes before: `back` the
/// beats of rest between the line and the word.
#[derive(Clone, Debug, PartialEq)]
pub struct Laned {
    pub line: String,
    pub back: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Word {
    pub word: String,
    /// A syllable's notes each.
    pub groups: Vec<Vec<Tone>>,
    pub lane: Vec<Laned>,
}

/// A run of words with no rest between, from `start` beats into the song.
#[derive(Clone, Debug, PartialEq)]
pub struct Phrase {
    pub start: f64,
    pub words: Vec<Word>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Written {
    pub bpm: f64,
    pub phrases: Vec<Phrase>,
    /// Beats of rest after the last word.
    pub tail: f64,
    /// The lanes' lines after the last word.
    pub after: Vec<String>,
}

impl Phrase {
    fn tones(&self) -> impl Iterator<Item = &Tone> {
        self.words.iter().flat_map(|w| w.groups.iter().flatten())
    }

    fn tones_mut(&mut self) -> Vec<&mut Tone> {
        self.words.iter_mut().flat_map(|w| w.groups.iter_mut().flatten()).collect()
    }

    pub fn end(&self) -> f64 {
        self.start + self.tones().fold(0.0, |a, x| a + x.beats)
    }

    fn last(&mut self) -> &mut Tone {
        self.words.last_mut().and_then(|w| w.groups.last_mut()).and_then(|g| g.last_mut()).expect("a phrase has a note")
    }
}

fn num(s: &str, n: usize) -> Result<f64> {
    match s.parse::<f64>() {
        Ok(v) if v > 0.0 && v.is_finite() => Ok(v),
        _ => err(format!("line {n}: {s}: beats must be a positive number")),
    }
}

/// The song's phrases, its notes kept as written (the engine checks them).
pub fn parse(text: &str) -> Result<Written> {
    let (mut bpm, mut beat, mut open, mut tail) = (None, 0.0f64, false, 0.0f64);
    let mut lane: Vec<Laned> = Vec::new();
    let mut phrases: Vec<Phrase> = Vec::new();
    for (i, raw) in text.split('\n').enumerate() {
        let (line, n) = (raw.trim(), i + 1);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        if f[0] == "bpm" && f.len() == 2 {
            if bpm.is_some() {
                return err(format!("line {n}: bpm given twice"));
            }
            bpm = Some(num(f[1], n)?);
        } else if f[0] == "rest" && f.len() == 2 {
            let b = num(f[1], n)?;
            beat += b;
            for c in &mut lane {
                c.back += b;
            }
            open = false;
            tail = beat - phrases.last().map_or(beat, Phrase::end);
        } else if f[0] == "bpm" || f[0] == "rest" {
            return err(format!("line {n}: {} takes one number", f[0]));
        } else if LANES.contains(&f[0]) {
            if f.len() < 2 {
                return err(format!("line {n}: {} takes its sizes, VALUE or VALUE:BEATS each", f[0]));
            }
            lane.push(Laned { line: f.join(" "), back: 0.0 });
        } else if f.len() >= 2 {
            let mut groups = Vec::new();
            for g in &f[1..] {
                let mut tones = Vec::new();
                for x in g.split('+') {
                    match x.rfind(':') {
                        Some(k) if k >= 1 => tones.push(Tone { pitch: x[..k].to_string(), beats: num(&x[k + 1..], n)? }),
                        _ => return err(format!("line {n}: {x}: a note is NOTE:BEATS")),
                    }
                }
                groups.push(tones);
            }
            if !open {
                phrases.push(Phrase { start: beat, words: Vec::new() });
                open = true;
            }
            for x in groups.iter().flatten() {
                beat += x.beats;
            }
            phrases.last_mut().unwrap().words.push(Word { word: f[0].to_string(), groups, lane: std::mem::take(&mut lane) });
            tail = 0.0;
        } else {
            return err(format!("line {n}: {}: a word takes its notes, NOTE:BEATS each", f[0]));
        }
    }
    let bpm = bpm.ok_or_else(|| Error("the song has no bpm line".into()))?;
    if phrases.is_empty() {
        return err("the song has no words");
    }
    Ok(Written { bpm, phrases, tail, after: lane.into_iter().map(|c| c.line).collect() })
}

/// What a part's timing is drawn by: its own generator, or the piece's moments (a beat of the song
/// as written to its moment), each draw then the moment's and not the part's, so every part with a
/// phrase starting or a note changing at a moment moves it the same way and their consonants land
/// as one.
pub enum Timing<'a> {
    Own(&'a mut Rnd),
    Moments(&'a dyn Fn(f64) -> String),
}

/// Timing as a person's: each phrase starts off the beat by up to `jf` frames, and inside it each
/// note boundary moves by up to `jf` frames (never more than a fifth of either note beside it). The
/// song so sung, and the first phrase's offset in seconds, which the rest move against.
pub fn jitter(song: &Written, mut by: Timing, jf: f64) -> (Written, f64) {
    let fpb = FPS * 60.0 / song.bpm;
    let mut draw = |what: &str, beat: f64| match &mut by {
        Timing::Own(rnd) => rnd.int(-jf, jf),
        Timing::Moments(moment) => Rnd::new(&format!("timing {what} {}", moment(beat))).int(-jf, jf),
    };
    let mut offs: Vec<f64> = song.phrases.iter().map(|ph| draw("phrase", ph.start)).collect();
    let mut phrases = Vec::with_capacity(song.phrases.len());
    for (k, ph) in song.phrases.iter().enumerate() {
        let mut out = ph.clone();
        out.start = ph.start + (offs[k] - offs[0]) / fpb;
        if k > 0 {
            // the rest before it keeps a frame
            let room = (ph.start - song.phrases[k - 1].end()) * fpb - 1.0;
            if offs[k] - offs[k - 1] < -room {
                offs[k] = offs[k - 1] - room.floor();
                out.start = ph.start + (offs[k] - offs[0]) / fpb;
            }
        }
        let mut ns = out.tones_mut();
        let mut prev = 0.0; // the last boundary's move, frames
        let mut beat = ph.start; // the boundary as written
        let written: Vec<f64> = ph.tones().map(|x| x.beats).collect();
        for i in 1..ns.len() {
            beat += written[i - 1];
            let q = (0.2 * ns[i - 1].beats.min(ns[i].beats) * fpb).floor();
            let e = (-q).max(q.min(draw("note", beat)));
            ns[i - 1].beats += (e - prev) / fpb;
            prev = e;
        }
        let last = ns.len() - 1;
        ns[last].beats -= prev / fpb;
        phrases.push(out);
    }
    (Written { bpm: song.bpm, phrases, tail: song.tail, after: song.after.clone() }, offs[0] / FPS)
}

/// A breath: `n` samples from sample `at` of the library's sound.
#[derive(Clone, Debug, PartialEq)]
pub struct Clip {
    pub id: String,
    pub sex: char,
    pub at: usize,
    pub n: usize,
}

impl Clip {
    pub fn dur(&self) -> f64 {
        self.n as f64 / SR
    }
}

/// The breaths by sex.
pub struct Library {
    pub clips: Vec<Clip>,
}

impl Library {
    pub fn new(clips: Vec<Clip>) -> Result<Library> {
        if let Some(c) = clips.iter().find(|c| c.sex != 'F' && c.sex != 'M') {
            return err(format!("breath {}: sex {}", c.id, c.sex));
        }
        Ok(Library { clips })
    }

    /// A clip of `sex` no longer than `maxd` seconds, one of NEAR or more preferred: its index.
    /// The clips to choose among are put in an order set by `deck` and the one `turn` places in
    /// taken, so singers breathing at the same moment with turns apart draw different clips.
    pub fn pick(&self, sex: char, maxd: f64, deck: &str, turn: i64) -> Result<Option<usize>> {
        if sex != 'F' && sex != 'M' {
            return err(format!("no breaths for sex {sex}"));
        }
        let mut cs: Vec<usize> = (0..self.clips.len()).filter(|&i| self.clips[i].sex == sex).collect();
        let mut r = Rnd::new(&format!("deck {deck}"));
        for i in (1..cs.len()).rev() {
            let k = r.int(0.0, i as f64) as usize;
            cs.swap(i, k);
        }
        let ok: Vec<usize> = cs.into_iter().filter(|&i| self.clips[i].dur() <= maxd).collect();
        if ok.is_empty() {
            return Ok(None);
        }
        let near: Vec<usize> = ok.iter().copied().filter(|&i| self.clips[i].dur() >= NEAR).collect();
        let of = if near.is_empty() { ok } else { near };
        Ok(Some(of[turn.rem_euclid(of.len() as i64) as usize]))
    }
}

/// A breath asked for: in the engine's silent span `rest` (the lead-in is 0, then each rest),
/// before phrase `j`, `room` the seconds of silence written for it.
#[derive(Clone, Debug, PartialEq)]
pub struct Req {
    pub rest: usize,
    pub clip: usize,
    pub j: usize,
    pub room: f64,
}

/// Who breathes and when.
pub struct Breathing<'a> {
    pub sex: char,
    pub lib: Option<&'a Library>,
    /// Whether a breath is wanted before phrase j.
    pub want: &'a dyn Fn(usize) -> bool,
    /// Library::pick's deck for phrase j, and the singer's turn.
    pub deck: &'a dyn Fn(usize) -> String,
    pub turn: i64,
    /// The most of itself the note before gives a breath, a share; or all but MIN_NOTE beats.
    pub give: Option<f64>,
}

fn line(w: &Word) -> String {
    let groups: Vec<String> = w.groups.iter().map(|g| g.iter().map(|x| format!("{}:{}", x.pitch, fmt(x.beats))).collect::<Vec<_>>().join("+")).collect();
    format!("{} {}", w.word, groups.join(" "))
}

/// The song's text with a breath asked for before each phrase that wants one, room made for it in
/// the rest by shortening the note before (to MIN_NOTE beats at least, and by no more than
/// Breathing::give of itself; a breath that does not fit in that is not taken and the note is
/// held). The first phrase's breath fits the lead-in as written. A rest too short for the engine to set a word's onset in is held
/// by the note before. `margins`: the seconds of a rest the word after it takes, where more than
/// ONSET_MARGIN; `pins`: the clip a phrase drew first, kept while it fits.
pub fn plan(song: &Written, b: &Breathing, margins: &HashMap<usize, f64>, pins: &mut HashMap<usize, usize>) -> Result<(String, Vec<Req>)> {
    let spb = 60.0 / song.bpm;
    let mut phrases = song.phrases.clone();
    let (mut reqs, mut gaps) = (Vec::new(), Vec::new());
    let (mut cur, mut rests) = (0.0f64, 0usize);
    for j in 0..phrases.len() {
        let (mut gap, mut breath) = (phrases[j].start - cur, false);
        if let Some(lib) = b.lib.filter(|_| (b.want)(j)) {
            let mg = margins.get(&j).copied().unwrap_or(ONSET_MARGIN);
            let maxd = if j == 0 {
                ENTRY.min(gap * spb + LEAD - BREATH_PRE - mg)
            } else {
                let prev = phrases[j - 1].last().beats;
                let lend = (prev - MIN_NOTE).max(0.0).min(b.give.map_or(f64::INFINITY, |g| prev * g));
                (gap + lend) * spb - BREATH_PRE - mg
            };
            let mut clip = if maxd >= 0.2 { lib.pick(b.sex, maxd, &(b.deck)(j), b.turn)? } else { None };
            if let Some(&p) = pins.get(&j) {
                if lib.clips[p].dur() <= maxd {
                    clip = Some(p);
                }
            }
            if let Some(c) = clip {
                pins.insert(j, c);
                let need = (lib.clips[c].dur() + BREATH_PRE + mg) / spb;
                if j > 0 && gap < need {
                    phrases[j - 1].last().beats -= need - gap;
                    gap = need;
                }
                reqs.push(Req { rest: if j == 0 { 0 } else { rests + 1 }, clip: c, j, room: gap * spb + if j == 0 { LEAD } else { 0.0 } });
                breath = true;
            }
        }
        if j > 0 && !breath && gap * FPS * spb < MIN_REST {
            phrases[j - 1].last().beats += gap;
            gap = 0.0;
        }
        if j > 0 && gap > 0.0 {
            rests += 1;
        }
        gaps.push(gap);
        cur = phrases[j].end();
    }
    let mut out = vec![format!("bpm {}", fmt(song.bpm))];
    for (j, ph) in phrases.iter().enumerate() {
        let mut left = gaps[j]; // beats of the rest before the phrase still to write
        for (k, w) in ph.words.iter().enumerate() {
            for c in &w.lane {
                let r = left - c.back.min(left);
                if fmt(r) != "0" {
                    out.push(format!("rest {}", fmt(r)));
                    left -= r;
                }
                out.push(c.line.clone());
            }
            if k == 0 && left > 0.0 {
                out.push(format!("rest {}", fmt(left)));
                left = 0.0;
            }
            out.push(line(w));
        }
    }
    out.extend(song.after.iter().cloned());
    if song.tail > 0.0 {
        out.push(format!("rest {}", fmt(song.tail)));
    }
    Ok((out.join("\n") + "\n", reqs))
}

/// The rests short of their breaths, by phrase: the seconds each lacks. `spans`: the engine's own
/// silent spans, seconds.
pub fn deficits(spans: &[(f64, f64)], reqs: &[Req], lib: &Library) -> Result<HashMap<usize, f64>> {
    let mut out = HashMap::new();
    for r in reqs {
        let (c0, c1) = *spans.get(r.rest).ok_or_else(|| Error(format!("a breath in rest {} of a song with {}", r.rest, spans.len())))?;
        let short = lib.clips[r.clip].dur() + BREATH_PRE + 0.03 - (c1 - c0);
        if short > 1e-4 {
            out.insert(r.j, short);
        }
    }
    Ok(out)
}

/// A breath library from its index (`path`, .json) and, beside it as .bin, its sound: the clips,
/// and the samples they are of (16 bits, at SR).
pub fn breaths(path: &str) -> Result<(Library, Vec<i16>)> {
    let Some(stem) = path.strip_suffix(".json") else {
        return err(format!("{path}: a breath library's .json, its sound beside it as .bin"));
    };
    let bad = |e: Error| Error(format!("{path}: {}", e.0));
    let text = std::fs::read_to_string(path).map_err(|e| Error(format!("{path}: {e}")))?;
    let j = Json::parse(&text).map_err(bad)?;
    let sr = j.get("sr").and_then(Json::num).map_err(bad)?;
    if sr != SR {
        return err(format!("{path}: breaths at {sr} Hz, not {SR}"));
    }
    let bin = format!("{stem}.bin");
    let bytes = std::fs::read(&bin).map_err(|e| Error(format!("{bin}: {e}")))?;
    if bytes.len() % 2 == 1 {
        return err(format!("{bin}: an odd number of bytes"));
    }
    let pcm: Vec<i16> = bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
    let mut clips = Vec::new();
    for c in j.get("clips").and_then(Json::arr).map_err(bad)? {
        let id = c.get("id").and_then(Json::str).map_err(bad)?.to_string();
        let field = |k: &str| c.get(k).map_err(|e| Error(format!("{path}, breath {id}: {}", e.0)));
        let count = |k: &str| field(k)?.count().map_err(|e| Error(format!("{path}, breath {id}: {k} {}", e.0)));
        let sex = field("sex")?.str().map_err(bad)?;
        let (at, n) = (count("at")?, count("n")?);
        if n == 0 || at + n > pcm.len() {
            return err(format!("{path}, breath {id}: samples {at} to {} of {}", at + n, pcm.len()));
        }
        let mut cs = sex.chars();
        match (cs.next(), cs.next()) {
            (Some(sex), None) => clips.push(Clip { id, sex, at, n }),
            _ => return err(format!("{path}, breath {id}: sex {sex}")),
        }
    }
    Ok((Library::new(clips).map_err(bad)?, pcm))
}

/// A part to perform.
pub struct Part<'a> {
    pub song: &'a str,
    pub sex: char,
    pub seed: u64,
    /// Seconds into the piece the part starts, as written.
    pub at: f64,
    pub shift: f64,
    /// Frames each phrase and note may move by; cents the pitch may be off by; seconds the start
    /// may be off by; the chance of a breath before a phrase.
    pub jitter: f64,
    pub detune: f64,
    pub spread: f64,
    pub breath: f64,
}

/// How a part is performed beside what Part says of it.
#[derive(Clone, Copy, Default)]
pub struct Manner {
    /// Its timing drawn by the piece's moments, as every such part's (Timing::Moments). Its singer
    /// is then opened on the song `clocked`.
    pub together: bool,
    /// Breathing::give.
    pub give: Option<f64>,
}

/// A song with the line that has its singer keep the others' clock (sing::Song::together), after
/// its bpm: what a part performed together is opened on.
pub fn clocked(text: &str) -> Result<String> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let k = lines.iter().position(|l| l.split_whitespace().next() == Some("bpm")).ok_or_else(|| Error("the song has no bpm line".into()))?;
    lines.insert(k + 1, "together");
    Ok(lines.join("\n"))
}

/// The part performed: the engine's singer of `text`, the breaths to add (a clip of the library
/// and the sample of the part it starts at), the seconds the part starts late by, its shift.
pub struct Performed<S> {
    pub singer: S,
    pub text: String,
    pub breaths: Vec<(usize, i64)>,
    pub lag: f64,
    pub shift: f64,
}

/// `open(text, shift)`: the engine's singer of the song at a shift, and its silent spans in
/// frames (sing::Plan::rests). The song is planned again, the word after a short rest given more
/// of it, until every breath fits its rest.
pub fn perform<S>(part: &Part, lib: Option<&Library>, open: impl FnMut(&str, f64) -> Result<(S, Vec<std::ops::Range<usize>>)>) -> Result<Performed<S>> {
    perform_as(part, Manner::default(), lib, open)
}

/// perform, in a manner.
pub fn perform_as<S>(
    part: &Part,
    manner: Manner,
    lib: Option<&Library>,
    mut open: impl FnMut(&str, f64) -> Result<(S, Vec<std::ops::Range<usize>>)>,
) -> Result<Performed<S>> {
    let mut r = Rnd::new(&format!("{} perform", part.seed));
    let song = parse(part.song)?;
    let spb = 60.0 / song.bpm;
    let own = jitter(&song, Timing::Own(&mut r), part.jitter); // drawn either way: the draws after it stay the part's
    let (sung, lag) = if manner.together { jitter(&song, Timing::Moments(&|beat| fixed(part.at + beat * spb, 3)), part.jitter) } else { own };
    let shift = part.shift + r.between(-part.detune, part.detune) / 100.0;
    let spread = r.between(-part.spread, part.spread);
    // one decision a moment, shared by every part that starts a phrase then
    let moment = |j: usize| fixed(part.at + song.phrases[j].start * spb, 3);
    let want = |j: usize| Rnd::new(&format!("breath {}", moment(j))).uniform() < part.breath;
    let b = Breathing { sex: part.sex, lib, want: &want, deck: &moment, turn: part.seed as i64, give: manner.give };
    let (mut margins, mut pins) = (HashMap::new(), HashMap::new());
    for _ in 0..ATTEMPTS {
        let (text, reqs) = plan(&sung, &b, &margins, &mut pins)?;
        let (singer, rests) = open(&text, shift)?;
        let spans: Vec<(f64, f64)> = rests.iter().map(|r| (r.start as f64 / FPS, r.end as f64 / FPS)).collect();
        let Some(lib) = lib else {
            return Ok(Performed { singer, text, breaths: Vec::new(), lag: lag + spread, shift });
        };
        let short = deficits(&spans, &reqs, lib)?;
        if short.is_empty() {
            let breaths = reqs
                .iter()
                .map(|q| {
                    let ((c0, c1), dur) = (spans[q.rest], lib.clips[q.clip].dur());
                    let room = (c1 - c0 - dur - BREATH_PRE - 0.03).max(0.0);
                    let e = c1 - 0.03 - room.min(0.04); // the same lead for every singer, so a section breathes together
                    (q.clip, round((e - dur) * SR) as i64)
                })
                .collect();
            return Ok(Performed { singer, text, breaths, lag: lag + spread, shift });
        }
        // what the next word's onset took of the silence written, and a little more
        for q in &reqs {
            if short.contains_key(&q.j) {
                margins.insert(q.j, q.room - (spans[q.rest].1 - spans[q.rest].0) + 0.05);
            }
        }
    }
    err(format!("the breaths do not fit the rests after {ATTEMPTS} tries"))
}

/// A note of a piano roll, in beats from the part's start.
#[derive(Clone, Debug, PartialEq)]
pub struct Key {
    /// MIDI number.
    pub pitch: f32,
    pub start: f64,
    pub beats: f64,
}

/// A word of a roll's lyric: the notes each of its syllables takes, where it writes its
/// syllables (hyphens), or the notes it holds past its last (`_`) where it does not.
struct Lyric {
    word: String,
    split: Option<Vec<usize>>,
    held: usize,
}

fn lyric(words: &str) -> Result<Vec<Lyric>> {
    let mut out: Vec<Lyric> = Vec::new();
    for tok in words.split_whitespace() {
        let t = tok.trim_matches(|c: char| ".,;:!?\"()\u{201c}\u{201d}".contains(c));
        if t.is_empty() {
            continue;
        }
        if t.chars().all(|c| c == '_') {
            let Some(w) = out.last_mut() else {
                return err(format!("{tok}: a held note with no word before it"));
            };
            match &mut w.split {
                Some(s) => *s.last_mut().unwrap() += t.len(),
                None => w.held += t.len(),
            }
            continue;
        }
        let pieces: Vec<(&str, usize)> = t
            .split('-')
            .map(|p| {
                let s = p.trim_end_matches('_');
                (s, p.len() - s.len())
            })
            .collect();
        if pieces.iter().any(|p| p.0.is_empty() || p.0.contains('_')) {
            return err(format!("{tok}: a syllable is letters, then a _ for each note it holds"));
        }
        let word: String = pieces.iter().map(|p| p.0).collect();
        if pieces.len() == 1 {
            out.push(Lyric { word, split: None, held: pieces[0].1 });
        } else {
            out.push(Lyric { word, split: Some(pieces.iter().map(|p| 1 + p.1).collect()), held: 0 });
        }
    }
    if out.is_empty() {
        return err("the part has no words");
    }
    Ok(out)
}

/// The syllables the engine sings word `k` of a song's lines in (`items`: each line's word, a
/// rest's None), as sing::plan counts them.
pub fn syllables(ph: &mut Phonemizer, diction: bool, items: &[Option<&str>], k: usize) -> Result<usize> {
    let (mut said, mut low) = (Vec::new(), Vec::new());
    for item in items {
        match item {
            Some(w) => {
                let ws = front::words_and_stops(w)?;
                if ws.len() != 1 || front::STOPS.contains(&ws[0].as_str()) {
                    return err(format!("{w}: one word at a time"));
                }
                low.push(ws[0].to_ascii_lowercase());
                said.push(ws[0].clone());
            }
            None => {
                low.push(",".to_string());
                said.push(String::new());
            }
        }
    }
    let mut phones = ph.phones_in(&said[k], &low, k)?;
    if diction {
        phones = sing::sung_diction(&phones)?;
    }
    Ok(phones.iter().filter(|p| p.ends_with(|c: char| c.is_ascii_digit())).count())
}

fn pitch(m: f32) -> String {
    format!("{m}")
}

/// A piano roll's notes and the words under them as a song. `count(items, k)`: the syllables word
/// `k` of the song's lines is sung in (`syllables`). One note at a time: two that start together
/// are an error, and a note still sounding when the next starts ends there. A gap between words of
/// `join` beats or less is no rest: the note before holds it, as a player's fingers leave one
/// between notes meant to run on. The song starts at beat `from` of the notes' own count.
/// `vibrato` is the pedal beside the notes: from each point's beat (the notes' count) the
/// vibrato's size against the voice's own, held until the next; 1 before the first. It is written
/// as vibrato lines, each word's own before it, so a word sung off its beat takes its pedal along.
pub fn roll(bpm: f64, from: f64, keys: &[Key], words: &str, vibrato: &[(f64, f64)], join: f64, count: &mut dyn FnMut(&[Option<&str>], usize) -> Result<usize>) -> Result<String> {
    if !(bpm > 0.0 && bpm.is_finite()) {
        return err(format!("bpm {bpm}: more than 0"));
    }
    if !from.is_finite() {
        return err(format!("a song from beat {from}"));
    }
    if !(join >= 0.0 && join.is_finite()) {
        return err(format!("gaps of {join} beats joined: 0 or more"));
    }
    let grid = |b: f64| (b * 1e6).round();
    for (i, p) in vibrato.iter().enumerate() {
        if !(p.0.is_finite() && p.1 >= 0.0 && p.1.is_finite()) {
            return err(format!("the pedal at beat {}: a vibrato {} times the size", p.0, p.1));
        }
        if i > 0 && grid(p.0) <= grid(vibrato[i - 1].0) {
            return err(format!("the pedal at beat {}: not after the point before it", fmt(p.0)));
        }
    }
    let mut keys: Vec<&Key> = keys.iter().collect();
    for k in &keys {
        if !(k.start >= from && k.start.is_finite()) {
            return err(format!("a note at beat {}: {} or later", k.start, fmt(from)));
        }
        if !(k.beats > 0.0 && k.beats.is_finite()) {
            return err(format!("the note at beat {}: {} beats long", fmt(k.start), k.beats));
        }
        if !(0.0..=127.0).contains(&k.pitch) {
            return err(format!("the note at beat {}: MIDI {}", fmt(k.start), k.pitch));
        }
    }
    keys.sort_by(|a, b| a.start.total_cmp(&b.start));
    if let Some(w) = keys.windows(2).find(|w| grid(w[0].start) == grid(w[1].start)) {
        return err(format!("two notes start at beat {}: a singer sings one at a time", fmt(w[0].start)));
    }
    let lyr = lyric(words)?;
    let names: Vec<&str> = lyr.iter().map(|l| l.word.as_str()).collect();
    // each word's syllables as the engine says them: first with no rests known, then with the rests
    // the notes leave, until the two agree
    let mut items: Vec<Option<&str>> = names.iter().map(|w| Some(*w)).collect();
    let mut at: Vec<usize> = (0..lyr.len()).collect(); // each word's place among the items
    for _ in 0..4 {
        // each word's notes a syllable; what is wrong with them is said once the rests have settled
        let (mut groups, mut wrong) = (Vec::<Vec<usize>>::new(), None);
        for (i, l) in lyr.iter().enumerate() {
            let n = count(&items, at[i])?;
            if n == 0 {
                return err(format!("{}: no syllable to sing", l.word));
            }
            groups.push(match &l.split {
                Some(s) => {
                    if s.len() != n && wrong.is_none() {
                        wrong = Some(format!("{}: written in {} syllables, sung in {n}", l.word, s.len()));
                    }
                    s.clone()
                }
                None => (0..n).map(|k| if k + 1 == n { 1 + l.held } else { 1 }).collect(),
            });
        }
        let need: usize = groups.iter().flatten().sum();
        let mut out = vec![format!("bpm {}", fmt(bpm))];
        let (mut next, mut k, mut short) = (Vec::new(), 0, None);
        let mut pos = grid(from); // the grid place written up to
        let mut starts = Vec::new(); // each word's line, and the grid place it starts at
        for (i, g) in groups.iter().enumerate() {
            let stop = k + g.iter().sum::<usize>(); // past the word's last note
            if short.is_none() && stop > keys.len() {
                short = Some(i); // the notes run out here: the words from here on go unsung
            }
            if short.is_none() && grid(keys[k].start) > pos {
                out.push(format!("rest {}", fmt((grid(keys[k].start) - pos) / 1e6)));
                next.push(None);
            }
            at[i] = next.len();
            next.push(Some(names[i]));
            if short.is_some() {
                continue;
            }
            starts.push((out.len(), grid(keys[k].start)));
            let mut syls = Vec::new();
            for &n in g {
                let mut tones = Vec::new();
                for _ in 0..n {
                    let (a, own) = (grid(keys[k].start), grid(keys[k].start + keys[k].beats));
                    // inside a word a note runs to the next; its last no further than the next word
                    let end = match keys.get(k + 1).map(|x| grid(x.start)) {
                        Some(f) if k + 1 < stop || f - own <= grid(join) => f,
                        Some(f) => own.min(f),
                        None => own,
                    };
                    if end <= a {
                        return err(format!("the note at beat {}: under a millionth of a beat long", fmt(keys[k].start)));
                    }
                    tones.push(format!("{}:{}", pitch(keys[k].pitch), fmt((end - a) / 1e6)));
                    pos = end;
                    k += 1;
                }
                syls.push(tones.join("+"));
            }
            out.push(format!("{} {}", names[i], syls.join(" ")));
        }
        if next != items {
            items = next;
            continue;
        }
        if let Some(e) = wrong {
            return err(e);
        }
        if let Some(i) = short {
            return err(format!("the words take {need} notes and the part has {}: the notes run out at \"{}\" (word {})", keys.len(), lyr[i].word, i + 1));
        }
        if need < keys.len() {
            return err(format!("the words take {need} notes and the part has {}: the words run out at beat {}", keys.len(), fmt(keys[need].start)));
        }
        // last word first: a line put in moves the lines after it alone
        for (j, &(line, a)) in starts.iter().enumerate().rev() {
            let until = starts.get(j + 1).map_or(f64::INFINITY, |s| s.1);
            // what the pedal stands at where the word starts, and whether it is new there
            let at = vibrato.partition_point(|p| grid(p.0) <= a);
            let (mut v, landed) = match at.checked_sub(1).map(|i| vibrato[i]) {
                Some(p) => (p.1, j == 0 || grid(p.0) == a),
                None => (1.0, false),
            };
            let mut steps = Vec::new();
            if landed && !(j == 0 && v == 1.0) {
                steps.push(fmt(v));
            }
            let mut pos = a;
            for p in vibrato[at..].iter().take_while(|p| grid(p.0) < until) {
                steps.push(format!("{}:{}", fmt(v), fmt((grid(p.0) - pos) / 1e6)));
                steps.push(fmt(p.1));
                (v, pos) = (p.1, grid(p.0));
            }
            if !steps.is_empty() {
                out.insert(line, format!("vibrato {}", steps.join(" ")));
            }
        }
        return Ok(out.join("\n") + "\n");
    }
    err("the words' syllables do not settle with the rests the notes leave")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rnd_is_room_js() {
        // node: const r = rng("3 perform"); [r.uniform(), r.uniform(), r.int(-2, 2), r.between(-1, 1)]
        let mut r = Rnd::new("3 perform");
        let got = [r.uniform(), r.uniform(), r.int(-2.0, 2.0), r.between(-1.0, 1.0)];
        assert_eq!(got, [0.6419031659606844, 0.3271235160063952, 0.0, 0.2629675781354308]);
    }

    #[test]
    fn fixed_is_to_fixed() {
        assert_eq!(fixed(0.0078125, 6), "0.007813");
        assert_eq!(fixed(-0.0078125, 6), "-0.007813");
        assert_eq!(fixed(2.5, 0), "3");
        assert_eq!(fixed(1.0005, 3), "1.000");
        assert_eq!(fixed(-0.0, 3), "0.000");
        assert_eq!(fixed(-1e-9, 3), "-0.000");
        assert_eq!(fixed(12.3456789, 3), "12.346");
        assert_eq!(fixed(0.5, 0), "1");
        assert_eq!(fixed(0.125, 2), "0.13");
        assert_eq!(fixed(1.005, 2), "1.00");
        assert_eq!(fmt(10.0), "10");
        assert_eq!(fmt(0.5), "0.5");
        assert_eq!(fmt(0.0000001), "0");
        assert_eq!(fmt(1.0 / 3.0), "0.333333");
    }

    fn one(_: &[Option<&str>], _: usize) -> Result<usize> {
        Ok(1)
    }

    fn key(pitch: f32, start: f64, beats: f64) -> Key {
        Key { pitch, start, beats }
    }

    #[test]
    fn roll_writes_the_pedal_before_each_word() {
        let keys = [key(60.0, 1.0, 1.0), key(62.0, 2.0, 1.0), key(64.0, 3.0, 1.5), key(65.0, 5.0, 1.0)];
        let lane = |text: &str| crate::sing::Song::parse(text).unwrap().vibrato;
        // none: the song as it was
        assert_eq!(roll(90.0, 0.0, &keys, "the wide_ sea", &[], 0.0, &mut one).unwrap(), "bpm 90\nrest 1\nthe 60:1\nwide 62:1+64:1.5\nrest 0.5\nsea 65:1\n");
        // set before the first note, moved inside the held word, and again on the last word's beat
        let text = roll(90.0, 0.0, &keys, "the wide_ sea", &[(-3.0, 0.0), (2.5, 0.5), (3.0, 2.0), (5.0, 1.0)], 0.0, &mut one).unwrap();
        assert_eq!(text, "bpm 90\nrest 1\nvibrato 0\nthe 60:1\nvibrato 0:0.5 0.5 0.5:0.5 2\nwide 62:1+64:1.5\nrest 0.5\nvibrato 1\nsea 65:1\n");
        let l = lane(&text);
        for (beat, v) in [(0.5, 1.0), (1.0, 0.0), (2.49, 0.0), (2.51, 0.5), (2.99, 0.5), (3.01, 2.0), (4.99, 2.0), (5.0, 1.0), (9.0, 1.0)] {
            assert_eq!(l.at(beat), v, "beat {beat}: {l:?}");
        }
        // a point in a rest goes with the word before it, as one after the last note does
        let text = roll(90.0, 0.0, &keys, "the wide_ sea", &[(4.75, 0.25), (5.5, 1.5), (7.0, 0.0)], 0.0, &mut one).unwrap();
        assert_eq!(text, "bpm 90\nrest 1\nthe 60:1\nvibrato 1:2.75 0.25\nwide 62:1+64:1.5\nrest 0.5\nvibrato 0.25:0.5 1.5 1.5:1.5 0\nsea 65:1\n");
        let l = lane(&text);
        for (beat, v) in [(1.0, 1.0), (4.7, 1.0), (4.8, 0.25), (5.0, 0.25), (5.6, 1.5), (7.5, 0.0)] {
            assert_eq!(l.at(beat), v, "beat {beat}: {l:?}");
        }
        // the song from another beat: the pedal's beats are the notes'
        let text = roll(90.0, -1.0, &keys[..1], "the", &[(1.5, 0.5)], 0.0, &mut one).unwrap();
        assert_eq!(text, "bpm 90\nrest 2\nvibrato 1:0.5 0.5\nthe 60:1\n");
        for bad in [vec![(1.0, -0.5)], vec![(1.0, 0.5), (1.0, 0.75)], vec![(2.0, 0.5), (1.0, 0.75)], vec![(f64::NAN, 1.0)]] {
            assert!(roll(90.0, 0.0, &keys, "the wide_ sea", &bad, 0.0, &mut one).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn roll_writes_rests_and_holds() {
        let keys = [key(60.0, 1.0, 0.9), key(62.0, 2.0, 1.0), key(64.0, 3.0, 1.5), key(65.0, 5.0, 1.0)];
        let text = roll(90.0, 0.0, &keys, "the wide_ sea", &[], 0.0, &mut one).unwrap();
        assert_eq!(text, "bpm 90\nrest 1\nthe 60:0.9\nrest 0.1\nwide 62:1+64:1.5\nrest 0.5\nsea 65:1\n");
        // a note still sounding ends where the next starts
        let keys = [key(60.0, 0.0, 2.0), key(62.0, 1.0, 1.0)];
        assert_eq!(roll(120.0, 0.0, &keys, "a b", &[], 0.0, &mut one).unwrap(), "bpm 120\na 60:1\nb 62:1\n");
        // a gap between words is a rest unless it is short enough to join
        let keys = [key(60.0, 0.0, 0.9), key(62.0, 1.0, 0.5), key(64.0, 2.0, 1.0)];
        assert_eq!(roll(120.0, 0.0, &keys, "a b c", &[], 0.0, &mut one).unwrap(), "bpm 120\na 60:0.9\nrest 0.1\nb 62:0.5\nrest 0.5\nc 64:1\n");
        assert_eq!(roll(120.0, 0.0, &keys, "a b c", &[], 0.125, &mut one).unwrap(), "bpm 120\na 60:1\nb 62:0.5\nrest 0.5\nc 64:1\n");
        // a song from a beat of the notes' own count, before 0 as well; what is wrong is said in that count
        let keys = [key(60.0, 33.0, 1.0), key(62.0, 34.5, 1.0)];
        assert_eq!(roll(120.0, 30.0, &keys, "a b", &[], 0.0, &mut one).unwrap(), "bpm 120\nrest 3\na 60:1\nrest 0.5\nb 62:1\n");
        assert_eq!(roll(120.0, 33.0, &keys[..1], "a", &[], 0.0, &mut one).unwrap(), "bpm 120\na 60:1\n");
        assert_eq!(roll(120.0, -2.0, &[key(60.0, 0.0, 1.0)], "a", &[], 0.0, &mut one).unwrap(), "bpm 120\nrest 2\na 60:1\n");
        assert!(roll(120.0, 30.0, &keys, "a", &[], 0.0, &mut one).unwrap_err().0.contains("the words run out at beat 34.5"));
        assert!(roll(120.0, 33.5, &keys, "a b", &[], 0.0, &mut one).unwrap_err().0.contains("a note at beat 33: 33.5 or later"));
    }

    #[test]
    fn roll_splits_a_word() {
        let mut two = |items: &[Option<&str>], k: usize| Ok(if items[k] == Some("water") { 2 } else { 1 });
        let keys = [key(60.0, 0.0, 1.0), key(62.0, 1.0, 0.5), key(64.0, 2.0, 1.0), key(65.0, 3.0, 1.0)];
        assert_eq!(roll(60.0, 0.0, &keys, "wa_-ter is", &[], 0.0, &mut two).unwrap(), "bpm 60\nwater 60:1+62:1 64:1\nis 65:1\n");
        assert_eq!(roll(60.0, 0.0, &keys[..3], "water wide", &[], 0.0, &mut two).unwrap(), "bpm 60\nwater 60:1 62:0.5\nrest 0.5\nwide 64:1\n");
        let e = roll(60.0, 0.0, &keys, "wa-te-r is", &[], 0.0, &mut two).unwrap_err();
        assert!(e.0.contains("written in 3 syllables, sung in 2"), "{}", e.0);
    }

    #[test]
    fn roll_refuses() {
        let keys = [key(60.0, 0.0, 1.0), key(62.0, 1.0, 1.0)];
        let e = roll(60.0, 0.0, &keys, "a b c", &[], 0.0, &mut one).unwrap_err();
        assert!(e.0.contains("the notes run out at \"c\" (word 3)"), "{}", e.0);
        let e = roll(60.0, 0.0, &keys, "a", &[], 0.0, &mut one).unwrap_err();
        assert!(e.0.contains("the words run out at beat 1"), "{}", e.0);
        let e = roll(60.0, 0.0, &[key(60.0, 0.0, 1.0), key(64.0, 0.0, 1.0)], "a b", &[], 0.0, &mut one).unwrap_err();
        assert!(e.0.contains("two notes start at beat 0"), "{}", e.0);
        assert!(roll(60.0, 0.0, &keys, "_ a", &[], 0.0, &mut one).is_err());
        assert!(roll(60.0, 0.0, &keys, "", &[], 0.0, &mut one).is_err());
    }

    #[test]
    fn roll_recounts_with_its_rests() {
        // a word sung in two syllables only after a rest
        let mut c = |items: &[Option<&str>], k: usize| Ok(if k > 0 && items[k - 1].is_none() { 2 } else { 1 });
        let keys = [key(60.0, 0.0, 1.0), key(62.0, 2.0, 1.0), key(64.0, 3.0, 1.0)];
        assert_eq!(roll(60.0, 0.0, &keys, "a bless'd", &[], 0.0, &mut c).unwrap(), "bpm 60\na 60:1\nrest 1\nbless'd 62:1 64:1\n");
        let mut calls = 0;
        let mut c = |items: &[Option<&str>], k: usize| {
            calls += 1;
            Ok(if items[k].is_some() { 1 } else { 0 })
        };
        assert_eq!(roll(60.0, 0.0, &keys[..2], "a b", &[], 0.0, &mut c).unwrap(), "bpm 60\na 60:1\nrest 1\nb 62:1\n");
        assert_eq!(calls, 4);
    }

    #[test]
    fn parse_and_plan_keep_a_song() {
        let text = "bpm 84\nrest 2\nThe 60:1\nwater 60:1 60:0.5\nrest 0.01\nis 62:0.5\nrest 1\nwide 62:2\nrest 1\n";
        let song = parse(text).unwrap();
        assert_eq!(song.phrases.len(), 3);
        assert_eq!(song.tail, 1.0);
        let b = Breathing { sex: 'F', lib: None, want: &|_| false, deck: &|_| String::new(), turn: 0, give: None };
        let (out, reqs) = plan(&song, &b, &HashMap::new(), &mut HashMap::new()).unwrap();
        // the rest too short for an onset is held by the note before
        assert_eq!(out, "bpm 84\nrest 2\nThe 60:1\nwater 60:1 60:0.51\nis 62:0.5\nrest 1\nwide 62:2\nrest 1\n");
        assert!(reqs.is_empty());
    }

    #[test]
    fn plan_makes_room_for_a_breath() {
        let lib = Library::new(vec![Clip { id: "a".into(), sex: 'F', at: 0, n: 9600 }, Clip { id: "b".into(), sex: 'M', at: 9600, n: 4800 }]).unwrap();
        let song = parse("bpm 60\nla 60:2\nrest 0.25\nla 62:1\n").unwrap();
        let b = Breathing { sex: 'F', lib: Some(&lib), want: &|j| j == 1, deck: &|_| "0.000".into(), turn: 5, give: None };
        let mut pins = HashMap::new();
        let (out, reqs) = plan(&song, &b, &HashMap::new(), &mut pins).unwrap();
        // 0.4 s of breath, 0.07 before it and 0.25 for the onset: 0.72 beats, 0.47 of them from the note
        assert_eq!(out, "bpm 60\nla 60:1.53\nrest 0.72\nla 62:1\n");
        assert_eq!(reqs, vec![Req { rest: 1, clip: 0, j: 1, room: 0.72 }]);
        assert_eq!(pins.get(&1), Some(&0));
        let short = deficits(&[(0.0, 0.1), (1.63, 2.0)], &reqs, &lib).unwrap();
        assert!((short[&1] - 0.13).abs() < 1e-9);
    }
}
