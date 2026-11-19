// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A speaker's pauses on the mel route (pause.rs): which frames take the loop, how, and the same
//! samples streamed as whole. testdata/voice-a-pause.lsw is voice-a-i8 with LJ Speech's pauses.

use lipservice::front::{symbol_id, BOS, EOS, SPACE};
use lipservice::melvoc::{MelVoc, N_MEL};
use lipservice::pause::{self, PauseBank, Pauses, CEIL, EASE, FROM, GATE, GROUP, LOOK, MIN, SHORT, SHORT_EASE};
use lipservice::voice::Voice;
use lipservice::weights::Weights;

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn voice() -> Voice {
    Voice::load(read("voice-a-pause.lsw"), None).unwrap()
}

#[test]
fn non_word_tokens_are_pauses() {
    let (ah, comma) = (symbol_id("AH0").unwrap(), symbol_id(",").unwrap());
    let tok = [BOS, ah, SPACE, ah, SPACE, comma, ah, EOS];
    let dur = [8, 9, 1, 3, 10, 2, 4, 12];
    let want: Vec<bool> = tok.iter().zip(dur).flat_map(|(&t, d)| std::iter::repeat_n(t != ah, d)).collect();
    assert_eq!(pause::pause_frames(&tok, &dur), want);
    assert!(Voice::load(read("voice-a-i8.lsw"), None).unwrap().pause.is_none());
}

fn ln(db: f32) -> f32 {
    db * std::f32::consts::LN_10 / 20.0
}

/// A row `db` over the gate, every band alike: not quiet.
fn loud_row(bank: &PauseBank, db: f32) -> Vec<f32> {
    vec![ln(bank.level() - GATE + db); N_MEL]
}

/// The row's groups from FROM up, dB over its level.
fn tilt(row: &[f32]) -> Vec<f32> {
    let lv = pause::level(row);
    row.chunks_exact(GROUP).skip(FROM).map(|g| pause::level(g) - lv).collect()
}

/// A loop frame within the ceilings, moved to `db` under the gate: quiet.
fn quiet_row(bank: &PauseBank, db: f32) -> Vec<f32> {
    let k = (0..bank.frames())
        .find(|&k| tilt(bank.row(k)).iter().zip(bank.ceilings()).all(|(t, c)| t < &(c - 0.1)))
        .expect("a loop frame within the ceilings");
    let r = bank.row(k);
    let by = ln(bank.level() - GATE - db - pause::level(r));
    r.iter().map(|x| x + by).collect()
}

#[test]
fn quiet_is_under_the_gate_and_no_brighter_than_the_loop() {
    let v = voice();
    let bank = v.pause.as_ref().unwrap();
    let c = bank.ceilings();
    assert_eq!(c.len(), N_MEL / GROUP - FROM);
    let tilts: Vec<Vec<f32>> = (0..bank.frames()).map(|k| tilt(bank.row(k))).collect();
    for (i, &c) in c.iter().enumerate() {
        let mut t: Vec<f32> = tilts.iter().map(|t| t[i]).collect();
        t.sort_by(f32::total_cmp);
        assert_eq!(c, t[(CEIL * (bank.frames() - 1) as f32).round() as usize], "group {}", FROM + i);
    }
    let q = quiet_row(bank, 1.0);
    assert!((pause::level(&q) - (bank.level() - GATE - 1.0)).abs() < 1e-3);
    assert!(bank.quiet(&q));
    assert!(!bank.quiet(&loud_row(bank, 1.0)));
    // a sibilant's tail: under the gate as a whole, the top group brighter than the loop's
    let mut r = quiet_row(bank, 30.0);
    let top = N_MEL / GROUP - 1;
    for x in &mut r[top * GROUP..] {
        *x += ln(20.0);
    }
    assert!(pause::level(&r) < bank.level() - GATE && tilt(&r)[top - FROM] > c[top - FROM], "not a quiet bright row");
    assert!(!bank.quiet(&r));
}

