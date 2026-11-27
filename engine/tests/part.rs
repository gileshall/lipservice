// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A part from a piano roll, and performed: the engine sings what part.rs writes.

use lipservice::diction::{Rules, Who};
use lipservice::front::Phonemizer;
use lipservice::g2p::G2p;
use lipservice::lexicon::Lexicon;
use lipservice::part::{clocked, perform, perform_as, roll, syllables, Clip, Key, Library, Manner, Part, BREATH_PRE, FPS, SR};
use lipservice::score::ScoreModel;
use lipservice::sing::{plan, Song, Style};
use lipservice::weights::Weights;

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn phonemizer() -> Phonemizer {
    Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap()
}

fn style(shift: f32) -> Style {
    Style { shift, vibrato: 0.25, vibrato_hz: 5.5, vibrato_delay: 0.25, vibrato_ramp: 0.2, glide: 9, dynamics: 0.0, consonants: 1.0, breathiness: 1.0, who: Default::default(), motion: None, motion_scale: 1.0, seed: 0 }
}

/// A note a beat from `start`, the pitches given.
fn keys(start: f64, pitches: &[f32]) -> Vec<Key> {
    pitches.iter().enumerate().map(|(i, &pitch)| Key { pitch, start: start + i as f64, beats: 1.0 }).collect()
}

#[test]
fn the_engine_sings_a_roll() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    // "water" over two notes by itself, "wide" held over two, a rest where the notes leave one
    let mut ks = keys(1.0, &[60.0, 62.0, 64.0, 62.0, 60.0, 59.0]);
    ks.extend(keys(8.0, &[57.0, 59.0, 60.0]));
    ks[5].beats = 1.5;
    let text = roll(96.0, 0.0, &ks, "The water is wide_, I can't cross", &[], 0.0, &mut |items, k| syllables(&mut ph, &Rules::default(), &Who::default(), items, k)).unwrap();
    assert_eq!(text, "%bpm 96\n%rest 1\nThe 60:1\nwater 62:1 64:1\nis 62:1\nwide 60:1+59:1.5\n%rest 0.5\nI 57:1\ncan't 59:1\ncross 60:1\n");
    let p = plan(&m, &mut ph, &Song::parse(&text).unwrap(), 0, &style(0.0)).unwrap();
    assert_eq!(p.notes.len(), 9);
    assert_eq!(p.rests().len(), 2);

    // the writer's own syllables must be the engine's
    let e = roll(96.0, 0.0, &ks[..2], "wa-ter-s", &[], 0.0, &mut |items, k| syllables(&mut ph, &Rules::default(), &Who::default(), items, k)).unwrap_err();
    assert!(e.0.contains("written in 3 syllables, sung in 2"), "{}", e.0);
    let two = roll(96.0, 0.0, &ks[..3], "wa_-ter", &[], 0.0, &mut |items, k| syllables(&mut ph, &Rules::default(), &Who::default(), items, k)).unwrap();
    assert_eq!(two, "%bpm 96\n%rest 1\nwater 60:1+62:1 64:1\n");
    // a word the front end reads as more than one
    assert!(roll(96.0, 0.0, &ks[..2], "twenty-one 3", &[], 0.0, &mut |items, k| syllables(&mut ph, &Rules::default(), &Who::default(), items, k)).is_err());
}

#[test]
fn a_performed_part_keeps_its_songs_diction() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    // a rule line is the whole song's, and the part as performed says it still
    let song = "%bpm 96\n%rest 1\n%diction word=mild -> M AY AH L D\nso G4:1\nmild A4:1 B4:1\n%rest 1\n";
    let asked = Part { song, sex: 'F', seed: 3, at: 0.0, shift: 0.0, jitter: 2.0, detune: 3.0, spread: 0.0, breath: 0.0 };
    let p = perform(&asked, None, |text, shift| {
        let plan = plan(&m, &mut ph, &Song::parse(text)?, 0, &style(shift as f32))?;
        let rests = plan.rests();
        Ok((plan, rests))
    })
    .unwrap();
    assert!(p.text.starts_with("%bpm 96\n%diction word=mild -> M AY AH L D\n"), "{}", p.text);
    assert_eq!(p.singer.notes.len(), 3);
    // a word called diction is a word
    assert!(lipservice::part::parse("%bpm 96\ndiction C4:1\n").unwrap().diction.is_empty());
}

