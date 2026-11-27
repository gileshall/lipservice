// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Diction: how a word's sounds are sung or said where that is a choice. Every such choice is a
//! rule, one shape for all of them, read from %diction lines of a song, a rules file, or a caller:
//!
//!   %diction [for=WHO,..] [word=WORD] [SOUND [when ..]] -> WHAT
//!
//!   for=    who it is for: a track's name, a voice's, or a tag the piece gives a singer (letters
//!           compared without case or spaces); several, any of them. Left out: everyone.
//!   word=   every such word. Left out: any word. (One word where it stands is the song's to
//!           write: night{N,AA,~AY,T}.)
//!   SOUND   a phone (AY any stress, AY1 that one), a list (B,D,G), or `vowel` or `consonant`.
//!           Left out (with word=): the whole word.
//!   when    held>=240 or held<240   the syllable's length, ms (never true where nothing is held: speech)
//!           before=L,R  not-before=L,R  after=..  not-after=..
//!                                   the next (the last) sound of the same word: phones, `vowel`,
//!                                   `consonant`; at the word's edge `rest` (a rest, the start or
//!                                   the end) or `word` (another word straight on)
//!           place=first|inside|last where in the word the sound is
//!   WHAT    phones, spaces between: what the sound (or the word) is sung as, a vowel without its
//!           stress digit stressed. ~V is a close: V in the last of the note of the vowel before
//!           it, ~V:200 for 200 ms, ~V:<200 for 200 ms and a third of the note at most, bare ~V
//!           as ~V:<200. `none`: the consonant is not sung. `same`: the sound as it is (PLAIN's or SUNG's
//!           rule for it is off; a stress= still applies).
//!           or stress=0|1|2 (a vowel's), or dip=X (the pitch dip through a B, D, G or JH between
//!           voiced sounds, scaled; 0 for none).
//!
//!   %diction [for=WHO,..] spoken   said, not sung: the sung rules (SUNG) off
//!   %diction [for=WHO,..] sung     sung: the sung rules on, as they are with no line
//!
//! Every song is sung by the rules PLAIN and SUNG and those it writes. Of spoken and sung, the
//! narrowest line for the singer says which (who as below, then the later line). One rule of each
//! kind (phones, stress, dip) applies to a sound. A written rule comes before PLAIN's and SUNG's;
//! then the narrowest, by where
//! (every such word, any word), then who (the track, the voice, a tag, everyone),
//! then the sound (a phone with its stress, a phone, a list, a class), then how many `when`s,
//! then the later line. A word given whole (word= with
//! no SOUND, or `word{..}` in a song line) is sung as written: no rule changes its phones, a dip
//! still applies. Only a word given whole changes how many syllables it has; a sound's rule
//! keeps the count of what it replaces, so the count never turns on a note's length (`count`).

use crate::g2p::PHONES;
use crate::weights::{err, Error, Result};

/// A frame, ms.
pub const FRAME_MS: usize = 10;
/// A close's frames where none are written.
pub const CLOSE: usize = 20;
/// The consonants a dip is drawn through.
pub const DIPPED: [&str; 4] = ["B", "D", "G", "JH"];

/// The rules every song is sung by, spoken or sung. No line of PLAIN or SUNG is for anyone
/// (`for=`): the engine makes no choice by voice.
pub const PLAIN: [&str; 1] = ["B,D,G place=first -> dip=1"];
/// A singer's vowels, off where the singer speaks: each stressed, a weak ER as AH and R, and a
/// held AY or OY held open on its first vowel and closed late by its own end (before another vowel
/// by IY), an AY before an L or R left whole.
pub const SUNG: [&str; 6] = [
    "vowel -> stress=1",
    "ER0 -> AH R",
    "AY held>=240 not-before=L,R -> AA ~AY:<200",
    "AY held>=240 before=vowel -> AA ~IY:<200",
    "OY held>=240 -> AO ~OY:<200",
    "OY held>=240 before=vowel -> AO ~IY:<200",
];

const FORM: &str = "a rule is [for=WHO] [word=WORD] [SOUND when..] -> WHAT; or [for=WHO] spoken, or sung";

/// A close's length: `frames`, to the frame where `exact`, else a third of the note at most.
#[derive(Clone, Debug, PartialEq)]
pub struct Close {
    pub frames: usize,
    pub exact: bool,
}

/// A phone written for a word; with `close`, the close of the vowel before it.
#[derive(Clone, Debug, PartialEq)]
pub struct Ph {
    pub phone: &'static str,
    pub close: Option<Close>,
}

/// Who sings: what a rule's `for=` is matched against.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Who {
    pub track: Option<String>,
    pub voice: Option<String>,
    pub tags: Vec<String>,
}

