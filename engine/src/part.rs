// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A singer's part. `roll` writes a piano roll's notes and the words under them as a song (the
//! format sing.rs reads). `perform` sings a song as a person does, as the page's choirs and the
//! editor's singers are sung (through the wasm's ls_perform): each phrase a few frames off the beat
//! and its notes pulled about inside it, the pitch a few cents off, and breaths taken in the rests,
//! room made for them by shortening the note before. It was web/perform.js's to the letter, its
//! arithmetic operation for operation in f64, and is now the only copy (tests/perform.rs has that
//! file's checks).
//!
//! The words of a roll: a word takes a note a syllable, as the engine says it. Hyphens may split
//! a word into its syllables (`wa-ter`), and each `_` after a syllable holds it over one more
//! note (`wide__`, `wa_-ter`; a `_` standing alone holds the word before it). A note runs to the
//! next note's start inside a word, and no further than it between words; what is left between
//! words is a rest. `roll_under` is the roll for notes still being written: a note past the words
//! sings a word of its own that it is given (a singer's "oo"), and words past the notes wait
//! unsung. `align` and `carry` keep each syllable under its note when the notes change.

use std::collections::HashMap;

use crate::diction::{Rules, Who};
use crate::front::{self, Phonemizer};
use crate::json::Json;
use crate::song;
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
    /// The song's %diction lines (diction.rs), as written: the engine reads them.
    pub diction: Vec<String>,
    /// The song has its %together line.
    pub together: bool,
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

