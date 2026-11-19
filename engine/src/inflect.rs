// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Inflection as edits to the score (ssml.rs gives what is asked). Durations: each word's tokens
//! scaled by its rate, an emphasized word's tokens and the spaces either side given the frames
//! readers add, a reduced word's shortened, a break the whole pause at the stop it falls on (a
//! comma where there is none): the stop keeps what of its own time fits, and the space or end after
//! it, which the decoder leaves silent, takes the rest. Pitch: operations on the log F0 the score
//! model (or the flow) gives, each over a stretch of frames and anchored on the pitch where the
//! stretch starts, so a stream can apply them as the pitch comes: a span's semitones, a span set
//! to a pitch in Hz, an emphasized word's rise, a reduced word flattened, a yes-no question's
//! rise from its last stressed vowel, and an exclamation's end held up from its nucleus. The decoder takes the model's own pitch and the vocoder the edited
//! one, so an edit moves the voice's pitch and not its vowels. Loudness: decibels on the envelope,
//! after any sharpening.

use crate::breaks::Breaks;
use crate::dsp::{NBIN, NFFT, SR};
use crate::front::{self, Phonemizer, BOS, EOS, SPACE};
use crate::score::{semitones, unvoiced_frames, Pitch, Score, ScoreModel};
use crate::melvoc::N_MEL;
use crate::ssml::{Ctl, Emphasis, Piece};
use crate::vocoder::{Frames, N_ENV};
use crate::weights::{err, Result};

/// Frames a second.
const FPS: f32 = 100.0;
/// Frames over which a span's pitch or loudness comes in and goes out.
const PITCH_RAMP: usize = 5;
const GAIN_RAMP: usize = 3;
/// Words that open a question that falls (a wh-question); others rise.
const WH: [&str; 9] = [
    "what", "where", "when", "why", "who", "whom", "whose", "which", "how",
];
/// Words a clause may open with before its wh-word.
const LEAD: [&str; 8] = ["and", "but", "so", "or", "then", "well", "oh", "now"];
/// A question's last comma-part of at most this many words is a tag or a vocative ("sir").
const TAG: usize = 2;

