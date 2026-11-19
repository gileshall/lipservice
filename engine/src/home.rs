// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Where the models live on this machine, and how they get there: the served manifest (its
//! files, each one's size and SHA-256, and the voices), the cache that keeps them, and the check
//! a fetched file must pass before it is kept. The bytes themselves are moved by the caller's
//! `Get` (the command line runs curl; the Python package, urllib), so this crate needs no network
//! code of its own.
//!
//! The manifest is read from the first source that gives it, once a process, and kept. When none
//! can be reached, the kept one is used, and that is said. A file is fetched when it is first
//! needed, or when the manifest's hash for it is not the one it was kept under. With
//! LIPSERVICE_MODELS set, that folder is the models, its manifest.json the list, and nothing is
//! fetched.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::json::Json;
use crate::weights::{err, Error, Result};

/// The manifest's layout this engine reads.
pub const FORMAT: usize = 1;
/// Where the models are served, in the order tried, unless LIPSERVICE_SOURCES names others
/// (separated by spaces).
pub const SOURCES: &[&str] = &["https://models.lipservice.dev"];

pub fn sources() -> Vec<String> {
    match std::env::var("LIPSERVICE_SOURCES") {
        Ok(v) if !v.trim().is_empty() => v.split_whitespace().map(String::from).collect(),
        _ => SOURCES.iter().map(|s| s.to_string()).collect(),
    }
}
pub const QUALITIES: &[&str] = &["hifi", "fast"];
pub const MOTIONS: &[&str] = &["straight", "vibrato", "wide"];

/// Moves the bytes at a URL to a file, or says why it could not.
pub type Get<'a> = &'a mut dyn FnMut(&str, &Path) -> Result<()>;

pub struct File {
    pub size: u64,
    pub sha256: String,
}

pub struct Voice {
    pub name: String,
    pub sex: String,
    pub source: String,
}

pub struct Home {
    /// The folder the files are read from.
    pub dir: PathBuf,
    /// Whether files may be fetched into it (not when LIPSERVICE_MODELS names it).
    fetches: bool,
    pub set: String,
    pub voices: Vec<Voice>,
    pub files: BTreeMap<String, File>,
    /// The manifest as read, for a caller that wants all of it.
    pub text: String,
}

fn io(what: &Path, e: std::io::Error) -> Error {
    Error(format!("{}: {e}", what.display()))
}

/// The folder fetched files are kept in.
pub fn cache() -> Result<PathBuf> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let top = match env("LIPSERVICE_CACHE") {
        Some(p) => p,
        None => match std::env::consts::OS {
            "macos" => env("HOME").ok_or_else(|| Error("HOME is not set, so there is nowhere to keep the models: set LIPSERVICE_CACHE".into()))?.join("Library/Caches/lipservice"),
            "windows" => env("LOCALAPPDATA").ok_or_else(|| Error("LOCALAPPDATA is not set, so there is nowhere to keep the models: set LIPSERVICE_CACHE".into()))?.join("lipservice").join("Cache"),
            _ => match env("XDG_CACHE_HOME") {
                Some(p) => p.join("lipservice"),
                None => env("HOME").ok_or_else(|| Error("HOME is not set, so there is nowhere to keep the models: set LIPSERVICE_CACHE".into()))?.join(".cache/lipservice"),
            },
        },
    };
    Ok(top.join("models"))
}

fn parse(text: &str, whence: &str) -> Result<(String, Vec<Voice>, BTreeMap<String, File>)> {
    let m = Json::parse(text).map_err(|e| Error(format!("{whence}: {e}")))?;
    let format = m.get("format").and_then(|f| f.count()).map_err(|e| Error(format!("{whence}: format: {e}")))?;
    if format != FORMAT {
        return err(format!("{whence}: model format {format}; this lipservice reads format {FORMAT}: upgrade it"));
    }
    let set = m.get("set")?.str()?.to_string();
    let mut voices = Vec::new();
    for v in m.get("voices")?.arr()? {
        voices.push(Voice { name: v.get("name")?.str()?.into(), sex: v.get("sex")?.str()?.into(), source: v.get("source")?.str()?.into() });
    }
    let mut files = BTreeMap::new();
    match m.get("files")? {
        Json::Obj(fs) => {
            for (name, f) in fs {
                let sha = f.get("sha256")?.str()?;
                if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return err(format!("{whence}: {name}: sha256 is not 64 hex digits"));
                }
                if name.split('/').any(|p| p.is_empty() || p == "." || p == "..") {
                    return err(format!("{whence}: {name}: not a plain path"));
                }
                files.insert(name.clone(), File { size: f.get("size")?.count()? as u64, sha256: sha.to_ascii_lowercase() });
            }
        }
        _ => return err(format!("{whence}: files is not an object")),
    }
    Ok((set, voices, files))
}

