// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A small seeded generator (xoshiro128++) and Gaussian noise.

pub struct Rng {
    s: [u32; 4],
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        // splitmix64 to fill the state
        let mut z = seed;
        let mut next = || {
            z = z.wrapping_add(0x9e3779b97f4a7c15);
            let mut x = z;
            x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
            x ^ (x >> 31)
        };
        let a = next();
        let b = next();
        Rng { s: [a as u32, (a >> 32) as u32, b as u32, (b >> 32) as u32] }
    }

    /// Stream k of a seed: stream 0 is Rng::new(seed); others are apart from it.
    pub fn stream(seed: u64, k: u64) -> Rng {
        Rng::new(seed ^ k.wrapping_mul(0xd1b54a32d192ed03))
    }

    /// Place i under a key (key): a generator of its own, none of the others' values made to reach
    /// it.
    pub fn place(key: u64, i: u64) -> Rng {
        Rng::new(key ^ i.wrapping_add(1).wrapping_mul(0xbf58476d1ce4e5b9))
    }

    /// The key of stream k of a seed's places (place).
    pub fn key(seed: u64, k: u64) -> u64 {
        let mut r = Rng::stream(seed, k);
        (r.next_u32() as u64) << 32 | r.next_u32() as u64
    }

    pub fn next_u32(&mut self) -> u32 {
        let r = self.s[0].wrapping_add(self.s[3]).rotate_left(7).wrapping_add(self.s[0]);
        let t = self.s[1] << 9;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(11);
        r
    }

    /// Past the next n values.
    pub fn skip(&mut self, n: usize) {
        for _ in 0..n {
            self.next_u32();
        }
    }

    /// Uniform in (0, 1).
    pub fn uniform(&mut self) -> f64 {
        ((self.next_u32() >> 8) as f64 + 0.5) / (1u32 << 24) as f64
    }

    /// Unit-variance Gaussian samples, by Box-Muller.
    pub fn gaussian(&mut self, n: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(n + 1);
        while out.len() < n {
            let r = (-2.0 * self.uniform().ln()).sqrt();
            let a = 2.0 * std::f64::consts::PI * self.uniform();
            out.push((r * a.cos()) as f32);
            out.push((r * a.sin()) as f32);
        }
        out.truncate(n);
        out
    }

    /// What gaussian(a + n) gives after its first a samples, those not made.
    pub fn gaussian_after(&mut self, a: usize, n: usize) -> Vec<f32> {
        self.skip(a / 2 * 2);
        let mut out = self.gaussian(a % 2 + n);
        out.drain(..a % 2);
        out
    }
}

/// Rng::gaussian's samples a stretch at a time, from its sample `at` on, those before not made.
pub struct Gaussian {
    rng: Rng,
    /// The second of a pair, its first given.
    spare: Option<f32>,
}

impl Gaussian {
    pub fn after(mut rng: Rng, at: usize) -> Gaussian {
        rng.skip(at / 2 * 2);
        let mut g = Gaussian { rng, spare: None };
        if at % 2 == 1 {
            g.next();
        }
        g
    }

    fn next(&mut self) -> f32 {
        if let Some(v) = self.spare.take() {
            return v;
        }
        let r = (-2.0 * self.rng.uniform().ln()).sqrt();
        let a = 2.0 * std::f64::consts::PI * self.rng.uniform();
        self.spare = Some((r * a.sin()) as f32);
        (r * a.cos()) as f32
    }

    /// The next n samples, onto `out`.
    pub fn draw(&mut self, n: usize, out: &mut Vec<f32>) {
        out.extend((0..n).map(|_| self.next()));
    }
}
