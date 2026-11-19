// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Radix-2 FFTs: complex, and real via a half-size complex transform.

use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct C {
    pub re: f32,
    pub im: f32,
}

impl C {
    #[inline]
    pub fn new(re: f32, im: f32) -> C {
        C { re, im }
    }
    #[inline]
    pub fn mul(self, o: C) -> C {
        C::new(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re)
    }
    #[inline]
    pub fn add(self, o: C) -> C {
        C::new(self.re + o.re, self.im + o.im)
    }
    #[inline]
    pub fn sub(self, o: C) -> C {
        C::new(self.re - o.re, self.im - o.im)
    }
    #[inline]
    pub fn conj(self) -> C {
        C::new(self.re, -self.im)
    }
    #[inline]
    pub fn scale(self, s: f32) -> C {
        C::new(self.re * s, self.im * s)
    }
}

/// In-place complex FFT of a power-of-two size, unnormalized in both directions.
pub struct Fft {
    n: usize,
    rev: Vec<u32>,
    #[cfg(any(test, not(target_arch = "wasm32")))]
    tw: Vec<C>, // e^{-2 pi i k / n}, k < n/2
    /// For wasm: each stage's twiddles in order (the stage of half h at h - 1), forward then
    /// inverse, as w and as (-w.im, w.re), so two butterflies take a multiply each.
    #[cfg(target_arch = "wasm32")]
    st: [[Vec<C>; 2]; 2],
}

impl Fft {
    pub fn new(n: usize) -> Fft {
        assert!(n.is_power_of_two() && n >= 2, "FFT size {n} is not a power of two");
        let bits = n.trailing_zeros();
        let rev = (0..n as u32).map(|i| i.reverse_bits() >> (32 - bits)).collect();
        let tw = (0..n / 2)
            .map(|k| {
                let a = -2.0 * PI * k as f64 / n as f64;
                C::new(a.cos() as f32, a.sin() as f32)
            })
            .collect::<Vec<C>>();
        #[cfg(target_arch = "wasm32")]
        let st = [false, true].map(|inverse| {
            let w: Vec<C> = (0..bits)
                .flat_map(|s| {
                    let (half, step) = (1 << s, n >> (s + 1));
                    (0..half).map(move |k| (k, step))
                })
                .map(|(k, step)| if inverse { tw[k * step].conj() } else { tw[k * step] })
                .collect();
            let r = w.iter().map(|w| C::new(-w.im, w.re)).collect();
            [w, r]
        });
        Fft {
            n,
            rev,
            #[cfg(any(test, not(target_arch = "wasm32")))]
            tw,
            #[cfg(target_arch = "wasm32")]
            st,
        }
    }

    pub fn len(&self) -> usize {
        self.n
    }

