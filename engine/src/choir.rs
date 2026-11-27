// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A choir's singers seated and mixed (engine/web/choir.js), sample for
//! sample: seats on risers facing the listener, each singer's sound from its seat as a direct sound
//! and two early reflections, panned, to four buses (dry left and right, the room's send left and
//! right), each part at its gain and its written levels, faded in and out. The room (room.rs) takes
//! the buses.

use std::collections::VecDeque;
use std::f64::consts::PI;

use crate::diction::Rules;
use crate::dsp::SR;
use crate::json::Json;
use crate::part::{clocked, fmt, perform_as, Library, Manner, Part, Rnd};
use crate::room::{Room, TRACE};
use crate::timing::Timing;
use crate::weights::{err, Error, Result};

/// A part's start and end are faded, never cut, over this many samples (player.js).
pub const FADE: usize = 192;
/// A seat's direct sound and its two reflections.
pub const REFL_SUM: f64 = 1.0 + 0.25 + 0.18;

#[derive(Clone, Debug, PartialEq)]
pub struct Reflection {
    pub delay_ms: f64,
    pub pan: f64,
    pub gain: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Seat {
    pub row: usize,
    pub pan: f64,
    pub gain: f64,
    pub send: f64,
    pub delay_ms: f64,
    pub itd_ms: f64,
    pub refl: [Reflection; 2],
}

/// choirkit.make_seats: n seats on risers facing the listener, rows of about 25 (row 0 nearest),
/// odd rows staggered half a seat; pan from the angle, so no one sits hard left or right; further
/// rows quieter, wetter and later. Sorted left to right, each with two early reflections.
pub fn seats(n: usize, pan_max: f64, half_angle: f64) -> Vec<Seat> {
    let rows = ((n as f64 / 25.0).round() as usize).max(1);
    let (base, extra, rad) = (n / rows, n % rows, PI / 180.0);
    // found as it runs, as the seat's sine is: a build for another machine folds a constant's with its own libm
    let edge = (std::hint::black_box(half_angle) * rad).sin();
    let mut out = Vec::new();
    for r in 0..rows {
        let c = base + usize::from(r < extra);
        let odd = r % 2 == 1;
        for i in 0..c {
            let u = if c > 1 { ((i as f64 + if odd { 0.5 } else { 0.0 }) / (c as f64 - if odd { 0.0 } else { 1.0 }).max(1.0)).min(1.0) } else { 0.5 };
            let a = -half_angle + 2.0 * half_angle * u;
            let none = Reflection { delay_ms: 0.0, pan: 0.0, gain: 0.0 };
            out.push(Seat {
                row: r,
                pan: pan_max * (a * rad).sin() / edge,
                gain: 1.0 - 0.1 * r as f64,
                send: 0.6 + 0.2 * r as f64,
                delay_ms: 3.0 * r as f64,
                itd_ms: 0.0,
                refl: [none.clone(), none],
            });
        }
    }
    out.sort_by(|a, b| a.pan.partial_cmp(&b.pan).unwrap().then(a.row.cmp(&b.row)));
    let mut rnd = Rnd::new("seats");
    let clamp = |p: f64| p.clamp(-0.95, 0.95);
    for s in &mut out {
        s.itd_ms = 0.35 * s.pan.abs();
        let d0 = rnd.between(7.0, 19.0);
        let p0 = clamp(-0.6 * s.pan + rnd.between(-0.3, 0.3));
        let d1 = rnd.between(21.0, 37.0);
        let p1 = clamp(0.3 * s.pan + rnd.between(-0.5, 0.5));
        s.refl = [Reflection { delay_ms: d0, pan: p0, gain: 0.25 }, Reflection { delay_ms: d1, pan: p1, gain: 0.18 }];
    }
    out
}

/// A tap: a channel, a gain and a delay in samples.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tap {
    pub ch: usize,
    pub g: f64,
    pub d: usize,
}

/// JS's Math.round: a half goes up.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f < 0.5 {
        f
    } else {
        f + 1.0
    }
}

/// choirkit.add_source: a source at `gain` from its seat as taps: the direct sound panned, the far
/// ear later by the interaural time, the row's gain and distance, and the two reflections. The send
/// bus takes the same taps times seat.send.
pub fn taps(gain: f64, seat: &Seat) -> Vec<Tap> {
    let ms = |x: f64| js_round(x / 1000.0 * SR as f64) as usize;
    let g = gain * seat.gain;
    let dd = ms(seat.delay_ms);
    let mut legs = vec![(seat.pan, g, dd, ms(seat.itd_ms))];
    legs.extend(seat.refl.iter().map(|r| (r.pan, g * r.gain, dd + ms(r.delay_ms), ms(0.35 * r.pan.abs()))));
    legs.into_iter()
        .flat_map(|(p, gg, d, itd)| {
            let th = (p + 1.0) * PI / 4.0;
            [Tap { ch: 0, g: gg * th.cos(), d: if p > 0.0 { d + itd } else { d } }, Tap { ch: 1, g: gg * th.sin(), d: if p > 0.0 { d } else { d + itd } }]
        })
        .collect()
}

