// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! SSML read into words: the W3C SSML 1.1 core, each word carrying
//! what its elements asked of it, with the stops and breaks between words. A tag or an attribute
//! lipservice cannot honor is an error naming it, never skipped.
//!
//! ```text
//!   <speak>       the root; xml:lang, when given, English
//!   <p> <s>       a sentence ends with a full stop; a paragraph also with a strong break
//!   <break>       time="500ms" or "2s", or strength: none 0, x-weak 100, weak 200, medium 400,
//!                 strong 700, x-strong 1200 ms
//!   <prosody>     rate: x-slow 0.5, slow 0.75, medium 1, fast 1.25, x-fast 1.5, "80%" (of the
//!                 rate), "+20%" or "-20%" (a change), or a multiple ("1.2"); pitch: x-low -6,
//!                 low -3, medium 0, high +3, x-high +6 semitones, "+2st", "+10%" or "-10%", or
//!                 "180Hz"; volume: silent, x-soft -12, soft -6, medium 0, loud +6, x-loud +12 dB,
//!                 or "+3dB". Nested, rates multiply, semitones and decibels add, and Hz sets the
//!                 pitch anew.
//!   <emphasis>    level strong, moderate (the default), none or reduced
//!   <say-as>      interpret-as characters or spell-out, cardinal or number, ordinal, digits, time
//!   <phoneme>     alphabet x-arpabet, arpabet or cmu: ph for the element's text, said as one word
//!   <sub>         alias said in place of the text
//!   <lang>        English only
//!   <w> <token>   a word or words, as its text says them
//!   <meta> <metadata>  not said
//! ```
//! Everything else (voice, mark, audio, lexicon, contour, range, duration, IPA, vendors' tags) is
//! an error.

use crate::front::{cardinal, number_words, words_and_stops, STOPS};
use crate::g2p::PHONES;
use crate::weights::{err, Error, Result};

// ------------------------------------------------------------------ XML

pub enum Child {
    Text(String),
    Elem(Node),
}

pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Child>,
    at: usize,
}

impl Node {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

fn name_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

fn name_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || b"_:.-".contains(&c)
}

