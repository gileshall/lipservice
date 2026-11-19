// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Inflection: SSML's asks as edits to the score, the same streamed as whole.

use lipservice::dsp::HOP;
use lipservice::front::{self, Phonemizer};
use lipservice::g2p::G2p;
use lipservice::inflect::{self, Inflection};
use lipservice::lexicon::Lexicon;
use lipservice::melvoc::N_MEL;
use lipservice::pitchflow::{PitchFlow, Sampling, Widen, WIDEN};
use lipservice::rng::Rng;
use lipservice::score::{semitones, Pitch, Score, ScoreModel};
use lipservice::sharpen::Sharpen;
use lipservice::ssml;
use lipservice::stream::{Render, Stream};
use lipservice::vocoder::{Vocoder, LF0_MU, LF0_SD, N_ENV};
use lipservice::weights::Weights;

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn phonemizer() -> Phonemizer {
    Phonemizer::new(
        Lexicon::load(&read("lexicon.lsw")).unwrap(),
        G2p::load(&read("g2p-i8.lsw")).unwrap(),
    )
    .unwrap()
}

fn st(lf0: f32) -> f32 {
    lf0 * 12.0 / std::f32::consts::LN_2
}

/// SSML's asks on the model's own reading, LEXICAL's edits off (lexical_words_said_as_readers_do).
fn said(m: &ScoreModel, ph: &mut Phonemizer, src: &str) -> (Inflection, Score) {
    let mut inf = Inflection::new(ph, &ssml::pieces(src).unwrap()).unwrap();
    inf.lexical = 0.0;
    let (s, ed) = inflect::infer(m, &inf, 0, 1.0, 0.0, Pitch::Head).unwrap();
    let mut s = s;
    ed.gain(&mut s.frames.env, 0);
    (inf, s)
}

/// The model's own log F0 on the inflection's durations, before any pitch edit.
fn raw(m: &ScoreModel, inf: &Inflection) -> Vec<f32> {
    let h = m.encode(&inf.tokens, 0).unwrap();
    let ed = inf.edits(m, &h, 1.0).unwrap();
    let t = ed.durations.iter().sum();
    let (p, _) = m.pitch(&m.expand(&h, &ed.durations), t);
    p.iter().map(|v| v * LF0_SD + LF0_MU).collect()
}

fn close(a: f32, b: f32, what: &str) {
    assert!((a - b).abs() < 1e-4, "{what}: {a} against {b}");
}

/// Frames where each token starts, and the end.
fn starts(d: &[usize]) -> Vec<usize> {
    let mut at = vec![0];
    for &k in d {
        at.push(at.last().unwrap() + k);
    }
    at
}

/// Token index of the n-th occurrence of a phone.
fn find(tok: &[usize], sym: &str, n: usize) -> usize {
    tok.iter()
        .enumerate()
        .filter(|(_, &t)| front::symbol(t) == sym)
        .nth(n)
        .unwrap()
        .0
}