#[test]
fn a_roll_counts_by_the_songs_diction() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let ks = keys(0.0, &[60.0, 62.0, 64.0]);
    let two = Rules::file("word=mild -> M AY AH L D\nfor=alto word=so -> S OW AH").unwrap();
    let alto = Who { track: None, voice: None, tags: vec!["alto".into()] };
    let mut count = |who: &Who, words: &str, n: usize| roll(96.0, 0.0, &ks[..n], words, &[], 0.0, &mut |items, k| syllables(&mut ph, &two, who, items, k));
    // a word given whole in two syllables takes two notes, for the one it is given for
    let text = count(&Who::default(), "so mild", 3).unwrap();
    assert_eq!(text, "%bpm 96\nso 60:1\nmild 62:1 64:1\n");
    assert!(count(&Who::default(), "mild", 1).unwrap_err().0.contains("mild"));
    assert_eq!(count(&alto, "so", 2).unwrap(), "%bpm 96\nso 60:1 62:1\n");
    assert!(count(&Who::default(), "so", 2).is_err());
    // and the plan under the same rules sings what the roll wrote
    let p = plan(&m, &mut ph, &Song::parse_under(&text, two.clone()).unwrap(), 0, &style(0.0)).unwrap();
    assert_eq!(p.notes.len(), 3);
    // a sound's rule keeps the count, whatever is held
    let sung = Rules::default();
    assert_eq!(syllables(&mut ph, &sung, &Who::default(), &[Some("night"), Some("mother")], 0).unwrap(), 1);
    assert_eq!(syllables(&mut ph, &sung, &Who::default(), &[Some("night"), Some("mother")], 1).unwrap(), 2);
}

#[test]
fn a_performed_part_breathes_in_its_rests() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let lib = Library::new(vec![
        Clip { id: "a".into(), sex: 'F', at: 0, n: 7200 },
        Clip { id: "b".into(), sex: 'F', at: 7200, n: 9600 },
        Clip { id: "c".into(), sex: 'M', at: 16800, n: 9600 },
    ])
    .unwrap();
    let song = "%bpm 90\n%rest 2\nthe C4:1\nwater D4:1 E4:1\nis D4:1\nwide C4:2\n%rest 0.25\nI A3:1\ncan't B3:1\ncross C4:1\nover D4:1 E4:2\n";
    for seed in 0..6 {
        let part = Part { song, sex: 'F', seed, at: 0.0, shift: 0.0, jitter: 2.0, detune: 5.0, spread: 0.0, breath: 1.0 };
        let mut opened = 0;
        let p = perform(&part, Some(&lib), |text, shift| {
            opened += 1;
            let p = plan(&m, &mut ph, &Song::parse(text)?, 0, &style(shift as f32))?;
            let rests = p.rests();
            Ok((p, rests))
        })
        .unwrap();
        assert!(opened <= 14);
        assert!(p.shift.abs() <= 0.05 && p.lag.abs() <= 0.02, "{} {}", p.shift, p.lag);
        // a breath before each phrase, a woman's, whole inside the engine's own silence there
        assert_eq!(p.breaths.len(), 2);
        let rests = p.singer.rests();
        assert_eq!(rests.len(), 2);
        for (&(c, at), r) in p.breaths.iter().zip(&rests) {
            assert_eq!(lib.clips[c].sex, 'F');
            let (from, to) = (r.start as f64 / FPS * SR, r.end as f64 / FPS * SR);
            assert!(at as f64 >= from + BREATH_PRE * SR - 1.0, "seed {seed}: a breath at {at} in {from}..{to}");
            assert!((at + lib.clips[c].n as i64) as f64 <= to - 0.03 * SR + 1.0, "seed {seed}: a breath at {at} in {from}..{to}");
        }
        // the quarter beat written was not room enough: the note before gave the rest up
        assert!(!p.text.contains("wide C4:2\n"), "{}", p.text);
    }
    // no library, no breaths, and the short rest stays as written
    let part = Part { song, sex: 'F', seed: 0, at: 0.0, shift: -12.0, jitter: 0.0, detune: 0.0, spread: 0.0, breath: 0.0 };
    let p = perform(&part, None, |text, shift| Ok(((), plan(&m, &mut ph, &Song::parse(text)?, 0, &style(shift as f32))?.rests()))).unwrap();
    assert_eq!((p.text.as_str(), p.breaths.len(), p.lag, p.shift), (song, 0, 0.0, -12.0));
}

