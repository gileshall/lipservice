// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The latent voice's chain against PyTorch, and through the stream: testdata/vox{,-i8,-voice,
//! -voice-other,-base,-test,-test-i8}.lsw.

use lipservice::dsp::{Stft, HOP};
use lipservice::front::Phonemizer;
use lipservice::g2p::G2p;
use lipservice::lexicon::Lexicon;
use lipservice::pitchflow::Sampling;
use lipservice::score::Pitch;
use lipservice::sing::{self, Song, Style};
use lipservice::stream::{Render, Stream};
use lipservice::voice::Voice;
use lipservice::vox::{edit, hisses, Model, Noise, Phases, Plan, Vox, Wearer};
use lipservice::weights::Weights;
use std::rc::Rc;

fn snr_db(want: &[f32], got: &[f32]) -> f64 {
    assert_eq!(want.len(), got.len());
    let s: f64 = want.iter().map(|v| (*v as f64).powi(2)).sum();
    let e: f64 = want.iter().zip(got).map(|(a, b)| (*a as f64 - *b as f64).powi(2)).sum();
    10.0 * (s / e.max(1e-30)).log10()
}

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn ids(v: &[f32]) -> Vec<usize> {
    v.iter().map(|&x| x as usize).collect()
}

/// The model on the test voice's parts, its states taken as the encoder's the model reads.
fn on_states(model: &str) -> Vox {
    let m = read(model);
    let enc = Vox::reads(&m).unwrap();
    Vox::load(m, Wearer { parts: read("vox-voice.lsw").split("vox."), enc }).unwrap()
}

/// The page's voice with its parts of the latent voice, on its base.
fn voice() -> Voice {
    Voice::load(read("vox-voice.lsw").on_base(&read("vox-base.lsw")).unwrap(), None).unwrap()
}

/// Each stage on torch's inputs to it, then the whole chain from the noise, each SNR over its floor:
/// loudness, z, samples, edits, whole.
fn stages(model: &str, test: &str, floors: [f64; 5]) {
    let vox = on_states(model);
    let t = read(test);
    let get = |n: &str| t.get(n).unwrap().data.clone();
    let (h, dur) = (get("h"), ids(&get("dur")));
    let (lf0, vuv, gain, tilt) = (get("lf0"), get("vuv"), get("gain"), get("tilt"));
    let p = Plan { h: &h, dur: &dur, hiss: &[], close: &[], lf0: &lf0, told: &[], vuv: &vuv, gain: &gain, tilt: &tilt, breath: &[] };
    let noise = Noise { z: get("xz"), audio: get("nz"), loud: get("xl"), phases: Phases::of(0, 0) };
    let pass = |k: usize, want: &[f32], got: &[f32]| {
        let (what, s) = (["loudness", "z", "samples", "edits", "whole"][k], snr_db(want, got));
        println!("{model} {what} {s:.1} dB");
        assert!(s > floors[k], "{model} {what} {s:.1} dB");
    };
    pass(0, &get("loud"), &vox.loudness(&p, &noise.loud).unwrap());
    pass(1, &get("z"), &vox.code(&p, &get("loud"), &noise.z).unwrap());
    pass(2, &get("y"), &vox.generator().render(&get("z"), &lf0, &vuv, &noise.audio).unwrap());
    pass(3, &get("edited"), &edit(&Stft::new(), &get("y"), &gain, &tilt));
    pass(4, &get("edited"), &vox.render(&p, noise).unwrap());
}

#[test]
fn vox_matches_torch() {
    stages("vox.lsw", "vox-test.lsw", [70.0; 5]);
}

/// The int8 file against PyTorch's simulation of it; the draws' rounding differences add up over
/// their steps.
#[test]
fn vox_int8_matches_torch() {
    stages("vox-i8.lsw", "vox-test-i8.lsw", [45.0, 35.0, 40.0, 70.0, 28.0]);
}