#[test]
fn plain_text_is_the_score_but_its_pauses() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let rate = 1.3;
    // the least frames at each stop inside, at rate 1: a comma's 16.5 + 6.7 ln(words before) +
    // 6.2 ln(words after); a semicolon's or colon's 55, a full stop's 80; a question's none; an
    // exclamation's own edits off (exclamations_rise_on_their_nucleus_and_hold_their_end_up)
    let comma = |b: f32, a: f32| 16.5 + 6.7 * b.ln() + 6.2 * a.ln();
    for (text, least) in [
        ("Where are you going?", vec![]),
        ("Plain words change nothing, not one frame.", vec![comma(4.0, 3.0)]),
        ("Hi; there: one!", vec![55.0, 55.0]),
        ("One, two, three, four.", vec![comma(1.0, 1.0); 3]),
        ("Yes, I know. Do you? I do, now.", vec![comma(1.0, 2.0), 80.0, comma(2.0, 1.0)]),
    ] {
        let mut inf = Inflection::new(&mut ph, &ssml::plain(text).unwrap()).unwrap();
        inf.exclaim = 0.0;
        inf.lexical = 0.0;
        let tok = ph.encode(text).unwrap();
        assert_eq!(inf.tokens, tok);
        let (s, ed) = inflect::infer(&m, &inf, 0, rate, 2.0, Pitch::Head).unwrap();
        assert!(ed.gain.is_empty());
        let want = m.infer(&tok, 0, rate, 2.0, Pitch::Head).unwrap();
        let stops: Vec<usize> = (1..tok.len() - 1)
            .filter(|&i| front::STOPS.contains(&front::symbol(tok[i])) && front::symbol(tok[i + 1]) == " ")
            .collect();
        let mut k = 0;
        for i in 0..tok.len() {
            if i > 0 && stops.contains(&(i - 1)) {
                continue;
            }
            assert_eq!(s.durations[i], want.durations[i], "{text}: token {i}");
            if stops.contains(&i) {
                let have = want.durations[i] + want.durations[i + 1];
                let got = s.durations[i] + s.durations[i + 1];
                match front::symbol(tok[i]) {
                    "?" | "!" => assert_eq!(got, have, "{text}: token {i}"),
                    _ => {
                        let l = (least[k] / rate).round() as usize;
                        assert_eq!(got, have.max(l), "{text}: token {i}, least {l}");
                        k += 1;
                    }
                }
            }
        }
        assert_eq!(k, least.len(), "{text}");
        if s.durations == want.durations {
            assert_eq!(s.frames.lf0, want.frames.lf0);
            assert_eq!(s.frames.env, want.frames.env);
            assert_eq!(s.frames.bap, want.frames.bap);
        }
    }
    // with no stop inside, the score as it was
    let text = "Where are you going?";
    let inf = Inflection::new(&mut ph, &ssml::plain(text).unwrap()).unwrap();
    let (s, _) = inflect::infer(&m, &inf, 0, rate, 2.0, Pitch::Head).unwrap();
    let want = m.infer(&ph.encode(text).unwrap(), 0, rate, 2.0, Pitch::Head).unwrap();
    assert_eq!(s.durations, want.durations);
    assert_eq!(s.frames.env, want.frames.env);
}

#[test]
fn a_comma_pauses_as_readers_do() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let mut pause = |src: &str| {
        let (inf, s) = said(&m, &mut ph, src);
        let c = find(&inf.tokens, ",", 0);
        s.durations[c] + s.durations[c + 1]
    };
    // at least the readers' mean, more after a longer phrase: 1 word and 2, 6 and 6
    let least = |b: f32, a: f32| (16.5 + 6.7 * b.ln() + 6.2 * a.ln()).round() as usize;
    let short = pause("<speak>Yes, I know.</speak>");
    let long = pause("<speak>When the long rain finally stopped, we all went outside to play.</speak>");
    assert!(short >= least(1.0, 2.0), "{short}");
    assert!(long >= least(6.0, 6.0), "{long}");
    assert!(least(6.0, 6.0) > least(1.0, 2.0) + 15);
    // a break asked there is the whole pause, however short
    assert_eq!(pause("<speak>Yes,<break time=\"50ms\"/> I know.</speak>"), 5);
    // a slower word's stop, a slower pause
    let slow = pause("<speak><prosody rate=\"50%\">Yes,</prosody> I know.</speak>");
    assert!(slow >= 2 * least(1.0, 2.0) - 1, "{slow}");
}

#[test]
fn rate_and_breaks() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    // the same tokens both ways: a break where no stop is takes a comma, which the encoder sees
    let (_, plain) = said(
        &m,
        &mut ph,
        "<speak>one two three<break time=\"730ms\"/></speak>",
    );
    let (inf, slow) = said(
        &m,
        &mut ph,
        "<speak>one <prosody rate=\"50%\">two</prosody> three<break time=\"730ms\"/></speak>",
    );
    // two: T UW1
    let t = find(&inf.tokens, "UW1", 0);
    for i in [t - 1, t] {
        let (a, b) = (plain.durations[i] as f32, slow.durations[i] as f32);
        assert!((b - 2.0 * a).abs() <= 1.0, "token {i}: {a} to {b}");
    }
    assert_eq!(&plain.durations[..t - 1], &slow.durations[..t - 1]);
    let n = inf.tokens.len();
    assert_eq!(front::symbol(inf.tokens[n - 2]), ",");
    assert_eq!(slow.durations[n - 2] + slow.durations[n - 1], 73);
    // a break on a stop is the whole pause there, the stop and the space after it, the stop
    // keeping its own time; before the first word, the start
    let (_, natural) = said(&m, &mut ph, "<speak>one. two</speak>");
    let (inf, s) = said(
        &m,
        &mut ph,
        "<speak><break time=\"200ms\"/>one.<break strength=\"x-strong\"/> two</speak>",
    );
    let stop = find(&inf.tokens, ".", 0);
    assert_eq!(s.durations[0], 20);
    assert_eq!(s.durations[stop], natural.durations[stop]);
    assert_eq!(s.durations[stop] + s.durations[stop + 1], 120);
    let (_, short) = said(&m, &mut ph, "<speak>one.<break time=\"10ms\"/> two</speak>");
    assert_eq!((short.durations[stop], short.durations[stop + 1]), (1, 1));
}

