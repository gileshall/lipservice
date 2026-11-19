// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The mel route against PyTorch: testdata/melvoc-test.lsw, and
//! melvoc-h*.lsw the same for a decoder with the harmonic template.

use lipservice::melvoc::{MelVoc, N_MEL};
use lipservice::weights::Weights;

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn max_err(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}

fn snr_db(want: &[f32], got: &[f32]) -> f64 {
    assert_eq!(want.len(), got.len());
    let s: f64 = want.iter().map(|v| (*v as f64).powi(2)).sum();
    let e: f64 = want.iter().zip(got).map(|(a, b)| (*a as f64 - *b as f64).powi(2)).sum();
    10.0 * (s / e.max(1e-30)).log10()
}

/// The mel's SNR, Vocos input's largest error and the audio's SNR, each stage from torch's input.
fn check(weights: &str, test: &str) -> (f64, f32, f64) {
    let m = MelVoc::load(read(weights)).unwrap();
    let v = read(test);
    let d = |n: &str| v.get(n).unwrap().data.clone();
    let mel = m.mel.forward(&d("hx"), &d("lf0"), &d("vuv"), None).unwrap();
    let e_mel = snr_db(&d("mel"), &mel);
    let vin = m.vocos.input(&d("mel")).unwrap();
    let e_vin = max_err(&vin, &d("vin"));
    let n = vin.len() / N_MEL;
    let y = m.vocos.istft(&m.vocos.spectrum(&d("vin"), n), n);
    (e_mel, e_vin, snr_db(&d("audio"), &y))
}

#[test]
fn matches_torch() {
    let (e_mel, e_vin, s) = check("melvoc.lsw", "melvoc-test.lsw");
    println!("mel {e_mel:.1} dB, vocos input max err {e_vin:.2e}, audio {s:.1} dB");
    assert!(e_mel > 100.0, "mel {e_mel}");
    assert!(e_vin < 1e-5, "vocos input {e_vin}");
    assert!(s > 50.0, "audio {s}");
}

#[test]
fn matches_torch_int8() {
    let (e_mel, e_vin, s) = check("melvoc-i8.lsw", "melvoc-test-i8.lsw");
    println!("int8: mel {e_mel:.1} dB, vocos input max err {e_vin:.2e}, audio {s:.1} dB");
    assert!(e_mel > 45.0, "mel {e_mel}");
    assert!(e_vin < 1e-5, "vocos input {e_vin}");
    assert!(s > 20.0, "audio {s}");
}

#[test]
fn matches_torch_harmonic() {
    for (w, t, mel_db, audio_db) in [("melvoc-h.lsw", "melvoc-h-test.lsw", 100.0, 50.0), ("melvoc-h-i8.lsw", "melvoc-h-test-i8.lsw", 45.0, 20.0)] {
        let (e_mel, e_vin, s) = check(w, t);
        println!("{w}: mel {e_mel:.1} dB, vocos input max err {e_vin:.2e}, audio {s:.1} dB");
        assert!(e_mel > mel_db, "{w}: mel {e_mel}");
        assert!(e_vin < 1e-5, "{w}: vocos input {e_vin}");
        assert!(s > audio_db, "{w}: audio {s}");
    }
}