/// The factor of levels k ([(sample, factor)...]) at sample s, k[i] the last at or before it (i
/// from a guess at or before the answer).
fn level_at(k: &[(f64, f64)], s: f64, mut i: usize) -> (f64, usize) {
    while i + 1 < k.len() && k[i + 1].0 <= s {
        i += 1;
    }
    if s <= k[i].0 || i + 1 == k.len() {
        return (k[i].1, i);
    }
    let ((a, x), (b, y)) = (k[i], k[i + 1]);
    (x + (y - x) * (s - a) / (b - a), i)
}

/// A part as the mixer takes it.
pub struct MixPart {
    pub gain: f64,
    pub seat: Seat,
    /// [(s of its own, factor)...] in order: what its gain is times as it goes.
    pub levels: Option<Vec<(f64, f64)>>,
    /// Levels kept from an earlier mix of it (rms at its gain every TRACE samples, NaN where none came).
    pub lv: Option<Vec<f32>>,
    pub mute: bool,
}

struct Placed {
    gain: f64,
    env: Option<Vec<(f64, f64)>>,
    taps: Vec<Tap>,
    send: f64,
    reach: usize,
    q: VecDeque<Vec<f32>>,
    at: usize,
    placed: usize,
    got: usize,
    from: usize,
    len: Option<usize>,
    start: f64,
    off: i64,
    done: bool,
    lv: Option<Vec<f32>>,
    sq: f64,
    mute: bool,
}

/// The parts' samples, as they come, each from its seat at its own start, summed to four buses: dry
/// left and right, and the room's send left and right (choir.js Mixer). A part is opened with its
/// start (s) and length (samples) before its samples count. Starts are counted from t0 (s), or,
/// with none given, from the earliest once every part is open. Every part is faded in over its first
/// FADE samples and out over its last. take() gives the buses as far as every part has reached. A
/// part's levels are what its gain is times as it goes: a straight line from each to the next, the
/// first held before it and the last after. A mix picked up at its sample `from` (t0 given): its
/// parts are opened at the sample of their own they come in at, and what they have before the mix's
/// start is left out. A muted part gives no samples: it is opened at its end.
pub struct Mixer {
    parts: Vec<Placed>,
    t0: Option<f64>,
    from: usize,
    opened: usize,
    out: usize,  // the sample of the mix given next
    base: usize, // the buses' first sample
    bus: [Vec<f64>; 4],
    /// Samples in all, once every part is open.
    pub total: Option<usize>,
}

impl Mixer {
    pub fn new(parts: Vec<MixPart>, t0: Option<f64>, from: usize) -> Result<Mixer> {
        if from != 0 && t0.is_none() {
            return err("mixer: picked up, it needs its t0".to_string());
        }
        let mut placed = Vec::new();
        for (i, p) in parts.into_iter().enumerate() {
            let t = taps(p.gain, &p.seat);
            if let Some(lv) = &p.levels {
                let ok = !lv.is_empty() && lv.iter().enumerate().all(|(j, &(at, k))| at >= 0.0 && k >= 0.0 && k.is_finite() && (j == 0 || at > lv[j - 1].0));
                if !ok {
                    return err(format!("mixer: part {i}'s levels {lv:?}"));
                }
            }
            placed.push(Placed {
                gain: p.gain,
                env: p.levels.map(|lv| lv.iter().map(|&(at, k)| (js_round(at * SR as f64), k)).collect()),
                reach: t.iter().map(|x| x.d).max().unwrap_or(0),
                taps: t,
                send: p.seat.send,
                q: VecDeque::new(),
                at: 0,
                placed: 0,
                got: 0,
                from: 0,
                len: None,
                start: 0.0,
                off: 0,
                done: false,
                lv: p.lv,
                sq: 0.0,
                mute: p.mute,
            });
        }
        Ok(Mixer { parts: placed, t0, from, opened: 0, out: from, base: from, bus: std::array::from_fn(|_| Vec::new()), total: None })
    }