#[test]
fn pitch_in_semitones_and_hz() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let (_, plain) = said(&m, &mut ph, "<speak>say it again and again</speak>");
    let (inf, up) = said(
        &m,
        &mut ph,
        "<speak>say <prosody pitch=\"+4st\">it again and</prosody> again</speak>",
    );
    assert_eq!(plain.durations, up.durations);
    let at = starts(&up.durations);
    let (a, b) = (
        at[find(&inf.tokens, "IH1", 0)],
        at[find(&inf.tokens, "D", 0) + 1],
    );
    for f in a + 5..b - 5 {
        assert!(
            (st(up.frames.lf0[f] - plain.frames.lf0[f]) - 4.0).abs() < 1e-3,
            "frame {f}"
        );
    }
    for f in (0..a).chain(b..at[at.len() - 1]) {
        assert_eq!(up.frames.lf0[f], plain.frames.lf0[f], "frame {f}");
    }
    // the decoder hears the model's pitch: the envelope as it was
    assert_eq!(up.frames.env, plain.frames.env);
    // a span set in Hz starts there and keeps the model's movement
    let (inf, hz) = said(
        &m,
        &mut ph,
        "<speak>say <prosody pitch=\"200Hz\">it again and</prosody> again</speak>",
    );
    let at = starts(&hz.durations);
    let (a, b) = (
        at[find(&inf.tokens, "IH1", 0)],
        at[find(&inf.tokens, "D", 0) + 1],
    );
    for f in a + 5..b - 5 {
        let want = 200f32.ln() + plain.frames.lf0[f] - plain.frames.lf0[a];
        assert!(
            (hz.frames.lf0[f] - want).abs() < 1e-4,
            "frame {f}: {} against {want}",
            hz.frames.lf0[f]
        );
    }
}

#[test]
fn volume_on_the_envelope() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let (_, plain) = said(&m, &mut ph, "<speak>one two three</speak>");
    let (inf, loud) = said(
        &m,
        &mut ph,
        "<speak>one <prosody volume=\"+6dB\">two</prosody> three</speak>",
    );
    let at = starts(&loud.durations);
    let t = find(&inf.tokens, "UW1", 0);
    let (a, b) = (at[t - 1], at[t + 1]);
    let g = 6.0 * std::f32::consts::LN_10 / 10.0;
    for f in a + 3..b - 3 {
        for c in 0..N_ENV {
            let d = loud.frames.env[f * N_ENV + c] - plain.frames.env[f * N_ENV + c];
            assert!((d - g).abs() < 1e-4, "frame {f} band {c}: {d}");
        }
    }
    assert_eq!(
        &loud.frames.env[..a * N_ENV],
        &plain.frames.env[..a * N_ENV]
    );
}