    #[cfg(any(test, not(target_arch = "wasm32")))]
    fn run_plain(&self, x: &mut [C], inverse: bool) {
        let n = self.n;
        assert_eq!(x.len(), n);
        for i in 0..n {
            let j = self.rev[i] as usize;
            if i < j {
                x.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let step = n / len;
            for start in (0..n).step_by(len) {
                for k in 0..half {
                    let mut w = self.tw[k * step];
                    if inverse {
                        w = w.conj();
                    }
                    let a = x[start + k];
                    let b = x[start + k + half].mul(w);
                    x[start + k] = a.add(b);
                    x[start + k + half] = a.sub(b);
                }
            }
            len *= 2;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn run(&self, x: &mut [C], inverse: bool) {
        self.run_plain(x, inverse)
    }

    /// run_plain's butterflies, two at a time, each to the bit: b w's real part as b.re w.re +
    /// b.im (-w.im) is b.re w.re - b.im w.im.
    #[cfg(target_arch = "wasm32")]
    fn run(&self, x: &mut [C], inverse: bool) {
        use std::arch::wasm32::*;
        let n = self.n;
        assert_eq!(x.len(), n);
        for i in 0..n {
            let j = self.rev[i] as usize;
            if i < j {
                x.swap(i, j);
            }
        }
        let [w1, w2] = &self.st[inverse as usize];
        assert!(w1.len() == n - 1 && w2.len() == n - 1);
        let p = x.as_mut_ptr() as *mut v128;
        // b w for b, w each two complex values (w2: w as (-w.im, w.re))
        let mul = |b: v128, w1: v128, w2: v128| {
            f32x4_add(f32x4_mul(i32x4_shuffle::<0, 0, 2, 2>(b, b), w1), f32x4_mul(i32x4_shuffle::<1, 1, 3, 3>(b, b), w2))
        };
        // SAFETY: x holds n complex values (two to a v128) and w1, w2 n - 1 (checked above);
        // every index below is under those.
        unsafe {
            if n == 2 {
                let (a, b) = (x[0], x[1].mul(w1[0]));
                x[0] = a.add(b);
                x[1] = a.sub(b);
                return;
            }
            // len 2: two butterflies of one twiddle, from neighbouring pairs
            let (v1, v2) = (v128_load64_splat(w1.as_ptr() as *const u64), v128_load64_splat(w2.as_ptr() as *const u64));
            for i in (0..n / 2).step_by(2) {
                let (u, v) = (v128_load(p.add(i)), v128_load(p.add(i + 1)));
                let (a, b) = (i64x2_shuffle::<0, 2>(u, v), i64x2_shuffle::<1, 3>(u, v));
                let bw = mul(b, v1, v2);
                let (s, d) = (f32x4_add(a, bw), f32x4_sub(a, bw));
                v128_store(p.add(i), i64x2_shuffle::<0, 2>(s, d));
                v128_store(p.add(i + 1), i64x2_shuffle::<1, 3>(s, d));
            }
            let mut half = 2;
            while half < n {
                let (t1, t2) = (w1.as_ptr().add(half - 1) as *const v128, w2.as_ptr().add(half - 1) as *const v128);
                for start in (0..n / 2).step_by(half) {
                    let (pa, pb) = (p.add(start), p.add(start + half / 2));
                    for k in 0..half / 2 {
                        let a = v128_load(pa.add(k));
                        let bw = mul(v128_load(pb.add(k)), v128_load(t1.add(k)), v128_load(t2.add(k)));
                        v128_store(pa.add(k), f32x4_add(a, bw));
                        v128_store(pb.add(k), f32x4_sub(a, bw));
                    }
                }
                half *= 2;
            }
        }
    }

    pub fn forward(&self, x: &mut [C]) {
        self.run(x, false)
    }

    pub fn inverse(&self, x: &mut [C]) {
        self.run(x, true)
    }
}

/// Real FFT of size n: n reals to n/2 + 1 bins. `inverse` is normalized by 1/n, like irfft.
pub struct RealFft {
    n: usize,
    half: Fft,
    tw: Vec<C>, // e^{-2 pi i k / n}, k <= n/2
    buf: std::cell::RefCell<Vec<C>>,
}

impl RealFft {
    pub fn new(n: usize) -> RealFft {
        assert!(n >= 4, "real FFT size {n} too small");
        let tw = (0..=n / 2)
            .map(|k| {
                let a = -2.0 * PI * k as f64 / n as f64;
                C::new(a.cos() as f32, a.sin() as f32)
            })
            .collect();
        RealFft { n, half: Fft::new(n / 2), tw, buf: std::cell::RefCell::new(vec![C::default(); n / 2]) }
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn bins(&self) -> usize {
        self.n / 2 + 1
    }

    pub fn forward(&self, x: &[f32], out: &mut [C]) {
        let h = self.n / 2;
        assert_eq!(x.len(), self.n);
        assert_eq!(out.len(), h + 1);
        let mut z = self.buf.borrow_mut();
        for m in 0..h {
            z[m] = C::new(x[2 * m], x[2 * m + 1]);
        }
        self.half.forward(&mut z);
        for k in 0..=h {
            let zk = z[k % h];
            let zc = z[(h - k) % h].conj();
            let e = zk.add(zc).scale(0.5);
            let d = zk.sub(zc).scale(0.5);
            let o = C::new(d.im, -d.re); // d / i
            out[k] = e.add(self.tw[k].mul(o));
        }
    }

    /// Ignores the imaginary parts of bins 0 and n/2, as irfft does.
    pub fn inverse(&self, xs: &[C], out: &mut [f32]) {
        let h = self.n / 2;
        assert_eq!(xs.len(), h + 1);
        assert_eq!(out.len(), self.n);
        let mut z = self.buf.borrow_mut();
        let at = |k: usize| -> C {
            let c = xs[k];
            if k == 0 || k == h {
                C::new(c.re, 0.0)
            } else {
                c
            }
        };
        for k in 0..h {
            let a = at(k);
            let b = at(h - k).conj();
            let e = a.add(b).scale(0.5);
            let o = a.sub(b).scale(0.5).mul(self.tw[k].conj()); // divide by w^k
            z[k] = C::new(e.re - o.im, e.im + o.re); // e + i o
        }
        self.half.inverse(&mut z);
        let s = 1.0 / h as f32;
        for m in 0..h {
            out[2 * m] = z[m].re * s;
            out[2 * m + 1] = z[m].im * s;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dft(x: &[f32]) -> Vec<(f64, f64)> {
        let n = x.len();
        (0..=n / 2)
            .map(|k| {
                let mut re = 0.0;
                let mut im = 0.0;
                for (t, &v) in x.iter().enumerate() {
                    let a = -2.0 * PI * (k * t) as f64 / n as f64;
                    re += v as f64 * a.cos();
                    im += v as f64 * a.sin();
                }
                (re, im)
            })
            .collect()
    }

    /// run (SIMD on wasm) against run_plain, to the bit, both directions.
    #[test]
    fn fft_matches_plain() {
        let mut s = 777u32;
        let mut r = || {
            s = s.wrapping_mul(1664525).wrapping_add(1013904223);
            (s >> 8) as f32 / (1u32 << 20) as f32 - 8.0
        };
        for bits in 1..=11 {
            let f = Fft::new(1 << bits);
            for inverse in [false, true] {
                let mut x: Vec<C> = (0..f.n).map(|_| C::new(r(), r())).collect();
                x[0] = C::new(-0.0, 0.0);
                let mut y = x.clone();
                f.run(&mut x, inverse);
                f.run_plain(&mut y, inverse);
                for (a, b) in x.iter().zip(&y) {
                    assert!(a.re.to_bits() == b.re.to_bits() && a.im.to_bits() == b.im.to_bits(), "n {} inverse {inverse}", f.n);
                }
            }
        }
    }

    #[test]
    fn real_fft_matches_dft_and_inverts() {
        for &n in &[8usize, 64, 1024] {
            let mut s = 12345u32;
            let x: Vec<f32> = (0..n)
                .map(|_| {
                    s = s.wrapping_mul(1664525).wrapping_add(1013904223);
                    (s >> 8) as f32 / (1u32 << 24) as f32 - 0.5
                })
                .collect();
            let f = RealFft::new(n);
            let mut out = vec![C::default(); n / 2 + 1];
            f.forward(&x, &mut out);
            for (k, (re, im)) in dft(&x).into_iter().enumerate() {
                assert!((out[k].re as f64 - re).abs() < 1e-4 * n as f64, "n {n} bin {k}");
                assert!((out[k].im as f64 - im).abs() < 1e-4 * n as f64, "n {n} bin {k}");
            }
            let mut back = vec![0.0; n];
            f.inverse(&out, &mut back);
            for t in 0..n {
                assert!((back[t] - x[t]).abs() < 1e-5, "n {n} sample {t}");
            }
        }
    }
}
