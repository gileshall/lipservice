// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Against PyTorch: testdata/voc-test.lsw.

use lipservice::dsp::{self, MinPhase, Stft, NBIN};
use lipservice::fft::C;
use lipservice::vocoder::{Frames, Vocoder};
use lipservice::weights::Weights;

fn snr_db(want: &[f32], got: &[f32]) -> f64 {
    assert_eq!(want.len(), got.len());
    let s: f64 = want.iter().map(|v| (*v as f64).powi(2)).sum();
    let e: f64 = want.iter().zip(got).map(|(a, b)| (*a as f64 - *b as f64).powi(2)).sum();
    10.0 * (s / e.max(1e-30)).log10()
}

fn flat(c: &[C]) -> Vec<f32> {
    c.iter().flat_map(|v| [v.re, v.im]).collect()
}

fn load(weights: &str, test: &str) -> (Vocoder, Weights, Frames) {
    let dir = env!("CARGO_MANIFEST_DIR");
    let voc = Vocoder::load(&Weights::read(&format!("{dir}/testdata/{weights}")).unwrap()).unwrap();
    let v = Weights::read(&format!("{dir}/testdata/{test}")).unwrap();
    let f = Frames {
        env: v.get("env").unwrap().data.clone(),
        bap: v.get("bap").unwrap().data.clone(),
        lf0: v.get("lf0").unwrap().data.clone(),
        vuv: v.get("vuv").unwrap().data.clone(),
    };
    (voc, v, f)
}

#[test]
fn matches_torch() {
    let (voc, v, f) = load("voc-a.lsw", "voc-test.lsw");
    let t = f.len();
    let f0: Vec<f32> = f.lf0.iter().map(|x| x.exp()).collect();
    let src = dsp::harmonic_source(&f0, &f.vuv);
    let s_src = snr_db(&v.get("source").unwrap().data, &src);

    let stft = Stft::new();
    let eh = stft.forward(&v.get("source").unwrap().data, t);
    let s_stft = snr_db(&v.get("source_stft").unwrap().data, &flat(&eh));

    let (lh, ln) = voc.shapes(&f).unwrap();
    let e_lh = lh.iter().zip(&v.get("lh").unwrap().data).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    let e_ln = ln.iter().zip(&v.get("ln").unwrap().data).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);

    let mut mp = MinPhase::new();
    let mut hh = vec![C::default(); t * NBIN];
    let want_lh = &v.get("lh").unwrap().data;
    for i in 0..t {
        mp.run(&want_lh[i * NBIN..(i + 1) * NBIN], &mut hh[i * NBIN..(i + 1) * NBIN]);
    }
    let s_mp = snr_db(&v.get("min_phase").unwrap().data, &flat(&hh));

    let y = voc.render(&f, &v.get("noise").unwrap().data).unwrap();
    let s_audio = snr_db(&v.get("audio").unwrap().data, &y);

    println!("source {s_src:.1} dB, stft {s_stft:.1} dB, lh max err {e_lh:.2e}, ln max err {e_ln:.2e}, min phase {s_mp:.1} dB, audio {s_audio:.1} dB");
    assert!(s_stft > 100.0, "stft {s_stft}");
    assert!(e_lh < 1e-3 && e_ln < 1e-3, "shapes {e_lh} {e_ln}");
    assert!(s_mp > 90.0, "min phase {s_mp}");
    assert!(s_src > 50.0, "source {s_src}");
    assert!(s_audio > 50.0, "audio {s_audio}");
}

/// Int8 layers against torch's simulation of them. Float differences of 1e-7
/// flip roundings, so the floor is near 50 dB: torch itself lands there with its input nudged 1e-6.
#[test]
fn int8_matches_simulation() {
    let (voc, v, f) = load("voc-a-i8.lsw", "voc-test-i8.lsw");
    let (lh, ln) = voc.shapes(&f).unwrap();
    let s_lh = snr_db(&v.get("lh").unwrap().data, &lh);
    let s_ln = snr_db(&v.get("ln").unwrap().data, &ln);
    let y = voc.render(&f, &v.get("noise").unwrap().data).unwrap();
    let s_audio = snr_db(&v.get("audio").unwrap().data, &y);
    println!("int8: lh {s_lh:.1} dB, ln {s_ln:.1} dB, audio {s_audio:.1} dB");
    assert!(s_lh > 50.0 && s_ln > 50.0 && s_audio > 40.0);
}
