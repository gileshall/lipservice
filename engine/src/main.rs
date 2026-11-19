// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

use lipservice::breaks::Breaks;
use lipservice::dsp::{self, HOP, SR};
use lipservice::front::{self, Phonemizer};
use lipservice::g2p::G2p;
use lipservice::inflect::{self, Inflection};
use lipservice::lexicon::Lexicon;
use lipservice::melvoc::{MelDec, MelVoc};
use lipservice::part::{self, Key, Manner, Part};
use lipservice::release::Release;
use lipservice::pitchflow::{PitchFlow, Sampling, Solver, Widen, WIDEN};
use lipservice::rng::Rng;
use lipservice::score::{Pitch, ScoreModel};
use lipservice::sharpen::Sharpen;
use lipservice::sing::{Motion, Song, Style};
use lipservice::ssml;
use lipservice::passage::Passage;
use lipservice::pause::{self, PauseBank};
use lipservice::stream::{Render, Stream};
use lipservice::vocoder::{Frames, Vocoder};
use lipservice::voice::Voice;
use lipservice::vox::{Noise, Plan, Vox, Wearer};
use lipservice::weights::{Error, Result, Weights};
mod simple;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// The simple forms (say TEXT, sing SONG) print one line of their own, not the engine's report.
static QUIET: AtomicBool = AtomicBool::new(false);
macro_rules! report {
    ($($t:tt)*) => {
        if !QUIET.load(Ordering::Relaxed) {
            println!($($t)*);
        }
    };
}