/// A part rendered a stretch at a time is the part rendered whole, however it is cut and however
/// its pitch comes.
#[test]
fn vox_streams_what_it_renders() {
    for model in ["vox.lsw", "vox-i8.lsw"] {
        let vox = on_states(model);
        let t = read("vox-test.lsw");
        let get = |n: &str| t.get(n).unwrap().data.clone();
        let (h, dur) = (get("h"), ids(&get("dur")));
        let (lf0, vuv, gain, tilt) = (get("lf0"), get("vuv"), get("gain"), get("tilt"));
        let noise = Noise { z: get("xz"), audio: get("nz"), loud: get("xl"), phases: Phases::of(0, 0) };
        let told = hisses(&ids(&get("tok")));
        for (edits, hiss) in [(true, false), (false, false), (true, true)] {
            let (g, tl): (&[f32], &[f32]) = if edits { (&gain, &tilt) } else { (&[], &[]) };
            let hs: &[bool] = if hiss { &told } else { &[] };
            let p = Plan { h: &h, dur: &dur, hiss: hs, close: &[], lf0: &lf0, told: &[], vuv: &vuv, gain: g, tilt: tl, breath: &[] };
            let whole = vox.render(&p, noise.clone()).unwrap();
            assert_eq!(whole.len(), p.frames() * HOP);
            // (frames asked for at a time, pitch frames fed at a time)
            for (step, fed) in [(1, usize::MAX), (7, usize::MAX), (50, usize::MAX), (1, 1), (50, 13), (7, 100), (usize::MAX, 31)] {
                let (mut st, mut y) = (vox.begin(&h, &dur, g, tl, noise.clone()).unwrap(), Vec::new());
                if hiss {
                    st.hiss(hs).unwrap();
                }
                while st.done() < p.frames() {
                    let (a, b) = (st.fed(), st.fed().saturating_add(fed).min(p.frames()));
                    st.feed(&lf0[a..b], &vuv[a..b]);
                    y.extend(st.next(step));
                    assert!(y.len() <= st.done() * HOP);
                }
                assert!(y == whole, "{model}, edits {edits}, hiss {hiss}, {step} frames at a time, pitch {fed} at a time: {:.1} dB", snr_db(&whole, &y));
            }
        }
    }
}

/// The engine's int8 encoder makes the states the int8 chain was simulated on.
#[test]
fn vox_reads_the_voices_encoder() {
    let t = read("vox-test-i8.lsw");
    let got = voice().score.states(&ids(&t.get("tok").unwrap().data)).unwrap();
    let s = snr_db(&t.get("h").unwrap().data, &got);
    println!("states {s:.1} dB");
    assert!(s > 40.0, "{s:.1} dB");
}

/// Text to samples through the stream: the voice's own plan, rendered as it comes, is the plan
/// rendered whole.
#[test]
fn vox_speaks_through_the_stream() {
    let mut v = voice();
    let vox = Vox::load(read("vox-i8.lsw"), v.vox.take().unwrap()).unwrap();
    let tok = ids(&read("vox-test.lsw").get("tok").unwrap().data);
    for (rate, seed) in [(1.0, 0), (1.2, 5)] {
        let pitch = match &v.flow {
            Some(f) => Pitch::Flow(f, Sampling { seed, ..Default::default() }),
            None => Pitch::Head,
        };
        let sc = v.score.infer(&tok, 0, rate, v.shift, pitch).unwrap();
        let (h, t) = (v.score.states(&tok).unwrap(), sc.frames.len());
        let told = hisses(&tok);
        let p = Plan { h: &h, dur: &sc.durations, hiss: &told, close: &[], lf0: &sc.frames.lf0, told: &[], vuv: &sc.frames.vuv, gain: &[], tilt: &[], breath: &[] };
        let want = vox.render(&p, Noise::draw(seed, t, vox.zdim())).unwrap();
        for step in [1, 7, 50, 100000] {
            let mut st = Stream::new(&v.score, Render::Vox(&vox), &tok, 0, rate, v.shift, pitch, seed, None).unwrap();
            let (mut got, mut first) = (Vec::new(), None);
            while !st.done() {
                assert!(st.fed() < st.frames() || got.len() < want.len(), "stalled at {}", got.len());
                st.step(step, &mut got);
                if first.is_none() && !got.is_empty() {
                    first = Some(st.fed());
                }
            }
            assert!(got == want, "rate {rate} step {step}: {} and {} samples", got.len(), want.len());
            println!("rate {rate} step {step}: {} samples, first audio after {} of {t} frames", got.len(), first.unwrap());
        }
    }
}