/// The song's phrases (song::read), its notes kept as written.
pub fn parse(text: &str) -> Result<Written> {
    let read = song::read(text)?;
    let (mut open, mut tail, mut together) = (false, 0.0f64, false);
    let mut lane: Vec<Laned> = Vec::new();
    let mut phrases: Vec<Phrase> = Vec::new();
    let mut diction = Vec::new();
    for l in &read.lines {
        match &l.line {
            song::Line::Bpm(_) => {}
            song::Line::Together => together = true,
            song::Line::Diction(f) => diction.push(format!("%diction {}", f.join(" "))),
            song::Line::Rest(b) => {
                for c in &mut lane {
                    c.back += b;
                }
                open = false;
                tail = l.beat + b - phrases.last().map_or(l.beat + b, Phrase::end);
            }
            song::Line::Vibrato(sizes) => lane.push(Laned { line: format!("%vibrato {}", sizes.iter().map(|z| z.text).collect::<Vec<_>>().join(" ")), back: 0.0 }),
            song::Line::Word { word, braces, notes } => {
                let groups = notes.iter().map(|g| g.iter().map(|x| Tone { pitch: x.note.to_string(), beats: x.beats }).collect()).collect();
                if !open {
                    phrases.push(Phrase { start: l.beat, words: Vec::new() });
                    open = true;
                }
                let word = match braces {
                    Some(b) => format!("{word}{{{b}}}"),
                    None => word.to_string(),
                };
                phrases.last_mut().unwrap().words.push(Word { word, groups, lane: std::mem::take(&mut lane) });
                tail = 0.0;
            }
        }
    }
    Ok(Written { bpm: read.bpm, phrases, tail, after: lane.into_iter().map(|c| c.line).collect(), diction, together })
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
    (Written { bpm: song.bpm, phrases, tail: song.tail, after: song.after.clone(), diction: song.diction.clone(), together: song.together }, offs[0] / FPS)
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
    let mut out = vec![format!("%bpm {}", fmt(song.bpm))];
    if song.together {
        out.push("%together".to_string());
    }
    out.extend(song.diction.iter().cloned());
    for (j, ph) in phrases.iter().enumerate() {
        let mut left = gaps[j]; // beats of the rest before the phrase still to write
        for (k, w) in ph.words.iter().enumerate() {
            for c in &w.lane {
                let r = left - c.back.min(left);
                if fmt(r) != "0" {
                    out.push(format!("%rest {}", fmt(r)));
                    left -= r;
                }
                out.push(c.line.clone());
            }
            if k == 0 && left > 0.0 {
                out.push(format!("%rest {}", fmt(left)));
                left = 0.0;
            }
            out.push(line(w));
        }
    }
    out.extend(song.after.iter().cloned());
    if song.tail > 0.0 {
        out.push(format!("%rest {}", fmt(song.tail)));
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
    let text = std::fs::read_to_string(path).map_err(|e| Error(format!("{path}: {e}")))?;
    let bin = format!("{stem}.bin");
    let bytes = std::fs::read(&bin).map_err(|e| Error(format!("{bin}: {e}")))?;
    breaths_of(path, &text, &bin, &bytes)
}

/// breaths, from the index's text and the sound's bytes; `path` and `bin` name them in errors.
pub fn breaths_of(path: &str, text: &str, bin: &str, bytes: &[u8]) -> Result<(Library, Vec<i16>)> {
    let bad = |e: Error| Error(format!("{path}: {}", e.0));
    let j = Json::parse(text).map_err(bad)?;
    let sr = j.get("sr").and_then(Json::num).map_err(bad)?;
    if sr != SR {
        return err(format!("{path}: breaths at {sr} Hz, not {SR}"));
    }
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
pub struct Manner<'a> {
    /// Its timing drawn by the piece's moments, as every such part's (Timing::Moments). Its singer
    /// is then opened on the song `clocked`.
    pub together: bool,
    /// Breathing::give.
    pub give: Option<f64>,
    /// By phrase, a breath marked before it (the editor's breath marks): Some(true) always, Some(false)
    /// never, whatever the part's chance. A breath marked that does not fit its rest is refused.
    pub wants: &'a [Option<bool>],
}

/// A song with the line that has its singer keep the others' clock (sing::Song::together), after
/// its bpm: what a part performed together is opened on.
pub fn clocked(text: &str) -> Result<String> {
    let read = song::read(text)?;
    if read.together() {
        return Ok(text.to_string());
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    lines.insert(read.bpm_line, "%together");
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
    let want = |j: usize| match manner.wants.get(j).copied().flatten() {
        Some(w) => w,
        None => Rnd::new(&format!("breath {}", moment(j))).uniform() < part.breath,
    };
    let b = Breathing { sex: part.sex, lib, want: &want, deck: &moment, turn: part.seed as i64, give: manner.give };
    let (mut margins, mut pins) = (HashMap::new(), HashMap::new());
    for _ in 0..ATTEMPTS {
        let (text, reqs) = plan(&sung, &b, &margins, &mut pins)?;
        if let Some(j) = manner.wants.iter().enumerate().position(|(j, w)| *w == Some(true) && !reqs.iter().any(|q| q.j == j)) {
            return err(format!("phrase {j} (from 0): the breath marked does not fit: no breath is short enough for the time the note before can give"));
        }
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
/// syllables (hyphens), or the notes it holds past its last (`_`) where it does not; and the
/// text's tokens it is written in: its own, then those up to the next word (its holds standing
/// alone, and marks that are no word).
struct Lyric {
    word: String,
    split: Option<Vec<usize>>,
    held: usize,
    toks: std::ops::Range<usize>,
}

/// The marks about a word that are not of it.
const MARKS: &str = ".,;:!?\"()\u{201c}\u{201d}";

/// A text's tokens, each with the white space before it; and the white space after the last.
fn tokens(text: &str) -> (Vec<(&str, &str)>, &str) {
    let (mut out, mut rest) = (Vec::new(), text);
    loop {
        let body = rest.trim_start();
        let before = &rest[..rest.len() - body.len()];
        if body.is_empty() {
            return (out, before);
        }
        let n = body.find(char::is_whitespace).unwrap_or(body.len());
        out.push((before, &body[..n]));
        rest = &body[n..];
    }
}

/// A text's words; none of a text with no word in it.
fn lyric(words: &str) -> Result<Vec<Lyric>> {
    let mut out: Vec<Lyric> = Vec::new();
    for (i, (_, tok)) in tokens(words).0.into_iter().enumerate() {
        let t = tok.trim_matches(|c: char| MARKS.contains(c));
        if t.is_empty() || t.chars().all(|c| c == '_') {
            match out.last_mut() {
                Some(w) => {
                    w.toks.end = i + 1;
                    match &mut w.split {
                        Some(s) => *s.last_mut().unwrap() += t.len(),
                        None => w.held += t.len(),
                    }
                }
                None if !t.is_empty() => return err(format!("{tok}: a held note with no word before it")),
                None => {}
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
            out.push(Lyric { word, split: None, held: pieces[0].1, toks: i..i + 1 });
        } else {
            out.push(Lyric { word, split: Some(pieces.iter().map(|p| 1 + p.1).collect()), held: 0, toks: i..i + 1 });
        }
    }
    Ok(out)
}

/// The syllables `who` sings word `k` of a song's lines in by the song's diction (`items`: each
/// line's word, a rest's None), as sing::plan counts them.
pub fn syllables(ph: &mut Phonemizer, rules: &Rules, who: &Who, items: &[Option<&str>], k: usize) -> Result<usize> {
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
    let phones = ph.phones_in(&said[k], &low, k)?;
    Ok(rules.count(who, &low, k, &phones))
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
    let vibrato: Vec<Point> = vibrato.iter().map(|&p| p.into()).collect();
    Ok(roll_under(bpm, from, keys, words, &vibrato, join, None, count)?.song)
}

/// A point of the pedal: at its beat the vibrato's size becomes `size` and holds there until the
/// next. With `line` it has instead moved there in a straight line from the point before,
/// reaching `size` at the beat. Two points share a beat only where the first is reached by a line
/// and the second is not (the size arrives, then jumps); the first point is reached by no line.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub beat: f64,
    pub size: f64,
    pub line: bool,
}

impl From<(f64, f64)> for Point {
    fn from(p: (f64, f64)) -> Point {
        Point { beat: p.0, size: p.1, line: false }
    }
}

impl PartialEq<(f64, f64)> for Point {
    fn eq(&self, p: &(f64, f64)) -> bool {
        *self == Point::from(*p)
    }
}

/// Whether a pedal's points are one: each a beat and a size of 0 or more, in the order of their
/// beats (as `same` tells two beats apart), and where two share one, the first reached by a line
/// and the second not.
pub fn pedal(points: &[Point], same: &dyn Fn(f64, f64) -> bool) -> Result<()> {
    for (i, p) in points.iter().enumerate() {
        if !(p.beat.is_finite() && p.size >= 0.0 && p.size.is_finite()) {
            return err(format!("the pedal at beat {}: a vibrato {} times the size", p.beat, p.size));
        }
        let Some(q) = i.checked_sub(1).map(|k| points[k]) else {
            if p.line {
                return err(format!("the pedal at beat {}: the first point is reached by no line", fmt(p.beat)));
            }
            continue;
        };
        if same(q.beat, p.beat) {
            if p.line || !q.line || (i > 1 && same(points[i - 2].beat, p.beat)) {
                return err(format!("the pedal at beat {}: two points share a beat only where the first is reached by a line and the second is not", fmt(p.beat)));
            }
        } else if p.beat < q.beat {
            return err(format!("the pedal at beat {}: not after the point before it", fmt(p.beat)));
        }
    }
    Ok(())
}

/// Where a pedal stands at a beat: the size it has arrived at there, and the size it leaves at
/// (another only where it jumps on the beat). 1 before the first point.
pub fn stands(points: &[Point], beat: f64) -> (f64, f64) {
    // between a point and the next, which is past the beat
    let between = |p: Point, q: Point| if q.line { p.size + (q.size - p.size) * (beat - p.beat) / (q.beat - p.beat) } else { p.size };
    let before = points.partition_point(|p| p.beat < beat);
    let upto = points.partition_point(|p| p.beat <= beat);
    let arrives = match (before.checked_sub(1).map(|k| points[k]), points.get(before)) {
        (None, _) => 1.0,
        (Some(p), None) => p.size,
        (Some(_), Some(q)) if q.beat == beat && q.line => q.size,
        (Some(p), Some(q)) if q.beat > beat => between(p, *q),
        (Some(p), Some(_)) => p.size,
    };
    let leaves = match (upto.checked_sub(1).map(|k| points[k]), points.get(upto)) {
        (None, _) => 1.0,
        (Some(p), Some(q)) if p.beat < beat => between(p, *q),
        (Some(p), _) => p.size,
    };
    (arrives, leaves)
}

/// A roll as a song, and how its words fell under its notes.
#[derive(Clone, Debug, PartialEq)]
pub struct Rolled {
    pub song: String,
    /// Of each word sung, in the words' order: the notes each of its syllables takes.
    pub groups: Vec<Vec<usize>>,
    /// The words past the notes, unsung; and the notes past the words, each sung on the fill.
    pub unsung: usize,
    pub filled: usize,
}

/// `roll`, of notes and words that need not fit when `fill` is a word (a singer's "oo"): the
/// words go under the notes in order, a word the notes run out on and those after it wait unsung,
/// and each note left past the words sings `fill`, a word of one syllable. With no `fill`, words
/// and notes that do not fit are refused, as a text with no word is.
#[allow(clippy::too_many_arguments)]
pub fn roll_under(bpm: f64, from: f64, keys: &[Key], words: &str, vibrato: &[Point], join: f64, fill: Option<&str>, count: &mut dyn FnMut(&[Option<&str>], usize) -> Result<usize>) -> Result<Rolled> {
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
    pedal(vibrato, &|a, b| grid(a) == grid(b))?;
    // the pedal on the grid the words' starts are on
    let vibrato: Vec<Point> = vibrato.iter().map(|p| Point { beat: grid(p.beat), ..*p }).collect();
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
    if lyr.is_empty() && fill.is_none() {
        return err("the part has no words");
    }
    if keys.is_empty() && fill.is_some() {
        return err("the part has no notes");
    }
    let names: Vec<&str> = lyr.iter().map(|l| l.word.as_str()).collect();
    // a word's line starts with its word: one that starts as an instruction or a comment does is no word
    if let Some(w) = names.iter().chain(fill.iter()).find(|w| w.starts_with(['%', '#'])) {
        return err(format!("{w}: a word to sing does not start with % or #"));
    }
    // each word's syllables as the engine says them: first with no rests known, then with the rests
    // the notes leave, until the two agree
    let mut items: Vec<Option<&str>> = names.iter().map(|w| Some(*w)).collect();
    let mut at: Vec<usize> = (0..lyr.len()).collect(); // each word's place among the items
    // the words that have notes: fewer, with a fill, once the notes run out on one
    let mut limit = lyr.len();
    let one = vec![1usize];
    for _ in 0..6 {
        // each word's notes a syllable; what is wrong with them is said once the rests have settled
        let (mut groups, mut wrong) = (Vec::<Vec<usize>>::new(), None);
        for (i, l) in lyr[..limit].iter().enumerate() {
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
        // the notes run out here: the words from here on go unsung
        let mut took = 0;
        let short = groups.iter().position(|g| {
            took += g.iter().sum::<usize>();
            took > keys.len()
        });
        if let (Some(i), Some(_)) = (short, fill) {
            limit = i;
            groups.truncate(i);
        }
        let need: usize = groups.iter().flatten().sum();
        let sung = short.unwrap_or(groups.len()).min(groups.len());
        let filled = if fill.is_some() { keys.len() - need } else { 0 };
        let lines = groups[..sung].iter().enumerate().map(|(i, g)| (names[i], g)).chain(fill.into_iter().flat_map(|f| (0..filled).map(move |_| f)).map(|f| (f, &one)));
        let mut out = vec![format!("%bpm {}", fmt(bpm))];
        let (mut next, mut k) = (Vec::new(), 0);
        let mut pos = grid(from); // the grid place written up to
        let mut starts = Vec::new(); // each word's line, and the grid place it starts at
        let mut fills = Vec::new(); // the places among the items of the words that are the fill
        for (i, (name, g)) in lines.enumerate() {
            let stop = k + g.iter().sum::<usize>(); // past the word's last note
            if grid(keys[k].start) > pos {
                out.push(format!("%rest {}", fmt((grid(keys[k].start) - pos) / 1e6)));
                next.push(None);
            }
            if i < sung {
                at[i] = next.len();
            } else {
                fills.push(next.len());
            }
            next.push(Some(name));
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
            out.push(format!("{name} {}", syls.join(" ")));
        }
        // with no fill, the words past the notes are still words the engine reads the others beside
        for i in sung..groups.len() {
            at[i] = next.len();
            next.push(Some(names[i]));
        }
        if next != items {
            items = next;
            continue;
        }
        if let Some(e) = wrong {
            return err(e);
        }
        if let Some(i) = short.filter(|_| fill.is_none()) {
            return err(format!("the words take {need} notes and the part has {}: the notes run out at \"{}\" (word {})", keys.len(), lyr[i].word, i + 1));
        }
        if need < keys.len() && fill.is_none() {
            return err(format!("the words take {need} notes and the part has {}: the words run out at beat {}", keys.len(), fmt(keys[need].start)));
        }
        for &f in &fills {
            if count(&items, f)? != 1 {
                return err(format!("{}: a note with no word sings it, and it is not one syllable", fill.unwrap_or_default()));
            }
        }
        // last word first: a line put in moves the lines after it alone
        for (j, &(line, a)) in starts.iter().enumerate().rev() {
            let until = starts.get(j + 1).map_or(f64::INFINITY, |s| s.1);
            // what the pedal stands at where the word starts, and whether it is new there: the
            // first word's is, and one the pedal is put at on the word's beat
            let at = vibrato.partition_point(|p| p.beat <= a);
            let mut v = stands(&vibrato, a).1;
            let landed = if j == 0 { v != 1.0 } else { at > 0 && vibrato[at - 1].beat == a && !vibrato[at - 1].line };
            let mut steps = Vec::new();
            if landed {
                steps.push(fmt(v));
            }
            let mut pos = a;
            let over = |from: f64, to: f64| fmt((to - from) / 1e6);
            for p in vibrato[at..].iter().take_while(|p| p.beat < until) {
                if p.line {
                    steps.push(format!("{}:{}", fmt(p.size), over(pos, p.beat)));
                } else {
                    if p.beat > pos {
                        steps.push(format!("{}:{}", fmt(v), over(pos, p.beat)));
                    }
                    steps.push(fmt(p.size));
                }
                (v, pos) = (p.size, p.beat);
            }
            // a line still on its way where the next word starts: as far as it has come there
            if until.is_finite() && vibrato.iter().find(|p| p.beat >= until).is_some_and(|p| p.line) {
                steps.push(format!("{}:{}", fmt(stands(&vibrato, until).0), over(pos, until)));
            }
            if !steps.is_empty() {
                out.insert(line, format!("%vibrato {}", steps.join(" ")));
            }
        }
        return Ok(Rolled { song: out.join("\n") + "\n", groups, unsung: lyr.len() - sung, filled });
    }
    err("the words' syllables do not settle with the rests the notes leave")
}

/// What two notes that are not one and the same cost to take for each other, and what a note
/// with no other to be costs: less than a pair costs at its worst is more than two alone would,
/// so as many notes as both sides have are paired.
const APART: f32 = 1.2;

/// Which of the notes as they were (`was`) each note is now, as a diff lines one text up with
/// another: in their order, as many as both have, those left without one the ones that fit
/// worst. Two notes fit by pitch, by where they start (a beat apart is as far as apart gets) and
/// by how long they are.
pub fn align(was: &[Key], now: &[Key]) -> Vec<Option<usize>> {
    let (n, m) = (was.len(), now.len());
    let cost = |a: &Key, b: &Key| (a.pitch != b.pitch) as u8 as f32 + ((a.start - b.start).abs().min(1.0)) as f32 + 0.25 * ((a.beats - b.beats).abs() > 1e-6) as u8 as f32;
    // d[i][j]: the least the first i of was and the first j of now cost
    let w = m + 1;
    let mut d = vec![0f32; (n + 1) * w];
    for i in 0..=n {
        for j in 0..=m {
            d[i * w + j] = match (i, j) {
                (0, _) => j as f32 * APART,
                (_, 0) => i as f32 * APART,
                _ => (d[(i - 1) * w + j - 1] + cost(&was[i - 1], &now[j - 1])).min(d[(i - 1) * w + j] + APART).min(d[i * w + j - 1] + APART),
            };
        }
    }
    let mut out = vec![None; m];
    let (mut i, mut j) = (n, m);
    while i > 0 && j > 0 {
        if d[i * w + j] == d[(i - 1) * w + j - 1] + cost(&was[i - 1], &now[j - 1]) {
            out[j - 1] = Some(i - 1);
            (i, j) = (i - 1, j - 1);
        } else if d[i * w + j] == d[(i - 1) * w + j] + APART {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    out
}

/// A word's letters in `n` written syllables, for a word the engine sings in more syllables than
/// it is written in: cut between its groups of vowels (one consonant goes with the vowels after
/// it, more are shared), and by its length where it has too few groups. None of a word with
/// fewer letters than syllables.
pub fn spell(word: &str, n: usize) -> Option<Vec<String>> {
    let cs: Vec<char> = word.chars().collect();
    if n == 0 || cs.len() < n {
        return None;
    }
    let vowel = |c: char| "aeiouyAEIOUY".contains(c);
    let mut groups: Vec<(usize, usize)> = Vec::new(); // each run of vowels: from, to
    for (i, &c) in cs.iter().enumerate() {
        match groups.last_mut() {
            Some(g) if vowel(c) && g.1 == i => g.1 = i + 1,
            _ if vowel(c) => groups.push((i, i + 1)),
            _ => {}
        }
    }
    let cuts: Vec<usize> = if groups.len() >= n {
        (1..n).map(|g| groups[g - 1].1 + (groups[g].0 - groups[g - 1].1) / 2).collect()
    } else {
        (1..n).map(|k| k * cs.len() / n).collect()
    };
    let edges: Vec<usize> = std::iter::once(0).chain(cuts).chain([cs.len()]).collect();
    Some(edges.windows(2).map(|e| cs[e[0]..e[1]].iter().collect()).collect())
}

/// What is under each of a roll's `notes` notes, for a page that shows them: a syllable as it is
/// written, with a hyphen after it where its word goes on (a word the engine splits and its
/// writer did not is cut by its letters); `_` where the note holds the syllable before it; and
/// `fill` under a note past the words. `groups` are the roll's (`Rolled::groups`).
pub fn under(words: &str, groups: &[Vec<usize>], notes: usize, fill: &str) -> Result<Vec<String>> {
    let lyr = lyric(words)?;
    if groups.len() > lyr.len() {
        return err(format!("{} words sung of a text of {}", groups.len(), lyr.len()));
    }
    let toks = tokens(words).0;
    let mut out = Vec::with_capacity(notes);
    for (l, g) in lyr.iter().zip(groups) {
        let pieces: Vec<String> = match &l.split {
            Some(_) => toks[l.toks.start].1.trim_matches(|c: char| MARKS.contains(c)).split('-').map(|p| p.trim_end_matches('_').to_string()).collect(),
            // a word too short to cut is under its first note, whole
            None => spell(&l.word, g.len()).unwrap_or_else(|| std::iter::once(l.word.clone()).chain((1..g.len()).map(|_| String::new())).collect()),
        };
        if pieces.len() != g.len() {
            return err(format!("{}: written in {} syllables, sung in {}", l.word, pieces.len(), g.len()));
        }
        for (s, (&n, piece)) in g.iter().zip(&pieces).enumerate() {
            out.push(if s + 1 < g.len() { format!("{piece}-") } else { piece.clone() });
            out.extend((1..n).map(|_| "_".to_string()));
        }
    }
    if out.len() > notes {
        return err(format!("the words sung take {} notes of {notes}", out.len()));
    }
    out.resize(notes, fill.to_string());
    Ok(out)
}

/// A text being written a token at a time: the white space before each as it was, but for the
/// first, and a line's break before a word that is gone kept for the next one written.
struct Text<'a> {
    out: String,
    started: bool,
    broke: Option<&'a str>,
}

impl<'a> Text<'a> {
    fn put(&mut self, before: &'a str, tok: &str) {
        let b = match self.broke.take() {
            Some(b) if !before.contains('\n') => b,
            _ => before,
        };
        if std::mem::replace(&mut self.started, true) {
            // the text's first word had none before it
            self.out.push_str(if b.is_empty() { " " } else { b });
        }
        self.out.push_str(tok);
    }
}

/// The words of a roll once its notes have changed, each syllable kept under its note. `groups`
/// are the roll's (`Rolled::groups`, of `words` under the notes as they were); `was[j]` is which
/// of those notes note j is now, or None of a new one (`align`). A note gone takes its syllable
/// with it. A new note inside a word holds the syllable before it; one between words, or before
/// them, sings `fill`; one after the last word is left to the words that wait, or to the fill.
/// A word that lost a syllable is written in what is left of it where the engine sings that in
/// as many syllables (`count`, the roll's); where it does not, its notes sing `fill`. The words
/// the roll left unsung stay as written, and so do the text's lines and its marks.
pub fn carry(words: &str, groups: &[Vec<usize>], was: &[Option<usize>], fill: &str, count: &mut dyn FnMut(&[Option<&str>], usize) -> Result<usize>) -> Result<String> {
    let (toks, tail) = tokens(words);
    let lyr = lyric(words)?;
    if groups.len() > lyr.len() {
        return err(format!("{} words sung of a text of {}", groups.len(), lyr.len()));
    }
    // each note as it was: the word and the syllable it sang
    let cell: Vec<(usize, usize)> = groups.iter().enumerate().flat_map(|(w, g)| g.iter().enumerate().flat_map(move |(s, &n)| (0..n).map(move |_| (w, s)))).collect();
    let of = |j: usize| was[j].and_then(|o| cell.get(o).copied());
    let Some(last) = (0..was.len()).rev().find(|&j| of(j).is_some()) else {
        // no note of the words is left: the words that waited are the words
        let from = lyr.get(groups.len()).map_or(toks.len(), |l| l.toks.start);
        let kept: String = toks[from..].iter().enumerate().map(|(i, (before, tok))| format!("{}{tok}", if i == 0 { "" } else { before })).collect();
        return Ok(if kept.is_empty() { String::new() } else { kept + tail });
    };
    // the notes each syllable has now, and the words and fills in the order they are sung
    let mut notes: Vec<Vec<usize>> = groups.iter().map(|g| vec![0; g.len()]).collect();
    let mut order: Vec<Option<usize>> = Vec::new();
    let mut seen = vec![false; groups.len()];
    let mut before: Option<(usize, usize)> = None;
    for j in 0..=last {
        match of(j) {
            Some((w, s)) => {
                notes[w][s] += 1;
                if !std::mem::replace(&mut seen[w], true) {
                    order.push(Some(w));
                }
                before = Some((w, s));
            }
            None => match (before, (j..=last).find_map(of)) {
                (Some((w, s)), Some((next, _))) if w == next => notes[w][s] += 1,
                _ => order.push(None),
            },
        }
    }
    let mut text = Text { out: String::new(), started: false, broke: None };
    let first = lyr.first().map_or(toks.len(), |l| l.toks.start);
    for (before, tok) in &toks[..first] {
        text.put(before, tok);
    }
    let mut next = 0; // the words written or let go so far
    for item in order {
        let Some(w) = item else {
            text.put(" ", fill);
            continue;
        };
        for l in &lyr[next..w] {
            if let Some((b, _)) = toks[l.toks.clone()].iter().find(|(b, _)| b.contains('\n')) {
                text.broke.get_or_insert(b);
            }
        }
        next = w + 1;
        let (l, own) = (&lyr[w], toks[lyr[w].toks.start]);
        if notes[w] == groups[w] {
            for (before, tok) in &toks[l.toks.clone()] {
                text.put(before, tok);
            }
            continue;
        }
        // written again: its marks stay about it, its holds are in it, the marks after it follow
        let core = own.1.trim_matches(|c: char| MARKS.contains(c));
        let at = own.1.find(core).unwrap_or(0);
        let (lead, trail) = (&own.1[..at], &own.1[at + core.len()..]);
        let pieces: Option<Vec<String>> = match &l.split {
            Some(_) => Some(core.split('-').map(|p| p.trim_end_matches('_').to_string()).collect()),
            None => spell(&l.word, groups[w].len()),
        };
        let left: Vec<usize> = (0..groups[w].len()).filter(|&s| notes[w][s] > 0).collect();
        let written = match pieces {
            Some(p) if p.len() == groups[w].len() => {
                let whole: String = left.iter().map(|&s| p[s].as_str()).collect();
                let sings = left.len() == groups[w].len() || count(&[Some(whole.as_str())], 0)? == left.len();
                sings.then(|| left.iter().map(|&s| format!("{}{}", p[s], "_".repeat(notes[w][s] - 1))).collect::<Vec<_>>().join("-"))
            }
            _ => None,
        };
        match written {
            Some(new) => text.put(own.0, &format!("{lead}{new}{trail}")),
            None => {
                let n: usize = notes[w].iter().sum();
                text.put(own.0, &vec![fill; n].join(" "));
            }
        }
        for (before, tok) in &toks[l.toks.start + 1..l.toks.end] {
            if !tok.trim_matches(|c: char| MARKS.contains(c)).chars().all(|c| c == '_') || tok.trim_matches(|c: char| MARKS.contains(c)).is_empty() {
                text.put(before, tok);
            }
        }
    }
    // the words that waited for notes
    for l in &lyr[next..groups.len()] {
        if let Some((b, _)) = toks[l.toks.clone()].iter().find(|(b, _)| b.contains('\n')) {
            text.broke.get_or_insert(b);
        }
    }
    let from = lyr.get(groups.len()).map_or(toks.len(), |l| l.toks.start);
    for (before, tok) in &toks[from..] {
        text.put(before, tok);
    }
    text.out.push_str(tail);
    Ok(text.out)
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
        assert_eq!(roll(90.0, 0.0, &keys, "the wide_ sea", &[], 0.0, &mut one).unwrap(), "%bpm 90\n%rest 1\nthe 60:1\nwide 62:1+64:1.5\n%rest 0.5\nsea 65:1\n");
        // set before the first note, moved inside the held word, and again on the last word's beat
        let text = roll(90.0, 0.0, &keys, "the wide_ sea", &[(-3.0, 0.0), (2.5, 0.5), (3.0, 2.0), (5.0, 1.0)], 0.0, &mut one).unwrap();
        assert_eq!(text, "%bpm 90\n%rest 1\n%vibrato 0\nthe 60:1\n%vibrato 0:0.5 0.5 0.5:0.5 2\nwide 62:1+64:1.5\n%rest 0.5\n%vibrato 1\nsea 65:1\n");
        let l = lane(&text);
        for (beat, v) in [(0.5, 1.0), (1.0, 0.0), (2.49, 0.0), (2.51, 0.5), (2.99, 0.5), (3.01, 2.0), (4.99, 2.0), (5.0, 1.0), (9.0, 1.0)] {
            assert_eq!(l.at(beat), v, "beat {beat}: {l:?}");
        }
        // a point in a rest goes with the word before it, as one after the last note does
        let text = roll(90.0, 0.0, &keys, "the wide_ sea", &[(4.75, 0.25), (5.5, 1.5), (7.0, 0.0)], 0.0, &mut one).unwrap();
        assert_eq!(text, "%bpm 90\n%rest 1\nthe 60:1\n%vibrato 1:2.75 0.25\nwide 62:1+64:1.5\n%rest 0.5\n%vibrato 0.25:0.5 1.5 1.5:1.5 0\nsea 65:1\n");
        let l = lane(&text);
        for (beat, v) in [(1.0, 1.0), (4.7, 1.0), (4.8, 0.25), (5.0, 0.25), (5.6, 1.5), (7.5, 0.0)] {
            assert_eq!(l.at(beat), v, "beat {beat}: {l:?}");
        }
        // the song from another beat: the pedal's beats are the notes'
        let text = roll(90.0, -1.0, &keys[..1], "the", &[(1.5, 0.5)], 0.0, &mut one).unwrap();
        assert_eq!(text, "%bpm 90\n%rest 2\n%vibrato 1:0.5 0.5\nthe 60:1\n");
        for bad in [vec![(1.0, -0.5)], vec![(1.0, 0.5), (1.0, 0.75)], vec![(2.0, 0.5), (1.0, 0.75)], vec![(f64::NAN, 1.0)]] {
            assert!(roll(90.0, 0.0, &keys, "the wide_ sea", &bad, 0.0, &mut one).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_pedal_that_moves_in_a_line_is_written_as_glides() {
        let keys = [key(60.0, 1.0, 1.0), key(62.0, 2.0, 1.0), key(64.0, 3.0, 1.5), key(65.0, 5.0, 1.0)];
        let pt = |beat: f64, size: f64, line: bool| Point { beat, size, line };
        let lane = |text: &str| crate::sing::Song::parse(text).unwrap().vibrato;
        let rolled = |pedal: &[Point]| roll_under(90.0, 0.0, &keys, "the wide_ sea", pedal, 0.0, None, &mut one).map(|r| r.song);
        // up through the first two words and half the held one, down at once, and up again through the rest into the last
        let pedal = [pt(1.0, 0.0, false), pt(3.5, 1.0, true), pt(3.5, 0.5, false), pt(4.0, 0.5, false), pt(6.0, 1.5, true)];
        let text = rolled(&pedal).unwrap();
        assert_eq!(text, "%bpm 90\n%rest 1\n%vibrato 0 0.4:1\nthe 60:1\n%vibrato 1:1.5 0.5 0.5:0.5 0.5 1:1\nwide 62:1+64:1.5\n%rest 0.5\n%vibrato 1.5:1\nsea 65:1\n");
        let l = lane(&text);
        for beat in [0.0, 0.5, 1.0, 1.5, 2.0, 2.75, 3.25, 3.75, 4.0, 4.5, 5.0, 5.5, 6.0, 7.0] {
            let (v, w) = (l.at(beat) as f64, stands(&pedal, beat as f64).1);
            assert!((v - w).abs() < 1e-6, "beat {beat}: {v}, the pedal {w}: {text}");
        }
        assert_eq!((stands(&pedal, 3.5), stands(&pedal, 0.5), stands(&pedal, 2.25), stands(&pedal, 6.0), stands(&pedal, 9.0)), ((1.0, 0.5), (1.0, 1.0), (0.5, 0.5), (1.5, 1.5), (1.5, 1.5)));
        // a song that starts inside a line starts where the line has come to
        let text = rolled(&[pt(0.0, 0.0, false), pt(2.0, 1.0, true)]).unwrap();
        assert_eq!(text, "%bpm 90\n%rest 1\n%vibrato 0.5 1:1\nthe 60:1\nwide 62:1+64:1.5\n%rest 0.5\nsea 65:1\n");
        // points that hold are written as they were
        let steps = [(-3.0, 0.0), (2.5, 0.5), (3.0, 2.0), (5.0, 1.0)];
        assert_eq!(rolled(&steps.map(Point::from)).unwrap(), roll(90.0, 0.0, &keys, "the wide_ sea", &steps, 0.0, &mut one).unwrap());
        for bad in [vec![pt(1.0, 0.5, true)], vec![pt(1.0, 0.5, false), pt(1.0, 0.75, true)], vec![pt(0.0, 1.0, false), pt(1.0, 0.5, false), pt(1.0, 0.75, false)], vec![pt(0.0, 1.0, false), pt(1.0, 0.5, true), pt(1.0, 0.75, false), pt(1.0, 0.8, false)], vec![pt(2.0, 0.5, false), pt(1.0, 0.75, true)]] {
            assert!(rolled(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn roll_writes_rests_and_holds() {
        let keys = [key(60.0, 1.0, 0.9), key(62.0, 2.0, 1.0), key(64.0, 3.0, 1.5), key(65.0, 5.0, 1.0)];
        let text = roll(90.0, 0.0, &keys, "the wide_ sea", &[], 0.0, &mut one).unwrap();
        assert_eq!(text, "%bpm 90\n%rest 1\nthe 60:0.9\n%rest 0.1\nwide 62:1+64:1.5\n%rest 0.5\nsea 65:1\n");
        // a note still sounding ends where the next starts
        let keys = [key(60.0, 0.0, 2.0), key(62.0, 1.0, 1.0)];
        assert_eq!(roll(120.0, 0.0, &keys, "a b", &[], 0.0, &mut one).unwrap(), "%bpm 120\na 60:1\nb 62:1\n");
        // the instructions' words are words to sing; a word that starts as an instruction does is refused
        assert_eq!(roll(120.0, 0.0, &keys[..2], "rest bpm", &[], 0.0, &mut one).unwrap(), "%bpm 120\nrest 60:1\nbpm 62:1\n");
        assert_eq!(roll(120.0, 0.0, &keys[..2], "a %rest", &[], 0.0, &mut one).unwrap_err().0, "%rest: a word to sing does not start with % or #");
        assert_eq!(roll(120.0, 0.0, &keys[..2], "#a b", &[], 0.0, &mut one).unwrap_err().0, "#a: a word to sing does not start with % or #");
        // a gap between words is a rest unless it is short enough to join
        let keys = [key(60.0, 0.0, 0.9), key(62.0, 1.0, 0.5), key(64.0, 2.0, 1.0)];
        assert_eq!(roll(120.0, 0.0, &keys, "a b c", &[], 0.0, &mut one).unwrap(), "%bpm 120\na 60:0.9\n%rest 0.1\nb 62:0.5\n%rest 0.5\nc 64:1\n");
        assert_eq!(roll(120.0, 0.0, &keys, "a b c", &[], 0.125, &mut one).unwrap(), "%bpm 120\na 60:1\nb 62:0.5\n%rest 0.5\nc 64:1\n");
        // a song from a beat of the notes' own count, before 0 as well; what is wrong is said in that count
        let keys = [key(60.0, 33.0, 1.0), key(62.0, 34.5, 1.0)];
        assert_eq!(roll(120.0, 30.0, &keys, "a b", &[], 0.0, &mut one).unwrap(), "%bpm 120\n%rest 3\na 60:1\n%rest 0.5\nb 62:1\n");
        assert_eq!(roll(120.0, 33.0, &keys[..1], "a", &[], 0.0, &mut one).unwrap(), "%bpm 120\na 60:1\n");
        assert_eq!(roll(120.0, -2.0, &[key(60.0, 0.0, 1.0)], "a", &[], 0.0, &mut one).unwrap(), "%bpm 120\n%rest 2\na 60:1\n");
        assert!(roll(120.0, 30.0, &keys, "a", &[], 0.0, &mut one).unwrap_err().0.contains("the words run out at beat 34.5"));
        assert!(roll(120.0, 33.5, &keys, "a b", &[], 0.0, &mut one).unwrap_err().0.contains("a note at beat 33: 33.5 or later"));
    }

    #[test]
    fn roll_splits_a_word() {
        let mut two = |items: &[Option<&str>], k: usize| Ok(if items[k] == Some("water") { 2 } else { 1 });
        let keys = [key(60.0, 0.0, 1.0), key(62.0, 1.0, 0.5), key(64.0, 2.0, 1.0), key(65.0, 3.0, 1.0)];
        assert_eq!(roll(60.0, 0.0, &keys, "wa_-ter is", &[], 0.0, &mut two).unwrap(), "%bpm 60\nwater 60:1+62:1 64:1\nis 65:1\n");
        assert_eq!(roll(60.0, 0.0, &keys[..3], "water wide", &[], 0.0, &mut two).unwrap(), "%bpm 60\nwater 60:1 62:0.5\n%rest 0.5\nwide 64:1\n");
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
    fn a_roll_with_a_fill_sings_what_fits() {
        let keys = [key(60.0, 0.0, 1.0), key(62.0, 1.0, 1.0), key(64.0, 2.5, 1.0), key(65.0, 4.0, 1.0)];
        let mut two = |items: &[Option<&str>], k: usize| Ok(if items[k] == Some("water") { 2 } else { 1 });
        let under = |words: &str, n: usize, count: &mut dyn FnMut(&[Option<&str>], usize) -> Result<usize>| roll_under(60.0, 0.0, &keys[..n], words, &[], 0.0, Some("oo"), count);
        // notes past the words sing the fill, each a word of its own
        let r = under("the wide", 4, &mut one).unwrap();
        assert_eq!(r, Rolled { song: "%bpm 60\nthe 60:1\nwide 62:1\n%rest 0.5\noo 64:1\n%rest 0.5\noo 65:1\n".into(), groups: vec![vec![1], vec![1]], unsung: 0, filled: 2 });
        // no words yet: every note does
        let r = under(" \n", 2, &mut one).unwrap();
        assert_eq!((r.song.as_str(), r.groups.len(), r.unsung, r.filled), ("%bpm 60\noo 60:1\noo 62:1\n", 0, 0, 2));
        // words past the notes wait
        let r = under("a b c d_ e", 2, &mut one).unwrap();
        assert_eq!((r.song.as_str(), r.groups.len(), r.unsung, r.filled), ("%bpm 60\na 60:1\nb 62:1\n", 2, 3, 0));
        // a word the notes run out on waits whole, and the notes it left sing the fill
        let r = under("a b wa-ter is", 3, &mut two).unwrap();
        assert_eq!((r.song.as_str(), r.groups.len(), r.unsung, r.filled), ("%bpm 60\na 60:1\nb 62:1\n%rest 0.5\noo 64:1\n", 2, 2, 1));
        // and as they are written the song is the strict roll's
        let words = "a wa_-ter";
        assert_eq!(under(words, 4, &mut two).unwrap().song, roll(60.0, 0.0, &keys, words, &[], 0.0, &mut two).unwrap());
        // what is wrong with the words is still wrong
        assert!(under("wa-te-r", 4, &mut two).unwrap_err().0.contains("written in 3 syllables, sung in 2"));
        assert!(under("_ a", 4, &mut one).is_err());
        assert!(under("a", 0, &mut one).unwrap_err().0.contains("no notes"));
        let mut long = |items: &[Option<&str>], k: usize| Ok(if items[k] == Some("oo") { 2 } else { 1 });
        assert!(under("a", 2, &mut long).unwrap_err().0.contains("not one syllable"));
    }

    #[test]
    fn notes_are_lined_up_as_a_diff_does() {
        let was = [key(60.0, 0.0, 1.0), key(62.0, 1.0, 1.0), key(64.0, 2.0, 1.0), key(65.0, 3.0, 2.0)];
        let same: Vec<Option<usize>> = (0..4).map(Some).collect();
        assert_eq!(align(&was, &was), same);
        assert_eq!(align(&[], &was), vec![None; 4]);
        assert_eq!(align(&was, &[]), vec![]);
        // a pitch changed, a note moved, one made longer: each is the note it was
        let mut now = was.to_vec();
        (now[1].pitch, now[2].start, now[3].beats) = (70.0, 2.25, 1.0);
        assert_eq!(align(&was, &now), same);
        // all of them a bar later, and a third higher
        let later: Vec<Key> = was.iter().map(|k| key(k.pitch, k.start + 4.0, k.beats)).collect();
        assert_eq!(align(&was, &later), same);
        let higher: Vec<Key> = was.iter().map(|k| key(k.pitch + 4.0, k.start, k.beats)).collect();
        assert_eq!(align(&was, &higher), same);
        // one put in, one taken out
        let mut more = was.to_vec();
        more.insert(2, key(63.0, 1.5, 0.5));
        assert_eq!(align(&was, &more), vec![Some(0), Some(1), None, Some(2), Some(3)]);
        assert_eq!(align(&more, &was), vec![Some(0), Some(1), Some(3), Some(4)]);
        // one taken out and another put in further on: not every note after it shifted by one
        let moved = [was[0].clone(), was[2].clone(), was[3].clone(), key(72.0, 8.0, 1.0)];
        assert_eq!(align(&was, &moved), vec![Some(0), Some(2), Some(3), None]);
        // one note where there was another: the same note, changed
        assert_eq!(align(&was[..1], &[key(72.0, 9.0, 3.0)]), vec![Some(0)]);
    }

    #[test]
    fn a_word_is_written_in_its_syllables() {
        let s = |w: &str, n: usize| spell(w, n).map(|p| p.join("-"));
        assert_eq!(s("water", 2).as_deref(), Some("wa-ter"));
        assert_eq!(s("little", 2).as_deref(), Some("lit-tle"));
        assert_eq!(s("beautiful", 3).as_deref(), Some("beau-ti-ful"));
        assert_eq!(s("over", 2).as_deref(), Some("o-ver"));
        assert_eq!(s("wonder", 2).as_deref(), Some("won-der"));
        assert_eq!(s("desire", 2).as_deref(), Some("de-sire"));
        assert_eq!(s("heav'n", 1).as_deref(), Some("heav'n"));
        // too few groups of vowels: by its length
        assert_eq!(s("rhythm", 2).as_deref(), Some("rhy-thm"));
        assert_eq!(s("a", 2), None);
    }

    #[test]
    fn each_note_shows_what_is_under_it() {
        let groups: Vec<Vec<usize>> = vec![vec![1], vec![2, 1], vec![1, 1, 2], vec![1]];
        let got = under("The wa_-ter, beautiful_ night and more", &groups, 10, "oo").unwrap();
        assert_eq!(got, ["The", "wa-", "_", "ter", "beau-", "ti-", "ful", "_", "night", "oo"]);
        assert_eq!(under("", &[], 2, "oo").unwrap(), ["oo", "oo"]);
        assert_eq!(under("a b", &[vec![2]], 2, "oo").unwrap(), ["a", "_"]);
        // a word of fewer letters than the syllables it is sung in
        assert_eq!(under("I", &[vec![1, 1]], 2, "oo").unwrap(), ["I-", ""]);
        assert!(under("a b", &[vec![2], vec![1]], 2, "oo").is_err());
        assert!(under("a", &[vec![1], vec![1]], 2, "oo").is_err());
    }

    #[test]
    fn words_stay_under_their_notes() {
        let words = "The wa-ter is_ wide,\nI can't cross\no-ver. _";
        // the, wa, ter, is, (is), wide, I, can't, cross, o, ver, (ver)
        let groups: Vec<Vec<usize>> = vec![vec![1], vec![1, 1], vec![2], vec![1], vec![1], vec![1], vec![1], vec![1, 2]];
        let mut two = |items: &[Option<&str>], k: usize| Ok(if matches!(items[k], Some("water" | "over")) { 2 } else { 1 });
        let all: Vec<Option<usize>> = (0..12).map(Some).collect();
        let mut c = |was: &[Option<usize>]| carry(words, &groups, was, "oo", &mut two).unwrap();
        // the notes as they were, and notes that only moved: the words as written
        assert_eq!(c(&all), words);
        // a note gone takes its syllable: a word, a held note, a syllable of a word, a hold written alone
        let less = |gone: &[usize]| all.iter().cloned().filter(|o| !gone.contains(&o.unwrap())).collect::<Vec<_>>();
        assert_eq!(c(&less(&[0])), "wa-ter is_ wide,\nI can't cross\no-ver. _");
        assert_eq!(c(&less(&[4])), "The wa-ter is wide,\nI can't cross\no-ver. _");
        assert_eq!(c(&less(&[2])), "The wa is_ wide,\nI can't cross\no-ver. _");
        assert_eq!(c(&less(&[1, 5])), "The ter is_\nI can't cross\no-ver. _");
        assert_eq!(c(&less(&[11])), "The wa-ter is_ wide,\nI can't cross\no-ver.");
        assert_eq!(c(&less(&[6, 7, 8])), "The wa-ter is_ wide,\no-ver. _");
        // a new note: inside a word it holds the syllable before it, between words it sings the fill
        let with = |at: usize| {
            let mut w = all.clone();
            w.insert(at, None);
            w
        };
        assert_eq!(c(&with(2)), "The wa_-ter is_ wide,\nI can't cross\no-ver. _");
        assert_eq!(c(&with(4)), "The wa-ter is__ wide,\nI can't cross\no-ver. _");
        assert_eq!(c(&with(1)), "The oo wa-ter is_ wide,\nI can't cross\no-ver. _");
        assert_eq!(c(&with(0)), "oo The wa-ter is_ wide,\nI can't cross\no-ver. _");
        assert_eq!(c(&with(6)), "The wa-ter is_ wide, oo\nI can't cross\no-ver. _");
        // after the last word it is left to the words to come
        assert_eq!(c(&with(12)), words);
        // nothing left of the words
        assert_eq!(c(&[None, None]), "");

        // a word the engine splits, written whole: what is left of it is written, where that is sung in as many syllables
        let words = "Si-lent\nbeautiful night, and more to come";
        let groups: Vec<Vec<usize>> = vec![vec![1, 1], vec![1, 1, 1], vec![1]];
        let mut n = |items: &[Option<&str>], k: usize| {
            Ok(match items[k] {
                Some("beautiful") => 3,
                Some("silent" | "Silent" | "beauful") => 2,
                Some("tiful") => 3,
                _ => 1,
            })
        };
        let mut c = |was: &[Option<usize>]| carry(words, &groups, was, "oo", &mut n).unwrap();
        assert_eq!(c(&[Some(0), Some(1), Some(2), Some(3), Some(4), Some(5)]), words);
        assert_eq!(c(&[Some(0), Some(1), Some(2), Some(4), Some(5)]), "Si-lent\nbeau-ful night, and more to come");
        assert_eq!(c(&[Some(0), Some(1), Some(2), None, Some(3), Some(4), Some(5)]), "Si-lent\nbeau_-ti-ful night, and more to come");
        // "tiful" is not sung in two: its notes sing the fill
        assert_eq!(c(&[Some(0), Some(1), Some(3), Some(4), Some(5)]), "Si-lent\noo oo night, and more to come");
        // the words that waited come up when every note of the words is gone
        assert_eq!(c(&[None]), "and more to come");
    }

    #[test]
    fn roll_recounts_with_its_rests() {
        // a word sung in two syllables only after a rest
        let mut c = |items: &[Option<&str>], k: usize| Ok(if k > 0 && items[k - 1].is_none() { 2 } else { 1 });
        let keys = [key(60.0, 0.0, 1.0), key(62.0, 2.0, 1.0), key(64.0, 3.0, 1.0)];
        assert_eq!(roll(60.0, 0.0, &keys, "a bless'd", &[], 0.0, &mut c).unwrap(), "%bpm 60\na 60:1\n%rest 1\nbless'd 62:1 64:1\n");
        let mut calls = 0;
        let mut c = |items: &[Option<&str>], k: usize| {
            calls += 1;
            Ok(if items[k].is_some() { 1 } else { 0 })
        };
        assert_eq!(roll(60.0, 0.0, &keys[..2], "a b", &[], 0.0, &mut c).unwrap(), "%bpm 60\na 60:1\n%rest 1\nb 62:1\n");
        assert_eq!(calls, 4);
    }

    #[test]
    fn parse_and_plan_keep_a_song() {
        let text = "%bpm 84\n%rest 2\nThe 60:1\nwater 60:1 60:0.5\n%rest 0.01\nis 62:0.5\n%rest 1\nwide 62:2\n%rest 1\n";
        let song = parse(text).unwrap();
        assert_eq!(song.phrases.len(), 3);
        assert_eq!(song.tail, 1.0);
        let b = Breathing { sex: 'F', lib: None, want: &|_| false, deck: &|_| String::new(), turn: 0, give: None };
        let (out, reqs) = plan(&song, &b, &HashMap::new(), &mut HashMap::new()).unwrap();
        // the rest too short for an onset is held by the note before
        assert_eq!(out, "%bpm 84\n%rest 2\nThe 60:1\nwater 60:1 60:0.51\nis 62:0.5\n%rest 1\nwide 62:2\n%rest 1\n");
        assert!(reqs.is_empty());
    }

    #[test]
    fn plan_makes_room_for_a_breath() {
        let lib = Library::new(vec![Clip { id: "a".into(), sex: 'F', at: 0, n: 9600 }, Clip { id: "b".into(), sex: 'M', at: 9600, n: 4800 }]).unwrap();
        let song = parse("%bpm 60\nla 60:2\n%rest 0.25\nla 62:1\n").unwrap();
        let b = Breathing { sex: 'F', lib: Some(&lib), want: &|j| j == 1, deck: &|_| "0.000".into(), turn: 5, give: None };
        let mut pins = HashMap::new();
        let (out, reqs) = plan(&song, &b, &HashMap::new(), &mut pins).unwrap();
        // 0.4 s of breath, 0.07 before it and 0.25 for the onset: 0.72 beats, 0.47 of them from the note
        assert_eq!(out, "%bpm 60\nla 60:1.53\n%rest 0.72\nla 62:1\n");
        assert_eq!(reqs, vec![Req { rest: 1, clip: 0, j: 1, room: 0.72 }]);
        assert_eq!(pins.get(&1), Some(&0));
        let short = deficits(&[(0.0, 0.1), (1.63, 2.0)], &reqs, &lib).unwrap();
        assert!((short[&1] - 0.13).abs() < 1e-9);
    }
}