/// Where a word is: its singer, the word in lowercase, and whether a rest (or the start, or the end) is before and after it.
pub struct At<'a> {
    pub who: &'a Who,
    pub word: &'a str,
    pub after_rest: bool,
    pub before_rest: bool,
}

/// A sound as sung: its phone, its close, its dip, and the rules (by their place in
/// `Rules::lines`) that gave the phone and the dip.
#[derive(Clone, Debug, PartialEq)]
pub struct Sung {
    pub phone: &'static str,
    pub close: Option<Close>,
    pub dip: f32,
    pub by: Option<usize>,
    pub dip_by: Option<usize>,
}

#[derive(Clone, Debug, PartialEq)]
enum Sound {
    Exact(&'static str),
    /// A vowel of any stress, by its name without the digit.
    Any(&'static str),
    Vowel,
    Consonant,
}

#[derive(Clone, Debug, PartialEq)]
enum Near {
    Sound(Sound),
    Rest,
    Word,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Place {
    First,
    Inside,
    Last,
}

#[derive(Clone, Debug, PartialEq)]
enum When {
    Held { least: bool, frames: usize },
    Next { not: bool, any: Vec<Near> },
    Last { not: bool, any: Vec<Near> },
    Place(Place),
}

#[derive(Clone, Debug, PartialEq)]
enum What {
    As(Vec<Ph>),
    Same,
    Stress(u8),
    Dip(f32),
}

#[derive(Clone, Debug, PartialEq)]
struct Rule {
    who: Vec<String>,
    word: Option<String>,
    sound: Vec<Sound>,
    when: Vec<When>,
    what: What,
    text: String,
    /// One of PLAIN's or SUNG's, not written.
    set: bool,
    /// One of SUNG's: off where the singer speaks.
    sung: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Word,
    As,
    Stress,
    Dip,
}

/// The rules a song is sung by, PLAIN's and SUNG's then those written, in order; and its spoken
/// and sung lines, each its for= and whether sung.
#[derive(Clone, Debug, PartialEq)]
pub struct Rules {
    rules: Vec<Rule>,
    modes: Vec<(Vec<String>, bool)>,
}

impl Default for Rules {
    fn default() -> Rules {
        let mut r = Rules::none();
        for (lines, sung) in [(&PLAIN[..], false), (&SUNG[..], true)] {
            for l in lines {
                r.rules.push(Rule { set: true, sung, ..Rule::read(&l.split_whitespace().collect::<Vec<_>>()).expect("PLAIN and SUNG") });
            }
        }
        r
    }
}

/// How narrowly `names` (a for=, plain) is for `who`: the track 3, the voice 2, a tag 1, everyone
/// (no names) 0; None where it is not.
fn rank(names: &[String], who: &Who) -> Option<u8> {
    let has = |x: &Option<String>| x.as_ref().is_some_and(|x| names.contains(&plain(x)));
    if names.is_empty() {
        Some(0)
    } else if has(&who.track) {
        Some(3)
    } else if has(&who.voice) {
        Some(2)
    } else if who.tags.iter().any(|t| names.contains(&plain(t))) {
        Some(1)
    } else {
        None
    }
}

pub fn is_vowel(p: &str) -> bool {
    p.ends_with(|c: char| c.is_ascii_digit())
}

/// A phone by its name; a vowel without its stress digit is stressed.
pub fn phone(s: &str) -> Result<&'static str> {
    PHONES
        .iter()
        .find(|p| **p == s)
        .or_else(|| PHONES.iter().find(|p| p.strip_suffix('1') == Some(s)))
        .copied()
        .ok_or_else(|| Error(format!("{s}: not an ARPAbet phone (AA, AY1, T)")))
}

/// Frames of a time written in ms.
pub fn frames_of(s: &str) -> Result<usize> {
    match s.parse::<usize>() {
        Ok(v) if v >= FRAME_MS && v % FRAME_MS == 0 => Ok(v / FRAME_MS),
        _ => err(format!("{s}: ms in steps of {FRAME_MS}, {FRAME_MS} or more")),
    }
}

/// Phones as written, one a part: P, ~P, ~P:MS or ~P:<MS.
pub fn phones<'a>(parts: impl Iterator<Item = &'a str>) -> Result<Vec<Ph>> {
    let mut out: Vec<Ph> = Vec::new();
    for x in parts {
        let (close, x) = x.strip_prefix('~').map_or((false, x), |r| (true, r));
        let (name, ms) = x.split_once(':').map_or((x, None), |(a, b)| (a, Some(b)));
        let p = phone(name)?;
        if !close {
            if ms.is_some() {
                return err(format!("{x}: only a close (~) takes a length"));
            }
            out.push(Ph { phone: p, close: None });
            continue;
        }
        if !is_vowel(p) {
            return err(format!("~{name}: a close is a vowel"));
        }
        if !out.last().is_some_and(|q| is_vowel(q.phone) && q.close.is_none()) {
            return err(format!("~{name}: a close comes straight after the vowel it closes"));
        }
        let c = match ms {
            None => Close { frames: CLOSE, exact: false },
            Some(m) => match m.strip_prefix('<') {
                Some(m) => Close { frames: frames_of(m)?, exact: false },
                None => Close { frames: frames_of(m)?, exact: true },
            },
        };
        out.push(Ph { phone: p, close: Some(c) });
    }
    Ok(out)
}

fn plain(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect()
}

fn vowels(ps: &[Ph]) -> usize {
    ps.iter().filter(|p| p.close.is_none() && is_vowel(p.phone)).count()
}

impl Sound {
    fn read(s: &str) -> Result<Sound> {
        match s {
            "vowel" => return Ok(Sound::Vowel),
            "consonant" => return Ok(Sound::Consonant),
            _ => {}
        }
        if let Some(p) = PHONES.iter().find(|p| **p == s) {
            return Ok(Sound::Exact(p));
        }
        match PHONES.iter().find(|p| p.strip_suffix('1') == Some(s)) {
            Some(p) => Ok(Sound::Any(&p[..p.len() - 1])),
            None => err(format!("{s}: a phone (AY, AY1, T), vowel or consonant")),
        }
    }

