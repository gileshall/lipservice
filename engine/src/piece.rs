// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! A piece asked for as JSON and sung from loaded models: what the page's node tools, the Python
//! package and the command line ask a choir by, and the one way a singer is opened for it.
//!
//! The ask: {piece | choir, choirs, list, voices_by_part, songs, seed, room, motion, how}.
//!   choir   a choir as web/choirs.js CHOIRS holds one
//!   piece   in its place: a name of `choirs`, a choir, or {choir: a name or a choir, and any of
//!           seed, voices, songs, room, motion, how}, as the editor's and the site's files are
//!   choirs  {name: choir}, the pieces sung by name
//!   list    [{name, sex, label}]: the voices, each one's name in the models (what a choir's parts
//!           say), its sex, and the name people call it by, which a part or the ask may also say
//!   the rest: how it is sung where that is not the piece's own (choir::Ask), over the piece's
//!   file's; voices_by_part and songs by part, null keeping the part's.

use std::ops::Range;

use crate::choir::{self, arrange, Arranged, Ask, Piece};
use crate::front::Phonemizer;
use crate::home::MOTIONS;
use crate::json::{quote, Json};
use crate::part::Library;
use crate::diction::{Rules, Who};
use crate::sing::{self, Motion, Plan, Song, Style};
use crate::stream::{Render, Stream};
use crate::timing;
use crate::voice::Voice;
use crate::weights::{err, Error, Result};

/// What a piece's file may say beside its choir.
const ASK: [&str; 6] = ["seed", "voices", "songs", "room", "motion", "how"];
/// How a choir sings where that is not the piece's own way, in Ask's order.
pub const HOW: [&str; 7] = ["sway", "loose", "vibrato", "glide", "dynamics", "breathiness", "breath"];

/// A voice there is: its name in the models, the name people call it by, its sex.
pub struct Listed {
    pub id: String,
    pub label: Option<String>,
    pub sex: char,
}

fn member<'a>(j: &'a Json, k: &str) -> Option<&'a Json> {
    match j {
        Json::Obj(kv) => kv.iter().find(|(key, _)| key == k).map(|(_, v)| v),
        _ => None,
    }
}

fn given<'a>(j: &'a Json, k: &str) -> Option<&'a Json> {
    member(j, k).filter(|v| !matches!(v, Json::Null))
}

fn listed(j: &Json) -> Result<Vec<Listed>> {
    j.get("list")?
        .arr()?
        .iter()
        .map(|v| {
            let id = v.get("name")?.str()?.to_string();
            let label = given(v, "label").map(|l| l.str().map(str::to_string)).transpose()?;
            match v.get("sex")?.str()? {
                "F" => Ok(Listed { id, label, sex: 'F' }),
                "M" => Ok(Listed { id, label, sex: 'M' }),
                x => err(format!("voice {id}: sex {x}")),
            }
        })
        .collect()
}

/// A voice's name in the models, from that or the name people call it by.
fn id_of(list: &[Listed], name: &str) -> Result<String> {
    let lower = name.to_lowercase();
    match list.iter().find(|l| l.id == name || l.label.as_deref() == Some(lower.as_str())) {
        Some(l) => Ok(l.id.clone()),
        None => err(format!("no voice '{name}': {}", list.iter().map(|l| l.label.as_deref().unwrap_or(&l.id)).collect::<Vec<_>>().join(", "))),
    }
}

/// What an ask, or a piece's file, says of how the piece is sung.
#[derive(Default)]
struct Said {
    seed: Option<i64>,
    voices: Vec<Option<String>>,
    songs: Vec<Option<String>>,
    room: Option<String>,
    motion: Option<Option<String>>,
    how: [Option<f64>; 7],
}

fn by_part(j: &Json, k: &str) -> Result<Vec<Option<String>>> {
    match given(j, k) {
        None => Ok(Vec::new()),
        Some(a) => a.arr().map_err(|e| Error(format!("{k}: {}", e.0)))?.iter().map(|x| if matches!(x, Json::Null) { Ok(None) } else { Ok(Some(x.str()?.to_string())) }).collect(),
    }
}

