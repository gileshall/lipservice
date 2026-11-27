// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! What a voice did when, in samples of its sound, for pictures and other rigs to follow: its phones
//! and words from the plan's tokens and the frames each takes, its sung notes, and its pitch a frame
//! as the stream made it. say(), sing() and a choir's parts give the same shape.

use std::ops::Range;

use crate::dsp::HOP;
use crate::front::{self, BOS, EOS, PAD, SPACE};
use crate::json::quote;
use crate::passage::Passage;
use crate::weights::{err, Result};

/// A rest's comma among a song's tokens, and a pause's in speech.
const COMMA: usize = 4;

/// A stretch of the sound, samples [start, end), and what it is: a phone's symbol or a word.
#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    pub start: i64,
    pub end: i64,
    pub text: String,
}

/// A sung note: samples [start, end) of its vowel, its MIDI as sung (the shift in it), its word.
#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    pub start: i64,
    pub end: i64,
    pub midi: f32,
    pub word: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Timing {
    pub phones: Vec<Span>,
    pub words: Vec<Span>,
    pub notes: Vec<Note>,
    /// Hz a frame (HOP samples) from the sound's first, 0 where unvoiced.
    pub pitch: Vec<f32>,
}

fn edge(t: usize) -> bool {
    [PAD, BOS, EOS, SPACE, COMMA].contains(&t)
}

/// Each token's frames [start, end).
fn frames(durations: &[usize]) -> Vec<Range<usize>> {
    let mut t = 0;
    durations
        .iter()
        .map(|&d| {
            t += d;
            t - d..t
        })
        .collect()
}

fn phones(tokens: &[usize], at: &[Range<usize>]) -> Vec<Span> {
    tokens
        .iter()
        .zip(at)
        .filter(|(&k, r)| !edge(k) && !r.is_empty())
        .map(|(&k, r)| Span { start: (r.start * HOP) as i64, end: (r.end * HOP) as i64, text: front::symbol(k).to_string() })
        .collect()
}

fn hz(lf0: &[f32], vuv: &[f32]) -> Vec<f32> {
    lf0.iter().zip(vuv).map(|(&l, &v)| if v > 0.5 { l.exp() } else { 0.0 }).collect()
}

/// A song's timing: `words`, the song's words in order, one to each run of tokens between its
/// spaces, commas and ends; `notes`, the plan's (word, MIDI, vowel frames); lf0 and vuv the stream's.
pub fn sung(tokens: &[usize], durations: &[usize], words: &[String], notes: &[(String, f32, Range<usize>)], lf0: &[f32], vuv: &[f32]) -> Result<Timing> {
    let at = frames(durations);
    let mut runs: Vec<Range<usize>> = Vec::new();
    for (i, &k) in tokens.iter().enumerate() {
        if edge(k) {
            continue;
        }
        match runs.last_mut() {
            Some(r) if r.end == i => r.end = i + 1,
            _ => runs.push(i..i + 1),
        }
    }
    if runs.len() != words.len() {
        return err(format!("timing: {} words written, {} sung", words.len(), runs.len()));
    }
    let words = runs
        .iter()
        .zip(words)
        .map(|(r, w)| Span { start: (at[r.start].start * HOP) as i64, end: (at[r.end - 1].end * HOP) as i64, text: w.clone() })
        .collect();
    let notes = notes.iter().map(|(w, m, r)| Note { start: (r.start * HOP) as i64, end: (r.end * HOP) as i64, midi: *m, word: w.clone() }).collect();
    Ok(Timing { phones: phones(tokens, &at), words, notes, pitch: hz(lf0, vuv) })
}

