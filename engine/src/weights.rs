// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! LSW files: named f32 or int8 tensors.

use std::collections::HashMap;
use std::fmt;

#[derive(Debug)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

pub fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(Error(msg.into()))
}

#[derive(Clone)]
pub struct Tensor {
    pub shape: Vec<usize>,
    pub data: Vec<f32>, // f32 tensors
    pub q: Vec<i8>,     // int8 tensors
}

pub struct Weights {
    tensors: HashMap<String, Tensor>,
    /// FNV-1a over the file's bytes: which file a lexicon was pruned against.
    pub digest: u64,
}

pub fn fnv64(b: &[u8]) -> u64 {
    b.iter().fold(0xcbf29ce484222325, |h, &c| (h ^ c as u64).wrapping_mul(0x100000001b3))
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.p + n > self.b.len() {
            return err(format!("LSW truncated at byte {}", self.p));
        }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
}

impl Weights {
    pub fn read(path: &str) -> Result<Weights> {
        let b = std::fs::read(path).map_err(|e| Error(format!("{path}: {e}")))?;
        Weights::parse(&b).map_err(|e| Error(format!("{path}: {e}")))
    }

    pub fn parse(b: &[u8]) -> Result<Weights> {
        crate::nn::accel()?;
        let mut r = Reader { b, p: 0 };
        if r.take(4)? != b"LSW1" {
            return err("not an LSW1 file");
        }
        let count = r.u32()? as usize;
        let mut index = Vec::with_capacity(count);
        for _ in 0..count {
            let nl = r.u16()? as usize;
            let name = String::from_utf8(r.take(nl)?.to_vec()).map_err(|_| Error("tensor name is not utf-8".into()))?;
            let dtype = r.u8()?;
            if dtype > 1 {
                return err(format!("{name}: dtype {dtype} unsupported"));
            }
            let nd = r.u8()? as usize;
            let mut shape = Vec::with_capacity(nd);
            for _ in 0..nd {
                shape.push(r.u32()? as usize);
            }
            let off = r.u64()? as usize;
            index.push((name, dtype, shape, off));
        }
        let start = (r.p + 63) / 64 * 64;
        let mut tensors = HashMap::new();
        for (name, dtype, shape, off) in index {
            let n: usize = shape.iter().product();
            let a = start + off;
            let size = if dtype == 0 { 4 } else { 1 };
            if a + size * n > b.len() {
                return err(format!("{name}: data past the end of the file"));
            }
            let t = if dtype == 0 {
                let data = b[a..a + 4 * n].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
                Tensor { shape, data, q: Vec::new() }
            } else {
                Tensor { shape, data: Vec::new(), q: b[a..a + n].iter().map(|&v| v as i8).collect() }
            };
            tensors.insert(name, t);
        }
        Ok(Weights { tensors, digest: fnv64(b) })
    }

    pub fn get(&self, name: &str) -> Result<&Tensor> {
        self.tensors.get(name).ok_or_else(|| Error(format!("missing tensor {name}")))
    }

    fn checked(&self, name: &str, shape: &[usize], int8: bool) -> Result<&Tensor> {
        let t = self.get(name)?;
        if t.shape != shape {
            return err(format!("{name}: shape {:?}, expected {:?}", t.shape, shape));
        }
        let n: usize = shape.iter().product();
        if int8 != (t.q.len() == n && t.data.is_empty()) {
            return err(format!("{name}: expected {}", if int8 { "int8" } else { "f32" }));
        }
        Ok(t)
    }

    /// An f32 tensor, checked against an expected shape.
    pub fn shaped(&self, name: &str, shape: &[usize]) -> Result<&[f32]> {
        Ok(&self.checked(name, shape, false)?.data)
    }

    /// An int8 tensor, checked against an expected shape.
    pub fn shaped_i8(&self, name: &str, shape: &[usize]) -> Result<&[i8]> {
        Ok(&self.checked(name, shape, true)?.q)
    }

    pub fn has(&self, name: &str) -> bool {
        self.tensors.contains_key(name)
    }

    pub fn names(&self) -> impl Iterator<Item = &String> {
        self.tensors.keys()
    }

    /// The tensors named `prefix`NAME, moved out under NAME (the digest kept).
    pub fn split(&mut self, prefix: &str) -> Weights {
        let names: Vec<String> = self.tensors.keys().filter(|n| n.starts_with(prefix)).cloned().collect();
        let tensors = names.into_iter().map(|n| (n[prefix.len()..].to_string(), self.tensors.remove(&n).unwrap())).collect();
        Weights { tensors, digest: self.digest }
    }