/// `voices`: the key its voices by part are under. `null_motion`: a motion of null is the machine
/// vibrato (a file's), not nothing said.
fn said(j: &Json, voices: &str, null_motion: bool) -> Result<Said> {
    let seed = match given(j, "seed") {
        None => None,
        Some(s) => {
            let s = s.num().map_err(|e| Error(format!("seed: {}", e.0)))?;
            if !(s.fract() == 0.0 && s.abs() < 9e15) {
                return err(format!("seed {s}: a whole number"));
            }
            Some(s as i64)
        }
    };
    let motion = match member(j, "motion") {
        None => None,
        Some(Json::Null) => null_motion.then_some(None),
        Some(m) => match m.str().map_err(|e| Error(format!("motion: {}", e.0)))? {
            "none" => Some(None),
            x => Some(Some(x.to_string())),
        },
    };
    let mut how = [None; 7];
    match given(j, "how") {
        None => {}
        Some(Json::Obj(kv)) => {
            for (k, v) in kv {
                let at = HOW.iter().position(|h| h == k).ok_or_else(|| Error(format!("how a choir sings: no {k}; there are {}", HOW.join(", "))))?;
                if !matches!(v, Json::Null) {
                    how[at] = Some(v.num().map_err(|e| Error(format!("{k}: {}", e.0)))?);
                }
            }
        }
        Some(_) => return err("how a choir sings: an object".to_string()),
    }
    Ok(Said { seed, voices: by_part(j, voices)?, songs: by_part(j, "songs")?, room: given(j, "room").map(|r| r.str().map(str::to_string)).transpose()?, motion, how })
}

fn over(a: Vec<Option<String>>, b: Vec<Option<String>>) -> Vec<Option<String>> {
    let n = a.len().max(b.len());
    let (mut a, mut b) = (a.into_iter(), b.into_iter());
    (0..n).map(|_| a.next().flatten().or(b.next().flatten())).collect()
}

/// A piece ready to sing: what it is called, and its singers arranged.
pub struct Wanted {
    pub title: String,
    pub arranged: Arranged,
}

impl Wanted {
    /// The voices it sings with, by their names in the models, each once.
    pub fn voices(&self) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        for s in &self.arranged.singers {
            if !out.contains(&s.voice.as_str()) {
                out.push(&s.voice);
            }
        }
        out
    }

    /// The pitch motions it sings with, each once.
    pub fn motions(&self) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        for m in self.arranged.singers.iter().filter_map(|s| s.motion.as_deref()) {
            if !out.contains(&m) {
                out.push(m);
            }
        }
        out
    }
}

/// The names of the pieces an ask's `choirs` holds, in its order.
pub fn names(choirs: &Json) -> Result<Vec<&str>> {
    match choirs {
        Json::Obj(kv) => Ok(kv.iter().map(|(k, _)| k.as_str()).collect()),
        _ => err("the choirs: an object of pieces by name".to_string()),
    }
}

fn named<'a>(j: &'a Json, name: &str) -> Result<&'a Json> {
    let choirs = given(j, "choirs").ok_or_else(|| Error(format!("no choir '{name}': no choirs were given to sing by name")))?;
    match member(choirs, name) {
        Some(c) => Ok(c),
        None => err(format!("no choir '{name}': {}", names(choirs)?.join(", "))),
    }
}

/// The ask's piece arranged for a route ("hifi" or "fast"), every voice by its name in the models.
pub fn wanted(j: &Json, route: &str) -> Result<Wanted> {
    let list = listed(j)?;
    let outer = said(j, "voices_by_part", false)?;
    let (c, inner, title) = match given(j, "piece") {
        None => (j.get("choir").map_err(|e| Error(format!("the ask: {}", e.0)))?, Said::default(), "a choir"),
        Some(Json::Str(name)) => (named(j, name)?, Said::default(), name.as_str()),
        Some(p @ Json::Obj(kv)) => match member(p, "choir") {
            Some(c) => {
                let more: Vec<&str> = kv.iter().map(|(k, _)| k.as_str()).filter(|k| *k != "choir" && !ASK.contains(k)).collect();
                if !more.is_empty() {
                    return err(format!("a piece says {}: it may say {}", more.join(", "), ASK.join(", ")));
                }
                let inner = said(p, "voices", true)?;
                match c {
                    Json::Str(name) => (named(j, name)?, inner, name.as_str()),
                    Json::Obj(_) => (c, inner, "a choir"),
                    _ => return err("a piece's choir is a choir or the name of one".to_string()),
                }
            }
            None => (p, Said::default(), "a choir"),
        },
        Some(_) => return err("a piece is the name of a choir, a choir or {\"choir\": ...}".to_string()),
    };
    let parts = match member(c, "parts") {
        Some(Json::Arr(p)) if !p.is_empty() => p,
        _ => return err("a choir has parts".to_string()),
    };
    let h = |i: usize| outer.how[i].or(inner.how[i]);
    let mut ask = Ask {
        seed: outer.seed.or(inner.seed).unwrap_or(0),
        voices: over(outer.voices, inner.voices),
        songs: over(outer.songs, inner.songs),
        room: outer.room.or(inner.room),
        motion: outer.motion.or(inner.motion),
        sway: h(0),
        loose: h(1),
        vibrato: h(2),
        glide: h(3),
        dynamics: h(4),
        breathiness: h(5),
        breath: h(6),
    };
    for (k, n) in [("voices", ask.voices.len()), ("songs", ask.songs.len())] {
        if n > parts.len() {
            return err(format!("{n} {k} for {} parts", parts.len()));
        }
    }
    ask.voices.resize(parts.len(), None);
    for (p, v) in parts.iter().zip(&mut ask.voices) {
        let name = match (&v, given(p, "voice")) {
            (Some(v), _) => Some(v.clone()),
            (None, Some(Json::Str(v))) => Some(v.clone()),
            (None, _) => None,
        };
        *v = name.map(|n| id_of(&list, &n)).transpose()?;
    }
    let pairs: Vec<(String, char)> = list.iter().map(|l| (l.id.clone(), l.sex)).collect();
    let mut arranged = arrange(c, &pairs, route, &ask)?;
    for s in &mut arranged.singers {
        s.called = list.iter().find(|l| l.id == s.voice).and_then(|l| l.label.clone());
    }
    for m in arranged.singers.iter().filter_map(|s| s.motion.as_deref()) {
        if !MOTIONS.contains(&m) {
            return err(format!("motion '{m}': {} or none", MOTIONS.join(", ")));
        }
    }
    Ok(Wanted { title: title.to_string(), arranged })
}