/// Parts performed together move their phrases and notes as one, whatever their seeds, and keep
/// their own pitch; a note gives a breath no more of itself than its share, and holds where the
/// breath does not fit in that.
#[test]
fn parts_keep_time_together_and_a_note_gives_its_share() {
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let lib = Library::new(vec![Clip { id: "a".into(), sex: 'F', at: 0, n: 7200 }, Clip { id: "b".into(), sex: 'F', at: 7200, n: 9600 }]).unwrap();
    let song = "%bpm 90\n%rest 2\nthe C4:1\nwater D4:1 E4:1\nis D4:1\nwide C4:2\n%rest 0.25\nI A3:1\ncan't B3:1\ncross C4:1\nover D4:1 E4:2\n";
    let mut sing = |part: &Part, manner: Manner, lib: Option<&Library>| {
        perform_as(part, manner, lib, |text, shift| {
            let text = if manner.together { clocked(text)? } else { text.to_string() };
            let p = plan(&m, &mut ph, &Song::parse(&text)?, 0, &style(shift as f32))?;
            let rests = p.rests();
            Ok((p, rests))
        })
        .unwrap()
    };
    let part = |seed: u64| Part { song, sex: 'F', seed, at: 4.0, shift: 0.0, jitter: 3.0, detune: 5.0, spread: 0.0, breath: 0.0 };
    let together = Manner { together: true, give: None, wants: &[] };
    let (own, kept): (Vec<_>, Vec<_>) = (0..6).map(|seed| (sing(&part(seed), Manner::default(), None), sing(&part(seed), together, None))).unzip();
    assert!(kept.iter().all(|p| p.text == kept[0].text && p.lag == kept[0].lag), "together, each its own timing");
    assert!(kept[0].text != song && own.iter().any(|p| p.text != own[0].text), "the timing did not move");
    // the pitch is each part's own, and the same as it is alone
    for (a, b) in own.iter().zip(&kept) {
        assert_eq!(a.shift, b.shift);
        assert!(b.singer.rests().len() == 2 && !b.text.contains("together"));
    }
    assert!(kept.iter().any(|p| p.shift != kept[0].shift));
    // another place in the piece is another draw
    let later = sing(&Part { at: 5.0, ..part(0) }, together, None);
    assert!(later.text != kept[0].text || later.lag != kept[0].lag);
    assert_eq!(clocked(song).unwrap(), song.replacen("%bpm 90\n", "%bpm 90\n%together\n", 1));
    assert!(clocked("la C4:1\n").is_err());

    // the two beats of "wide": all but half a beat to give without a share; a third is too little for
    // any breath, so none is taken and the note is held; a half is room for one
    let breathing = Part { song, sex: 'F', seed: 0, at: 0.0, shift: 0.0, jitter: 0.0, detune: 0.0, spread: 0.0, breath: 1.0 };
    let wide = |text: &str| -> f64 { text.lines().find_map(|l| l.strip_prefix("wide C4:")).unwrap().parse().unwrap() };
    let all = sing(&breathing, Manner::default(), Some(&lib));
    let third = sing(&breathing, Manner { together: false, give: Some(1.0 / 3.0), wants: &[] }, Some(&lib));
    let half = sing(&breathing, Manner { together: false, give: Some(0.5), wants: &[] }, Some(&lib));
    assert_eq!((all.breaths.len(), third.breaths.len(), half.breaths.len()), (2, 1, 2));
    assert!(third.text.contains("wide C4:2\n%rest 0.25\n"), "{}", third.text);
    assert!(wide(&half.text) >= 1.0 && wide(&half.text) < 2.0, "{}", half.text);
    assert!(wide(&all.text) < 2.0, "{}", all.text);
}