/// A small strict reader: elements, attributes, text, the five entities and character references,
/// comments, CDATA and an XML declaration. Gives the one root element.
pub fn parse_xml(src: &str) -> Result<Node> {
    let b = src.as_bytes();
    let where_ = |k: usize| {
        let before = &src[..k];
        format!(
            "line {}, column {}",
            before.matches('\n').count() + 1,
            k - before.rfind('\n').map_or(0, |i| i + 1) + 1
        )
    };
    let fail =
        |what: String, k: usize| -> Error { Error(format!("ssml: {what} at {}", where_(k))) };
    let decode = |s: &str, k: usize| -> Result<String> {
        let mut out = String::with_capacity(s.len());
        let mut rest = s;
        while let Some(i) = rest.find('&') {
            out.push_str(&rest[..i]);
            let tail = &rest[i + 1..];
            let e = tail
                .find(|c: char| c == ';' || c == '&' || c.is_whitespace())
                .filter(|&j| tail.as_bytes()[j] == b';')
                .ok_or_else(|| fail("a bare &".into(), k))?;
            let ent = &tail[..e];
            let ch = match ent {
                "amp" => '&',
                "lt" => '<',
                "gt" => '>',
                "quot" => '"',
                "apos" => '\'',
                _ => {
                    let n = if let Some(h) =
                        ent.strip_prefix("#x").or_else(|| ent.strip_prefix("#X"))
                    {
                        u32::from_str_radix(h, 16).ok()
                    } else if let Some(d) = ent.strip_prefix('#') {
                        d.parse().ok()
                    } else {
                        None
                    };
                    n.and_then(char::from_u32)
                        .ok_or_else(|| fail(format!("an unknown entity &{ent};"), k))?
                }
            };
            out.push(ch);
            rest = &tail[e + 1..];
        }
        out.push_str(rest);
        Ok(out)
    };
    let name_at = |i: usize| -> Option<usize> {
        if i < b.len() && name_start(b[i]) {
            let mut j = i + 1;
            while j < b.len() && name_char(b[j]) {
                j += 1;
            }
            Some(j)
        } else {
            None
        }
    };
    let skip_ws = |mut i: usize| {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        i
    };
    let mut stack: Vec<Node> = vec![Node {
        name: "#document".into(),
        attrs: vec![],
        children: vec![],
        at: 0,
    }];
    let mut i = 0;
    while i < b.len() {
        let rest = &src[i..];
        if rest.starts_with("<!--") {
            let e = src[i + 4..]
                .find("-->")
                .ok_or_else(|| fail("an unclosed comment".into(), i))?;
            i += 4 + e + 3;
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            let e = rest
                .find("]]>")
                .ok_or_else(|| fail("an unclosed CDATA".into(), i))?;
            stack
                .last_mut()
                .unwrap()
                .children
                .push(Child::Text(rest[9..e].to_string()));
            i += e + 3;
            continue;
        }
        if rest.starts_with("<?") {
            let e = rest
                .find("?>")
                .ok_or_else(|| fail("a processing instruction".into(), i))?;
            if !(rest.starts_with("<?xml")
                && rest
                    .as_bytes()
                    .get(5)
                    .map_or(false, |c| c.is_ascii_whitespace()))
            {
                return Err(fail("a processing instruction".into(), i));
            }
            i += e + 2;
            continue;
        }
        if rest.starts_with("<!") {
            return Err(fail("a DOCTYPE or other declaration".into(), i));
        }
        if rest.starts_with("</") {
            let e = name_at(i + 2).ok_or_else(|| fail("a bad end tag".into(), i))?;
            let name = &src[i + 2..e];
            let j = skip_ws(e);
            if b.get(j) != Some(&b'>') {
                return Err(fail("a bad end tag".into(), i));
            }
            if stack.len() == 1 || stack.last().unwrap().name != name {
                let open = if stack.len() == 1 {
                    "nothing is open".to_string()
                } else {
                    format!("<{}> is open", stack.last().unwrap().name)
                };
                return Err(fail(format!("</{name}> where {open}"), i));
            }
            let node = stack.pop().unwrap();
            stack.last_mut().unwrap().children.push(Child::Elem(node));
            i = j + 1;
            continue;
        }
        if b[i] == b'<' {
            let e = name_at(i + 1).ok_or_else(|| fail("a bad tag".into(), i))?;
            let mut node = Node {
                name: src[i + 1..e].to_string(),
                attrs: vec![],
                children: vec![],
                at: i,
            };
            let mut j = e;
            loop {
                let k = skip_ws(j);
                if b.get(k) == Some(&b'>')
                    || (b.get(k) == Some(&b'/') && b.get(k + 1) == Some(&b'>'))
                {
                    let empty = b[k] == b'/';
                    i = k + if empty { 2 } else { 1 };
                    if empty {
                        stack.last_mut().unwrap().children.push(Child::Elem(node));
                    } else {
                        stack.push(node);
                    }
                    break;
                }
                let ne = match name_at(k) {
                    Some(ne) if k > j => ne,
                    _ => return Err(fail("a bad tag".into(), i)),
                };
                let an = &src[k..ne];
                let q = skip_ws(ne);
                if b.get(q) != Some(&b'=') {
                    return Err(fail("a bad tag".into(), i));
                }
                let q = skip_ws(q + 1);
                let quote = *b.get(q).ok_or_else(|| fail("a bad tag".into(), i))?;
                if quote != b'"' && quote != b'\'' {
                    return Err(fail("a bad tag".into(), i));
                }
                let close = src[q + 1..]
                    .find(quote as char)
                    .ok_or_else(|| fail("a bad tag".into(), i))?
                    + q
                    + 1;
                let v = &src[q + 1..close];
                if v.contains('<') {
                    return Err(fail("a bad tag".into(), i));
                }
                if node.attrs.iter().any(|(n, _)| n == an) {
                    return Err(fail(format!("{an} given twice"), i));
                }
                node.attrs.push((an.to_string(), decode(v, i)?));
                j = close + 1;
            }
            continue;
        }
        let end = rest.find('<').map_or(src.len(), |e| i + e);
        let text = decode(&src[i..end], i)?;
        stack.last_mut().unwrap().children.push(Child::Text(text));
        i = end;
    }
    if stack.len() > 1 {
        let n = stack.last().unwrap();
        return Err(fail(format!("<{}> is not closed", n.name), n.at));
    }
    let doc = stack.pop().unwrap();
    let mut root = None;
    for c in doc.children {
        match c {
            Child::Elem(n) if root.is_none() => root = Some(n),
            Child::Text(t) if t.trim().is_empty() => {}
            _ => return Err(fail("one root element and nothing outside it".into(), 0)),
        }
    }
    root.ok_or_else(|| fail("one root element and nothing outside it".into(), 0))
}

