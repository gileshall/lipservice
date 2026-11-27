// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The engine for the browser: a C ABI over wasm32 memory (web/lipservice.js drives it). Voices,
//! the vocoder, the mel route, the latent voice and the phonemizer load from bytes and live as long
//! as the instance. Speech streams a step of frames at a time, through the mel route once one is
//! loaded and the vocoder until then; a song renders whole, through the vocoder, or a step at a
//! time, any number of songs at once (ls_sing_open), each in its own style, a trained singers'
//! pitch motion (ls_motion) among it. With the latent voice loaded (ls_vox, before any voice),
//! speech and songs go through it instead, as each voice wears it; a voice without its parts of it
//! is then an error. Once a break model is loaded (ls_breaks), speech is phrased where a reader
//! would break, at each voice's own share of word gaps (voice.phrase); a voice without one is then
//! an error. Speech goes at each voice's speaker's pace (voice.pace). One voice heard alone (speech,
//! a song sung alone) goes out through ls_alone: a song let down to speech's level, then held under
//! the ceiling; what it is given is as made. A call that fails returns -1 and leaves its message at
//! ls_error.

use std::cell::RefCell;
use std::rc::Rc;

use lipservice::alone::Alone;
use lipservice::room::{Room, STAGES, TRACE_RING};
use lipservice::breaks::Breaks;
use lipservice::choir::{self, Arranged, MixPart, Mixer, Reflection, Seat};
use lipservice::json::Json;
use lipservice::part::Library;
use lipservice::diction::{Rules, Who, DIPPED, PLAIN, SUNG};
use lipservice::dsp::HOP;
use lipservice::front::Phonemizer;
use lipservice::g2p::G2p;
use lipservice::lexicon::Lexicon;
use lipservice::melvoc::MelVoc;
use lipservice::passage::Passage;
use lipservice::pitchflow::{Sampling, Widen, WIDEN};
use lipservice::rng::Rng;
use lipservice::score::Pitch;
use lipservice::sing::{self, Motion, Plan, Song, Style};
use lipservice::ssml;
use lipservice::stream::{Render, Stream};
use lipservice::vocoder::Vocoder;
use lipservice::voice::{Base, Voice};
use lipservice::vox::{Model, Vox};
use lipservice::weights::{Error, Result, Weights};

#[derive(Default)]
struct State {
    bases: Vec<Base>,
    voices: Vec<&'static Voice>,
    /// The latent voice, and each voice's wearing of it.
    vox: Option<Rc<Model>>,
    worn: Vec<Option<&'static Vox>>,
    voc: Option<&'static Vocoder>,
    mel: Option<&'static MelVoc>,
    /// The mel route's tensors under mel., which a voice's mel decoder in a file of its own takes
    /// what it leaves out from.
    mel_shared: Option<Weights>,
    breaks: Option<&'static Breaks>,
    ph: Option<Phonemizer>,
    stream: Option<Passage<'static>>,
    /// What the passage being said has said when (lipservice::timing), its parts as each is done.
    told: lipservice::timing::Told,
    motions: Vec<Motion>,
    singers: Vec<Option<Singer>>,
    alone: Vec<Option<Alone>>,
    rooms: Vec<Option<Room>>,
    mixers: Vec<Option<Mixer>>,
    /// The breaths a choir's singers take (ls_breaths): the clips and their sound.
    breaths: Option<(Library, Vec<i16>)>,
    out: Vec<f32>,
    info: String,
    error: String,
}

struct Singer {
    v: &'static Voice,
    render: Render<'static>,
    seed: u64,
    plan: Plan,
    /// The frame the next samples are the song's from, and the stream giving them once any are asked for.
    from: usize,
    st: Option<Stream<'static>>,
    /// The silent spans, frames: start, end, start, end...
    rests: Vec<f32>,
    /// The breaths it takes (ls_perform): a clip of the loaded breaths and the sample of the song
    /// it starts at.
    breaths: Vec<(usize, i64)>,
    /// The sample of the song the next step's first is.
    pos: usize,
    /// The song's words and tempo, for its timing.
    words: Vec<String>,
    bpm: f32,
    /// The song's diction, its rules as lines.
    rules: Vec<String>,
}

impl Singer {
    fn stream(&mut self) -> Result<&mut Stream<'static>> {
        if self.st.is_none() {
            let sharpen = match self.render {
                Render::Voc(_) => self.v.sharpen.as_ref(),
                _ => None,
            };
            self.st = Some(Stream::sung_from(&self.v.score, self.render, &self.plan, 0, None, self.seed, sharpen, self.from)?);
        }
        Ok(self.st.as_mut().unwrap())
    }
}

thread_local! {
    static S: RefCell<State> = RefCell::new(State::default());
}

fn bytes<'a>(p: *const u8, n: usize) -> &'a [u8] {
    // SAFETY: the caller hands a range it allocated with ls_alloc and filled.
    unsafe { std::slice::from_raw_parts(p, n) }
}

fn text<'a>(p: *const u8, n: usize) -> Result<&'a str> {
    std::str::from_utf8(bytes(p, n)).map_err(|_| Error("the text is not utf-8".into()))
}