/// Whether a question falls, from its words and the stop after each: its own clause is what follows
/// its last semicolon or colon; of that clause's comma-parts, the last longer than a tag decides (the
/// first when none is), falling when it opens with a wh-word, after any of LEAD.
fn falls(texts: &[&str], stops: &[Option<&str>]) -> bool {
    let mut parts: Vec<(usize, usize)> = Vec::new();
    let mut a = 0;
    for (i, s) in stops.iter().enumerate() {
        match *s {
            Some(";") | Some(":") => {
                parts.clear();
                a = i + 1;
            }
            Some(",") => {
                parts.push((a, i + 1));
                a = i + 1;
            }
            _ => {}
        }
    }
    if a < texts.len() {
        parts.push((a, texts.len()));
    }
    let Some(&(a, b)) = parts
        .iter()
        .rev()
        .find(|(a, b)| b - a > TAG)
        .or(parts.first())
    else {
        return false;
    };
    texts[a..b]
        .iter()
        .find(|w| !LEAD.contains(w))
        .is_some_and(|w| WH.contains(w))
}
/// Semitones a yes-no question rises by the end of its last vowel, from its last stressed vowel's
/// start, and how much of the model's own movement it keeps there.
const RISE: f32 = 8.0;
/// An exclamation (a sentence ending in '!'), at strength 1: from its nucleus's stressed vowel
/// rising EXCLAIM_RISE semitones by the nucleus's end and held there to the sentence's end; the
/// sentence EXCLAIM_DB louder. Its nucleus is its last word with a vowel not in FUNCTION, else its
/// last word with a vowel. The rise is the one at which the engine's '!' against its '.' comes to
/// LibriTTS-R's readers' on the same texts, by the pitch after the nucleus's stressed vowel and
/// over the sentence's last frames (score-L's aligner). The sentence's pitch, its span, its
/// nucleus's peak and its spectrum's tilt the model gives as the readers do.
const EXCLAIM_RISE: f32 = 1.0;
const EXCLAIM_DB: f32 = 1.3;
/// Frames of the running mean a widening is above.
const EXCLAIM_TAU: f32 = 50.0;
/// The lowest band centre the tilt tells apart, Hz.
const TILT_FLOOR: f32 = 100.0;
/// Words that do not take a sentence's nuclear accent when a later one could.
const FUNCTION: [&str; 102] = [
    "a", "an", "the", "and", "but", "or", "nor", "so", "of", "to", "in", "on", "at", "for", "with",
    "by", "from", "into", "onto", "upon", "about", "as", "than", "then", "is", "are", "was", "were",
    "be", "been", "being", "am", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
    "us", "them", "my", "your", "his", "its", "our", "their", "this", "that", "these", "those",
    "do", "does", "did", "have", "has", "had", "will", "would", "can", "could", "shall", "should",
    "may", "might", "must", "there", "here", "if", "just", "very", "too", "that's", "it's", "i'm",
    "you're", "he's", "she's", "we're", "they're", "i'll", "you'll", "he'll", "she'll", "we'll",
    "they'll", "i've", "you've", "we've", "they've", "i'd", "you'd", "he'd", "she'd", "we'd",
    "they'd", "don't", "there's", "what's",
];
const RISE_KEEP: f32 = 0.15;
/// An emphasized word at strength 1: a word all its listeners marked as emphasized against the
/// same word where none did, as LibriTTS-R's readers say them (the slope on the share marking it;
/// Morrison's crowdsourced prominence annotations, doi:10.5281/zenodo.10402793), less the model's
/// own on the same texts (score-L's aligner). The pitch and level are those at which the engine's
/// emphasized word against its own plain reading, measured the same way, comes to the readers':
/// the model moves its own pitch on a lengthened word. The words beside it the readers say as the
/// model does.
///
/// Frames its tokens gain, by the word's syllables (one, more): the space before it, the
/// consonants before its stressed vowel, the vowel, the consonants after it, the word's last
/// consonants (when not those), its other vowels, its other consonants, and the space after it.
const ADDED: [[f32; 2]; 8] = [
    [3.0, 2.8],
    [1.5, 0.9],
    [3.6, 1.8],
    [1.4, 0.7],
    [0.0, 0.5],
    [0.0, 0.7],
    [0.0, 0.3],
    [1.8, 3.4],
];
/// Semitones on the model's pitch: FOCUS_START at the word's start, rising to FOCUS_PEAK at
/// FOCUS_AT of its stressed vowel (a word ending on that syllable, one that goes on); the first
/// held to its end, the second falling to FOCUS_END by its end.
const FOCUS_START: f32 = 0.7;
const FOCUS_PEAK: [f32; 2] = [3.2, 2.3];
const FOCUS_AT: f32 = 0.5;
const FOCUS_END: f32 = 1.0;
/// Decibels on the word, its stressed vowel's.
const FOCUS_DB: f32 = 2.2;
/// Frames LibriTTS-R's readers pause at a comma, the stop and the space after it (500 held-out
/// readings, score-L's aligner): [0] + [1] ln(words since the last stop) + [2] ln(words to the next).
/// The model's own pause there is about the readers' mean less what it cannot tell, so a comma
/// gets at least this.
const COMMA_PAUSE: [f32; 3] = [16.5, 6.7, 6.2];
/// The least at a semicolon or colon, and at a full stop with a sentence after it. A question's or
/// exclamation's is the model's: inside the utterance one is mostly in dialogue ("what?" he asked).
const CLAUSE_PAUSE: f32 = 55.0;
const SENTENCE_PAUSE: f32 = 80.0;
/// A reduced word: its frames' times, and decibels.
const REDUCED_TIME: f32 = 0.85;
const REDUCED_DB: f32 = -3.0;
/// How readers say a word over how the page's voices say it: its stressed vowel's frames times, its
/// other tokens' frames times, decibels and semitones.
#[derive(Clone, Copy, PartialEq)]
struct Said(f32, f32, f32, f32);
const AS_MODEL: Said = Said(1.0, 1.0, 0.0, 0.0);
/// Rarer words said as a function word (bee, hymn, knot, witch, butt, bin, oar, ore, wee, aye, ewe,
/// yew, yore, whir, awl, sew), pooled.
const RARE: (Said, Said) = (Said(1.77, 1.52, 0.0, 0.55), Said(1.35, 1.1, 0.9, 0.0));
/// Words the score model says as the function word that shares their phones ("two" as "to", "buy"
/// as "by", "hear" as "here"), and what LibriTTS-R's readers give them over the page's voices on the
/// same texts (score-L's aligner), less what they give the other one-syllable words of those
/// lines: with a word after them, then before a stop.
const LEXICAL: [(&str, Said, Said); 33] = [
    ("two", Said(1.85, 1.75, 0.3, 2.8), Said(1.05, 1.1, -1.1, 2.0)),
    ("too", Said(2.15, 1.8, -0.4, 2.4), Said(0.94, 1.3, -0.3, 2.35)),
    ("hour", Said(2.0, 0.95, 1.5, -0.3), Said(1.15, 1.0, 0.5, -0.8)),
    ("wood", Said(1.95, 1.22, 0.3, -1.3), Said(1.0, 1.2, -1.75, 1.7)),
    ("due", Said(1.15, 1.43, 0.4, -0.9), AS_MODEL),
    ("dew", Said(1.15, 1.43, 0.4, -0.9), AS_MODEL),
    ("wear", Said(1.4, 1.3, 0.0, -0.45), AS_MODEL),
    ("ware", Said(1.4, 1.3, 0.0, -0.45), AS_MODEL),
    ("won", Said(1.2, 1.26, 0.0, 0.0), AS_MODEL),
    ("sum", Said(1.45, 1.36, 0.0, 0.7), Said(1.37, 1.17, 1.0, 2.5)),
    ("bye", Said(1.6, 2.1, 0.5, 0.6), Said(1.0, 1.0, 0.2, 3.6)),
    ("buy", Said(1.2, 1.52, 0.0, -0.35), AS_MODEL),
    ("ann", Said(5.2, 1.0, 0.0, 0.0), AS_MODEL),
    ("anne", Said(5.2, 1.0, 0.0, 0.0), AS_MODEL),
    ("know", Said(1.03, 1.22, 0.9, -1.8), Said(0.89, 0.92, 0.0, 0.0)),
    ("hear", Said(0.89, 1.1, -0.65, 1.4), Said(1.16, 1.0, 0.6, 1.3)),
    ("threw", Said(1.58, 1.08, 0.4, 1.15), AS_MODEL),
    ("bee", RARE.0, RARE.1),
    ("hymn", RARE.0, RARE.1),
    ("knot", RARE.0, RARE.1),
    ("witch", RARE.0, RARE.1),
    ("butt", RARE.0, RARE.1),
    ("bin", RARE.0, RARE.1),
    ("oar", RARE.0, RARE.1),
    ("ore", RARE.0, RARE.1),
    ("wee", RARE.0, RARE.1),
    ("aye", RARE.0, RARE.1),
    ("ewe", RARE.0, RARE.1),
    ("yew", RARE.0, RARE.1),
    ("yore", RARE.0, RARE.1),
    ("whir", RARE.0, RARE.1),
    ("awl", RARE.0, RARE.1),
    ("sew", RARE.0, RARE.1),
];

/// An emphasis's strength: strong a word all its listeners marked, moderate one half of them did.
fn focus(e: Emphasis) -> Option<f32> {
    match e {
        Emphasis::Strong => Some(1.0),
        Emphasis::Moderate => Some(0.5),
        Emphasis::Reduced | Emphasis::None => None,
    }
}

struct Word {
    /// As written.
    text: String,
    /// Its tokens.
    first: usize,
    end: usize,
    /// Its stressed vowel's token, if it has a vowel.
    stressed: Option<usize>,
    ctl: Ctl,
    /// Its sentence's first token, and the last of its tail: its stop and the space or end after it.
    sentence_start: usize,
    sentence_end: usize,
}