#[test]
fn emphasis_lengthens_raises_and_louder() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let (_, plain) = said(
        &m,
        &mut ph,
        "<speak>I never said she stole my money.</speak>",
    );
    let ease = |x: f32| 0.5 * (1.0 - (std::f32::consts::PI * x).cos());
    let db = |x: f32| x * std::f32::consts::LN_10 / 10.0;
    // the text, the word's first phone, its stressed vowel, its last, whether it goes on after that
    // vowel, and the frames readers add at strength 1 from the space before it to the space after
    let she: &[f32] = &[3.0, 1.5, 3.6, 1.8];
    let never: &[f32] = &[2.8, 0.9, 1.8, 0.7, 0.7, 3.4];
    for (level, k) in [("strong", 1.0f32), ("moderate", 0.5)] {
        for (src, first, vowel, last, goes_on, added) in [
            ("I never said <emphasis level=\"LEVEL\">she</emphasis> stole my money.", "SH", "IY1", "IY1", false, she),
            ("I <emphasis level=\"LEVEL\">never</emphasis> said she stole my money.", "N", "EH1", "ER0", true, never),
        ] {
            let (inf, e) = said(&m, &mut ph, &format!("<speak>{}</speak>", src.replace("LEVEL", level)));
            let (a, v, z) = (find(&inf.tokens, first, 0), find(&inf.tokens, vowel, 0), find(&inf.tokens, last, 0) + 1);
            // strong the frames of a word all its listeners marked, moderate half of them: a word
            // of one syllable's space before it, onset, stressed vowel and space after it; a
            // longer word's with the consonant after its vowel and its other vowel. Whole frames,
            // the rest carried to the next token
            let mut want = plain.durations.clone();
            assert_eq!(z + 1 - (a - 1), added.len(), "{src}");
            let mut rest = 0.0f32;
            for (i, x) in (a - 1..z + 1).zip(added) {
                rest += k * x;
                let whole = (rest + 0.5).floor();
                rest -= whole;
                want[i] += whole as usize;
            }
            assert_eq!(e.durations, want, "{src} {level}");
            let more = |d: &[usize]| d.iter().sum::<usize>() as f32;
            let all = k * added.iter().sum::<f32>();
            assert!((more(&e.durations) - more(&plain.durations) - all).abs() <= 0.5, "{src} {level}");
            // 0.7 semitones up at its start, rising halfway into its stressed vowel: to 3.2 and
            // held to the end of a word ending on that syllable, to 2.3 and falling to 1 by the
            // end of one that goes on; the words beside it as the model has them
            let r = raw(&m, &inf);
            let at = starts(&e.durations);
            let (wa, wb, va, vb) = (at[a], at[z], at[v], at[v + 1]);
            let top = va + ((vb - va) as f32 * 0.5).round() as usize;
            assert!(wa < top && top < wb - 1, "{src}");
            let lf0 = &e.frames.lf0;
            let peak = if goes_on { 2.3 } else { 3.2 };
            for f in 0..lf0.len() {
                let to = if f < wa || f >= wb {
                    0.0
                } else if f < top {
                    0.7 + (peak - 0.7) * ease((f - wa) as f32 / (top - wa) as f32)
                } else if goes_on {
                    peak - (peak - 1.0) * ease((f - top) as f32 / (wb - 1 - top) as f32)
                } else {
                    peak
                };
                close(lf0[f], r[f] + semitones(to * k), &format!("{src} {level}: frame {f}"));
            }
            // 2.2 dB louder over the word, ramped in and out
            let h = m.encode(&inf.tokens, 0).unwrap();
            let g = inf.edits(&m, &h, 1.0).unwrap().gain;
            assert!(wb - wa > 6, "{src}");
            for f in wa + 3..wb - 3 {
                close(g[f], db(2.2 * k), &format!("{src} {level}: gain at frame {f}"));
            }
            assert!(g[..wa].iter().chain(&g[wb..]).all(|&x| x == 0.0), "{src} {level}");
        }
    }
}

#[test]
fn reduced_shorter_flatter_quieter() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let (_, plain) = said(&m, &mut ph, "<speak>one two three</speak>");
    let (inf, e) = said(
        &m,
        &mut ph,
        "<speak>one <emphasis level=\"reduced\">two</emphasis> three</speak>",
    );
    let (t, u) = (find(&inf.tokens, "T", 0), find(&inf.tokens, "UW1", 0));
    // 0.85 times as long, each token rounded
    for i in t..=u {
        let x = plain.durations[i] as f32 * 0.85;
        assert!((e.durations[i] as f32 - x).abs() <= 1.0, "token {i}: {} against {x}", e.durations[i]);
    }
    let sum = |d: &[usize]| d[t..=u].iter().sum::<usize>();
    assert!(sum(&e.durations) < sum(&plain.durations));
    let at = starts(&e.durations);
    let h = m.encode(&inf.tokens, 0).unwrap();
    let g = inf.edits(&m, &h, 1.0).unwrap().gain;
    for f in at[t] + 3..at[u + 1] - 3 {
        close(g[f], -3.0 * std::f32::consts::LN_10 / 10.0, &format!("gain at frame {f}"));
    }
    let r = raw(&m, &inf);
    for f in (0..at[t]).chain(at[u + 1]..at[at.len() - 1]) {
        assert_eq!(e.frames.lf0[f], r[f], "frame {f}");
    }
}

