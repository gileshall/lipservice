// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The command line for people: the models found by name and fetched on first use (lipservice::home),
//! the same commands as the Python package's.
//!
//!     lipservice say "Hello there." [-o FILE.wav] [--voice ada] [--quality hifi] [--rate 1] [--shift 0] [--seed 0] [--ssml]
//!     lipservice sing SONG.txt [-o FILE.wav] [--voice ada] [--quality hifi] [--shift 0] [--seed 0] [--vibrato 0.25]
//!         [--vibrato-hz 5.5] [--vibrato-delay 0.25] [--motion straight|vibrato|wide] [--motion-scale 1]
//!         [--glide 9] [--dynamics 0] [--consonants 1] [--breathiness 1] [--rules RULES.txt]
//!     lipservice choir PIECE [-o FILE.wav] [--timing FILE.json] [--quality hifi] [--seed N] [--room ROOM]
//!         [--motion straight|vibrato|wide|none] [--voices NAME,NAME,...] [--sway X] [--vibrato X] [--loose X]
//!         [--glide N] [--dynamics X] [--breath X] [--breathiness X]
//!     lipservice voices
//!     lipservice choirs
//!     lipservice fetch [--quality hifi|fast|all]
//!
//! TEXT, SONG.txt or PIECE as - is read from stdin. Without -o the sound is played (afplay on macOS,
//! aplay on Linux). say and sing build the file arguments the engine's own forms take and run those,
//! as a voice heard alone goes out (--alone), so the samples are theirs and the package's. choir
//! sings a piece for several voices (lipservice::piece): one of `choirs` by name, or a JSON file.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::time::Instant;

use lipservice::home::{Home, MOTIONS, QUALITIES};
use lipservice::json::Json;
use lipservice::piece::{self, Cast, HOW};
use lipservice::sing::Motion;
use lipservice::stream::Render;
use lipservice::vocoder::Vocoder;
use lipservice::voice::{Base, Voice};
use lipservice::vox::{Model, Vox};
use lipservice::weights::{err, Error, Result, Weights};

pub const USAGE: &str = "usage:
  lipservice say TEXT [-o FILE.wav] [--timing FILE.json] [--voice ada] [--quality hifi|fast] [--rate 1] [--shift 0]
      [--seed 0] [--ssml]
  lipservice sing SONG.txt [-o FILE.wav] [--timing FILE.json] [--voice ada] [--quality hifi|fast] [--shift 0]
      [--seed 0] [--vibrato 0.25] [--vibrato-hz 5.5] [--vibrato-delay 0.25] [--motion straight|vibrato|wide]
      [--motion-scale 1] [--glide 9] [--dynamics 0] [--consonants 1] [--breathiness 1] [--rules RULES.txt]
  lipservice choir PIECE [-o FILE.wav] [--timing FILE.json] [--quality hifi|fast] [--seed N] [--room ROOM]
      [--motion straight|vibrato|wide|none] [--voices NAME,NAME,...] [--sway X] [--vibrato X] [--loose X]
      [--glide N] [--dynamics X] [--breath X] [--breathiness X]
  lipservice voices
  lipservice choirs
  lipservice fetch [--quality hifi|fast|all]
  lipservice --version

TEXT, SONG.txt or PIECE as - is read from stdin. Without -o the sound is played. choir sings a piece
for several voices, seated and in a room, in stereo: PIECE is one of `lipservice choirs`, or a
piece's JSON file. --timing writes what each voice did when (phones, words, notes, breaths, pitch
and loudness, in samples) as JSON. The models are fetched
from https://models.lipservice.dev on first use and kept (LIPSERVICE_CACHE says where), with the
list of them; after that the server is asked nothing until fetch, which reads its list again.
LIPSERVICE_MODELS names a folder that already holds them.";