/// A song's words as planned, JSON: [{"word", "phones": [[symbol, close (0 or 1), start, end, by,
/// dip]]}], start and end samples; a close is the end of the vowel before it, in that vowel's
/// note; by and dip the diction rules (Rules::lines) that gave the phone and its dip, or null. As
/// `word{...}` writes them (sing.rs) the word is sung the same again.
pub fn planned(tokens: &[usize], durations: &[usize], closes: &[bool], by: &[(Option<usize>, Option<usize>)], words: &[String]) -> Result<String> {
    let rule = |k: Option<usize>| k.map_or("null".to_string(), |k| k.to_string());
    let at = frames(durations);
    let mut out: Vec<String> = Vec::new();
    let mut open = false;
    for (i, &k) in tokens.iter().enumerate() {
        if edge(k) {
            open = false;
            continue;
        }
        if !open {
            let Some(w) = words.get(out.len()) else { return err(format!("timing: {} words written, more sung", words.len())) };
            out.push(format!("{{\"word\":{},\"phones\":[", quote(w)));
            open = true;
        } else {
            out.last_mut().unwrap().push(',');
        }
        out.last_mut().unwrap().push_str(&format!("[\"{}\",{},{},{},{},{}]", front::symbol(k), closes[i] as u8, at[i].start * HOP, at[i].end * HOP, rule(by[i].0), rule(by[i].1)));
    }
    if out.len() != words.len() {
        return err(format!("timing: {} words written, {} sung", words.len(), out.len()));
    }
    Ok(format!("[{}]", out.iter().map(|w| format!("{w}]}}")).collect::<Vec<_>>().join(",")))
}

/// Speech's timing, a part of a passage: `words` as the part's inflection gives them (text, first
/// token, end token).
pub fn said(tokens: &[usize], durations: &[usize], words: &[(String, usize, usize)], lf0: &[f32], vuv: &[f32]) -> Result<Timing> {
    let at = frames(durations);
    let mut out = Vec::new();
    for (w, a, b) in words {
        if !(a < b && *b <= tokens.len()) {
            return err(format!("timing: the word {w} at tokens {a} to {b} of {}", tokens.len()));
        }
        out.push(Span { start: (at[*a].start * HOP) as i64, end: (at[b - 1].end * HOP) as i64, text: w.clone() });
    }
    Ok(Timing { phones: phones(tokens, &at), words: out, notes: Vec::new(), pitch: hz(lf0, vuv) })
}

/// A song's words in order.
pub fn words_of(song: &str) -> Result<Vec<String>> {
    Ok(crate::sing::Song::parse(song)?
        .items
        .iter()
        .filter_map(|i| match i {
            crate::sing::Item::Word(w, _) => Some(w.clone()),
            crate::sing::Item::Rest(_) => None,
        })
        .collect())
}

impl Timing {
    /// Its spans `by` samples later. Its pitch stays a frame each from the sound's own first sample.
    pub fn later(mut self, by: i64) -> Timing {
        for s in self.phones.iter_mut().chain(self.words.iter_mut()) {
            s.start += by;
            s.end += by;
        }
        for n in &mut self.notes {
            n.start += by;
            n.end += by;
        }
        self
    }

    /// `other` after this one (a passage's next part, its spans already where they fall): its spans
    /// added, and its pitch after this one's, `gap` frames of silence between.
    pub fn append(&mut self, mut other: Timing, gap: usize) {
        self.pitch.extend(std::iter::repeat_n(0.0, gap));
        self.phones.append(&mut other.phones);
        self.words.append(&mut other.words);
        self.notes.append(&mut other.notes);
        self.pitch.append(&mut other.pitch);
    }
}

/// A number as JSON has it: finite only.
pub fn num_json(x: f64) -> String {
    assert!(x.is_finite(), "timing: a number that is not finite");
    format!("{x}")
}

impl Timing {
    /// As JSON's fields (no braces): phones and words [[start, end, text]], notes [[start, end,
    /// midi, word]], pitch [Hz a frame].
    pub fn json_fields(&self) -> String {
        let spans = |v: &[Span]| v.iter().map(|s| format!("[{},{},{}]", s.start, s.end, quote(&s.text))).collect::<Vec<_>>().join(",");
        let notes = self.notes.iter().map(|n| format!("[{},{},{},{}]", n.start, n.end, num_json(n.midi as f64), quote(&n.word))).collect::<Vec<_>>().join(",");
        let pitch = self.pitch.iter().map(|&p| num_json(p as f64)).collect::<Vec<_>>().join(",");
        format!("\"phones\":[{}],\"words\":[{}],\"notes\":[{notes}],\"pitch\":[{pitch}]", spans(&self.phones), spans(&self.words))
    }
}

/// The timing's format, as a clip's JSON says it.
pub const FORMAT: usize = 1;

/// A passage's timing as it is said: the parts done, how many, the samples given, and where the
/// part being said starts.
#[derive(Default)]
pub struct Told {
    pub timing: Timing,
    parts: usize,
    /// The samples given so far.
    pub n: i64,
    start: i64,
}