#[test]
fn yes_no_questions_rise() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    // from the last stressed vowel's start to the end of the last vowel, the model's movement
    // flattened to 0.15 and 8 semitones added, rising as the square; held through the stop and the end
    let inf = Inflection::new(
        &mut ph,
        &ssml::plain("Are you coming home tonight?").unwrap(),
    )
    .unwrap();
    let (s, _) = inflect::infer(&m, &inf, 0, 1.0, 0.0, Pitch::Head).unwrap();
    let r = raw(&m, &inf);
    let at = starts(&s.durations);
    let v = find(&inf.tokens, "AY1", 0);
    let (a, end, b) = (at[v], at[v + 1], r.len());
    let len = (end - a) as f32;
    for f in a..b {
        let x = ((f - a) as f32 / len).min(1.0);
        close(
            s.frames.lf0[f],
            r[a] + (r[f] - r[a]) * (1.0 - x * 0.85) + semitones(8.0) * x * x,
            &format!("frame {f}"),
        );
    }
    for f in (0..a).chain(b..r.len()) {
        assert_eq!(s.frames.lf0[f], r[f], "frame {f}");
    }
    // a wh-question falls as the model has it
    let inf = Inflection::new(
        &mut ph,
        &ssml::plain("Who is coming home tonight?").unwrap(),
    )
    .unwrap();
    let (s, _) = inflect::infer(&m, &inf, 0, 1.0, 0.0, Pitch::Head).unwrap();
    assert_eq!(s.frames.lf0, raw(&m, &inf));
}

#[test]
fn exclamations_rise_on_their_nucleus_and_hold_their_end_up() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    // a sentence ending in '!': its whole pitch lifted `lift` semitones and its pitch above a running
    // mean (50 frames, from the sentence's start) `span` times as far above it, both ramped over 5
    // frames at either end; from the stressed vowel of its nucleus, its last word with a vowel not a
    // function word ("game", not "for them"; with none, its last word with a vowel), rising `rise`
    // semitones by the nucleus's end (a half cosine) and held there to the end of its tail; the
    // sentence 1.3 dB louder and tilted `tilt` dB an octave, ramped over 3 frames; the durations and
    // the sentence before it as the model has them. Scaled by exclaim: none at 0. Unless asked: no
    // lift, widening or tilt, and a rise of 1.
    let inf = Inflection::new(&mut ph, &ssml::plain("Do it!").unwrap()).unwrap();
    assert_eq!((inf.exclaim, inf.exclaim_lift, inf.exclaim_span, inf.exclaim_tilt, inf.exclaim_rise), (1.0, 0.0, 1.0, 0.0, 1.0));
    let ease = |x: f32| 0.5 * (1.0 - (std::f32::consts::PI * x).cos());
    let db = std::f32::consts::LN_10 / 10.0;
    // text, the sentence's first phone, the nucleus's first, its stressed vowel, its last
    let mut widened = 0;
    for (lift, span, tilt, rise) in [(0.0, 1.0, 0.0, 1.0), (2.0, 1.3, 0.3, 4.0)] {
        for (text, s0, n0, sv, n1) in [
            ("It works. We won the game for them!", ("W", 1), ("G", 0), ("EY1", 0), ("M", 0)),
            ("Do it!", ("D", 0), ("IH1", 0), ("IH1", 0), ("T", 0)),
        ] {
            let mut model = None;
            for k in [0.0, 1.0, 2.0] {
                let mut inf = Inflection::new(&mut ph, &ssml::plain(text).unwrap()).unwrap();
                (inf.exclaim, inf.exclaim_lift, inf.exclaim_span, inf.exclaim_tilt, inf.exclaim_rise) = (k, lift, span, tilt, rise);
                let (s, ed) = inflect::infer(&m, &inf, 0, 1.0, 0.0, Pitch::Head).unwrap();
                let r = raw(&m, &inf);
                assert_eq!(&s.durations, model.get_or_insert_with(|| s.durations.clone()), "{text} at {k}");
                if k == 0.0 {
                    assert_eq!(s.frames.lf0, r, "{text}");
                    assert!(ed.gain.is_empty() && ed.tilt.is_empty(), "{text}");
                    continue;
                }
                assert_eq!(ed.tilt.is_empty(), tilt == 0.0, "{text}");
                let tok = &inf.tokens;
                let (sa, na, v, nb) = (find(tok, s0.0, s0.1), find(tok, n0.0, n0.1), find(tok, sv.0, sv.1), find(tok, n1.0, n1.1) + 1);
                let at = starts(&s.durations);
                let (sf, a, top, b) = (at[sa], at[v], at[nb], r.len());
                assert!(at[na] <= a);
                let mut whole = 0.0;
                for f in 0..b {
                    let mut want = r[f];
                    if f >= sf {
                        let w = ((f - sf + 1).min(b - f) as f32 / 5.0).min(1.0);
                        want += w * semitones(lift * k);
                        whole = if f == sf { want } else { whole + (want - whole) / 50.0 };
                        widened += (span != 1.0 && want > whole) as usize;
                        want += w * (span - 1.0) * k * (want - whole).max(0.0);
                    }
                    if f >= a {
                        want += semitones(rise * k) * ease(((f - a) as f32 / (top - a) as f32).min(1.0));
                    }
                    close(s.frames.lf0[f], want, &format!("{text} at {k}, lift {lift}: frame {f}"));
                    let w = if f < sf { 0.0 } else { ((f - sf + 1).min(b - f) as f32 / 3.0).min(1.0) };
                    close(ed.gain[f], 1.3 * k * db * w, &format!("{text} at {k}: gain {f}"));
                    if tilt != 0.0 {
                        close(ed.tilt[f], tilt * k * db * w, &format!("{text} at {k}: tilt {f}"));
                    }
                }
            }
        }
    }
    assert!(widened > 0, "no frame above its running mean");
}