/// The bytes at a URL to a file, by curl, which every Mac, Windows 10 and later, and common
/// Linux carry. The file's hash is checked by home.rs, whatever moved it.
fn curl(url: &str, out: &Path) -> Result<()> {
    let r = Command::new("curl").args(["--fail", "--silent", "--show-error", "--location", "--retry", "2", "-A", "lipservice", "-o"]).arg(out).arg(url).output();
    match r {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => err("curl is not on this machine to fetch the models with: install curl, or set LIPSERVICE_MODELS to a folder that holds them"),
        Err(e) => err(format!("curl: {e}")),
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => err(String::from_utf8_lossy(&o.stderr).trim().trim_start_matches("curl: ").to_string()),
    }
}

struct Args {
    rest: Vec<String>,
}

impl Args {
    fn value(&mut self, name: &str) -> Result<Option<String>> {
        match self.rest.iter().position(|a| a == name) {
            None => Ok(None),
            Some(i) if i + 1 < self.rest.len() => {
                let v = self.rest.remove(i + 1);
                self.rest.remove(i);
                if self.rest.iter().any(|a| a == name) {
                    return err(format!("{name} given twice"));
                }
                Ok(Some(v))
            }
            Some(_) => err(format!("{name} takes a value")),
        }
    }

    fn switch(&mut self, name: &str) -> bool {
        let before = self.rest.len();
        self.rest.retain(|a| a != name);
        before != self.rest.len()
    }

    fn done(&self) -> Result<()> {
        match self.rest.first() {
            None => Ok(()),
            Some(a) => err(format!("{a}: not an option here\n\n{USAGE}")),
        }
    }
}

fn stdin_all() -> Result<String> {
    let mut s = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).map_err(|e| Error(format!("stdin: {e}")))?;
    Ok(s)
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The length of a WAV file the engine wrote, seconds: its data over 4 bytes a sample at 24 kHz.
fn seconds(p: &Path) -> Result<f64> {
    let b = std::fs::read(p).map_err(|e| Error(format!("{}: {e}", p.display())))?;
    let i = b.windows(4).position(|w| w == b"data").ok_or_else(|| Error(format!("{}: no data chunk", p.display())))?;
    let n = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as f64;
    Ok(n / 4.0 / lipservice::dsp::SR as f64)
}

fn play(p: &Path) -> Result<()> {
    let player: &[&str] = match std::env::consts::OS {
        "macos" => &["afplay"],
        "linux" => &["aplay", "-q"],
        os => return err(format!("no player for {os}: give -o FILE.wav to write a file")),
    };
    match Command::new(player[0]).args(&player[1..]).arg(p).status() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => err(format!("{} is not on this machine to play it with: give -o FILE.wav to write a file", player[0])),
        Err(e) => err(format!("{}: {e}", player[0])),
        Ok(st) if st.success() => Ok(()),
        Ok(st) => err(format!("{}: {st}", player[0])),
    }
}

fn quality(a: &mut Args) -> Result<String> {
    let q = a.value("--quality")?.unwrap_or_else(|| "hifi".into());
    if !QUALITIES.contains(&q.as_str()) {
        return err(format!("quality {q:?}: {}", QUALITIES.join(", ")));
    }
    Ok(q)
}

