// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! 32-bit float mono WAV output: every sample as computed, nothing clipped.

use crate::weights::{err, Result};

pub fn write(path: &str, x: &[f32], sr: u32) -> Result<()> {
    if let Some(i) = x.iter().position(|v| !v.is_finite()) {
        return err(format!("{path}: sample {i} is {}", x[i]));
    }
    let data = (x.len() * 4) as u32;
    let mut b = Vec::with_capacity(58 + data as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(50 + data).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&18u32.to_le_bytes());
    b.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&sr.to_le_bytes());
    b.extend_from_slice(&(sr * 4).to_le_bytes());
    b.extend_from_slice(&4u16.to_le_bytes());
    b.extend_from_slice(&32u16.to_le_bytes());
    b.extend_from_slice(&0u16.to_le_bytes());
    b.extend_from_slice(b"fact");
    b.extend_from_slice(&4u32.to_le_bytes());
    b.extend_from_slice(&(x.len() as u32).to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data.to_le_bytes());
    for v in x {
        b.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, b).map_err(|e| crate::weights::Error(format!("{path}: {e}")))
}
