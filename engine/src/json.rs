// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! JSON as RFC 8259 writes it, read whole: for the small files beside the models (a breath
//! library's index, the voices' list).

use crate::weights::{err, Error, Result};

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    /// In the order written.
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn parse(text: &str) -> Result<Json> {
        let mut r = Reader { s: text.as_bytes(), i: 0 };
        let v = r.value(0)?;
        r.space();
        if r.i != r.s.len() {
            return r.fail("more after the value");
        }
        Ok(v)
    }

    /// An object's member.
    pub fn get(&self, key: &str) -> Result<&Json> {
        match self {
            Json::Obj(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v).ok_or_else(|| Error(format!("no {key}"))),
            _ => err(format!("{key}: of what is not an object")),
        }
    }

    pub fn num(&self) -> Result<f64> {
        match self {
            Json::Num(v) => Ok(*v),
            _ => err("not a number"),
        }
    }

    /// A whole number, 0 or more.
    pub fn count(&self) -> Result<usize> {
        match self {
            Json::Num(v) if *v >= 0.0 && v.fract() == 0.0 && *v < 9e15 => Ok(*v as usize),
            _ => err("not a whole number, 0 or more"),
        }
    }

    pub fn str(&self) -> Result<&str> {
        match self {
            Json::Str(s) => Ok(s),
            _ => err("not a string"),
        }
    }

    pub fn arr(&self) -> Result<&[Json]> {
        match self {
            Json::Arr(a) => Ok(a),
            _ => err("not an array"),
        }
    }
}

const DEPTH: usize = 64;