#[test]
fn the_tilt_turns_each_mel_band_by_its_octaves() {
    // on log-mel magnitude rows from frame `from` on: half the gain in every band, and half the
    // tilt times the octaves of the band's centre (HTK mel over 0 to 12 kHz, 100 Hz at least) less
    // their mean over the bands
    let ed = inflect::Edits {
        durations: Vec::new(),
        contour: inflect::Contour::none(),
        gain: vec![9.0, 0.4, -0.2],
        tilt: vec![9.0, 0.3, 0.0],
    };
    let mut mel = vec![1.0f32; 2 * N_MEL];
    ed.gain_mel(&mut mel, 1);
    let top = 2595.0 * (1.0f64 + 12000.0 / 700.0).log10();
    let oct: Vec<f64> = (1..=N_MEL)
        .map(|c| (700.0 * (10f64.powf(top * c as f64 / (N_MEL + 1) as f64 / 2595.0) - 1.0)).max(100.0).log2())
        .collect();
    let mid = oct.iter().sum::<f64>() / N_MEL as f64;
    for c in 0..N_MEL {
        close(mel[c], 1.0 + 0.2 + 0.15 * (oct[c] - mid) as f32, &format!("band {c}"));
        close(mel[N_MEL + c], 1.0 - 0.1, &format!("band {c}, no tilt"));
    }
    assert!(oct[0] == 100f64.log2() && oct[N_MEL - 1] > 13.5, "band centres");
}

#[test]
fn ssml_streamed_as_whole() {
    let src = "<speak><s>Is <emphasis>this</emphasis> <prosody rate=\"fast\" pitch=\"+3st\" volume=\"loud\">the same</prosody>?</s>\
               <break time=\"300ms\"/><prosody pitch=\"150Hz\">One <emphasis level=\"reduced\">two</emphasis></prosody> three. \
               We <emphasis>won</emphasis> the game!</speak>";
    for (score, voc, flow, sharpen) in [
        ("score-a.lsw", "voc-a.lsw", None, false),
        (
            "score-a-i8.lsw",
            "voc-a-i8.lsw",
            Some("pitch-a-i8.lsw"),
            true,
        ),
    ] {
        let (s, v) = (
            ScoreModel::load(&read(score)).unwrap(),
            Vocoder::load(&read(voc)).unwrap(),
        );
        let f = flow.map(|p| PitchFlow::load(&read(p)).unwrap());
        let sh = sharpen.then(|| {
            let mu = Rng::new(3)
                .gaussian(s.speakers() * N_ENV)
                .iter()
                .map(|v| 0.5 * v)
                .collect();
            Sharpen::new(mu, vec![1.0; s.speakers()], 1.3, 1.0, 1.0).unwrap()
        });
        let mut ph = phonemizer();
        let inf = Inflection::new(&mut ph, &ssml::pieces(src).unwrap()).unwrap();
        let pitch = match &f {
            Some(f) => Pitch::Flow(
                f,
                Sampling {
                    seed: 5,
                    widen: Some(Widen { by: WIDEN, centre: 4.9 }),
                    ..Default::default()
                },
            ),
            None => Pitch::Head,
        };
        let (mut sc, ed) = inflect::infer(&s, &inf, 0, 1.1, -1.0, pitch).unwrap();
        if let Some(sh) = &sh {
            sc.frames.env = sh.apply(0, &sc.frames.env);
        }
        ed.gain(&mut sc.frames.env, 0);
        let want = v
            .render(&sc.frames, &Rng::new(5).gaussian(sc.frames.len() * HOP))
            .unwrap();
        for step in [1, 7, 100000] {
            let mut st =
                Stream::inflected(&s, Render::Voc(&v), &inf, 0, 1.1, -1.0, pitch, 5, sh.as_ref()).unwrap();
            assert_eq!(st.durations(), &sc.durations[..]);
            let mut got = Vec::new();
            while !st.done() {
                st.step(step, &mut got);
            }
            let (lf0, _) = st.pitch();
            assert_eq!(lf0, &sc.frames.lf0[..], "{score} step {step}");
            assert_eq!(got.len(), want.len());
            let bad = (0..want.len())
                .filter(|&k| got[k].to_bits() != want[k].to_bits())
                .count();
            assert_eq!(bad, 0, "{score} step {step}: {bad} samples differ");
        }
    }
}