/// A song through the stream is its plan rendered whole: the notes' pitch, the voicing the song
/// fixes and the pitch head's elsewhere, the dynamics as the plan's loudness and tilt, the breath on
/// the sung vowels alone.
#[test]
fn vox_sings_through_the_stream() {
    let mut v = voice();
    let vox = Vox::load(read("vox-i8.lsw"), v.vox.take().unwrap()).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = Song::parse("bpm 120\nrest 0.5\nrow D4:1\nthe F#4:0.5\nboat E4:1.5\nrest 1\nhome A4:2\nrest 1\n").unwrap();
    for (dynamics, breathiness, seed) in [(0.0, 1.0, 0), (1.0, 0.35, 4), (0.0, 0.35, 0)] {
        let st = Style { shift: 0.0, vibrato: 0.25, vibrato_hz: 5.5, vibrato_delay: 0.25, vibrato_ramp: 0.2, glide: 9, dynamics, consonants: 1.0, breathiness, diction: false, motion: None, motion_scale: 1.0, seed };
        let p = sing::plan(&v.score, &mut ph, &song, 0, &st).unwrap();
        let (vuv, _) = sing::voicing(&v.score, &v.score.expand(&p.h, &p.durations), &p);
        let (gain, tilt) = sing::loudness(&p.gain, &p.quiet);
        assert_eq!(tilt.is_empty(), dynamics == 0.0);
        let told = hisses(&p.tokens);
        let part = Plan { h: &p.states, dur: &p.durations, hiss: &told, close: &[], lf0: &p.lf0, told: &[], vuv: &vuv, gain: &gain, tilt: &tilt, breath: &p.breath };
        let want = vox.render(&part, Noise::draw(seed, part.frames(), vox.zdim())).unwrap();
        // the breath changes the sung vowels and nothing a window clear of them
        if breathiness != 1.0 {
            let plain = vox.render(&Plan { breath: &[], ..part }, Noise::draw(seed, part.frames(), vox.zdim())).unwrap();
            let (mut same, mut other) = (0, 0);
            for f in 0..part.frames() {
                let (a, b) = (&want[f * HOP..(f + 1) * HOP], &plain[f * HOP..(f + 1) * HOP]);
                if p.breath[f.saturating_sub(6)..(f + 7).min(part.frames())].iter().all(|k| *k == 1.0) {
                    assert!(a == b, "frame {f} changed off the sung vowels");
                    same += 1;
                } else if p.breath[f] < 0.5 {
                    assert!(a != b, "frame {f} of a sung vowel unchanged");
                    other += 1;
                }
            }
            assert!(same > 50 && other > 50, "{same} frames clear of the sung vowels, {other} in them");
        }
        // the rests are silent, once released into and clear of the notes' windows, and the last
        // one's silence lasts to the end
        let peak = |y: &[f32]| y.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let rests = p.rests();
        assert_eq!(rests.len(), 3);
        for (i, r) in rests.iter().enumerate() {
            assert!(r.len() > 16, "a rest of {} frames", r.len());
            let end = if i == 2 { part.frames() } else { r.end - 4 };
            let rest = peak(&want[(r.start + 12) * HOP..end * HOP]);
            assert!(rest < 1e-3 * peak(&want), "a rest peaks at {rest}, the song at {}", peak(&want));
        }
        for step in [1, 7, 50, 100000] {
            let p = sing::plan(&v.score, &mut ph, &song, 0, &st).unwrap();
            let mut s = Stream::sung(&v.score, Render::Vox(&vox), p, 0, None, seed, None).unwrap();
            let mut got = Vec::new();
            while !s.done() {
                assert!(s.fed() < s.frames() || got.len() < want.len(), "stalled at {}", got.len());
                s.step(step, &mut got);
            }
            assert!(got == want, "dynamics {dynamics} breathiness {breathiness} step {step}: {} and {} samples", got.len(), want.len());
        }
        println!("dynamics {dynamics} breathiness {breathiness}: {} samples", want.len());
    }
    let p = sing::plan(&v.score, &mut ph, &song, 0, &Style { shift: 0.0, vibrato: 0.25, vibrato_hz: 5.5, vibrato_delay: 0.25, vibrato_ramp: 0.2, glide: 9, dynamics: 0.0, consonants: 1.0, breathiness: 1.0, diction: false, motion: None, motion_scale: 1.0, seed: 0 }).unwrap();
    assert!(Stream::sung(&v.score, Render::Vox(&vox), p, 0, Some(3.0), 0, None).is_err());
}

/// A song picked up at a frame is the whole song's samples from there, bit for bit.
#[test]
fn vox_picks_a_song_up() {
    let mut v = voice();
    let vox = Vox::load(read("vox-i8.lsw"), v.vox.take().unwrap()).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let text = format!("bpm 120\n{}", "rest 0.5\nrow D4:1\nthe F#4:0.5\nboat E4:1.5+F#4:1\nrest 1\nhome A4:2\n".repeat(3));
    let song = Song::parse(&text).unwrap();
    for (dynamics, breathiness, seed) in [(0.0, 1.0, 0), (1.0, 0.35, 4)] {
        let st = Style { shift: 0.0, vibrato: 0.25, vibrato_hz: 5.5, vibrato_delay: 0.25, vibrato_ramp: 0.2, glide: 9, dynamics, consonants: 1.0, breathiness, diction: false, motion: None, motion_scale: 1.0, seed };
        let p = sing::plan(&v.score, &mut ph, &song, 0, &st).unwrap();
        let total = p.lf0.len();
        let mut s = Stream::sung(&v.score, Render::Vox(&vox), p.tail(0), 0, None, seed, None).unwrap();
        let mut want = Vec::new();
        while !s.done() {
            s.step(100000, &mut want);
        }
        assert_eq!(want.len(), total * HOP);
        let mut late = 0;
        for from in [0, 1, 60, total / 3, total / 2, total / 2 + 77, total - 40, total - 2, total] {
            for step in [1, 7, 100000] {
                let mut s = Stream::sung_from(&v.score, Render::Vox(&vox), &p, 0, None, seed, None, from).unwrap();
                let mut got = Vec::new();
                while !s.done() {
                    s.step(step, &mut got);
                }
                let b = s.base();
                assert!(b <= from && s.frames() == total - b);
                late += (b > 0) as usize;
                let w = &want[from * HOP..];
                assert_eq!(got.len(), w.len(), "from {from} step {step}");
                let bad: Vec<usize> = (0..w.len()).filter(|&k| got[k].to_bits() != w[k].to_bits()).collect();
                assert!(bad.is_empty(), "dynamics {dynamics} from {from} step {step} (base {b}): {} samples differ, {} to {} of {}", bad.len(), bad[0], bad[bad.len() - 1], w.len());
            }
        }
        assert!(late >= 9, "{late} streams started late");
        println!("dynamics {dynamics}: {total} frames, ahead {}", vox.ahead());
    }
}