// ------------------------------------------------------------------ values

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Emphasis {
    Strong,
    Moderate,
    None,
    Reduced,
}

/// What a word's elements asked of it.
#[derive(Clone, Debug, PartialEq)]
pub struct Ctl {
    /// Speed, 2 twice as fast.
    pub rate: f32,
    /// Semitones on the voice's pitch, or on `hz` when set.
    pub st: f32,
    pub hz: Option<f32>,
    pub db: f32,
    pub emphasis: Option<Emphasis>,
}

impl Default for Ctl {
    fn default() -> Ctl {
        Ctl {
            rate: 1.0,
            st: 0.0,
            hz: None,
            db: 0.0,
            emphasis: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Piece {
    /// A word as the front end writes it (front::words_and_stops), or with its phones given.
    Word {
        text: String,
        phones: Option<Vec<&'static str>>,
        ctl: Ctl,
    },
    Stop(&'static str),
    /// Milliseconds of silence.
    Break(f32),
}

const BREAK: [(&str, f32); 6] = [
    ("none", 0.0),
    ("x-weak", 100.0),
    ("weak", 200.0),
    ("medium", 400.0),
    ("strong", 700.0),
    ("x-strong", 1200.0),
];
const RATE: [(&str, f32); 6] = [
    ("x-slow", 0.5),
    ("slow", 0.75),
    ("medium", 1.0),
    ("default", 1.0),
    ("fast", 1.25),
    ("x-fast", 1.5),
];
const PITCH: [(&str, f32); 6] = [
    ("x-low", -6.0),
    ("low", -3.0),
    ("medium", 0.0),
    ("default", 0.0),
    ("high", 3.0),
    ("x-high", 6.0),
];
const VOLUME: [(&str, f32); 7] = [
    ("silent", f32::NEG_INFINITY),
    ("x-soft", -12.0),
    ("soft", -6.0),
    ("medium", 0.0),
    ("default", 0.0),
    ("loud", 6.0),
    ("x-loud", 12.0),
];

fn label(table: &[(&str, f32)], v: &str) -> Option<f32> {
    table.iter().find(|(k, _)| *k == v).map(|&(_, x)| x)
}

/// A plain decimal number: digits, optionally a point and more digits.
fn num(s: &str) -> Option<f32> {
    let (a, b) = s.split_once('.').unwrap_or((s, "0"));
    if a.is_empty() || b.is_empty() || !a.bytes().chain(b.bytes()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// A signed change: "+20" or "-20" before the unit.
fn signed(s: &str) -> Option<f32> {
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1.0, &s[1..]),
        b'-' => (-1.0, &s[1..]),
        _ => return None,
    };
    num(rest).map(|v| sign * v)
}

fn ms_of(t: &str) -> Option<f32> {
    if let Some(v) = t.strip_suffix("ms") {
        num(v)
    } else {
        t.strip_suffix('s').and_then(num).map(|v| v * 1000.0)
    }
}

fn rate_of(v: &str) -> Option<f32> {
    let r = if let Some(r) = label(&RATE, v) {
        Some(r)
    } else if let Some(p) = v.strip_suffix('%') {
        signed(p)
            .map(|c| 1.0 + c / 100.0)
            .or_else(|| num(p).map(|x| x / 100.0))
    } else {
        num(v)
    };
    r.filter(|r| (0.2..=5.0).contains(r))
}

enum PitchAsk {
    St(f32),
    Hz(f32),
}

fn pitch_of(v: &str) -> Option<PitchAsk> {
    if let Some(s) = label(&PITCH, v) {
        return Some(PitchAsk::St(s));
    }
    if let Some(s) = v.strip_suffix("st") {
        return signed(s).map(PitchAsk::St);
    }
    if let Some(p) = v.strip_suffix('%') {
        let f = 1.0 + signed(p)? / 100.0;
        return (f > 0.0).then(|| PitchAsk::St(12.0 * f.log2()));
    }
    v.strip_suffix("Hz")
        .and_then(num)
        .filter(|h| (40.0..=1000.0).contains(h))
        .map(PitchAsk::Hz)
}

fn volume_of(v: &str) -> Option<f32> {
    label(&VOLUME, v).or_else(|| v.strip_suffix("dB").and_then(signed))
}

// ------------------------------------------------------------------ the words

/// One stop for a run of them: a question or an exclamation wins, else the last.
fn stop_of(run: &str) -> &'static str {
    let s = if run.contains('?') {
        "?"
    } else if run.contains('!') {
        "!"
    } else {
        &run[run.len() - 1..]
    };
    STOPS.iter().find(|x| **x == s).copied().unwrap()
}

fn is_stop(c: char) -> bool {
    ",.?!;:".contains(c)
}

/// A text's trailing run of stops, and the text before it.
fn trailing_stop(text: &str) -> (&str, Option<&'static str>) {
    let body = text.trim_end_matches(is_stop);
    (
        body,
        (body.len() < text.len()).then(|| stop_of(&text[body.len()..])),
    )
}

struct Reader {
    out: Vec<Piece>,
}

impl Reader {
    fn last_word(&self) -> Option<usize> {
        self.out
            .iter()
            .rposition(|p| matches!(p, Piece::Word { .. }))
    }

    /// Puts a stop after the last word, or makes the stop already there `s` if s is stronger.
    fn stop(&mut self, s: &'static str) {
        let Some(w) = self.last_word() else { return };
        match self.out.get(w + 1) {
            Some(Piece::Stop(t)) => {
                let t = *t;
                self.out[w + 1] = Piece::Stop(stop_of(&format!("{t}{s}")));
            }
            _ => self.out.insert(w + 1, Piece::Stop(s)),
        }
    }

    /// Ends a sentence with a full stop if no stop ends it.
    fn end(&mut self) {
        let Some(w) = self.last_word() else { return };
        if !matches!(self.out.get(w + 1), Some(Piece::Stop(_))) {
            self.out.insert(w + 1, Piece::Stop("."));
        }
    }

    fn word(&mut self, text: String, phones: Option<Vec<&'static str>>, ctl: &Ctl) {
        self.out.push(Piece::Word {
            text,
            phones,
            ctl: ctl.clone(),
        });
    }

    /// A text's words; its leading stop ends the word before it.
    fn say(&mut self, text: &str, ctl: &Ctl) -> Result<()> {
        let t = text.trim_start();
        let lead = t.len() - t.trim_start_matches(is_stop).len();
        if lead > 0 {
            self.stop(stop_of(&t[..lead]));
        }
        for w in words_and_stops(&t[lead..])? {
            match STOPS.iter().find(|s| **s == w) {
                Some(s) => self.stop(s),
                None => self.word(w, None, ctl),
            }
        }
        Ok(())
    }

    fn walk(&mut self, node: &Node, ctl: &Ctl) -> Result<()> {
        for c in &node.children {
            match c {
                Child::Text(t) => self.say(t, ctl)?,
                Child::Elem(n) => self.element(n, ctl)?,
            }
        }
        Ok(())
    }

    fn element(&mut self, n: &Node, ctl: &Ctl) -> Result<()> {
        match n.name.as_str() {
            "p" | "s" => {
                only(n, &["xml:lang"])?;
                english(n)?;
                self.walk(n, ctl)?;
                self.end();
                if n.name == "p" {
                    self.out
                        .push(Piece::Break(label(&BREAK, "strong").unwrap()));
                }
            }
            "break" => {
                only(n, &["time", "strength"])?;
                if !n.children.is_empty() {
                    return fail(n, "has content");
                }
                let ms = match (n.attr("time"), n.attr("strength")) {
                    (Some(t), _) => ms_of(t),
                    (None, s) => label(&BREAK, s.unwrap_or("medium")),
                };
                match ms {
                    Some(ms) if ms <= 60000.0 => self.out.push(Piece::Break(ms)),
                    _ => return fail(
                        n,
                        &format!(
                            "time={:?} strength={:?}: a time in ms or s up to 60 s, or a strength",
                            n.attr("time"),
                            n.attr("strength")
                        ),
                    ),
                }
            }
            "prosody" => {
                only(n, &["rate", "pitch", "volume"])?;
                if n.attrs.is_empty() {
                    return fail(n, "asks for nothing: rate, pitch or volume");
                }
                let mut c = ctl.clone();
                if let Some(v) = n.attr("rate") {
                    let r = rate_of(v).ok_or_else(|| fail_err(n, &format!("rate=\"{v}\": a label, a percentage, a change, or a multiple from 0.2 to 5")))?;
                    c.rate *= r;
                }
                if let Some(v) = n.attr("pitch") {
                    match pitch_of(v).ok_or_else(|| fail_err(n, &format!("pitch=\"{v}\": a label, semitones (+2st), a change (+10%) or Hz from 40 to 1000")))? {
                        PitchAsk::St(s) => c.st += s,
                        PitchAsk::Hz(h) => {
                            c.hz = Some(h);
                            c.st = 0.0;
                        }
                    }
                }
                if let Some(v) = n.attr("volume") {
                    c.db += volume_of(v).ok_or_else(|| {
                        fail_err(n, &format!("volume=\"{v}\": a label or a change in dB"))
                    })?;
                }
                self.walk(n, &c)?;
            }
            "emphasis" => {
                only(n, &["level"])?;
                let e = match n.attr("level").unwrap_or("moderate") {
                    "strong" => Emphasis::Strong,
                    "moderate" => Emphasis::Moderate,
                    "none" => Emphasis::None,
                    "reduced" => Emphasis::Reduced,
                    l => {
                        return fail(
                            n,
                            &format!("level=\"{l}\": strong, moderate, none, reduced"),
                        )
                    }
                };
                self.walk(
                    n,
                    &Ctl {
                        emphasis: Some(e),
                        ..ctl.clone()
                    },
                )?;
            }
            "say-as" => self.say_as(n, ctl)?,
            "phoneme" => {
                only(n, &["alphabet", "ph"])?;
                let a = n.attr("alphabet").unwrap_or("").to_ascii_lowercase();
                if !["x-arpabet", "arpabet", "cmu"].contains(&a.as_str()) {
                    return fail(
                        n,
                        &format!(
                            "alphabet={:?}: x-arpabet, arpabet or cmu",
                            n.attr("alphabet")
                        ),
                    );
                }
                let ph = n
                    .attr("ph")
                    .filter(|p| !p.trim().is_empty())
                    .ok_or_else(|| fail_err(n, "has no ph"))?;
                let mut phones = Vec::new();
                for p in ph.split_whitespace() {
                    let p = p.to_ascii_uppercase();
                    match PHONES.iter().find(|x| **x == p) {
                        Some(x) => phones.push(*x),
                        None => return fail(
                            n,
                            &format!(
                                "ph=\"{ph}\": {p} is not an ARPAbet phone with its stress (AH0, T)"
                            ),
                        ),
                    }
                }
                let text = text_of(n)?;
                let (body, stop) = trailing_stop(text.trim());
                if body.trim().is_empty() {
                    return fail(n, "has no text");
                }
                self.word(body.trim().to_string(), Some(phones), ctl);
                if let Some(s) = stop {
                    self.stop(s);
                }
            }
            "sub" => {
                only(n, &["alias"])?;
                let alias = n.attr("alias").ok_or_else(|| fail_err(n, "has no alias"))?;
                text_of(n)?;
                self.say(alias, ctl)?;
            }
            "lang" => {
                only(n, &["xml:lang"])?;
                if n.attr("xml:lang").is_none() {
                    return fail(n, "has no xml:lang");
                }
                english(n)?;
                self.walk(n, ctl)?;
            }
            "w" | "token" => {
                only(n, &[])?;
                self.walk(n, ctl)?;
            }
            "meta" | "metadata" => {}
            "voice" => return fail(n, "is not supported: lipservice speaks in one voice a call"),
            "mark" => return fail(n, "is not supported: lipservice reports no timings"),
            _ => return fail(n, "is not supported"),
        }
        Ok(())
    }

    fn say_as(&mut self, n: &Node, ctl: &Ctl) -> Result<()> {
        only(n, &["interpret-as", "format", "detail"])?;
        if n.attr("format").is_some() || n.attr("detail").is_some() {
            return fail(n, "format and detail are not supported");
        }
        let text = text_of(n)?;
        let (body, stop) = trailing_stop(text.trim());
        let tok: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        let as_ = n.attr("interpret-as").unwrap_or("");
        let cannot = || fail_err(n, &format!("interpret-as=\"{as_}\" cannot read \"{body}\""));
        let words: Vec<String> = match as_ {
            "characters" | "spell-out" => {
                let mut w = Vec::new();
                for c in tok.chars().filter(|&c| c != '.') {
                    if c.is_ascii_alphabetic() {
                        w.push(format!("_{}", c.to_ascii_uppercase()));
                    } else if let Some(d) = c.to_digit(10) {
                        w.push(cardinal(d as u64));
                    } else {
                        return fail(n, &format!("cannot spell \"{c}\""));
                    }
                }
                w
            }
            "digits" if !tok.is_empty() && tok.bytes().all(|c| c.is_ascii_digit()) => tok
                .chars()
                .map(|c| cardinal(c.to_digit(10).unwrap() as u64))
                .collect(),
            "cardinal" | "number" => {
                let (neg, digits) = tok
                    .strip_prefix('-')
                    .map_or((false, tok.as_str()), |d| (true, d));
                let (int, frac) = digits.split_once('.').unwrap_or((digits, ""));
                let plain = int.replace(',', "");
                if plain.is_empty()
                    || !plain.bytes().all(|c| c.is_ascii_digit())
                    || !frac.bytes().all(|c| c.is_ascii_digit())
                    || (digits.contains('.') && frac.is_empty())
                {
                    return Err(cannot());
                }
                let mut w = Vec::new();
                if neg {
                    w.push("minus".to_string());
                }
                w.push(cardinal(plain.parse().map_err(|_| cannot())?));
                if !frac.is_empty() {
                    w.push("point".into());
                    w.extend(
                        frac.chars()
                            .map(|c| cardinal(c.to_digit(10).unwrap() as u64)),
                    );
                }
                w
            }
            "ordinal" => {
                let low = tok.to_ascii_lowercase();
                let plain = ["st", "nd", "rd", "th"]
                    .iter()
                    .find_map(|s| low.strip_suffix(s))
                    .unwrap_or(&low)
                    .replace(',', "");
                if plain.is_empty() || !plain.bytes().all(|c| c.is_ascii_digit()) {
                    return Err(cannot());
                }
                let v: u64 = plain.parse().map_err(|_| cannot())?;
                let suffix = match (v % 100, v % 10) {
                    (11..=13, _) => "th",
                    (_, 1) => "st",
                    (_, 2) => "nd",
                    (_, 3) => "rd",
                    _ => "th",
                };
                vec![number_words(&format!("{plain}{suffix}"))?.ok_or_else(cannot)?]
            }
            "time" => {
                let ok = tok.split_once(':').map_or(false, |(h, m)| {
                    (1..=2).contains(&h.len())
                        && m.len() == 2
                        && h.bytes().chain(m.bytes()).all(|c| c.is_ascii_digit())
                });
                if !ok {
                    return Err(cannot());
                }
                vec![number_words(&tok)?.ok_or_else(cannot)?]
            }
            "digits" => return Err(cannot()),
            _ => return fail(n, &format!("interpret-as=\"{as_}\" is not supported")),
        };
        for w in words.iter().flat_map(|w| w.split(' ')) {
            self.word(w.to_string(), None, ctl);
        }
        if let Some(s) = stop {
            self.stop(s);
        }
        Ok(())
    }
}

fn fail_err(n: &Node, what: &str) -> Error {
    Error(format!("ssml: <{}> {what}", n.name))
}

fn fail<T>(n: &Node, what: &str) -> Result<T> {
    Err(fail_err(n, what))
}

fn only(n: &Node, allowed: &[&str]) -> Result<()> {
    match n.attrs.iter().find(|(a, _)| !allowed.contains(&a.as_str())) {
        Some((a, _)) => fail(n, &format!("has {a}, which lipservice cannot honor")),
        None => Ok(()),
    }
}

fn english(n: &Node) -> Result<()> {
    match n.attr("xml:lang") {
        Some(l)
            if !(l.len() >= 2
                && l[..2].eq_ignore_ascii_case("en")
                && (l.len() == 2 || l.as_bytes()[2] == b'-')) =>
        {
            fail(n, &format!("is in {l}; lipservice speaks English"))
        }
        _ => Ok(()),
    }
}

fn text_of(n: &Node) -> Result<String> {
    let mut s = String::new();
    for c in &n.children {
        match c {
            Child::Text(t) => s.push_str(t),
            Child::Elem(e) => {
                return fail(e, &format!("inside <{}>, which takes text only", n.name))
            }
        }
    }
    Ok(s)
}

/// SSML to words, stops and breaks.
pub fn pieces(src: &str) -> Result<Vec<Piece>> {
    let root = parse_xml(src)?;
    if root.name != "speak" {
        return err(format!("ssml: the root is <{}>, not <speak>", root.name));
    }
    if let Some((a, _)) = root.attrs.iter().find(|(a, _)| {
        !["version", "xml:lang", "xmlns"].contains(&a.as_str())
            && !a.starts_with("xmlns:")
            && !a.starts_with("xsi:")
    }) {
        return fail(&root, &format!("has {a}, which lipservice cannot honor"));
    }
    english(&root)?;
    let mut r = Reader { out: Vec::new() };
    r.walk(&root, &Ctl::default())?;
    Ok(r.out)
}

/// Plain text as pieces: front::words_and_stops, every word as asked of none. Blank lines part
/// paragraphs, each but the last ended as `<p>` ends one: a full stop if no stop ends it, and a
/// strong break.
pub fn plain(text: &str) -> Result<Vec<Piece>> {
    let mut paras: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            if !cur.is_empty() {
                paras.push(std::mem::take(&mut cur));
            }
        } else {
            if !cur.is_empty() {
                cur.push('\n');
            }
            cur.push_str(line);
        }
    }
    if !cur.is_empty() {
        paras.push(cur);
    }
    let mut out = Vec::new();
    for (k, p) in paras.iter().enumerate() {
        out.extend(words_and_stops(p)?.into_iter().map(|w| match STOPS.iter().find(|s| **s == w) {
            Some(s) => Piece::Stop(s),
            None => Piece::Word {
                text: w,
                phones: None,
                ctl: Ctl::default(),
            },
        }));
        if k + 1 < paras.len() {
            if matches!(out.last(), Some(Piece::Word { .. })) {
                out.push(Piece::Stop("."));
            }
            out.push(Piece::Break(label(&BREAK, "strong").unwrap()));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(src: &str) -> Vec<String> {
        pieces(src)
            .unwrap()
            .iter()
            .map(|p| match p {
                Piece::Word { text, .. } => text.clone(),
                Piece::Stop(s) => s.to_string(),
                Piece::Break(ms) => format!("<{ms}>"),
            })
            .collect()
    }

    #[test]
    fn reads_the_core() {
        assert_eq!(
            words("<speak>Hello, world</speak>"),
            ["hello", ",", "world"]
        );
        assert_eq!(
            words("<speak><s>One</s><s>Two</s></speak>"),
            ["one", ".", "two", "."]
        );
        assert_eq!(
            words("<speak><p>Hi</p>there</speak>"),
            ["hi", ".", "<700>", "there"]
        );
        assert_eq!(
            words("<speak>a<break time=\"1.5s\"/>b<break/>c<break strength='x-weak'/></speak>"),
            ["a", "<1500>", "b", "<400>", "c", "<100>"]
        );
        assert_eq!(
            words("<speak><say-as interpret-as=\"characters\">AB1</say-as>?</speak>"),
            ["_A", "_B", "one", "?"]
        );
        assert_eq!(words("<speak><say-as interpret-as=\"ordinal\">22</say-as> <say-as interpret-as=\"digits\">907</say-as></speak>"), ["twenty", "second", "nine", "zero", "seven"]);
        assert_eq!(words("<speak><sub alias=\"World Wide Web\">WWW</sub> don&apos;t <w>stop</w><!-- not said --></speak>"), ["world", "wide", "web", "don't", "stop"]);
        assert_eq!(
            words("<?xml version=\"1.0\"?><speak xml:lang=\"en-US\"><![CDATA[x y z]]></speak>")
                .len(),
            3
        );
        match &parse_xml("<speak><![CDATA[x </s> y]]></speak>")
            .unwrap()
            .children[..]
        {
            [Child::Text(t)] => assert_eq!(t, "x </s> y"),
            _ => panic!("CDATA not one text"),
        }
        let p = pieces(
            "<speak><phoneme alphabet=\"cmu\" ph=\"T AH0 M EY1 T OW2\">tomato</phoneme>.</speak>",
        )
        .unwrap();
        assert_eq!(
            p[0],
            Piece::Word {
                text: "tomato".into(),
                phones: Some(vec!["T", "AH0", "M", "EY1", "T", "OW2"]),
                ctl: Ctl::default()
            }
        );
        assert_eq!(p[1], Piece::Stop("."));
    }

    #[test]
    fn nests_prosody() {
        let p = pieces("<speak><prosody rate=\"slow\" pitch=\"+2st\" volume=\"loud\">a <prosody rate=\"200%\" pitch=\"low\" volume=\"-3dB\">b <prosody pitch=\"180Hz\">c <emphasis>d</emphasis></prosody></prosody></prosody></speak>").unwrap();
        let ctl = |i: usize| match &p[i] {
            Piece::Word { ctl, .. } => ctl.clone(),
            _ => panic!(),
        };
        assert_eq!(
            ctl(0),
            Ctl {
                rate: 0.75,
                st: 2.0,
                hz: None,
                db: 6.0,
                emphasis: None
            }
        );
        assert_eq!(
            ctl(1),
            Ctl {
                rate: 1.5,
                st: -1.0,
                hz: None,
                db: 3.0,
                emphasis: None
            }
        );
        assert_eq!(
            ctl(2),
            Ctl {
                rate: 1.5,
                st: 0.0,
                hz: Some(180.0),
                db: 3.0,
                emphasis: None
            }
        );
        assert_eq!(ctl(3).emphasis, Some(Emphasis::Moderate));
    }

    #[test]
    fn refuses_what_it_cannot_honor() {
        for (src, says) in [
            ("<speak>a<b>c</b></speak>", "<b> is not supported"),
            (
                "<speak><prosody contour=\"(0%,+20Hz)\">a</prosody></speak>",
                "has contour",
            ),
            (
                "<speak><prosody rate=\"9\">a</prosody></speak>",
                "rate=\"9\"",
            ),
            ("<speak><voice name=\"x\">a</voice></speak>", "one voice"),
            ("<speak><mark name=\"m\"/>a</speak>", "no timings"),
            ("<speak xml:lang=\"fr\">a</speak>", "is in fr"),
            ("<speak>a &nbsp; b</speak>", "unknown entity"),
            ("<speak>a & b</speak>", "a bare &"),
            ("<speak>a</p></speak>", "</p> where <speak> is open"),
            ("<speak>a", "<speak> is not closed"),
            ("<p>a</p>", "not <speak>"),
            ("<speak>a</speak>b", "nothing outside it"),
            (
                "<speak><phoneme alphabet=\"ipa\" ph=\"t\">a</phoneme></speak>",
                "alphabet",
            ),
            (
                "<speak><phoneme alphabet=\"cmu\" ph=\"AH\">a</phoneme></speak>",
                "AH is not",
            ),
            (
                "<speak><say-as interpret-as=\"date\">1/2</say-as></speak>",
                "not supported",
            ),
            ("<speak><break time=\"2 s\"/></speak>", "a time in ms or s"),
        ] {
            let e = pieces(src).err().unwrap_or_else(|| panic!("{src} read")).0;
            assert!(e.contains(says), "{src}: {e}");
        }
    }

    #[test]
    fn plain_text_is_its_words() {
        let p = plain("Is it 4:30?").unwrap();
        let w: Vec<String> = p
            .iter()
            .map(|p| match p {
                Piece::Word { text, .. } => text.clone(),
                Piece::Stop(s) => s.to_string(),
                Piece::Break(_) => panic!(),
            })
            .collect();
        assert_eq!(w, ["is", "it", "four", "thirty", "?"]);
    }
}