#[test]
fn quiet_runs_take_the_loop_eased() {
    let v = voice();
    let bank = v.pause.as_ref().unwrap();
    assert_eq!(bank.frames(), 2000);
    // pause frames 0..60, word frames 60..80, pause 80..120; quiet everywhere but 20..23 and
    // 100..120, so long runs 0..20, 23..60 and 80..100; then a short run of 5 at 125 and one of
    // MIN - 1 at 133, not taken.
    let t = 140;
    let mut pause = vec![true; t];
    pause[60..80].fill(false);
    pause[120..].fill(false);
    pause[125..130].fill(true);
    pause[133..133 + MIN - 1].fill(true);
    let quiet_at = |f: usize| pause[f] && !(20..23).contains(&f) && !(100..120).contains(&f);
    let mut mel = Vec::with_capacity(t * N_MEL);
    for f in 0..t {
        mel.extend(if quiet_at(f) { quiet_row(bank, 5.0) } else { loud_row(bank, 5.0) });
    }
    let raw = mel.clone();
    let mut p = Pauses::new(bank, pause.clone(), 9);
    p.see(&mel);
    p.apply(&mut mel, 0);
    let runs = [(0usize, 20usize), (23, 60), (80, 100), (125, 130)];
    assert!(runs.iter().all(|&(a, b)| (b - a < SHORT) == (a == 125)));
    let close = |g: &[f32], x: &[f32], y: &[f32], w: f32| g.iter().zip(x).zip(y).all(|((g, x), y)| (g - (x + w * (y - x))).abs() < 1e-5);
    for f in 0..t {
        let (got, was) = (&mel[f * N_MEL..(f + 1) * N_MEL], &raw[f * N_MEL..(f + 1) * N_MEL]);
        match runs.iter().find(|(a, b)| (*a..*b).contains(&f)) {
            None => assert_eq!(got, was, "frame {f} changed"),
            Some(&(a, b)) => {
                let ease = if b - a < SHORT { SHORT_EASE } else { EASE };
                let weight = |f: usize| ((f - a + 1).min(b - f) as f32 / (ease + 1) as f32).min(1.0);
                // the loop's frame: from the run's offset on, whichever offset it drew
                let k = (0..bank.frames())
                    .find(|&o| close(got, was, bank.row(o + f - a), weight(f)))
                    .unwrap_or_else(|| panic!("frame {f}: no loop frame at weight {}", weight(f)));
                if f > a {
                    let (prev, xp) = (&mel[(f - 1) * N_MEL..f * N_MEL], &raw[(f - 1) * N_MEL..f * N_MEL]);
                    assert!(close(prev, xp, bank.row(k + f - a - 1), weight(f - 1)), "frame {f}: not the loop's next frame");
                }
            }
        }
    }
    // another seed, another offset
    let mut other = raw.clone();
    let mut q = Pauses::new(bank, pause, 10);
    q.see(&other);
    q.apply(&mut other, 0);
    assert_ne!(other[30 * N_MEL..31 * N_MEL], mel[30 * N_MEL..31 * N_MEL]);
}