fn say(line: &str) {
    eprintln!("lipservice: {line}");
}

impl Home {
    /// The models: LIPSERVICE_MODELS's folder, or the cache with the served manifest.
    pub fn open(get: Get) -> Result<Home> {
        if let Some(given) = std::env::var_os("LIPSERVICE_MODELS").filter(|v| !v.is_empty()) {
            let dir = PathBuf::from(given);
            let p = dir.join("manifest.json");
            let text = fs::read_to_string(&p).map_err(|e| io(&p, e))?;
            let (set, voices, files) = parse(&text, &p.display().to_string())?;
            return Ok(Home { dir, fetches: false, set, voices, files, text });
        }
        let dir = cache()?;
        fs::create_dir_all(&dir).map_err(|e| io(&dir, e))?;
        let kept = dir.join("manifest.json");
        let part = dir.join(format!("manifest.json.{}.part", std::process::id()));
        let text = match fetch_from_sources("manifest.json", &part, get) {
            Ok(()) => {
                let text = fs::read_to_string(&part).map_err(|e| io(&part, e))?;
                parse(&text, "the server's manifest.json")?;
                fs::rename(&part, &kept).map_err(|e| io(&kept, e))?;
                text
            }
            Err(e) => {
                let _ = fs::remove_file(&part);
                if !kept.exists() {
                    return Err(e);
                }
                say(&format!("{e}; using the models kept in {}", dir.display()));
                fs::read_to_string(&kept).map_err(|e| io(&kept, e))?
            }
        };
        let (set, voices, files) = parse(&text, "the server's manifest.json")?;
        Ok(Home { dir, fetches: true, set, voices, files, text })
    }

    pub fn voice(&self, name: &str) -> Result<&Voice> {
        let n = name.to_ascii_lowercase();
        self.voices.iter().find(|v| v.name == n).ok_or_else(|| Error(format!("no voice {name:?}: {}", self.voices.iter().map(|v| v.name.as_str()).collect::<Vec<_>>().join(", "))))
    }

    /// Where file `name` is, fetched first if it is not kept or has changed.
    pub fn path(&self, name: &str, get: Get) -> Result<PathBuf> {
        let want = self.files.get(name).ok_or_else(|| Error(format!("no model file {name}")))?;
        let p = name.split('/').fold(self.dir.clone(), |p, part| p.join(part));
        if !self.fetches {
            if !p.exists() {
                return err(format!("{}: not in the folder LIPSERVICE_MODELS names", p.display()));
            }
        } else if !(p.exists() && kept(&self.dir)?.get(name) == Some(&want.sha256)) {
            self.fetch(name, want, &p, get)?;
        }
        let size = fs::metadata(&p).map_err(|e| io(&p, e))?.len();
        if size != want.size {
            return err(format!("{}: {size} bytes; the manifest has {}", p.display(), want.size));
        }
        Ok(p)
    }

    fn fetch(&self, name: &str, want: &File, p: &Path, get: Get) -> Result<()> {
        if let Some(d) = p.parent() {
            fs::create_dir_all(d).map_err(|e| io(d, e))?;
        }
        say(&format!("fetching {name}, {:.1} MB", want.size as f64 / 1e6));
        // named for this process, so two fetching the same file at once do not write into one
        let part = p.with_file_name(format!("{}.{}.part", p.file_name().and_then(|f| f.to_str()).unwrap_or("file"), std::process::id()));
        let checked = fetch_from_sources(name, &part, get).and_then(|()| {
            let size = fs::metadata(&part).map_err(|e| io(&part, e))?.len();
            let sha = sha256_file(&part)?;
            if (size, sha.as_str()) != (want.size, want.sha256.as_str()) {
                return err(format!("{name}: {size} bytes, sha256 {sha}; the manifest has {} bytes, sha256 {}", want.size, want.sha256));
            }
            Ok(())
        });
        if let Err(e) = checked {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
        fs::rename(&part, p).map_err(|e| io(p, e))?;
        keep(&self.dir, name, &want.sha256)
    }

    /// The files a quality needs before its first word, every voice's and motion's left out.
    pub fn base_files(quality: &str) -> Result<Vec<&'static str>> {
        Ok(match quality {
            "hifi" => vec!["hifi/vox.lsw", "base.lsw", "g2p.lsw", "lexicon.lsw", "breaks.lsw"],
            "fast" => vec!["fast/vocoder.lsw", "fast/melvoc.lsw", "base.lsw", "g2p.lsw", "lexicon.lsw", "breaks.lsw"],
            _ => return err(format!("quality {quality:?}: {}", QUALITIES.join(", "))),
        })
    }