/// A singer's voice as loaded: its score model and sharpening, and what it sounds through.
#[derive(Clone, Copy)]
pub struct Cast<'a> {
    pub voice: &'a Voice,
    pub render: Render<'a>,
}

/// The piece sung (choir::sing) by loaded voices: `cast` and `motions` by singer, in the
/// arrangement's order.
pub fn sing(a: &Arranged, breaths: Option<&(Library, Vec<i16>)>, ph: &mut Phonemizer, cast: &[Cast], motions: &[Option<Motion>]) -> Result<Piece> {
    if cast.len() != a.singers.len() || motions.len() != a.singers.len() {
        return err(format!("{} singers, {} voices and {} motions", a.singers.len(), cast.len(), motions.len()));
    }
    let open = |i: usize, text: &str, shift: f64| -> Result<(Plan, Vec<Range<usize>>)> {
        let p = &a.singers[i];
        let style = Style {
            shift: shift as f32,
            vibrato: p.vibrato as f32,
            vibrato_hz: p.vibrato_hz as f32,
            vibrato_delay: p.vibrato_delay as f32,
            vibrato_ramp: 0.2,
            glide: p.glide as usize,
            dynamics: p.dynamics as f32,
            consonants: 1.0,
            breathiness: p.breathiness as f32,
            who: Who { track: Some(p.name.clone()), voice: Some(p.called.clone().unwrap_or_else(|| p.voice.clone())), tags: p.tags.clone() },
            motion: motions[i].clone(),
            motion_scale: p.motion_scale as f32,
            seed: p.seed as u32 as u64,
        };
        let mut rules = Rules::default();
        for l in &p.diction {
            rules.read(&l.split_whitespace().collect::<Vec<_>>()).map_err(|e| Error(format!("{}: diction: {l}: {}", p.name, e.0)))?;
        }
        let plan = sing::plan(&cast[i].voice.score, ph, &Song::parse_under(text, rules)?, 0, &style)?;
        let rests = plan.rests();
        Ok((plan, rests))
    };
    let whole = |i: usize, plan: Plan, text: &str| -> Result<(Vec<f32>, timing::Timing)> {
        let c = &cast[i];
        let sharpen = match c.render {
            Render::Voc(_) => c.voice.sharpen.as_ref(),
            _ => None,
        };
        let mut st = Stream::sung_from(&c.voice.score, c.render, &plan, 0, None, a.singers[i].seed as u32 as u64, sharpen, 0)?;
        let mut y = Vec::new();
        while !st.done() {
            st.step(usize::MAX, &mut y);
        }
        let (lf0, vuv) = st.pitch();
        let t = timing::sung(&plan.tokens, &plan.durations, &timing::words_of(text)?, &plan.notes, lf0, vuv)?;
        Ok((y, t))
    };
    choir::sing(a, breaths, open, whole)
}