    fn list(s: &str) -> Result<Vec<Sound>> {
        s.split(',').map(Sound::read).collect()
    }

    fn fits(&self, p: &str) -> bool {
        match self {
            Sound::Exact(x) => *x == p,
            Sound::Any(b) => is_vowel(p) && &p[..p.len() - 1] == *b,
            Sound::Vowel => is_vowel(p),
            Sound::Consonant => !is_vowel(p),
        }
    }

    /// Some(true) a vowel, Some(false) a consonant.
    fn vowel(&self) -> bool {
        match self {
            Sound::Exact(x) => is_vowel(x),
            Sound::Any(_) | Sound::Vowel => true,
            Sound::Consonant => false,
        }
    }
}

fn nears(s: &str) -> Result<Vec<Near>> {
    s.split(',')
        .map(|x| match x {
            "rest" => Ok(Near::Rest),
            "word" => Ok(Near::Word),
            x => Sound::read(x).map(Near::Sound).map_err(|e| Error(format!("{}, rest or word", e.0))),
        })
        .collect()
}

/// A sound among its word's, where the word is.
struct Env<'a> {
    at: &'a At<'a>,
    ps: &'a [&'static str],
    i: usize,
    held: Option<usize>,
}

impl Rule {
    fn read(f: &[&str]) -> Result<Rule> {
        let arrow = f.iter().position(|x| *x == "->").ok_or_else(|| Error(old(f)))?;
        let (left, right) = (&f[..arrow], &f[arrow + 1..]);
        let (mut who, mut word, mut sound, mut when) = (Vec::new(), None, Vec::new(), Vec::new());
        for x in left {
            if let Some(ms) = x.strip_prefix("held>=") {
                when.push(When::Held { least: true, frames: frames_of(ms)? });
            } else if let Some(ms) = x.strip_prefix("held<") {
                when.push(When::Held { least: false, frames: frames_of(ms)? });
            } else if let Some((k, v)) = x.split_once('=') {
                if v.is_empty() {
                    return err(format!("{x}: {k}= takes a value"));
                }
                match k {
                    "for" => who.extend(v.split(',').map(plain)),
                    "word" if word.is_some() => return err("word= given twice"),
                    "word" => {
                        if v.contains('@') {
                            return err(format!("{x}: a rule is for every such word; one word where it stands is written in the song, night{{N,AA,~AY,T}}"));
                        }
                        word = Some(v.to_lowercase());
                    }
                    "before" => when.push(When::Next { not: false, any: nears(v)? }),
                    "not-before" => when.push(When::Next { not: true, any: nears(v)? }),
                    "after" => when.push(When::Last { not: false, any: nears(v)? }),
                    "not-after" => when.push(When::Last { not: true, any: nears(v)? }),
                    "place" => when.push(When::Place(match v {
                        "first" => Place::First,
                        "inside" => Place::Inside,
                        "last" => Place::Last,
                        _ => return err(format!("{x}: place=first, inside or last")),
                    })),
                    _ => return err(format!("{x}: a rule takes for=, word=, held>=, held<, before=, not-before=, after=, not-after= and place=")),
                }
            } else if sound.is_empty() {
                sound = Sound::list(x)?;
            } else {
                return err(format!("{x}: one SOUND a rule (a list has commas, no spaces)"));
            }
        }
        if right.is_empty() {
            return err("nothing after ->: phones, none, same, stress=N or dip=X");
        }
        let what = match right {
            ["none"] => What::As(Vec::new()),
            ["same"] => What::Same,
            [x] if x.starts_with("stress=") => match x["stress=".len()..].parse::<u8>() {
                Ok(n) if n <= 2 => What::Stress(n),
                _ => return err(format!("{x}: stress=0, 1 or 2")),
            },
            [x] if x.starts_with("dip=") => match x["dip=".len()..].parse::<f32>() {
                Ok(d) if d >= 0.0 && d.is_finite() => What::Dip(d),
                _ => return err(format!("{x}: dip=0 or more")),
            },
            ps if ps.iter().any(|x| x.contains('=')) => return err("after ->: phones, none, or one of stress=N and dip=X"),
            ps => What::As(phones(ps.iter().copied())?),
        };
        if sound.is_empty() {
            if word.is_none() {
                return err(format!("no word= and no SOUND: {FORM}"));
            }
            if !when.is_empty() {
                return err("a word given whole takes no when (held, before, after, place): those are a sound's");
            }
            match &what {
                What::As(ps) if vowels(ps) >= 1 => {}
                What::As(_) => return err("a word has a vowel"),
                _ => return err("same, stress= and dip= are a sound's: name the SOUND"),
            }
        } else {
            let vowel = sound[0].vowel();
            if sound.iter().any(|s| s.vowel() != vowel) {
                return err("a rule's SOUND is vowels or consonants, not both");
            }
            match &what {
                // the syllables stay as they were
                What::As(ps) if vowels(ps) != vowel as usize => {
                    return err(if vowel { "a vowel is sung as one vowel (and its ~close, and consonants): only a word given whole changes its syllables" } else { "a consonant is sung as consonants, or none: only a word given whole changes its syllables" });
                }
                What::Stress(_) if !vowel => return err("stress= is a vowel's"),
                What::Dip(_) if !sound.iter().all(|s| matches!(s, Sound::Exact(p) if DIPPED.contains(p))) => {
                    return err(format!("dip= is through {}", DIPPED.join(", ")));
                }
                _ => {}
            }
        }
        Ok(Rule { who, word, sound, when, what, text: f.join(" "), set: false, sung: false })
    }