    /// Every file a quality reads: what `fetch` keeps.
    pub fn quality_files(&self, quality: &str) -> Result<Vec<String>> {
        Home::base_files(quality)?;
        Ok(self.files.keys().filter(|n| match n.split('/').next() {
            Some(q) if QUALITIES.contains(&q) => q == quality,
            Some("page") => false,
            _ => true,
        }).cloned().collect())
    }
}

fn fetch_from_sources(rel: &str, out: &Path, get: Get) -> Result<()> {
    let mut failed = Vec::new();
    for src in sources() {
        let url = format!("{}/{rel}", src.trim_end_matches('/'));
        match get(&url, out) {
            Ok(()) => return Ok(()),
            Err(Error(e)) => {
                say(&format!("{url}: {e}"));
                failed.push(format!("{url}: {e}"));
            }
        }
    }
    err(format!("{rel} could not be fetched: {}", failed.join("; ")))
}

fn kept(dir: &Path) -> Result<BTreeMap<String, String>> {
    let p = dir.join("kept.json");
    if !p.exists() {
        return Ok(BTreeMap::new());
    }
    let text = fs::read_to_string(&p).map_err(|e| io(&p, e))?;
    let mut out = BTreeMap::new();
    match Json::parse(&text).map_err(|e| Error(format!("{}: {e}", p.display())))? {
        Json::Obj(m) => {
            for (k, v) in m {
                out.insert(k, v.str()?.to_string());
            }
        }
        _ => return err(format!("{}: not an object", p.display())),
    }
    Ok(out)
}

fn keep(dir: &Path, name: &str, sha: &str) -> Result<()> {
    let mut k = kept(dir)?;
    k.insert(name.to_string(), sha.to_string());
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let body: Vec<String> = k.iter().map(|(n, s)| format!(" \"{}\": \"{}\"", esc(n), esc(s))).collect();
    let p = dir.join("kept.json");
    let part = dir.join(format!("kept.json.{}.part", std::process::id()));
    fs::write(&part, format!("{{\n{}\n}}\n", body.join(",\n"))).map_err(|e| io(&part, e))?;
    fs::rename(&part, &p).map_err(|e| io(&p, e))
}

pub fn sha256_file(p: &Path) -> Result<String> {
    use std::io::Read;
    let mut f = fs::File::open(p).map_err(|e| io(p, e))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| io(p, e))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.hex())
}

/// SHA-256, FIPS 180-4.
pub struct Sha256 {
    h: [u32; 8],
    block: [u8; 64],
    fill: usize,
    len: u64,
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

impl Sha256 {
    pub fn new() -> Sha256 {
        Sha256 { h: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], block: [0; 64], fill: 0, len: 0 }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.len += data.len() as u64;
        while !data.is_empty() {
            let n = (64 - self.fill).min(data.len());
            self.block[self.fill..self.fill + n].copy_from_slice(&data[..n]);
            self.fill += n;
            data = &data[n..];
            if self.fill == 64 {
                self.compress();
                self.fill = 0;
            }
        }
    }

    fn compress(&mut self) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([self.block[4 * i], self.block[4 * i + 1], self.block[4 * i + 2], self.block[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.h;
        for i in 0..64 {
            let t1 = h.wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25)).wrapping_add((e & f) ^ (!e & g)).wrapping_add(K[i]).wrapping_add(w[i]);
            let t2 = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22)).wrapping_add((a & b) ^ (a & c) ^ (b & c));
            (h, g, f, e, d, c, b, a) = (g, f, e, d.wrapping_add(t1), c, b, a, t1.wrapping_add(t2));
        }
        for (s, v) in self.h.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *s = s.wrapping_add(v);
        }
    }

    pub fn hex(mut self) -> String {
        let bits = self.len * 8;
        self.update(&[0x80]);
        while self.fill != 56 {
            self.update(&[0]);
        }
        let mut tail = bits.to_be_bytes();
        self.block[56..].copy_from_slice(&tail);
        self.compress();
        tail.fill(0);
        self.h.iter().map(|v| format!("{v:08x}")).collect()
    }
}

impl Default for Sha256 {
    fn default() -> Sha256 {
        Sha256::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_the_standard() {
        let h = |s: &[u8]| {
            let mut x = Sha256::new();
            x.update(s);
            x.hex()
        };
        assert_eq!(h(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(h(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(h(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
        let mut x = Sha256::new();
        for _ in 0..1000 {
            x.update(&[b'a'; 1000]);
        }
        assert_eq!(x.hex(), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    }
}