impl Told {
    /// The part being said, done, into the passage's timing.
    fn take(&mut self, st: &Passage) -> Result<()> {
        let (inf, stream) = (st.inflection(), st.stream());
        let (lf0, vuv) = stream.pitch();
        let words: Vec<(String, usize, usize)> = inf.words().map(|(t, a, b)| (t.to_string(), a, b)).collect();
        let t = said(&inf.tokens, stream.durations(), &words, lf0, vuv)?.later(self.start);
        let gap = ((self.start as f64 / HOP as f64).round() as i64 - self.timing.pitch.len() as i64).max(0) as usize;
        self.timing.append(t, gap);
        self.parts += 1;
        Ok(())
    }

    /// The passage's next samples onto `out` (Passage::step), a part done timed before the next
    /// takes its place.
    pub fn step(&mut self, st: &mut Passage, frames: usize, out: &mut Vec<f32>) -> Result<()> {
        if st.stream().done() && self.parts == st.part() {
            self.take(st)?;
        }
        let (part, before, had) = (st.part(), self.n, out.len());
        st.step(frames, out)?;
        self.n = before + (out.len() - had) as i64;
        if st.part() != part {
            self.start = before + st.gap() as i64;
        }
        Ok(())
    }

    /// After the last step: the last part timed.
    pub fn end(&mut self, st: &Passage) -> Result<()> {
        if st.done() && self.parts == st.part() {
            self.take(st)?;
        }
        Ok(())
    }
}

/// A sound's loudness a frame (HOP samples): rms.
pub fn levels(y: &[f32]) -> Vec<f64> {
    y.chunks(HOP).map(|c| (c.iter().fold(0.0f64, |a, &x| a + x as f64 * x as f64) / c.len() as f64).sqrt()).collect()
}

/// A part of a clip's timing, as JSON: its name (a choir's) and voice, the samples of the clip it
/// covers, its seat's pan, its timing (spans already samples of the clip), its breaths (start and
/// end, samples of the clip), its loudness a frame (`level`, the numbers written, commas between),
/// and `more`, further fields (each led by a comma).
#[allow(clippy::too_many_arguments)]
pub fn part_json(name: &str, voice: &str, start: i64, length: usize, pan: f64, t: &Timing, breaths: &[(i64, i64)], level: &str, more: &str) -> String {
    let bs: Vec<String> = breaths.iter().map(|(a, b)| format!("[{a},{b}]")).collect();
    format!(
        "{{\"name\":{},\"voice\":{},\"start\":{start},\"length\":{length},\"pan\":{},{},\"breaths\":[{}],\"level\":[{level}]{more}}}",
        quote(name),
        quote(voice),
        num_json(pan),
        t.json_fields(),
        bs.join(",")
    )
}

/// A clip's timing, as JSON (python/lipservice/_timing.py has the shape): its samples, a song's
/// tempo (the number as written) and the sample written beat 0 falls on, and its parts (part_json).
pub fn clip_json(length: usize, bpm: Option<String>, beat_zero: Option<i64>, parts: &[String]) -> String {
    let or_null = |x: Option<String>| x.unwrap_or_else(|| "null".to_string());
    format!(
        "{{\"format\":{FORMAT},\"rate\":{},\"length\":{length},\"frame\":{HOP},\"bpm\":{},\"beat_zero\":{},\"parts\":[{}]}}",
        crate::dsp::SR,
        or_null(bpm),
        or_null(beat_zero.map(|z| z.to_string())),
        parts.join(",")
    )
}