/// The piece's timing (timing::clip_json): `label` gives the name people call a voice by.
pub fn timing_json(piece: &Piece, label: impl Fn(&str) -> String) -> String {
    let parts: Vec<String> = piece
        .parts
        .iter()
        .map(|p| {
            let breaths: Vec<(i64, i64)> = p.breaths.iter().map(|&(at, n)| (p.start + at, p.start + at + n as i64)).collect();
            let level: Vec<String> = p.level.iter().map(|&v| if v.is_finite() { format!("{v}") } else { "null".to_string() }).collect();
            let more = format!(",\"text\":{},\"lag\":{},\"shift\":{}", quote(&p.text), p.lag, p.shift);
            timing::part_json(&p.name, &label(&p.voice), p.start, p.len, p.pan, &p.timing, &breaths, &level.join(","), &more)
        })
        .collect();
    timing::clip_json(piece.left.len(), Some(format!("{}", piece.bpm)), Some(piece.beat_zero), &parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = r#"[{"name":"6345","sex":"F","label":"cora"},{"name":"2428","sex":"M","label":"ben"},{"name":"777","sex":"F","label":"eve"}]"#;
    const DUET: &str = r#"{"room":"drier","style":{"glide":9,"dynamics":1,"breathiness":0.5,"motion":"vibrato","breath":0.5},
        "parts":[{"name":"High","voice":"cora","song":"%bpm 96\nla G4:2\n"},{"name":"Low","voice":"2428","song":"%bpm 96\nla D4:2\n"}]}"#;

    fn ask(rest: &str) -> Json {
        Json::parse(&format!("{{\"list\":{LIST},\"choirs\":{{\"Duet\":{DUET},\"Other\":{DUET}}}{rest}}}")).unwrap()
    }

    fn got(rest: &str) -> Wanted {
        wanted(&ask(rest), "fast").unwrap()
    }

    fn refused(rest: &str) -> String {
        match wanted(&ask(rest), "fast") {
            Ok(_) => panic!("not refused: {rest}"),
            Err(e) => e.0,
        }
    }

    #[test]
    fn a_pieces_diction_is_rules_and_its_singers_have_names() {
        let piece = |style: &str, low: &str| {
            format!(
                r#","piece":{{"room":"drier","style":{{"glide":9,"dynamics":1,"breathiness":0.5{style}}},
                "parts":[{{"name":"High","voice":"cora","song":"%bpm 96\nla G4:2\n"}},{{"name":"Low","voice":"2428","song":"%bpm 96\nla D4:2\n"{low}}}]}}"#
            )
        };
        // the style's lines for every singer, a part's own after them; tags and the name a voice is called by
        let w = got(&piece(r#","diction":["spoken","for=bass word=la -> L AO"]"#, r#","tags":["bass"],"diction":["word=la -> L AA"]"#));
        let s = &w.arranged.singers;
        assert_eq!(s[0].diction, ["spoken", "for=bass word=la -> L AO"]);
        assert_eq!(s[1].diction, ["spoken", "for=bass word=la -> L AO", "word=la -> L AA"]);
        assert_eq!((s[0].tags.len(), s[1].tags.clone()), (0, vec!["bass".to_string()]));
        assert_eq!((s[0].called.as_deref(), s[1].called.as_deref()), (Some("cora"), Some("ben")));
        // none said: no lines, every song's rules
        assert!(got(&piece("", "")).arranged.singers.iter().all(|s| s.diction.is_empty() && s.tags.is_empty()));
        // lines, not a switch; a line that is no rule, by the part
        assert_eq!(refused(&piece(r#","diction":true"#, "")), "the style's diction: a list of strings");
        assert_eq!(refused(&piece("", r#","diction":false"#)), "Low: diction: a list of strings");
        assert!(refused(&piece("", r#","diction":["AY -> T"]"#)).starts_with("Low: diction: AY -> T: a vowel is sung as one vowel"));
        assert!(refused(&piece("", r#","tags":"bass""#)).contains("Low: tags: a list of strings"));
    }

    #[test]
    fn a_piece_by_name_by_choir_and_by_file() {
        let w = got(r#","piece":"Duet""#);
        assert_eq!(w.title, "Duet");
        // a part's voice by the name people call it or its name in the models; a man an octave down
        assert_eq!(w.voices(), ["6345", "2428"]);
        assert_eq!(w.arranged.singers.iter().map(|s| s.shift).collect::<Vec<_>>(), [0.0, -12.0]);
        assert_eq!(w.motions(), ["vibrato"]);
        assert_eq!((w.arranged.room.as_str(), w.arranged.bpm), ("drier", 96.0));
        let c = got(&format!(",\"piece\":{DUET}"));
        assert_eq!((c.title.as_str(), c.voices()), ("a choir", vec!["6345", "2428"]));
        // the form before `piece`: the choir alone
        assert_eq!(got(&format!(",\"choir\":{DUET}")).voices(), ["6345", "2428"]);
        let f = got(r#","piece":{"choir":"Duet","seed":5,"room":"card","voices":[null,"eve"],"how":{"glide":14,"breath":0}}"#);
        assert_eq!((f.title.as_str(), f.arranged.room.as_str()), ("Duet", "card"));
        assert_eq!(f.voices(), ["6345", "777"]);
        assert_eq!(f.arranged.singers.iter().map(|s| (s.seed, s.glide, s.breath)).collect::<Vec<_>>(), [(5, 14.0, 0.0), (6, 14.0, 0.0)]);
    }

    #[test]
    fn what_is_asked_goes_over_what_the_file_says() {
        let file = r#""piece":{"choir":"Duet","seed":5,"room":"card","voices":["eve","eve"],"songs":[null,"%bpm 96\nlo C4:2\n"],"motion":"wide","how":{"glide":14,"dynamics":2}}"#;
        let w = got(&format!(r#",{file},"seed":9,"room":"bare","voices_by_part":[null,"CORA"],"motion":"straight","how":{{"glide":20}}"#));
        assert_eq!(w.arranged.room, "bare");
        // by part: the ask's where it names one, the file's where it does not
        assert_eq!(w.arranged.singers.iter().map(|s| s.voice.as_str()).collect::<Vec<_>>(), ["777", "6345"]);
        assert_eq!(w.voices(), ["777", "6345"]);
        assert_eq!(w.arranged.singers.iter().map(|s| (s.seed, s.glide, s.dynamics)).collect::<Vec<_>>(), [(9, 20.0, 2.0), (10, 20.0, 2.0)]);
        assert!(w.arranged.singers[1].song.contains("lo C4:2") && w.arranged.singers[0].song.contains("la G4:2"));
        assert_eq!(w.motions(), ["straight"]);
    }

    #[test]
    fn no_motion_is_the_machine_vibrato() {
        // a file's null, and "none" asked for; a null in the ask is nothing said
        assert!(got(r#","piece":{"choir":"Duet","motion":null}"#).motions().is_empty());
        assert!(got(r#","piece":"Duet","motion":"none""#).motions().is_empty());
        assert_eq!(got(r#","piece":"Duet","motion":null"#).motions(), ["vibrato"]);
        assert_eq!(got(r#","piece":{"choir":"Duet","motion":null},"motion":"wide""#).motions(), ["wide"]);
    }

    #[test]
    fn what_cannot_be_sung_is_refused_in_words() {
        assert_eq!(refused(r#","piece":"Nope""#), "no choir 'Nope': Duet, Other");
        assert_eq!(refused(r#","piece":{"choir":"Duet","tempo":2}"#), "a piece says tempo: it may say seed, voices, songs, room, motion, how");
        assert_eq!(refused(r#","piece":{"choir":7}"#), "a piece's choir is a choir or the name of one");
        assert_eq!(refused(r#","piece":7"#), "a piece is the name of a choir, a choir or {\"choir\": ...}");
        assert_eq!(refused(r#","piece":{"room":"card"}"#), "a choir has parts");
        assert_eq!(refused(r#","piece":{"room":"card","parts":[]}"#), "a choir has parts");
        assert_eq!(refused(r#","piece":"Duet","voices_by_part":["zed"]"#), "no voice 'zed': cora, ben, eve");
        assert_eq!(refused(r#","piece":"Duet","voices_by_part":["cora","ben","eve"]"#), "3 voices for 2 parts");
        assert_eq!(refused(r#","piece":"Duet","songs":["a","b","c"]"#), "3 songs for 2 parts");
        assert_eq!(refused(r#","piece":"Duet","motion":"wobble""#), "motion 'wobble': straight, vibrato, wide or none");
        assert_eq!(refused(r#","piece":"Duet","how":{"wobble":1}"#), "how a choir sings: no wobble; there are sway, loose, vibrato, glide, dynamics, breathiness, breath");
        assert_eq!(refused(r#","piece":"Duet","seed":1.5"#), "seed 1.5: a whole number");
        assert!(refused(r#","piece":"Duet","room":"cathedral""#).starts_with("no room cathedral"));
        let none = Json::parse(&format!("{{\"list\":{LIST},\"piece\":\"Duet\"}}")).unwrap();
        assert_eq!(wanted(&none, "fast").err().unwrap().0, "no choir 'Duet': no choirs were given to sing by name");
        assert_eq!(names(ask("").get("choirs").unwrap()).unwrap(), ["Duet", "Other"]);
    }
}
