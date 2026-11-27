// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A song's text, read: the one reader of the format (docs/release/repo/SCORE.md is its spec).
//!
//! A line each. A line whose first field starts with % is an instruction; every other line that
//! is not blank or a comment (its first character #) is a word and its notes:
//!
//!   %bpm 96                     the tempo, beats a minute (BPM), once
//!   %together                   sung on the clock the voices keep together
//!   %diction word=were -> W ER  a rule of the song's diction (diction.rs), the fields after it;
//!                               with none, the song is sung by the rules every song is
//!   %rest 0.5                   beats of silence, where it is written
//!   %vibrato 0 1.5:3            the vibrato's size from here on, against the voice's own: VALUE
//!                               jumps to it, VALUE:BEATS glides to it over as many beats
//!   hum D3:2                    a word and a NOTE:BEATS for each of its syllables (NOTE is C4,
//!                               F#3, Bb2 or a MIDI number)
//!   you D3:1+E3:0.5             notes joined by + share a syllable
//!   night{N,AA,~AY:200,T} D4:3  the word's sounds as written (diction.rs's WHAT, commas between)
//!
//! %bpm, %together and %diction are the whole song's and come before its first word; %rest and
//! %vibrato act where they are written. Nothing else is an instruction: rest, bpm, vibrato,
//! together and diction without the % are words to sing.

use crate::json::quote as json_str;
use crate::weights::{err, Error, Result};

/// The instructions, as written.
pub const INSTRUCTIONS: [&str; 5] = ["%bpm", "%together", "%diction", "%rest", "%vibrato"];
/// The slowest and the fastest tempo, beats a minute.
pub const BPM: (f64, f64) = (20.0, 400.0);

/// A note of a word: its two fields as written, and what they say.
#[derive(Clone, Debug, PartialEq)]
pub struct Note<'a> {
    pub note: &'a str,
    pub beats_text: &'a str,
    pub midi: f32,
    pub beats: f64,
}

/// A vibrato size: its value, and the beats it is glided to over where it says them.
#[derive(Clone, Debug, PartialEq)]
pub struct Size<'a> {
    pub text: &'a str,
    pub value: f64,
    pub over: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Line<'a> {
    Bpm(f64),
    Together,
    /// A rule's fields, those after %diction.
    Diction(Vec<&'a str>),
    Rest(f64),
    Vibrato(Vec<Size<'a>>),
    /// The word without its braces, the braces' inside where it has them, and its notes a
    /// syllable each.
    Word { word: &'a str, braces: Option<&'a str>, notes: Vec<Vec<Note<'a>>> },
}

/// A line that says something: its number in the text from 1, the beat it starts on, and what it says.
#[derive(Clone, Debug, PartialEq)]
pub struct Read<'a> {
    pub n: usize,
    pub beat: f64,
    pub line: Line<'a>,
}

/// A song read: its lines in order, its tempo and the line that gives it, and its beats in all.
#[derive(Clone, Debug, PartialEq)]
pub struct Song<'a> {
    pub lines: Vec<Read<'a>>,
    pub bpm: f64,
    pub bpm_line: usize,
    pub beats: f64,
}

/// Beats as written: more than 0.
pub fn beats(s: &str) -> Result<f64> {
    match s.parse::<f64>() {
        Ok(v) if v > 0.0 && v.is_finite() => Ok(v),
        _ => err(format!("{s}: beats must be a positive number")),
    }
}

/// A note name (C4 is MIDI 60; sharps #, flats b) or a MIDI number.
pub fn midi(s: &str) -> Result<f32> {
    if let Ok(v) = s.parse::<f32>() {
        return if (0.0..=127.0).contains(&v) { Ok(v) } else { err(format!("{s}: MIDI 0 to 127")) };
    }
    let b = s.as_bytes();
    let step = match b.first() {
        Some(b'C') => 0,
        Some(b'D') => 2,
        Some(b'E') => 4,
        Some(b'F') => 5,
        Some(b'G') => 7,
        Some(b'A') => 9,
        Some(b'B') => 11,
        _ => return err(format!("{s}: not a note (C4, F#3, Bb2 or a MIDI number)")),
    };
    let mut i = 1;
    let mut acc = 0;
    while i < b.len() && (b[i] == b'#' || b[i] == b'b') {
        acc += if b[i] == b'#' { 1 } else { -1 };
        i += 1;
    }
    let oct: i32 = s[i..].parse().map_err(|_| Error(format!("{s}: not a note (C4, F#3, Bb2 or a MIDI number)")))?;
    let m = 12 * (oct + 1) + step + acc;
    if !(0..=127).contains(&m) {
        return err(format!("{s}: outside MIDI 0 to 127"));
    }
    Ok(m as f32)
}