/// Text with what was asked of it, as tokens and the edits to make to their score.
pub struct Inflection {
    pub tokens: Vec<usize>,
    words: Vec<Word>,
    /// Milliseconds of pause asked at a stop token, with the space or end after it, or at the start.
    pause: Vec<Option<f32>>,
    /// Questions that rise: the stressed vowel's token, the last vowel's, and the last of its tail.
    rises: Vec<(usize, usize, usize)>,
    /// A comma put where a reader would break (phrase), and a space asked to have no break.
    phrased: Vec<bool>,
    joined: Vec<bool>,
    pub delivery: Delivery,
    /// Each word's phones' frames scaled, not the spaces' or stops' (Voice::pace).
    pub pace: f32,
    /// The exclamation's edits scaled: 0 none, 1 as readers.
    pub exclaim: f32,
    /// Its whole sentence's lift, semitones, tilt, dB an octave, and widening (none unless asked),
    /// and its end's rise, semitones, at strength 1.
    pub exclaim_lift: f32,
    pub exclaim_tilt: f32,
    pub exclaim_span: f32,
    pub exclaim_rise: f32,
    /// LEXICAL's edits scaled: 0 none, 1 as readers.
    pub lexical: f32,
}

/// Changes to the model's reading as a whole, each 1 for none; whole utterances only.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Delivery {
    /// Each word's pitch, its mean less the utterance's trend, moved this many times as far from
    /// the trend; the shift runs linearly between word centres, so a word's own shape stays.
    pub word_pitch: f32,
    /// The frames at a stop inside the utterance and the space after it, scaled.
    pub pauses: f32,
}

impl Default for Delivery {
    fn default() -> Self {
        Delivery { word_pitch: 1.0, pauses: 1.0 }
    }
}

fn is_stop_token(t: usize) -> bool {
    matches!(front::symbol(t), "," | "." | "?" | "!" | ";" | ":")
}

fn is_vowel(t: usize) -> bool {
    front::symbol(t).ends_with(|c: char| c.is_ascii_digit())
}

fn stressed(tok: &[usize]) -> Option<usize> {
    let s = |d: char| tok.iter().position(|&t| front::symbol(t).ends_with(d));
    s('1')
        .or_else(|| s('2'))
        .or_else(|| tok.iter().position(|&t| is_vowel(t)))
}

impl Inflection {
    /// Tokens as Phonemizer::encode makes them: ^ word (space word)* with stops after their
    /// words, then $; a break where no stop is takes a comma.
    pub fn new(ph: &mut Phonemizer, pieces: &[Piece]) -> Result<Inflection> {
        let mut tokens = vec![BOS];
        let mut pause: Vec<Option<f32>> = vec![None];
        let mut words: Vec<Word> = Vec::new();
        let mut texts: Vec<String> = Vec::new();
        let mut joined = vec![false];
        let mut join_next = false;
        let mut prev_word = false;
        // the words and stops as said, a break as a comma, for heteronyms' senses
        let mut low: Vec<String> = Vec::new();
        let mut at: Vec<usize> = Vec::new();
        for p in pieces {
            at.push(low.len());
            match p {
                Piece::Word { text, .. } => low.push(text.to_ascii_lowercase()),
                Piece::Stop(s) => low.push(s.to_string()),
                Piece::Break(ms) if *ms > 0.0 => low.push(",".to_string()),
                Piece::Break(_) => {}
            }
        }
        for (k, p) in pieces.iter().enumerate() {
            match p {
                Piece::Word { text, phones, ctl } => {
                    if prev_word || tokens.len() > 1 {
                        tokens.push(SPACE);
                        pause.push(None);
                        joined.resize(tokens.len() - 1, false);
                        joined.push(join_next);
                    }
                    join_next = false;
                    let ph = match phones {
                        Some(p) => p.clone(),
                        None => ph.phones_in(text, &low, at[k])?,
                    };
                    let first = tokens.len();
                    tokens.extend(ph.iter().map(|p| front::symbol_id(p).unwrap()));
                    pause.resize(tokens.len(), None);
                    let stressed = stressed(&tokens[first..]).map(|i| first + i);
                    words.push(Word {
                        text: text.clone(),
                        first,
                        end: tokens.len(),
                        stressed,
                        ctl: ctl.clone(),
                        sentence_start: 0,
                        sentence_end: 0,
                    });
                    texts.push(text.to_ascii_lowercase());
                    prev_word = true;
                }
                Piece::Stop(s) => {
                    if !prev_word {
                        return err(format!("a stop {s} with no word before it"));
                    }
                    tokens.push(front::symbol_id(s).unwrap());
                    pause.push(None);
                    prev_word = false;
                }
                Piece::Break(ms) => {
                    if prev_word {
                        if *ms == 0.0 {
                            join_next = true;
                            continue;
                        }
                        tokens.push(front::symbol_id(",").unwrap());
                        pause.push(Some(*ms));
                        prev_word = false;
                    } else {
                        let last = pause.last_mut().unwrap();
                        *last = Some(last.unwrap_or(0.0) + ms);
                    }
                }
            }
        }
        tokens.push(EOS);
        pause.push(None);
        joined.resize(tokens.len(), false);
        // sentences: up to a full stop, question or exclamation, or the end
        let ends: Vec<usize> = (0..tokens.len())
            .filter(|&i| [".", "?", "!", "$"].contains(&front::symbol(tokens[i])))
            .collect();
        let mut rises = Vec::new();
        let mut w0 = 0;
        for &e in &ends {
            // a sentence's tail: its stop and the space or end after it
            let mut b = e;
            while b + 1 < tokens.len() && [SPACE, EOS].contains(&tokens[b + 1]) {
                b += 1;
            }
            let w1 = words
                .iter()
                .position(|w| w.first > e)
                .unwrap_or(words.len());
            let start = words.get(w0).map_or(0, |w| w.first);
            for w in &mut words[w0..w1] {
                w.sentence_start = start;
                w.sentence_end = b;
            }
            let stop = |w: &Word| {
                tokens
                    .get(w.end)
                    .map(|&t| front::symbol(t))
                    .filter(|s| [",", ";", ":"].contains(s))
            };
            let ws: Vec<&str> = texts[w0..w1].iter().map(|t| t.as_str()).collect();
            let st: Vec<Option<&str>> = words[w0..w1].iter().map(stop).collect();
            if front::symbol(tokens[e]) == "?" && w1 > w0 && !falls(&ws, &st) {
                let last = (words[w0].first..e).rev().find(|&i| is_vowel(tokens[i]));
                if let (Some(v), Some(last)) =
                    (words[w0..w1].iter().rev().find_map(|w| w.stressed), last)
                {
                    rises.push((v, last, b));
                }
            }
            w0 = w1;
        }
        Ok(Inflection {
            phrased: vec![false; tokens.len()],
            tokens,
            words,
            pause,
            rises,
            joined,
            delivery: Delivery::default(),
            pace: 1.0,
            exclaim: 1.0,
            exclaim_lift: 0.0,
            exclaim_tilt: 0.0,
            exclaim_span: 1.0,
            exclaim_rise: EXCLAIM_RISE,
            lexical: 1.0,
        })
    }

