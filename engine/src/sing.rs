// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Singing: a song's notes write the score. A word takes one note per syllable (per vowel of its
//! phones). A vowel starts on its note's beat and holds to the note's end, less its syllable's
//! coda and the next syllable's onset; the consonants take the score model's durations (scaled by
//! `Style::consonants`, the stops' and affricates' kept, a lengthened vowel's floor
//! LENGTHENED_VOWEL), the onsets ahead of the beat; a word's first consonant keeps the space
//! before it, as in speech (a stop's closure, the start of a fricative). The pitch is the notes', changing as each
//! syllable's onset starts (and on the beat of each later note a vowel takes), smoothed by a Hann
//! window (the glide) and with vibrato on each held note, or a trained singer's motion (`Motion`);
//! the voicing is the score model's pitch
//! head on those durations, every vowel frame voiced and every voiceless consonant's frame unvoiced,
//! the space its word takes before it too (from TAIL frames in, where a sound runs into it);
//! the rests, the lead-in and the end are silent, a rest after a voiceless consonant from its
//! release's end (RELEASED).
//! How a word's sounds are sung where that is a choice is the song's diction (diction.rs): its
//! rules give each word's phones, a held vowel's close (a second vowel in the note's last frames)
//! and the dip through a voiced stop.
//! Dynamics (optional) raise a note with its height in its phrase, swell a long note and let a
//! phrase's last note fall away, as gain and brightness on the envelope (`louden`). The ring
//! (optional, `ring`) is the singer's formant: the sung vowels' envelope raised about RING_HZ.
//!
//! A song's text is read by song.rs (its head has the format; docs/release/repo/SCORE.md the spec).

use crate::diction::{self, is_vowel, At, Ph, Rules, Who};
use crate::dsp::{HOP, SR};
use crate::front::{self, Phonemizer, SPACE};
use crate::rng::Rng;
use crate::score::{Score, ScoreModel};
use crate::song;
use crate::vocoder::{Frames, N_AP, N_ENV};
use crate::weights::{err, Error, Result, Weights};

pub const FPS: f32 = SR as f32 / HOP as f32;
/// Frames of silence before the first onset and after the last note.
const LEAD: usize = 10;
/// A rest, the lead-in and the end are silent: the voice released over RELEASE frames (a raised
/// cosine in amplitude) into SILENCE_DB down and unvoiced from there (the decoder voices a long
/// pause token at full level).
const RELEASE: usize = 8;
const SILENCE_DB: f32 = 80.0;
/// A phrase's last voiceless consonant ends in the pause after it: the model draws a stop's
/// closure through its own frames and on, its burst 7 to 12 frames into the pause, and a
/// fricative's hiss rising through the pause's first frames (a T before a pause is 2 to 4 frames,
/// an S 2 or 3). The pause's first RELEASED frames sound, unvoiced, and the silence is released
/// into from there; cut at the consonant's end a held "night" has no T and "peace" no S.
const RELEASED: usize = 12;
/// After a rest, the space a word's first consonant takes is that consonant's. Before a voiced one
/// it is its voice, begun (a stop's voice bar too), and is left as sung through its last VOICE
/// frames; what a longer space has before those (to 0.5 s) is the decoder's murmur, 30 to 40 dB
/// under the vowel, and is silent as the rest is, the voice risen into over SWELL frames. Before a
/// voiceless one there is no voice to hold and the decoder draws that murmur, a fricative's
/// frication coming late in it: the space is silent but for its last ATTACK frames before a closure
/// and its last SWELL before frication (each rise a raised cosine in amplitude).
const ATTACK: usize = 3;
const SWELL: usize = 8;
const VOICE: usize = 14;

/// How a word starting on token `t` comes out of a rest's silence in its space of `d` frames: the
/// frames at the space's end that sound, and how many of those, from their first, it rises over.
/// None where the whole space is sung.
fn emerge(t: usize, d: usize) -> Option<(usize, usize)> {
    let s = front::symbol(t);
    if VOICELESS.contains(&s) {
        let r = if CLOSED.contains(&s) { ATTACK } else { SWELL }.min(d);
        Some((r, r))
    } else {
        (d > VOICE).then_some((VOICE, SWELL))
    }
}
/// Inside a phrase the sound before a word's space runs TAIL frames into it. A voiceless first
/// consonant sounds from there (the latent voice's hiss is up by the space's frame 2 or 3, however
/// long the space), and is unvoiced from there: on a sung pitch's pulses its hiss is a buzz.
const TAIL: usize = 2;
/// The fewest frames a vowel keeps; consonants are shortened to leave them.
const MIN_VOWEL: usize = 3;
/// Sung together a vowel keeps this share of its last note at least: the clock's consonants are a
/// word's said alone, longer than the same word's in a line, and at their full lengths a heavy word on a
/// short note ("text" on a half beat) is all consonant in every voice at once.
const CLOCKED_VOWEL: usize = 3;
/// The frames a vowel keeps (or half its note) when its consonants are lengthened.
const LENGTHENED_VOWEL: usize = 8;
const BOS: usize = 1;
const EOS: usize = 2;
const COMMA: usize = 4;
/// Dynamics, dB at --dynamics 1: per semitone from the phrase's mean note (at most MAX_DB either
/// way), a long note's swell at its middle, and the fall over a phrase's last note.
const PER_SEMITONE_DB: f32 = 0.6;
const MAX_DB: f32 = 4.0;
const SWELL_DB: f32 = 2.0;
const SWELL_FROM: f32 = 0.4; // seconds
const FALL_DB: f32 = 4.0;
/// The Hann window smoothing the gain, frames.
const GAIN_GLIDE: usize = 15;
/// The ring's centre and its width (standard deviation), octaves.
const RING_HZ: f32 = 3000.0;
const RING_OCTAVES: f32 = 0.3;
/// Consonants sung unvoiced.
const VOICELESS: [&str; 9] = ["P", "T", "K", "F", "TH", "S", "SH", "CH", "HH"];
/// Stops and affricates, which keep the score model's durations whatever the consonants' scale.
const CLOSED: [&str; 8] = ["P", "T", "K", "B", "D", "G", "CH", "JH"];
/// A word's first voiced stop after a voiced sound and before a vowel: the readers' pitch through
/// it, semitones on the sung line. Of 2636 such stops in LibriTTS-R by the aligner's frames, the
/// median pitch against the vowel's, its dip and its rise each scaled to the median stop's own (2.7
/// down, 1.6 up). STOP_CLOSE is stretched over the closure (the space and the stop), STOP_OPEN is
/// the vowel's first frames. On a pitch held level through the closure the latent voice sings on
/// through it and no stop is heard (boat as vote).
const VOICED_INTO: [&str; 11] = ["M", "N", "NG", "L", "R", "W", "Y", "V", "DH", "Z", "ZH"];
const STOP_CLOSE: [f32; 10] = [-0.58, -1.67, -2.06, -2.45, -2.70, -2.52, -1.55, 0.21, 1.60, 1.55];
const STOP_OPEN: [f32; 6] = [0.98, 0.65, 0.41, 0.25, 0.13, 0.05];
/// The fewest frames of space that are such a stop's closure.
const STOP_SPACE: usize = 3;
/// A word's first vowel after a word's last vowel: readers strike it again, the level 7 dB down at the
/// median just before it (LibriTTS-R, 832 such boundaries with the second vowel stressed) and the
/// pitch down 1.6 st. The dip, semitones on the sung line, over the first vowel's last VOWEL_FRAMES
/// frames (a raised cosine); on it the latent voice dips as the readers do (7 dB at the median of
/// 80, eight voices), and without it sings one vowel into the next (how I as one word).
const VOWEL_DIP: f32 = 1.5;
const VOWEL_FRAMES: usize = 6;
/// Frames over which joined motions cross, and over which a note's motion fades in and out.
const MOTION_FADE: usize = 10;
/// Frames into a note by which a singer's vibrato has grown: a join enters a note no sooner.
const MOTION_GROWN: usize = 30;
/// How far past that a join may enter, frames: a whole cycle of the slowest vibrato (4 Hz).
const MOTION_CYCLE: usize = 25;
/// Frames before a join's crossing that are matched with it: with the crossing a whole cycle of a
/// 5 Hz vibrato, so its depth is met as well as its place in the cycle.
const MOTION_LEAD: usize = 10;
/// The pieces tried at each join.
const MOTION_TRIES: usize = 16;
/// The Hann window that parts a singer's vibrato from the slower drift of its pitch, frames: its
/// first null under the slowest vibrato (4 Hz).
const MOTION_DRIFT: usize = 51;
/// A sung note takes a real note at least its length when its singer has this many to draw from.
const MOTION_FEW: usize = 4;

