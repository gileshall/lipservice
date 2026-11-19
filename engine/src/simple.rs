// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! The command line for people: the models found by name and fetched on first use (lipservice::home),
//! the same commands as the Python package's.
//!
//!     lipservice say "Hello there." [-o FILE.wav] [--voice ada] [--quality hifi] [--rate 1] [--shift 0] [--seed 0] [--ssml]
//!     lipservice sing SONG.txt [-o FILE.wav] [--voice ada] [--quality hifi] [--shift 0] [--seed 0] [--vibrato 0.25]
//!         [--vibrato-hz 5.5] [--vibrato-delay 0.25] [--motion straight|vibrato|wide] [--motion-scale 1]
//!         [--glide 9] [--dynamics 0] [--breathiness 1] [--diction]
//!     lipservice voices
//!     lipservice fetch [--quality hifi|fast|all]
//!
//! TEXT or SONG.txt as - is read from stdin. Without -o the sound is played (afplay on macOS, aplay
//! on Linux). say and sing build the file arguments the engine's own forms take and run those, so
//! the samples are theirs.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use lipservice::home::{Home, MOTIONS, QUALITIES};
use lipservice::weights::{err, Error, Result};

pub const USAGE: &str = "usage:
  lipservice say TEXT [-o FILE.wav] [--voice ada] [--quality hifi|fast] [--rate 1] [--shift 0] [--seed 0] [--ssml]
  lipservice sing SONG.txt [-o FILE.wav] [--voice ada] [--quality hifi|fast] [--shift 0] [--seed 0] [--vibrato 0.25]
      [--vibrato-hz 5.5] [--vibrato-delay 0.25] [--motion straight|vibrato|wide] [--motion-scale 1] [--glide 9]
      [--dynamics 0] [--breathiness 1] [--diction]
  lipservice voices
  lipservice fetch [--quality hifi|fast|all]
  lipservice --version

TEXT or SONG.txt as - is read from stdin. Without -o the sound is played. The models are fetched
from https://models.lipservice.dev on first use and kept (LIPSERVICE_CACHE says where);
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
    e.extend(["--base".into(), path("base.lsw")?]);
    // the engine's own command line loads no mel route to sing through the vocoder, so takes no mel part there
    match (kind, q.as_str()) {
        (_, "hifi") => e.extend(["--vox-part".into(), path(&format!("hifi/voices/{v}.lsw"))?]),
        ("say", _) => e.extend(["--mel-part".into(), path(&format!("fast/voices/{v}.lsw"))?]),
        _ => {}
    }
    if kind == "say" {
        e.extend(["--breaks".into(), path("breaks.lsw")?]);
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
        for f in ["--shift", "--seed", "--vibrato", "--vibrato-hz", "--vibrato-delay", "--motion-scale", "--glide", "--dynamics", "--breathiness"] {
            if let Some(x) = a.value(f)? {
                e.extend([f.into(), x]);
            }
        }
        if a.switch("--diction") {
            e.push("--diction".into());
        }
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
    let home = Home::open(&mut get)?;
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