    /// Each word as written, with its tokens [first, end).
    pub fn words(&self) -> impl Iterator<Item = (&str, usize, usize)> {
        self.words.iter().map(|w| (w.text.as_str(), w.first, w.end))
    }

    /// Whether each token is a comma put where a reader would break (phrase).
    pub fn phrased(&self) -> &[bool] {
        &self.phrased
    }

    /// The questions that rise, each as the tokens [stressed vowel, end of its tail].
    pub fn rises(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        self.rises.iter().map(|&(v, _, b)| (v, b + 1))
    }

    /// The sentences ending in '!', each as its tokens [first word's first, end of its tail) and
    /// its nucleus's word (none when no word has a vowel).
    pub fn exclaims(&self) -> Vec<(usize, usize, Option<usize>)> {
        let mut out = Vec::new();
        for (k, w) in self.words.iter().enumerate() {
            let last = self.words.get(k + 1).is_none_or(|x| x.sentence_start != w.sentence_start);
            if last && w.end < self.tokens.len() && front::symbol(self.tokens[w.end]) == "!" {
                let s = (0..=k).rev().take_while(|&j| self.words[j].sentence_start == w.sentence_start);
                let content = |j: &usize| {
                    let t = self.words[*j].text.to_ascii_lowercase().replace('\u{2019}', "'");
                    !FUNCTION.contains(&t.as_str())
                };
                let voiced = |j: &usize| self.words[*j].stressed.is_some();
                let nucleus = s.clone().filter(voiced).find(content).or_else(|| s.filter(voiced).next());
                out.push((w.sentence_start, w.sentence_end + 1, nucleus));
            }
        }
        out
    }

    /// Commas where a reader would break: at the space between two words, no break of none asked
    /// there, whose logit is above the one `rate` of such gaps pass. A phrased comma does not
    /// count as a stop for a comma's least pause.
    pub fn phrase(&mut self, b: &Breaks, rate: f32) -> Result<()> {
        let cut = b.cut(rate)?;
        let logit = b.logits(&self.tokens)?;
        let at: Vec<usize> = self
            .words
            .windows(2)
            .filter(|w| {
                let i = w[0].end;
                w[1].first == i + 1
                    && self.tokens[i] == SPACE
                    && !self.joined[i]
                    && (w[0].first..i).any(|j| is_vowel(self.tokens[j]))
                    && logit[i] > cut
            })
            .map(|w| w[0].end)
            .collect();
        for &i in at.iter().rev() {
            self.insert_comma(i);
        }
        Ok(())
    }

    /// A phrased comma at token i, a space between words, before it.
    fn insert_comma(&mut self, i: usize) {
        let comma = front::symbol_id(",").unwrap();
        self.tokens.insert(i, comma);
        self.pause.insert(i, None);
        self.phrased.insert(i, true);
        self.joined.insert(i, false);
        let tok = |x: &mut usize| *x += (*x >= i) as usize;
        for w in &mut self.words {
            tok(&mut w.first);
            w.end += (w.end > i) as usize;
            if let Some(v) = w.stressed.as_mut() {
                tok(v);
            }
            tok(&mut w.sentence_start);
            tok(&mut w.sentence_end);
        }
        for (v, last, e) in &mut self.rises {
            tok(v);
            tok(last);
            tok(e);
        }
    }

    /// The least frames, at rate 1, of the stop at token i and the space after it: a comma's by
    /// the words either side of it up to the stops before and after, a semicolon's, colon's or full
    /// stop's; None for a question or exclamation.
    fn least_pause(&self, i: usize) -> Option<f32> {
        if self.phrased[i] {
            return None;
        }
        let stop = |w: &Word| w.end < self.tokens.len() && is_stop_token(self.tokens[w.end]) && !self.phrased[w.end];
        match front::symbol(self.tokens[i]) {
            "," => {
                let k = self.words.iter().position(|w| w.end == i)?;
                let before = 1 + self.words[..k].iter().rev().take_while(|w| !stop(w)).count();
                // through the word the next stop follows, or the last
                let rest = &self.words[k + 1..];
                let after = 1 + rest.iter().take_while(|w| !stop(w)).count().min(rest.len() - 1);
                let [a, b, c] = COMMA_PAUSE;
                Some(a + b * (before as f32).ln() + c * (after as f32).ln())
            }
            ";" | ":" => Some(CLAUSE_PAUSE),
            "." => Some(SENTENCE_PAUSE),
            _ => None,
        }
    }