    pub fn open(&mut self, i: usize, start: f64, len: usize, from: usize) -> Result<()> {
        let t0 = self.t0;
        let p = self.parts.get_mut(i).ok_or_else(|| Error(format!("mixer: no part {i}")))?;
        if p.len.is_some() {
            return err(format!("mixer: part {i} opened twice"));
        }
        if len == 0 {
            return err(format!("mixer: part {i} of {len} samples"));
        }
        if from > len || !from.is_multiple_of(TRACE) {
            return err(format!("mixer: part {i} picked up at sample {from} of {len}"));
        }
        if p.mute && from != len {
            return err(format!("mixer: part {i} is muted, and opened at sample {from} of {len}"));
        }
        p.start = start;
        p.len = Some(len);
        p.from = from;
        p.got = from;
        p.placed = from;
        if p.lv.as_ref().map(Vec::len) != Some(len.div_ceil(TRACE)) {
            p.lv = Some(vec![f32::NAN; len.div_ceil(TRACE)]);
        }
        if let Some(t0) = t0 {
            if start < t0 {
                return err(format!("mixer: part {i} starts at {start} s, before the mix's {t0}"));
            }
            p.off = js_round((start - t0) * SR as f64) as i64;
        }
        self.opened += 1;
        if self.opened == self.parts.len() {
            if self.t0.is_none() {
                let t0 = self.parts.iter().map(|p| p.start).fold(f64::INFINITY, f64::min);
                self.t0 = Some(t0);
                for p in &mut self.parts {
                    p.off = js_round((p.start - t0) * SR as f64) as i64;
                }
            }
            self.total = Some(self.parts.iter().map(|p| (p.off + (p.len.unwrap() + p.reach) as i64) as usize).max().unwrap());
        }
        Ok(())
    }

    pub fn push(&mut self, i: usize, samples: Vec<f32>) -> Result<()> {
        let from = self.from;
        let p = &mut self.parts[i];
        let Some(len) = p.len else {
            return err(format!("mixer: part {i} is not open"));
        };
        if p.done {
            return err(format!("mixer: part {i} has ended"));
        }
        if p.got + samples.len() > len {
            return err(format!("mixer: part {i} past its {len} samples"));
        }
        let lv = p.lv.as_mut().unwrap();
        for (j, &x) in samples.iter().enumerate() {
            p.sq += x as f64 * x as f64;
            let s = p.got + j + 1;
            if s.is_multiple_of(TRACE) {
                let k = p.env.as_ref().map_or(1.0, |e| level_at(e, (s - TRACE / 2) as f64, 0).0);
                lv[s / TRACE - 1] = (p.gain * k * (p.sq / TRACE as f64).sqrt()) as f32;
                p.sq = 0.0;
            }
        }
        // what a part picked up has before the mix's start is not placed
        let lead = samples.len().min((from as i64 - p.off - p.got as i64).max(0) as usize);
        if lead > 0 {
            p.placed += lead;
        }
        let n = samples.len();
        if lead < n {
            p.q.push_back(if lead > 0 { samples[lead..].to_vec() } else { samples });
        }
        p.got += n;
        Ok(())
    }

    pub fn end(&mut self, i: usize) -> Result<()> {
        let p = &mut self.parts[i];
        if Some(p.got) != p.len {
            return err(format!("mixer: part {i} ended at {} samples of {:?}", p.got, p.len));
        }
        p.done = true;
        Ok(())
    }

    pub fn finished(&self) -> bool {
        self.total.is_some_and(|t| self.parts.iter().all(|p| p.done) && self.out >= t)
    }

    /// Part i's levels as it came (rms at its gain every TRACE samples, NaN where none came).
    pub fn levels(&self, i: usize) -> Option<&[f32]> {
        self.parts[i].lv.as_deref()
    }

    /// Part i's first sample in the mix, once it is known.
    pub fn off(&self, i: usize) -> i64 {
        self.parts[i].off
    }

    /// How far past its own samples part i's taps reach, samples.
    pub fn reach(&self, i: usize) -> usize {
        self.parts[i].reach
    }

    pub fn len(&self) -> usize {
        self.parts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.parts.is_empty()
    }

    /// The buses writable to `to` (a sample of the mix).
    fn room(&mut self, to: usize) {
        let n = self.bus[0].len();
        if to - self.base <= n {
            return;
        }
        let keep = self.out - self.base;
        if keep > 0 {
            // what is given is dropped first
            for b in &mut self.bus {
                b.copy_within(keep.., 0);
                b[n - keep..].fill(0.0);
            }
            self.base = self.out;
        }
        if to - self.base > n {
            let m = (2 * n).max(to - self.base + 8192);
            for b in &mut self.bus {
                b.resize(m, 0.0);
            }
        }
    }

