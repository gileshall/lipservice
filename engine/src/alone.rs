// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! One voice heard alone (speech, a song sung alone; what no room masters) on its way out: a song
//! set to speech's level, then held under a ceiling of -1.5 dBFS by a look-ahead limiter that a
//! clip at its level seldom wakes. A choir's parts do not come through here; the room masters them.
//! The limiter is the room's (room::Limiter, room.js Limiter), one voice in both its channels.

use crate::room::Limiter;

/// How far a song sung alone is let down, dB. Through the latent voice singing comes 7 to 9 dB
/// over speech, its highest samples to 7 dB over full scale; through the vocoder 3 dB quieter and
/// never over full scale. At these it meets the ceiling about as seldom as speech does.
pub const SUNG_VOX_DB: f64 = -9.0;
pub const SUNG_VOC_DB: f64 = -6.0;
/// A voice alone on its way out, each sample in its own place: what push() gives runs the
/// limiter's delay behind what it is given, and end() gives the rest.
pub struct Alone {
    gain: f64,
    lim: Limiter,
    skip: usize,
    ended: bool,
}

impl Alone {
    fn new(db: f64) -> Self {
        let lim = Limiter::new();
        Alone { gain: 10f64.powf(db / 20.0), skip: lim.delay, lim, ended: false }
    }

    pub fn speech() -> Self {
        Self::new(0.0)
    }

    /// A song sung alone through the latent voice (vox) or the vocoder.
    pub fn song(vox: bool) -> Self {
        Self::new(if vox { SUNG_VOX_DB } else { SUNG_VOC_DB })
    }

    pub fn push(&mut self, x: &[f32], out: &mut Vec<f32>) {
        assert!(!self.ended, "samples pushed after the end");
        for &s in x {
            let v = (s as f64 * self.gain) as f32 as f64;
            let (y, _) = self.lim.step(v, v);
            if self.skip > 0 {
                self.skip -= 1;
            } else {
                out.push(y as f32);
            }
        }
    }

    /// The samples still held: the limiter's delay of them. Once only.
    pub fn end(&mut self, out: &mut Vec<f32>) {
        assert!(!self.ended, "ended twice");
        for _ in 0..self.lim.delay {
            let (y, _) = self.lim.step(0.0, 0.0);
            if self.skip > 0 {
                self.skip -= 1;
            } else {
                out.push(y as f32);
            }
        }
        self.ended = true;
    }

    pub fn ended(&self) -> bool {
        self.ended
    }

    /// A whole clip.
    pub fn whole(mut self, x: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity(x.len());
        self.push(x, &mut out);
        self.end(&mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|i| amp * (i as f32 * 0.07).sin()).collect()
    }

    #[test]
    fn a_clip_comes_out_as_long_as_it_went_in_however_it_is_pushed() {
        let x = tone(10_000, 3.0);
        let whole = Alone::song(true).whole(&x);
        assert_eq!(whole.len(), x.len());
        let mut a = Alone::song(true);
        let mut parts = Vec::new();
        for c in x.chunks(37) {
            a.push(c, &mut parts);
        }
        a.end(&mut parts);
        assert_eq!(parts, whole);
    }

    #[test]
    fn under_the_ceiling_it_is_only_the_level() {
        let x = tone(5_000, 0.3);
        let y = Alone::speech().whole(&x);
        assert_eq!(x, y);
        let g = 10f64.powf(SUNG_VOC_DB / 20.0);
        let y = Alone::song(false).whole(&x);
        assert!(x.iter().zip(&y).all(|(a, b)| (*a as f64 * g) as f32 == *b));
    }

    #[test]
    fn over_the_ceiling_it_is_held_under_it() {
        let y = Alone::speech().whole(&tone(20_000, 4.0));
        let ceiling = 10f64.powf(-1.5 / 20.0) as f32;
        let top = y.iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!(top <= ceiling, "{top}");
        assert!(top > 0.9 * ceiling, "{top}");
    }
}