#[test]
fn phrasing_puts_commas_between_words() {
    let b = lipservice::breaks::Breaks::load(&read("breaks-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let words: Vec<&str> = "the old woman who kept the shop at the corner of the street had lived there for as long as anyone in the village could remember and nobody knew where she had come from".split(' ').collect();
    let phrased = |ph: &mut Phonemizer, src: &str, rate: f32| {
        let mut inf = Inflection::new(ph, &ssml::pieces(src).unwrap()).unwrap();
        inf.phrase(&b, rate).unwrap();
        inf
    };
    // each comma by the word before it, from 0
    let commas = |inf: &Inflection| -> Vec<usize> {
        let t = &inf.tokens;
        (0..t.len()).filter(|&i| front::symbol(t[i]) == ",").map(|i| t[..i].iter().filter(|&&x| x == front::SPACE).count()).collect()
    };
    let src = format!("<speak>{}</speak>", words.join(" "));
    let plain = Inflection::new(&mut ph, &ssml::pieces(&src).unwrap()).unwrap();
    let (few, many) = (phrased(&mut ph, &src, 0.02), phrased(&mut ph, &src, 0.10));
    assert!(!commas(&many).is_empty() && commas(&few).iter().all(|c| commas(&many).contains(c)), "{:?} {:?}", commas(&few), commas(&many));
    // the words' tokens as they were, each comma before the space between two words
    let t = &many.tokens;
    assert_eq!(t.iter().copied().filter(|&x| front::symbol(x) != ",").collect::<Vec<_>>(), plain.tokens);
    for i in (0..t.len()).filter(|&i| front::symbol(t[i]) == ",") {
        assert!(t[i + 1] == front::SPACE && t[i - 1] != front::SPACE && front::symbol(t[i + 2]).chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()), "{i}");
    }
    // a gap asked to have no break has none; the others keep theirs
    let k = commas(&many)[0];
    let joined = format!("<speak>{}<break time=\"0ms\"/> {}</speak>", words[..=k].join(" "), words[k + 1..].join(" "));
    let j = phrased(&mut ph, &joined, 0.10);
    assert_eq!(commas(&j), commas(&many)[1..]);
    // a stop the text has is not doubled
    let stopped = format!("<speak>{}, {}</speak>", words[..=k].join(" "), words[k + 1..].join(" "));
    assert_eq!(commas(&phrased(&mut ph, &stopped, 0.10)).iter().filter(|&&c| c == k).count(), 1);
}

#[test]
fn pace_lengthens_words_not_gaps() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let src = "<speak>When the long rain finally stopped, we all went outside to play.</speak>";
    let mut at = |pace: f32| {
        let mut inf = Inflection::new(&mut ph, &ssml::pieces(src).unwrap()).unwrap();
        inf.pace = pace;
        let (s, _) = inflect::infer(&m, &inf, 0, 1.0, 0.0, Pitch::Head).unwrap();
        (inf.tokens, s.durations)
    };
    let (tok, one) = at(1.0);
    let (_, slow) = at(1.25);
    let gap = |i: usize| [" ", ",", ".", "^", "$"].contains(&front::symbol(tok[i]));
    let total = |d: &[usize], g: bool| (0..d.len()).filter(|&i| gap(i) == g).map(|i| d[i]).sum::<usize>() as f32;
    let r = total(&slow, false) / total(&one, false);
    assert!((r - 1.25).abs() < 0.03, "words {r}");
    for i in (0..tok.len()).filter(|&i| gap(i)) {
        assert!(one[i].abs_diff(slow[i]) <= 1, "{} at {i}: {} to {}", front::symbol(tok[i]), one[i], slow[i]);
    }
    let mut inf = Inflection::new(&mut ph, &ssml::pieces(src).unwrap()).unwrap();
    inf.pace = 0.0;
    assert!(inflect::infer(&m, &inf, 0, 1.0, 0.0, Pitch::Head).is_err());
}