/// A hiss's residual takes its drawn phases in the frames of the tokens that sing one, voiced or
/// not, and nowhere else (a voiced frame's from 2 kHz up alone), the same for a seed; and the song
/// is the same streamed, and picked up anywhere.
#[test]
fn vox_scatters_a_hiss() {
    let mut v = voice();
    let vox = Vox::load(read("vox-i8.lsw"), v.vox.take().unwrap()).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = Song::parse("bpm 100\nrest 0.5\nacross D4:1 G4:1.5\nthe G4:0.5\nsea A4:2\nrest 1\nships E4:1.5\npass D4:2\nrest 1\nwas G4:1\nchosen A4:1 G4:1\nrest 1\neasy G4:2 A4:2\nrest 1\n").unwrap();
    let st = Style { shift: 0.0, vibrato: 0.25, vibrato_hz: 5.5, vibrato_delay: 0.25, vibrato_ramp: 0.2, glide: 9, dynamics: 1.0, consonants: 1.0, breathiness: 1.0, diction: false, motion: None, motion_scale: 1.0, seed: 0 };
    let p = sing::plan(&v.score, &mut ph, &song, 0, &st).unwrap();
    let (vuv, _) = sing::voicing(&v.score, &v.score.expand(&p.h, &p.durations), &p);
    let (gain, tilt) = sing::loudness(&p.gain, &p.quiet);
    let told = hisses(&p.tokens);
    let symbols: Vec<&str> = p.tokens.iter().map(|t| lipservice::front::symbol(*t)).collect();
    for (i, s) in symbols.iter().enumerate() {
        let beside = |j: usize| matches!(symbols[j], "S" | "SH" | "Z" | "ZH" | "CH" | "JH");
        let want = beside(i) || (*s == " " && ((i > 0 && beside(i - 1)) || (i + 1 < symbols.len() && beside(i + 1))));
        assert_eq!(told[i], want, "token {i} ({s}) of {symbols:?}");
    }
    assert!(told.iter().filter(|t| **t).count() >= 6 && told.iter().any(|t| !*t), "{symbols:?}");
    assert!(symbols.contains(&"Z") && symbols.contains(&"CH"), "{symbols:?}");
    let total = p.lf0.len();
    let drawn: Vec<bool> = told.iter().zip(&p.durations).flat_map(|(t, d)| std::iter::repeat(*t).take(*d)).collect();
    assert!((0..total).any(|f| drawn[f] && vuv[f] >= 0.5) && (0..total).any(|f| drawn[f] && vuv[f] < 0.5), "a voiced hiss and an unvoiced one");
    let part = Plan { h: &p.states, dur: &p.durations, hiss: &told, close: &[], lf0: &p.lf0, told: &[], vuv: &vuv, gain: &gain, tilt: &tilt, breath: &p.breath };
    let seed = 3;
    let want = vox.render(&part, Noise::draw(seed, total, vox.zdim())).unwrap();
    assert!(want == vox.render(&part, Noise::draw(seed, total, vox.zdim())).unwrap(), "a seed's song twice");
    let plain = vox.render(&Plan { hiss: &[], ..part }, Noise::draw(seed, total, vox.zdim())).unwrap();
    // a frame's window and the edits' after it reach 5 frames either side
    let (mut same, mut other) = (0, 0);
    for f in 0..total {
        let (a, b) = (&want[f * HOP..(f + 1) * HOP], &plain[f * HOP..(f + 1) * HOP]);
        if !drawn[f.saturating_sub(6)..(f + 7).min(total)].iter().any(|d| *d) {
            assert!(a == b, "frame {f} changed off the hisses");
            same += 1;
        } else if drawn[f] {
            assert!(a != b, "frame {f} of a hiss unchanged");
            other += 1;
        }
    }
    assert!(same > 100 && other >= 12, "{same} frames clear of the hisses, {other} in them");
    // a voiced hiss clear of an unvoiced one keeps the model's own sound under 2 kHz
    let band = |d: &[f32], bins: std::ops::Range<usize>| -> f64 {
        bins.map(|k| {
            let (mut re, mut im) = (0.0f64, 0.0f64);
            for (j, x) in d.iter().enumerate() {
                let w = 0.5 - 0.5 * (std::f64::consts::TAU * j as f64 / d.len() as f64).cos();
                let a = std::f64::consts::TAU * (k * j) as f64 / d.len() as f64;
                re += w * *x as f64 * a.cos();
                im -= w * *x as f64 * a.sin();
            }
            re * re + im * im
        })
        .sum()
    };
    let mut voiced = 0;
    for f in 3..total - 3 {
        if !(drawn[f] && vuv[f] >= 0.5) || (f.saturating_sub(6)..(f + 7).min(total)).any(|g| drawn[g] && vuv[g] < 0.5) {
            continue;
        }
        let d: Vec<f32> = (f * HOP - 512..f * HOP + 512).map(|k| want[k] - plain[k]).collect();
        // 1.5 kHz down, and 2 kHz up
        let (low, high) = (band(&d, 1..64), band(&d, 86..513));
        assert!(high > 0.0 && low < 1e-6 * high, "frame {f}: {low:e} under 1.5 kHz, {high:e} over 2 kHz");
        voiced += 1;
    }
    assert!(voiced >= 4, "{voiced} voiced frames of a hiss clear of an unvoiced one");
    let other_seed = vox.render(&part, Noise::draw(seed + 1, total, vox.zdim())).unwrap();
    assert!(other_seed != want);
    for step in [1, 7, 100000] {
        let mut s = Stream::sung(&v.score, Render::Vox(&vox), p.tail(0), 0, None, seed, None).unwrap();
        let mut got = Vec::new();
        while !s.done() {
            s.step(step, &mut got);
        }
        assert!(got == want, "step {step}: {} and {} samples", got.len(), want.len());
    }
    // picked up in and about every hiss, and in the space after one
    let edges: Vec<usize> = (1..total).filter(|f| drawn[*f] != drawn[*f - 1]).collect();
    assert!(edges.len() >= 4, "{edges:?}");
    let mut late = 0;
    for from in edges.iter().flat_map(|e| [e.saturating_sub(3), *e, (*e + 2).min(total)]) {
        let mut s = Stream::sung_from(&v.score, Render::Vox(&vox), &p, 0, None, seed, None, from).unwrap();
        let mut got = Vec::new();
        while !s.done() {
            s.step(7, &mut got);
        }
        late += (s.base() > 0) as usize;
        let w = &want[from * HOP..];
        let bad = (0..w.len()).filter(|&k| got[k].to_bits() != w[k].to_bits()).count();
        assert!(got.len() == w.len() && bad == 0, "from {from} (base {}): {bad} samples of {} differ", s.base(), w.len());
    }
    assert!(late >= 4, "{late} streams started late");
    println!("{total} frames, {other} drawn ({voiced} voiced and clear), {} edges", edges.len());
}