/// A trained singer's held notes, each its pitch about its own median, semitones a frame: `heads`
/// from a note's start, `tails` from inside one.
#[derive(Clone, Default)]
pub struct Held {
    pub heads: Vec<Vec<f32>>,
    pub tails: Vec<Vec<f32>>,
}

/// Trained singers' pitch motion, each singer's own. A voice sings as one
/// of the singers (by its seed), so its vibrato keeps that singer's rate and depth from note to
/// note. A sung note takes one of the singer's notes at least as long, from its start (a vibrato
/// grows over a note's first third of a second); longer than the singer held, it is several
/// joined, each entered past its start where it best meets the end of the one before. Clones share
/// the notes.
#[derive(Clone)]
pub struct Motion {
    singers: std::sync::Arc<Vec<Held>>,
    /// Each singer's pieces a join may enter: (a tail?, its index, the first frame to cross into it at).
    joins: std::sync::Arc<Vec<Vec<(bool, usize, usize)>>>,
}

impl Motion {
    /// "motion" (every piece end to end), "lengths" (frames a piece), "singers" (each piece's
    /// singer, from 0) and "starts" (1 for a piece from its note's start).
    pub fn load(w: &Weights) -> Result<Motion> {
        let (m, lens) = (&w.get("motion")?.data, &w.get("lengths")?.data);
        let (who, starts) = (&w.get("singers")?.data, &w.get("starts")?.data);
        if who.len() != lens.len() || starts.len() != lens.len() {
            return err(format!("motion: {} pieces, {} singers and {} starts of them", lens.len(), who.len(), starts.len()));
        }
        let mut singers: Vec<Held> = Vec::new();
        let mut at = 0;
        for ((&l, &s), &head) in lens.iter().zip(who.iter()).zip(starts.iter()) {
            let n = l as usize;
            if l.fract() != 0.0 || at + n > m.len() {
                return err(format!("motion: a piece of {l} frames at {at} of {}", m.len()));
            }
            if !(s >= 0.0 && s.fract() == 0.0 && s < lens.len() as f32) {
                return err(format!("motion: a piece of singer {s}"));
            }
            if head != 0.0 && head != 1.0 {
                return err(format!("motion: starts is 0 or 1, not {head}"));
            }
            if singers.len() <= s as usize {
                singers.resize(s as usize + 1, Held::default());
            }
            let h = &mut singers[s as usize];
            if head == 1.0 { &mut h.heads } else { &mut h.tails }.push(m[at..at + n].to_vec());
            at += n;
        }
        if at != m.len() {
            return err(format!("motion: lengths cover {at} of {} frames", m.len()));
        }
        Motion::new(singers)
    }

    /// Each singer's notes: every piece at least MOTION_LEAD + 2 MOTION_FADE frames (a join's match
    /// and crossing, and as much again after), a head to start a note with, and a piece a join can
    /// enter (a tail, or a head of at least MOTION_GROWN + 2 MOTION_FADE).
    pub fn new(singers: Vec<Held>) -> Result<Motion> {
        if singers.is_empty() {
            return err("motion: no singers");
        }
        let mut joins = Vec::with_capacity(singers.len());
        for (k, s) in singers.iter().enumerate() {
            let least = MOTION_LEAD + 2 * MOTION_FADE;
            if let Some(n) = s.heads.iter().chain(&s.tails).find(|n| n.len() < least) {
                return err(format!("motion: singer {k}: a piece of {} frames, under {least}", n.len()));
            }
            if s.heads.iter().chain(&s.tails).flatten().any(|v| !v.is_finite()) {
                return err(format!("motion: singer {k}: a pitch that is not a number"));
            }
            if s.heads.is_empty() {
                return err(format!("motion: singer {k}: no piece from a note's start"));
            }
            let heads = s.heads.iter().enumerate().filter(|(_, h)| h.len() >= MOTION_GROWN + 2 * MOTION_FADE).map(|(i, _)| (false, i, MOTION_GROWN));
            let j: Vec<(bool, usize, usize)> = heads.chain((0..s.tails.len()).map(|i| (true, i, MOTION_LEAD))).collect();
            if j.is_empty() {
                return err(format!("motion: singer {k}: no piece to carry a note on with"));
            }
            joins.push(j);
        }
        Ok(Motion { singers: std::sync::Arc::new(singers), joins: std::sync::Arc::new(joins) })
    }

    /// The singer a voice of this seed sings as: seeds in a row, singers in a row.
    pub fn singer(&self, seed: u64) -> usize {
        (seed % self.singers.len() as u64) as usize
    }

    /// `n` frames of singer `who`'s motion for a note: faded in and out over MOTION_FADE frames and
    /// centred on the note (a short note takes part of a vibrato's cycle, off the note when left as cut).
    fn placed(&self, who: usize, n: usize, rng: &mut Rng) -> Vec<f32> {
        let edge: Vec<f32> = (0..n).map(|i| (i + 1).min(n - i).min(MOTION_FADE) as f32 / MOTION_FADE as f32).collect();
        let mv = self.take(who, n, rng);
        let mean = mv.iter().zip(&edge).map(|(v, e)| v * e).sum::<f32>() / edge.iter().sum::<f32>();
        mv.iter().zip(&edge).map(|(v, e)| (v - mean) * e).collect()
    }