    /// The tensors named `prefix`NAME, copied under NAME (the digest kept).
    pub fn under(&self, prefix: &str) -> Weights {
        let tensors = self.tensors.iter().filter(|(n, _)| n.starts_with(prefix)).map(|(n, t)| (n[prefix.len()..].to_string(), t.clone())).collect();
        Weights { tensors, digest: self.digest }
    }

    pub fn is_empty(&self) -> bool {
        self.tensors.is_empty()
    }

    /// Whether the file holds only what differs from a base, its base's
    /// digest under `base.digest`.
    pub fn needs_base(&self) -> bool {
        self.has("base.digest")
    }

    /// A file written against a base, whole: its tensors, then the base's
    /// it left out.
    pub fn on_base(self, base: &Weights) -> Result<Weights> {
        self.on_base_where(base, |_| true)
    }

    /// on_base() with, of the base's tensors the file left out, those `takes` says to.
    pub fn on_base_where(mut self, base: &Weights, takes: impl Fn(&str) -> bool) -> Result<Weights> {
        let want = self.named("base.digest")?.ok_or_else(|| Error("no base.digest: not written against a base".into()))?;
        if want != base.digest {
            return err(format!("written against base {want:016x}, not this one ({:016x})", base.digest));
        }
        for (n, t) in &base.tensors {
            if !self.tensors.contains_key(n) && takes(n) {
                self.tensors.insert(n.clone(), t.clone());
            }
        }
        Ok(self)
    }

    /// The file a tensor of 8 int8 names by its digest, the tensor taken out; none without it.
    fn named(&mut self, name: &str) -> Result<Option<u64>> {
        let Some(d) = self.tensors.remove(name) else { return Ok(None) };
        if d.shape != [8] || d.q.len() != 8 {
            return err(format!("{name}: shape {:?}, expected 8 int8", d.shape));
        }
        Ok(Some(u64::from_le_bytes(std::array::from_fn(|i| d.q[i] as u8))))
    }

    /// Whether the file is a part of a voice kept in a file of its own (tools/split.py), its
    /// voice's file's digest under `voice.digest`.
    pub fn is_part(&self) -> bool {
        self.has("voice.digest")
    }

    /// Refuses a voice that lacks one of `needed` (vox, mel) which `voice.apart` (names with commas
    /// between) says is kept in a file of its own, so nothing else stands in for it.
    pub fn has_parts(&self, needed: &[&str]) -> Result<()> {
        let Some(t) = self.tensors.get("voice.apart") else { return Ok(()) };
        let apart = String::from_utf8(t.q.iter().map(|&b| b as u8).collect()).map_err(|_| Error("voice.apart is not utf-8".into()))?;
        for part in apart.split(',') {
            if needed.contains(&part) && !self.tensors.keys().any(|n| n.starts_with(part) && n[part.len()..].starts_with('.')) {
                return err(format!("the voice's {part} part is a file of its own, and it was not given"));
            }
        }
        Ok(())
    }

    /// A voice file with a part of it joined (its parts of the latent voice, or its mel decoder):
    /// the part's tensors beside its own. A mel decoder's part names the mel route's file under
    /// `melvoc.digest` and takes from `route`, that file's tensors under mel., those it leaves out.
    pub fn join(&mut self, mut part: Weights, route: Option<&Weights>) -> Result<()> {
        let of = part.named("voice.digest")?.ok_or_else(|| Error("no voice.digest: not a part of a voice".into()))?;
        if of != self.digest {
            return err(format!("a part of voice {of:016x}, not this one ({:016x})", self.digest));
        }
        if let Some(want) = part.named("melvoc.digest")? {
            let Some(r) = route else { return err("a voice's mel decoder needs the mel route's file, and none is loaded") };
            if want != r.digest {
                return err(format!("fitted to mel route {want:016x}, not this one ({:016x})", r.digest));
            }
            for (n, t) in &r.tensors {
                part.tensors.entry(format!("mel.{n}")).or_insert_with(|| t.clone());
            }
        }
        for (n, t) in part.tensors {
            if self.tensors.contains_key(&n) {
                return err(format!("{n}: in the voice and in its part"));
            }
            self.tensors.insert(n, t);
        }
        Ok(())
    }
}
