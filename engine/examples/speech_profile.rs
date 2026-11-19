// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Where speech's time goes, a stage at a time and inside a ConvNeXt block:
//!   cargo run --release --example speech_profile MODELS VOICE [REPS] [blocks]
//! MODELS holds voices/, bases/, melvoc.lsw, g2p.lsw, lexicon.lsw and breaks.lsw (the web's models).
use lipservice::breaks::Breaks;
use lipservice::front::Phonemizer;
use lipservice::g2p::G2p;
use lipservice::inflect::{self, Inflection};
use lipservice::lexicon::Lexicon;
use lipservice::melvoc::MelVoc;
use lipservice::nn::{gelu_slice, ConvNeXt, DwConv, LayerNorm, Linear};
use lipservice::passage::Passage;
use lipservice::pitchflow::Sampling;
use lipservice::score::Pitch;
use lipservice::ssml;
use lipservice::stream::Render;
use lipservice::voice::Voice;
use lipservice::weights::Weights;
use std::hint::black_box;
use std::time::Instant;

const TEXT: &str = "The old lighthouse keeper climbed the stairs each evening, counting the steps as his father had taught him, and at the top he lit the lamp that guided ships past the rocks.";

fn ms<T>(reps: usize, mut f: impl FnMut() -> T) -> f64 {
    black_box(f());
    let t = Instant::now();
    for _ in 0..reps {
        black_box(f());
    }
    t.elapsed().as_secs_f64() * 1e3 / reps as f64
}