    /// `n` frames of singer `who`'s motion, from a note's start.
    fn take(&self, who: usize, n: usize, rng: &mut Rng) -> Vec<f32> {
        let (s, joins) = (&self.singers[who], &self.joins[who]);
        let pick = |of: usize, rng: &mut Rng| (rng.uniform() * of as f64) as usize % of;
        let long: Vec<&Vec<f32>> = s.heads.iter().filter(|x| x.len() >= n).collect();
        if long.len() >= MOTION_FEW {
            return long[pick(long.len(), rng)][..n].to_vec();
        }
        let mut out: Vec<f32> = s.heads[pick(s.heads.len(), rng)].clone();
        while out.len() < n {
            let k = out.len() - MOTION_FADE;
            let mut best: (f32, &[f32]) = (f32::INFINITY, &[]);
            for _ in 0..MOTION_TRIES {
                let (tail, i, from) = joins[pick(joins.len(), rng)];
                let piece = if tail { &s.tails[i] } else { &s.heads[i] };
                for o in from..=(piece.len() - 2 * MOTION_FADE).min(from + MOTION_CYCLE) {
                    let d: f32 = out[k - MOTION_LEAD..].iter().zip(&piece[o - MOTION_LEAD..]).map(|(a, b)| (a - b) * (a - b)).sum();
                    if d < best.0 {
                        best = (d, &piece[o..]);
                    }
                }
            }
            let next = best.1;
            for (i, &v) in next[..MOTION_FADE].iter().enumerate() {
                let w = (i + 1) as f32 / (MOTION_FADE + 1) as f32;
                out[k + i] = out[k + i] * (1.0 - w) + v * w;
            }
            out.extend_from_slice(&next[MOTION_FADE..]);
        }
        out.truncate(n);
        out
    }
}

pub struct Note {
    pub midi: f32,
    pub beats: f32,
}

pub enum Item {
    Word(String, Vec<Vec<Note>>), // a syllable's notes each
    Rest(f32),
}

pub struct Song {
    pub bpm: f32,
    pub items: Vec<Item>,
    /// The vibrato's size along the song, against the voice's own.
    pub vibrato: Lane,
    /// Sung with others (a `together` line): the consonants take the lengths of the clock the voices
    /// keep (ScoreModel::common_durations), not the singer's own, so that a section's consonants land
    /// as one and no one's vowel lies under another's S.
    pub together: bool,
    /// Each item's phones where its line writes them (`word{...}`).
    pub spelled: Vec<Option<Vec<Ph>>>,
    pub diction: Rules,
}

/// A value written along a song, as a pedal's is beside a part's notes: its points (beat, value)
/// in the order of their beats, straight lines between them, a jump where two share a beat; 1
/// before the first, and the last held.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Lane(pub Vec<(f32, f32)>);

impl Lane {
    pub fn at(&self, beat: f32) -> f32 {
        let i = self.0.partition_point(|p| p.0 <= beat);
        match (i.checked_sub(1).map(|k| self.0[k]), self.0.get(i)) {
            (None, _) => 1.0,
            (Some(a), None) => a.1,
            (Some(a), Some(b)) => a.1 + (b.1 - a.1) * (beat - a.0) / (b.0 - a.0),
        }
    }

    /// From `beat` on, each of `steps` in turn: a jump to its value, or with beats a glide to it
    /// over them. What was written to come after `beat` is left unsung.
    fn write(&mut self, beat: f32, steps: &[(f32, Option<f32>)]) {
        let v = self.at(beat);
        self.0.retain(|p| p.0 <= beat);
        self.0.push((beat, v));
        let mut at = beat;
        for &(v, over) in steps {
            at += over.unwrap_or(0.0);
            self.0.push((at, v));
        }
    }
}

pub use crate::song::midi;

impl Song {
    pub fn parse(text: &str) -> Result<Song> {
        Song::parse_under(text, Rules::default())
    }

    /// The song (song::read), its %diction lines read after `diction` (a rules file's, a caller's).
    pub fn parse_under(text: &str, mut diction: Rules) -> Result<Song> {
        let read = song::read(text)?;
        let (mut items, mut together, mut written, mut vibrato) = (Vec::new(), false, Vec::new(), Lane::default());
        // the beat a line starts on as `plan` counts it: summed as it sums, in f32
        let mut beat = 0.0f32;
        for l in &read.lines {
            let at = |e: Error| Error(format!("line {}: {}", l.n, e.0));
            match &l.line {
                song::Line::Bpm(_) => {}
                song::Line::Together => together = true,
                song::Line::Diction(f) => diction.read(f).map_err(|e| at(Error(format!("%diction {}: {}", f.join(" "), e.0))))?,
                song::Line::Rest(b) => {
                    beat += *b as f32;
                    items.push(Item::Rest(*b as f32));
                    written.push(None);
                }
                song::Line::Vibrato(sizes) => vibrato.write(beat, &sizes.iter().map(|z| (z.value as f32, z.over.map(|b| b as f32))).collect::<Vec<_>>()),
                song::Line::Word { word, braces, notes } => {
                    let phones = braces.map(|b| diction::phones(b.split(',')).map_err(|e| at(Error(format!("{word}{{{b}}}: {}", e.0))))).transpose()?;
                    // a note's beats read as f32 from its text, not rounded twice by way of f64
                    let notes: Vec<Vec<Note>> = notes.iter().map(|s| s.iter().map(|x| Note { midi: x.midi, beats: x.beats_text.parse().unwrap_or(x.beats as f32) }).collect()).collect();
                    for x in notes.iter().flatten() {
                        beat += x.beats;
                    }
                    items.push(Item::Word(word.to_string(), notes));
                    written.push(phones);
                }
            }
        }
        Ok(Song { bpm: read.bpm as f32, items, vibrato, together, spelled: written, diction })
    }
}

pub struct Style {
    /// Semitones added to every note.
    pub shift: f32,
    /// Peak vibrato, semitones, and its rate in Hz.
    pub vibrato: f32,
    pub vibrato_hz: f32,
    /// Seconds into a vowel before the vibrato starts, and to reach its depth.
    pub vibrato_delay: f32,
    pub vibrato_ramp: f32,
    /// The Hann window smoothing the notes' steps, frames.
    pub glide: usize,
    /// Dynamics scale; 0 for none.
    pub dynamics: f32,
    /// The consonants' durations but the stops' and affricates' against the score model's (the vowels give the time up).
    pub consonants: f32,
    /// Who sings: what the song's diction rules are for (`for=`).
    pub who: Who,
    /// The sung vowels' aperiodicity scaled: under 1 for less breath noise in them.
    pub breathiness: f32,
    /// A trained singer's pitch motion on every note, in place of the vibrato: the singer and the
    /// draws by seed. Its size against the singer's own: 1 as sung, 0 for none. Where the song
    /// writes the vibrato's size (`Song::vibrato`) that is the size of the motion's vibrato (what
    /// of it is faster than MOTION_DRIFT), the drift under it kept.
    pub motion: Option<Motion>,
    pub motion_scale: f32,
    pub seed: u64,
}

struct Syl {
    onset: Vec<usize>,
    vowel: usize,
    /// Where the token after the vowel is its closing vowel, which the notes hold too: the close's
    /// frames, and whether exactly those (written) or at most a third of the two tokens'.
    closed: Option<(usize, bool)>,
    coda: Vec<usize>,
    start: usize, // the beat, frames from the song's start
    end: usize,
    notes: Vec<(f32, usize)>, // MIDI and beat of each note the syllable takes
    rest: Option<usize>, // the rest token after it
}

