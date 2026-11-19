// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Multi-head attention and pre-norm transformer layers (torch.nn semantics, norm_first=True).

use crate::nn::{LayerNorm, Linear};
use crate::weights::{Result, Weights};

pub struct Mha {
    d: usize,
    heads: usize,
    q: Linear,
    k: Linear,
    v: Linear,
    out: Linear,
}

impl Mha {
    pub fn load(ws: &Weights, prefix: &str, d: usize, heads: usize) -> Result<Mha> {
        let b = ws.shaped(&format!("{prefix}.in_proj_bias"), &[3 * d])?;
        let out = Linear::load(ws, &format!("{prefix}.out_proj"), d, d)?;
        let (wn, sn) = (format!("{prefix}.in_proj_weight"), format!("{prefix}.in_proj_wscale"));
        if ws.has(&sn) {
            let w = ws.shaped_i8(&wn, &[3 * d, d])?;
            let s = ws.shaped(&sn, &[3 * d])?;
            let part = |i: usize| Linear::new_i8(&w[i * d * d..(i + 1) * d * d], &s[i * d..(i + 1) * d], &b[i * d..(i + 1) * d], d, d);
            return Ok(Mha { d, heads, q: part(0)?, k: part(1)?, v: part(2)?, out });
        }
        let w = ws.shaped(&wn, &[3 * d, d])?;
        let part = |i: usize| Linear::new(&w[i * d * d..(i + 1) * d * d], &b[i * d..(i + 1) * d], d, d);
        Ok(Mha { d, heads, q: part(0), k: part(1), v: part(2), out })
    }

    /// Appends the keys and values of m (tk, d).
    pub fn kv(&self, m: &[f32], tk: usize, k: &mut Vec<f32>, v: &mut Vec<f32>) {
        let (a, b) = (k.len(), v.len());
        k.resize(a + tk * self.d, 0.0);
        v.resize(b + tk * self.d, 0.0);
        self.k.forward(m, tk, &mut k[a..]);
        self.v.forward(m, tk, &mut v[b..]);
    }

    /// Queries x (tq, d) over keys and values from m (tk, d); causal masks keys after the query.
    pub fn forward(&self, x: &[f32], tq: usize, m: &[f32], tk: usize, causal: bool, out: &mut [f32]) {
        let (mut k, mut v) = (Vec::new(), Vec::new());
        self.kv(m, tk, &mut k, &mut v);
        self.attend(x, tq, &k, &v, tk, causal, out);
    }

    /// Queries x (tq, d) over tk keys and values from kv.
    #[allow(clippy::too_many_arguments)]
    pub fn attend(&self, x: &[f32], tq: usize, k: &[f32], v: &[f32], tk: usize, causal: bool, out: &mut [f32]) {
        let (d, nh) = (self.d, self.heads);
        let hd = d / nh;
        assert!(k.len() == tk * d && v.len() == tk * d);
        let mut q = vec![0.0; tq * d];
        self.q.forward(x, tq, &mut q);
        let scale = 1.0 / (hd as f32).sqrt();
        let mut ctx = vec![0.0; tq * d];
        let mut s = vec![0.0f32; tk];
        for h in 0..nh {
            for i in 0..tq {
                let qi = &q[i * d + h * hd..i * d + (h + 1) * hd];
                let n = if causal { (i + 1).min(tk) } else { tk };
                let mut mx = f32::NEG_INFINITY;
                for j in 0..n {
                    let kj = &k[j * d + h * hd..j * d + (h + 1) * hd];
                    let mut acc = 0.0;
                    for c in 0..hd {
                        acc += qi[c] * kj[c];
                    }
                    s[j] = acc * scale;
                    mx = mx.max(s[j]);
                }
                let mut z = 0.0;
                for j in 0..n {
                    s[j] = (s[j] - mx).exp();
                    z += s[j];
                }
                let o = &mut ctx[i * d + h * hd..i * d + (h + 1) * hd];
                for j in 0..n {
                    let p = s[j] / z;
                    let vj = &v[j * d + h * hd..j * d + (h + 1) * hd];
                    for c in 0..hd {
                        o[c] += p * vj[c];
                    }
                }
            }
        }
        self.out.forward(&ctx, tq, out);
    }
}

struct Ff {
    l1: Linear,
    l2: Linear,
}

impl Ff {
    fn load(ws: &Weights, prefix: &str, d: usize, ff: usize) -> Result<Ff> {
        Ok(Ff { l1: Linear::load(ws, &format!("{prefix}.linear1"), ff, d)?, l2: Linear::load(ws, &format!("{prefix}.linear2"), d, ff)? })
    }