    /// Frames a token, and the edits to its pitch and loudness.
    pub fn edits(&self, score: &ScoreModel, h: &[f32], rate: f32) -> Result<Edits> {
        if !(rate > 0.0) {
            return err(format!("rate {rate} must be positive"));
        }
        let n = self.tokens.len();
        let mut scale = vec![1.0f32; n];
        let mut word_rate = 1.0f32;
        let mut wi = 0;
        for i in 0..n {
            if wi < self.words.len() && i == self.words[wi].first {
                word_rate = self.words[wi].ctl.rate;
            }
            if wi < self.words.len() && i == self.words[wi].end {
                wi += 1;
            }
            scale[i] = 1.0 / word_rate;
        }
        if !(self.pace > 0.0) {
            return err(format!("pace {} must be positive", self.pace));
        }
        for w in &self.words {
            (w.first..w.end).for_each(|i| scale[i] *= self.pace);
            if w.ctl.emphasis == Some(Emphasis::Reduced) {
                (w.first..w.end).for_each(|i| scale[i] *= REDUCED_TIME);
            }
        }
        if !(self.lexical >= 0.0) {
            return err(format!("lexical {} must be 0 or more", self.lexical));
        }
        let lexical: Vec<(usize, f32, f32)> = self
            .words
            .iter()
            .enumerate()
            .filter(|(_, w)| w.ctl.emphasis.is_none() && self.lexical > 0.0)
            .filter_map(|(k, w)| {
                let t = w.text.to_ascii_lowercase();
                let &(_, inside, stop) = LEXICAL.iter().find(|e| e.0 == t)?;
                let Said(v, rest, db, st) = if self.tokens.get(w.end) == Some(&SPACE) { inside } else { stop };
                for i in w.first..w.end {
                    scale[i] *= (if Some(i) == w.stressed { v } else { rest }).powf(self.lexical);
                }
                Some((k, db * self.lexical, st * self.lexical))
            })
            .collect();
        if !(self.exclaim >= 0.0) {
            return err(format!("exclaim {} must be 0 or more", self.exclaim));
        }
        let exclaims = if self.exclaim > 0.0 { self.exclaims() } else { Vec::new() };
        let mut spelled = vec![false; n];
        for w in self.words.iter().filter(|w| w.text.starts_with('_')) {
            spelled[w.first..w.end].iter_mut().for_each(|s| *s = true);
        }
        let logd = score.log_durations(&score.marked(h, &spelled), n);
        let mut durations: Vec<usize> = (0..n)
            .map(|i| {
                ((logd[i].max(0.0).exp_m1() * scale[i] / rate)
                    .round_ties_even()
                    .max(1.0)) as usize
            })
            .collect();
        for w in &self.words {
            let Some(k) = w.ctl.emphasis.and_then(focus) else {
                continue;
            };
            let syl = (w.first..w.end)
                .filter(|&i| is_vowel(self.tokens[i]))
                .count()
                .clamp(1, 2)
                - 1;
            // whole frames, the rest carried to the next token
            let mut rest = 0.0f32;
            let mut added = |c: usize| {
                rest += k * ADDED[c][syl] / (rate * w.ctl.rate);
                let whole = (rest + 0.5).floor();
                rest -= whole;
                whole as usize
            };
            if w.first > 1 && self.tokens[w.first - 1] == SPACE {
                durations[w.first - 1] += added(0);
            }
            let sv = w.stressed.unwrap_or(w.first);
            let last_vowel = (w.first..w.end).rev().find(|&i| is_vowel(self.tokens[i]));
            let vowel_in = |a: usize, b: usize| (a..b).any(|j| is_vowel(self.tokens[j]));
            for i in w.first..w.end {
                let c = if i == sv {
                    2
                } else if is_vowel(self.tokens[i]) {
                    5
                } else if i < sv && !vowel_in(i, sv) {
                    1
                } else if i > sv && !vowel_in(sv + 1, i + 1) {
                    3
                } else if last_vowel.is_some_and(|v| i > v) {
                    4
                } else {
                    6
                };
                durations[i] += added(c);
            }
            if w.end < n && self.tokens[w.end] == SPACE {
                durations[w.end] += added(7);
            }
        }
        // a stop inside the utterance with no break asked: at least the pause readers make there,
        // the space after it taking what more is needed (a stretched stop decodes voiced)
        for i in 1..n.saturating_sub(1) {
            if is_stop_token(self.tokens[i]) && self.tokens[i + 1] == SPACE && self.pause[i].is_none() {
                if let Some(least) = self.least_pause(i) {
                    let least = (least * scale[i] / rate).round() as usize;
                    let have = durations[i] + durations[i + 1];
                    if have < least {
                        durations[i + 1] += least - have;
                    }
                }
            }
        }
        if self.delivery.pauses != 1.0 {
            for i in 0..n.saturating_sub(1) {
                if is_stop_token(self.tokens[i]) && self.tokens[i + 1] == SPACE && self.pause[i].is_none() {
                    for j in [i, i + 1] {
                        durations[j] = ((durations[j] as f32 * self.delivery.pauses).round() as usize).max(1);
                    }
                }
            }
        }
        for i in 0..n {
            let Some(ms) = self.pause[i] else { continue };
            let total = (ms / 1000.0 * FPS).round() as usize;
            if i + 1 < n && [SPACE, EOS].contains(&self.tokens[i + 1]) {
                durations[i] = durations[i].min(total.saturating_sub(1)).max(1);
                durations[i + 1] = total.saturating_sub(durations[i]).max(1);
            } else {
                durations[i] = total.max(1);
            }
        }
        // test only: LS_DURS, a file of frames a token, in place of the planned durations
        if let Ok(f) = std::env::var("LS_DURS") {
            let s = match std::fs::read_to_string(&f) {
                Ok(s) => s,
                Err(e) => return err(format!("LS_DURS {f}: {e}")),
            };
            let mut d = Vec::with_capacity(n);
            for x in s.split_whitespace() {
                match x.parse::<usize>() {
                    Ok(v) if v > 0 => d.push(v),
                    Ok(_) => return err(format!("LS_DURS {f}: a token of 0 frames")),
                    Err(e) => return err(format!("LS_DURS {f}: {x}: {e}")),
                }
            }
            if d.len() != n {
                return err(format!("LS_DURS {f} has {} durations for {n} tokens", d.len()));
            }
            durations = d;
        }
        // test only: LS_DUMP_DURS, the tokens and their frames written to this file
        if let Ok(f) = std::env::var("LS_DUMP_DURS") {
            let line = |v: &[usize]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(" ");
            if let Err(e) = std::fs::write(&f, format!("{}\n{}\n", line(&self.tokens), line(&durations))) {
                return err(format!("LS_DUMP_DURS {f}: {e}"));
            }
        }
        let mut at = vec![0; n + 1];
        for i in 0..n {
            at[i + 1] = at[i] + durations[i];
        }
        let total = at[n];

        let mut ops = Vec::new();
        // spans of words asking the same pitch, the spaces between them included
        let mut i = 0;
        while i < self.words.len() {
            let c = &self.words[i].ctl;
            let mut j = i + 1;
            while j < self.words.len()
                && self.words[j].ctl.hz == c.hz
                && self.words[j].ctl.st == c.st
                && self.words[j].first == self.words[j - 1].end + 1
            {
                j += 1;
            }
            let (a, b) = (at[self.words[i].first], at[self.words[j - 1].end]);
            if let Some(hz) = c.hz {
                ops.push(Op {
                    a,
                    b,
                    ramp: PITCH_RAMP,
                    kind: Kind::Hz(hz.ln() + semitones(c.st)),
                });
            } else if c.st != 0.0 {
                ops.push(Op {
                    a,
                    b,
                    ramp: PITCH_RAMP,
                    kind: Kind::Shift(semitones(c.st)),
                });
            }
            i = j;
        }
        for w in &self.words {
            let (wa, wb) = (at[w.first], at[w.end]);
            if w.ctl.emphasis == Some(Emphasis::Reduced) {
                ops.push(Op {
                    a: wa,
                    b: wb,
                    ramp: PITCH_RAMP,
                    kind: Kind::Flatten {
                        keep: 0.5,
                        drop: semitones(-1.0),
                    },
                });
            }
            let (Some(k), Some(v)) = (w.ctl.emphasis.and_then(focus), w.stressed) else {
                continue;
            };
            let (va, vb) = (at[v], at[v + 1]);
            let goes_on = (v + 1..w.end).any(|i| is_vowel(self.tokens[i]));
            let peak = FOCUS_PEAK[goes_on as usize];
            ops.push(Op {
                a: wa,
                b: wb,
                ramp: 0,
                kind: Kind::RiseFall {
                    top: va + ((vb - va) as f32 * FOCUS_AT).round() as usize,
                    start: semitones(FOCUS_START * k),
                    peak: semitones(peak * k),
                    end: semitones(if goes_on { FOCUS_END } else { peak } * k),
                },
            });
        }
        for &(k, _, st) in lexical.iter().filter(|e| e.2 != 0.0) {
            let w = &self.words[k];
            ops.push(Op {
                a: at[w.first],
                b: at[w.end],
                ramp: PITCH_RAMP,
                kind: Kind::Shift(semitones(st)),
            });
        }
        for &(v, last, e) in &self.rises {
            let (a, last, b) = (at[v], at[last + 1], at[e + 1]);
            ops.push(Op {
                a,
                b,
                ramp: 0,
                kind: Kind::Rise {
                    len: (last - a).max(1),
                    height: semitones(RISE),
                },
            });
        }
        for &(a, b, _) in &exclaims {
            ops.push(Op {
                a: at[a],
                b: at[b],
                ramp: PITCH_RAMP,
                kind: Kind::Shift(semitones(self.exclaim_lift * self.exclaim)),
            });
            ops.push(Op {
                a: at[a],
                b: at[b],
                ramp: PITCH_RAMP,
                kind: Kind::Widen(1.0 + (self.exclaim_span - 1.0) * self.exclaim),
            });
        }
        for &(_, b, k) in &exclaims {
            let Some(w) = k.map(|k| &self.words[k]) else { continue };
            let v = w.stressed.expect("a nucleus has a vowel");
            ops.push(Op {
                a: at[v],
                b: at[b],
                ramp: 0,
                kind: Kind::Exclaim {
                    top: at[w.end],
                    height: semitones(self.exclaim_rise * self.exclaim),
                },
            });
        }
        ops.sort_by_key(|o| o.kind.order());
        let anchors = vec![0.0; ops.len()];

        let mut gain = vec![0.0f32; total];
        let mut any = false;
        let mut add = |a: usize, b: usize, db: f32| {
            if db != 0.0 {
                any = true;
                for f in a..b {
                    gain[f] += db * std::f32::consts::LN_10 / 10.0 * ramp(f, a, b, GAIN_RAMP);
                }
            }
        };
        // spans of words asking the same loudness, the spaces between them included; an
        // emphasized word's own on top
        let mut i = 0;
        while i < self.words.len() {
            let db = self.words[i].ctl.db;
            let mut j = i + 1;
            while j < self.words.len()
                && self.words[j].ctl.db == db
                && self.words[j].first == self.words[j - 1].end + 1
            {
                j += 1;
            }
            add(
                at[self.words[i].first],
                at[self.words[j - 1].end],
                db.max(-100.0),
            );
            i = j;
        }
        for &(a, b, _) in &exclaims {
            add(at[a], at[b], EXCLAIM_DB * self.exclaim);
        }
        let mut tilt = Vec::new();
        let k = self.exclaim_tilt * self.exclaim;
        if k != 0.0 && !exclaims.is_empty() {
            tilt = vec![0.0f32; total];
            for &(a, b, _) in &exclaims {
                let (a, b) = (at[a], at[b]);
                for f in a..b {
                    tilt[f] += k * std::f32::consts::LN_10 / 10.0 * ramp(f, a, b, GAIN_RAMP);
                }
            }
        }
        for &(k, db, _) in &lexical {
            add(at[self.words[k].first], at[self.words[k].end], db);
        }
        for w in &self.words {
            if w.ctl.emphasis == Some(Emphasis::Reduced) {
                add(at[w.first], at[w.end], REDUCED_DB);
            }
            if let Some(k) = w.ctl.emphasis.and_then(focus) {
                add(at[w.first], at[w.end], FOCUS_DB * k);
            }
        }
        if !any {
            gain.clear();
        }
        Ok(Edits {
            durations,
            contour: Contour {
                ops,
                anchors,
                next: 0,
            },
            gain,
            tilt,
        })
    }
}