/// Streaming the mel route against its whole-utterance path, SSML edits and all: the same
/// samples, bit for bit, however the frames are fed.
#[test]
fn stream_matches_whole() {
    use lipservice::dsp::HOP;
    use lipservice::front::Phonemizer;
    use lipservice::g2p::G2p;
    use lipservice::inflect::{self, Inflection};
    use lipservice::lexicon::Lexicon;
    use lipservice::pitchflow::{PitchFlow, Sampling};
    use lipservice::score::{Pitch, ScoreModel};
    use lipservice::ssml;
    use lipservice::stream::{Render, Stream};

    let src = "<speak><s>Is <emphasis>this</emphasis> <prosody rate=\"fast\" pitch=\"+3st\" volume=\"loud\">the same</prosody>?</s>\
               <break time=\"300ms\"/><prosody pitch=\"150Hz\">One <emphasis level=\"reduced\">two</emphasis></prosody> three.</speak>";
    for (score, file, flow) in [
        ("score-a.lsw", "melvoc.lsw", None),
        ("score-a-i8.lsw", "melvoc-i8.lsw", Some("pitch-a-i8.lsw")),
        ("score-a-i8.lsw", "melvoc-h-i8.lsw", Some("pitch-a-i8.lsw")),
    ] {
        let s = ScoreModel::load(&read(score)).unwrap();
        let m = MelVoc::load(read(file)).unwrap();
        let f = flow.map(|p| PitchFlow::load(&read(p)).unwrap());
        let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
        for text in [ssml::pieces(src).unwrap(), ssml::plain("Hi.").unwrap()] {
            let inf = Inflection::new(&mut ph, &text).unwrap();
            let pitch = match &f {
                Some(f) => Pitch::Flow(f, Sampling { seed: 5, ..Default::default() }),
                None => Pitch::Head,
            };
            let p = inflect::plan(&s, &inf, 0, 1.1, -1.0, pitch).unwrap();
            let mut mel = m.mel.forward(&p.hx, &p.lf0, &p.vuv, None).unwrap();
            p.edits.gain_mel(&mut mel, 0);
            let want = m.vocos.render(&mel).unwrap();
            assert_eq!(want.len(), (lipservice::melvoc::vocos_frames(p.lf0.len()) - 1) * 256);
            assert!(want.len() + 2 * HOP > p.lf0.len() * HOP);
            for step in [1, 2, 7, 50, 100000] {
                let mut st = Stream::inflected(&s, Render::mel(&m, None), &inf, 0, 1.1, -1.0, pitch, 5, None).unwrap();
                assert_eq!(st.durations(), &p.edits.durations[..]);
                let (mut got, mut first) = (Vec::new(), None);
                while !st.done() {
                    assert!(st.fed() < st.frames() || got.len() < want.len(), "stalled at {}", got.len());
                    st.step(step, &mut got);
                    if first.is_none() && !got.is_empty() {
                        first = Some(st.fed());
                    }
                }
                assert_eq!(st.pitch().0, &p.lf0[..]);
                assert_eq!(got.len(), want.len(), "{file} step {step}");
                let bad: Vec<usize> = (0..want.len()).filter(|&k| got[k].to_bits() != want[k].to_bits()).collect();
                assert!(bad.is_empty(), "{file} step {step}: {} samples differ, first {}", bad.len(), bad[0]);
                println!("{file} {flow:?} step {step}: {} samples, first audio after {:?} of {} frames", got.len(), first, st.frames());
            }
        }
    }
}

/// A voice with a decoder of its own speaks through it: the same samples, bit
/// for bit, as a route built with that decoder, and not the route's.
#[test]
fn voice_own_decoder() {
    use lipservice::front::Phonemizer;
    use lipservice::g2p::G2p;
    use lipservice::inflect::Inflection;
    use lipservice::lexicon::Lexicon;
    use lipservice::pitchflow::Sampling;
    use lipservice::score::Pitch;
    use lipservice::ssml;
    use lipservice::stream::{Render, Stream};
    use lipservice::voice::Voice;

    assert!(Voice::load(read("voice-a-i8.lsw"), None).unwrap().mel.is_none());
    let v = Voice::load(read("voice-a-mel.lsw"), None).unwrap();
    assert!(v.mel.is_some());
    let (route, h) = (MelVoc::load(read("melvoc-i8.lsw")).unwrap(), MelVoc::load(read("melvoc-h-i8.lsw")).unwrap());
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let inf = Inflection::new(&mut ph, &ssml::plain("Where the river bends, the willows lean low.").unwrap()).unwrap();
    let pitch = Pitch::Flow(v.flow.as_ref().unwrap(), Sampling { seed: 5, ..Default::default() });
    let say = |r: Render| {
        let mut st = Stream::inflected(&v.score, r, &inf, 0, 1.0, v.shift, pitch, 5, None).unwrap();
        let mut y = Vec::new();
        while !st.done() {
            st.step(20, &mut y);
        }
        y.iter().map(|x| x.to_bits()).collect::<Vec<u32>>()
    };
    let own = say(Render::mel(&route, v.mel.as_ref()));
    assert!(!own.is_empty());
    assert_eq!(own, say(Render::mel(&h, None)));
    assert_ne!(own, say(Render::mel(&route, None)));
}

