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
//! an error. Speech goes at each voice's speaker's pace (voice.pace). A call that fails returns -1
//! and leaves its message at ls_error.

use std::cell::RefCell;
use std::rc::Rc;

use lipservice::breaks::Breaks;
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
    motions: Vec<Motion>,
    singers: Vec<Option<Singer>>,
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
        Ok(n)
    })
}

/// The next samples of the passage, `frames` score frames on (at ls_out): how many, 0 once done.
#[no_mangle]
pub extern "C" fn ls_step(frames: usize) -> i32 {
    run(|s| {
        let st = s.stream.as_mut().ok_or_else(|| Error("nothing being said".into()))?;
        s.out.clear();
        while s.out.is_empty() && !st.done() {
            st.step(frames.max(1), &mut s.out)?;
        }
        if s.out.is_empty() {
            s.stream = None;
        }
        Ok(s.out.len() as i32)
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
        diction: false,
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

/// A song to sing a step at a time: its handle. Any number are open at once; each is closed with
/// ls_sing_close. The style is the CLI's `sing` flags: vibrato (peak semitones) at vibrato_hz from
/// vibrato_delay seconds into a vowel, glide (frames), dynamics, breathiness, diction (0 or 1), and
/// motion (from ls_motion, in place of the vibrato; motion_scale times its singer's own size) or
/// -1; with ls_sing's (0.25, 5.5, 0.25, 9, 0, 1, 0, -1, 1), its samples.
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
    diction: u32,
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
        let diction = match diction {
            0 => false,
            1 => true,
            _ => return Err(Error(format!("diction {diction}: 0 or 1"))),
        };
        let motion = match motion {
            -1 => None,
            m => Some(usize::try_from(m).ok().and_then(|i| s.motions.get(i)).ok_or_else(|| Error(format!("no motion {m}")))?.clone()),
        };
        let st = Style { vibrato, vibrato_delay, glide: glide as usize, dynamics, breathiness, diction, motion, motion_scale, ..style(shift, vibrato_hz, seed) };
        let (v, sound, ph) = parts(s, voice)?;
        let render = match sound {
            Sound::Vox(x) => Render::Vox(x),
            Sound::Voc(voc) => Render::Voc(voc),
        };
        let song = Song::parse(text(p, n)?)?;
        let plan = sing::plan(&v.score, ph, &song, 0, &st)?;
        let rests = plan.rests().iter().flat_map(|r| [r.start as f32, r.end as f32]).collect();
        let at = match s.singers.iter().position(Option::is_none) {
            Some(i) => i,
            None => {
                s.singers.push(None);
                s.singers.len() - 1
            }
        };
        s.singers[at] = Some(Singer { v, render, seed: seed as u64, plan, from: 0, st: None, rests });
        Ok(at as i32)
    })
}

fn singer<'a>(singers: &'a mut [Option<Singer>], h: i32) -> Result<&'a mut Singer> {
    usize::try_from(h).ok().and_then(|i| singers.get_mut(i)).and_then(Option::as_mut).ok_or_else(|| Error(format!("no song {h} open")))
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
        (sg.from, sg.st) = (frame, None);
        Ok(0)
    })
}

/// The next samples of the song, `frames` score frames on (at ls_out): how many; 0 once it is done.
#[no_mangle]
pub extern "C" fn ls_sing_step(h: i32, frames: usize) -> i32 {
    run(|s| {
        let st = singer(&mut s.singers, h)?.stream()?;
        s.out.clear();
        while s.out.is_empty() && !st.done() {
            st.step(frames.max(1), &mut s.out);
        }
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

    /// Opens the models (once a process): the manifest's text, its length the return.
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