/// Fed a few frames at a time, settled LOOK behind, the same rows as whole.
#[test]
fn settled_in_pieces_as_whole() {
    let v = voice();
    let bank = v.pause.as_ref().unwrap();
    let t = 300;
    let pause: Vec<bool> = (0..t).map(|f| (f / 37) % 2 == 0).collect();
    let mut rng = 12345u64;
    let mut mel = Vec::with_capacity(t * N_MEL);
    for f in 0..t {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        mel.extend(if (rng >> 33) % 5 == 0 { loud_row(bank, 3.0) } else { quiet_row(bank, 3.0 + (f % 7) as f32) });
    }
    let mut want = mel.clone();
    let mut w = Pauses::new(bank, pause.clone(), 3);
    w.see(&want);
    w.apply(&mut want, 0);
    assert_ne!(want, mel);
    for step in [1, 2, 5, 6, 13, 300] {
        let mut p = Pauses::new(bank, pause.clone(), 3);
        let (mut got, mut seen) = (Vec::new(), 0);
        while got.len() < mel.len() {
            let to = (seen + step).min(t);
            p.see(&mel[seen * N_MEL..to * N_MEL]);
            seen = to;
            let ready = p.ready();
            assert!(ready == t || ready == seen.saturating_sub(LOOK), "step {step}: {ready} settled of {seen}");
            let from = got.len() / N_MEL;
            let mut rows = mel[from * N_MEL..ready * N_MEL].to_vec();
            p.apply(&mut rows, from);
            got.extend(rows);
        }
        assert_eq!(got, want, "step {step}");
    }
}

/// A voice with its speaker's pauses, streamed as whole, bit for bit; its quiet pauses changed and
/// nothing else.
#[test]
fn voice_pauses_stream_as_whole() {
    use lipservice::front::Phonemizer;
    use lipservice::g2p::G2p;
    use lipservice::inflect::{self, Inflection};
    use lipservice::lexicon::Lexicon;
    use lipservice::pitchflow::Sampling;
    use lipservice::score::Pitch;
    use lipservice::ssml;
    use lipservice::stream::{Render, Stream};

    let v = voice();
    let bank = v.pause.as_ref().unwrap();
    let m = MelVoc::load(read("melvoc-i8.lsw")).unwrap();
    let mut ph = Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap();
    let src = "<speak>Where the river bends, <break time=\"600ms\"/> the willows lean low. And then; nothing.</speak>";
    let inf = Inflection::new(&mut ph, &ssml::pieces(src).unwrap()).unwrap();
    let pitch = Pitch::Flow(v.flow.as_ref().unwrap(), Sampling { seed: 5, ..Default::default() });
    let p = inflect::plan(&v.score, &inf, 0, 1.0, v.shift, pitch).unwrap();
    let mut raw = m.mel.forward(&p.hx, &p.lf0, &p.vuv, None).unwrap();
    p.edits.gain_mel(&mut raw, 0);
    let mut mel = raw.clone();
    pause::whole(bank, &inf.tokens, &p.edits.durations, 5, &mut mel).unwrap();
    let pf = pause::pause_frames(&inf.tokens, &p.edits.durations);
    let changed: Vec<usize> = (0..pf.len()).filter(|&f| mel[f * N_MEL..(f + 1) * N_MEL] != raw[f * N_MEL..(f + 1) * N_MEL]).collect();
    assert!(changed.len() >= MIN, "{} frames changed", changed.len());
    for &f in &changed {
        assert!(pf[f], "frame {f} changed outside a pause");
        assert!(bank.quiet(&raw[f * N_MEL..(f + 1) * N_MEL]), "frame {f} changed, not quiet");
    }
    println!("{} of {} frames in pauses, {} took the loop", pf.iter().filter(|&&x| x).count(), pf.len(), changed.len());
    let want = m.vocos.render(&mel).unwrap();
    assert_ne!(want, m.vocos.render(&raw).unwrap());
    for step in [1, 2, 7, 50, 100000] {
        let mut st = Stream::inflected(&v.score, Render::mel(&m, None).with_pauses(Some(bank)), &inf, 0, 1.0, v.shift, pitch, 5, None).unwrap();
        let mut got = Vec::new();
        while !st.done() {
            assert!(st.fed() < st.frames() || got.len() < want.len(), "stalled at {}", got.len());
            st.step(step, &mut got);
        }
        assert_eq!(got.len(), want.len(), "step {step}");
        let bad = (0..want.len()).filter(|&k| got[k].to_bits() != want[k].to_bits()).count();
        assert_eq!(bad, 0, "step {step}: {bad} samples differ");
    }
}