    fn forward(&self, x: &[f32], t: usize, out: &mut [f32]) {
        let mut h = vec![0.0; t * self.l1.cout];
        self.l1.forward(x, t, &mut h);
        for v in h.iter_mut() {
            *v = v.max(0.0);
        }
        self.l2.forward(&h, t, out);
    }
}

fn add(x: &mut [f32], y: &[f32]) {
    for (a, b) in x.iter_mut().zip(y) {
        *a += b;
    }
}

pub struct EncoderLayer {
    d: usize,
    sa: Mha,
    ff: Ff,
    n1: LayerNorm,
    n2: LayerNorm,
}

impl EncoderLayer {
    pub fn load(ws: &Weights, prefix: &str, d: usize, heads: usize) -> Result<EncoderLayer> {
        let ff = ws.get(&format!("{prefix}.linear1.weight"))?.shape[0];
        Ok(EncoderLayer {
            d,
            sa: Mha::load(ws, &format!("{prefix}.self_attn"), d, heads)?,
            ff: Ff::load(ws, prefix, d, ff)?,
            n1: LayerNorm::load(ws, &format!("{prefix}.norm1"), d)?,
            n2: LayerNorm::load(ws, &format!("{prefix}.norm2"), d)?,
        })
    }

    pub fn forward(&self, x: &mut [f32], t: usize) {
        let mut y = x.to_vec();
        self.n1.forward(&mut y);
        let mut o = vec![0.0; t * self.d];
        self.sa.forward(&y, t, &y, t, false, &mut o);
        add(x, &o);
        y.copy_from_slice(x);
        self.n2.forward(&mut y);
        self.ff.forward(&y, t, &mut o);
        add(x, &o);
    }
}

/// A decoder layer's keys and values so far, and those of the memory.
pub struct DecoderCache {
    sk: Vec<f32>,
    sv: Vec<f32>,
    mk: Vec<f32>,
    mv: Vec<f32>,
    tm: usize,
}

pub struct DecoderLayer {
    d: usize,
    sa: Mha,
    ca: Mha,
    ff: Ff,
    n1: LayerNorm,
    n2: LayerNorm,
    n3: LayerNorm,
}

impl DecoderLayer {
    pub fn load(ws: &Weights, prefix: &str, d: usize, heads: usize) -> Result<DecoderLayer> {
        let ff = ws.get(&format!("{prefix}.linear1.weight"))?.shape[0];
        Ok(DecoderLayer {
            d,
            sa: Mha::load(ws, &format!("{prefix}.self_attn"), d, heads)?,
            ca: Mha::load(ws, &format!("{prefix}.multihead_attn"), d, heads)?,
            ff: Ff::load(ws, prefix, d, ff)?,
            n1: LayerNorm::load(ws, &format!("{prefix}.norm1"), d)?,
            n2: LayerNorm::load(ws, &format!("{prefix}.norm2"), d)?,
            n3: LayerNorm::load(ws, &format!("{prefix}.norm3"), d)?,
        })
    }

    /// Causal self-attention over x (t, d), then attention over the memory (tm, d).
    pub fn forward(&self, x: &mut [f32], t: usize, mem: &[f32], tm: usize) {
        let mut y = x.to_vec();
        let mut o = vec![0.0; t * self.d];
        self.n1.forward(&mut y);
        self.sa.forward(&y, t, &y, t, true, &mut o);
        add(x, &o);
        y.copy_from_slice(x);
        self.n2.forward(&mut y);
        self.ca.forward(&y, t, mem, tm, false, &mut o);
        add(x, &o);
        y.copy_from_slice(x);
        self.n3.forward(&mut y);
        self.ff.forward(&y, t, &mut o);
        add(x, &o);
    }

    pub fn cache(&self, mem: &[f32], tm: usize) -> DecoderCache {
        let mut c = DecoderCache { sk: Vec::new(), sv: Vec::new(), mk: Vec::new(), mv: Vec::new(), tm };
        self.ca.kv(mem, tm, &mut c.mk, &mut c.mv);
        c
    }

    /// The next row x (d) of forward, given the rows before it in c: the same values.
    pub fn step(&self, x: &mut [f32], c: &mut DecoderCache) {
        let mut y = x.to_vec();
        let mut o = vec![0.0; self.d];
        self.n1.forward(&mut y);
        self.sa.kv(&y, 1, &mut c.sk, &mut c.sv);
        self.sa.attend(&y, 1, &c.sk, &c.sv, c.sk.len() / self.d, false, &mut o);
        add(x, &o);
        y.copy_from_slice(x);
        self.n2.forward(&mut y);
        self.ca.attend(&y, 1, &c.mk, &c.mv, c.tm, false, &mut o);
        add(x, &o);
        y.copy_from_slice(x);
        self.n3.forward(&mut y);
        self.ff.forward(&y, 1, &mut o);
        add(x, &o);
    }
}