/// An LSW1 file of f32 tensors.
fn lsw(tensors: &[(&str, Vec<usize>, Vec<f32>)]) -> Vec<u8> {
    let mut index = b"LSW1".to_vec();
    index.extend((tensors.len() as u32).to_le_bytes());
    let mut off = 0u64;
    let mut offsets = Vec::new();
    for (_, _, d) in tensors {
        offsets.push(off);
        off += (4 * d.len() as u64).div_ceil(64) * 64;
    }
    for ((n, s, _), o) in tensors.iter().zip(&offsets) {
        index.extend((n.len() as u16).to_le_bytes());
        index.extend(n.as_bytes());
        index.extend([0u8, s.len() as u8]);
        for &x in s {
            index.extend((x as u32).to_le_bytes());
        }
        index.extend(o.to_le_bytes());
    }
    let start = index.len().div_ceil(64) * 64;
    let mut b = index;
    b.resize(start + off as usize, 0);
    for ((_, _, d), o) in tensors.iter().zip(&offsets) {
        let at = start + *o as usize;
        for (k, v) in d.iter().enumerate() {
            b[at + 4 * k..at + 4 * k + 4].copy_from_slice(&v.to_le_bytes());
        }
    }
    b
}

/// The release channel: streamed the same, bit for bit, as the whole utterance; it changes the
/// audio; a bias is refused.
#[test]
fn release_stream_matches_whole() {
    use lipservice::front::Phonemizer;
    use lipservice::g2p::G2p;
    use lipservice::inflect::{self, Inflection};
    use lipservice::lexicon::Lexicon;
    use lipservice::release::Release;
    use lipservice::rng::Rng;
    use lipservice::score::{Pitch, ScoreModel};
    use lipservice::ssml;
    use lipservice::stream::{Render, Stream};

    let s = ScoreModel::load(&read("score-a.lsw")).unwrap();
    let m = MelVoc::load(read("melvoc.lsw")).unwrap();
    assert!(m.release.is_none());
    let d = read("melvoc.lsw").get("mel.dec_in.weight").unwrap().shape[0];
    let w: Vec<f32> = Rng::new(3).gaussian(d * 6).iter().map(|v| v * 0.5).collect();
    let rel = Release::load(&Weights::parse(&lsw(&[("emb.weight", vec![d, 2, 3], w.clone()), ("emb.bias", vec![d], vec![0.0; d])])).unwrap(), d).unwrap();
    assert!(Release::load(&Weights::parse(&lsw(&[("emb.weight", vec![d, 2, 3], w), ("emb.bias", vec![d], vec![0.1; d])])).unwrap(), d).is_err());
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let inf = Inflection::new(&mut ph, &ssml::plain("Get that cat back, now.").unwrap()).unwrap();
    let p = inflect::plan(&s, &inf, 0, 1.0, 0.0, Pitch::Head).unwrap();
    let told = Release::told(&inf.tokens, &p.edits.durations);
    assert!(told.iter().any(|&v| v > 0.0));
    let mut mel = m.mel.forward(&p.hx, &p.lf0, &p.vuv, Some((&rel, &told))).unwrap();
    let plain = m.mel.forward(&p.hx, &p.lf0, &p.vuv, None).unwrap();
    assert!(max_err(&mel, &plain) > 0.1);
    p.edits.gain_mel(&mut mel, 0);
    let want = m.vocos.render(&mel).unwrap();
    for step in [1, 3, 50, 100000] {
        let mut st = Stream::inflected(&s, Render::Mel(&m.mel, &m.vocos, None, Some(&rel)), &inf, 0, 1.0, 0.0, Pitch::Head, 5, None).unwrap();
        let mut got = Vec::new();
        while !st.done() {
            st.step(step, &mut got);
        }
        assert_eq!(got.len(), want.len(), "step {step}");
        assert!(got.iter().zip(&want).all(|(a, b)| a.to_bits() == b.to_bits()), "step {step}: the stream differs");
    }
}