pub struct Sung {
    pub tokens: Vec<usize>,
    pub score: Score,
    /// Vowel frames, and how many of them the pitch head voiced (all are sung voiced).
    pub vowel_frames: usize,
    pub vowel_voiced: usize,
    /// Voiceless consonants' frames, and how many of them the pitch head voiced (none are sung voiced).
    pub voiceless_frames: usize,
    pub voiceless_voiced: usize,
    /// Each note's word, MIDI (transposed) and vowel frames.
    pub notes: Vec<(String, f32, std::ops::Range<usize>)>,
    /// Each frame's dynamics, dB (all 0 without them); `louden` puts them on an envelope.
    pub gain: Vec<f32>,
    /// How sung each frame is: 1 in a vowel, 0 away from every vowel, smoothed; `ring` weights by it.
    pub sung: Vec<f32>,
}

/// How a frame is voiced: by the pitch head, or as the song sings it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Voicing {
    Head,
    Vowel,
    Voiceless,
    /// A space the voiceless consonant after it sounds in.
    Begun,
    Silent,
}

impl Voicing {
    /// The frame's voicing, 0 or 1, where the pitch head's logit is `logit`.
    pub fn vuv(self, logit: f32) -> f32 {
        match self {
            Voicing::Head => (logit > 0.0) as u8 as f32,
            Voicing::Vowel => 1.0,
            Voicing::Voiceless | Voicing::Begun | Voicing::Silent => 0.0,
        }
    }
}

/// A song fixed for one voice, short of the pitch head and the decoder: `sing` finishes it whole,
/// `Stream::sung` a few frames at a time.
pub struct Plan {
    pub tokens: Vec<usize>,
    /// The text encoder's token states, no speaker in them.
    pub states: Vec<f32>,
    /// The speaker's token states, and the frames each token takes.
    pub h: Vec<f32>,
    pub durations: Vec<usize>,
    /// Each frame's log F0: the notes' with their vibrato or motion, and the shift.
    pub lf0: Vec<f32>,
    /// Each frame's log F0 as the latent voice's loudness model and prior are told it, where that
    /// is not the one sung (vox::Stream::feed_told); or none, told the one sung.
    pub told: Vec<f32>,
    pub voicing: Vec<Voicing>,
    /// Each frame's silence, dB: off the decoder's envelope (`quieten`), or off the latent voice's
    /// samples (`loudness`).
    pub quiet: Vec<f32>,
    /// Each frame's factor on the decoder's aperiodicity (`breathe`).
    pub breath: Vec<f32>,
    /// As in `Sung`.
    pub gain: Vec<f32>,
    pub sung: Vec<f32>,
    pub notes: Vec<(String, f32, std::ops::Range<usize>)>,
    /// Each token: whether it is the close of the vowel before it.
    pub closes: Vec<bool>,
    /// Each token: the song's diction rules (Rules::lines) that gave its phone and its dip.
    pub by: Vec<(Option<usize>, Option<usize>)>,
}

impl Plan {
    /// The silent spans a singer could breathe in, frames from the song's start: the lead-in and
    /// each rest, a rest's with what its next word's space holds silent (`emerge`) and from the end
    /// of what a voiceless consonant before it sounds of it (RELEASED).
    pub fn rests(&self) -> Vec<std::ops::Range<usize>> {
        let mut out = Vec::new();
        let mut t = 0;
        for (i, (&k, &d)) in self.tokens.iter().zip(&self.durations).enumerate() {
            if (k == BOS || k == COMMA) && d > 0 {
                let space = k == COMMA && self.tokens.get(i + 1) == Some(&SPACE);
                let held = space.then(|| emerge(self.tokens[i + 2], self.durations[i + 1])).flatten().map_or(0, |(kept, _)| self.durations[i + 1] - kept);
                let released = if i > 0 && VOICELESS.contains(&front::symbol(self.tokens[i - 1])) { RELEASED.min(d) } else { 0 };
                out.push(t + released..t + d + held);
            }
            t += d;
        }
        out
    }

    /// The plan from frame `s` on, as it stands in the whole: the token `s` falls in keeps its
    /// frames from there.
    pub fn tail(&self, s: usize) -> Plan {
        let total: usize = self.durations.iter().sum();
        assert!(s <= total, "frame {s} of {total}");
        let (n, d) = (self.tokens.len(), self.h.len() / self.tokens.len().max(1));
        let (mut k, mut t) = (0, 0);
        while k < n && t + self.durations[k] <= s {
            t += self.durations[k];
            k += 1;
        }
        let mut durations = self.durations[k..].to_vec();
        if let Some(first) = durations.first_mut() {
            *first -= s - t;
        }
        Plan {
            tokens: self.tokens[k..].to_vec(),
            states: self.states[k * (self.states.len() / n.max(1))..].to_vec(),
            h: self.h[k * d..].to_vec(),
            durations,
            lf0: self.lf0[s..].to_vec(),
            told: if self.told.is_empty() { Vec::new() } else { self.told[s..].to_vec() },
            voicing: self.voicing[s..].to_vec(),
            quiet: self.quiet[s..].to_vec(),
            breath: self.breath[s..].to_vec(),
            gain: self.gain[s..].to_vec(),
            sung: self.sung[s..].to_vec(),
            notes: self.notes.iter().filter(|(_, _, r)| r.end > s).map(|(w, m, r)| (w.clone(), *m, r.start.saturating_sub(s)..r.end - s)).collect(),
            closes: self.closes[k..].to_vec(),
            by: self.by[k..].to_vec(),
        }
    }
}

/// A Hann window's weights, `g` taps (odd).
fn hann(g: usize) -> Vec<f32> {
    (0..g).map(|i| (std::f32::consts::PI * (i as f32 + 1.0) / (g as f32 + 1.0)).sin().powi(2)).collect()
}

/// `x` smoothed by a Hann window of `g` frames (made odd), its ends held.
fn smooth(x: &[f32], g: usize) -> Vec<f32> {
    let g = g.max(1) | 1;
    let w = hann(g);
    let ws: f32 = w.iter().sum();
    let t = x.len();
    (0..t).map(|i| (0..g).map(|j| w[j] * x[(i + j).saturating_sub(g / 2).min(t - 1)]).sum::<f32>() / ws).collect()
}

/// Each frame's gain, dB, on an envelope (natural log power): the low bands take half of it, the
/// highest one and a half, so louder is brighter.
pub fn louden(env: &mut [f32], gain: &[f32]) {
    let k = std::f32::consts::LN_10 / 10.0;
    for (row, &g) in env.chunks_mut(N_ENV).zip(gain) {
        for (c, e) in row.iter_mut().enumerate() {
            *e += g * k * (0.5 + c as f32 / (N_ENV - 1) as f32);
        }
    }
}

/// Each frame's silence, dB, off an envelope (natural log power).
pub fn quieten(env: &mut [f32], quiet: &[f32]) {
    for (row, &q) in env.chunks_exact_mut(N_ENV).zip(quiet) {
        row.iter_mut().for_each(|e| *e -= q * std::f32::consts::LN_10 / 10.0);
    }
}

