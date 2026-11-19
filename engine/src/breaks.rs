// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Where a reader would break at a word gap with no stop: a text encoder and a head giving each
//! token a logit, read at the space between two words; and the logit above which a given share of
//! such gaps in held-out text lie (rates ascending, cuts).
use crate::nn::Conv1d;
use crate::score::TextEncoder;
use crate::weights::{err, Result, Weights};

pub struct Breaks {
    enc: TextEncoder,
    head: [Conv1d; 2],
    rates: Vec<f32>,
    cuts: Vec<f32>,
}

impl Breaks {
    pub fn load(ws: &Weights) -> Result<Breaks> {
        let enc = TextEncoder::load(ws, "enc")?;
        let d = enc.dim();
        let rates = ws.get("rates")?.data.clone();
        let cuts = ws.shaped("cuts", &[rates.len()])?.to_vec();
        if rates.len() < 2 || rates.windows(2).any(|w| !(w[0] < w[1])) || cuts.windows(2).any(|w| w[0] < w[1]) {
            return err("rates must ascend and cuts not rise");
        }
        Ok(Breaks {
            head: [Conv1d::load(ws, "head.0", d, d, 3)?, Conv1d::load(ws, "head.3", 1, d, 1)?],
            enc,
            rates,
            cuts,
        })
    }

    /// The logit above which `rate` of the word gaps lie.
    pub fn cut(&self, rate: f32) -> Result<f32> {
        let (r, c) = (&self.rates, &self.cuts);
        if !(rate >= r[0] && rate <= r[r.len() - 1]) {
            return err(format!("a break rate of {rate}: from {} to {}", r[0], r[r.len() - 1]));
        }
        let k = r.partition_point(|&x| x <= rate).clamp(1, r.len() - 1);
        let t = (rate - r[k - 1]) / (r[k] - r[k - 1]);
        Ok(c[k - 1] + t * (c[k] - c[k - 1]))
    }

    /// A logit a token.
    pub fn logits(&self, tok: &[usize]) -> Result<Vec<f32>> {
        let (d, n) = (self.enc.dim(), tok.len());
        if n == 0 {
            return err("no tokens to break");
        }
        let h = self.enc.forward(tok)?;
        let mut a = vec![0.0; n * d];
        self.head[0].forward(&h, n, &mut a);
        a.iter_mut().for_each(|v| *v = v.max(0.0));
        let mut out = vec![0.0; n];
        self.head[1].forward(&a, n, &mut out);
        Ok(out)
    }
}