/// One voice alone, the whole clip its part: say's and sing's timing.
pub fn alone_json(voice: &str, y: &[f32], t: &Timing, bpm: Option<String>, beat_zero: Option<i64>) -> String {
    let level: Vec<String> = levels(y).iter().map(|&v| num_json(v)).collect();
    clip_json(y.len(), bpm, beat_zero, &[part_json("", voice, 0, y.len(), 0.0, t, &[], &level.join(","), "")])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(s: &str) -> usize {
        front::symbol_id(s).unwrap()
    }

    #[test]
    fn a_songs_words_and_phones_fall_where_their_frames_do() {
        // BOS, "la" (L AA1), comma, space, "do" (D OW1), EOS
        let tokens = [BOS, id("L"), id("AA1"), COMMA, SPACE, id("D"), id("OW1"), EOS];
        let durations = [10, 3, 20, 15, 2, 4, 30, 10];
        let notes = vec![("la".to_string(), 69.0, 13..33), ("do".to_string(), 67.0, 54..84)];
        let lf0 = vec![(440f32).ln(); 94];
        let vuv: Vec<f32> = (0..94).map(|f| if (13..33).contains(&f) { 1.0 } else { 0.0 }).collect();
        let t = sung(&tokens, &durations, &["la".into(), "do".into()], &notes, &lf0, &vuv).unwrap();
        assert_eq!(t.words, vec![Span { start: 2400, end: 7920, text: "la".into() }, Span { start: 12000, end: 20160, text: "do".into() }]);
        assert_eq!(t.phones.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), ["L", "AA1", "D", "OW1"]);
        assert_eq!(t.phones[1], Span { start: 3120, end: 7920, text: "AA1".into() });
        assert_eq!(t.notes[1], Note { start: 12960, end: 20160, midi: 67.0, word: "do".into() });
        assert!((t.pitch[20] - 440.0).abs() < 1e-3 && t.pitch[40] == 0.0);
        let later = t.clone().later(100);
        assert_eq!(later.words[0].start, 2500);
        assert!(sung(&tokens, &durations, &["la".into()], &notes, &lf0, &vuv).is_err());
    }

    #[test]
    fn a_clips_timing_is_json_in_its_shape() {
        use crate::json::Json;
        // rms a frame, the last one short
        let y: Vec<f32> = [vec![0.5f32; HOP], vec![-0.25; HOP / 2]].concat();
        assert_eq!(levels(&y), [0.5, 0.25]);
        assert!(levels(&[]).is_empty());
        let t = Timing {
            phones: vec![Span { start: 0, end: 240, text: "AA1".into() }],
            words: vec![Span { start: 0, end: 240, text: "say \"ah\"\n".into() }],
            notes: vec![Note { start: 0, end: 240, midi: 60.5, word: "ah".into() }],
            pitch: vec![220.0, 0.0],
        };
        let j = Json::parse(&alone_json("cora", &y, &t, Some("90".into()), Some(2400))).unwrap();
        let n = |k: &str| j.get(k).unwrap().num().unwrap();
        assert_eq!((n("format"), n("rate"), n("length"), n("frame"), n("bpm"), n("beat_zero")), (1.0, 24000.0, 360.0, 240.0, 90.0, 2400.0));
        let [p] = j.get("parts").unwrap().arr().unwrap() else { panic!("one part") };
        assert_eq!((p.get("name").unwrap().str().unwrap(), p.get("voice").unwrap().str().unwrap()), ("", "cora"));
        assert_eq!((p.get("start").unwrap().num().unwrap(), p.get("length").unwrap().num().unwrap(), p.get("pan").unwrap().num().unwrap()), (0.0, 360.0, 0.0));
        assert_eq!(p.get("words").unwrap().arr().unwrap()[0].arr().unwrap()[2].str().unwrap(), "say \"ah\"\n");
        assert_eq!(p.get("notes").unwrap().arr().unwrap()[0].arr().unwrap()[2].num().unwrap(), 60.5);
        assert_eq!(p.get("level").unwrap().arr().unwrap().iter().map(|x| x.num().unwrap()).collect::<Vec<_>>(), [0.5, 0.25]);
        assert_eq!(p.get("pitch").unwrap().arr().unwrap().len(), 2);
        assert!(p.get("breaths").unwrap().arr().unwrap().is_empty());
        // speech: no tempo; a choir's part: its breaths, a level with none where none came, and more
        let said = Json::parse(&alone_json("ada", &y, &Timing::default(), None, None)).unwrap();
        assert!(matches!((said.get("bpm").unwrap(), said.get("beat_zero").unwrap()), (Json::Null, Json::Null)));
        let part = part_json("Low", "ben", 100, 50, -0.5, &t, &[(110, 120)], "0.1,null", ",\"lag\":0.02");
        let p = Json::parse(&part).unwrap();
        assert_eq!(p.get("breaths").unwrap().arr().unwrap()[0].arr().unwrap()[1].num().unwrap(), 120.0);
        assert!(matches!(p.get("level").unwrap().arr().unwrap()[1], Json::Null));
        assert_eq!((p.get("lag").unwrap().num().unwrap(), p.get("pan").unwrap().num().unwrap()), (0.02, -0.5));
    }
}