    /// Part p's samples from placed to `upto` (its own samples) onto the buses.
    fn place(bus: &mut [Vec<f64>; 4], base: usize, p: &mut Placed, upto: usize) {
        let len = p.len.unwrap();
        while p.placed < upto {
            let c = &p.q[0];
            let k = (c.len() - p.at).min(upto - p.placed);
            let (s0, a) = (p.placed, p.at);
            let lev: Option<Vec<f32>> = p.env.as_ref().map(|e| {
                let mut i = 0;
                (0..k)
                    .map(|j| {
                        let (v, ii) = level_at(e, (s0 + j) as f64, i);
                        i = ii;
                        v as f32
                    })
                    .collect()
            });
            for t in &p.taps {
                let gs = t.g * p.send;
                let o = (p.off + t.d as i64 - base as i64) as usize;
                for j in 0..k {
                    let s = s0 + j;
                    let mut x = c[a + j] as f64;
                    if s < FADE {
                        x *= s as f64 / FADE as f64;
                    }
                    if s + FADE >= len {
                        x *= (len - 1 - s) as f64 / FADE as f64;
                    }
                    if let Some(l) = &lev {
                        x *= l[j] as f64;
                    }
                    bus[t.ch][o + s] += t.g * x;
                    bus[2 + t.ch][o + s] += gs * x;
                }
            }
            p.placed += k;
            p.at += k;
            if p.at == c.len() {
                p.q.pop_front();
                p.at = 0;
            }
        }
    }

    /// [dry l, dry r, send l, send r] as far as every part has reached, or None.
    pub fn take(&mut self) -> Option<[Vec<f32>; 4]> {
        let total = self.total?;
        let mut lim = total as i64;
        for p in &self.parts {
            if !p.done {
                lim = lim.min(p.off + p.got as i64);
            }
        }
        if lim <= self.out as i64 {
            return None;
        }
        let upto = |p: &Placed| p.got.min((lim - p.off).max(0) as usize);
        let reach = self.parts.iter().map(|p| (p.off + (upto(p) + p.reach) as i64) as usize).max().unwrap();
        self.room(reach);
        let base = self.base;
        for p in &mut self.parts {
            let u = upto(p);
            Self::place(&mut self.bus, base, p, u);
        }
        let (a, b) = (self.out - base, lim as usize - base);
        let y = std::array::from_fn(|c| self.bus[c][a..b].iter().map(|&v| v as f32).collect());
        self.out = lim as usize;
        Some(y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seats_go_left_to_right_inside_the_pan() {
        let s = seats(8, 0.85, 52.0);
        assert_eq!(s.len(), 8);
        assert!(s.windows(2).all(|w| w[0].pan <= w[1].pan));
        assert!(s.iter().all(|x| x.pan.abs() <= 0.85 + 1e-12));
    }

    #[test]
    fn a_mix_is_as_long_as_its_last_part_and_its_reach() {
        let st = seats(2, 0.85, 52.0);
        let parts = st.iter().map(|s| MixPart { gain: 0.5, seat: s.clone(), levels: None, lv: None, mute: false }).collect();
        let mut m = Mixer::new(parts, None, 0).unwrap();
        m.open(0, 0.0, 4800, 0).unwrap();
        m.open(1, 0.1, 4800, 0).unwrap();
        let x = vec![0.1f32; 4800];
        m.push(0, x.clone()).unwrap();
        m.push(1, x).unwrap();
        m.end(0).unwrap();
        m.end(1).unwrap();
        let mut n = 0;
        while let Some(y) = m.take() {
            n += y[0].len();
        }
        assert_eq!(Some(n), m.total);
        assert!(m.finished());
    }
}

// ---------------------------------------------------------------- a piece arranged and sung

/// The machine vibrato's size against its own where a piece does not write one (choirs.js VIBRATO).
pub const VIBRATO: f64 = 0.6;
/// A piece's singers keep time together unless it says not (choirs.js TOGETHER).
pub const TOGETHER: bool = true;
/// The most of itself a note gives a breath (choirs.js GIVE).
pub const GIVE: f64 = 1.0 / 3.0;
/// Men sing an octave down (choirs.js arrange).
const MAN_SHIFT: f64 = -12.0;

/// A singer of a piece, as choirs.js arrange() gives choir.js start() one.
#[derive(Clone, Debug, PartialEq)]
pub struct Singer {
    pub name: String,
    /// The voice's name as the site lists it.
    pub voice: String,
    /// The name people call the voice by, where the list gives one: who a diction rule's for= knows it as.
    pub called: Option<String>,
    pub sex: char,
    pub shift: f64,
    pub seed: i64,
    pub song: String,
    /// Seconds into the piece the part starts, as written.
    pub at: f64,
    pub gain: f64,
    pub levels: Option<Vec<(f64, f64)>>,
    pub seat: usize,
    /// A trained singer's pitch motion by name, or the machine vibrato.
    pub motion: Option<String>,
    pub motion_scale: f64,
    pub vibrato: f64,
    pub vibrato_hz: f64,
    pub vibrato_delay: f64,
    /// What the song's vibrato lines are sized by.
    pub vibrato_size: f64,
    pub glide: f64,
    pub dynamics: f64,
    pub breathiness: f64,
    /// Names the singer goes by besides its part's and its voice's, for a diction rule's for=.
    pub tags: Vec<String>,
    /// The diction's rules as lines (diction.rs): the style's, then the part's own.
    pub diction: Vec<String>,
    pub jitter: f64,
    pub detune: f64,
    pub spread: f64,
    pub breath: f64,
    pub together: bool,
    pub give: f64,
}

/// A piece arranged: its singers, their seats, its room and its tempo.
#[derive(Clone, Debug)]
pub struct Arranged {
    pub singers: Vec<Singer>,
    pub seats: Vec<Seat>,
    pub room: String,
    pub bpm: f64,
}

/// How a piece is sung where that is not its own way (arrange()'s and choir_wav.mjs's ask): each
/// None the piece's own.
#[derive(Clone, Debug, Default)]
pub struct Ask {
    pub seed: i64,
    /// By part, a voice's name in place of the piece's.
    pub voices: Vec<Option<String>>,
    /// By part, a song in place of the piece's.
    pub songs: Vec<Option<String>>,
    pub room: Option<String>,
    /// Some(None): the machine vibrato for every part.
    pub motion: Option<Option<String>>,
    /// The pitch's movement, the singers' own or the machine vibrato, against its own size.
    pub sway: Option<f64>,
    /// How far off the beat and the pitch each singer is, against the piece's.
    pub loose: Option<f64>,
    /// The vibrato alone against its own size: what the songs' vibrato lines are sized by.
    pub vibrato: Option<f64>,
    pub glide: Option<f64>,
    pub dynamics: Option<f64>,
    pub breathiness: Option<f64>,
    pub breath: Option<f64>,
}

/// A singer's own machine vibrato, as the sing-demos drew each singer's:
/// its peak (semitones), its rate (Hz) and how far into a vowel it starts (s).
pub fn vibrato(seed: i64) -> (f64, f64, f64) {
    let mut r = Rnd::new(&format!("vibrato {seed}"));
    let v = r.between(0.15, 0.35);
    let hz = r.between(4.8, 6.0);
    (v, hz, r.between(0.2, 0.5))
}

fn field<'a>(j: &'a Json, k: &str) -> Option<&'a Json> {
    match j {
        Json::Obj(kv) => kv.iter().find(|(key, _)| key == k).map(|(_, v)| v).filter(|v| !matches!(v, Json::Null)),
        _ => None,
    }
}