/// The loudness model and the prior are told the pitch a plan tells them, the generator sings the
/// plan's own; over 540 Hz the prior alone is told the octave below.
#[test]
fn vox_tells_a_pitch_it_does_not_sing() {
    let vox = on_states("vox-i8.lsw");
    let t = read("vox-test-i8.lsw");
    let get = |n: &str| t.get(n).unwrap().data.clone();
    let (h, dur) = (get("h"), ids(&get("dur")));
    let (lf0, vuv, gain, tilt) = (get("lf0"), get("vuv"), get("gain"), get("tilt"));
    let noise = Noise { z: get("xz"), audio: get("nz"), loud: get("xl"), phases: Phases::of(0, 0) };
    let n = lf0.len();
    let of = |lf0: &[f32], told: &[f32]| vox.render(&Plan { h: &h, dur: &dur, hiss: &[], close: &[], lf0, told, vuv: &vuv, gain: &gain, tilt: &tilt, breath: &[] }, noise.clone()).unwrap();
    // each stage on its own, the generator on the pitch `sung`, the others on `told`
    let staged = |sung: &[f32], told: &[f32]| {
        let p = Plan { h: &h, dur: &dur, hiss: &[], close: &[], lf0: told, told: &[], vuv: &vuv, gain: &gain, tilt: &tilt, breath: &[] };
        let loud = vox.loudness(&p, &noise.loud).unwrap();
        let z = vox.code(&p, &loud, &noise.z).unwrap();
        edit(&Stft::new(), &vox.generator().render(&z, sung, &vuv, &noise.audio).unwrap(), &gain, &tilt)
    };
    let plain = of(&lf0, &[]);
    assert!(lf0.iter().all(|l| l.exp() < 540.0), "the test plan's pitch reaches {:.0} Hz", lf0.iter().fold(0.0f32, |m, l| m.max(l.exp())));
    assert!(plain == of(&lf0, &lf0), "told the pitch sung");
    assert!(plain == staged(&lf0, &lf0), "{:.1} dB", snr_db(&plain, &staged(&lf0, &lf0)));
    // a dip told and not sung
    let (a, b) = (n / 2, n / 2 + 12);
    let told: Vec<f32> = (0..n).map(|f| if (a..b).contains(&f) { lf0[f] - 0.12 } else { lf0[f] }).collect();
    let dipped = of(&lf0, &told);
    assert!(dipped != plain && dipped != of(&told, &[]));
    assert!(dipped == staged(&lf0, &told), "{:.1} dB", snr_db(&dipped, &staged(&lf0, &told)));
    for (step, fed) in [(1, usize::MAX), (7, 13), (usize::MAX, 31)] {
        let (mut st, mut y) = (vox.begin(&h, &dur, &gain, &tilt, noise.clone()).unwrap(), Vec::new());
        while st.done() < n {
            let (i, j) = (st.fed(), st.fed().saturating_add(fed).min(n));
            st.feed_told(&lf0[i..j], &told[i..j], &vuv[i..j]);
            y.extend(st.next(step));
        }
        assert!(y == dipped, "{step} frames at a time, pitch {fed} at a time");
    }
    // In C#5 to D#5 the prior is told the octave below, a note one way through its vibrato; under
    // and over the band it is told the pitch as it is. The loudness model is told it as it is.
    let octave = std::f32::consts::LN_2;
    let note = |hz: f32, f: usize| (hz * 2f32.powf(0.5 / 12.0 * (std::f32::consts::TAU * 5.5 * f as f32 / 100.0).sin())).ln();
    let held = |hz: f32| -> Vec<f32> { (0..n).map(|f| note(hz, f)).collect() };
    let below = |p: &[f32]| -> Vec<f32> { p.iter().map(|l| l - octave).collect() };
    let stages = |pitch: &[f32]| {
        let p = Plan { h: &h, dur: &dur, hiss: &[], close: &[], lf0: pitch, told: &[], vuv: &vuv, gain: &gain, tilt: &tilt, breath: &[] };
        let loud = vox.loudness(&p, &noise.loud).unwrap();
        (loud.clone(), vox.code(&p, &loud, &noise.z).unwrap())
    };
    let z_at = |pitch: &[f32], loud: &[f32]| vox.code(&Plan { h: &h, dur: &dur, hiss: &[], close: &[], lf0: pitch, told: &[], vuv: &vuv, gain: &gain, tilt: &tilt, breath: &[] }, loud, &noise.z).unwrap();
    for (name, hz, folds) in [("C5", 523.25, false), ("C#5", 554.37, true), ("D5", 587.33, true), ("D#5", 622.25, true), ("E5", 659.26, false), ("G5", 783.99, false)] {
        let p = held(hz);
        let (lo, hi) = (p.iter().fold(f32::MAX, |m, l| m.min(l.exp())), p.iter().fold(0.0f32, |m, l| m.max(l.exp())));
        let (loud, z) = stages(&p);
        assert!(loud != stages(&below(&p)).0, "{name}: the loudness model told the octave below");
        // the octave below is outside the band, told as it is
        assert_eq!(z == z_at(&below(&p), &loud), folds, "{name} ({lo:.0} to {hi:.0} Hz)");
        let want = edit(&Stft::new(), &vox.generator().render(&z, &p, &vuv, &noise.audio).unwrap(), &gain, &tilt);
        assert!(of(&p, &[]) == want, "{name}: {:.1} dB", snr_db(&want, &of(&p, &[])));
    }
    // a close vowel in the band is told its pitch as it is: every token one, the octave below is
    // not told at all; one token, its frames alone are told as sung, whole and in steps
    let d5 = held(587.33);
    let coded = |close: &[bool], told: &[f32], loud: &[f32]| vox.code(&Plan { h: &h, dur: &dur, hiss: &[], close, lf0: told, told: &[], vuv: &vuv, gain: &gain, tilt: &tilt, breath: &[] }, loud, &noise.z).unwrap();
    let (loud, folded) = stages(&d5);
    let every = vec![true; dur.len()];
    assert!(coded(&every, &d5, &loud) != folded && coded(&vec![false; dur.len()], &d5, &loud) == folded);
    let k = (0..dur.len()).max_by_key(|&i| dur[i]).unwrap();
    let (a, b) = (dur[..k].iter().sum::<usize>(), dur[..=k].iter().sum::<usize>());
    let one: Vec<bool> = (0..dur.len()).map(|i| i == k).collect();
    // what the prior is then told, given outright: the octave below but in that token's frames
    let mixed: Vec<f32> = (0..n).map(|f| if (a..b).contains(&f) { d5[f] } else { d5[f] - octave }).collect();
    let z = coded(&one, &d5, &loud);
    assert!(z == coded(&one, &mixed, &loud) && z != folded && z != coded(&every, &d5, &loud) && z != z_at(&mixed, &loud));
    let p = Plan { h: &h, dur: &dur, hiss: &[], close: &one, lf0: &d5, told: &[], vuv: &vuv, gain: &gain, tilt: &tilt, breath: &[] };
    let want = edit(&Stft::new(), &vox.generator().render(&z, &d5, &vuv, &noise.audio).unwrap(), &gain, &tilt);
    assert!(vox.render(&p, noise.clone()).unwrap() == want);
    for step in [1, 7] {
        let mut st = vox.begin(&h, &dur, &gain, &tilt, noise.clone()).unwrap();
        st.close(&one).unwrap();
        let mut got = Vec::new();
        for c in d5.chunks(step).zip(vuv.chunks(step)) {
            st.feed(c.0, c.1);
            got.extend(st.next(step));
        }
        got.extend(st.next(n));
        assert!(got == want, "a close vowel in steps of {step}");
    }
    // a C#5's vibrato crosses the band's edge and a D#5's comes near its top
    assert!(held(554.37).iter().any(|l| l.exp() < 540.0) && held(622.25).iter().any(|l| l.exp() > 639.0));
    // through the band and out of it, however the part is cut and its pitch comes
    let scale: Vec<f32> = (0..n).map(|f| note([523.25, 587.33, 659.26, 554.37][(4 * f / n).min(3)], f)).collect();
    let whole = of(&scale, &[]);
    assert!(whole != of(&below(&scale), &[]));
    for (step, fed) in [(1, usize::MAX), (1, 1), (7, 13), (50, 9), (usize::MAX, 31)] {
        let (mut st, mut y) = (vox.begin(&h, &dur, &gain, &tilt, noise.clone()).unwrap(), Vec::new());
        while st.done() < n {
            let (i, j) = (st.fed(), st.fed().saturating_add(fed).min(n));
            st.feed(&scale[i..j], &vuv[i..j]);
            y.extend(st.next(step));
        }
        assert!(y == whole, "{step} frames at a time, pitch {fed} at a time: {:.1} dB", snr_db(&whole, &y));
    }
    println!("{n} frames");
}