/// A vibrato size: VALUE, or VALUE:BEATS.
pub fn size(s: &str) -> Result<Size<'_>> {
    let (v, over) = match s.split_once(':') {
        Some((v, b)) => (v, Some(beats(b)?)),
        None => (s, None),
    };
    match v.parse::<f64>() {
        Ok(value) if value >= 0.0 && value.is_finite() => Ok(Size { text: s, value, over }),
        _ => err(format!("{s}: a size is VALUE or VALUE:BEATS, the value 0 or more")),
    }
}

/// `word{...}` apart: the word, and the braces' inside where it has them.
fn braced(w: &str) -> Result<(&str, Option<&str>)> {
    if !w.contains(['{', '}']) {
        return Ok((w, None));
    }
    match w.split_once('{').and_then(|(a, b)| Some((a, b.strip_suffix('}')?))) {
        Some((a, b)) if !a.is_empty() && !b.is_empty() && !b.contains(['{', '}']) => Ok((a, Some(b))),
        _ => err(format!("{w}: a word's phones are written in one piece, commas between: night{{N,AA,~AY:200,T}}")),
    }
}

/// What an instruction's word was before it took its %: said where a line of that form is refused.
fn once(f: &[&str]) -> String {
    match f[0] {
        "bpm" | "rest" | "vibrato" | "together" | "diction" => format!(" (the instruction is written %{})", f.join(" ")),
        _ => String::new(),
    }
}

fn word<'a>(f: &[&'a str]) -> Result<Line<'a>> {
    if f.len() < 2 {
        return err(format!("{}: a word takes its notes, NOTE:BEATS each{}", f[0], once(f)));
    }
    let (word, braces) = braced(f[0])?;
    let mut notes = Vec::new();
    for g in &f[1..] {
        let mut syl = Vec::new();
        for x in g.split('+') {
            let note = match x.split_once(':') {
                Some((note, b)) if !note.is_empty() && !b.contains(':') => Note { note, beats_text: b, midi: midi(note)?, beats: beats(b)? },
                _ => return err(format!("{x}: a note is NOTE:BEATS{}", once(f))),
            };
            syl.push(note);
        }
        notes.push(syl);
    }
    Ok(Line::Word { word, braces, notes })
}

