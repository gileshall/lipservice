// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The packed lexicon: each word's first pronunciation, words
//! front coded in byte order, looked up by binary search over the blocks' first words. A word
//! with no phones is one the G2P gets right: the G2P whose file digest the lexicon holds.

use crate::g2p::PHONES;
use crate::weights::{err, Result, Weights};

pub struct Lexicon {
    words: Vec<u8>,
    phones: Vec<u8>,
    block: usize,
    len: usize,
    g2p: Option<u64>,
    /// Per block, where its first word and its first word's phones start.
    heads: Vec<(usize, usize)>,
}

fn bytes(ws: &Weights, name: &str) -> Result<Vec<u8>> {
    let t = ws.get(name)?;
    if t.shape.len() != 1 || t.q.len() != t.shape[0] {
        return err(format!("{name}: a 1-d int8 tensor"));
    }
    Ok(t.q.iter().map(|&b| b as u8).collect())
}

impl Lexicon {
    pub fn load(ws: &Weights) -> Result<Lexicon> {
        let (words, phones) = (bytes(ws, "lex.words")?, bytes(ws, "lex.phones")?);
        let b = ws.shaped("lex.block", &[1])?[0];
        if !(b >= 1.0 && b.fract() == 0.0) {
            return err(format!("lex.block {b}: a positive integer"));
        }
        let block = b as usize;
        let g2p = if ws.has("lex.g2p") {
            let d = bytes(ws, "lex.g2p")?;
            let d: [u8; 8] = d.try_into().map_err(|_| crate::weights::Error("lex.g2p: 8 bytes".into()))?;
            Some(u64::from_le_bytes(d))
        } else {
            None
        };
        let (mut heads, mut wp, mut pp, mut len) = (Vec::new(), 0, 0, 0);
        let mut prev_len = 0;
        while wp < words.len() {
            let n = if len % block == 0 {
                heads.push((wp, pp));
                0
            } else {
                wp += 1;
                words[wp - 1] as usize
            };
            let Some(e) = words[wp..].iter().position(|&c| c == b'\n') else {
                return err(format!("lex.words: word {len} has no end"));
            };
            if n > prev_len || n + e == 0 {
                return err(format!("lex.words: word {len} shares {n} letters with a word of {prev_len}"));
            }
            prev_len = n + e;
            wp += e + 1;
            let Some(e) = phones.get(pp..).and_then(|s| s.iter().position(|&c| c == 0)) else {
                return err(format!("lex.phones: word {len} has no end"));
            };
            if e == 0 && g2p.is_none() {
                return err(format!("lex.phones: word {len} has no phones and the lexicon names no G2P"));
            }
            if phones[pp..pp + e].iter().any(|&c| c as usize > PHONES.len()) {
                return err(format!("lex.phones: word {len} has a phone out of range"));
            }
            pp += e + 1;
            len += 1;
        }
        if pp != phones.len() {
            return err(format!("lex.phones: {} bytes after the last word", phones.len() - pp));
        }
        Ok(Lexicon { words, phones, block, len, g2p, heads })
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The digest of the G2P file that gives the words with no phones, if any are left to one.
    pub fn g2p(&self) -> Option<u64> {
        self.g2p
    }

    fn line(&self, at: usize) -> (&[u8], usize) {
        let e = at + self.words[at..].iter().position(|&c| c == b'\n').unwrap();
        (&self.words[at..e], e + 1)
    }

    fn phones_at(&self, mut pp: usize, skip: usize) -> Vec<&'static str> {
        for _ in 0..skip {
            pp += self.phones[pp..].iter().position(|&c| c == 0).unwrap() + 1;
        }
        self.phones[pp..].iter().take_while(|&&c| c != 0).map(|&c| PHONES[c as usize - 1]).collect()
    }

    /// Every word and its phones (none if left to the G2P), in order.
    pub fn entries(&self) -> Vec<(String, Vec<&'static str>)> {
        let mut out = Vec::with_capacity(self.len);
        for (b, &(wp, pp)) in self.heads.iter().enumerate() {
            self.decode_block(b, wp, |j, w| {
                out.push((String::from_utf8_lossy(w).into_owned(), self.phones_at(pp, j)));
                false
            });
        }
        out
    }

    /// Calls f with each word of block b in order until f returns true; the index it stopped at.
    fn decode_block(&self, b: usize, mut wp: usize, mut f: impl FnMut(usize, &[u8]) -> bool) -> Option<usize> {
        let n = self.block.min(self.len - b * self.block);
        let mut cur = Vec::new();
        for j in 0..n {
            if j > 0 {
                cur.truncate(self.words[wp] as usize);
                wp += 1;
            }
            let (suffix, next) = self.line(wp);
            cur.extend_from_slice(suffix);
            wp = next;
            if f(j, &cur) {
                return Some(j);
            }
        }
        None
    }

    /// The word's phones: none if left to the G2P.
    pub fn get(&self, word: &str) -> Option<Vec<&'static str>> {
        let w = word.as_bytes();
        // the last block whose first word is at most w
        let b = self.heads.partition_point(|&(wp, _)| self.line(wp).0 <= w);
        if b == 0 {
            return None;
        }
        let (wp, pp) = self.heads[b - 1];
        let mut found = false;
        let j = self.decode_block(b - 1, wp, |_, cur| {
            found = cur == w;
            cur >= w
        })?;
        found.then(|| self.phones_at(pp, j))
    }
}