/// A song with notes in the band the prior is told an octave below in, and either side of it,
/// picked up at a frame, is the whole song's samples from there, bit for bit.
#[test]
fn vox_picks_up_a_song_in_the_band() {
    let mut v = voice();
    let vox = Vox::load(read("vox-i8.lsw"), v.vox.take().unwrap()).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let text = format!("bpm 120\n{}", "rest 0.5\nrow C5:1\nthe C#5:0.5\nboat D5:1.5+E5:1\nrest 1\nhome D#5:1+F5:1\nrow D5:2\n".repeat(3));
    let song = Song::parse(&text).unwrap();
    let st = Style { shift: 0.0, vibrato: 0.5, vibrato_hz: 5.5, vibrato_delay: 0.1, vibrato_ramp: 0.1, glide: 9, dynamics: 1.0, consonants: 1.0, breathiness: 1.0, diction: false, motion: None, motion_scale: 1.0, seed: 1 };
    let p = sing::plan(&v.score, &mut ph, &song, 0, &st).unwrap();
    let total = p.lf0.len();
    let in_band = |l: f32| l.exp() > 540.0 && l.exp() <= 640.0;
    let edges: Vec<usize> = (1..total).filter(|f| in_band(p.lf0[*f]) != in_band(p.lf0[*f - 1])).collect();
    assert!(edges.len() >= 12, "the pitch crosses the band's edges at {edges:?}");
    let mut s = Stream::sung(&v.score, Render::Vox(&vox), p.tail(0), 0, None, 3, None).unwrap();
    let mut want = Vec::new();
    while !s.done() {
        s.step(100000, &mut want);
    }
    // how far before a frame a stream picked up there starts
    let past = total - Stream::sung_from(&v.score, Render::Vox(&vox), &p, 0, None, 3, None, total).unwrap().base();
    // picked up so that the stream's own first frames lie about each of the band's edges, and so
    // that the first frame asked for does
    let froms: Vec<usize> = edges.iter().filter(|e| **e + past + 12 < total).flat_map(|e| [e + past - 9, e + past, e + past + 7]).chain(edges.iter().filter(|e| **e > past + 12).take(6).flat_map(|e| [e - 4, e + 6])).collect();
    assert!(froms.len() >= 12, "{} pick-ups; the edges at {edges:?}, a stream starts {past} frames before", froms.len());
    for &from in &froms {
        let mut s = Stream::sung_from(&v.score, Render::Vox(&vox), &p, 0, None, 3, None, from).unwrap();
        assert!(s.base() > 0 && s.base() == from - past);
        let mut got = Vec::new();
        while !s.done() {
            s.step(31, &mut got);
        }
        let w = &want[from * HOP..];
        let bad = (0..w.len().min(got.len())).filter(|&k| got[k].to_bits() != w[k].to_bits()).count();
        assert!(got.len() == w.len() && bad == 0, "from {from} (base {}): {bad} samples of {} differ", s.base(), w.len());
    }
    println!("{total} frames, {} edges of the band, {} pick-ups, each starting {past} frames before", edges.len(), froms.len());
}