fn num_of(j: &Json, k: &str, what: &str) -> Result<Option<f64>> {
    field(j, k).map(|v| v.num().map_err(|e| Error(format!("{what} {k}: {}", e.0)))).transpose()
}

fn str_of<'a>(j: &'a Json, k: &str, what: &str) -> Result<Option<&'a str>> {
    field(j, k).map(|v| v.str().map_err(|e| Error(format!("{what} {k}: {}", e.0)))).transpose()
}

/// A list of strings, none where it is left out.
fn strs_of(j: &Json, k: &str, what: &str) -> Result<Vec<String>> {
    match field(j, k) {
        None => Ok(Vec::new()),
        Some(Json::Arr(xs)) => xs.iter().map(|x| x.str().map(str::to_string).map_err(|_| Error(format!("{what} {k}: a list of strings")))).collect(),
        Some(_) => err(format!("{what} {k}: a list of strings")),
    }
}

/// Diction rules as a piece writes them, a line each (diction.rs), every one read here.
fn rules_of(j: &Json, what: &str) -> Result<Vec<String>> {
    let lines = strs_of(j, "diction", what)?;
    let mut r = Rules::none();
    for l in &lines {
        r.read(&l.split_whitespace().collect::<Vec<_>>()).map_err(|e| Error(format!("{what} diction: {l}: {}", e.0)))?;
    }
    Ok(lines)
}

fn bool_of(j: &Json, k: &str, what: &str) -> Result<Option<bool>> {
    match field(j, k) {
        None => Ok(None),
        Some(Json::Bool(b)) => Ok(Some(*b)),
        Some(_) => err(format!("{what} {k}: true or false")),
    }
}

/// JS's Math.hypot as V8 sums it: each over the largest, squared, by Kahan's compensated sum.
fn hypot(xs: &[f64]) -> f64 {
    let max = xs.iter().fold(0.0f64, |m, x| m.max(x.abs()));
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut comp) = (0.0f64, 0.0f64);
    for x in xs {
        let n = x.abs() / max;
        let summand = n * n - comp;
        let pre = sum + summand;
        comp = (pre - sum) - summand;
        sum = pre;
    }
    sum.sqrt() * max
}