const USAGE: &str = "usage:
  lipservice vocode WEIGHTS.lsw FRAMES.lsw OUT.wav [SEED]
  lipservice bench WEIGHTS.lsw FRAMES.lsw [REPS]
  lipservice words [-0] < TEXT     (each line's words and stops, or its error; -0: texts split by NUL)
  lipservice tokens G2P.lsw LEXICON.lsw < TEXT    (each line's token ids)
  lipservice g2p G2P.lsw < WORDS   (each word and its G2P phones or !error, tab separated; timing on stderr)
  lipservice say SCORE.lsw|VOICE.lsw VOCODER.lsw G2P.lsw LEXICON.lsw OUT.wav TEXT [--ssml] [--rate R] [--shift SEMITONES] [--seed N]
      [--base BASE.lsw] [--vox-part PART.lsw] [--mel-part PART.lsw] [--stream FRAMES] [--pitch FLOW.lsw [--pitch-solver euler] [--pitch-steps 8] [--pitch-temp 1] [--pitch-slow 10] [--pitch-widen 1.85]] [--speaker N] [--sharpen SHAPE.lsw [--widen 1.3]] [--word-pitch K] [--pauses P]
      [--plan OUT.txt]
      [--breaks BREAKS.lsw [--phrase RATE]] [--pace P] [--exclaim K [--exclaim-lift ST] [--exclaim-tilt DB]
      [--exclaim-span K] [--exclaim-rise ST]] [--lexical K]

FRAMES.lsw holds env, bap, lf0 and vuv; LEXICON.lsw is a cmudict-style dictionary,
packed. say --stream says the text a part at a time
(engine/src/passage.rs: parts end at a paragraph's end), FRAMES score frames a step, and reports
when the first audio came; a text of one part gives the same samples. say --pitch draws the pitch
and voicing from the flow instead of the score model's head, its noise from
--seed too; --pitch-slow N takes each frame's log F0 noise less its mean over N frames (default 10,
0 for none), the draw's slow shape near the flow's mean; --pitch-widen G scales the drawn log F0 G
times about the voice's pitch centre (voice.centre, the median of its draws), frame by frame
(default 1.85, the readers' spread; 1 for none, which a score model, with no centre,
needs). --speaker picks the score model's speaker by index (default 0). say --sharpen sharpens the
decoder's envelope about the voice's mean shape from SHAPE.lsw,
its shape widened --widen times. A voice file
in place of SCORE.lsw brings its own speaker, pitch flow (or the head), sharpening and
register; --shift then moves the voice from its register. A voice file written against a base
needs that base, --base. A voice's parts of the latent voice and its mel decoder may be
files of their own (tools/split.py), given by --vox-part and --mel-part; the mel decoder's goes with a mel route file. A mel route file in place of
VOCODER.lsw renders speech through its mel decoder and Vocos; --sharpen and --widen do not apply to
it, and sing takes the vocoder. --word-pitch K moves each word's pitch, its mean less the utterance's
trend, K times as far from the trend, the word's own shape kept; --pauses P scales the frames at a
stop inside the utterance and the space after it. Both before any SSML edits, whole utterances
only, not with --stream. --breaks phrases the text where a reader would break
(engine/src/breaks.rs): a comma, said as the model says one, at the word gaps with no stop its
model scores in the top RATE of such gaps, the voice's own share (voice.phrase) unless --phrase
gives one. --pace scales each word's phones' frames, not the spaces' or stops', in place of the
voice's own pace (voice.pace; 1 without it). A sentence ending in '!' holds its end up from its nucleus
and is louder, as readers do (engine/src/inflect.rs); --exclaim K scales that (0 none, 1 by default);
--exclaim-lift, -tilt, -span and -rise set, at strength 1, its sentence's lift (semitones), tilt (dB an
octave, on the mel route) and widening (times), none unless asked, and its end's rise (semitones). A word the model says as the function word sharing its phones ('two' as 'to') is
said as long, loud and high as readers say it; --lexical K scales that (0 none, 1 by default). Whole
utterances only. With --ssml, TEXT is SSML (engine/src/ssml.rs
gives what is read): prosody's rate, pitch and volume, emphasis, breaks, say-as, phoneme and sub, as
edits to the score (engine/src/inflect.rs). A question not opened by a wh-word rises at its end.
--plan writes the plan as rendered, for another renderer: for each part (one, without --stream) the samples
of silence before it, the token ids, their frames, each frame's log F0 and voicing after every edit, and
each frame's added loudness and tilt; sing takes it too, without --dynamics or --ring.

  lipservice sing SCORE.lsw|VOICE.lsw VOCODER.lsw G2P.lsw LEXICON.lsw OUT.wav SONG.txt [--shift SEMITONES] [--base BASE.lsw] [--vox-part PART.lsw] [--mel-part PART.lsw]
      [--speaker N] [--sharpen SHAPE.lsw [--widen 1.3]] [--vibrato 0.25] [--vibrato-hz 5.5]
      [--vibrato-delay 0.25] [--motion MOTION.lsw [--motion-scale 1]] [--glide 9] [--dynamics 0] [--ring 0] [--consonants 1]
      [--breathiness 1] [--diction] [--seed N] [--frames OUT.tsv] [--plan OUT.txt]

  lipservice roll G2P.lsw LEXICON.lsw NOTES.txt WORDS.txt OUT-SONG.txt [--diction] [--join BEATS]
  lipservice perform SCORE.lsw|VOICE.lsw VOCODER.lsw G2P.lsw LEXICON.lsw OUT.wav SONG.txt [--base BASE.lsw] [--vox-part PART.lsw] [--mel-part PART.lsw] [--seed N]
      [--at S] [--jitter FRAMES] [--detune CENTS] [--spread S] [--breaths BREATHS.json --breath P --sex F|M]
      [--together] [--give SHARE] [--shift SEMITONES] [--vibrato 0.25] [--vibrato-hz 5.5] [--vibrato-delay 0.25] [--motion MOTION.lsw [--motion-scale 1]]
      [--glide 9] [--dynamics 0] [--consonants 1] [--breathiness 1] [--diction] [--performed OUT-SONG.txt] [--dry]

  lipservice vox VOX.lsw VOICE.lsw PLAN.txt OUT.wav [--base BASE.lsw] [--vox-part PART.lsw] [--mel-part PART.lsw] [--seed N] [--stream FRAMES]

The latent voice's models (engine/src/vox.rs) in place of say's VOCODER.lsw render
speech through them: the loudness model and the prior draw from the text encoder's states, the durations and
the pitch, and the generator renders their code on the pitch, the plan's loudness and tilt edits put on its
samples. It takes a voice file with the voice's parts of it, fitted for these
models on this text encoder; --sharpen and --widen do not apply to it. vox renders a plan (say's or sing's
--plan, the voice's own) the same way: part k's noise is seed N + k's, the plan's silence goes between the
parts, and --stream renders each part so many frames at a time, the same samples sooner.

sing takes the durations and pitch from the song's notes (engine/src/sing.rs gives the format); with
the latent voice's models as its VOCODER.lsw it sings through them, a voice file's as say: --dynamics
and the rests' silence go on as a plan's loudness and tilt, --breathiness scales its generator's noise and
residual in the sung vowels, and --sharpen, --widen and --ring do not apply.
--shift transposes the song, --vibrato is its peak in semitones, starting --vibrato-delay seconds into
each vowel; --motion puts a trained singer's pitch motion on every note in
place of the vibrato, the singer and the draws by --seed, --motion-scale times the singer's own size. --glide is the frames over which the pitch moves between notes. --dynamics scales
the loudness and brightness that follow the notes, and --ring raises the sung vowels about 3 kHz
by that many dB (the singer's formant); 0, the default, for none. --consonants scales the
consonants' durations but the stops' and affricates', the vowels giving the time up; --breathiness
scales the sung vowels' aperiodicity, under 1 for less breath noise. --frames writes each frame's
log F0 and voicing as rendered. --diction sings every vowel
stressed and an unstressed ER as AH and R. A voice file's register shift does not apply.

roll writes a piano roll's notes and the words under them as a song (engine/src/part.rs gives the words'
format: a note a syllable, wa-ter for a word's own syllables, a _ for each further note one holds).
NOTES.txt: a line `bpm N`, then a note a line, NOTE START BEATS (a note name or MIDI number, and
beats from the part's start); a line `vibrato BEAT SIZE` is the pedal beside them, the vibrato SIZE
times the voice's own from BEAT until the next such line. --diction counts the syllables as sing --diction sings them; a gap
between words of --join beats or less is held by the note before it (0 by default: every gap a rest).

perform sings a song as a person does, as the page's choirs are sung (engine/web/perform.js): each
phrase up to --jitter frames off the beat and its notes pulled about inside it, the pitch up to
--detune cents off, the start up to --spread seconds off (reported, not put in the file), all drawn by
--seed; and a breath from the library (its index BREATHS.json, its sound beside it as .bin: 16-bit,
24 kHz) before a phrase with chance --breath, of a singer of --sex, room made in the rest by
shortening the note before, by no more than --give of itself (a share over 0, up to 1; without it, to
half a beat at least). --at is where the part starts in its piece, seconds: parts that start a
phrase at the same moment breathe together. --together draws the timing by the piece's moments and not
by the seed, as every such part's, and has the singer keep the others' clock for its consonants (a
together line in the song as sung, which --performed's file does not have). --performed writes the song as sung; --dry plans it and
places its breaths without singing it or writing OUT.wav. The style flags are sing's.";

fn frames(path: &str) -> Result<Frames> {
    let v = Weights::read(path)?;
    let f = Frames {
        env: v.get("env")?.data.clone(),
        bap: v.get("bap")?.data.clone(),
        lf0: v.get("lf0")?.data.clone(),
        vuv: v.get("vuv")?.data.clone(),
    };
    f.check()?;
    Ok(f)
}

fn phonemizer(g2p: &str, lexicon: &str) -> Result<Phonemizer> {
    Phonemizer::new(
        Lexicon::load(&Weights::read(lexicon)?)?,
        G2p::load(&Weights::read(g2p)?)?,
    )
}

/// Values of `--name VALUE` pairs in `args`, each name one of `names`.
/// Removes `name FILE` from args and gives FILE; an error if given twice or without a file.
/// One part of the plan as rendered, for another renderer: seven lines, each a name and its values, "gap"
/// the samples of silence before the part, "tok" the token ids, "dur" their frames, "lf0" and "vuv" each
/// frame's log F0 and voicing, "gain" each frame's added loudness (log power) and "tilt" its added tilt
/// (log power an octave, as `Edits::gain_mel` puts it on a mel); the last two with no values when the
/// render had none.
fn plan_part(gap: usize, tokens: &[usize], durations: &[usize], lf0: &[f32], vuv: &[f32], gain: &[f32], tilt: &[f32]) -> Result<String> {
    let whole = |v: &[f32]| v.is_empty() || v.len() == lf0.len();
    if tokens.len() != durations.len() || lf0.len() != vuv.len() || durations.iter().sum::<usize>() != lf0.len() || !whole(gain) || !whole(tilt) {
        return Err(Error(format!(
            "--plan: {} tokens, {} durations summing to {}, {} pitch, {} voicing, {} loudness and {} tilt frames",
            tokens.len(),
            durations.len(),
            durations.iter().sum::<usize>(),
            lf0.len(),
            vuv.len(),
            gain.len(),
            tilt.len()
        )));
    }
    let ints = |v: &[usize]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(" ");
    let reals = |v: &[f32]| v.iter().map(|x| format!("{x:.8e}")).collect::<Vec<_>>().join(" ");
    Ok(format!(
        "gap {gap}\ntok {}\ndur {}\nlf0 {}\nvuv {}\ngain {}\ntilt {}\n",
        ints(tokens),
        ints(durations),
        reals(lf0),
        reals(vuv),
        reals(gain),
        reals(tilt)
    ))
}

/// A plan of one part, written.
fn write_plan(path: &str, tokens: &[usize], durations: &[usize], lf0: &[f32], vuv: &[f32], gain: &[f32], tilt: &[f32]) -> Result<()> {
    write_text(path, &plan_part(0, tokens, durations, lf0, vuv, gain, tilt)?)
}

/// One part of a written plan.
struct PlanPart {
    gap: usize,
    tok: Vec<usize>,
    dur: Vec<usize>,
    lf0: Vec<f32>,
    vuv: Vec<f32>,
    gain: Vec<f32>,
    tilt: Vec<f32>,
}

/// A plan as `plan_part` writes its parts.
fn read_plan(path: &str) -> Result<Vec<PlanPart>> {
    const NAMES: [&str; 7] = ["gap", "tok", "dur", "lf0", "vuv", "gain", "tilt"];
    let text = std::fs::read_to_string(path).map_err(|e| Error(format!("{path}: {e}")))?;
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() || lines.len() % NAMES.len() != 0 {
        return Err(Error(format!("{path}: {} lines, not seven a part", lines.len())));
    }
    fn values<T: std::str::FromStr>(path: &str, at: usize, line: &str, name: &str) -> Result<Vec<T>> {
        let rest = line.strip_prefix(name).filter(|r| r.is_empty() || r.starts_with(' '));
        let rest = rest.ok_or_else(|| Error(format!("{path}, line {}: not {name}'s", at + 1)))?;
        rest.split_whitespace().map(|v| v.parse().map_err(|_| Error(format!("{path}, line {}: {v} in {name}", at + 1)))).collect()
    }
    let mut parts = Vec::new();
    for (k, c) in lines.chunks(NAMES.len()).enumerate() {
        let at = k * NAMES.len();
        let gap = values::<usize>(path, at, c[0], NAMES[0])?;
        if gap.len() != 1 || (gap[0] == 0) != (k == 0) {
            return Err(Error(format!("{path}, part {k}: silence before it of {gap:?} samples")));
        }
        parts.push(PlanPart {
            gap: gap[0],
            tok: values(path, at + 1, c[1], NAMES[1])?,
            dur: values(path, at + 2, c[2], NAMES[2])?,
            lf0: values(path, at + 3, c[3], NAMES[3])?,
            vuv: values(path, at + 4, c[4], NAMES[4])?,
            gain: values(path, at + 5, c[5], NAMES[5])?,
            tilt: values(path, at + 6, c[6], NAMES[6])?,
        });
    }
    Ok(parts)
}

/// A plan rendered by the latent voice: each part from its own seed, the plan's silence between.
fn vox(args: &[String]) -> Result<()> {
    let t0 = Instant::now();
    let mut rest = args[5..].to_vec();
    let (ws, _) = based(Weights::read(&args[2])?, &mut rest, None, &["vox"])?;
    if !Voice::is(&ws) {
        return Err(Error(format!("{}: not a voice file", args[2])));
    }
    let voice = Voice::load(ws, None)?;
    let vox = worn(Weights::read(&args[1])?, voice.vox, &args[2])?;
    let plan = read_plan(&args[3])?;
    let f = flags(&rest, &["--seed", "--stream"])?;
    let seed = f.get("--seed").unwrap_or(0.0);
    if !(seed >= 0.0 && seed.fract() == 0.0) {
        return Err(Error(format!("--seed {seed}: a whole number")));
    }
    if f.get("--stream").is_some_and(|n| !(n >= 1.0 && n.fract() == 0.0)) {
        return Err(Error(format!("--stream {}: a whole number of frames, 1 at least", f.get("--stream").unwrap())));
    }
    let t1 = Instant::now();
    let mut y: Vec<f32> = Vec::new();
    let mut spent = [0.0f64; 5];
    let mut first = None;
    for (k, p) in plan.iter().enumerate() {
        let t = p.lf0.len();
        if p.tok.len() != p.dur.len() || p.dur.iter().sum::<usize>() != t || p.vuv.len() != t {
            return Err(Error(format!(
                "{}, part {k}: {} tokens, {} durations summing to {}, {t} pitch and {} voicing frames",
                args[3],
                p.tok.len(),
                p.dur.len(),
                p.dur.iter().sum::<usize>(),
                p.vuv.len()
            )));
        }
        let noise = Noise::draw(seed as u64 + k as u64, t, vox.zdim());
        let mut at = Instant::now();
        let mut lap = |i: usize| {
            spent[i] += at.elapsed().as_secs_f64();
            at = Instant::now();
        };
        let mut st = vox.begin(&voice.score.states(&p.tok)?, &p.dur, &p.gain, &p.tilt, noise)?;
        st.hiss(&lipservice::vox::hisses(&p.tok))?;
        st.close(&lipservice::vox::closes(&p.tok))?;
        st.feed(&p.lf0, &p.vuv);
        lap(0);
        let mut s = Vec::new();
        while st.done() < t {
            s.extend(st.next_timed(f.get("--stream").map_or(t, |n| n as usize), &mut lap));
            if first.is_none() && !s.is_empty() {
                first = Some((t1.elapsed().as_secs_f64(), s.len(), vox.ahead()));
            }
        }
        if k > 0 {
            y.extend(lipservice::passage::gap(p.gap, *y.last().unwrap(), s[0]));
        }
        y.extend(s);
    }
    let t2 = Instant::now();
    lipservice::wav::write(&args[4], &y, SR as u32)?;
    let secs = y.len() as f64 / SR as f64;
    let (wait, got, ahead) = first.ok_or(Error("an empty plan".to_string()))?;
    println!(
        "{}: {secs:.2} s, {} parts, {} and {} steps; load {:.1} ms; first {:.2} s of audio {:.1} ms after the plan ({ahead} frames ahead); a second of audio: text {:.4}, loudness {:.4}, prior {:.4}, generator {:.4}, edits {:.4}; rtf {:.4} (one thread, after load)",
        args[4],
        plan.len(),
        vox.steps().0,
        vox.steps().1,
        (t1 - t0).as_secs_f64() * 1e3,
        got as f64 / SR as f64,
        wait * 1e3,
        spent[0] / secs,
        spent[1] / secs,
        spent[2] / secs,
        spent[3] / secs,
        spent[4] / secs,
        (t2 - t1).as_secs_f64() / secs
    );
    Ok(())
}

/// The latent voice's models as a voice's parts of it, a voice file's, wear them.
fn worn(model: Weights, parts: Option<Wearer>, voice: &str) -> Result<Vox> {
    match parts {
        Some(w) => Vox::load(model, w),
        None => Err(Error(format!("{voice}: no parts of the latent voice"))),
    }
}

fn write_text(path: &str, text: &str) -> Result<()> {
    std::fs::write(path, text).map_err(|e| Error(format!("{path}: {e}")))
}

fn file_flag(args: &mut Vec<String>, name: &str) -> Result<Option<String>> {
    value_flag(args, name, "a file")
}

/// Removes a flag and its value from args; the value, if it was there.
fn value_flag(args: &mut Vec<String>, name: &str, what: &str) -> Result<Option<String>> {
    match args.iter().position(|a| a == name) {
        Some(i) if i + 1 < args.len() => {
            let path = args.remove(i + 1);
            args.remove(i);
            if args.iter().any(|a| a == name) {
                return Err(Error(format!("{name} given twice")));
            }
            Ok(Some(path))
        }
        Some(_) => Err(Error(format!("{name} takes {what}"))),
        None => Ok(None),
    }
}

/// Removes a switch from args; whether it was there.
/// A voice written against a base, whole; any other file as it is.
/// A voice's tensors on its base, and the base's score model, whose clock the voice keeps
/// (ScoreModel::timed_by, as Voice::load_on's); a whole voice's own.
/// A voice's parts kept in files of their own (--vox-part, --mel-part) are joined to it first,
/// its mel decoder's on `route`, the mel route's tensors under mel.; one of `needed` (what the
/// models given speak through) kept apart and not given is refused.
fn based(mut ws: Weights, rest: &mut Vec<String>, route: Option<&Weights>, needed: &[&str]) -> Result<(Weights, Option<ScoreModel>)> {
    for flag in ["--vox-part", "--mel-part"] {
        if let Some(p) = file_flag(rest, flag)? {
            ws.join(Weights::read(&p)?, route).map_err(|e| Error(format!("{flag} {p}: {e}")))?;
        }
    }
    ws.has_parts(needed)?;
    match (ws.needs_base(), file_flag(rest, "--base")?) {
        (true, Some(b)) => {
            let of = |e: Error| Error(format!("--base {b}: {e}"));
            let bw = Weights::read(&b)?;
            Ok((ws.on_base(&bw).map_err(of)?, Some(ScoreModel::load(&bw.under("score.")).map_err(of)?)))
        }
        (true, None) => Err(Error("the voice is written against a base: give it with --base BASE.lsw".into())),
        (false, Some(b)) => Err(Error(format!("--base {b}: the voice is whole"))),
        (false, None) => Ok((ws, None)),
    }
}

fn switch(args: &mut Vec<String>, name: &str) -> Result<bool> {
    match args.iter().filter(|a| *a == name).count() {
        0 => Ok(false),
        1 => {
            args.retain(|a| a != name);
            Ok(true)
        }
        _ => Err(Error(format!("{name} given twice"))),
    }
}

/// Numbers given by flag, each read by its flag's name.
struct Flags<'a> {
    names: &'a [&'a str],
    given: Vec<Option<f64>>,
}

impl Flags<'_> {
    fn get(&self, name: &str) -> Option<f64> {
        let k = self.names.iter().position(|n| *n == name);
        self.given[k.unwrap_or_else(|| panic!("{name}: not a flag read here"))]
    }
}

fn flags<'a>(args: &[String], names: &'a [&'a str]) -> Result<Flags<'a>> {
    let mut out = vec![None; names.len()];
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let k = names
            .iter()
            .position(|n| n == a)
            .ok_or_else(|| Error(format!("{a}: not one of {}", names.join(", "))))?;
        let v = it
            .next()
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| Error(format!("{a} takes a number")))?;
        if out[k].replace(v).is_some() {
            return Err(Error(format!("{a} given twice")));
        }
    }
    Ok(Flags { names, given: out })
}

fn int<T: std::str::FromStr>(arg: Option<&String>, name: &str, default: T) -> Result<T> {
    arg.map_or(Ok(default), |s| {
        s.parse()
            .map_err(|_| Error(format!("{name} {s}: not a whole number")))
    })
}

fn say(args: &[String]) -> Result<()> {
    let t0 = Instant::now();
    let ws = Weights::read(&args[1])?;
    let vw = Weights::read(&args[2])?;
    let route = MelVoc::is(&vw).then(|| vw.under("mel."));
    let (voc, mv, vm) = if Vox::is(&vw) {
        (None, None, Some(vw))
    } else if MelVoc::is(&vw) {
        (None, Some(MelVoc::load(vw)?), None)
    } else {
        (Some(Vocoder::load(&vw)?), None, None)
    };
    let mut ph = phonemizer(&args[3], &args[4])?;
    let (out, text) = (&args[5], &args[6]);
    let mut rest = args[7..].to_vec();
    let (ws, clock) = based(ws, &mut rest, route.as_ref(), if vm.is_some() { &["vox"] } else if mv.is_some() { &["mel"] } else { &[] })?;
    let is_ssml = switch(&mut rest, "--ssml")?;
    let plan_out = file_flag(&mut rest, "--plan")?;
    let (flow, shape) = (
        file_flag(&mut rest, "--pitch")?,
        file_flag(&mut rest, "--sharpen")?,
    );
    let solver = value_flag(&mut rest, "--pitch-solver", "euler or midpoint")?;
    let breaks = match file_flag(&mut rest, "--breaks")? {
        Some(b) => Some(Breaks::load(&Weights::read(&b)?)?),
        None => None,
    };
    let f = flags(
        &rest,
        &[
            "--rate",
            "--shift",
            "--seed",
            "--stream",
            "--pitch-steps",
            "--pitch-temp",
            "--speaker",
            "--widen",
            "--word-pitch",
            "--pauses",
            "--phrase",
            "--pace",
            "--exclaim",
            "--exclaim-lift",
            "--exclaim-tilt",
            "--exclaim-span",
            "--exclaim-rise",
            "--lexical",
            "--pitch-slow",
            "--pitch-widen",
        ],
    )?;
    let (rate, seed) = (f.get("--rate").unwrap_or(1.0), f.get("--seed").unwrap_or(0.0));
    if !(seed >= 0.0 && seed.fract() == 0.0) {
        return Err(Error(format!("--seed {seed}: a whole number")));
    }
    if voc.is_none() && (shape.is_some() || f.get("--widen").is_some()) {
        return Err(Error("--sharpen and --widen go with a vocoder, not the mel route or the latent voice".into()));
    }
    let Parts {
        name,
        score,
        flow,
        sharpen,
        speaker,
        shift,
        centre,
        phrase,
        pace,
        mel,
        pause,
        vox,
    } = parts(&args[1], ws, clock.as_ref(), flow, shape, f.get("--speaker"), f.get("--widen"), f.get("--shift").unwrap_or(0.0))?;
    let vx = vm.map(|m| worn(m, vox, &args[1])).transpose()?;
    let back = match (&voc, &mv, &vx) {
        (Some(v), ..) => Render::Voc(v),
        (_, Some(m), _) => Render::mel(m, mel.as_ref()).with_pauses(pause.as_ref()),
        (_, _, Some(x)) => Render::Vox(x),
        _ => unreachable!(),
    };
    let step = f.get("--stream").unwrap_or(0.0);
    if f.get("--stream").is_some() && !(step >= 1.0 && step.fract() == 0.0) {
        return Err(Error(format!(
            "--stream {step}: a whole number of frames, at least 1"
        )));
    }
    let pitch = match &flow {
        Some(fl) => {
            let d = Sampling::default();
            let steps = f.get("--pitch-steps").unwrap_or(d.steps as f64);
            if !(steps >= 1.0 && steps.fract() == 0.0) {
                return Err(Error(format!(
                    "--pitch-steps {steps}: a whole number, at least 1"
                )));
            }
            let slow = f.get("--pitch-slow").unwrap_or(d.slow as f64);
            if !(slow >= 0.0 && slow.fract() == 0.0) {
                return Err(Error(format!("--pitch-slow {slow}: a whole number of frames, 0 for none")));
            }
            let by = f.get("--pitch-widen").unwrap_or(WIDEN as f64);
            if !(by > 0.0 && by.is_finite()) {
                return Err(Error(format!("--pitch-widen {by}: finite and over 0")));
            }
            let widen = match (by == 1.0, centre) {
                (true, _) => None,
                (false, Some(c)) => Some(Widen { by: by as f32, centre: c }),
                (false, None) => {
                    return Err(Error(format!(
                        "--pitch-widen {by}: widens about the voice's pitch centre (voice.centre), which this one has not; --pitch-widen 1 for none"
                    )))
                }
            };
            let solver = match solver.as_deref() {
                None => d.solver,
                Some("euler") => Solver::Euler,
                Some("midpoint") => Solver::Midpoint,
                Some(s) => return Err(Error(format!("--pitch-solver {s}: euler or midpoint"))),
            };
            Pitch::Flow(
                fl,
                Sampling {
                    solver,
                    steps: steps as usize,
                    temp: f.get("--pitch-temp").unwrap_or(1.0) as f32,
                    seed: seed as u64,
                    slow: slow as usize,
                    widen,
                },
            )
        }
        None if ["--pitch-steps", "--pitch-temp", "--pitch-slow", "--pitch-widen"].iter().any(|n| f.get(n).is_some()) || solver.is_some() => {
            return Err(Error(
                "--pitch-steps, --pitch-temp, --pitch-slow, --pitch-widen and --pitch-solver need a pitch flow".into(),
            ))
        }
        None => Pitch::Head,
    };
    let pitch_desc = name.map_or(String::new(), |n| format!("voice {n}, shift {shift:+.3}, "))
        + &match pitch {
            Pitch::Head => "pitch head".to_string(),
            Pitch::Flow(_, s) => format!(
                "pitch flow, {} {:?} steps, temp {}, slow noise out over {}, {}",
                s.steps,
                s.solver,
                s.temp,
                s.slow,
                s.widen.map_or("not widened".to_string(), |w| format!("widened {} about {:.1} Hz", w.by, w.centre.exp()))
            ),
        }
        + &match (&back, &sharpen) {
            (Render::Voc(_), Some(sh)) => format!(", sharpened, shape x{}", sh.widen),
            (Render::Voc(_), None) => String::new(),
            (Render::Mel(..), Some(_)) => ", mel route (the voice's shape is the envelope's, unused)".to_string(),
            (Render::Mel(..), None) => ", mel route".to_string(),
            (Render::Vox(_), Some(_)) => ", the latent voice (the voice's shape is the envelope's, unused)".to_string(),
            (Render::Vox(_), None) => ", the latent voice".to_string(),
        }
        + match &back {
            Render::Mel(_, _, _, Some(_)) => ", word-final stops told a release",
            _ => "",
        }
        + match (&back, &mel) {
            (Render::Mel(..), Some(_)) => ", the voice's own mel decoder",
            (Render::Voc(_) | Render::Vox(_), Some(_)) => ", the voice's mel decoder unused",
            (_, None) => "",
        }
        + match (&back, &pause) {
            (Render::Mel(..), Some(_)) => ", its speaker's pauses",
            (Render::Voc(_) | Render::Vox(_), Some(_)) => ", its speaker's pauses unused",
            (_, None) => "",
        };
    let sharpen = if matches!(back, Render::Voc(_)) { sharpen } else { None };
    let t1 = Instant::now();
    let pieces = if is_ssml { ssml::pieces(text)? } else { ssml::plain(text)? };
    let phrase = match (&breaks, f.get("--phrase"), phrase) {
        (None, None, _) => None,
        (None, Some(_), _) => return Err(Error("--phrase goes with --breaks".into())),
        (Some(b), Some(r), _) => Some((b, r as f32)),
        (Some(b), None, Some(r)) => Some((b, r)),
        (Some(_), None, None) => {
            return Err(Error("--breaks: the voice has no share of gaps to break at (voice.phrase); give --phrase".into()))
        }
    };
    let pace = match f.get("--pace") {
        Some(p) if !(p > 0.0) => return Err(Error(format!("--pace {p}: above 0"))),
        Some(p) => p as f32,
        None => pace,
    };
    let mut inf = Inflection::new(&mut ph, &pieces)?;
    if let Some((b, r)) = phrase {
        inf.phrase(b, r)?;
    }
    inf.pace = pace;
    for name in ["--word-pitch", "--pauses"] {
        if let Some(k) = f.get(name) {
            if !(k > 0.0) {
                return Err(Error(format!("{name} {k}: above 0")));
            }
        }
    }
    inf.delivery = lipservice::inflect::Delivery {
        word_pitch: f.get("--word-pitch").unwrap_or(1.0) as f32,
        pauses: f.get("--pauses").unwrap_or(1.0) as f32,
    };
    if let Some(k) = f.get("--exclaim") {
        if f.get("--stream").is_some() {
            return Err(Error("--exclaim does not stream".into()));
        }
        inf.exclaim = k as f32;
    }
    for name in ["--exclaim-lift", "--exclaim-tilt", "--exclaim-span", "--exclaim-rise"] {
        if let Some(k) = f.get(name) {
            if f.get("--stream").is_some() {
                return Err(Error(format!("{name} does not stream")));
            }
            let k = k as f32;
            match name {
                "--exclaim-lift" => inf.exclaim_lift = k,
                "--exclaim-tilt" => inf.exclaim_tilt = k,
                "--exclaim-span" => inf.exclaim_span = k,
                _ => inf.exclaim_rise = k,
            }
        }
    }
    if let Some(k) = f.get("--lexical") {
        if f.get("--stream").is_some() {
            return Err(Error("--lexical does not stream".into()));
        }
        inf.lexical = k as f32;
    }
    let tok = &inf.tokens;
    let t_text = Instant::now();
    report!(
        "{}",
        tok.iter()
            .map(|&t| front::symbol(t))
            .collect::<Vec<_>>()
            .join(" ")
    );
    if !ph.guessed.is_empty() {
        let g: Vec<String> = ph
            .guessed
            .iter()
            .map(|(w, p)| format!("{w}: {}", p.join(" ")))
            .collect();
        report!("from the G2P: {}", g.join("; "));
    }
    if step != 0.0 {
        if inf.delivery != lipservice::inflect::Delivery::default() {
            return Err(Error("--word-pitch and --pauses need the whole utterance; they do not stream".into()));
        }
        let t2 = t_text;
        let mut st = Passage::new(
            &score,
            back,
            &mut ph,
            &pieces,
            speaker,
            rate as f32,
            shift as f32,
            pitch,
            seed as u64,
            sharpen.as_ref(),
            phrase,
            pace,
        )?;
        let t3 = Instant::now();
        let (mut y, mut first, mut steps) = (Vec::new(), None, 0);
        let mut plan = String::new();
        let part = |st: &Passage| -> Result<String> {
            let (s, (lf0, vuv), (gain, tilt)) = (st.stream(), st.stream().pitch(), st.stream().loudness());
            let tilt = if matches!(back, Render::Voc(_)) { &[] } else { tilt };
            plan_part(st.gap(), &st.inflection().tokens, s.durations(), lf0, vuv, gain, tilt)
        };
        while !st.done() {
            if st.stream().done() {
                plan += &part(&st)?;
            }
            st.step(step as usize, &mut y)?;
            steps += 1;
            if first.is_none() && !y.is_empty() {
                first = Some((Instant::now(), st.stream().fed(), y.len()));
            }
        }
        let t4 = Instant::now();
        lipservice::wav::write(out, &y, SR as u32)?;
        if let Some(p) = &plan_out {
            write_text(p, &(plan + &part(&st)?))?;
        }
        let secs = y.len() as f64 / SR as f64;
        let (tf, fed, got) = first.unwrap();
        let ms = |a: Instant, b: Instant| (b - a).as_secs_f64() * 1e3;
        report!(
            "{out}: {secs:.2} s, {} parts in {steps} steps of {step} frames, {pitch_desc}; load {:.1} ms, text {:.1} ms, first part {:.1} ms; first audio {:.1} ms after the text ({got} samples, {fed} frames in); all {:.1} ms; rtf {:.4}",
            st.parts(),
            ms(t0, t1),
            ms(t1, t2),
            ms(t2, t3),
            ms(t1, tf),
            ms(t1, t4),
            (t4 - t1).as_secs_f64() / secs
        );
        return Ok(());
    }
    let t2 = t_text;
    let (y, frames, t3) = match back {
        Render::Voc(voc) => {
            let (mut s, edits) = inflect::infer(&score, &inf, speaker, rate as f32, shift as f32, pitch)?;
            if let Some(sh) = &sharpen {
                s.frames.env = sh.apply(speaker, &s.frames.env);
            }
            edits.gain(&mut s.frames.env, 0);
            if let Some(p) = &plan_out {
                write_plan(p, &inf.tokens, &edits.durations, &s.frames.lf0, &s.frames.vuv, &edits.gain, &[])?;
            }
            let t3 = Instant::now();
            let noise = Rng::new(seed as u64).gaussian(s.frames.len() * HOP);
            (voc.render(&s.frames, &noise)?, s.frames.len(), t3)
        }
        Render::Mel(md, vc, bank, rel) => {
            if md.cin() != score.dim() {
                return Err(Error(format!("the mel decoder takes token states of {}, the score model gives {}", md.cin(), score.dim())));
            }
            let p = inflect::plan(&score, &inf, speaker, rate as f32, shift as f32, pitch)?;
            if let Some(f) = &plan_out {
                write_plan(f, &inf.tokens, &p.edits.durations, &p.lf0, &p.vuv, &p.edits.gain, &p.edits.tilt)?;
            }
            let told = rel.map(|_| Release::told(&inf.tokens, &p.edits.durations));
            let mut mel = md.forward(&p.hx, &p.lf0, &p.vuv, rel.zip(told.as_deref()))?;
            p.edits.gain_mel(&mut mel, 0);
            if let Some(b) = bank {
                pause::whole(b, &inf.tokens, &p.edits.durations, seed as u64, &mut mel)?;
            }
            let t3 = Instant::now();
            (vc.render(&mel)?, p.lf0.len(), t3)
        }
        Render::Vox(v) => {
            let p = inflect::plan(&score, &inf, speaker, rate as f32, shift as f32, pitch)?;
            if let Some(f) = &plan_out {
                write_plan(f, &inf.tokens, &p.edits.durations, &p.lf0, &p.vuv, &p.edits.gain, &p.edits.tilt)?;
            }
            let t3 = Instant::now();
            let hiss = lipservice::vox::hisses(&inf.tokens);
            let close = lipservice::vox::closes(&inf.tokens);
            let part = Plan { h: &p.states, dur: &p.edits.durations, hiss: &hiss, close: &close, lf0: &p.lf0, told: &[], vuv: &p.vuv, gain: &p.edits.gain, tilt: &p.edits.tilt, breath: &[] };
            (v.render(&part, Noise::draw(seed as u64, part.frames(), v.zdim()))?, part.frames(), t3)
        }
    };
    let t4 = Instant::now();
    lipservice::wav::write(out, &y, SR as u32)?;
    let secs = y.len() as f64 / SR as f64;
    let ms = |a: Instant, b: Instant| (b - a).as_secs_f64() * 1e3;
    report!(
        "{out}: {secs:.2} s, {} frames, {pitch_desc}; load {:.1} ms, text {:.1} ms, score {:.1} ms, vocoder {:.1} ms; rtf {:.4} (one thread, after load)",
        frames,
        ms(t0, t1),
        ms(t1, t2),
        ms(t2, t3),
        ms(t3, t4),
        (t4 - t1).as_secs_f64() / secs
    );
    Ok(())
}

/// A voice file's parts, or a score model's with the parts given by flag.
struct Parts {
    name: Option<String>,
    score: ScoreModel,
    flow: Option<PitchFlow>,
    sharpen: Option<Sharpen>,
    speaker: usize,
    shift: f64,
    centre: Option<f32>,
    phrase: Option<f32>,
    pace: f32,
    mel: Option<MelDec>,
    pause: Option<PauseBank>,
    vox: Option<Wearer>,
}

fn parts(
    path: &str,
    ws: Weights,
    clock: Option<&ScoreModel>,
    flow: Option<String>,
    shape: Option<String>,
    speaker: Option<f64>,
    widen: Option<f64>,
    shift: f64,
) -> Result<Parts> {
    if Voice::is(&ws) {
        if flow.is_some() || shape.is_some() || speaker.is_some() {
            return Err(Error(format!(
                "{path}: a voice file brings its own pitch, sharpening and speaker"
            )));
        }
        let v = Voice::load(ws, widen.map(|w| w as f32))?;
        if widen.is_some() && v.sharpen.is_none() {
            return Err(Error(format!(
                "--widen: voice {} has no shape to sharpen with",
                v.name
            )));
        }
        let shift = v.shift as f64 + shift;
        return Ok(Parts {
            name: Some(v.name),
            score: match clock {
                Some(base) => v.score.timed_by(base),
                None => v.score,
            },
            flow: v.flow,
            sharpen: v.sharpen,
            speaker: 0,
            shift,
            centre: v.centre,
            phrase: v.phrase,
            pace: v.pace,
            mel: v.mel,
            pause: v.pause,
            vox: v.vox,
        });
    }
    let w = widen.unwrap_or(1.3) as f32;
    let score = ScoreModel::load(&ws)?;
    let speaker = speaker.unwrap_or(0.0);
    if !(speaker >= 0.0 && speaker.fract() == 0.0 && (speaker as usize) < score.speakers()) {
        return Err(Error(format!(
            "--speaker {speaker}: the score model has speakers 0 to {}",
            score.speakers() - 1
        )));
    }
    let speaker = speaker as usize;
    let flow = match flow {
        Some(path) => Some(PitchFlow::load(&Weights::read(&path)?)?),
        None => None,
    };
    let sharpen = match shape {
        Some(path) => {
            let sh = Sharpen::load(&Weights::read(&path)?, score.speakers(), w, 1.0, 1.0)?;
            sh.check(speaker)?;
            Some(sh)
        }
        None if widen.is_some() => return Err(Error("--widen needs --sharpen".into())),
        None => None,
    };
    Ok(Parts {
        name: None,
        score,
        flow,
        sharpen,
        speaker,
        shift,
        centre: None,
        phrase: None,
        pace: 1.0,
        mel: None,
        pause: None,
        vox: None,
    })
}

/// The style sing's flags give.
fn style_of(f: &Flags, diction: bool, motion: Option<Motion>, seed: u64) -> Result<Style> {
    let glide = f.get("--glide").unwrap_or(9.0);
    if !(glide >= 1.0 && glide.fract() == 0.0) {
        return Err(Error(format!(
            "--glide {glide}: a whole number of frames, at least 1"
        )));
    }
    let style = Style {
        shift: f.get("--shift").unwrap_or(0.0) as f32,
        vibrato: f.get("--vibrato").unwrap_or(0.25) as f32,
        vibrato_hz: f.get("--vibrato-hz").unwrap_or(5.5) as f32,
        vibrato_delay: f.get("--vibrato-delay").unwrap_or(0.25) as f32,
        vibrato_ramp: 0.2,
        glide: glide as usize,
        dynamics: f.get("--dynamics").unwrap_or(0.0) as f32,
        consonants: f.get("--consonants").unwrap_or(1.0) as f32,
        breathiness: f.get("--breathiness").unwrap_or(1.0) as f32,
        diction,
        motion,
        motion_scale: f.get("--motion-scale").unwrap_or(1.0) as f32,
        seed,
    };
    if !(style.motion_scale >= 0.0 && style.motion_scale.is_finite()) {
        return Err(Error(format!("--motion-scale {}: 0 or more", style.motion_scale)));
    }
    if f.get("--motion-scale").is_some() && style.motion.is_none() {
        return Err(Error("--motion-scale goes with --motion".into()));
    }
    if !(style.consonants > 0.0 && style.consonants.is_finite()) {
        return Err(Error(format!(
            "--consonants {}: more than 0",
            style.consonants
        )));
    }
    if !(style.breathiness >= 0.0 && style.breathiness.is_finite()) {
        return Err(Error(format!(
            "--breathiness {}: 0 or more",
            style.breathiness
        )));
    }
    if !(style.dynamics >= 0.0 && style.dynamics.is_finite()) {
        return Err(Error(format!("--dynamics {}: 0 or more", style.dynamics)));
    }
    Ok(style)
}

fn sing(args: &[String]) -> Result<()> {
    let ws = Weights::read(&args[1])?;
    let vw = Weights::read(&args[2])?;
    if MelVoc::is(&vw) {
        return Err(Error(format!("{}: a mel route; sing renders through a vocoder or the latent voice", args[2])));
    }
    let (voc, vm) = if Vox::is(&vw) { (None, Some(vw)) } else { (Some(Vocoder::load(&vw)?), None) };
    let mut ph = phonemizer(&args[3], &args[4])?;
    let out = &args[5];
    let song = Song::parse(
        &std::fs::read_to_string(&args[6]).map_err(|e| Error(format!("{}: {e}", args[6])))?,
    )
    .map_err(|e| Error(format!("{}: {}", args[6], e.0)))?;
    let mut rest = args[7..].to_vec();
    let (ws, clock) = based(ws, &mut rest, None, if vm.is_some() { &["vox"] } else { &[] })?;
    let diction = switch(&mut rest, "--diction")?;
    let shape = file_flag(&mut rest, "--sharpen")?;
    let frames_out = file_flag(&mut rest, "--frames")?;
    let plan_out = file_flag(&mut rest, "--plan")?;
    let motion = file_flag(&mut rest, "--motion")?
        .map(|p| Motion::load(&Weights::read(&p)?))
        .transpose()?;
    let f = flags(
        &rest,
        &[
            "--shift",
            "--seed",
            "--speaker",
            "--widen",
            "--vibrato",
            "--vibrato-hz",
            "--vibrato-delay",
            "--glide",
            "--dynamics",
            "--ring",
            "--consonants",
            "--breathiness",
            "--motion-scale",
        ],
    )?;
    let seed = f.get("--seed").unwrap_or(0.0);
    if !(seed >= 0.0 && seed.fract() == 0.0) {
        return Err(Error(format!("--seed {seed}: a whole number")));
    }
    if voc.is_none() && (shape.is_some() || f.get("--widen").is_some() || f.get("--ring").is_some()) {
        return Err(Error("--sharpen, --widen and --ring go with a vocoder, not the latent voice".into()));
    }
    // the notes set the pitch: a voice's register shift does not apply
    let Parts {
        name,
        score,
        sharpen,
        speaker,
        vox,
        ..
    } = parts(&args[1], ws, clock.as_ref(), None, shape, f.get("--speaker"), f.get("--widen"), 0.0)?;
    let vx = vm.map(|m| worn(m, vox, &args[1])).transpose()?;
    let style = style_of(&f, diction, motion, seed as u64)?;
    let ring = f.get("--ring").unwrap_or(0.0) as f32;
    if !(ring >= 0.0 && ring.is_finite()) {
        return Err(Error(format!("--ring {ring}: 0 or more dB")));
    }
    let t1 = Instant::now();
    // the song as sung: tokens, durations, log F0, voicing, the plan's loudness and tilt, notes,
    // the pitch head's counts (sing::voicing), the samples
    let (tokens, durations, lf0, vuv, edits, notes, n, y) = match (&voc, &vx) {
        (Some(voc), _) => {
            let mut s = lipservice::sing::sing(&score, &mut ph, &song, speaker, &style)?;
            if let Some(sh) = &sharpen {
                s.score.frames.env = sh.apply(speaker, &s.score.frames.env);
            }
            lipservice::sing::louden(&mut s.score.frames.env, &s.gain);
            lipservice::sing::ring(&mut s.score.frames.env, &s.sung, ring);
            let noise = Rng::new(seed as u64).gaussian(s.score.frames.len() * HOP);
            let y = voc.render(&s.score.frames, &noise)?;
            let n = [s.vowel_frames, s.vowel_voiced, s.voiceless_frames, s.voiceless_voiced];
            // the envelope's dynamics and ring are not a plan's edits
            let edits = (style.dynamics == 0.0 && ring == 0.0).then_some((Vec::new(), Vec::new()));
            (s.tokens, s.score.durations, s.score.frames.lf0, s.score.frames.vuv, edits, s.notes, n, y)
        }
        (None, Some(v)) => {
            let p = lipservice::sing::plan(&score, &mut ph, &song, speaker, &style)?;
            let (vuv, n) = lipservice::sing::voicing(&score, &score.expand(&p.h, &p.durations), &p);
            let (gain, tilt) = lipservice::sing::loudness(&p.gain, &p.quiet);
            let hiss = lipservice::vox::hisses(&p.tokens);
            let close = lipservice::vox::closes(&p.tokens);
            let part = Plan { h: &p.states, dur: &p.durations, hiss: &hiss, close: &close, lf0: &p.lf0, told: &p.told, vuv: &vuv, gain: &gain, tilt: &tilt, breath: &p.breath };
            let y = v.render(&part, Noise::draw(seed as u64, part.frames(), v.zdim()))?;
            (p.tokens, p.durations, p.lf0, vuv, Some((gain, tilt)), p.notes, n, y)
        }
        (None, None) => unreachable!(),
    };
    let t2 = Instant::now();
    lipservice::wav::write(out, &y, SR as u32)?;
    if let Some(p) = &frames_out {
        let text: String = lf0.iter().zip(&vuv).map(|(l, v)| format!("{l}\t{v}\n")).collect();
        std::fs::write(p, format!("lf0\tvuv\n{text}")).map_err(|e| Error(format!("{p}: {e}")))?;
    }
    if let Some(p) = &plan_out {
        let Some((gain, tilt)) = &edits else {
            return Err(Error("through a vocoder, --plan carries neither --dynamics nor --ring".into()));
        };
        write_plan(p, &tokens, &durations, &lf0, &vuv, gain, tilt)?;
    }
    report!(
        "{}",
        tokens
            .iter()
            .zip(&durations)
            .map(|(&t, d)| format!("{}:{d}", front::symbol(t)))
            .collect::<Vec<_>>()
            .join(" ")
    );
    report!(
        "{}",
        notes
            .iter()
            .map(|(w, m, r)| format!("{w} {m} {}-{}", r.start, r.end))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let secs = y.len() as f64 / SR as f64;
    report!(
        "{out}: {secs:.2} s, {} frames, {}{}; the pitch head voiced {} of {} vowel frames (all sung voiced) and {} of {} voiceless consonant frames (none sung voiced); rtf {:.4} (one thread, after load)",
        lf0.len(),
        name.map_or(String::new(), |n| format!("voice {n}, ")),
        match (&vx, &sharpen) {
            (Some(_), _) => "the latent voice",
            (None, Some(_)) => "sharpened",
            (None, None) => "unsharpened",
        },
        n[1],
        n[0],
        n[3],
        n[2],
        (t2 - t1).as_secs_f64() / secs
    );
    Ok(())
}

fn read_text(path: &str) -> Result<String> {
    std::fs::read_to_string(path).map_err(|e| Error(format!("{path}: {e}")))
}

fn roll(args: &[String]) -> Result<()> {
    let mut ph = phonemizer(&args[1], &args[2])?;
    let mut rest = args[6..].to_vec();
    let diction = switch(&mut rest, "--diction")?;
    let join = flags(&rest, &["--join"])?.get("--join").unwrap_or(0.0);
    let (mut bpm, mut keys, mut pedal) = (None, Vec::new(), Vec::new());
    for (i, raw) in read_text(&args[3])?.lines().enumerate() {
        let at = |what: &str| Error(format!("{}, line {}: {what}", args[3], i + 1));
        let f: Vec<&str> = raw.split_whitespace().collect();
        let num = |s: &str| s.parse::<f64>().map_err(|_| at(&format!("{s}: not a number")));
        match f[..] {
            [] => {}
            [c, ..] if c.starts_with('#') => {}
            ["bpm", v] if bpm.is_none() => bpm = Some(num(v)?),
            ["bpm", ..] => return Err(at("bpm takes one number, once")),
            ["vibrato", beat, size] => pedal.push((num(beat)?, num(size)?)),
            ["vibrato", ..] => return Err(at("the pedal is vibrato BEAT SIZE")),
            [note, start, beats] => keys.push(Key { pitch: lipservice::sing::midi(note).map_err(|e| at(&e.0))?, start: num(start)?, beats: num(beats)? }),
            _ => return Err(at("a note is NOTE START BEATS")),
        }
    }
    let bpm = bpm.ok_or_else(|| Error(format!("{}: no bpm line", args[3])))?;
    let song = part::roll(bpm, 0.0, &keys, &read_text(&args[4])?, &pedal, join, &mut |items, k| part::syllables(&mut ph, diction, items, k))?;
    write_text(&args[5], &song)?;
    println!("{}: {} notes under {} words", args[5], keys.len(), song.lines().filter(|l| !l.starts_with("bpm ") && !l.starts_with("rest ")).count());
    Ok(())
}

fn perform(args: &[String]) -> Result<()> {
    let ws = Weights::read(&args[1])?;
    let vw = Weights::read(&args[2])?;
    if MelVoc::is(&vw) {
        return Err(Error(format!("{}: a mel route; perform renders through a vocoder or the latent voice", args[2])));
    }
    let (voc, vm) = if Vox::is(&vw) { (None, Some(vw)) } else { (Some(Vocoder::load(&vw)?), None) };
    let mut ph = phonemizer(&args[3], &args[4])?;
    let out = &args[5];
    let text = read_text(&args[6])?;
    let mut rest = args[7..].to_vec();
    let (ws, clock) = based(ws, &mut rest, None, if vm.is_some() { &["vox"] } else { &[] })?;
    let diction = switch(&mut rest, "--diction")?;
    let dry = switch(&mut rest, "--dry")?;
    let together = switch(&mut rest, "--together")?;
    let performed = file_flag(&mut rest, "--performed")?;
    let lib = file_flag(&mut rest, "--breaths")?.map(|p| part::breaths(&p)).transpose()?;
    let sex = value_flag(&mut rest, "--sex", "F or M")?;
    let motion = file_flag(&mut rest, "--motion")?.map(|p| Motion::load(&Weights::read(&p)?)).transpose()?;
    let f = flags(
        &rest,
        &[
            "--shift", "--seed", "--vibrato", "--vibrato-hz", "--vibrato-delay", "--glide", "--dynamics", "--consonants", "--breathiness",
            "--motion-scale", "--at", "--jitter", "--detune", "--spread", "--breath", "--give",
        ],
    )?;
    let seed = f.get("--seed").unwrap_or(0.0);
    if !(seed >= 0.0 && seed.fract() == 0.0 && seed <= u32::MAX as f64) {
        return Err(Error(format!("--seed {seed}: a whole number")));
    }
    let seed = seed as u64;
    let some = |name: &str, what: &str| -> Result<f64> {
        let v = f.get(name).unwrap_or(0.0);
        if v >= 0.0 && v.is_finite() { Ok(v) } else { Err(Error(format!("{name} {v}: 0 or more {what}"))) }
    };
    let (at, jitter, detune, spread) = (some("--at", "seconds")?, some("--jitter", "frames")?, some("--detune", "cents")?, some("--spread", "seconds")?);
    if jitter.fract() != 0.0 {
        return Err(Error(format!("--jitter {jitter}: a whole number of frames")));
    }
    let (sex, breath) = match (&lib, sex, f.get("--breath")) {
        (Some(_), Some(s), Some(b)) if b > 0.0 && b <= 1.0 && (s == "F" || s == "M") => (s.chars().next().unwrap(), b),
        (Some(_), Some(s), Some(b)) => return Err(Error(format!("--breath {b} --sex {s}: a chance over 0, up to 1, and F or M"))),
        (None, None, None) => ('F', 0.0), // no breath is drawn
        _ => return Err(Error("--breaths, --breath and --sex go together".into())),
    };
    let give = f.get("--give");
    if give.is_some_and(|g| !(g > 0.0 && g <= 1.0)) {
        return Err(Error(format!("--give {}: a share over 0, up to 1", give.unwrap())));
    }
    // check the flags before the song is planned
    style_of(&f, diction, motion.clone(), seed)?;
    // the notes set the pitch: a voice's register shift does not apply
    let Parts { name, score, sharpen, speaker, vox, .. } = parts(&args[1], ws, clock.as_ref(), None, None, None, None, 0.0)?;
    let vx = vm.map(|m| worn(m, vox, &args[1])).transpose()?;
    let asked = Part { song: &text, sex, seed, at, shift: f.get("--shift").unwrap_or(0.0), jitter, detune, spread, breath };
    let t1 = Instant::now();
    let p = part::perform_as(&asked, Manner { together, give }, lib.as_ref().map(|l| &l.0), |text, shift| {
        let style = Style { shift: shift as f32, ..style_of(&f, diction, motion.clone(), seed)? };
        let song = if together { Song::parse(&part::clocked(text)?)? } else { Song::parse(text)? };
        let plan = lipservice::sing::plan(&score, &mut ph, &song, speaker, &style)?;
        let rests = plan.rests();
        Ok((plan, rests))
    })
    .map_err(|e| Error(format!("{}: {}", args[6], e.0)))?;
    if let Some(path) = &performed {
        write_text(path, &p.text)?;
    }
    let clip = |c: usize| &lib.as_ref().unwrap().0.clips[c];
    println!("breaths{}", p.breaths.iter().map(|&(c, at)| format!(" {}@{at}", clip(c).id)).collect::<String>());
    println!("lag {}", p.lag);
    println!("shift {}", p.shift);
    if dry {
        return Ok(());
    }
    let (frames, mut y) = (p.singer.lf0.len(), Vec::new());
    let (render, sharpen) = match (&voc, &vx) {
        (Some(v), _) => (Render::Voc(v), sharpen.as_ref()),
        (None, Some(x)) => (Render::Vox(x), None),
        (None, None) => unreachable!(),
    };
    let mut st = Stream::sung(&score, render, p.singer, speaker, None, seed, sharpen)?;
    while !st.done() {
        st.step(usize::MAX, &mut y);
    }
    for &(c, at) in &p.breaths {
        let (c, pcm) = (clip(c), &lib.as_ref().unwrap().1);
        let (lo, hi) = (at.max(0), (at + c.n as i64).min(y.len() as i64));
        for s in lo..hi {
            y[s as usize] += pcm[c.at + (s - at) as usize] as f32 / 32767.0;
        }
    }
    let t2 = Instant::now();
    lipservice::wav::write(out, &y, SR as u32)?;
    let secs = y.len() as f64 / SR as f64;
    println!(
        "{out}: {secs:.2} s, {frames} frames, {}{}, {} breaths; rtf {:.4} (one thread, after load)",
        name.map_or(String::new(), |n| format!("voice {n}, ")),
        if vx.is_some() { "the latent voice" } else { "a vocoder" },
        p.breaths.len(),
        (t2 - t1).as_secs_f64() / secs
    );
    Ok(())
}

fn run(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("vocode") if matches!(args.len(), 4 | 5) => {
            let voc = Vocoder::load(&Weights::read(&args[1])?)?;
            let f = frames(&args[2])?;
            let seed: u64 = int(args.get(4), "SEED", 0)?;
            let noise = Rng::new(seed).gaussian(f.len() * HOP);
            let y = voc.render(&f, &noise)?;
            lipservice::wav::write(&args[3], &y, SR as u32)?;
            println!("{}: {:.2} s", args[3], y.len() as f64 / SR as f64);
            Ok(())
        }
        Some("bench") if matches!(args.len(), 3 | 4) => {
            let voc = Vocoder::load(&Weights::read(&args[1])?)?;
            let f = frames(&args[2])?;
            let reps: usize = int(args.get(3), "REPS", 10)?;
            let secs = f.len() as f64 * HOP as f64 / SR as f64;
            let noise = Rng::new(0).gaussian(f.len() * HOP);
            let f0: Vec<f32> = f.lf0.iter().map(|v| v.exp()).collect();
            let time = |label: &str, g: &mut dyn FnMut()| {
                g();
                let t0 = Instant::now();
                for _ in 0..reps {
                    g();
                }
                let dt = t0.elapsed().as_secs_f64() / reps as f64;
                println!("{label:>16}: {:8.3} ms  rtf {:.5}", dt * 1e3, dt / secs);
            };
            println!(
                "{} frames, {secs:.2} s of audio, {} layers, one thread",
                f.len(),
                voc.layers()
            );
            time("harmonic source", &mut || {
                std::hint::black_box(dsp::harmonic_source(&f0, &f.vuv));
            });
            time("filter shapes", &mut || {
                std::hint::black_box(voc.shapes(&f).unwrap());
            });
            time("render (all)", &mut || {
                std::hint::black_box(voc.render(&f, &noise).unwrap());
            });
            Ok(())
        }
        Some("tokens") if args.len() == 3 => {
            let mut ph = phonemizer(&args[1], &args[2])?;
            for line in std::io::stdin().lines() {
                let line = line.map_err(|e| Error(format!("stdin: {e}")))?;
                let t = ph.encode(&line)?;
                println!(
                    "{}",
                    t.iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join(" ")
                );
            }
            Ok(())
        }
        Some("g2p") if args.len() == 2 => {
            let g = G2p::load(&Weights::read(&args[1])?)?;
            let (t0, mut n) = (Instant::now(), 0);
            for line in std::io::stdin().lines() {
                let w = line.map_err(|e| Error(format!("stdin: {e}")))?;
                match g.phones(&w) {
                    Ok(p) => println!("{w}\t{}", p.join(" ")),
                    Err(e) => println!("{w}\t!error {e}"),
                }
                n += 1;
            }
            eprintln!(
                "{n} words, {:.3} ms a word",
                t0.elapsed().as_secs_f64() * 1e3 / n.max(1) as f64
            );
            Ok(())
        }
        // the simple forms: a text or a song, no model files named
        Some("say" | "sing") if args.get(1).is_some_and(|a| !a.ends_with(".lsw")) => {
            QUIET.store(true, Ordering::Relaxed);
            simple::speak(&args[0], args, |e| if e[0] == "say" { say(e) } else { sing(e) })
        }
        Some("voices") => simple::voices(args),
        Some("fetch") => simple::fetch(args),
        Some("--version") if args.len() == 1 => {
            println!("lipservice {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("say") if args.len() >= 7 => say(args),
        Some("sing") if args.len() >= 7 => sing(args),
        Some("roll") if args.len() >= 6 => roll(args),
        Some("perform") if args.len() >= 7 => perform(args),
        Some("vox") if args.len() >= 5 => vox(args),
        Some("words") if args.len() == 1 || (args.len() == 2 && args[1] == "-0") => {
            let texts: Vec<String> = if args.len() == 2 {
                let mut all = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut all).map_err(|e| Error(format!("stdin: {e}")))?;
                all.split('\0').map(String::from).collect()
            } else {
                std::io::stdin().lines().collect::<std::io::Result<_>>().map_err(|e| Error(format!("stdin: {e}")))?
            };
            for text in texts {
                match lipservice::front::words_and_stops(&text) {
                    Ok(w) if w.iter().any(|t| t.is_empty() || t.contains(' ')) => println!("!error a word with a space in {w:?}"),
                    Ok(w) => println!("{}", w.join(" ")),
                    Err(e) => println!("!error {}", e.to_string().replace('\n', " ")),
                }
            }
            Ok(())
        }
        None | Some("--help" | "-h" | "help") => {
            eprintln!("{}", simple::USAGE);
            std::process::exit(2)
        }
        _ => {
            eprintln!("{}\n\nThe engine's own forms, with every model file named:\n{USAGE}", simple::USAGE);
            std::process::exit(2)
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = run(&args) {
        eprintln!("lipservice: {e}");
        std::process::exit(1);
    }
}