/// say or sing: the engine's form of it, run with the found files.
pub fn speak(kind: &str, args: &[String], engine: impl Fn(&[String]) -> Result<()>) -> Result<()> {
    let mut a = Args { rest: args[1..].to_vec() };
    if a.rest.is_empty() {
        return err(USAGE);
    }
    let what = a.rest.remove(0);
    let out = match a.value("-o")? {
        Some(o) => Some(o),
        None => a.value("--out")?,
    };
    let timing = a.value("--timing")?;
    let voice = a.value("--voice")?.unwrap_or_else(|| "ada".into());
    let q = quality(&mut a)?;
    let mut get = curl;
    let home = Home::open(&mut get)?;
    let v = home.voice(&voice)?.name.clone();
    let mut path = |n: &str| home.path(n, &mut get).map(|p| s(&p));
    let tmp = std::env::temp_dir().join(format!("lipservice-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| Error(format!("{}: {e}", tmp.display())))?;
    let wav: PathBuf = match &out {
        Some(o) => PathBuf::from(o),
        None => tmp.join("clip.wav"),
    };
    let sound = match (kind, q.as_str()) {
        (_, "hifi") => "hifi/vox.lsw",
        ("say", _) => "fast/melvoc.lsw",
        _ => "fast/vocoder.lsw",
    };
    let mut e: Vec<String> = vec![kind.into(), path(&format!("voices/{v}.lsw"))?, path(sound)?, path("g2p.lsw")?, path("lexicon.lsw")?, s(&wav)];
    if kind == "say" {
        e.push(if what == "-" { stdin_all()? } else { what.clone() });
    } else if what == "-" {
        let song = tmp.join("song.txt");
        std::fs::write(&song, stdin_all()?).map_err(|e| Error(format!("{}: {e}", song.display())))?;
        e.push(s(&song));
    } else {
        e.push(what.clone());
    }
    e.extend(["--alone".into(), "--base".into(), path("base.lsw")?]);
    if let Some(t) = &timing {
        e.extend(["--timing".into(), t.clone(), "--named".into(), v.clone()]);
    }
    // the engine's own command line loads no mel route to sing through the vocoder, so takes no mel part there
    match (kind, q.as_str()) {
        (_, "hifi") => e.extend(["--vox-part".into(), path(&format!("hifi/voices/{v}.lsw"))?]),
        ("say", _) => e.extend(["--mel-part".into(), path(&format!("fast/voices/{v}.lsw"))?]),
        _ => {}
    }
    if kind == "say" {
        // a part at a time, as the package says it: paragraphs with a pause between
        e.extend(["--breaks".into(), path("breaks.lsw")?, "--stream".into(), "100".into()]);
        for f in ["--rate", "--shift", "--seed"] {
            if let Some(x) = a.value(f)? {
                e.extend([f.into(), x]);
            }
        }
        if a.switch("--ssml") {
            e.push("--ssml".into());
        }
    } else {
        if let Some(m) = a.value("--motion")? {
            if !MOTIONS.contains(&m.as_str()) {
                return err(format!("motion {m:?}: {}", MOTIONS.join(", ")));
            }
            e.extend(["--motion".into(), path(&format!("motion/{m}.lsw"))?]);
        }
        for f in ["--shift", "--seed", "--vibrato", "--vibrato-hz", "--vibrato-delay", "--motion-scale", "--glide", "--dynamics", "--consonants", "--breathiness", "--rules"] {
            if let Some(x) = a.value(f)? {
                e.extend([f.into(), x]);
            }
        }
        if a.switch("--diction") {
            e.push("--diction".into());
        }
        e.extend(["--for".into(), v.clone()]);
    }
    a.done()?;
    let t = Instant::now();
    let made = engine(&e);
    let took = t.elapsed().as_secs_f64();
    let result = made.and_then(|()| {
        eprintln!("lipservice: {kind}, {v}, {q}: {:.2} s of sound in {took:.2} s", seconds(&wav)?);
        if out.is_none() {
            play(&wav)?;
        }
        Ok(())
    });
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

fn read(p: &Path) -> Result<Weights> {
    Weights::read(&s(p))
}

fn text_of(p: &Path) -> Result<String> {
    std::fs::read_to_string(p).map_err(|e| Error(format!("{}: {e}", p.display())))
}

fn obj(kv: Vec<(&str, Json)>) -> Json {
    Json::Obj(kv.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

pub fn choirs(args: &[String]) -> Result<()> {
    if args.len() != 1 {
        return err(USAGE);
    }
    let mut get = curl;
    let home = Home::open(&mut get)?;
    let all = Json::parse(&text_of(&home.path("choirs.json", &mut get)?)?)?;
    for n in piece::names(&all)? {
        println!("{n}");
    }
    Ok(())
}

/// A piece for several voices, sung whole (lipservice::piece), as the package's choir() sings it.
pub fn choir(args: &[String]) -> Result<()> {
    let mut a = Args { rest: args[1..].to_vec() };
    if a.rest.is_empty() {
        return err(USAGE);
    }
    let what = a.rest.remove(0);
    let out = match a.value("-o")? {
        Some(o) => Some(o),
        None => a.value("--out")?,
    };
    let timing = a.value("--timing")?;
    let q = quality(&mut a)?;
    let num = |name: &str, v: String| v.parse::<f64>().map_err(|_| Error(format!("{name} {v}: not a number")));
    let mut ask: Vec<(&str, Json)> = Vec::new();
    if let Some(v) = a.value("--seed")? {
        ask.push(("seed", Json::Num(num("--seed", v)?)));
    }
    if let Some(v) = a.value("--room")? {
        ask.push(("room", Json::Str(v)));
    }
    if let Some(v) = a.value("--motion")? {
        ask.push(("motion", Json::Str(v)));
    }
    if let Some(v) = a.value("--voices")? {
        // a voice a part, an empty place the part's own
        ask.push(("voices_by_part", Json::Arr(v.split(',').map(|n| if n.trim().is_empty() { Json::Null } else { Json::Str(n.trim().to_string()) }).collect())));
    }
    let mut how = Vec::new();
    for k in HOW {
        let flag = format!("--{k}");
        if let Some(v) = a.value(&flag)? {
            how.push((k, Json::Num(num(&flag, v)?)));
        }
    }
    ask.push(("how", obj(how)));
    a.done()?;
    let mut get = curl;
    let home = Home::open(&mut get)?;
    let all = Json::parse(&text_of(&home.path("choirs.json", &mut get)?)?)?;
    let piece = if what == "-" {
        Json::parse(&stdin_all()?)?
    } else if piece::names(&all)?.contains(&what.as_str()) {
        Json::Str(what.clone())
    } else if Path::new(&what).is_file() {
        Json::parse(&text_of(Path::new(&what))?).map_err(|e| Error(format!("{what}: {e}")))?
    } else {
        return err(format!("no choir '{what}': it is not one of `lipservice choirs`, and there is no such file"));
    };
    ask.push(("piece", piece));
    ask.push(("choirs", all));
    ask.push(("list", Json::Arr(home.voices.iter().map(|v| obj(vec![("name", Json::Str(v.id.clone())), ("sex", Json::Str(v.sex.clone())), ("label", Json::Str(v.name.clone()))])).collect())));
    let wanted = piece::wanted(&obj(ask), &q)?;
    let t = Instant::now();
    let arranged = &wanted.arranged;
    let label = |id: &str| home.voices.iter().find(|v| v.id == id).map(|v| v.name.clone()).ok_or_else(|| Error(format!("no voice {id}")));
    let base = Base::load(read(&home.path("base.lsw", &mut get)?)?)?;
    let (model, voc) = match q.as_str() {
        "hifi" => (Some(Rc::new(Model::load(read(&home.path("hifi/vox.lsw", &mut get)?)?)?)), None),
        _ => (None, Some(Vocoder::load(&read(&home.path("fast/vocoder.lsw", &mut get)?)?)?)),
    };
    // each voice once: its file, and on hifi its parts of the latent voice
    let ids = wanted.voices();
    let (mut voices, mut worn) = (Vec::new(), Vec::new());
    for id in &ids {
        let name = label(id)?;
        let mut ws = read(&home.path(&format!("voices/{name}.lsw"), &mut get)?)?;
        if model.is_some() {
            ws.join(read(&home.path(&format!("hifi/voices/{name}.lsw"), &mut get)?)?, None)?;
            ws.has_parts(&["vox"])?;
        }
        let mut v = Voice::load_on(ws, &base, None, false)?;
        if let Some(m) = &model {
            let w = v.vox.take().ok_or_else(|| Error(format!("voice {name} has no parts of the latent voice")))?;
            worn.push(Vox::wear(m, w)?);
        }
        voices.push(v);
    }
    let names = wanted.motions();
    let mut loaded = Vec::new();
    for m in &names {
        loaded.push(Motion::load(&read(&home.path(&format!("motion/{m}.lsw"), &mut get)?)?)?);
    }
    let cast: Vec<Cast> = arranged
        .singers
        .iter()
        .map(|p| {
            let i = ids.iter().position(|id| *id == p.voice).unwrap();
            Cast { voice: &voices[i], render: match &voc { Some(v) => Render::Voc(v), None => Render::Vox(&worn[i]) } }
        })
        .collect();
    let motions: Vec<Option<Motion>> = arranged.singers.iter().map(|p| p.motion.as_ref().map(|m| loaded[names.iter().position(|n| n == m).unwrap()].clone())).collect();
    let breaths = lipservice::part::breaths_of(
        "breaths.json",
        &text_of(&home.path("page/breaths.json", &mut get)?)?,
        "breaths.bin",
        &std::fs::read(home.path("page/breaths.bin", &mut get)?).map_err(|e| Error(format!("breaths.bin: {e}")))?,
    )?;
    let mut ph = super::phonemizer(&s(&home.path("g2p.lsw", &mut get)?), &s(&home.path("lexicon.lsw", &mut get)?))?;
    let sung = piece::sing(arranged, Some(&breaths), &mut ph, &cast, &motions)?;
    let took = t.elapsed().as_secs_f64();
    let tmp = std::env::temp_dir().join(format!("lipservice-{}", std::process::id()));
    let wav: PathBuf = match &out {
        Some(o) => PathBuf::from(o),
        None => {
            std::fs::create_dir_all(&tmp).map_err(|e| Error(format!("{}: {e}", tmp.display())))?;
            tmp.join("clip.wav")
        }
    };
    let result = (|| {
        lipservice::wav::write_channels(&s(&wav), &[&sung.left, &sung.right], lipservice::dsp::SR as u32)?;
        if let Some(p) = &timing {
            let json = piece::timing_json(&sung, |id| label(id).expect("a voice it sang with"));
            std::fs::write(p, json).map_err(|e| Error(format!("{p}: {e}")))?;
        }
        eprintln!("lipservice: choir, {}, {q}: {:.2} s of sound in {took:.2} s", wanted.title, sung.left.len() as f64 / lipservice::dsp::SR as f64);
        if out.is_none() {
            play(&wav)?;
        }
        Ok(())
    })();
    if out.is_none() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    result
}

pub fn voices(args: &[String]) -> Result<()> {
    if args.len() != 1 {
        return err(USAGE);
    }
    let mut get = curl;
    let home = Home::open(&mut get)?;
    for v in &home.voices {
        println!("{}\t{}\t{}", v.name, v.sex, v.source);
    }
    Ok(())
}

pub fn fetch(args: &[String]) -> Result<()> {
    let mut a = Args { rest: args[1..].to_vec() };
    let which = a.value("--quality")?.unwrap_or_else(|| "hifi".into());
    a.done()?;
    let qs: Vec<&str> = match which.as_str() {
        "all" => QUALITIES.to_vec(),
        q if QUALITIES.contains(&q) => vec![q],
        q => return err(format!("quality {q:?}: {}, all", QUALITIES.join(", "))),
    };
    let mut get = curl;
    let home = Home::update(&mut get)?;
    let mut names: Vec<String> = Vec::new();
    for q in qs {
        for n in home.quality_files(q)? {
            if !names.contains(&n) {
                names.push(n);
            }
        }
    }
    for n in &names {
        home.path(n, &mut get)?;
    }
    eprintln!("lipservice: the models are in {}", home.dir.display());
    Ok(())
}