/// A block's pieces on t rows: dw, norm, pw1, gelu, pw2, and the whole block.
fn block(ws: &Weights, prefix: &str, dim: usize, eps: f32, t: usize, reps: usize) {
    let dw = DwConv::load(ws, &format!("{prefix}.dw"), dim, 7).unwrap();
    let norm = LayerNorm::load_eps(ws, &format!("{prefix}.norm"), dim, eps).unwrap();
    let pw1 = Linear::load(ws, &format!("{prefix}.pw1"), dim * 3, dim).unwrap();
    let pw2 = Linear::load(ws, &format!("{prefix}.pw2"), dim, dim * 3).unwrap();
    let b = ConvNeXt::load_eps(ws, prefix, dim, 3, 7, eps).unwrap();
    let x: Vec<f32> = (0..t * dim).map(|i| ((i * 7919) % 1000) as f32 / 500.0 - 1.0).collect();
    let mut y = vec![0.0; t * dim];
    let mut h = vec![0.0; t * dim * 3];
    let a = ms(reps, || dw.forward(&x, t, &mut y));
    let mut z = y.clone();
    let n = ms(reps, || {
        z.copy_from_slice(&y);
        norm.forward(&mut z)
    });
    let p1 = ms(reps, || pw1.forward(&z, t, &mut h));
    let mut g = h.clone();
    let ge = ms(reps, || {
        g.copy_from_slice(&h);
        gelu_slice(&mut g)
    });
    let p2 = ms(reps, || pw2.forward(&g, t, &mut y));
    let mut xx = x.clone();
    let whole = ms(reps, || {
        xx.copy_from_slice(&x);
        b.forward(&mut xx, t)
    });
    let macs = (2 * 3 * dim * dim * t) as f64;
    println!(
        "  block {dim} x {t} rows: dw {a:.2}, norm {n:.2}, pw1 {p1:.2}, gelu {ge:.2}, pw2 {p2:.2}; whole {whole:.2} ms; {:.1} GMAC/s in pw1+pw2",
        macs / ((p1 + p2) * 1e6)
    );
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (m, name) = (&a[1], &a[2]);
    let reps: usize = a.get(3).map_or(5, |s| s.parse().unwrap());
    let mut ws = Weights::read(&format!("{m}/voices/{name}.lsw")).unwrap();
    if ws.needs_base() {
        ws = ws.on_base(&Weights::read(&format!("{m}/bases/score-l.lsw")).unwrap()).unwrap();
    }
    let v = Voice::load(ws, None).unwrap();
    let mv = MelVoc::load(Weights::read(&format!("{m}/melvoc.lsw")).unwrap()).unwrap();
    let mut ph = Phonemizer::new(
        Lexicon::load(&Weights::read(&format!("{m}/lexicon.lsw")).unwrap()).unwrap(),
        G2p::load(&Weights::read(&format!("{m}/g2p.lsw")).unwrap()).unwrap(),
    )
    .unwrap();
    let br = Breaks::load(&Weights::read(&format!("{m}/breaks.lsw")).unwrap()).unwrap();
    let pitch = match &v.flow {
        Some(f) => Pitch::Flow(f, Sampling::default()),
        None => Pitch::Head,
    };
    let pieces = ssml::plain(TEXT).unwrap();
    let text = ms(reps, || {
        let mut inf = Inflection::new(&mut ph, &pieces).unwrap();
        inf.phrase(&br, v.phrase.unwrap()).unwrap();
        inf
    });
    let mut inf = Inflection::new(&mut ph, &pieces).unwrap();
    inf.phrase(&br, v.phrase.unwrap()).unwrap();
    inf.pace = v.pace;
    let (s, sh) = (&v.score, v.shift);
    let enc = ms(reps, || s.encode(&inf.tokens, 0).unwrap());
    let h = s.encode(&inf.tokens, 0).unwrap();
    let ed = inf.edits(s, &h, 1.0).unwrap();
    let t: usize = ed.durations.iter().sum();
    let flow = match &v.flow {
        Some(f) => ms(reps, || f.sample(&h, &ed.durations, &Sampling::default()).unwrap()),
        None => ms(reps, || s.pitch(&s.expand(&h, &ed.durations), t)),
    };
    let p = inflect::plan(s, &inf, 0, 1.0, sh, pitch).unwrap();
    let dec = ms(reps, || mv.mel.forward(&p.hx, &p.lf0, &p.vuv, None).unwrap());
    let mel = mv.mel.forward(&p.hx, &p.lf0, &p.vuv, None).unwrap();
    let x = mv.vocos.input(&mel).unwrap();
    let n = x.len() / 100;
    let spec = ms(reps, || mv.vocos.spectrum(&x, n));
    let sp = mv.vocos.spectrum(&x, n);
    let ist = ms(reps, || mv.vocos.istft(&sp, n));
    let secs = t as f64 / 100.0;
    println!(
        "voice {name}: {t} frames ({secs:.2} s); text+breaks {text:.2}, encode {enc:.2}, {} {flow:.2}, mel decoder {dec:.2}, vocos net+head {spec:.2}, istft {ist:.2} ms",
        if v.flow.is_some() { "flow" } else { "pitch head" }
    );
    for step in [20usize, 100] {
        let mut run = || {
            let mut st = Passage::new(s, Render::mel(&mv, v.mel.as_ref()).with_pauses(v.pause.as_ref()), &mut ph, &pieces, 0, 1.0, sh, pitch, 0, None, Some((&br, v.phrase.unwrap())), v.pace).unwrap();
            let t0 = Instant::now();
            let (mut y, mut first) = (Vec::new(), None);
            while !st.done() {
                st.step(step, &mut y).unwrap();
                if first.is_none() && !y.is_empty() {
                    first = Some(t0.elapsed().as_secs_f64() * 1e3);
                }
            }
            (first.unwrap(), t0.elapsed().as_secs_f64() * 1e3, y.len())
        };
        let mut best = (f64::MAX, f64::MAX, 0);
        for _ in 0..reps {
            let r = run();
            if r.1 < best.1 {
                best = r;
            }
        }
        println!(
            "  stream, steps of {step}: first audio {:.1} ms, all {:.1} ms, {:.1}x real time",
            best.0,
            best.1,
            best.2 as f64 / 24000.0 / (best.1 / 1e3)
        );
    }
    if a.len() > 4 {
        let vw = Weights::read(&format!("{m}/voices/4446.lsw")).unwrap();
        let mut mw = Weights::read(&format!("{m}/melvoc.lsw")).unwrap();
        let (mel, voc) = (mw.split("mel."), mw.split("vocos."));
        let mut vw2 = vw;
        let fl = vw2.split("flow.");
        block(&fl, "blocks.blocks.0", 256, 1e-5, 200, reps * 4);
        block(&mel, "dec.blocks.0", 384, 1e-5, 200, reps * 4);
        block(&voc, "blocks.0", 512, 1e-6, 200, reps * 4);
        block(&fl, "blocks.blocks.0", 256, 1e-5, 20, reps * 40);
        block(&voc, "blocks.0", 512, 1e-6, 20, reps * 40);
    }
}