/// The inflection of plain text with LEXICAL's edits scaled by k, its score and edits.
fn lexical(m: &ScoreModel, ph: &mut Phonemizer, src: &str, k: f32) -> (Inflection, Score, inflect::Edits) {
    let mut inf = Inflection::new(ph, &ssml::pieces(src).unwrap()).unwrap();
    inf.lexical = k;
    let (s, ed) = inflect::infer(m, &inf, 0, 1.0, 0.0, Pitch::Head).unwrap();
    (inf, s, ed)
}

#[test]
fn lexical_words_said_as_readers_do() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    // "two" and "too", which the model says as "to", with a word after them and before a stop:
    // their vowel's frames and their consonant's times LEXICAL's (each rounded), its decibels
    // ramped over 3 frames, its semitones up ramped over 5; the other tokens as the model has them.
    // Scaled by lexical: none at 0. None on a word with emphasis asked.
    let ramp = |f: usize, a: usize, b: usize, r: usize| ((f - a + 1).min(b - f) as f32 / r as f32).min(1.0);
    for (src, vowel, rest, db, up) in [
        ("<speak>one two three</speak>", 1.85, 1.75, 0.3, 2.8),
        ("<speak>me too now</speak>", 2.15, 1.8, -0.4, 2.4),
        ("<speak>me too, now</speak>", 0.94, 1.3, -0.3, 2.35),
        ("<speak>I have two.</speak>", 1.05, 1.1, -1.1, 2.0),
    ] {
        let (inf, plain, ed) = lexical(&m, &mut ph, src, 0.0);
        assert!(ed.gain.is_empty(), "{src}");
        assert_eq!(plain.frames.lf0, raw(&m, &inf), "{src}");
        for k in [0.5, 1.0] {
            let (inf, s, ed) = lexical(&m, &mut ph, src, k);
            let (t, u) = (find(&inf.tokens, "T", 0), find(&inf.tokens, "UW1", 0));
            for i in 0..inf.tokens.len() {
                if (t..=u).contains(&i) {
                    let x = plain.durations[i] as f32 * f32::powf(if i == u { vowel } else { rest }, k);
                    assert!((s.durations[i] as f32 - x).abs() <= 1.5, "{src} at {k}: token {i}, {} against {x}", s.durations[i]);
                } else {
                    assert_eq!(s.durations[i], plain.durations[i], "{src} at {k}: token {i}");
                }
            }
            assert_ne!(s.durations[t..=u], plain.durations[t..=u], "{src} at {k}");
            let at = starts(&s.durations);
            let (a, b) = (at[t], at[u + 1]);
            let r = raw(&m, &inf);
            for f in 0..r.len() {
                let (g, p) = if (a..b).contains(&f) {
                    (db * k * std::f32::consts::LN_10 / 10.0 * ramp(f, a, b, 3), r[f] + semitones(up * k) * ramp(f, a, b, 5))
                } else {
                    (0.0, r[f])
                };
                close(ed.gain[f], g, &format!("{src} at {k}: gain {f}"));
                close(s.frames.lf0[f], p, &format!("{src} at {k}: frame {f}"));
            }
        }
    }
    for src in [
        "<speak>one <emphasis>two</emphasis> three</speak>",
        "<speak>one <emphasis level=\"reduced\">two</emphasis> three</speak>",
    ] {
        let (_, a, ea) = lexical(&m, &mut ph, src, 0.0);
        let (_, b, eb) = lexical(&m, &mut ph, src, 1.0);
        assert_eq!(a.durations, b.durations, "{src}");
        assert_eq!(a.frames.lf0, b.frames.lf0, "{src}");
        assert_eq!(ea.gain, eb.gain, "{src}");
    }
}