/// The piece `c` (a choir as choirs.js CHOIRS holds one) arranged for a route (its loud passages
/// as measured on it, c.loud), its singers' voices from `list` (name and sex), as choirs.js
/// arrange(): seeds from ask.seed, a level of 1 / (N REFL_SUM) unless the piece sets one, men an
/// octave down, each singer's own vibrato, and the piece's level made by one gain on every part.
pub fn arrange(c: &Json, list: &[(String, char)], route: &str, ask: &Ask) -> Result<Arranged> {
    let parts = c.get("parts").and_then(Json::arr).map_err(|e| Error(format!("a choir's parts: {}", e.0)))?;
    if parts.is_empty() {
        return err("a choir needs a part".to_string());
    }
    let style = c.get("style").map_err(|e| Error(format!("a choir's style: {}", e.0)))?;
    let level = num_of(c, "level", "the choir's")?.unwrap_or(1.0 / (parts.len() as f64 * REFL_SUM));
    let st = |k: &str| num_of(style, k, "the style's");
    let own_motion = str_of(style, "motion", "the style's")?.map(str::to_string);
    let motion = ask.motion.clone().unwrap_or(own_motion.clone());
    let (sway, loose) = (ask.sway.unwrap_or(1.0), ask.loose.unwrap_or(1.0));
    let size = match ask.vibrato {
        Some(v) => v,
        None => st("vibratoSize")?.unwrap_or(VIBRATO),
    };
    let glide = match ask.glide {
        Some(g) => g,
        None => st("glide")?.ok_or_else(|| Error("the style has no glide".into()))?,
    };
    let dynamics = match ask.dynamics {
        Some(v) => v,
        None => st("dynamics")?.ok_or_else(|| Error("the style has no dynamics".into()))?,
    };
    let breathiness = match ask.breathiness {
        Some(v) => v,
        None => st("breathiness")?.ok_or_else(|| Error("the style has no breathiness".into()))?,
    };
    let breath = match ask.breath {
        Some(v) => v,
        None => st("breath")?.unwrap_or(0.0),
    };
    let diction = rules_of(style, "the style's")?;
    let together = bool_of(style, "together", "the style's")?.unwrap_or(TOGETHER);
    let give = st("give")?.unwrap_or(GIVE);
    let mut singers = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        let name = str_of(p, "name", "a part's")?.ok_or_else(|| Error(format!("part {i} has no name")))?.to_string();
        let what = format!("{name}:");
        let voice = match ask.voices.get(i).cloned().flatten() {
            Some(v) => v,
            None => str_of(p, "voice", &what)?.ok_or_else(|| Error(format!("{name}: no voice")))?.to_string(),
        };
        let sex = list.iter().find(|(n, _)| *n == voice).map(|(_, s)| *s).ok_or_else(|| Error(format!("{name}: no voice {voice}")))?;
        let (v, hz, delay) = vibrato(ask.seed + i as i64);
        let mut k = [1.0f64; 4]; // dynamics, breathiness, detune, spread
        if let Some(sc) = field(p, "scale") {
            let Json::Obj(kv) = sc else { return err(format!("{name}: a scale is an object")) };
            for (key, val) in kv {
                let at = ["dynamics", "breathiness", "detune", "spread"].iter().position(|x| x == key).ok_or_else(|| Error(format!("{name}: a scale of {key}")))?;
                k[at] = val.num().map_err(|e| Error(format!("{name}: scale {key}: {}", e.0)))?;
            }
        }
        let part_motion = str_of(p, "motion", &what)?.map(str::to_string);
        let levels = match field(p, "levels") {
            None => None,
            Some(l) => Some(
                l.arr()?
                    .iter()
                    .map(|x| match x.arr() {
                        Ok([a, b]) => Ok((a.num()?, b.num()?)),
                        _ => err(format!("{name}: a level is [seconds, factor]")),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
        };
        let song = match ask.songs.get(i).cloned().flatten() {
            Some(s) => s,
            None => str_of(p, "song", &what)?.ok_or_else(|| Error(format!("{name}: no song")))?.to_string(),
        };
        singers.push(Singer {
            motion: if motion == own_motion { part_motion.or(motion.clone()) } else { motion.clone() },
            motion_scale: sway,
            vibrato: v * sway,
            vibrato_hz: hz,
            vibrato_delay: delay,
            vibrato_size: size,
            glide,
            dynamics: dynamics * k[0],
            breathiness: breathiness * k[1],
            called: None,
            tags: strs_of(p, "tags", &what)?,
            diction: diction.iter().cloned().chain(rules_of(p, &what)?).collect(),
            // singers who keep time together start together: a start of one's own puts a vowel under the others' S
            jitter: js_round(st("jitter")?.unwrap_or(0.0) * loose),
            detune: st("detune")?.unwrap_or(0.0) * loose * k[2],
            spread: if together { 0.0 } else { st("spread")?.unwrap_or(0.0) * loose * k[3] },
            breath,
            together,
            give,
            shift: if sex == 'F' { 0.0 } else { MAN_SHIFT },
            seed: ask.seed + i as i64,
            song,
            at: num_of(p, "at", &what)?.unwrap_or(0.0),
            gain: level * num_of(p, "gain", &what)?.unwrap_or(1.0),
            levels,
            seat: match num_of(p, "seat", &what)? {
                Some(s) => s.count_of(&name)?,
                None => i,
            },
            name,
            voice,
            sex,
        });
    }
    let fulls: Vec<f64> = singers.iter().map(|s| s.gain * s.levels.as_ref().map_or(1.0, |l| l.iter().fold(f64::NEG_INFINITY, |m, &(_, k)| m.max(k)))).collect();
    let full = hypot(&fulls);
    // the loud passages as measured on this route, or one number for every route
    let loud = match field(c, "loud") {
        None => None,
        Some(Json::Num(x)) => Some(*x),
        Some(l @ Json::Obj(_)) => num_of(l, route, "the choir's loud")?,
        Some(_) => return err("a choir's loud: a number, or one a route".to_string()),
    };
    let k = match loud {
        None => crate::room::FULL_CHOIR / full,
        Some(l) => 10f64.powf((crate::room::LOUD - l) / 20.0),
    };
    if !(k > 0.0 && k.is_finite()) {
        return err(format!("a choir's level: loud passages at {loud:?}, a full choir of {full}"));
    }
    for s in &mut singers {
        s.gain *= k;
    }
    let pan = num_of(c, "pan", "the choir's")?.unwrap_or(0.85);
    let room = match &ask.room {
        Some(r) => r.clone(),
        None => str_of(c, "room", "the choir's")?.ok_or_else(|| Error("a choir has no room".into()))?.to_string(),
    };
    crate::room::room(&room)?;
    let bpm = crate::part::parse(&singers[0].song)?.bpm;
    let seats = seats(singers.len(), pan, 52.0);
    for s in &singers {
        if s.seat >= seats.len() {
            return err(format!("{}: no seat {}", s.name, s.seat));
        }
    }
    Ok(Arranged { singers, seats, room, bpm })
}

trait Count {
    fn count_of(self, name: &str) -> Result<usize>;
}

impl Count for f64 {
    fn count_of(self, name: &str) -> Result<usize> {
        if self >= 0.0 && self.fract() == 0.0 {
            Ok(self as usize)
        } else {
            err(format!("{name}: seat {self}"))
        }
    }
}

/// A song with its vibrato `k` times the size (as web/perform.js sized): every size its lines write, and
/// the voice's own (1) they start from, as a line at the song's head.
pub fn sized(text: &str, k: f64) -> Result<String> {
    if !(k >= 0.0 && k.is_finite()) {
        return err(format!("a vibrato {k} times the size"));
    }
    if k == 1.0 {
        return Ok(text.to_string());
    }
    let mut head = false;
    let mut out = Vec::new();
    for raw in text.split('\n') {
        let f: Vec<&str> = raw.split_whitespace().collect();
        if f.first() == Some(&"%bpm") && !head {
            head = true;
            out.push(raw.to_string());
            out.push(format!("%vibrato {}", fmt(k)));
            continue;
        }
        if f.first() != Some(&"%vibrato") || f.len() < 2 {
            out.push(raw.to_string());
            continue;
        }
        let sizes = f[1..]
            .iter()
            .map(|x| {
                let mut it = x.split(':');
                let v = it.next().unwrap_or("");
                let over: Vec<&str> = it.collect();
                let n: f64 = v.parse().unwrap_or(f64::NAN);
                if v.is_empty() || !(n >= 0.0 && n.is_finite()) || over.len() > 1 {
                    return err(format!("{x}: a size is VALUE or VALUE:BEATS, the value 0 or more"));
                }
                Ok(std::iter::once(fmt(n * k)).chain(over.iter().map(|s| s.to_string())).collect::<Vec<_>>().join(":"))
            })
            .collect::<Result<Vec<_>>>()?;
        out.push(format!("%vibrato {}", sizes.join(" ")));
    }
    if !head {
        return err("the song has no %bpm line".to_string());
    }
    Ok(out.join("\n"))
}

/// A part as sung in the piece: its singer's name and voice, the song as sung, its breaths (the
/// sample of the part each starts at, and how many samples), the s it starts late by, its shift
/// (semitones, its detune in it), where it falls in the piece's sound (the sample its first is, and
/// how many), its timing there (timing.rs: phones, words, notes in samples of the piece, pitch a
/// frame from its first sample), its level a TRACE of its own samples as the mixer had it (rms at
/// its gain and levels; NaN where none came), and its seat's pan.
#[derive(Clone, Debug)]
pub struct PartSung {
    pub name: String,
    pub voice: String,
    pub text: String,
    pub breaths: Vec<(i64, usize)>,
    pub lag: f64,
    pub shift: f64,
    pub start: i64,
    pub len: usize,
    pub timing: Timing,
    pub level: Vec<f32>,
    pub pan: f64,
}

/// A piece sung: left and right at SR, its parts, its tempo, and the sample of its sound written
/// beat 0 falls on.
pub struct Piece {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub parts: Vec<PartSung>,
    pub bpm: f64,
    pub beat_zero: i64,
}

/// The piece sung, seated, mixed and put through its room, as the page sings it (worker.js choir,
/// choir.js Choir): each part performed (part::perform_as; `open(i, text, shift)` gives the engine's
/// singer of part i's song as sung, already clocked and sized, and its silent spans), sung whole by
/// `sing(i, singer, song)` (its samples and its timing from its first; `song` the song as sung), its
/// breaths added, then mixed from its seat and put through the room.
pub fn sing<S>(
    a: &Arranged,
    breaths: Option<&(Library, Vec<i16>)>,
    mut open: impl FnMut(usize, &str, f64) -> Result<(S, Vec<std::ops::Range<usize>>)>,
    mut sing: impl FnMut(usize, S, &str) -> Result<(Vec<f32>, Timing)>,
) -> Result<Piece> {
    let t0 = a.singers.iter().map(|p| p.at - p.jitter / 100.0 - p.spread).fold(f64::INFINITY, f64::min);
    let mut mixer = Mixer::new(
        a.singers.iter().map(|p| MixPart { gain: p.gain, seat: a.seats[p.seat].clone(), levels: p.levels.clone(), lv: None, mute: false }).collect(),
        Some(t0),
        0,
    )?;
    let mut room = Room::new(&a.room, a.bpm, 1, false, 0, 0)?;
    let mut sung = Vec::new();
    for (i, p) in a.singers.iter().enumerate() {
        let lib = if p.breath > 0.0 {
            Some(breaths.ok_or_else(|| Error(format!("{}: breaths asked for and no breaths loaded", p.name)))?)
        } else {
            None
        };
        let part = Part { song: &p.song, sex: p.sex, seed: p.seed as u64, at: p.at, shift: p.shift, jitter: p.jitter, detune: p.detune, spread: p.spread, breath: p.breath };
        let done = perform_as(&part, Manner { together: p.together, give: Some(p.give), wants: &[] }, lib.map(|l| &l.0), |text, shift| {
            let t = if p.together { clocked(text)? } else { text.to_string() };
            open(i, &sized(&t, p.vibrato_size)?, shift)
        })
        .map_err(|e| Error(format!("{}: {}", p.name, e.0)))?;
        let (mut y, timing) = sing(i, done.singer, &done.text).map_err(|e| Error(format!("{}: {}", p.name, e.0)))?;
        let mut bs = Vec::new();
        if let Some((lib, pcm)) = lib {
            let k = 1.0 / 32767.0;
            for &(c, at) in &done.breaths {
                let clip = &lib.clips[c];
                let (lo, hi) = (at.max(0), (at + clip.n as i64).min(y.len() as i64));
                for s in lo..hi {
                    let v = &mut y[s as usize];
                    *v = (*v as f64 + pcm[clip.at + (s - at) as usize] as f64 * k) as f32;
                }
                bs.push((at, clip.n));
            }
        }
        let start = p.at + done.lag;
        let at = js_round((start - t0) * SR as f64) as i64;
        mixer.open(i, start, y.len(), 0)?;
        let len = y.len();
        mixer.push(i, y)?;
        mixer.end(i)?;
        sung.push(PartSung {
            name: p.name.clone(),
            voice: p.voice.clone(),
            text: done.text,
            breaths: bs,
            lag: done.lag,
            shift: done.shift,
            start: at,
            len,
            timing: timing.later(at),
            level: mixer.levels(i).map(<[f32]>::to_vec).unwrap_or_default(),
            pan: a.seats[p.seat].pan,
        });
    }
    let mut out = [Vec::new(), Vec::new()];
    while let Some(y) = mixer.take() {
        room.push([&y[0], &y[1]], [&y[2], &y[3]], &mut out)?;
    }
    room.end(&mut out);
    let [left, right] = out;
    // written beat 0 a song's lead-in after a part at the piece's start
    let beat_zero = js_round((0.0 - t0) * SR as f64) as i64 + js_round(crate::part::LEAD * SR as f64) as i64;
    Ok(Piece { left, right, parts: sung, bpm: a.bpm, beat_zero })
}