/// Weight of frame f in [a, b): rising over the first `r` frames and falling over the last.
fn ramp(f: usize, a: usize, b: usize, r: usize) -> f32 {
    if r == 0 {
        return 1.0;
    }
    ((f - a + 1).min(b - f) as f32 / r as f32).min(1.0)
}

enum Kind {
    Shift(f32),
    /// The span starts at this log F0 and keeps the model's movement from there.
    Hz(f32),
    /// Lowered by `drop`, and movement above the lowest point so far kept by `keep`.
    Flatten {
        keep: f32,
        drop: f32,
    },
    /// Raised by `start` where it begins, rising to `peak` at `top` and going to `end` by its end.
    RiseFall {
        top: usize,
        start: f32,
        peak: f32,
        end: f32,
    },
    Rise {
        len: usize,
        height: f32,
    },
    /// Raised by `height` from `top` on, rising to it from the start.
    Exclaim {
        top: usize,
        height: f32,
    },
    /// Pitch above a running mean (EXCLAIM_TAU frames, from the pitch where it starts) this many
    /// times as far above it.
    Widen(f32),
}

impl Kind {
    fn order(&self) -> u8 {
        match self {
            Kind::Hz(_) => 0,
            Kind::Shift(_) => 1,
            Kind::Widen(_) => 2,
            Kind::Exclaim { .. } => 3,
            Kind::Flatten { .. } => 4,
            Kind::RiseFall { .. } => 5,
            Kind::Rise { .. } => 6,
        }
    }
}

struct Op {
    a: usize,
    b: usize,
    ramp: usize,
    kind: Kind,
}