/// The song's lines that say something, in order. Refused, the line's number first ("line 3: ...").
pub fn read(text: &str) -> Result<Song<'_>> {
    let (mut lines, mut beat, mut bpm, mut together, mut sung) = (Vec::new(), 0.0f64, None, false, false);
    for (i, raw) in text.lines().enumerate() {
        let (line, n) = (raw.trim(), i + 1);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let at = |e: Error| Error(format!("line {n}: {}", e.0));
        let f: Vec<&str> = line.split_whitespace().collect();
        let head = |what: &str| if sung { Err(at(Error(format!("{what} is the whole song's: it comes before the first word")))) } else { Ok(()) };
        let got = match f[0] {
            "%bpm" => {
                head("%bpm")?;
                let v = match f[1..] {
                    [v] => v.parse::<f64>().ok().filter(|v| *v >= BPM.0 && *v <= BPM.1).ok_or_else(|| at(Error(format!("%bpm {v}: {} to {} beats a minute", BPM.0, BPM.1))))?,
                    _ => return Err(at(Error("%bpm takes one number".into()))),
                };
                if bpm.replace((v, n)).is_some() {
                    return Err(at(Error("%bpm given twice: a song has one tempo".into())));
                }
                Line::Bpm(v)
            }
            "%together" => {
                head("%together")?;
                if f.len() != 1 {
                    return Err(at(Error("%together takes nothing after it".into())));
                }
                if std::mem::replace(&mut together, true) {
                    return Err(at(Error("%together given twice".into())));
                }
                Line::Together
            }
            "%diction" => {
                head("%diction")?;
                if f.len() < 2 {
                    return Err(at(Error("%diction takes a rule (diction.rs), or spoken, or sung".into())));
                }
                Line::Diction(f[1..].to_vec())
            }
            "%rest" => match f[1..] {
                [b] => Line::Rest(beats(b).map_err(at)?),
                _ => return Err(at(Error("%rest takes one number, its beats".into()))),
            },
            "%vibrato" => {
                if f.len() < 2 {
                    return Err(at(Error("%vibrato takes its sizes, VALUE or VALUE:BEATS each".into())));
                }
                Line::Vibrato(f[1..].iter().map(|x| size(x)).collect::<Result<_>>().map_err(at)?)
            }
            x if x.starts_with('%') => return Err(at(Error(format!("{x}: not an instruction ({})", INSTRUCTIONS.join(", "))))),
            _ => {
                sung = true;
                word(&f).map_err(at)?
            }
        };
        let start = beat;
        beat += match &got {
            Line::Rest(b) => *b,
            Line::Word { notes, .. } => notes.iter().flatten().map(|x| x.beats).sum(),
            _ => 0.0,
        };
        lines.push(Read { n, beat: start, line: got });
    }
    let (bpm, bpm_line) = bpm.ok_or_else(|| Error("the song has no %bpm line".into()))?;
    if !sung {
        return err("the song has no words");
    }
    Ok(Song { lines, bpm, bpm_line, beats: beat })
}