    fn kind(&self) -> Kind {
        match &self.what {
            What::As(_) if self.sound.is_empty() => Kind::Word,
            What::As(_) | What::Same => Kind::As,
            What::Stress(_) => Kind::Stress,
            What::Dip(_) => Kind::Dip,
        }
    }

    /// How narrowly the rule is for this singer and word: (where, who), or None where it is not.
    fn scope(&self, at: &At) -> Option<(u8, u8)> {
        let wher = match &self.word {
            None => 0,
            Some(w) if w != at.word => return None,
            Some(_) => 1,
        };
        Some((wher, rank(&self.who, at.who)?))
    }

    /// How narrowly the rule is for this sound here: (where, who, sound, whens).
    fn fits(&self, e: &Env) -> Option<(u8, u8, u8, usize)> {
        let (wher, who) = self.scope(e.at)?;
        let p = e.ps[e.i];
        if !self.sound.iter().any(|s| s.fits(p)) {
            return None;
        }
        let near = |any: &[Near], q: Option<&&'static str>, rest: bool| {
            any.iter().any(|n| match (n, q) {
                (Near::Sound(s), Some(q)) => s.fits(q),
                (Near::Rest, None) => rest,
                (Near::Word, None) => !rest,
                _ => false,
            })
        };
        let ok = self.when.iter().all(|w| match w {
            When::Held { least, frames } => e.held.is_some_and(|h| (h >= *frames) == *least),
            When::Next { not, any } => near(any, e.ps.get(e.i + 1), e.at.before_rest) != *not,
            When::Last { not, any } => near(any, e.i.checked_sub(1).and_then(|j| e.ps.get(j)), e.at.after_rest) != *not,
            When::Place(Place::First) => e.i == 0,
            When::Place(Place::Last) => e.i + 1 == e.ps.len(),
            When::Place(Place::Inside) => e.i != 0 && e.i + 1 != e.ps.len(),
        });
        let sound = match &self.sound[..] {
            [Sound::Exact(_)] => 3,
            [Sound::Any(_)] => 2,
            s if s.iter().all(|s| matches!(s, Sound::Exact(_) | Sound::Any(_))) => 1,
            _ => 0,
        };
        ok.then_some((wher, who, sound, self.when.len()))
    }
}