/// The pitch operations, applied a frame at a time in order.
pub struct Contour {
    ops: Vec<Op>,
    anchors: Vec<f32>,
    next: usize,
}

impl Contour {
    /// No operations.
    pub fn none() -> Contour {
        Contour {
            ops: Vec::new(),
            anchors: Vec::new(),
            next: 0,
        }
    }

    /// The edited log F0 of the next frame, given the model's.
    pub fn apply(&mut self, mut v: f32) -> f32 {
        let f = self.next;
        self.next += 1;
        for (op, anchor) in self.ops.iter().zip(self.anchors.iter_mut()) {
            if f < op.a || f >= op.b {
                continue;
            }
            if f == op.a {
                *anchor = v;
            }
            let w = ramp(f, op.a, op.b, op.ramp);
            v = match op.kind {
                Kind::Shift(c) => v + w * c,
                Kind::Hz(t) => v + w * (t - *anchor),
                Kind::Flatten { keep, drop } => {
                    *anchor = anchor.min(v);
                    v + w * (*anchor + (v - *anchor) * keep + drop - v)
                }
                Kind::RiseFall { top, start, peak, end } => {
                    if f < top {
                        v + start + (peak - start) * ease((f - op.a) as f32 / (top - op.a).max(1) as f32)
                    } else {
                        v + peak + (end - peak) * ease((f - top) as f32 / (op.b - 1 - top).max(1) as f32)
                    }
                }
                Kind::Widen(k) => {
                    if f > op.a {
                        *anchor += (v - *anchor) / EXCLAIM_TAU;
                    }
                    v + w * (k - 1.0) * (v - *anchor).max(0.0)
                }
                Kind::Exclaim { top, height } => v + height * ease(((f - op.a) as f32 / (top - op.a).max(1) as f32).min(1.0)),
                Kind::Rise { len, height } => {
                    let x = ((f - op.a) as f32 / len as f32).min(1.0);
                    *anchor + (v - *anchor) * (1.0 - x * (1.0 - RISE_KEEP)) + height * x * x
                }
            };
        }
        v
    }
}

/// 0 to 1 over x in [0, 1], a half cosine.
fn ease(x: f32) -> f32 {
    0.5 * (1.0 - (std::f32::consts::PI * x).cos())
}

/// Inflection's edits for one utterance: frames a token, the pitch's contour, the loudness a frame
/// in log power, and the mel route's tilt a frame in log power an octave (each empty when none).
pub struct Edits {
    pub durations: Vec<usize>,
    pub contour: Contour,
    pub gain: Vec<f32>,
    pub tilt: Vec<f32>,
}

/// Octaves of each mel band's centre (HTK mel over 0 to 12 kHz; TILT_FLOOR at
/// least), and their mean over the bands.
fn band_octaves() -> ([f32; N_MEL], f32) {
    let top = 2595.0 * (1.0f32 + 12000.0 / 700.0).log10();
    let mut o = [0.0f32; N_MEL];
    for (c, x) in o.iter_mut().enumerate() {
        let hz = 700.0 * (10.0f32.powf(top * (c + 1) as f32 / (N_MEL + 1) as f32 / 2595.0) - 1.0);
        *x = hz.max(TILT_FLOOR).log2();
    }
    let m = o.iter().sum::<f32>() / N_MEL as f32;
    (o, m)
}

/// The tilt's shape on a mel: each band's octaves from the bands' mean.
fn octaves() -> [f32; N_MEL] {
    let (mut o, m) = band_octaves();
    o.iter_mut().for_each(|x| *x -= m);
    o
}

/// The tilt's shape at frequencies, Hz: each one's octaves (TILT_FLOOR at least) from the mel
/// bands' mean.
pub(crate) fn octaves_at(hz: impl Iterator<Item = f32>) -> Vec<f32> {
    let m = band_octaves().1;
    hz.map(|f| f.max(TILT_FLOOR).log2() - m).collect()
}

/// The tilt's shape on a spectrum: each STFT bin's.
pub(crate) fn bin_octaves() -> Vec<f32> {
    octaves_at((0..NBIN).map(|k| k as f32 * SR as f32 / NFFT as f32))
}

impl Edits {
    /// Adds the loudness to envelope rows from frame `from` on.
    pub fn gain(&self, env: &mut [f32], from: usize) {
        if self.gain.is_empty() {
            return;
        }
        for (k, row) in env.chunks_mut(N_ENV).enumerate() {
            let g = self.gain[from + k];
            row.iter_mut().for_each(|e| *e += g);
        }
    }

    /// Adds the loudness and the tilt to log-mel magnitude rows (half the log power) from frame
    /// `from` on.
    pub fn gain_mel(&self, mel: &mut [f32], from: usize) {
        if !self.gain.is_empty() {
            for (k, row) in mel.chunks_mut(N_MEL).enumerate() {
                let g = 0.5 * self.gain[from + k];
                row.iter_mut().for_each(|e| *e += g);
            }
        }
        if !self.tilt.is_empty() {
            let o = octaves();
            for (k, row) in mel.chunks_mut(N_MEL).enumerate() {
                let t = 0.5 * self.tilt[from + k];
                row.iter_mut().zip(o.iter()).for_each(|(e, x)| *e += t * x);
            }
        }
    }
}

/// The score before a decoder: the text encoder's token states, no speaker in them; the speaker's
/// over their frames; the model's log F0 and the edited, the voicing, and the edits.
pub struct Planned {
    pub states: Vec<f32>,
    pub hx: Vec<f32>,
    pub model: Vec<f32>,
    pub lf0: Vec<f32>,
    pub vuv: Vec<f32>,
    pub edits: Edits,
}