/// Each frame's factor on aperiodicity rows.
pub fn breathe(bap: &mut [f32], breath: &[f32]) {
    for (row, &k) in bap.chunks_exact_mut(N_AP).zip(breath) {
        row.iter_mut().for_each(|a| *a *= k);
    }
}

/// Each envelope band's centre, Hz (the models' mel bank).
fn band_hz(c: usize) -> f32 {
    let top = 2595.0 * (1.0 + (SR as f32 / 2.0) / 700.0).log10();
    700.0 * (10f32.powf(top * (c + 1) as f32 / (N_ENV + 1) as f32 / 2595.0) - 1.0)
}

/// The ring on `env` (natural log power): `db` at RING_HZ, falling off as a Gaussian in octaves,
/// over the frames `mask` weights (0 to 1).
pub fn ring(env: &mut [f32], mask: &[f32], db: f32) {
    let k = std::f32::consts::LN_10 / 10.0;
    let bump: Vec<f32> = (0..N_ENV).map(|c| db * k * (-0.5 * ((band_hz(c) / RING_HZ).log2() / RING_OCTAVES).powi(2)).exp()).collect();
    for (row, &m) in env.chunks_mut(N_ENV).zip(mask) {
        for (e, b) in row.iter_mut().zip(&bump) {
            *e += m * b;
        }
    }
}

/// The dynamics of `spans` (MIDI, frames, phrase), `t` frames; a frame outside every note keeps
/// the last note's gain (the first note's before it).
fn dynamics(spans: &[(f32, std::ops::Range<usize>, usize)], t: usize, scale: f32) -> Vec<f32> {
    let mut gain = vec![f32::NAN; t];
    let phrases = spans.last().map_or(0, |s| s.2 + 1);
    for p in 0..phrases {
        let notes: Vec<&(f32, std::ops::Range<usize>, usize)> = spans.iter().filter(|s| s.2 == p).collect();
        let frames: usize = notes.iter().map(|s| s.1.len()).sum();
        let mean = notes.iter().map(|s| s.0 * s.1.len() as f32).sum::<f32>() / frames as f32;
        for (k, (m, r, _)) in notes.iter().enumerate() {
            let height = (PER_SEMITONE_DB * (m - mean)).clamp(-MAX_DB, MAX_DB);
            let n = r.len() as f32;
            for f in r.clone() {
                let x = (f - r.start) as f32 / n;
                let swell = if n / FPS >= SWELL_FROM { SWELL_DB * (std::f32::consts::PI * x).sin() } else { 0.0 };
                let fall = if k + 1 == notes.len() { FALL_DB * x * x } else { 0.0 };
                gain[f] = scale * (height + swell - fall);
            }
        }
    }
    let first = spans.first().map_or(0.0, |s| gain[s.1.start]);
    let mut last = first;
    for g in gain.iter_mut() {
        if g.is_nan() {
            *g = last;
        } else {
            last = *g;
        }
    }
    smooth(&gain, GAIN_GLIDE)
}

/// Take back the lengthening of `parts` beyond `model` (the score model's), evenly, to fit in
/// `budget` frames where it can; all of it if even `model` does not fit.
fn give(parts: &mut [usize], model: &[usize], budget: usize) {
    let (sum, base) = (parts.iter().sum::<usize>(), model.iter().sum::<usize>());
    if sum <= budget {
        return;
    }
    let a = if base >= budget { 0.0 } else { (budget - base) as f32 / (sum - base) as f32 };
    for (p, &b) in parts.iter_mut().zip(model) {
        *p = b.max(1).min(*p) + ((p.saturating_sub(b.max(1))) as f32 * a).floor() as usize;
    }
}

/// Shorten `parts` (each kept at least 1) to fit in `budget` frames.
fn fit(parts: &mut [usize], budget: usize, what: &str) -> Result<()> {
    let sum: usize = parts.iter().sum();
    if sum <= budget {
        return Ok(());
    }
    if budget < parts.len() {
        return err(format!("{what}: {budget} frames for {} consonants; the note is too short", parts.len()));
    }
    let k = budget as f32 / sum as f32;
    for p in parts.iter_mut() {
        *p = ((*p as f32 * k).floor() as usize).max(1);
    }
    let mut over = parts.iter().sum::<usize>().saturating_sub(budget);
    while over > 0 {
        let i = (0..parts.len()).max_by_key(|&i| parts[i]).unwrap();
        parts[i] -= 1;
        over -= 1;
    }
    Ok(())
}