/// A song's told pitch goes through the stream as through the plan rendered whole, and a pick-up.
#[test]
fn vox_sings_a_told_pitch_through_the_stream() {
    let mut v = voice();
    let vox = Vox::load(read("vox-i8.lsw"), v.vox.take().unwrap()).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let song = Song::parse("bpm 120\nrest 0.5\nrow D4:1\nthe F#4:0.5\nboat E4:1.5\nrest 1\nhome A4:2\nrest 1\n").unwrap();
    let st = Style { shift: 0.0, vibrato: 0.25, vibrato_hz: 5.5, vibrato_delay: 0.25, vibrato_ramp: 0.2, glide: 9, dynamics: 1.0, consonants: 1.0, breathiness: 0.35, diction: false, motion: None, motion_scale: 1.0, seed: 2 };
    let mut p = sing::plan(&v.score, &mut ph, &song, 0, &st).unwrap();
    assert!(p.told.is_empty());
    let total = p.lf0.len();
    let plain = {
        let mut s = Stream::sung(&v.score, Render::Vox(&vox), p.tail(0), 0, None, 2, None).unwrap();
        let mut y = Vec::new();
        while !s.done() {
            s.step(100000, &mut y);
        }
        y
    };
    // a dip every 50 frames, told and not sung
    p.told = p.lf0.iter().enumerate().map(|(f, l)| if f % 50 < 8 { l - 0.1 } else { *l }).collect();
    let (vuv, _) = sing::voicing(&v.score, &v.score.expand(&p.h, &p.durations), &p);
    let (gain, tilt) = sing::loudness(&p.gain, &p.quiet);
    let told = hisses(&p.tokens);
    let part = Plan { h: &p.states, dur: &p.durations, hiss: &told, close: &[], lf0: &p.lf0, told: &p.told, vuv: &vuv, gain: &gain, tilt: &tilt, breath: &p.breath };
    let want = vox.render(&part, Noise::draw(2, total, vox.zdim())).unwrap();
    assert!(want != plain);
    for step in [1, 7, 100000] {
        let mut s = Stream::sung(&v.score, Render::Vox(&vox), p.tail(0), 0, None, 2, None).unwrap();
        let mut got = Vec::new();
        while !s.done() {
            s.step(step, &mut got);
        }
        assert!(got == want, "step {step}: {} and {} samples", got.len(), want.len());
    }
    for from in [1, 60, total / 2, total / 2 + 77, total - 40] {
        let mut s = Stream::sung_from(&v.score, Render::Vox(&vox), &p, 0, None, 2, None, from).unwrap();
        let mut got = Vec::new();
        while !s.done() {
            s.step(7, &mut got);
        }
        assert!(got[..] == want[from * HOP..], "from {from} (base {})", s.base());
    }
    p.told.pop();
    assert!(Stream::sung(&v.score, Render::Vox(&vox), p, 0, None, 2, None).is_err());
}