pub fn plan(
    score: &ScoreModel,
    inf: &Inflection,
    speaker: usize,
    rate: f32,
    shift: f32,
    pitch: Pitch,
) -> Result<Planned> {
    pitch.check(score)?;
    let states = score.states(&inf.tokens)?;
    let h = score.spoken(states.clone(), speaker)?;
    let mut ed = inf.edits(score, &h, rate)?;
    let hx = score.expand(&h, &ed.durations);
    let t = ed.durations.iter().sum();
    let (plf0, pv) = match pitch {
        Pitch::Head => score.pitch(&hx, t),
        Pitch::Flow(f, s) => {
            let x = f.sample(&h, &ed.durations, &s)?;
            (
                (0..t).map(|i| s.spread(x[2 * i])).collect(),
                (0..t).map(|i| x[2 * i + 1]).collect(),
            )
        }
    };
    let (mut model, mut vuv) = ScoreModel::to_lf0_vuv(&plf0, &pv, semitones(shift), &unvoiced_frames(&inf.tokens, &ed.durations));
    if inf.delivery.word_pitch != 1.0 {
        let spans: Vec<(usize, usize)> = inf.words.iter().map(|w| (w.first, w.end)).collect();
        word_pitch(&mut model, &vuv, &ed.durations, &spans, inf.delivery.word_pitch)?;
    }
    // test only: LS_PITCH, a file of log F0 and voicing a frame, in place of the planned pitch
    if let Ok(f) = std::env::var("LS_PITCH") {
        let s = match std::fs::read_to_string(&f) {
            Ok(s) => s,
            Err(e) => return err(format!("LS_PITCH {f}: {e}")),
        };
        let mut x = Vec::with_capacity(2 * t);
        for w in s.split_whitespace() {
            match w.parse::<f32>() {
                Ok(v) if v.is_finite() => x.push(v),
                Ok(v) => return err(format!("LS_PITCH {f}: {v}")),
                Err(e) => return err(format!("LS_PITCH {f}: {w}: {e}")),
            }
        }
        if x.len() != 2 * t {
            return err(format!("LS_PITCH {f} has {} values for {t} frames (log F0 and voicing each)", x.len()));
        }
        model = (0..t).map(|i| x[2 * i]).collect();
        vuv = (0..t).map(|i| x[2 * i + 1]).collect();
    }
    // test only: LS_DUMP_PITCH, the log F0 and voicing a frame written to this file
    if let Ok(f) = std::env::var("LS_DUMP_PITCH") {
        let s: Vec<String> = (0..t).map(|i| format!("{:.8e} {:.0}", model[i], vuv[i])).collect();
        if let Err(e) = std::fs::write(&f, s.join("\n") + "\n") {
            return err(format!("LS_DUMP_PITCH {f}: {e}"));
        }
    }
    let lf0 = model.iter().map(|&v| ed.contour.apply(v)).collect();
    Ok(Planned { states, hx, model, lf0, vuv, edits: ed })
}

/// Each word's mean log F0 over its voiced frames, less the line fit to all voiced frames, moved
/// k times as far from that line: (k - 1) times the offset at the word's centre, linear between
/// centres and held before the first and after the last. Words with no voiced frame are skipped.
fn word_pitch(lf0: &mut [f32], vuv: &[f32], durations: &[usize], words: &[(usize, usize)], k: f32) -> Result<()> {
    let voiced: Vec<usize> = (0..lf0.len()).filter(|&f| vuv[f] > 0.5).collect();
    if voiced.len() < 2 {
        return err("fewer than two voiced frames to fit the pitch's trend");
    }
    let n = voiced.len() as f64;
    let (mt, my) = voiced.iter().fold((0.0, 0.0), |(a, b), &f| (a + f as f64, b + lf0[f] as f64));
    let (mt, my) = (mt / n, my / n);
    let (sxy, sxx) = voiced.iter().fold((0.0, 0.0), |(a, b), &f| {
        let d = f as f64 - mt;
        (a + d * (lf0[f] as f64 - my), b + d * d)
    });
    let slope = sxy / sxx;
    let trend = |f: usize| (my + slope * (f as f64 - mt)) as f32;
    let mut at = vec![0; durations.len() + 1];
    for i in 0..durations.len() {
        at[i + 1] = at[i] + durations[i];
    }
    let mut knots: Vec<(f32, f32)> = Vec::new();
    for &(a, b) in words {
        let fr: Vec<usize> = (at[a]..at[b]).filter(|&f| vuv[f] > 0.5).collect();
        if fr.is_empty() {
            continue;
        }
        let off = fr.iter().map(|&f| lf0[f] - trend(f)).sum::<f32>() / fr.len() as f32;
        knots.push(((at[a] + at[b]) as f32 / 2.0, (k - 1.0) * off));
    }
    if knots.is_empty() {
        return err("no voiced word to move");
    }
    let mut j = 0;
    for (f, x) in lf0.iter_mut().enumerate() {
        let t = f as f32;
        while j + 1 < knots.len() && knots[j + 1].0 <= t {
            j += 1;
        }
        let s = if t <= knots[0].0 {
            knots[0].1
        } else if j + 1 == knots.len() {
            knots[j].1
        } else {
            let ((t0, s0), (t1, s1)) = (knots[j], knots[j + 1]);
            s0 + (s1 - s0) * (t - t0) / (t1 - t0)
        };
        *x += s;
    }
    Ok(())
}

/// The whole score with the inflection's edits but the loudness (Edits::gain, after any
/// sharpening).
pub fn infer(
    score: &ScoreModel,
    inf: &Inflection,
    speaker: usize,
    rate: f32,
    shift: f32,
    pitch: Pitch,
) -> Result<(Score, Edits)> {
    let Planned { hx, model, lf0, vuv, edits, .. } = plan(score, inf, speaker, rate, shift, pitch)?;
    let (env, bap) = score.decode(&hx, &model, &vuv);
    Ok((
        Score {
            durations: edits.durations.clone(),
            frames: Frames { env, bap, lf0, vuv },
        },
        edits,
    ))
}

#[cfg(test)]
mod tests {
    use super::falls;

    fn f(text: &str) -> bool {
        let mut ws = Vec::new();
        let mut st = Vec::new();
        for w in text.trim_end_matches('?').split_whitespace() {
            let s = w.trim_end_matches([',', ';', ':']);
            st.push(w.get(s.len()..).filter(|p| !p.is_empty()));
            ws.push(s);
        }
        falls(&ws, &st)
    }

    #[test]
    fn which_questions_fall() {
        for q in [
            "who is coming home tonight?",
            "keep away if you wish; when have I ever followed you?",
            "tell me, where did you go?",
            "and why not?",
            "where are you going, sir?",
            "what do you want, my dear?",
        ] {
            assert!(f(q), "{q}");
        }
        for q in [
            "are you coming home tonight?",
            "when you get there, will you call?",
            "you know where it is; will you come?",
            "is it?",
        ] {
            assert!(!f(q), "{q}");
        }
    }
}