/// The song's tokens, durations, pitch, voicing and dressing for `speaker`.
pub fn plan(m: &ScoreModel, ph: &mut Phonemizer, song: &Song, speaker: usize, st: &Style) -> Result<Plan> {
    let fpb = FPS * 60.0 / song.bpm;
    let frame = |beat: f32| (beat * fpb).round() as usize;
    let (mut tok, mut syls, mut beat, mut tail) = (vec![BOS], Vec::<Syl>::new(), 0.0f32, 0usize);
    let mut names: Vec<String> = Vec::new();
    // each line's word as the front end writes it, a rest as a comma, for heteronyms' senses
    let (mut said, mut low) = (Vec::new(), Vec::new());
    let dn = &song.diction;
    // each token's dip, and the rules (Rules::lines) that gave its phone and its dip
    let (mut dips, mut by) = (vec![0.0f32], vec![(None, None)]);
    for item in &song.items {
        match item {
            Item::Word(w, _) => {
                let ws = front::words_and_stops(w)?;
                if ws.len() != 1 || front::STOPS.contains(&ws[0].as_str()) {
                    return err(format!("{w}: one word a line"));
                }
                low.push(ws[0].to_ascii_lowercase());
                said.push(ws[0].clone());
            }
            Item::Rest(_) => {
                low.push(",".to_string());
                said.push(String::new());
            }
        }
    }
    for (k, item) in song.items.iter().enumerate() {
        match item {
            Item::Word(w, notes) => {
                let rest = |i: Option<&Item>| !matches!(i, Some(Item::Word(..)));
                let at = At { who: &st.who, word: &low[k], after_rest: rest(k.checked_sub(1).map(|i| &song.items[i])), before_rest: rest(song.items.get(k + 1)) };
                // the word as sung: as its line writes it, or its phones by the song's diction, each
                // syllable's frames told where the dictionary's syllables are the notes'
                let sung = match &song.spelled[k] {
                    Some(ps) => dn.written(&at, ps),
                    None => {
                        let phones = ph.phones_in(&said[k], &low, k)?;
                        let mut b = beat;
                        let held: Vec<usize> = notes
                            .iter()
                            .map(|g| {
                                let from = frame(b);
                                b += g.iter().map(|n| n.beats).sum::<f32>();
                                frame(b) - from
                            })
                            .collect();
                        let fits = phones.iter().filter(|p| is_vowel(p)).count() == notes.len();
                        dn.sing(&at, &phones, fits.then_some(&held[..]))
                    }
                };
                // a close with the vowel before it
                let (mut phones, mut closes, mut drawn) = (Vec::new(), Vec::new(), Vec::new());
                for p in &sung {
                    match &p.close {
                        Some(c) => *closes.last_mut().unwrap() = Some((p.phone, c.frames, c.exact)),
                        None => {
                            phones.push(p.phone);
                            closes.push(None);
                            drawn.push((p.dip, (p.by, p.dip_by)));
                        }
                    }
                }
                let vowels: Vec<usize> = (0..phones.len()).filter(|&i| is_vowel(phones[i])).collect();
                if vowels.len() != notes.len() {
                    return err(format!("{w}: {} syllables ({}), {} notes", vowels.len(), phones.join(" "), notes.len()));
                }
                if tok.len() > 1 {
                    tok.push(SPACE);
                    dips.push(0.0);
                    by.push((None, None));
                }
                let base = tok.len();
                // each phone's place among the word's tokens, a closed vowel's two at its own
                let mut place = Vec::with_capacity(phones.len());
                let mut closed = vec![None; vowels.len()];
                for (i, p) in phones.iter().enumerate() {
                    place.push(tok.len());
                    tok.push(front::symbol_id(p).unwrap());
                    dips.push(drawn[i].0);
                    by.push(drawn[i].1);
                    if let Some((close, frames, exact)) = closes[i] {
                        tok.push(front::symbol_id(close).unwrap());
                        dips.push(0.0);
                        by.push((drawn[i].1 .0, None));
                        closed[vowels.iter().position(|&v| v == i).unwrap()] = Some((frames, exact));
                    }
                }
                for (j, (&v, group)) in vowels.iter().zip(notes).enumerate() {
                    // between two vowels one consonant opens the next syllable; of more, the first closes this one
                    let lo = if j == 0 { 0 } else { vowels[j - 1] + 1 };
                    let gap = v - lo;
                    let onset_from = if j == 0 || gap <= 1 { lo } else { lo + 1 };
                    if j > 0 && gap > 1 {
                        syls.last_mut().unwrap().coda.push(place[lo]);
                    }
                    let hi = if j + 1 == vowels.len() { phones.len() } else { v + 1 };
                    let coda = if j + 1 == vowels.len() { (v + 1..hi).map(|i| place[i]).collect() } else { Vec::new() };
                    let start = frame(beat);
                    let mut sub = Vec::new();
                    for n in group {
                        sub.push((n.midi, frame(beat)));
                        beat += n.beats;
                    }
                    let mut onset: Vec<usize> = (onset_from..v).map(|i| place[i]).collect();
                    // a word's first consonant takes the space before it, as in speech (a stop's closure,
                    // the start of a fricative)
                    if j == 0 && base > 1 && onset_from < v {
                        onset.insert(0, base - 1);
                    }
                    syls.push(Syl { onset, vowel: place[v], closed: closed[j], coda, start, end: frame(beat), notes: sub, rest: None });
                    names.push(w.clone());
                }
            }
            Item::Rest(b) => {
                beat += b;
                if let Some(s) = syls.last_mut() {
                    if s.rest.is_none() {
                        s.rest = Some(tok.len());
                        tok.push(COMMA);
                        dips.push(0.0);
                        by.push((None, None));
                    }
                }
            }
        }
    }
    if let Some(s) = syls.last() {
        if s.rest.is_some() {
            tail = frame(beat) - s.end;
        }
    }
    tok.push(EOS);
    dips.push(0.0);
    by.push((None, None));

    let states = m.states(&tok)?;
    let h = m.spoken(states.clone(), speaker)?;
    let d1 = if song.together {
        // each word's lengths as the clock gives them in one fixed place, the word between two of
        // itself: the same word has the same consonants in every part, whatever is sung about it
        let mut d = m.common_durations(&tok)?;
        let mut known: std::collections::HashMap<Vec<usize>, Vec<usize>> = std::collections::HashMap::new();
        let edge = |t: usize| [BOS, SPACE, COMMA, EOS].contains(&t);
        let mut a = 0;
        while a < tok.len() {
            if edge(tok[a]) {
                a += 1;
                continue;
            }
            let b = (a..tok.len()).find(|&i| edge(tok[i])).unwrap_or(tok.len());
            let (w, n) = (tok[a..b].to_vec(), b - a);
            if !known.contains_key(&w) {
                let seq: Vec<usize> = [&[BOS][..], &w, &[SPACE], &w, &[SPACE], &w, &[EOS]].concat();
                // the space before the middle one, then its phones
                known.insert(w.clone(), m.common_durations(&seq)?[n + 1..2 * n + 2].to_vec());
            }
            let got = &known[&w];
            if tok[a - 1] == SPACE {
                d[a - 1] = got[0];
            }
            d[a..b].copy_from_slice(&got[1..]);
            a = b;
        }
        d
    } else {
        m.durations(&h, tok.len(), 1.0)?
    };
    let dp: Vec<usize> = d1.iter().zip(&tok).map(|(&d, &t)| {
        let k = if t == SPACE || CLOSED.contains(&front::symbol(t)) { 1.0 } else { st.consonants };
        if d == 0 { 0 } else { ((d as f32 * k).round() as usize).max(1) }
    }).collect();
    let mut dur = vec![0usize; tok.len()]; // spaces take no frames
    let on = |s: &Syl| -> Vec<usize> { s.onset.iter().map(|&i| dp[i]).collect() };
    let mut onset = on(&syls[0]);
    // the first word's consonants come out of the lead-in, as every other word's come out of what is
    // before it: its vowel starts on its beat, and a part that enters on a consonant is not late
    fit(&mut onset, LEAD + syls[0].start - 1, &names[0])?;
    dur[0] = LEAD + syls[0].start - onset.iter().sum::<usize>();
    for k in 0..syls.len() {
        let s = &syls[k];
        for (&i, &d) in s.onset.iter().zip(&onset) {
            dur[i] = d;
        }
        let next = syls.get(k + 1);
        let mut next_on = next.map_or(Vec::new(), on);
        let mut coda: Vec<usize> = s.coda.iter().map(|&i| dp[i]).collect();
        let model: Vec<usize> = s.coda.iter().chain(next.map_or(&[][..], |n| &n.onset[..])).map(|&i| d1[i]).collect();
        let mut ends = s.notes.iter().map(|n| n.1).skip(1).chain([s.end]);
        if let Some(short) = s.notes.iter().map(|n| ends.next().unwrap() - n.1).find(|&n| n < MIN_VOWEL) {
            return err(format!("{}: a note of {short} frames", names[k]));
        }
        // the coda and the next onset come out of the last note; lengthened, they leave its vowel
        // LENGTHENED_VOWEL frames (or half the note)
        let note = s.end - s.notes.last().unwrap().1;
        let half = note - (note / 2).min(LENGTHENED_VOWEL).max(MIN_VOWEL).min(note);
        let most = note - if song.together { (note / CLOCKED_VOWEL).max(MIN_VOWEL) } else { MIN_VOWEL };
        match (s.rest, next) {
            (Some(r), Some(n)) => {
                let gap = n.start - s.end;
                if gap < 1 + next_on.len() {
                    return err(format!("{}: a rest of {gap} frames before {}", names[k], names[k + 1]));
                }
                fit(&mut next_on, gap - 1, &names[k + 1])?;
                dur[r] = gap - next_on.iter().sum::<usize>();
                give(&mut coda, &model[..s.coda.len()], half);
                fit(&mut coda, most, &names[k])?;
            }
            (Some(r), None) => {
                dur[r] = tail;
                give(&mut coda, &model[..s.coda.len()], half);
                fit(&mut coda, most, &names[k])?;
            }
            (None, _) => {
                let mut both: Vec<usize> = coda.iter().chain(&next_on).copied().collect();
                give(&mut both, &model, half);
                fit(&mut both, most, &names[k])?;
                let c = coda.len();
                coda.copy_from_slice(&both[..c]);
                next_on.copy_from_slice(&both[c..]);
            }
        }
        for (&i, &d) in s.coda.iter().zip(&coda) {
            dur[i] = d;
        }
        let ahead = if s.rest.is_none() { next_on.iter().sum::<usize>() } else { 0 };
        dur[s.vowel] = s.end - s.start - coda.iter().sum::<usize>() - ahead;
        if let Some((n, exact)) = s.closed {
            if exact && dur[s.vowel] < n + MIN_VOWEL {
                return err(format!("{}: a close of {} ms in a vowel of {}", names[k], n * diction::FRAME_MS, dur[s.vowel] * diction::FRAME_MS));
            }
            let close = if exact { n } else { n.min(dur[s.vowel] / 3) };
            dur[s.vowel] -= close;
            dur[s.vowel + 1] = close;
        }
        onset = next_on;
    }
    // a song ending on a voiceless consonant ends after its release
    let ends = tok.len() - 2;
    *dur.last_mut().unwrap() = LEAD + if VOICELESS.contains(&front::symbol(tok[ends])) { RELEASED } else { 0 };

    let t: usize = dur.iter().sum();
    let mut at = vec![0usize; tok.len() + 1];
    for i in 0..tok.len() {
        at[i + 1] = at[i] + dur[i];
    }
    // each note's vowel frames: a syllable's later notes start their beats after its vowel's start
    let (mut spans, mut phrase, mut of) = (Vec::new(), 0, Vec::new());
    for (s, name) in syls.iter().zip(&names) {
        let (v0, v1) = (at[s.vowel], at[s.vowel + 1 + s.closed.is_some() as usize]);
        for (k, &(m, b)) in s.notes.iter().enumerate() {
            let a = if k == 0 { v0 } else { b - s.start + v0 };
            let e = s.notes.get(k + 1).map_or(v1, |n| n.1 - s.start + v0);
            if a >= e.min(v1) {
                return err(format!("{name}: the vowel ends before its note {} of {}", k + 1, s.notes.len()));
            }
            spans.push((name.clone(), m, a..e.min(v1)));
            of.push(phrase);
        }
        phrase += s.rest.is_some() as usize;
    }
    let mut target = vec![syls[0].notes[0].0; t];
    for s in &syls {
        let from = at[s.onset.first().copied().unwrap_or(s.vowel)];
        target[from..].iter_mut().for_each(|v| *v = s.notes[0].0);
    }
    for (_, m, r) in &spans {
        target[r.start..].iter_mut().for_each(|v| *v = *m);
    }
    let mut semi = smooth(&target, st.glide);
    let mut voicing = vec![Voicing::Head; t];
    let mut rng = Rng::stream(st.seed, 1);
    let who = st.motion.as_ref().map(|m| m.singer(st.seed));
    // the vibrato's size a frame where the song writes it: its beats at the frames the notes' are,
    // a jump eased as a note's step is
    let size = (!song.vibrato.0.is_empty()).then(|| {
        let zero = at[syls[0].vowel] - syls[0].start;
        let lane = Lane(song.vibrato.0.iter().map(|&(b, v)| ((zero + frame(b)) as f32, v)).collect());
        smooth(&(0..t).map(|f| lane.at(f as f32)).collect::<Vec<f32>>(), st.glide)
    });
    for (_, _, r) in &spans {
        let moved = st.motion.as_ref().zip(who).map(|(m, who)| m.placed(who, r.len(), &mut rng));
        let drift = moved.as_ref().filter(|_| size.is_some()).map(|mv| smooth(mv, MOTION_DRIFT));
        for f in r.clone() {
            let (i, age) = (f - r.start, (f - r.start) as f32 / FPS);
            let k = size.as_ref().map_or(1.0, |s| s[f]);
            semi[f] += match (&moved, &drift) {
                (Some(mv), Some(d)) => st.motion_scale * (d[i] + k * (mv[i] - d[i])),
                (Some(mv), None) => st.motion_scale * mv[i],
                (None, _) => {
                    let ramp = ((age - st.vibrato_delay) / st.vibrato_ramp.max(1e-6)).clamp(0.0, 1.0);
                    k * st.vibrato * ramp * (2.0 * std::f32::consts::PI * st.vibrato_hz * age).sin()
                }
            };
            voicing[f] = Voicing::Vowel;
        }
    }
    // a dipped consonant (the diction's) between voiced sounds: the pitch dips through its closure
    // and rises at its release, a word's first inside a phrase through the space before it too,
    // another through its own frames
    let vowel = |t: usize| is_vowel(front::symbol(t));
    let voiced = |t: usize| vowel(t) || VOICED_INTO.contains(&front::symbol(t));
    for i in 2..tok.len() - 1 {
        let first = tok[i - 1] == SPACE && dur[i - 1] >= STOP_SPACE && voiced(tok[i - 2]) && vowel(tok[i + 1]);
        let inside = voiced(tok[i - 1]) && dur[i] >= 2;
        if dips[i] == 0.0 || !(first || inside) {
            continue;
        }
        let (s0, v0) = (if first { at[i - 1] } else { at[i] }, at[i + 1]);
        let n = v0 - s0;
        for f in 0..n {
            let x = f as f32 * (STOP_CLOSE.len() - 1) as f32 / (n - 1) as f32;
            let (j, w) = (x as usize, x.fract());
            semi[s0 + f] += dips[i] * (STOP_CLOSE[j] + w * (STOP_CLOSE[(j + 1).min(STOP_CLOSE.len() - 1)] - STOP_CLOSE[j]));
        }
        if vowel(tok[i + 1]) {
            for (f, &d) in STOP_OPEN.iter().enumerate().take(dur[i + 1]) {
                semi[v0 + f] += dips[i] * d;
            }
        }
    }
    // a word's first vowel after a vowel, inside a phrase: the pitch dips just before it
    let closes: Vec<bool> = (0..tok.len()).map(|i| syls.iter().any(|s| s.closed.is_some() && s.vowel + 1 == i)).collect();
    for i in 2..tok.len() {
        // a held diphthong's two vowels are the one vowel before
        let before = dur[i - 2] + if closes[i - 2] { dur[i - 3] } else { 0 };
        if tok[i - 1] != SPACE || !vowel(tok[i]) || !vowel(tok[i - 2]) || before < 2 * VOWEL_FRAMES {
            continue;
        }
        for f in 0..VOWEL_FRAMES {
            let w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * (f as f32 + 0.5) / VOWEL_FRAMES as f32).cos());
            semi[at[i] - VOWEL_FRAMES + f] -= VOWEL_DIP * w;
        }
    }
    // beside long vowels the pitch head voices some voiceless consonants (an S held in a vowel's
    // voice), and the space a word's first one sounds in
    for i in 0..tok.len() {
        if VOICELESS.contains(&front::symbol(tok[i])) {
            voicing[at[i]..at[i + 1]].iter_mut().for_each(|v| *v = Voicing::Voiceless);
            if tok[i - 1] == SPACE {
                let tail = if tok[i - 2] == COMMA { 0 } else { TAIL };
                voicing[(at[i - 1] + tail).min(at[i])..at[i]].iter_mut().for_each(|v| *v = Voicing::Begun);
            }
        }
    }
    // each frame's silence, dB: full on the lead-in, released into over the first frames after the
    // sound (a rest's, or the end's; the end after a rest goes on from the rest's), and after a rest
    // held through the next word's space until the frames of it that sound, and risen out of (`emerge`)
    let mut quiet = vec![0.0f32; t];
    let mut from = None; // where the silence began
    for i in 0..tok.len() {
        let up = if tok[i] == SPACE && i > 0 && tok[i - 1] == COMMA { emerge(tok[i + 1], at[i + 1] - at[i]) } else { None };
        if up.is_none() && ![BOS, COMMA, EOS].contains(&tok[i]) {
            from = None;
            continue;
        }
        let a = *from.get_or_insert_with(|| {
            let last = i > 0 && VOICELESS.contains(&front::symbol(tok[i - 1]));
            at[i] + if last { RELEASED } else { 0 }
        });
        let (kept, ramp) = up.unwrap_or((0, 0));
        for f in at[i]..at[i + 1] {
            if f < a {
                voicing[f] = Voicing::Voiceless;
                continue;
            }
            let k = f - a;
            let down = if a == 0 || k >= RELEASE {
                SILENCE_DB
            } else {
                let w = 0.5 * (1.0 + (std::f32::consts::PI * (k + 1) as f32 / (RELEASE + 1) as f32).cos());
                -20.0 * w.log10()
            };
            let left = at[i + 1] - f; // frames to the consonant
            quiet[f] = if left > kept {
                if down == SILENCE_DB {
                    voicing[f] = Voicing::Silent;
                }
                down
            } else if left > kept - ramp {
                // a rest shorter than its release: both, the one over the other
                let w = 0.5 * (1.0 + (std::f32::consts::PI * (left - (kept - ramp)) as f32 / (ramp + 1) as f32).cos());
                let up = -20.0 * w.log10();
                if down == SILENCE_DB { up } else { up + down }
            } else {
                0.0
            }
            .min(SILENCE_DB);
        }
    }
    let lf0: Vec<f32> = semi.iter().map(|&s| (440.0f32).ln() + (s + st.shift - 69.0) * std::f32::consts::LN_2 / 12.0).collect();
    let mut sung = vec![0.0; t];
    for (_, _, r) in &spans {
        sung[r.clone()].iter_mut().for_each(|v| *v = 1.0);
    }
    let held = sung;
    let sung = smooth(&held, GAIN_GLIDE);
    // eased in and out of each vowel, the consonants untouched
    let breath = sung.iter().zip(&held).map(|(&w, &h)| 1.0 + (st.breathiness - 1.0) * w * h).collect();
    let gain = if st.dynamics == 0.0 {
        vec![0.0; t]
    } else {
        let marked: Vec<(f32, std::ops::Range<usize>, usize)> = spans.iter().zip(&of).map(|((_, m, r), &p)| (*m, r.clone(), p)).collect();
        dynamics(&marked, t, st.dynamics)
    };
    let notes = spans.into_iter().map(|(n, m, r)| (n, m + st.shift, r)).collect();
    Ok(Plan { tokens: tok, states, h, durations: dur, lf0, told: Vec::new(), voicing, quiet, breath, gain, sung, notes, closes, by })
}