/// What to say of a line with no ->: the lines this file replaced, each with its form now.
fn old(f: &[&str]) -> String {
    let now = match f {
        ["held", ..] => "the length is each rule's own: AY held>=240 -> AA ~AY",
        ["stops", ..] => "the dip is a rule: B,D,G place=first -> dip=1 (every one: B,D,G,JH -> dip=1)",
        ["word", ..] => "a word is a rule: word=night -> N AA ~AY T",
        [_, "off"] => "a sung rule is off for a sound by same: AY -> same",
        f if f.iter().any(|x| x.starts_with("hold=") || x.starts_with("close=")) => "a held vowel is a rule: AY held>=240 not-before=L,R -> AA ~AY:<200",
        _ => "",
    };
    if now.is_empty() {
        format!("no ->: {FORM}")
    } else {
        format!("no ->: {now}. {FORM}")
    }
}

impl Rules {
    /// No rules, not PLAIN's or SUNG's: what a caller reads lines into to see they are rules.
    pub fn none() -> Rules {
        Rules { rules: Vec::new(), modes: Vec::new() }
    }

    /// A `%diction` line's words after that one: a rule, or [for=WHO] spoken or sung.
    pub fn read(&mut self, f: &[&str]) -> Result<()> {
        match f.split_last() {
            Some((&m @ ("spoken" | "sung"), front)) if front.iter().all(|x| x.starts_with("for=")) => {
                let mut who = Vec::new();
                for x in front {
                    match &x["for=".len()..] {
                        "" => return err(format!("{x}: for= takes a value")),
                        v => who.extend(v.split(',').map(plain)),
                    }
                }
                self.modes.push((who, m == "sung"));
            }
            _ => self.rules.push(Rule::read(f)?),
        }
        Ok(())
    }

    /// Whether `who` sings (SUNG's rules on) or speaks: the narrowest spoken or sung line for it,
    /// the later of two as narrow; sung where none is.
    pub fn sings(&self, who: &Who) -> bool {
        let mut best: Option<(u8, bool)> = None;
        for (names, sung) in &self.modes {
            if let Some(r) = rank(names, who) {
                if best.is_none_or(|(b, _)| r >= b) {
                    best = Some((r, *sung));
                }
            }
        }
        best.is_none_or(|(_, s)| s)
    }

    /// A rules file: a rule a line, with %diction before it (as a song writes one) or not, over PLAIN's and SUNG's.
    pub fn file(text: &str) -> Result<Rules> {
        let mut d = Rules::default();
        for (n, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let f: Vec<&str> = line.split_whitespace().collect();
            let f = if f[0] == "%diction" { &f[1..] } else { &f[..] };
            d.read(f).map_err(|e| Error(format!("line {}: {line}: {}", n + 1, e.0)))?;
        }
        Ok(d)
    }

    /// The rules as lines, in order: what `Sung::by` counts.
    pub fn lines(&self) -> Vec<String> {
        self.rules.iter().map(|r| r.text.clone()).collect()
    }

    fn best<T: PartialOrd>(&self, kind: Kind, who: &Who, rank: impl Fn(&Rule) -> Option<T>) -> Option<usize> {
        let sings = self.sings(who);
        let mut best: Option<((bool, T), usize)> = None;
        for (k, r) in self.rules.iter().enumerate() {
            if r.kind() != kind || (r.sung && !sings) {
                continue;
            }
            if let Some(t) = rank(r).map(|t| (!r.set, t)) {
                // the later of two as narrow
                if best.as_ref().is_none_or(|(b, _)| t >= *b) {
                    best = Some((t, k));
                }
            }
        }
        best.map(|(_, k)| k)
    }

    fn whole(&self, at: &At) -> Option<(usize, &[Ph])> {
        let k = self.best(Kind::Word, at.who, |r| r.scope(at))?;
        match &self.rules[k].what {
            What::As(ps) => Some((k, ps)),
            _ => unreachable!(),
        }
    }

    fn dips(&self, at: &At, out: &mut [Sung]) {
        let own: Vec<usize> = (0..out.len()).filter(|&i| out[i].close.is_none()).collect();
        let ps: Vec<&'static str> = own.iter().map(|&i| out[i].phone).collect();
        for (i, &o) in own.iter().enumerate() {
            let e = Env { at, ps: &ps, i, held: None };
            if let Some(k) = self.best(Kind::Dip, at.who, |r| r.fits(&e)) {
                let What::Dip(d) = self.rules[k].what else { unreachable!() };
                (out[o].dip, out[o].dip_by) = (d, Some(k));
            }
        }
    }