impl Song<'_> {
    /// The beats of rest before the first word.
    pub fn lead(&self) -> f64 {
        self.lines.iter().find(|l| matches!(l.line, Line::Word { .. })).map_or(0.0, |l| l.beat)
    }

    pub fn together(&self) -> bool {
        self.lines.iter().any(|l| l.line == Line::Together)
    }

    /// The song as data, JSON: {bpm, bpm_line, beats, lead, together, diction: [{line, text}],
    /// items: [{line, kind: "rest" | "word", beat, beats, and a word's: word, braces (or null),
    /// notes: [[{note, beats_text, midi, beats}]] a syllable each}], vibrato: [{line, beat,
    /// sizes: [text]}]}. A line is its number in the text from 1; a beat is from the song's start.
    pub fn json(&self) -> String {
        let (mut diction, mut items, mut vibrato) = (Vec::new(), Vec::new(), Vec::new());
        for l in &self.lines {
            match &l.line {
                Line::Bpm(_) | Line::Together => {}
                Line::Diction(f) => diction.push(format!("{{\"line\":{},\"text\":{}}}", l.n, json_str(&f.join(" ")))),
                Line::Rest(b) => items.push(format!("{{\"line\":{},\"kind\":\"rest\",\"beat\":{},\"beats\":{b}}}", l.n, l.beat)),
                Line::Vibrato(sizes) => vibrato.push(format!("{{\"line\":{},\"beat\":{},\"sizes\":[{}]}}", l.n, l.beat, sizes.iter().map(|s| json_str(s.text)).collect::<Vec<_>>().join(","))),
                Line::Word { word, braces, notes } => {
                    let syls: Vec<String> = notes
                        .iter()
                        .map(|s| {
                            let ns: Vec<String> = s.iter().map(|x| format!("{{\"note\":{},\"beats_text\":{},\"midi\":{},\"beats\":{}}}", json_str(x.note), json_str(x.beats_text), x.midi, x.beats)).collect();
                            format!("[{}]", ns.join(","))
                        })
                        .collect();
                    let all: f64 = notes.iter().flatten().map(|x| x.beats).sum();
                    items.push(format!(
                        "{{\"line\":{},\"kind\":\"word\",\"beat\":{},\"beats\":{all},\"word\":{},\"braces\":{},\"notes\":[{}]}}",
                        l.n,
                        l.beat,
                        json_str(word),
                        braces.map_or("null".to_string(), json_str),
                        syls.join(",")
                    ));
                }
            }
        }
        format!(
            "{{\"bpm\":{},\"bpm_line\":{},\"beats\":{},\"lead\":{},\"together\":{},\"diction\":[{}],\"items\":[{}],\"vibrato\":[{}]}}",
            self.bpm,
            self.bpm_line,
            self.beats,
            self.lead(),
            self.together(),
            diction.join(","),
            items.join(","),
            vibrato.join(",")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(text: &str) -> String {
        read(text).err().unwrap_or_else(|| panic!("read: {text:?}")).0
    }

    #[test]
    fn a_song_is_read_a_line_each() {
        let s = read("# a carol\n%bpm 96\n%together\n%diction spoken\n\n  %rest 1\nnight{N,AA,~AY:200,T} D4:3\n%vibrato 0 1.5:3\nyou\tD3:1+E3:0.5 60:1\r\n%rest 0.5").unwrap();
        assert_eq!((s.bpm, s.bpm_line, s.beats, s.lead(), s.together()), (96.0, 2, 7.0, 1.0, true));
        let kinds: Vec<(usize, f64)> = s.lines.iter().map(|l| (l.n, l.beat)).collect();
        assert_eq!(kinds, [(2, 0.0), (3, 0.0), (4, 0.0), (6, 0.0), (7, 1.0), (8, 4.0), (9, 4.0), (10, 6.5)]);
        assert_eq!(s.lines[2].line, Line::Diction(vec!["spoken"]));
        let Line::Word { word, braces, notes } = &s.lines[4].line else { panic!() };
        assert_eq!((*word, *braces, notes.len()), ("night", Some("N,AA,~AY:200,T"), 1));
        let Line::Word { notes, .. } = &s.lines[6].line else { panic!() };
        assert_eq!(notes.iter().map(|g| g.iter().map(|n| (n.note, n.beats_text, n.midi, n.beats)).collect::<Vec<_>>()).collect::<Vec<_>>(), [vec![("D3", "1", 50.0, 1.0), ("E3", "0.5", 52.0, 0.5)], vec![("60", "1", 60.0, 1.0)]]);
        let Line::Vibrato(sizes) = &s.lines[5].line else { panic!() };
        assert_eq!(sizes.iter().map(|z| (z.text, z.value, z.over)).collect::<Vec<_>>(), [("0", 0.0, None), ("1.5:3", 1.5, Some(3.0))]);
    }

    #[test]
    fn the_instructions_words_are_words_to_sing() {
        let s = read("%bpm 90\nrest E4:1\nbpm E4:1\nvibrato C4:1 D4:1 E4:1\ntogether C4:1 D4:1 E4:1\ndiction C4:1 D4:1\n").unwrap();
        let words: Vec<&str> = s.lines.iter().filter_map(|l| if let Line::Word { word, .. } = &l.line { Some(*word) } else { None }).collect();
        assert_eq!(words, ["rest", "bpm", "vibrato", "together", "diction"]);
    }

    #[test]
    fn what_is_no_song_is_refused_by_its_line() {
        // the forms before the %
        assert_eq!(refused("bpm 90\nla C4:1\n"), "line 1: 90: a note is NOTE:BEATS (the instruction is written %bpm 90)");
        assert_eq!(refused("%bpm 90\nla C4:1\nrest 0.5\n"), "line 3: 0.5: a note is NOTE:BEATS (the instruction is written %rest 0.5)");
        assert_eq!(refused("%bpm 90\ntogether\nla C4:1\n"), "line 2: together: a word takes its notes, NOTE:BEATS each (the instruction is written %together)");
        assert_eq!(refused("%bpm 90\ndiction spoken\nla C4:1\n"), "line 2: spoken: a note is NOTE:BEATS (the instruction is written %diction spoken)");
        assert_eq!(refused("%bpm 90\nvibrato 0 1:2\nla C4:1\n"), "line 2: 0: a note is NOTE:BEATS (the instruction is written %vibrato 0 1:2)");
        // the whole song's lines before its first word
        assert_eq!(refused("la C4:1\n%bpm 90\n"), "line 2: %bpm is the whole song's: it comes before the first word");
        assert_eq!(refused("%bpm 90\nla C4:1\n%diction spoken\n"), "line 3: %diction is the whole song's: it comes before the first word");
        assert_eq!(refused("%bpm 90\nla C4:1\n%together\n"), "line 3: %together is the whole song's: it comes before the first word");
        assert!(read("%rest 2\n%vibrato 0\n%bpm 90\nla C4:1\n%rest 1\n%vibrato 1\n").is_ok());
        // each instruction's own form
        assert_eq!(refused("%bpm 90\n%bpm 90\nla C4:1\n"), "line 2: %bpm given twice: a song has one tempo");
        assert_eq!(refused("%bpm 0\nla C4:1\n"), "line 1: %bpm 0: 20 to 400 beats a minute");
        assert_eq!(refused("%bpm 100000\nla C4:1\n"), "line 1: %bpm 100000: 20 to 400 beats a minute");
        assert_eq!(refused("%bpm 90 x\nla C4:1\n"), "line 1: %bpm takes one number");
        assert_eq!(refused("%bpm 90\n%rest\nla C4:1\n"), "line 2: %rest takes one number, its beats");
        assert_eq!(refused("%bpm 90\n%rest 0\nla C4:1\n"), "line 2: 0: beats must be a positive number");
        assert_eq!(refused("%bpm 90\n%together now\nla C4:1\n"), "line 2: %together takes nothing after it");
        assert_eq!(refused("%bpm 90\n%diction\nla C4:1\n"), "line 2: %diction takes a rule (diction.rs), or spoken, or sung");
        assert_eq!(refused("%bpm 90\n%vibrato\nla C4:1\n"), "line 2: %vibrato takes its sizes, VALUE or VALUE:BEATS each");
        assert_eq!(refused("%bpm 90\n%vibrato C4:1\nla C4:1\n"), "line 2: C4:1: a size is VALUE or VALUE:BEATS, the value 0 or more");
        assert_eq!(refused("%bpm 90\n%tempo 80\nla C4:1\n"), "line 2: %tempo: not an instruction (%bpm, %together, %diction, %rest, %vibrato)");
        assert_eq!(refused("%BPM 90\nla C4:1\n"), "line 1: %BPM: not an instruction (%bpm, %together, %diction, %rest, %vibrato)");
        // a word's notes
        assert_eq!(refused("%bpm 90\nla\n"), "line 2: la: a word takes its notes, NOTE:BEATS each");
        assert_eq!(refused("%bpm 90\nla C4:1:2\n"), "line 2: C4:1:2: a note is NOTE:BEATS");
        assert_eq!(refused("%bpm 90\nla la C4:1\n"), "line 2: la: a note is NOTE:BEATS");
        assert_eq!(refused("%bpm 90\nla C4:1 # held\n"), "line 2: #: a note is NOTE:BEATS");
        assert_eq!(refused("%bpm 90\nla c4:1\n"), "line 2: c4: not a note (C4, F#3, Bb2 or a MIDI number)");
        assert_eq!(refused("%bpm 90\nla{} C4:1\n"), "line 2: la{}: a word's phones are written in one piece, commas between: night{N,AA,~AY:200,T}");
        assert_eq!(refused("la C4:1\n"), "the song has no %bpm line");
        assert_eq!(refused("%bpm 90\n%rest 1\n"), "the song has no words");
    }

    #[test]
    fn a_song_as_data() {
        let s = read("%bpm 96\n%diction spoken\n%rest 1\nnight{N,AA,~AY:200,T} Bb4:3\n%vibrato 0 1.5:3\nyou 60:0.5+62:0.5\n").unwrap();
        assert_eq!(
            s.json(),
            concat!(
                r#"{"bpm":96,"bpm_line":1,"beats":5,"lead":1,"together":false,"diction":[{"line":2,"text":"spoken"}],"#,
                r#""items":[{"line":3,"kind":"rest","beat":0,"beats":1},"#,
                r#"{"line":4,"kind":"word","beat":1,"beats":3,"word":"night","braces":"N,AA,~AY:200,T","notes":[[{"note":"Bb4","beats_text":"3","midi":70,"beats":3}]]},"#,
                r#"{"line":6,"kind":"word","beat":4,"beats":1,"word":"you","braces":null,"notes":[[{"note":"60","beats_text":"0.5","midi":60,"beats":0.5},{"note":"62","beats_text":"0.5","midi":62,"beats":0.5}]]}],"#,
                r#""vibrato":[{"line":5,"beat":4,"sizes":["0","1.5:3"]}]}"#
            )
        );
    }
}