/// A plan's frames' voicing, 0 or 1, on its speaker's frame states hx; and the vowels' frames, how
/// many of them the pitch head voiced, the voiceless consonants' and how many of those.
pub fn voicing(m: &ScoreModel, hx: &[f32], p: &Plan) -> (Vec<f32>, [usize; 4]) {
    let (_, pv) = m.pitch(hx, p.lf0.len());
    let mut n = [0; 4];
    for (v, &x) in p.voicing.iter().zip(&pv) {
        match v {
            Voicing::Vowel => (n[0], n[1]) = (n[0] + 1, n[1] + (x > 0.0) as usize),
            Voicing::Voiceless => (n[2], n[3]) = (n[2] + 1, n[3] + (x > 0.0) as usize),
            _ => {}
        }
    }
    (p.voicing.iter().zip(&pv).map(|(v, &x)| v.vuv(x)).collect(), n)
}

/// Each frame's dynamics and silence, dB, as a plan's edits (inflect::Edits): the loudness in log
/// power and the tilt in log power an octave that best fit, over the envelope's bands, what
/// `louden` adds to them, and the silence off the loudness as `quieten` takes it off the envelope.
/// The tilt is empty where there are no dynamics.
pub fn loudness(gain: &[f32], quiet: &[f32]) -> (Vec<f32>, Vec<f32>) {
    assert_eq!(gain.len(), quiet.len());
    let k = std::f32::consts::LN_10 / 10.0;
    if gain.iter().all(|g| *g == 0.0) {
        return (quiet.iter().map(|q| -q * k).collect(), Vec::new());
    }
    let o = crate::inflect::octaves_at((0..N_ENV).map(band_hz));
    let w: Vec<f32> = (0..N_ENV).map(|c| 0.5 + c as f32 / (N_ENV - 1) as f32).collect();
    let n = N_ENV as f32;
    let (om, wm) = (o.iter().sum::<f32>() / n, w.iter().sum::<f32>() / n);
    let slope = o.iter().zip(&w).map(|(a, b)| (a - om) * (b - wm)).sum::<f32>() / o.iter().map(|a| (a - om).powi(2)).sum::<f32>();
    (gain.iter().zip(quiet).map(|(g, q)| g * k * (wm - slope * om) - q * k).collect(), gain.iter().map(|g| g * k * slope).collect())
}

/// The song sung whole: `plan`, then the pitch head, the decoder and the dressing.
pub fn sing(m: &ScoreModel, ph: &mut Phonemizer, song: &Song, speaker: usize, st: &Style) -> Result<Sung> {
    let p = plan(m, ph, song, speaker, st)?;
    let hx = m.expand(&p.h, &p.durations);
    let (vuv, [vowel_frames, vowel_voiced, voiceless_frames, voiceless_voiced]) = voicing(m, &hx, &p);
    let (mut env, mut bap) = m.decode(&hx, &p.lf0, &vuv);
    quieten(&mut env, &p.quiet);
    breathe(&mut bap, &p.breath);
    Ok(Sung {
        tokens: p.tokens,
        score: Score { durations: p.durations, frames: Frames { env, bap, lf0: p.lf0, vuv } },
        vowel_frames,
        vowel_voiced,
        voiceless_frames,
        voiceless_voiced,
        notes: p.notes,
        gain: p.gain,
        sung: p.sung,
    })
}
