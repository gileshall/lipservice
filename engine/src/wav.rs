// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! 32-bit float WAV output: every sample as computed, nothing clipped.

use crate::weights::{err, Result};

pub fn write(path: &str, x: &[f32], sr: u32) -> Result<()> {
    write_channels(path, &[x], sr)
}

/// Channels of one length, left first, their samples in turn.
pub fn write_channels(path: &str, ch: &[&[f32]], sr: u32) -> Result<()> {
    let (c, n) = (ch.len(), ch[0].len());
    for x in ch {
        if x.len() != n {
            return err(format!("{path}: channels of {n} and {} samples", x.len()));
        }
        if let Some(i) = x.iter().position(|v| !v.is_finite()) {
            return err(format!("{path}: sample {i} is {}", x[i]));
        }
    }
    let data = (n * c * 4) as u32;
    let mut b = Vec::with_capacity(58 + data as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(50 + data).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&18u32.to_le_bytes());
    b.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    b.extend_from_slice(&(c as u16).to_le_bytes());
    b.extend_from_slice(&sr.to_le_bytes());
    b.extend_from_slice(&(sr * 4 * c as u32).to_le_bytes());
    b.extend_from_slice(&(4 * c as u16).to_le_bytes());
    b.extend_from_slice(&32u16.to_le_bytes());
    b.extend_from_slice(&0u16.to_le_bytes());
    b.extend_from_slice(b"fact");
    b.extend_from_slice(&4u32.to_le_bytes());
    b.extend_from_slice(&(n as u32).to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data.to_le_bytes());
    for i in 0..n {
        for x in ch {
            b.extend_from_slice(&x[i].to_le_bytes());
        }
    }
    std::fs::write(path, b).map_err(|e| crate::weights::Error(format!("{path}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_are_written_in_turn() {
        let dir = std::env::temp_dir().join(format!("lipservice-wav-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("two.wav").to_string_lossy().into_owned();
        write_channels(&p, &[&[0.25, 0.5, 0.75], &[-0.25, -0.5, -0.75]], 24000).unwrap();
        let b = std::fs::read(&p).unwrap();
        let u16_at = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
        let u32_at = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        assert_eq!((&b[..4], &b[8..16], &b[38..42], &b[50..54]), (&b"RIFF"[..], &b"WAVEfmt "[..], &b"fact"[..], &b"data"[..]));
        // float, two channels, 24 kHz, 8 bytes a frame, 3 frames, 24 bytes of sound
        assert_eq!((u16_at(20), u16_at(22), u32_at(24), u32_at(28), u16_at(32), u16_at(34)), (3, 2, 24000, 192000, 8, 32));
        assert_eq!((u32_at(4) as usize, u32_at(46), u32_at(54), b.len()), (b.len() - 8, 3, 24, 82));
        let x: Vec<f32> = b[58..].chunks(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        assert_eq!(x, [0.25, -0.25, 0.5, -0.5, 0.75, -0.75]);
        // one channel is write()'s own bytes
        let (q, r) = (dir.join("a.wav").to_string_lossy().into_owned(), dir.join("b.wav").to_string_lossy().into_owned());
        write(&q, &[0.1, 0.2], 24000).unwrap();
        write_channels(&r, &[&[0.1, 0.2]], 24000).unwrap();
        assert_eq!(std::fs::read(&q).unwrap(), std::fs::read(&r).unwrap());
        assert!(write_channels(&p, &[&[0.0, 0.0], &[0.0]], 24000).unwrap_err().0.contains("channels of 2 and 1 samples"));
        assert!(write_channels(&p, &[&[0.0], &[f32::NAN]], 24000).unwrap_err().0.contains("sample 0 is NaN"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