fn run(f: impl FnOnce(&mut State) -> Result<i32>) -> i32 {
    S.with(|s| {
        let mut s = s.borrow_mut();
        match f(&mut s) {
            Ok(v) => v,
            Err(Error(e)) => {
                s.error = e;
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn ls_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn ls_free(p: *mut u8, n: usize) {
    // SAFETY: p and n are an allocation from ls_alloc.
    drop(unsafe { Vec::from_raw_parts(p, 0, n) });
}

#[no_mangle]
pub extern "C" fn ls_error() -> *const u8 {
    S.with(|s| s.borrow().error.as_ptr())
}

#[no_mangle]
pub extern "C" fn ls_error_len() -> usize {
    S.with(|s| s.borrow().error.len())
}

/// The samples of the last step or song.
#[no_mangle]
pub extern "C" fn ls_out() -> *const f32 {
    S.with(|s| s.borrow().out.as_ptr())
}

/// The text of the last ls_say_info, utf-8.
#[no_mangle]
pub extern "C" fn ls_info() -> *const u8 {
    S.with(|s| s.borrow().info.as_ptr())
}

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// A base that voices are written against: its index.
#[no_mangle]
pub extern "C" fn ls_base(p: *const u8, n: usize) -> i32 {
    run(|s| {
        s.bases.push(Base::load(Weights::parse(bytes(p, n))?)?);
        Ok(s.bases.len() as i32 - 1)
    })
}

/// A voice file, on base `base` (from ls_base) or whole (-1): its index.
#[no_mangle]
pub extern "C" fn ls_voice(p: *const u8, n: usize, base: i32) -> i32 {
    ls_voice_parts(p, n, base, std::ptr::null(), 0, std::ptr::null(), 0)
}

/// As ls_voice, with the voice's parts kept in files of their own (tools/split.py), a length of 0
/// for one not given: its parts of the latent voice, which that route alone reads, and its mel
/// decoder, which speech on the mel route alone goes through (so after ls_melvoc).
#[no_mangle]
pub extern "C" fn ls_voice_parts(p: *const u8, n: usize, base: i32, vp: *const u8, vn: usize, mp: *const u8, mn: usize) -> i32 {
    run(|s| {
        let mut ws = Weights::parse(bytes(p, n))?;
        if vn > 0 {
            if s.vox.is_none() {
                return Err(Error("a voice's parts of the latent voice, and the latent voice is not loaded".into()));
            }
            ws.join(Weights::parse(bytes(vp, vn))?, None)?;
        }
        if mn > 0 {
            ws.join(Weights::parse(bytes(mp, mn))?, s.mel_shared.as_ref())?;
        }
        ws.has_parts(match (&s.vox, &s.mel) {
            (Some(_), _) => &["vox"],
            (None, Some(_)) => &["mel"],
            (None, None) => &[],
        })?;
        // with the latent voice loaded, nothing speaks through a voice's mel decoder or its pauses
        let mel = s.vox.is_none();
        let mut v = match (ws.needs_base(), base) {
            (false, -1) => {
                if !Voice::is(&ws) {
                    return Err(Error("not a voice file".into()));
                }
                if !mel {
                    ws.split("mel.");
                    ws.split("pause.");
                }
                Voice::load(ws, None)?
            }
            (true, -1) => return Err(Error("the voice is written against a base, and none was given".into())),
            (false, _) => return Err(Error("the voice is whole; it takes no base".into())),
            (true, b) => {
                let b = usize::try_from(b).ok().and_then(|i| s.bases.get(i)).ok_or_else(|| Error(format!("no base {base}")))?;
                Voice::load_on(ws, b, None, mel)?
            }
        };
        let worn: Option<&'static Vox> = match (&s.vox, v.vox.take()) {
            (Some(m), Some(w)) => Some(Box::leak(Box::new(Vox::wear(m, w)?))),
            _ => None,
        };
        s.voices.push(Box::leak(Box::new(v)));
        s.worn.push(worn);
        Ok(s.voices.len() as i32 - 1)
    })
}

#[no_mangle]
pub extern "C" fn ls_vocoder(p: *const u8, n: usize) -> i32 {
    run(|s| {
        if s.voc.is_some() {
            return Err(Error("the vocoder is loaded already".into()));
        }
        s.voc = Some(Box::leak(Box::new(Vocoder::load(&Weights::parse(bytes(p, n))?)?)));
        Ok(0)
    })
}

/// The latent voice, which speech and songs then go through, as each voice
/// loaded after it wears it; so before any voice.
#[no_mangle]
pub extern "C" fn ls_vox(p: *const u8, n: usize) -> i32 {
    run(|s| {
        if s.vox.is_some() {
            return Err(Error("the latent voice is loaded already".into()));
        }
        if !s.voices.is_empty() {
            return Err(Error("the latent voice loads before the voices that wear it".into()));
        }
        let ws = Weights::parse(bytes(p, n))?;
        if !Vox::is(&ws) {
            return Err(Error("not a file of the latent voice".into()));
        }
        s.vox = Some(Rc::new(Model::load(ws)?));
        Ok(0)
    })
}

/// The mel route, which speech then goes through.
#[no_mangle]
pub extern "C" fn ls_melvoc(p: *const u8, n: usize) -> i32 {
    run(|s| {
        if s.mel.is_some() {
            return Err(Error("the mel route is loaded already".into()));
        }
        let ws = Weights::parse(bytes(p, n))?;
        if !MelVoc::is(&ws) {
            return Err(Error("not a mel route file".into()));
        }
        s.mel_shared = Some(ws.under("mel."));
        s.mel = Some(Box::leak(Box::new(MelVoc::load(ws)?)));
        Ok(0)
    })
}

/// The break model, which speech is then phrased by.
#[no_mangle]
pub extern "C" fn ls_breaks(p: *const u8, n: usize) -> i32 {
    run(|s| {
        if s.breaks.is_some() {
            return Err(Error("the break model is loaded already".into()));
        }
        s.breaks = Some(Box::leak(Box::new(Breaks::load(&Weights::parse(bytes(p, n))?)?)));
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn ls_phonemizer(g2p: *const u8, g2p_n: usize, lex: *const u8, lex_n: usize) -> i32 {
    run(|s| {
        let g = G2p::load(&Weights::parse(bytes(g2p, g2p_n))?)?;
        let l = Lexicon::load(&Weights::parse(bytes(lex, lex_n))?)?;
        s.ph = Some(Phonemizer::new(l, g)?);
        Ok(0)
    })
}

/// What makes a voice's sound.
#[derive(Clone, Copy)]
enum Sound {
    Vox(&'static Vox),
    Voc(&'static Vocoder),
}

fn parts(s: &mut State, voice: i32) -> Result<(&'static Voice, Sound, &mut Phonemizer)> {
    let i = usize::try_from(voice).ok().filter(|i| *i < s.voices.len()).ok_or_else(|| Error(format!("no voice {voice}")))?;
    let v = s.voices[i];
    let sound = match (&s.vox, s.worn[i], s.voc) {
        (Some(_), Some(x), _) => Sound::Vox(x),
        (Some(_), None, _) => return Err(Error(format!("voice {} has no parts of the latent voice", v.name))),
        (None, _, Some(voc)) => Sound::Voc(voc),
        (None, _, None) => return Err(Error("no vocoder".into())),
    };
    let ph = s.ph.as_mut().ok_or_else(|| Error("no phonemizer".into()))?;
    Ok((v, sound, ph))
}

/// Starts speaking text (SSML when ssml is 1), a part at a time (lipservice::passage): the parts.
/// rate scales speed; shift moves the voice from its register, semitones.
#[no_mangle]
pub extern "C" fn ls_say(voice: i32, p: *const u8, n: usize, ssml: u32, rate: f32, shift: f32, seed: u32) -> i32 {
    run(|s| {
        let (mel, breaks) = (s.mel, s.breaks);
        let (v, sound, ph) = parts(s, voice)?;
        let phrase = match (breaks, v.phrase) {
            (None, _) => None,
            (Some(b), Some(r)) => Some((b, r)),
            (Some(_), None) => return Err(Error(format!("voice {} has no share of gaps to break at (voice.phrase)", v.name))),
        };
        let src = text(p, n)?;
        let pieces = match ssml {
            0 => ssml::plain(src)?,
            1 => ssml::pieces(src)?,
            _ => return Err(Error(format!("ssml {ssml}: 0 or 1"))),
        };
        let pitch = match (&v.flow, v.centre) {
            (Some(f), Some(centre)) => Pitch::Flow(f, Sampling { seed: seed as u64, widen: Some(Widen { by: WIDEN, centre }), ..Default::default() }),
            (Some(_), None) => return Err(Error(format!("voice {} has no pitch centre to widen its draws about (voice.centre)", v.name))),
            (None, _) => Pitch::Head,
        };
        let (render, sharpen) = match (sound, mel) {
            (Sound::Vox(x), _) => (Render::Vox(x), None),
            (Sound::Voc(_), Some(m)) => (Render::mel(m, v.mel.as_ref()).with_pauses(v.pause.as_ref()), None),
            (Sound::Voc(voc), None) => (Render::Voc(voc), v.sharpen.as_ref()),
        };
        let st = Passage::new(&v.score, render, ph, &pieces, 0, rate, v.shift + shift, pitch, seed as u64, sharpen, phrase, v.pace)?;
        let n = st.parts() as i32;
        s.stream = Some(st);
        s.told = lipservice::timing::Told::default();
        Ok(n)
    })
}

/// The next samples of the passage, `frames` score frames on (at ls_out): how many, 0 once done.
#[no_mangle]
pub extern "C" fn ls_step(frames: usize) -> i32 {
    run(|s| {
        let st = s.stream.as_mut().ok_or_else(|| Error("nothing being said".into()))?;
        let told = &mut s.told;
        s.out.clear();
        while s.out.is_empty() && !st.done() {
            told.step(st, frames.max(1), &mut s.out)?;
        }
        told.end(st)?;
        if s.out.is_empty() {
            s.stream = None;
        }
        Ok(s.out.len() as i32)
    })
}

/// What the passage said when (lipservice::timing), its parts done so far, in samples of its sound
/// as ls_step gave it: JSON at ls_info, {rate, length, phones, words ([[start, end, text]]), notes
/// ([]), pitch (Hz a frame, 0 unvoiced)}; its length in bytes.
#[no_mangle]
pub extern "C" fn ls_say_timing() -> i32 {
    run(|s| {
        let t = &s.told;
        s.info = format!("{{\"rate\":{},\"length\":{},{}}}", lipservice::dsp::SR, t.n, t.timing.json_fields());
        Ok(s.info.len() as i32)
    })
}

/// The part of the passage being said, from 0.
#[no_mangle]
pub extern "C" fn ls_say_part() -> i32 {
    run(|s| Ok(s.stream.as_ref().ok_or_else(|| Error("nothing being said".into()))?.part() as i32))
}

/// The part being said as the engine reads and plans it, as JSON at ls_info: {part, parts, gap
/// (samples of silence before it), tokens (symbols), dur (frames a token), phrased (the tokens that
/// are commas put where a reader would break), words ([text, first token, end token]), rises
/// ([first token, end token] of each question that rises)}: its length in bytes.
#[no_mangle]
pub extern "C" fn ls_say_info() -> i32 {
    run(|s| {
        let st = s.stream.as_ref().ok_or_else(|| Error("nothing being said".into()))?;
        let inf = st.inflection();
        let list = |xs: Vec<String>| format!("[{}]", xs.join(","));
        let tokens = list(inf.tokens.iter().map(|&t| json_str(lipservice::front::symbol(t))).collect());
        let dur = list(st.stream().durations().iter().map(|d| d.to_string()).collect());
        let phrased = list(inf.phrased().iter().enumerate().filter(|(_, &p)| p).map(|(i, _)| i.to_string()).collect());
        let words = list(inf.words().map(|(t, a, b)| format!("[{},{a},{b}]", json_str(t))).collect());
        let rises = list(inf.rises().map(|(a, b)| format!("[{a},{b}]")).collect());
        s.info = format!(
            "{{\"part\":{},\"parts\":{},\"gap\":{},\"tokens\":{tokens},\"dur\":{dur},\"phrased\":{phrased},\"words\":{words},\"rises\":{rises}}}",
            st.part(),
            st.parts(),
            st.gap()
        );
        Ok(s.info.len() as i32)
    })
}

/// Log F0 and voicing of frames [from, as far as made) of the part being said, at ls_out, a pair a
/// frame: how many numbers.
#[no_mangle]
pub extern "C" fn ls_say_pitch(from: usize) -> i32 {
    run(|s| {
        let st = s.stream.as_ref().ok_or_else(|| Error("nothing being said".into()))?;
        let (lf0, vuv) = st.stream().pitch();
        s.out = pairs(lf0, vuv, from)?;
        Ok(s.out.len() as i32)
    })
}

fn pairs(lf0: &[f32], vuv: &[f32], from: usize) -> Result<Vec<f32>> {
    if from > lf0.len() {
        return Err(Error(format!("frame {from}: only {} made", lf0.len())));
    }
    Ok(lf0[from..].iter().zip(&vuv[from..]).flat_map(|(&f, &v)| [f, v]).collect())
}

fn style(shift: f32, vibrato_hz: f32, seed: u32) -> Style {
    Style {
        shift,
        vibrato: 0.25,
        vibrato_hz,
        vibrato_delay: 0.25,
        vibrato_ramp: 0.2,
        glide: 9,
        dynamics: 0.0,
        consonants: 1.0,
        breathiness: 1.0,
        who: Who::default(),
        motion: None,
        motion_scale: 1.0,
        seed: seed as u64,
    }
}

/// Trained singers' pitch motion, for ls_sing_open: its index.
#[no_mangle]
pub extern "C" fn ls_motion(p: *const u8, n: usize) -> i32 {
    run(|s| {
        s.motions.push(Motion::load(&Weights::parse(bytes(p, n))?)?);
        Ok(s.motions.len() as i32 - 1)
    })
}

/// A song (engine/src/sing.rs gives the format), whole, at ls_out: its samples. shift in semitones.
#[no_mangle]
pub extern "C" fn ls_sing(voice: i32, p: *const u8, n: usize, shift: f32, seed: u32) -> i32 {
    run(|s| {
        let (v, sound, ph) = parts(s, voice)?;
        let song = Song::parse(text(p, n)?)?;
        let style = style(shift, 5.5, seed);
        match sound {
            Sound::Vox(x) => {
                let mut st = Stream::sung(&v.score, Render::Vox(x), sing::plan(&v.score, ph, &song, 0, &style)?, 0, None, seed as u64, None)?;
                s.out.clear();
                while !st.done() {
                    st.step(usize::MAX, &mut s.out);
                }
            }
            Sound::Voc(voc) => {
                let mut sung = sing::sing(&v.score, ph, &song, 0, &style)?;
                let f = &mut sung.score.frames;
                if let Some(sh) = &v.sharpen {
                    f.env = sh.apply(0, &f.env);
                }
                sing::louden(&mut f.env, &sung.gain);
                let noise = Rng::new(seed as u64).gaussian(f.len() * HOP);
                s.out = voc.render(f, &noise)?;
            }
        }
        Ok(s.out.len() as i32)
    })
}

/// A song's text read (lipservice::song, the one reader of the format; no model is needed): the
/// song as data, JSON at ls_info (song::Song::json has its shape); its length. Refused as the
/// engine refuses the song to sing, the line's number first.
#[no_mangle]
pub extern "C" fn ls_song(p: *const u8, n: usize) -> i32 {
    run(|s| {
        s.info = lipservice::song::read(text(p, n)?)?.json();
        Ok(s.info.len() as i32)
    })
}

/// A song to sing a step at a time: its handle. Any number are open at once; each is closed with
/// ls_sing_close. The style is the CLI's `sing` flags: vibrato (peak semitones) at vibrato_hz from
/// vibrato_delay seconds into a vowel, glide (frames), dynamics, breathiness, the diction (JSON at d,
/// dn bytes, or dn 0 for none: {who: {track, voice, tags}, who sings, for the rules' for=; diction:
/// rules as lines, the song's own after them, plain before}), and
/// motion (from ls_motion, in place of the vibrato; motion_scale times its singer's own size) or
/// -1; with ls_sing's (0.25, 5.5, 0.25, 9, 0, 1, none, -1, 1), its samples.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_sing_open(
    voice: i32,
    p: *const u8,
    n: usize,
    shift: f32,
    seed: u32,
    vibrato: f32,
    vibrato_hz: f32,
    vibrato_delay: f32,
    glide: u32,
    dynamics: f32,
    breathiness: f32,
    d: *const u8,
    dn: usize,
    motion: i32,
    motion_scale: f32,
) -> i32 {
    run(|s| {
        if !(vibrato >= 0.0 && vibrato.is_finite()) {
            return Err(Error(format!("vibrato {vibrato}: 0 or more semitones")));
        }
        if !(vibrato_hz > 0.0 && vibrato_hz.is_finite()) {
            return Err(Error(format!("vibrato {vibrato_hz} Hz: more than 0")));
        }
        if !(vibrato_delay >= 0.0 && vibrato_delay.is_finite()) {
            return Err(Error(format!("vibrato delay {vibrato_delay}: 0 or more seconds")));
        }
        if !(motion_scale >= 0.0 && motion_scale.is_finite()) {
            return Err(Error(format!("motion scale {motion_scale}: 0 or more")));
        }
        if glide < 1 {
            return Err(Error(format!("glide {glide}: at least 1 frame")));
        }
        if !(dynamics >= 0.0 && dynamics.is_finite()) {
            return Err(Error(format!("dynamics {dynamics}: 0 or more")));
        }
        if !(breathiness >= 0.0 && breathiness.is_finite()) {
            return Err(Error(format!("breathiness {breathiness}: 0 or more")));
        }
        let motion = match motion {
            -1 => None,
            m => Some(usize::try_from(m).ok().and_then(|i| s.motions.get(i)).ok_or_else(|| Error(format!("no motion {m}")))?.clone()),
        };
        let mut st = Style { vibrato, vibrato_delay, glide: glide as usize, dynamics, breathiness, motion, motion_scale, ..style(shift, vibrato_hz, seed) };
        let mut under = Rules::default();
        if dn > 0 {
            let Json::Obj(given) = Json::parse(text(d, dn)?)? else { return Err(Error("the diction is an object of who and diction".into())) };
            for (k, v) in &given {
                match k.as_str() {
                    "who" => st.who = who_of(v)?,
                    "diction" => rules_of(v, &mut under)?,
                    _ => return Err(Error(format!("{k}: who or diction"))),
                }
            }
        }
        open_song(s, voice, text(p, n)?, seed, &st, under)
    })
}

/// Who sings, as JSON: {track, voice, tags}, each or none.
fn who_of(v: &Json) -> Result<Who> {
    let Json::Obj(w) = v else { return Err(Error("who: an object of track, voice and tags".into())) };
    let mut who = Who::default();
    for (k, v) in w {
        match k.as_str() {
            "track" => who.track = Some(v.str().map_err(|e| Error(format!("who's track: {}", e.0)))?.to_string()),
            "voice" => who.voice = Some(v.str().map_err(|e| Error(format!("who's voice: {}", e.0)))?.to_string()),
            "tags" => who.tags = v.arr()?.iter().map(|t| t.str().map(str::to_string)).collect::<Result<_>>().map_err(|e| Error(format!("who's tags: {}", e.0)))?,
            _ => return Err(Error(format!("who's {k}: track, voice or tags"))),
        }
    }
    Ok(who)
}

/// Diction rules as JSON, a line each, read after those of `under`.
fn rules_of(v: &Json, under: &mut Rules) -> Result<()> {
    for l in v.arr().map_err(|e| Error(format!("diction: rule lines, a list: {}", e.0)))? {
        let l = l.str().map_err(|e| Error(format!("diction: {}", e.0)))?;
        under.read(&l.split_whitespace().collect::<Vec<_>>()).map_err(|e| Error(format!("diction: {l}: {}", e.0)))?;
    }
    Ok(())
}

/// A song opened in a style, its diction lines after `under`: its handle.
fn open_song(s: &mut State, voice: i32, song: &str, seed: u32, st: &Style, under: Rules) -> Result<i32> {
    let (v, sound, ph) = parts(s, voice)?;
    let render = match sound {
        Sound::Vox(x) => Render::Vox(x),
        Sound::Voc(voc) => Render::Voc(voc),
    };
    let song = Song::parse_under(song, under)?;
    let plan = sing::plan(&v.score, ph, &song, 0, st)?;
    let rests = plan.rests().iter().flat_map(|r| [r.start as f32, r.end as f32]).collect();
    let at = match s.singers.iter().position(Option::is_none) {
        Some(i) => i,
        None => {
            s.singers.push(None);
            s.singers.len() - 1
        }
    };
    let words = song.items.iter().filter_map(|i| if let lipservice::sing::Item::Word(w, _) = i { Some(w.clone()) } else { None }).collect();
    s.singers[at] = Some(Singer { v, render, seed: seed as u64, plan, from: 0, st: None, rests, breaths: Vec::new(), pos: 0, words, bpm: song.bpm, rules: song.diction.lines() });
    Ok(at as i32)
}

/// The sing options a bench offers (ls_bench) and ls_sing_with takes, each: its name, kind (number,
/// whole, switch or choice), what it is with none given, the least, the most and the step a hand
/// pulls it by, and what it does to the sound.
const OPTIONS: [(&str, &str, f64, f64, f64, f64, &str); 11] = [
    ("shift", "number", 0.0, -24.0, 24.0, 1.0, "Every note higher or lower, in semitones."),
    ("seed", "whole", 0.0, 0.0, 9999.0, 1.0, "Which draw of the small chance in the timing, the pitch motion and the breath noise."),
    ("vibrato", "number", 0.25, 0.0, 3.0, 0.05, "How far the pitch swings on a held note, semitones each way. A motion takes its place."),
    ("vibrato_hz", "number", 5.5, 0.5, 12.0, 0.1, "How many swings of the vibrato a second."),
    ("vibrato_delay", "number", 0.25, 0.0, 3.0, 0.05, "Seconds into a vowel before the vibrato starts."),
    ("motion", "choice", -1.0, -1.0, 0.0, 1.0, "A trained singer's own pitch movement on every note, in place of the plain vibrato."),
    ("motion_scale", "number", 1.0, 0.0, 4.0, 0.05, "How large the motion is against that singer's own: 0 none, 1 as sung."),
    ("glide", "whole", 9.0, 1.0, 80.0, 1.0, "How slowly the pitch moves from one note to the next: the smoothing, in hundredths of a second."),
    ("dynamics", "number", 0.0, 0.0, 4.0, 0.05, "How much louder and brighter the high and long notes are, and how far a phrase's last note falls away. 0 for none."),
    ("consonants", "number", 1.0, 0.05, 4.0, 0.05, "How long the consonants are against the engine's own, but the stops (b, d, g, p, t, k, ch, j): the vowels give up the time."),
    ("breathiness", "number", 1.0, 0.0, 3.0, 0.05, "How much breath noise is in the sung vowels: under 1 for less."),
];

/// What a bench offers, as the engine has it, JSON at ls_info: {phones (every sound, a vowel's
/// stress digit on it), options ([{name, kind, default, min, max, step, help}], ls_sing_with's),
/// motions (the trained motions' names), sets (the rules every song is sung by: plain, and sung,
/// off where a singer speaks; each its rules as lines), dipped (the consonants a dip is through)}:
/// its length.
#[no_mangle]
pub extern "C" fn ls_bench() -> i32 {
    run(|s| {
        let list = |xs: Vec<String>| format!("[{}]", xs.join(","));
        let phones = list(lipservice::g2p::PHONES.iter().map(|p| json_str(p)).collect());
        let options = list(
            OPTIONS
                .iter()
                .map(|&(name, kind, default, min, max, step, help)| {
                    format!("{{\"name\":{},\"kind\":{},\"default\":{default},\"min\":{min},\"max\":{max},\"step\":{step},\"help\":{}}}", json_str(name), json_str(kind), json_str(help))
                })
                .collect(),
        );
        let motions = list(lipservice::home::MOTIONS.iter().map(|m| json_str(m)).collect());
        let sets = [("plain", &PLAIN[..]), ("sung", &SUNG[..])].iter().map(|(name, lines)| format!("{}:{}", json_str(name), list(lines.iter().map(|l| json_str(l)).collect()))).collect::<Vec<_>>().join(",");
        let dipped = list(DIPPED.iter().map(|p| json_str(p)).collect());
        s.info = format!("{{\"phones\":{phones},\"options\":{options},\"motions\":{motions},\"sets\":{{{sets}}},\"dipped\":{dipped}}}");
        Ok(s.info.len() as i32)
    })
}

/// A song to sing a step at a time, as ls_sing_open's, its style by name: JSON at q (m bytes), an
/// object of OPTIONS' names, what is left out as ls_sing's; motion an index from ls_motion or -1;
/// who ({track, voice, tags}, each or none: who sings, for the diction's for=) and diction (rules
/// as lines, the song's own after them, plain before). A name that is none of these is refused.
#[no_mangle]
pub extern "C" fn ls_sing_with(voice: i32, p: *const u8, n: usize, q: *const u8, m: usize) -> i32 {
    run(|s| {
        let Json::Obj(given) = Json::parse(text(q, m)?)? else { return Err(Error("the options are an object, a value a name".into())) };
        let mut st = style(0.0, 5.5, 0);
        let mut seed = 0u32;
        let mut under = Rules::default();
        for (k, v) in &given {
            if k == "who" {
                st.who = who_of(v)?;
                continue;
            }
            if k == "diction" {
                rules_of(v, &mut under)?;
                continue;
            }
            let &(name, kind, _, min, max, ..) = OPTIONS.iter().find(|o| o.0 == k).ok_or_else(|| Error(format!("{k}: not a sing option ({})", OPTIONS.map(|o| o.0).join(", "))))?;
            let x = v.num().map_err(|e| Error(format!("{name}: {}", e.0)))?;
            if name == "motion" {
                st.motion = match x {
                    x if x == -1.0 => None,
                    x => Some(Some(x).filter(|x| *x >= 0.0 && x.fract() == 0.0).and_then(|x| s.motions.get(x as usize)).ok_or_else(|| Error(format!("no motion {x}")))?.clone()),
                };
                continue;
            }
            if !(x >= min && x <= max) || (kind == "whole" && x.fract() != 0.0) {
                return Err(Error(format!("{name} {x}: {}{min} to {max}", if kind == "whole" { "a whole number, " } else { "" })));
            }
            match name {
                "shift" => st.shift = x as f32,
                "seed" => seed = x as u32,
                "vibrato" => st.vibrato = x as f32,
                "vibrato_hz" => st.vibrato_hz = x as f32,
                "vibrato_delay" => st.vibrato_delay = x as f32,
                "motion_scale" => st.motion_scale = x as f32,
                "glide" => st.glide = x as usize,
                "dynamics" => st.dynamics = x as f32,
                "consonants" => st.consonants = x as f32,
                "breathiness" => st.breathiness = x as f32,
                _ => unreachable!(),
            }
        }
        st.seed = seed as u64;
        open_song(s, voice, text(p, n)?, seed, &st, under)
    })
}

/// One voice heard alone on its way out (lipservice::alone): speech (sung 0) or a song sung alone
/// (sung 1, let down to speech's level for what sings it: the latent voice once loaded, the vocoder
/// until then). Its handle: ls_alone_push gives what it holds back, ls_alone_end the rest; close each
/// with ls_alone_close.
#[no_mangle]
pub extern "C" fn ls_alone(sung: u32) -> i32 {
    run(|s| {
        let a = match (sung, s.vox.is_some(), s.voc.is_some()) {
            (0, _, _) => Alone::speech(),
            (1, true, _) => Alone::song(true),
            (1, false, true) => Alone::song(false),
            (1, false, false) => return Err(Error("nothing to sing through".into())),
            _ => return Err(Error(format!("sung {sung}: 0 or 1"))),
        };
        let at = match s.alone.iter().position(Option::is_none) {
            Some(i) => i,
            None => {
                s.alone.push(None);
                s.alone.len() - 1
            }
        };
        s.alone[at] = Some(a);
        Ok(at as i32)
    })
}

fn alone(all: &mut [Option<Alone>], h: i32) -> Result<&mut Alone> {
    usize::try_from(h).ok().and_then(|i| all.get_mut(i)).and_then(Option::as_mut).ok_or_else(|| Error(format!("no voice alone {h} open")))
}

/// Samples (n bytes of little-endian float32 at p) through it: what comes out, at ls_out, the
/// limiter's delay behind; how many.
#[no_mangle]
pub extern "C" fn ls_alone_push(h: i32, p: *const u8, n: usize) -> i32 {
    run(|s| {
        if !n.is_multiple_of(4) {
            return Err(Error(format!("{n} bytes: not float32 samples")));
        }
        let a = alone(&mut s.alone, h)?;
        if a.ended() {
            return Err(Error(format!("voice alone {h}: pushed after its end")));
        }
        let x: Vec<f32> = bytes(p, n).as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
        s.out.clear();
        a.push(&x, &mut s.out);
        Ok(s.out.len() as i32)
    })
}

/// The samples it still holds, at ls_out: how many. Once only.
#[no_mangle]
pub extern "C" fn ls_alone_end(h: i32) -> i32 {
    run(|s| {
        let a = alone(&mut s.alone, h)?;
        if a.ended() {
            return Err(Error(format!("voice alone {h}: ended twice")));
        }
        s.out.clear();
        a.end(&mut s.out);
        Ok(s.out.len() as i32)
    })
}

#[no_mangle]
pub extern "C" fn ls_alone_close(h: i32) -> i32 {
    run(|s| {
        alone(&mut s.alone, h)?;
        s.alone[h as usize] = None;
        Ok(0)
    })
}

/// Slot `at` for a new handle in a list of them.
fn slot<T>(all: &mut Vec<Option<T>>, x: T) -> i32 {
    let at = match all.iter().position(Option::is_none) {
        Some(i) => i,
        None => {
            all.push(None);
            all.len() - 1
        }
    };
    all[at] = Some(x);
    at as i32
}

fn handle<'a, T>(all: &'a mut [Option<T>], h: i32, what: &str) -> Result<&'a mut T> {
    usize::try_from(h).ok().and_then(|i| all.get_mut(i)).and_then(Option::as_mut).ok_or_else(|| Error(format!("no {what} {h} open")))
}

fn floats(p: *const u8, n: usize) -> Result<Vec<f32>> {
    if !n.is_multiple_of(4) {
        return Err(Error(format!("{n} bytes: not float32 samples")));
    }
    Ok(bytes(p, n).as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect())
}

/// The choir's room (lipservice::room, web/room.js): its handle. name (utf-8 at p, n bytes) is one
/// of lipservice::room::ROOMS; the echo at half a beat of bpm; the halls drawn from seed; trace 1
/// keeps the room's trace; at and from as Room::new.
#[no_mangle]
pub extern "C" fn ls_room(p: *const u8, n: usize, bpm: f64, seed: i32, trace: u32, at: usize, from: usize) -> i32 {
    run(|s| {
        let trace = match trace {
            0 => false,
            1 => true,
            _ => return Err(Error(format!("trace {trace}: 0 or 1"))),
        };
        let r = Room::new(text(p, n)?, bpm, seed as i64, trace, at, from)?;
        Ok(slot(&mut s.rooms, r))
    })
}

/// The mix's next samples through the room: n bytes at p of float32, four channels one after the
/// other (dry left, dry right, send left, send right). What it gives, at ls_out, left then right:
/// how many samples a channel.
#[no_mangle]
pub extern "C" fn ls_room_push(h: i32, p: *const u8, n: usize) -> i32 {
    run(|s| {
        let x = floats(p, n)?;
        if !x.len().is_multiple_of(4) {
            return Err(Error(format!("{} samples: not four channels", x.len())));
        }
        let k = x.len() / 4;
        let r = handle(&mut s.rooms, h, "room")?;
        let mut out = [Vec::new(), Vec::new()];
        r.push([&x[..k], &x[k..2 * k]], [&x[2 * k..3 * k], &x[3 * k..]], &mut out)?;
        let m = out[0].len();
        s.out.clear();
        s.out.extend(out[0].iter().chain(&out[1]));
        Ok(m as i32)
    })
}

/// The rest of the mix and the room's ring, at ls_out as ls_room_push gives it.
#[no_mangle]
pub extern "C" fn ls_room_end(h: i32) -> i32 {
    run(|s| {
        let r = handle(&mut s.rooms, h, "room")?;
        let mut out = [Vec::new(), Vec::new()];
        r.end(&mut out);
        let m = out[0].len();
        s.out.clear();
        s.out.extend(out[0].iter().chain(&out[1]));
        Ok(m as i32)
    })
}

/// How much the echo and both halls are heard (1: as set).
#[no_mangle]
pub extern "C" fn ls_room_wet(h: i32, wet: f64) -> i32 {
    run(|s| {
        if !(wet >= 0.0 && wet.is_finite()) {
            return Err(Error(format!("wet {wet}: 0 or more")));
        }
        handle(&mut s.rooms, h, "room")?.wet = wet;
        Ok(0)
    })
}

/// Samples the room gives each sample late by, past the block it waits for.
#[no_mangle]
pub extern "C" fn ls_room_delay(h: i32) -> i32 {
    run(|s| Ok(handle(&mut s.rooms, h, "room")?.delay() as i32))
}

/// Frames (TRACE samples) of the room's trace whose output has all been given.
#[no_mangle]
pub extern "C" fn ls_room_frames(h: i32) -> i32 {
    run(|s| {
        let r = handle(&mut s.rooms, h, "room")?;
        Ok(r.trace.as_ref().ok_or_else(|| Error(format!("room {h} keeps no trace")))?.frames as i32)
    })
}

/// The room's trace, frames [from, its frames) of it, at most the TRACE_RING it keeps, at ls_out a
/// stage after another (lipservice::room::STAGES, web/room.js Trace's: dry, echo, hall, master,
/// mhall, out, comp, lim): how many frames.
#[no_mangle]
pub extern "C" fn ls_room_trace(h: i32, from: usize) -> i32 {
    run(|s| {
        let r = handle(&mut s.rooms, h, "room")?;
        let t = r.trace.as_ref().ok_or_else(|| Error(format!("room {h} keeps no trace")))?;
        let a = from.max(t.frames.saturating_sub(TRACE_RING));
        let k = t.frames.saturating_sub(a);
        s.out.clear();
        for v in t.v.iter().take(STAGES.len()) {
            s.out.extend((a..a + k).map(|f| v[f % TRACE_RING]));
        }
        Ok(k as i32)
    })
}

#[no_mangle]
pub extern "C" fn ls_room_close(h: i32) -> i32 {
    run(|s| {
        handle(&mut s.rooms, h, "room")?;
        s.rooms[h as usize] = None;
        Ok(0)
    })
}

fn seat_of(j: &Json) -> Result<Seat> {
    let n = |j: &Json, k: &str| -> Result<f64> { j.get(k)?.num().map_err(|e| Error(format!("a seat's {k}: {}", e.0))) };
    let refl = j.get("refl")?.arr()?;
    if refl.len() != 2 {
        return Err(Error(format!("a seat has {} reflections, not 2", refl.len())));
    }
    let r = |x: &Json| -> Result<Reflection> { Ok(Reflection { delay_ms: n(x, "delayMs")?, pan: n(x, "pan")?, gain: n(x, "gain")? }) };
    // the row orders seats as they are made; taps and the mixer do not read it
    let row = match opt(j, "row") {
        None => 0,
        Some(r) => r.count()?,
    };
    Ok(Seat { row, pan: n(j, "pan")?, gain: n(j, "gain")?, send: n(j, "send")?, delay_ms: n(j, "delayMs")?, itd_ms: n(j, "itdMs")?, refl: [r(&refl[0])?, r(&refl[1])?] })
}

fn seat_json(s: &Seat) -> String {
    let r = |r: &Reflection| format!("{{\"delayMs\":{},\"pan\":{},\"gain\":{}}}", r.delay_ms, r.pan, r.gain);
    format!(
        "{{\"row\":{},\"pan\":{},\"gain\":{},\"send\":{},\"delayMs\":{},\"itdMs\":{},\"refl\":[{},{}]}}",
        s.row, s.pan, s.gain, s.send, s.delay_ms, s.itd_ms, r(&s.refl[0]), r(&s.refl[1])
    )
}

/// n seats facing the listener, left to right (lipservice::choir::seats, web/choir.js makeSeats),
/// as JSON at ls_info: its length.
#[no_mangle]
pub extern "C" fn ls_seats(n: usize, pan_max: f64, half_angle: f64) -> i32 {
    run(|s| {
        let seats: Vec<String> = choir::seats(n, pan_max, half_angle).iter().map(seat_json).collect();
        s.info = format!("[{}]", seats.join(","));
        Ok(s.info.len() as i32)
    })
}

/// A source at gain from a seat (JSON at p, n bytes, as ls_seats gives one) as taps (choir.rs taps,
/// web/choir.js taps), as JSON at ls_info, [{ch, g, d}] (channel, gain, delay in samples): its length.
#[no_mangle]
pub extern "C" fn ls_taps(gain: f64, p: *const u8, n: usize) -> i32 {
    run(|s| {
        let seat = seat_of(&Json::parse(text(p, n)?)?)?;
        let t: Vec<String> = choir::taps(gain, &seat).iter().map(|x| format!("{{\"ch\":{},\"g\":{},\"d\":{}}}", x.ch, x.g, x.d)).collect();
        s.info = format!("[{}]", t.join(","));
        Ok(s.info.len() as i32)
    })
}

/// A choir's mixer (lipservice::choir::Mixer, web/choir.js Mixer): its handle. JSON at p (n bytes):
/// its parts, [{gain, seat (as ls_seats gives one), levels ([[s, factor]...] or null), mute}]; t0 the
/// s its starts are counted from (NaN: from the earliest, once all are open); from, the sample of
/// the mix it is picked up at.
#[no_mangle]
pub extern "C" fn ls_mixer(p: *const u8, n: usize, t0: f64, from: usize) -> i32 {
    run(|s| {
        let j = Json::parse(text(p, n)?)?;
        let parts = j
            .arr()?
            .iter()
            .map(|x| {
                let levels = match opt(x, "levels") {
                    None => None,
                    Some(l) => Some(l.arr()?.iter().map(|y| match y.arr() {
                        Ok([a, b]) => Ok((a.num()?, b.num()?)),
                        _ => Err(Error("a level is [seconds, factor]".into())),
                    }).collect::<Result<Vec<_>>>()?),
                };
                let mute = matches!(opt(x, "mute"), Some(Json::Bool(true)));
                Ok(MixPart { gain: x.get("gain")?.num()?, seat: seat_of(x.get("seat")?)?, levels, lv: None, mute })
            })
            .collect::<Result<Vec<_>>>()?;
        let m = Mixer::new(parts, (!t0.is_nan()).then_some(t0), from)?;
        Ok(slot(&mut s.mixers, m))
    })
}

#[no_mangle]
pub extern "C" fn ls_mixer_open(h: i32, i: usize, start: f64, len: usize, from: usize) -> i32 {
    run(|s| {
        handle(&mut s.mixers, h, "mixer")?.open(i, start, len, from)?;
        Ok(0)
    })
}

/// Part i's next samples (n bytes of float32 at p).
#[no_mangle]
pub extern "C" fn ls_mixer_push(h: i32, i: usize, p: *const u8, n: usize) -> i32 {
    run(|s| {
        let x = floats(p, n)?;
        let m = handle(&mut s.mixers, h, "mixer")?;
        if i >= m.len() {
            return Err(Error(format!("mixer: no part {i}")));
        }
        m.push(i, x)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn ls_mixer_end(h: i32, i: usize) -> i32 {
    run(|s| {
        let m = handle(&mut s.mixers, h, "mixer")?;
        if i >= m.len() {
            return Err(Error(format!("mixer: no part {i}")));
        }
        m.end(i)?;
        Ok(0)
    })
}

/// The buses as far as every part has reached, at ls_out a bus after another (dry left, dry right,
/// send left, send right): samples a bus, 0 for none yet.
#[no_mangle]
pub extern "C" fn ls_mixer_take(h: i32) -> i32 {
    run(|s| {
        let m = handle(&mut s.mixers, h, "mixer")?;
        s.out.clear();
        let Some(y) = m.take() else { return Ok(0) };
        let k = y[0].len();
        for b in &y {
            s.out.extend_from_slice(b);
        }
        Ok(k as i32)
    })
}

/// Samples of the mix in all once every part is open, else -1.
#[no_mangle]
pub extern "C" fn ls_mixer_total(h: i32) -> i32 {
    run(|s| Ok(handle(&mut s.mixers, h, "mixer")?.total.map_or(-1, |t| t as i32)))
}

/// Part i's first sample in the mix, once it is known.
#[no_mangle]
pub extern "C" fn ls_mixer_off(h: i32, i: usize) -> i32 {
    run(|s| {
        let m = handle(&mut s.mixers, h, "mixer")?;
        if i >= m.len() {
            return Err(Error(format!("mixer: no part {i}")));
        }
        Ok(m.off(i) as i32)
    })
}

/// How far past its own samples part i's taps reach, samples.
#[no_mangle]
pub extern "C" fn ls_mixer_reach(h: i32, i: usize) -> i32 {
    run(|s| {
        let m = handle(&mut s.mixers, h, "mixer")?;
        if i >= m.len() {
            return Err(Error(format!("mixer: no part {i}")));
        }
        Ok(m.reach(i) as i32)
    })
}

/// Part i's levels as it came, entries [a, b) (one every TRACE samples of its own), at ls_out: how many.
#[no_mangle]
pub extern "C" fn ls_mixer_lv(h: i32, i: usize, a: usize, b: usize) -> i32 {
    run(|s| {
        let m = handle(&mut s.mixers, h, "mixer")?;
        if i >= m.len() {
            return Err(Error(format!("mixer: no part {i}")));
        }
        let lv = m.levels(i).ok_or_else(|| Error(format!("mixer: part {i} is not open")))?;
        if a > b || b > lv.len() {
            return Err(Error(format!("mixer: part {i}'s levels {a} to {b} of {}", lv.len())));
        }
        s.out.clear();
        s.out.extend_from_slice(&lv[a..b]);
        Ok((b - a) as i32)
    })
}

#[no_mangle]
pub extern "C" fn ls_mixer_close(h: i32) -> i32 {
    run(|s| {
        handle(&mut s.mixers, h, "mixer")?;
        s.mixers[h as usize] = None;
        Ok(0)
    })
}

/// The breaths a choir's singers take (web/choir_assets.py): the index (breaths.json, utf-8 at p,
/// n bytes) and the sound (breaths.bin, 16-bit at 24 kHz, at q, m bytes). How many clips.
#[no_mangle]
pub extern "C" fn ls_breaths(p: *const u8, n: usize, q: *const u8, m: usize) -> i32 {
    run(|s| {
        let b = lipservice::part::breaths_of("breaths.json", text(p, n)?, "breaths.bin", bytes(q, m))?;
        let k = b.0.clips.len();
        s.breaths = Some(b);
        Ok(k as i32)
    })
}

fn opt<'a>(j: &'a Json, k: &str) -> Option<&'a Json> {
    match j {
        Json::Obj(kv) => kv.iter().find(|(key, _)| key == k).map(|(_, v)| v).filter(|v| !matches!(v, Json::Null)),
        _ => None,
    }
}

fn opt_num(j: &Json, k: &str) -> Result<Option<f64>> {
    opt(j, k).map(|v| v.num().map_err(|e| Error(format!("{k}: {}", e.0)))).transpose()
}

fn singer_json(p: &choir::Singer) -> String {
    let levels = match &p.levels {
        None => "null".to_string(),
        Some(l) => format!("[{}]", l.iter().map(|(a, b)| format!("[{a},{b}]")).collect::<Vec<_>>().join(",")),
    };
    let motion = p.motion.as_deref().map_or("null".to_string(), json_str);
    let strs = |xs: &[String]| format!("[{}]", xs.iter().map(|x| json_str(x)).collect::<Vec<_>>().join(","));
    format!(
        "{{\"name\":{},\"voice\":{},\"called\":{},\"sex\":\"{}\",\"shift\":{},\"seed\":{},\"song\":{},\"at\":{},\"gain\":{},\"levels\":{levels},\"seat\":{},\"motion\":{motion},\"motionScale\":{},\"vibrato\":{},\"vibratoHz\":{},\"vibratoDelay\":{},\"vibratoSize\":{},\"glide\":{},\"dynamics\":{},\"breathiness\":{},\"tags\":{},\"diction\":{},\"jitter\":{},\"detune\":{},\"spread\":{},\"breath\":{},\"together\":{},\"give\":{}}}",
        json_str(&p.name), json_str(&p.voice), p.called.as_deref().map_or("null".to_string(), json_str), p.sex, p.shift, p.seed, json_str(&p.song), p.at, p.gain, p.seat, p.motion_scale, p.vibrato, p.vibrato_hz, p.vibrato_delay,
        p.vibrato_size, p.glide, p.dynamics, p.breathiness, strs(&p.tags), strs(&p.diction), p.jitter, p.detune, p.spread, p.breath, p.together, p.give
    )
}

/// A choir arranged as web/choirs.js arrange() did (lipservice::choir::arrange): JSON at p (n bytes)
/// {choir, list, route ("hifi" or "fast"), and as ls_choir seed, voices_by_part, songs, room, motion,
/// how}; the parts, seats, room and bpm, as JSON at ls_info (choir.js start()'s): its length.
#[no_mangle]
pub extern "C" fn ls_arrange(p: *const u8, n: usize) -> i32 {
    run(|s| {
        let j = Json::parse(text(p, n)?)?;
        let route = match opt(&j, "route") {
            Some(Json::Str(r)) if r == "hifi" || r == "fast" => r.clone(),
            r => return Err(Error(format!("a choir is arranged for a route, hifi or fast: {}", r.map_or("none".to_string(), |r| format!("{r:?}"))))),
        };
        let a = lipservice::piece::wanted(&j, &route)?.arranged;
        let parts: Vec<String> = a.singers.iter().map(singer_json).collect();
        let seats: Vec<String> = a.seats.iter().map(seat_json).collect();
        s.info = format!("{{\"parts\":[{}],\"seats\":[{}],\"room\":{},\"bpm\":{}}}", parts.join(","), seats.join(","), json_str(&a.room), a.bpm);
        Ok(s.info.len() as i32)
    })
}

/// A singer's own machine vibrato (choir::vibrato), as JSON at ls_info: [peak, Hz, delay]; its length.
#[no_mangle]
pub extern "C" fn ls_vibrato(seed: f64) -> i32 {
    run(|s| {
        if !(seed.fract() == 0.0 && seed.abs() < 9e15) {
            return Err(Error(format!("seed {seed}: a whole number")));
        }
        let (v, hz, d) = choir::vibrato(seed as i64);
        s.info = format!("[{v},{hz},{d}]");
        Ok(s.info.len() as i32)
    })
}

/// The route what is loaded sings a choir through: the latent voice, or the vocoder.
fn route(s: &State) -> &'static str {
    if s.vox.is_some() {
        "hifi"
    } else {
        "fast"
    }
}

/// What a choir's ask (ls_choir's, its voices and motions left out) needs loaded to be sung, as
/// JSON at ls_info: {title, voices: the voices' names in the models, motions}; its length. Every
/// refusal of the piece as written is made here.
#[no_mangle]
pub extern "C" fn ls_choir_want(p: *const u8, n: usize) -> i32 {
    run(|s| {
        let w = lipservice::piece::wanted(&Json::parse(text(p, n)?)?, route(s))?;
        let strs = |v: Vec<&str>| v.into_iter().map(json_str).collect::<Vec<_>>().join(",");
        s.info = format!("{{\"title\":{},\"voices\":[{}],\"motions\":[{}]}}", json_str(&w.title), strs(w.voices()), strs(w.motions()));
        Ok(s.info.len() as i32)
    })
}

/// A choir sung whole, as the page sings it (lipservice::piece gives the ask; web/choir_wav.mjs
/// takes the same): JSON at p (n bytes), the piece and how it is sung, with voices: {name: voice}
/// each voice the piece sings with (loaded, as ls_voice gives it) and motions: {name: motion} each
/// pitch motion it sings with (ls_motion's); ls_choir_want says which. Its route is what is
/// loaded: the latent voice, or the vocoder. What it gives, at ls_out, left then right: how many
/// samples a channel; how each part was sung at ls_info (ls_choir_info).
#[no_mangle]
pub extern "C" fn ls_choir(p: *const u8, n: usize) -> i32 {
    run(|s| {
        let j = Json::parse(text(p, n)?)?;
        let handles = |k: &str| -> Result<Vec<(String, usize)>> {
            match opt(&j, k) {
                None => Ok(Vec::new()),
                Some(Json::Obj(kv)) => kv.iter().map(|(name, v)| Ok((name.clone(), v.count()?))).collect(),
                Some(_) => Err(Error(format!("{k}: an object of names"))),
            }
        };
        let (voices, motions) = (handles("voices")?, handles("motions")?);
        let a: Arranged = lipservice::piece::wanted(&j, route(s))?.arranged;
        let (mut cast, mut mi) = (Vec::new(), Vec::new());
        for p in &a.singers {
            let v = voices.iter().find(|(n, _)| *n == p.voice).map(|(_, v)| *v).ok_or_else(|| Error(format!("{}: voice {} is not loaded", p.name, p.voice)))?;
            let (voice, sound, _) = parts(s, v as i32)?;
            cast.push(lipservice::piece::Cast {
                voice,
                render: match sound {
                    Sound::Vox(x) => Render::Vox(x),
                    Sound::Voc(voc) => Render::Voc(voc),
                },
            });
            mi.push(match &p.motion {
                None => None,
                Some(m) => {
                    let k = motions.iter().find(|(n, _)| n == m).map(|(_, k)| *k).ok_or_else(|| Error(format!("{}: motion {m} is not loaded", p.name)))?;
                    Some(s.motions.get(k).ok_or_else(|| Error(format!("no motion {k}")))?.clone())
                }
            });
        }
        let ph = s.ph.as_mut().ok_or_else(|| Error("no phonemizer".into()))?;
        let piece = lipservice::piece::sing(&a, s.breaths.as_ref(), ph, &cast, &mi);
        let piece = piece?;
        let parts: Vec<String> = piece
            .parts
            .iter()
            .map(|p| {
                let bs: Vec<String> = p.breaths.iter().map(|(at, n)| format!("[{at},{n}]")).collect();
                let level: Vec<String> = p.level.iter().map(|&v| if v.is_finite() { format!("{v}") } else { "null".to_string() }).collect();
                format!(
                    "{{\"name\":{},\"voice\":{},\"text\":{},\"breaths\":[{}],\"lag\":{},\"shift\":{},\"start\":{},\"len\":{},\"pan\":{},\"level\":[{}],{}}}",
                    json_str(&p.name),
                    json_str(&p.voice),
                    json_str(&p.text),
                    bs.join(","),
                    p.lag,
                    p.shift,
                    p.start,
                    p.len,
                    p.pan,
                    level.join(","),
                    p.timing.json_fields()
                )
            })
            .collect();
        let m = piece.left.len();
        s.info = format!("{{\"rate\":{},\"length\":{m},\"bpm\":{},\"beat_zero\":{},\"parts\":[{}]}}", lipservice::dsp::SR, piece.bpm, piece.beat_zero, parts.join(","));
        s.out.clear();
        s.out.extend(piece.left.iter().chain(&piece.right));
        Ok(m as i32)
    })
}

/// A sound's loudness a frame (lipservice::timing::levels), a clip's as it went out: n float32
/// samples at p; as JSON at ls_info, [rms a frame]: its length.
#[no_mangle]
pub extern "C" fn ls_levels(p: *const f32, n: usize) -> i32 {
    run(|s| {
        // SAFETY: the caller hands a range it allocated and filled.
        let y = unsafe { std::slice::from_raw_parts(p, n) };
        let level: Vec<String> = lipservice::timing::levels(y).iter().map(|&v| lipservice::timing::num_json(v)).collect();
        s.info = format!("[{}]", level.join(","));
        Ok(s.info.len() as i32)
    })
}

/// The rooms a choir may be sung in (lipservice::room::ROOMS), as JSON at ls_info: its length.
#[no_mangle]
pub extern "C" fn ls_rooms() -> i32 {
    run(|s| {
        let names: Vec<String> = lipservice::room::ROOMS.iter().map(|(n, _)| json_str(n)).collect();
        s.info = format!("[{}]", names.join(","));
        Ok(s.info.len() as i32)
    })
}

/// How the last choir's parts were sung, as JSON at ls_info: its length in bytes.
#[no_mangle]
pub extern "C" fn ls_choir_info() -> i32 {
    run(|s| Ok(s.info.len() as i32))
}

fn singer<'a>(singers: &'a mut [Option<Singer>], h: i32) -> Result<&'a mut Singer> {
    usize::try_from(h).ok().and_then(|i| singers.get_mut(i)).and_then(Option::as_mut).ok_or_else(|| Error(format!("no song {h} open")))
}

/// A part of a choir performed as a person sings it (lipservice::part, web/perform.js), to sing a
/// step at a time as ls_sing_open's songs are: its handle. JSON at p (n bytes): the part as
/// web/choirs.js arrange() gives it ({song, sex, seed, at, shift, jitter, detune, spread, breath,
/// together, give, vibratoSize, vibrato, vibratoHz, vibratoDelay, glide, dynamics, breathiness,
/// name, voice, called, tags, diction, motionScale}: name, voice (called, where given) and tags who sings, for the rules of
/// diction, lines read before the song's own; each but song, sex, seed and at as lipservice.js singer() and perform()
/// take it when left out), and as the editor's are: wants, by phrase, a breath marked before it (true
/// always, false never, null the part's chance; one that does not fit is refused, "phrase J (from
/// 0): ..."), and clocked, whether the singer is opened on the together line (together's own unless
/// given); motion from ls_motion or -1. Its breaths (from ls_breaths) are in the
/// samples ls_sing_step gives. How it was performed, as JSON at ls_info (its length is
/// ls_perform_info's): {text, the song as sung; breaths, [[sample of the part, samples]]; lag, the s
/// it starts late by; shift, semitones, its detune in it}.
#[no_mangle]
pub extern "C" fn ls_perform(voice: i32, p: *const u8, n: usize, motion: i32) -> i32 {
    run(|s| {
        let j = Json::parse(text(p, n)?)?;
        let num = |k: &str, or: Option<f64>| -> Result<f64> { opt_num(&j, k)?.or(or).ok_or_else(|| Error(format!("the part has no {k}"))) };
        let flag = |k: &str| -> Result<bool> {
            match opt(&j, k) {
                None => Ok(false),
                Some(Json::Bool(b)) => Ok(*b),
                Some(_) => Err(Error(format!("the part's {k}: true or false"))),
            }
        };
        let song = j.get("song")?.str()?.to_string();
        let sex = match j.get("sex")?.str()? {
            "F" => 'F',
            "M" => 'M',
            x => return Err(Error(format!("the part's sex {x}: F or M"))),
        };
        let seed = num("seed", None)?;
        if !(seed >= 0.0 && seed.fract() == 0.0 && seed < 4294967296.0) {
            return Err(Error(format!("the part's seed {seed}: a whole number from 0")));
        }
        let (at, shift0) = (num("at", None)?, num("shift", Some(0.0))?);
        let together = flag("together")?;
        // the together line its singer is opened on, which keeping the piece's moments brings
        let clocked = match opt(&j, "clocked") {
            None => together,
            Some(Json::Bool(b)) => *b,
            Some(_) => return Err(Error("the part's clocked: true or false".into())),
        };
        let wants: Vec<Option<bool>> = match opt(&j, "wants") {
            None => Vec::new(),
            Some(w) => w.arr()?.iter().map(|x| match x {
                Json::Null => Ok(None),
                Json::Bool(b) => Ok(Some(*b)),
                _ => Err(Error("the part's wants: true, false or null a phrase".into())),
            }).collect::<Result<_>>()?,
        };
        let marked = wants.contains(&Some(true));
        let give = opt_num(&j, "give")?;
        let size = num("vibratoSize", Some(1.0))?;
        let breath = num("breath", Some(0.0))?;
        let glide = num("glide", Some(9.0))?;
        if !(glide >= 1.0 && glide.fract() == 0.0) {
            return Err(Error(format!("glide {glide}: a whole number of frames, at least 1")));
        }
        let motion = match motion {
            -1 => None,
            m => Some(usize::try_from(m).ok().and_then(|i| s.motions.get(i)).ok_or_else(|| Error(format!("no motion {m}")))?.clone()),
        };
        let (vibrato, vibrato_delay, vibrato_hz) = (num("vibrato", Some(0.25))? as f32, num("vibratoDelay", Some(0.25))? as f32, num("vibratoHz", Some(5.5))? as f32);
        let (dynamics, breathiness, motion_scale) = (num("dynamics", Some(0.0))? as f32, num("breathiness", Some(1.0))? as f32, num("motionScale", Some(1.0))? as f32);
        let mut under = Rules::default();
        match opt(&j, "diction") {
            None => {}
            Some(v) => rules_of(v, &mut under)?,
        }
        let mut who = Who::default();
        // the voice by the name people call it, where the part says one
        let name = |k: &str| opt(&j, k).map(|v| v.str().map(str::to_string).map_err(|e| Error(format!("the part's {k}: {}", e.0)))).transpose();
        who.track = name("name")?;
        who.voice = match name("called")? {
            Some(c) => Some(c),
            None => name("voice")?,
        };
        if let Some(v) = opt(&j, "tags") {
            who.tags = v.arr()?.iter().map(|t| t.str().map(str::to_string)).collect::<Result<_>>().map_err(|e| Error(format!("the part's tags: {}", e.0)))?;
        }
        let style_at = |shift: f32| Style {
            vibrato,
            vibrato_delay,
            glide: glide as usize,
            dynamics,
            breathiness,
            motion: motion.clone(),
            motion_scale,
            who: who.clone(),
            ..style(shift, vibrato_hz, seed as u32)
        };
        let part = lipservice::part::Part {
            song: &song,
            sex,
            seed: seed as u64,
            at,
            shift: shift0,
            jitter: num("jitter", Some(0.0))?,
            detune: num("detune", Some(0.0))?,
            spread: num("spread", Some(0.0))?,
            breath,
        };
        let breaths = s.breaths.take();
        if (breath > 0.0 || marked) && breaths.is_none() {
            s.breaths = breaths;
            return Err(Error("the part breathes and the breaths are not loaded (ls_breaths)".into()));
        }
        let lib = if breath > 0.0 || marked { breaths.as_ref().map(|b| &b.0) } else { None };
        let (v, sound, ph) = match parts(s, voice) {
            Ok(x) => x,
            Err(e) => {
                s.breaths = breaths;
                return Err(e);
            }
        };
        let done = lipservice::part::perform_as(&part, lipservice::part::Manner { together, give, wants: &wants }, lib, |text, shift| {
            let t = if clocked { lipservice::part::clocked(text)? } else { text.to_string() };
            let plan = sing::plan(&v.score, ph, &Song::parse_under(&choir::sized(&t, size)?, under.clone())?, 0, &style_at(shift as f32))?;
            let rests = plan.rests();
            Ok((plan, rests))
        });
        s.breaths = breaths;
        let done = done?;
        let render = match sound {
            Sound::Vox(x) => Render::Vox(x),
            Sound::Voc(voc) => Render::Voc(voc),
        };
        let rests = done.singer.rests().iter().flat_map(|r| [r.start as f32, r.end as f32]).collect();
        let n_of = |c: usize| s.breaths.as_ref().map_or(0, |b| b.0.clips[c].n);
        let bs: Vec<String> = done.breaths.iter().map(|&(c, at)| format!("[{at},{}]", n_of(c))).collect();
        s.info = format!("{{\"text\":{},\"breaths\":[{}],\"lag\":{},\"shift\":{}}}", json_str(&done.text), bs.join(","), done.lag, done.shift);
        let words = lipservice::timing::words_of(&done.text)?;
        let sung = Song::parse_under(&done.text, under)?;
        let sg = Singer { v, render, seed: seed as u64, plan: done.singer, from: 0, st: None, rests, breaths: done.breaths, pos: 0, words, bpm: sung.bpm, rules: sung.diction.lines() };
        Ok(slot(&mut s.singers, sg))
    })
}

/// The length of what ls_perform left at ls_info.
#[no_mangle]
pub extern "C" fn ls_perform_info() -> i32 {
    run(|s| Ok(s.info.len() as i32))
}

/// The song's length in frames (10 ms each).
#[no_mangle]
pub extern "C" fn ls_sing_frames(h: i32) -> i32 {
    run(|s| Ok(singer(&mut s.singers, h)?.plan.lf0.len() as i32))
}

/// Picks the song up at `frame`: the next samples ls_sing_step gives are the song's from there (240
/// a frame), the same as it gives them sung from its start. The plan stays as it is; the sound is
/// made from a little before, for each layer's past, when the next step is asked for.
#[no_mangle]
pub extern "C" fn ls_sing_seek(h: i32, frame: usize) -> i32 {
    run(|s| {
        let sg = singer(&mut s.singers, h)?;
        if frame > sg.plan.lf0.len() {
            return Err(Error(format!("frame {frame} of a song of {}", sg.plan.lf0.len())));
        }
        (sg.from, sg.st, sg.pos) = (frame, None, frame * HOP);
        Ok(0)
    })
}

/// The next samples of the song, `frames` score frames on (at ls_out): how many; 0 once it is done.
#[no_mangle]
pub extern "C" fn ls_sing_step(h: i32, frames: usize) -> i32 {
    run(|s| {
        let sg = singer(&mut s.singers, h)?;
        let st = sg.stream()?;
        s.out.clear();
        while s.out.is_empty() && !st.done() {
            st.step(frames.max(1), &mut s.out);
        }
        // its breaths where they fall in these samples, as worker.js added them
        if !sg.breaths.is_empty() {
            let (lib, pcm) = s.breaths.as_ref().ok_or_else(|| Error("the breaths are not loaded (ls_breaths)".into()))?;
            let (s0, k) = (sg.pos as i64, 1.0 / 32767.0);
            for &(c, at) in &sg.breaths {
                let clip = &lib.clips[c];
                let (lo, hi) = (s0.max(at), (s0 + s.out.len() as i64).min(at + clip.n as i64));
                for t in lo..hi {
                    let v = &mut s.out[(t - s0) as usize];
                    *v = (*v as f64 + pcm[clip.at + (t - at) as usize] as f64 * k) as f32;
                }
            }
        }
        sg.pos += s.out.len();
        Ok(s.out.len() as i32)
    })
}

/// The song's silent spans (the lead-in and the rests), at ls_out as frame pairs: start, end, ...;
/// how many numbers.
#[no_mangle]
pub extern "C" fn ls_sing_rests(h: i32) -> i32 {
    run(|s| {
        let r = singer(&mut s.singers, h)?.rests.clone();
        s.out = r;
        Ok(s.out.len() as i32)
    })
}

/// Log F0 and voicing of the song's frames [from, as far as made), at ls_out, a pair a frame: how
/// many numbers. A song picked up part way has none before a little ahead of where it was picked up.
#[no_mangle]
pub extern "C" fn ls_sing_pitch(h: i32, from: usize) -> i32 {
    run(|s| {
        let st = singer(&mut s.singers, h)?.stream()?;
        let from = from.checked_sub(st.base()).ok_or_else(|| Error(format!("frame {from}: none made before {}", st.base())))?;
        let (lf0, vuv) = st.pitch();
        let p = pairs(lf0, vuv, from)?;
        s.out = p;
        Ok(s.out.len() as i32)
    })
}

/// What the song sang when (lipservice::timing), in samples of its sound from its start: JSON at
/// ls_info, {rate, length, bpm, beat_zero (the sample written beat 0 falls on), phones, words
/// ([[start, end, text]]), notes ([[start, end, midi as sung, word]]), pitch (Hz a frame, 0 unvoiced,
/// as far as sung)}; its length in bytes. A song picked up
/// part way has no pitch before where it was picked up.
#[no_mangle]
pub extern "C" fn ls_sing_timing(h: i32) -> i32 {
    run(|s| {
        let sg = singer(&mut s.singers, h)?;
        let n = sg.plan.lf0.len() * HOP;
        let st = sg.stream()?;
        if st.base() != 0 {
            return Err(Error(format!("song {h} was picked up at frame {}: its timing is a whole song's", st.base())));
        }
        let (lf0, vuv) = st.pitch();
        let (lf0, vuv) = (lf0.to_vec(), vuv.to_vec());
        let t = lipservice::timing::sung(&sg.plan.tokens, &sg.plan.durations, &sg.words, &sg.plan.notes, &lf0, &vuv)?;
        let (bpm, zero) = (sg.bpm, (lipservice::part::LEAD * lipservice::part::SR).round() as i64);
        s.info = format!("{{\"rate\":{},\"length\":{n},\"bpm\":{bpm},\"beat_zero\":{zero},{}}}", lipservice::dsp::SR, t.json_fields());
        Ok(s.info.len() as i32)
    })
}

/// The song as planned, JSON at ls_info: {words (lipservice::timing::planned), rules (its diction's
/// rules as lines, in the order the words' by and dip count)}: its length in bytes.
#[no_mangle]
pub extern "C" fn ls_sing_plan(h: i32) -> i32 {
    run(|s| {
        let sg = singer(&mut s.singers, h)?;
        let words = lipservice::timing::planned(&sg.plan.tokens, &sg.plan.durations, &sg.plan.closes, &sg.plan.by, &sg.words)?;
        s.info = format!("{{\"words\":{words},\"rules\":[{}]}}", sg.rules.iter().map(|l| json_str(l)).collect::<Vec<_>>().join(","));
        Ok(s.info.len() as i32)
    })
}

#[no_mangle]
pub extern "C" fn ls_sing_close(h: i32) -> i32 {
    run(|s| {
        singer(&mut s.singers, h)?;
        s.singers[h as usize] = None;
        Ok(0)
    })
}

// ---- the models on this machine (lipservice::home), for the Python package; not in the browser,
// which fetches through its own page. The bytes are moved by the caller's function, `get`: it is
// handed a URL and a file path and returns 0, or calls ls_home_fail with why and returns another.

#[cfg(not(target_arch = "wasm32"))]
mod home_abi {
    use super::{run, text};
    use lipservice::home::Home;
    use lipservice::weights::{Error, Result};
    use std::cell::RefCell;
    use std::path::Path;
    use std::sync::Mutex;

    pub type GetFn = extern "C" fn(*const u8, usize, *const u8, usize) -> i32;

    static HOME: Mutex<Option<Home>> = Mutex::new(None);

    thread_local! {
        static FAILED: RefCell<String> = RefCell::new(String::new());
        static OUT: RefCell<String> = RefCell::new(String::new());
    }

    fn getter(get: GetFn) -> impl FnMut(&str, &Path) -> Result<()> {
        move |url: &str, out: &Path| {
            let p = out.to_string_lossy();
            FAILED.with(|f| f.borrow_mut().clear());
            match get(url.as_ptr(), url.len(), p.as_ptr(), p.len()) {
                0 => Ok(()),
                _ => Err(Error(FAILED.with(|f| f.borrow().clone()))),
            }
        }
    }

    fn give(s: String) -> i32 {
        let n = s.len() as i32;
        OUT.with(|o| *o.borrow_mut() = s);
        n
    }

    #[no_mangle]
    pub extern "C" fn ls_home_fail(p: *const u8, n: usize) {
        let msg = text(p, n).unwrap_or("a failure that is not utf-8").to_string();
        FAILED.with(|f| *f.borrow_mut() = msg);
    }

    /// The last ls_home_* answer, utf-8, its length the call's return.
    #[no_mangle]
    pub extern "C" fn ls_home_out() -> *const u8 {
        OUT.with(|o| o.borrow().as_ptr())
    }

    /// Opens the models (once a process): the kept manifest's text, the server's when none is
    /// kept; its length the return.
    #[no_mangle]
    pub extern "C" fn ls_home_manifest(get: GetFn) -> i32 {
        run(|_| {
            let mut home = HOME.lock().map_err(|_| Error("the models' lock is poisoned".into()))?;
            if home.is_none() {
                *home = Some(Home::open(&mut getter(get))?);
            }
            Ok(give(home.as_ref().unwrap().text.clone()))
        })
    }

    /// As ls_home_manifest, the server's manifest read again first, in this process too.
    #[no_mangle]
    pub extern "C" fn ls_home_update(get: GetFn) -> i32 {
        run(|_| {
            let mut home = HOME.lock().map_err(|_| Error("the models' lock is poisoned".into()))?;
            let new = Home::update(&mut getter(get))?;
            let text = new.text.clone();
            *home = Some(new);
            Ok(give(text))
        })
    }

    /// Where model file NAME is, fetched first if it is not kept or has changed: its path's length.
    #[no_mangle]
    pub extern "C" fn ls_home_path(p: *const u8, n: usize, get: GetFn) -> i32 {
        run(|_| {
            let name = text(p, n)?.to_string();
            let mut home = HOME.lock().map_err(|_| Error("the models' lock is poisoned".into()))?;
            if home.is_none() {
                *home = Some(Home::open(&mut getter(get))?);
            }
            let path = home.as_ref().unwrap().path(&name, &mut getter(get))?;
            Ok(give(path.to_string_lossy().into_owned()))
        })
    }

    /// The folder the models are read from: its length.
    #[no_mangle]
    pub extern "C" fn ls_home_dir(get: GetFn) -> i32 {
        run(|_| {
            let mut home = HOME.lock().map_err(|_| Error("the models' lock is poisoned".into()))?;
            if home.is_none() {
                *home = Some(Home::open(&mut getter(get))?);
            }
            Ok(give(home.as_ref().unwrap().dir.to_string_lossy().into_owned()))
        })
    }
}