/// Voices wear one loading of the models, each as it wears its own.
#[test]
fn vox_voices_share_the_models() {
    let model = Rc::new(Model::load(read("vox-i8.lsw")).unwrap());
    let t = read("vox-test-i8.lsw");
    let get = |n: &str| t.get(n).unwrap().data.clone();
    let (h, dur, lf0, vuv) = (get("h"), ids(&get("dur")), get("lf0"), get("vuv"));
    let p = Plan { h: &h, dur: &dur, hiss: &[], close: &[], lf0: &lf0, told: &[], vuv: &vuv, gain: &[], tilt: &[], breath: &[] };
    let noise = Noise { z: get("xz"), audio: get("nz"), loud: get("xl"), phases: Phases::of(0, 0) };
    let want = on_states("vox-i8.lsw").render(&p, noise.clone()).unwrap();
    let wearer = || Wearer { parts: read("vox-voice.lsw").split("vox."), enc: Vox::reads(&read("vox-i8.lsw")).unwrap() };
    let (a, b) = (Vox::wear(&model, wearer()).unwrap(), Vox::wear(&model, wearer()).unwrap());
    assert_eq!(Rc::strong_count(&model), 3);
    assert!(a.render(&p, noise.clone()).unwrap() == want && b.render(&p, noise).unwrap() == want);
    let other = Wearer { parts: read("vox-voice-other.lsw").split("vox."), enc: Vox::reads(&read("vox-i8.lsw")).unwrap() };
    assert!(Vox::wear(&model, other).is_err());
}

/// A voice fitted for another prior of the same shape is refused, and so is a model that reads
/// another text encoder than the voice's.
#[test]
fn vox_refuses_what_it_was_not_fitted_for() {
    let m = read("vox.lsw");
    let enc = Vox::reads(&m).unwrap();
    let e = Vox::load(m, Wearer { parts: read("vox-voice-other.lsw").split("vox."), enc }).err().expect("refused");
    assert!(e.0.contains("fitted for another model"), "{}", e.0);
    // the float chain reads the float encoder; the page's voice has it in int8
    let e = Vox::load(read("vox.lsw"), voice().vox.unwrap()).err().expect("refused");
    assert!(e.0.contains("reads the states of text encoder"), "{}", e.0);
}