    /// The word as sung: `said` its phones as the dictionary has them, `held` the frames of each
    /// of its syllables where it is sung on notes (one a vowel of `said`).
    pub fn sing(&self, at: &At, said: &[&'static str], held: Option<&[usize]>) -> Vec<Sung> {
        let sung = |p: &Ph, k: usize| Sung { phone: p.phone, close: p.close.clone(), dip: 0.0, by: Some(k), dip_by: None };
        let mut out = Vec::new();
        if let Some((k, ps)) = self.whole(at) {
            out.extend(ps.iter().map(|p| sung(p, k)));
        } else {
            let mut v = 0;
            for (i, &p) in said.iter().enumerate() {
                let h = if is_vowel(p) {
                    v += 1;
                    held.map(|h| h[v - 1])
                } else {
                    None
                };
                let e = Env { at, ps: said, i, held: h };
                if let Some(k) = self.best(Kind::As, at.who, |r| r.fits(&e)) {
                    if let What::As(ps) = &self.rules[k].what {
                        out.extend(ps.iter().map(|p| sung(p, k)));
                        continue;
                    }
                }
                let (mut phone, mut by) = (p, None);
                if let Some(k) = self.best(Kind::Stress, at.who, |r| r.fits(&e)) {
                    let What::Stress(n) = self.rules[k].what else { unreachable!() };
                    let name = format!("{}{n}", &p[..p.len() - 1]);
                    (phone, by) = (*PHONES.iter().find(|q| **q == name).expect("a vowel's three stresses"), Some(k));
                }
                out.push(Sung { phone, close: None, dip: 0.0, by, dip_by: None });
            }
        }
        self.dips(at, &mut out);
        out
    }

    /// A word whose phones its song line writes: those, a dip where a rule gives one.
    pub fn written(&self, at: &At, phones: &[Ph]) -> Vec<Sung> {
        let mut out: Vec<Sung> = phones.iter().map(|p| Sung { phone: p.phone, close: p.close.clone(), dip: 0.0, by: None, dip_by: None }).collect();
        self.dips(at, &mut out);
        out
    }

    /// The syllables of word `k` of `low` (a singer's words in lowercase, in order) as `who`
    /// sings it: `said` its phones as the dictionary has them. What `sing` gives, whatever the notes.
    pub fn count(&self, who: &Who, low: &[String], k: usize, said: &[&'static str]) -> usize {
        // a rest either side or not: a word given whole takes no when
        let at = At { who, word: &low[k], after_rest: false, before_rest: false };
        match self.whole(&at) {
            Some((_, ps)) => vowels(ps),
            None => said.iter().filter(|p| is_vowel(p)).count(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lines alone, no PLAIN or SUNG.
    fn rules(lines: &[&str]) -> Rules {
        read(Rules::none(), lines)
    }

    /// The lines as a song's: over PLAIN and SUNG.
    fn song(lines: &[&str]) -> Rules {
        read(Rules::default(), lines)
    }

    fn read(mut r: Rules, lines: &[&str]) -> Rules {
        for l in lines {
            r.read(&l.split_whitespace().collect::<Vec<_>>()).unwrap_or_else(|e| panic!("{l}: {}", e.0));
        }
        r
    }

    fn refused(line: &str) -> String {
        Rules::none().read(&line.split_whitespace().collect::<Vec<_>>()).err().unwrap_or_else(|| panic!("{line}: read")).0
    }

    fn said(r: &Rules, at: &At, ps: &[&'static str], held: Option<&[usize]>) -> String {
        r.sing(at, ps, held)
            .iter()
            .map(|s| match &s.close {
                None => s.phone.to_string(),
                Some(c) => format!("~{}:{}{}", s.phone, if c.exact { "" } else { "<" }, c.frames * FRAME_MS),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn at<'a>(who: &'a Who, word: &'a str) -> At<'a> {
        At { who, word, after_rest: false, before_rest: false }
    }

    #[test]
    fn plain_and_sung_are_for_no_one() {
        for l in PLAIN.iter().chain(&SUNG) {
            assert!(!l.contains("for="), "{l}");
            let r = Rule::read(&l.split_whitespace().collect::<Vec<_>>()).unwrap_or_else(|e| panic!("{l}: {}", e.0));
            assert!(r.who.is_empty() && r.word.is_none(), "{l}");
        }
        assert_eq!(Rules::default().lines(), PLAIN.iter().chain(&SUNG).copied().collect::<Vec<_>>());
    }

    #[test]
    fn spoken_or_sung_by_the_narrowest_line() {
        let alto = Who { track: Some("Alto".into()), voice: Some("ada".into()), tags: vec!["low".into()] };
        let (bass, a) = (Who { track: Some("Bass".into()), ..Who::default() }, ["N", "AY1", "T"]);
        let held = Some(&[30usize][..]);
        let r = song(&[]);
        assert_eq!(said(&r, &at(&alto, "night"), &a, held), "N AA1 ~AY1:<200 T");
        let r = song(&["for=alto spoken"]);
        assert_eq!((r.sings(&alto), r.sings(&bass)), (false, true));
        assert_eq!(said(&r, &at(&alto, "night"), &a, held), "N AY1 T");
        assert_eq!(said(&r, &at(&alto, "the"), &["DH", "AH0"], None), "DH AH0");
        // the dip is PLAIN's: spoken or sung
        assert_eq!(r.sing(&at(&alto, "bad"), &["B", "AE1", "D"], None)[0].dip, 1.0);
        // everyone spoken but the track; a tag narrower than everyone; the later of two as narrow
        let r = song(&["sung", "spoken", "for=alto sung"]);
        assert_eq!((r.sings(&alto), r.sings(&bass)), (true, false));
        let r = song(&["for=low spoken", "spoken", "sung"]);
        assert_eq!((r.sings(&alto), r.sings(&bass)), (false, true));
        // a written rule still applies to one who speaks
        let r = song(&["spoken", "T place=last -> none"]);
        assert_eq!(said(&r, &at(&bass, "night"), &a, held), "N AY1");
        assert!(refused("for= spoken").contains("for= takes a value"));
    }

    #[test]
    fn sung_is_what_the_flag_sang() {
        let (r, who) = (song(&[]), Who::default());
        let a = at(&who, "x");
        // every vowel stressed, a weak ER as AH and R
        assert_eq!(said(&r, &a, &["M", "AH1", "DH", "ER0"], None), "M AH1 DH AH1 R");
        assert_eq!(said(&r, &a, &["B", "ER2", "D", "IY0"], None), "B ER1 D IY1");
        // held, an AY in two; short, or before an L or R, whole; before a vowel closed on IY
        assert_eq!(said(&r, &a, &["N", "AY1", "T"], Some(&[24])), "N AA1 ~AY1:<200 T");
        assert_eq!(said(&r, &a, &["N", "AY1", "T"], Some(&[23])), "N AY1 T");
        assert_eq!(said(&r, &a, &["AY1", "L"], Some(&[60])), "AY1 L");
        assert_eq!(said(&r, &a, &["D", "IH0", "N", "AY2", "AH0", "L"], Some(&[10, 40, 10])), "D IH1 N AA1 ~IY1:<200 AH1 L");
        assert_eq!(said(&r, &a, &["JH", "OY1"], Some(&[30])), "JH AO1 ~OY1:<200");
        assert_eq!(said(&r, &a, &["B", "OY1", "IH0", "SH"], Some(&[30, 10])), "B AO1 ~IY1:<200 IH1 SH");
        // spoken, nothing is held
        assert_eq!(said(&r, &a, &["N", "AY1", "T"], None), "N AY1 T");
        // the dip is a word's first B, D or G
        let d = r.sing(&a, &["B", "AE1", "D"], None);
        assert_eq!(d.iter().map(|s| s.dip).collect::<Vec<_>>(), [1.0, 0.0, 0.0]);
        assert_eq!((d[0].dip_by, d[1].by), (Some(0), Some(1)));
    }

    #[test]
    fn the_narrowest_rule_wins() {
        let who = Who { track: Some("Alto 1".into()), voice: Some("ada".into()), tags: vec!["altos".into()] };
        let other = Who::default();
        let r = rules(&[
            "vowel -> stress=1",
            "AY -> AA ~AY",
            "for=altos AY -> AA ~IH",
            "for=ada AY -> AA ~EH",
            "for=alto1 AY -> AA ~IY",
            "word=night -> N AO T",
            "for=ada word=my AY -> AH",
            "AY1 -> AE",
        ]);
        let ps = ["N", "AY1", "T"];
        assert_eq!(said(&r, &at(&who, "night"), &ps, None), "N AO1 T");
        // who before the sound: the track, the voice, a tag, everyone
        assert_eq!(said(&r, &at(&who, "light"), &["L", "AY1", "T"], None), "L AA1 ~IY1:<200 T");
        assert_eq!(said(&r, &at(&Who { track: None, ..who.clone() }, "light"), &["L", "AY1", "T"], None), "L AA1 ~EH1:<200 T");
        assert_eq!(said(&r, &at(&Who { tags: vec!["altos".into()], ..Who::default() }, "light"), &["L", "AY1", "T"], None), "L AA1 ~IH1:<200 T");
        // for everyone, the phone with its stress before the phone of any
        assert_eq!(said(&r, &at(&other, "light"), &["L", "AY1", "T"], None), "L AE1 T");
        assert_eq!(said(&r, &at(&other, "light"), &["L", "AY2", "T"], None), "L AA1 ~AY1:<200 T");
        // where before who
        assert_eq!(said(&r, &at(&who, "my"), &["M", "AY1"], None), "M AH1");
        // as narrow, the later line
        let r = rules(&["T -> D", "T -> none"]);
        assert_eq!(said(&r, &at(&other, "it"), &["IH1", "T"], None), "IH1");
        // a written rule before PLAIN's and SUNG's, however narrow those
        let r = song(&["B,D,G,JH -> dip=0.5", "AY -> AE"]);
        let s = r.sing(&at(&other, "bye"), &["B", "AY1"], Some(&[60]));
        assert_eq!((s[0].dip, s[1].phone, s.len()), (0.5, "AE1", 2));
        // same: a sung rule off for the sound, its stress still SUNG's
        let r = song(&["OY -> same", "AY held<600 -> same"]);
        assert_eq!(said(&r, &at(&other, "boy"), &["B", "OY0"], Some(&[60])), "B OY1");
        assert_eq!(said(&r, &at(&other, "my"), &["M", "AY1"], Some(&[59])), "M AY1");
        assert_eq!(said(&r, &at(&other, "my"), &["M", "AY1"], Some(&[60])), "M AA1 ~AY1:<200");
    }

    #[test]
    fn a_rule_sees_a_rest() {
        let (who, r) = (Who::default(), rules(&["T place=last before=rest -> none", "B,D,G after=rest -> dip=0.5", "D after=word -> dip=2"]));
        let a = At { who: &who, word: "dot", after_rest: true, before_rest: false };
        let s = r.sing(&a, &["D", "AA1", "T"], None);
        assert_eq!((s.len(), s[0].dip), (3, 0.5));
        let a = At { after_rest: false, before_rest: true, ..a };
        let s = r.sing(&a, &["D", "AA1", "T"], None);
        assert_eq!((s.len(), s[0].dip), (2, 2.0));
    }

    #[test]
    fn syllables_do_not_turn_on_the_notes() {
        let who = Who::default();
        let low: Vec<String> = ["fire", "and", "fire"].map(String::from).to_vec();
        let ps = ["F", "AY1", "ER0"];
        let r = song(&["word=fire -> F AY R"]);
        assert_eq!((r.count(&who, &low, 0, &ps), r.count(&who, &low, 1, &["AE1", "N", "D"]), r.count(&who, &low, 2, &ps)), (1, 1, 1));
        assert_eq!(song(&[]).count(&who, &low, 0, &ps), 2);
        for l in ["AY held>=240 -> AA IY", "ER0 -> R", "vowel -> none", "T -> AH T", "B,AY -> D", "word=fire held>=240 -> F AY R"] {
            refused(l);
        }
        assert!(refused("AY held>=240 -> AA IY").contains("only a word given whole"));
    }

    #[test]
    fn lines_refused() {
        for (l, why) in [
            ("held 240", "the length is each rule's own"),
            ("stops depth=0.5 inside=on", "the dip is a rule"),
            ("word night{N,AA,~AY,T}", "a word is a rule"),
            ("AY off", "AY -> same"),
            ("AY hold=AA close=IH", "a held vowel is a rule"),
            ("AY", "no ->"),
            ("-> AA", "no word= and no SOUND"),
            ("AY ->", "nothing after ->"),
            ("XX -> AA", "XX: a phone"),
            ("AY -> XX", "XX: not an ARPAbet phone"),
            ("AY T -> AA", "one SOUND a rule"),
            ("AY held>=245 -> AA", "ms in steps of 10"),
            ("AY place=middle -> AA", "place=first, inside or last"),
            ("AY sex=F -> AA", "a rule takes for="),
            ("T -> stress=1", "stress= is a vowel's"),
            ("AY -> stress=3", "stress=0, 1 or 2"),
            ("S -> dip=1", "dip= is through B, D, G, JH"),
            ("B -> dip=-1", "dip=0 or more"),
            ("word=night -> stress=1", "name the SOUND"),
            ("word=night -> same", "name the SOUND"),
            ("word=night@2 -> N AY T", "a rule is for every such word"),
            ("word=night -> N T", "a word has a vowel"),
            ("AY -> AA ~T", "a close is a vowel"),
            ("AY -> ~AY AA", "a close comes straight after"),
            ("AY -> AA:200", "only a close"),
            ("AY before=sometimes -> AA", "rest or word"),
            ("use sung", "no ->"),
            ("sung loud", "no ->"),
            ("for=alto word=la spoken", "no ->"),
        ] {
            let e = refused(l);
            assert!(e.contains(why), "{l}: {e}");
        }
        let e = Rules::file("# choral\nAY held>=200 -> AA ~IH\n\ndiction held 200\n").err().unwrap();
        assert!(e.0.starts_with("line 4: diction held 200: no ->"), "{}", e.0);
        let r = Rules::file("# choral\nAY held>=200 -> AA ~IH\n%diction word=boat -> B AO T\n").unwrap();
        assert_eq!(r.lines()[PLAIN.len() + SUNG.len()..], ["AY held>=200 -> AA ~IH", "word=boat -> B AO T"]);
    }
}