struct Reader<'a> {
    s: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn fail<T>(&self, what: &str) -> Result<T> {
        err(format!("JSON, byte {}: {what}", self.i))
    }

    fn space(&mut self) {
        while matches!(self.s.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn word(&mut self, w: &str, v: Json) -> Result<Json> {
        if self.s[self.i..].starts_with(w.as_bytes()) {
            self.i += w.len();
            return Ok(v);
        }
        self.fail("not a value")
    }

    fn value(&mut self, depth: usize) -> Result<Json> {
        if depth > DEPTH {
            return self.fail("nested too deep");
        }
        self.space();
        match self.s.get(self.i) {
            Some(b'{') => {
                self.i += 1;
                let mut m: Vec<(String, Json)> = Vec::new();
                self.space();
                if self.s.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Json::Obj(m));
                }
                loop {
                    self.space();
                    if self.s.get(self.i) != Some(&b'"') {
                        return self.fail("a member's name is a string");
                    }
                    let k = self.string()?;
                    if m.iter().any(|(have, _)| *have == k) {
                        return self.fail(&format!("{k} given twice"));
                    }
                    self.space();
                    if self.s.get(self.i) != Some(&b':') {
                        return self.fail("a colon after a member's name");
                    }
                    self.i += 1;
                    let v = self.value(depth + 1)?;
                    m.push((k, v));
                    self.space();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Json::Obj(m));
                        }
                        _ => return self.fail("a comma or the object's end"),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut a = Vec::new();
                self.space();
                if self.s.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Json::Arr(a));
                }
                loop {
                    a.push(self.value(depth + 1)?);
                    self.space();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Json::Arr(a));
                        }
                        _ => return self.fail("a comma or the array's end"),
                    }
                }
            }
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') => self.word("true", Json::Bool(true)),
            Some(b'f') => self.word("false", Json::Bool(false)),
            Some(b'n') => self.word("null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => self.fail("not a value"),
            None => self.fail("ends before a value"),
        }
    }

    fn digits(&mut self) -> usize {
        let a = self.i;
        while matches!(self.s.get(self.i), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        self.i - a
    }

    fn number(&mut self) -> Result<Json> {
        let a = self.i;
        if self.s[self.i] == b'-' {
            self.i += 1;
        }
        let whole = self.i;
        if self.digits() == 0 || (self.s[whole] == b'0' && self.i - whole > 1) {
            return self.fail("a number's digits");
        }
        if self.s.get(self.i) == Some(&b'.') {
            self.i += 1;
            if self.digits() == 0 {
                return self.fail("digits after the point");
            }
        }
        if matches!(self.s.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.s.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if self.digits() == 0 {
                return self.fail("digits in the exponent");
            }
        }
        // ASCII by the checks above
        match std::str::from_utf8(&self.s[a..self.i]).unwrap().parse::<f64>() {
            Ok(v) if v.is_finite() => Ok(Json::Num(v)),
            _ => self.fail("a number out of range"),
        }
    }

    fn hex4(&mut self) -> Result<u32> {
        let h = self.s.get(self.i..self.i + 4).and_then(|h| std::str::from_utf8(h).ok()).filter(|h| h.bytes().all(|c| c.is_ascii_hexdigit()));
        match h {
            Some(h) => {
                self.i += 4;
                Ok(u32::from_str_radix(h, 16).unwrap())
            }
            None => self.fail("four hex digits after \\u"),
        }
    }

    fn string(&mut self) -> Result<String> {
        self.i += 1;
        let mut out = Vec::new();
        loop {
            match self.s.get(self.i) {
                None => return self.fail("a string with no end"),
                Some(b'"') => {
                    self.i += 1;
                    // the input is a str and the escapes are whole characters
                    return Ok(String::from_utf8(out).unwrap());
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = match self.s.get(self.i) {
                        Some(b'"') => '"',
                        Some(b'\\') => '\\',
                        Some(b'/') => '/',
                        Some(b'b') => '\u{8}',
                        Some(b'f') => '\u{c}',
                        Some(b'n') => '\n',
                        Some(b'r') => '\r',
                        Some(b't') => '\t',
                        Some(b'u') => {
                            self.i += 1;
                            let hi = self.hex4()?;
                            let code = if (0xd800..0xdc00).contains(&hi) {
                                if self.s.get(self.i..self.i + 2) != Some(b"\\u") {
                                    return self.fail("half a surrogate pair");
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&lo) {
                                    return self.fail("half a surrogate pair");
                                }
                                0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                            } else {
                                hi
                            };
                            match char::from_u32(code) {
                                Some(c) => {
                                    out.extend(c.encode_utf8(&mut [0; 4]).bytes());
                                    continue;
                                }
                                None => return self.fail("half a surrogate pair"),
                            }
                        }
                        _ => return self.fail("an escape JSON does not have"),
                    };
                    out.extend(c.encode_utf8(&mut [0; 4]).bytes());
                    self.i += 1;
                }
                Some(&c) if c < 0x20 => return self.fail("a control character in a string"),
                Some(&c) => {
                    out.push(c);
                    self.i += 1;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads() {
        let v = Json::parse(" {\"sr\": 24000, \"clips\": [{\"id\": \"b0\", \"at\": 0, \"n\": 7920}], \"x\": [true, false, null, -1.5e2, \"a\\n\\u00e9\\ud83d\\ude00\"]} ").unwrap();
        assert_eq!(v.get("sr").unwrap().count().unwrap(), 24000);
        let c = &v.get("clips").unwrap().arr().unwrap()[0];
        assert_eq!(c.get("id").unwrap().str().unwrap(), "b0");
        assert_eq!(c.get("n").unwrap().count().unwrap(), 7920);
        assert_eq!(v.get("x").unwrap(), &Json::Arr(vec![Json::Bool(true), Json::Bool(false), Json::Null, Json::Num(-150.0), Json::Str("a\n\u{e9}\u{1f600}".into())]));
        assert!(v.get("y").is_err());
        assert_eq!(Json::parse("[]").unwrap(), Json::Arr(vec![]));
        assert_eq!(Json::parse("{}").unwrap(), Json::Obj(vec![]));
    }

    #[test]
    fn refuses() {
        for bad in ["", "{", "[1,]", "{\"a\":1,}", "{\"a\":1,\"a\":2}", "01", "1.", "-", "1e", "tru", "\"a", "\"\\x\"", "\"\\ud83d\"", "[1] 2", "{a:1}", "\"a\tb\"", "nul", "+1", ".5"] {
            assert!(Json::parse(bad).is_err(), "{bad}");
        }
        assert!(Json::parse(&"[".repeat(100)).is_err());
        assert!(Json::parse("1.5").unwrap().count().is_err());
        assert!(Json::parse("-1").unwrap().count().is_err());
    }
}
