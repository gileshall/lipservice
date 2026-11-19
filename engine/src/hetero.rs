// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Heteronyms: words whose sound turns on their sense ("we live here", "a live wire"), chosen
//! from the words around them in their clause. Other words keep the lexicon's first
//! pronunciation. The rules follow which sound LibriTTS-R's readers used, and
//! modern usage where the books have little of it ("going live", "content creators").

use crate::front::STOPS;

/// A heteronym: its two senses as (name, phones), and when it takes the second.
pub struct Het {
    pub word: &'static str,
    pub a: (&'static str, &'static str),
    pub b: (&'static str, &'static str),
    b_if: fn(&At) -> bool,
}

const fn h(word: &'static str, a: (&'static str, &'static str), b: (&'static str, &'static str), b_if: fn(&At) -> bool) -> Het {
    Het { word, a, b, b_if }
}

pub static HETS: &[Het] = &[
    h("live", ("verb", "L IH1 V"), ("adj", "L AY1 V"), live_adj),
    h("lives", ("noun", "L AY1 V Z"), ("verb", "L IH1 V Z"), lives_verb),
    h("read", ("past", "R EH1 D"), ("pres", "R IY1 D"), read_pres),
    h("close", ("adj", "K L OW1 S"), ("verb", "K L OW1 Z"), close_z),
    h("use", ("noun", "Y UW1 S"), ("verb", "Y UW1 Z"), use_verb),
    h("uses", ("noun", "Y UW1 S IH0 Z"), ("verb", "Y UW1 Z IH0 Z"), verb_s),
    h("used", ("verb", "Y UW1 Z D"), ("to", "Y UW1 S T"), used_to),
    h("excuse", ("noun", "IH0 K S K Y UW1 S"), ("verb", "IH0 K S K Y UW1 Z"), verb_base),
    h("excuses", ("noun", "IH0 K S K Y UW1 S IH0 Z"), ("verb", "IH0 K S K Y UW1 Z IH0 Z"), verb_s),
    h("abuse", ("noun", "AH0 B Y UW1 S"), ("verb", "AH0 B Y UW1 Z"), verb_base),
    h("abuses", ("noun", "AH0 B Y UW1 S IH0 Z"), ("verb", "AH0 B Y UW1 Z IH0 Z"), verb_s),
    h("house", ("noun", "HH AW1 S"), ("verb", "HH AW1 Z"), house_verb),
    h("houses", ("s", "HH AW1 S IH0 Z"), ("z", "HH AW1 Z IH0 Z"), always),
    h("mouth", ("noun", "M AW1 TH"), ("verb", "M AW1 DH"), house_verb),
    h("wind", ("noun", "W IH1 N D"), ("verb", "W AY1 N D"), wind_verb),
    h("winds", ("noun", "W IH1 N D Z"), ("verb", "W AY1 N D Z"), winds_verb),
    h("wound", ("injury", "W UW1 N D"), ("wound-up", "W AW1 N D"), wound_up),
    h("tear", ("rip", "T EH1 R"), ("cry", "T IH1 R"), tear_cry),
    h("tears", ("cry", "T IH1 R Z"), ("rip", "T EH1 R Z"), tears_rip),
    h("lead", ("verb", "L IY1 D"), ("metal", "L EH1 D"), lead_metal),
    h("bow", ("bend", "B AW1"), ("ribbon", "B OW1"), bow_ribbon),
    h("bows", ("bend", "B AW1 Z"), ("ribbon", "B OW1 Z"), bow_ribbon),
    h("bowing", ("bend", "B AW1 IH0 NG"), ("ribbon", "B OW1 IH0 NG"), never),
    h("dove", ("bird", "D AH1 V"), ("dived", "D OW1 V"), dove_dived),
    h("sow", ("plant", "S OW1"), ("pig", "S AW1"), sow_pig),
    h("row", ("line", "R OW1"), ("quarrel", "R AW1"), row_quarrel),
    h("bass", ("music", "B EY1 S"), ("fish", "B AE1 S"), bass_fish),
    h("does", ("verb", "D AH1 Z"), ("deer", "D OW1 Z"), does_deer),
    h("perfect", ("adj", "P ER1 F IH2 K T"), ("verb", "P ER0 F EH1 K T"), bare),
    // The voices learned F AO1 R from "for", mostly said weak; before a word they say "four" so too.
    h("four", ("end", "F AO1 R"), ("before", "F OW1 R"), before_word),
    h("fore", ("end", "F AO1 R"), ("before", "F OW1 R"), before_word),
    h("putting", ("put", "P UH1 T IH0 NG"), ("golf", "P AH1 T IH0 NG"), never),
    h("minute", ("time", "M IH1 N AH0 T"), ("tiny", "M AY0 N UW1 T"), minute_tiny),
    h("present", ("noun", "P R EH1 Z AH0 N T"), ("verb", "P R IY0 Z EH1 N T"), present_verb),
    h("presents", ("noun", "P R EH1 Z AH0 N T S"), ("verb", "P R IY0 Z EH1 N T S"), presents_verb),
    h("subject", ("noun", "S AH1 B JH IH0 K T"), ("verb", "S AH0 B JH EH1 K T"), subject_verb),
    h("subjects", ("noun", "S AH1 B JH IH0 K T S"), ("verb", "S AH0 B JH EH1 K T S"), subjects_verb),
    h("object", ("noun", "AA1 B JH EH0 K T"), ("verb", "AH0 B JH EH1 K T"), object_verb),
    h("objects", ("noun", "AA1 B JH EH0 K T S"), ("verb", "AH0 B JH EH1 K T S"), objects_verb),
    h("content", ("adj", "K AH0 N T EH1 N T"), ("noun", "K AA1 N T EH0 N T"), content_noun),
    h("progress", ("noun", "P R AA1 G R EH2 S"), ("verb", "P R AH0 G R EH1 S"), progress_verb),
    h("address", ("noun", "AE1 D R EH2 S"), ("verb", "AH0 D R EH1 S"), address_verb),
    h("refuse", ("verb", "R IH0 F Y UW1 Z"), ("noun", "R EH1 F Y UW2 S"), refuse_noun),
    h("desert", ("noun", "D EH1 Z ER0 T"), ("verb", "D IH0 Z ER1 T"), verb_base),
    h("deserts", ("noun", "D EH1 Z ER0 T S"), ("verb", "D IH0 Z ER1 T S"), verb_s),
    h("produce", ("verb", "P R AH0 D UW1 S"), ("noun", "P R OW1 D UW0 S"), produce_noun),
    h("record", ("noun", "R EH1 K ER0 D"), ("verb", "R IH0 K AO1 R D"), record_verb),
    h("records", ("noun", "R EH1 K ER0 D Z"), ("verb", "R IH0 K AO1 R D Z"), records_verb),
    h("contrast", ("noun", "K AA1 N T R AE0 S T"), ("verb", "K AH0 N T R AE1 S T"), verb_base),
    h("conflict", ("noun", "K AA1 N F L IH0 K T"), ("verb", "K AH0 N F L IH1 K T"), verb_base),
    h("rebel", ("noun", "R EH1 B AH0 L"), ("verb", "R IH0 B EH1 L"), verb_base),
    h("rebels", ("noun", "R EH1 B AH0 L Z"), ("verb", "R IH0 B EH1 L Z"), verb_s),
    h("contest", ("noun", "K AA1 N T EH0 S T"), ("verb", "K AH0 N T EH1 S T"), verb_base),
    h("contract", ("noun", "K AA1 N T R AE2 K T"), ("verb", "K AH0 N T R AE1 K T"), verb_base),
    h("compound", ("noun", "K AA1 M P AW0 N D"), ("verb", "K AH0 M P AW1 N D"), verb_base),
    h("invalid", ("noun", "IH1 N V AH0 L IH0 D"), ("adj", "IH2 N V AE1 L AH0 D"), invalid_adj),
    h("attribute", ("noun", "AE1 T R AH0 B Y UW2 T"), ("verb", "AH0 T R IH1 B Y UW2 T"), verb_base),
    h("attributes", ("noun", "AE1 T R AH0 B Y UW2 T S"), ("verb", "AH0 T R IH1 B Y UW2 T S"), verb_s),
    h("protest", ("noun", "P R OW1 T EH2 S T"), ("verb", "P R AH0 T EH1 S T"), verb_base),
    h("protests", ("noun", "P R OW1 T EH2 S T S"), ("verb", "P R AH0 T EH1 S T S"), verb_s),
    h("converse", ("noun", "K AA1 N V ER0 S"), ("verb", "K AH0 N V ER1 S"), verb_base),
    h("project", ("noun", "P R AA1 JH EH0 K T"), ("verb", "P R AH0 JH EH1 K T"), verb_base),
    h("projects", ("noun", "P R AA1 JH EH0 K T S"), ("verb", "P R AH0 JH EH1 K T S"), verb_s),
    h("convict", ("noun", "K AA1 N V IH0 K T"), ("verb", "K AH0 N V IH1 K T"), verb_base),
    h("convicts", ("noun", "K AA1 N V IH0 K T S"), ("verb", "K AH0 N V IH1 K T S"), verb_s),
    h("extract", ("noun", "EH1 K S T R AE2 K T"), ("verb", "IH0 K S T R AE1 K T"), extract_verb),
    h("defects", ("noun", "D IY1 F EH0 K T S"), ("verb", "D IH0 F EH1 K T S"), verb_s),
    h("convert", ("noun", "K AA1 N V ER0 T"), ("verb", "K AH0 N V ER1 T"), convert_verb),
    h("console", ("noun", "K AA1 N S OW0 L"), ("verb", "K AH0 N S OW1 L"), verb_base),
    h("compact", ("noun", "K AA1 M P AE0 K T"), ("verb", "K AH0 M P AE1 K T"), verb_base),
    h("accent", ("noun", "AE1 K S EH2 N T"), ("verb", "AH0 K S EH1 N T"), bare),
    h("recess", ("noun", "R IY1 S EH0 S"), ("verb", "R IH0 S EH1 S"), bare),
    h("ally", ("noun", "AE1 L AY0"), ("verb", "AH0 L AY1"), bare),
    h("allies", ("noun", "AE1 L AY0 Z"), ("verb", "AH0 L AY1 Z"), verb_s),
    h("increase", ("verb", "IH2 N K R IY1 S"), ("noun", "IH1 N K R IY2 S"), change_noun),
    h("increases", ("verb", "IH0 N K R IY1 S AH0 Z"), ("noun", "IH1 N K R IY2 S IH0 Z"), nominal_or_prep),
    h("decrease", ("verb", "D IH0 K R IY1 S"), ("noun", "D IY1 K R IY2 S"), change_noun),
    h("learned", ("verb", "L ER1 N D"), ("adj", "L ER1 N IH0 D"), learned_adj),
    h("blessed", ("verb", "B L EH1 S T"), ("adj", "B L EH1 S IH0 D"), blessed_adj),
    h("cursed", ("verb", "K ER1 S T"), ("adj", "K ER1 S IH0 D"), blessed_adj),
    h("beloved", ("adj", "B IH0 L AH1 V AH0 D"), ("verb", "B IH0 L AH1 V D"), beloved_verb),
    h("aged", ("verb", "EY1 JH D"), ("adj", "EY1 JH IH0 D"), aged_adj),
    h("dogged", ("verb", "D AO1 G D"), ("adj", "D AO1 G IH0 D"), dogged_adj),
    h("separate", ("adj", "S EH1 P R AH0 T"), ("verb", "S EH1 P ER0 EY2 T"), ate_verb),
    h("estimate", ("noun", "EH1 S T AH0 M AH0 T"), ("verb", "EH1 S T AH0 M EY2 T"), ate_verb),
    h("moderate", ("adj", "M AA1 D ER0 AH0 T"), ("verb", "M AA1 D ER0 EY2 T"), ate_verb),
    h("graduate", ("noun", "G R AE1 JH AH0 W AH0 T"), ("verb", "G R AE1 JH AH0 W EY2 T"), ate_verb),
    h("intimate", ("adj", "IH1 N T AH0 M AH0 T"), ("verb", "IH1 N T AH0 M EY2 T"), ate_verb),
    h("deliberate", ("adj", "D IH0 L IH1 B ER0 AH0 T"), ("verb", "D IH0 L IH1 B ER0 EY2 T"), ate_verb),
    h("appropriate", ("adj", "AH0 P R OW1 P R IY0 AH0 T"), ("verb", "AH0 P R OW1 P R IY0 EY2 T"), ate_verb),
    h("approximate", ("adj", "AH0 P R AA1 K S AH0 M AH0 T"), ("verb", "AH0 P R AA1 K S AH0 M EY2 T"), ate_verb),
    h("associate", ("noun", "AH0 S OW1 S IY0 AH0 T"), ("verb", "AH0 S OW1 S IY0 EY2 T"), ate_verb),
    h("advocate", ("noun", "AE1 D V AH0 K AH0 T"), ("verb", "AE1 D V AH0 K EY2 T"), ate_verb),
    h("alternate", ("adj", "AO1 L T ER0 N AH0 T"), ("verb", "AO1 L T ER0 N EY2 T"), ate_verb),
    h("delegate", ("noun", "D EH1 L AH0 G AH0 T"), ("verb", "D EH1 L AH0 G EY2 T"), ate_verb),
    h("duplicate", ("noun", "D UW1 P L AH0 K AH0 T"), ("verb", "D UW1 P L AH0 K EY2 T"), ate_verb),
    h("elaborate", ("adj", "IH0 L AE1 B R AH0 T"), ("verb", "IH0 L AE1 B ER0 EY2 T"), ate_verb),
    h("articulate", ("adj", "AA0 R T IH1 K Y AH0 L AH0 T"), ("verb", "AA0 R T IH1 K Y AH0 L EY2 T"), ate_verb),
    h("animate", ("adj", "AE1 N AH0 M AH0 T"), ("verb", "AE1 N AH0 M EY2 T"), ate_verb),
    h("subordinate", ("adj", "S AH0 B AO1 R D AH0 N AH0 T"), ("verb", "S AH0 B AO1 R D AH0 N EY2 T"), ate_verb),
    h("degenerate", ("adj", "D IH0 JH EH1 N ER0 AH0 T"), ("verb", "D IH0 JH EH1 N ER0 EY2 T"), ate_verb),
    // Told apart by stress: "the latest UPdate", "please upDATE it".
    h("update", ("noun", "AH1 P D EY2 T"), ("verb", "AH0 P D EY1 T"), verb_unless_noun),
    h("updates", ("noun", "AH1 P D EY2 T S"), ("verb", "AH0 P D EY1 T S"), verb_s),
    h("upgrade", ("noun", "AH1 P G R EY2 D"), ("verb", "AH0 P G R EY1 D"), verb_unless_noun),
    h("upgrades", ("noun", "AH1 P G R EY2 D Z"), ("verb", "AH0 P G R EY1 D Z"), verb_s),
    h("refund", ("noun", "R IY1 F AH2 N D"), ("verb", "R IH0 F AH1 N D"), verb_if_plain),
    h("refunds", ("noun", "R IY1 F AH2 N D Z"), ("verb", "R IH0 F AH1 N D Z"), verb_s),
    h("transfer", ("noun", "T R AE1 N S F ER0"), ("verb", "T R AE0 N S F ER1"), verb_if_plain),
    h("transfers", ("noun", "T R AE1 N S F ER0 Z"), ("verb", "T R AE0 N S F ER1 Z"), verb_s),
    h("survey", ("noun", "S ER1 V EY2"), ("verb", "S ER0 V EY1"), verb_if_plain),
    h("surveys", ("noun", "S ER1 V EY2 Z"), ("verb", "S ER0 V EY1 Z"), verb_s),
    h("suspect", ("noun", "S AH1 S P EH2 K T"), ("verb", "S AH0 S P EH1 K T"), suspect_verb),
    h("suspects", ("noun", "S AH1 S P EH2 K T S"), ("verb", "S AH0 S P EH1 K T S"), verb_s),
    h("permit", ("noun", "P ER1 M IH2 T"), ("verb", "P ER0 M IH1 T"), verb_unless_noun),
    h("permits", ("noun", "P ER1 M IH2 T S"), ("verb", "P ER0 M IH1 T S"), permits_verb),
    h("discount", ("noun", "D IH1 S K AW0 N T"), ("verb", "D IH0 S K AW1 N T"), verb_if_plain),
    h("impact", ("noun", "IH1 M P AE0 K T"), ("verb", "IH2 M P AE1 K T"), verb_if_plain),
    h("import", ("noun", "IH1 M P AO2 R T"), ("verb", "IH2 M P AO1 R T"), verb_if_plain),
    h("imports", ("noun", "IH1 M P AO2 R T S"), ("verb", "IH2 M P AO1 R T S"), verb_s),
    h("export", ("noun", "EH1 K S P AO0 R T"), ("verb", "IH0 K S P AO1 R T"), verb_if_plain),
    h("exports", ("noun", "EH1 K S P AO0 R T S"), ("verb", "IH0 K S P AO1 R T S"), verb_s),
    h("insert", ("noun", "IH1 N S ER2 T"), ("verb", "IH2 N S ER1 T"), verb_unless_noun),
    h("recall", ("noun", "R IY1 K AO2 L"), ("verb", "R IH0 K AO1 L"), verb_unless_noun),
    h("digest", ("noun", "D AY1 JH EH0 S T"), ("verb", "D AY0 JH EH1 S T"), verb_unless_noun),
    h("insult", ("noun", "IH1 N S AH2 L T"), ("verb", "IH2 N S AH1 L T"), verb_unless_noun),
    h("insults", ("noun", "IH1 N S AH2 L T S"), ("verb", "IH2 N S AH1 L T S"), verb_s),
    h("escort", ("noun", "EH1 S K AO0 R T"), ("verb", "EH0 S K AO1 R T"), verb_unless_noun),
    h("reset", ("noun", "R IY1 S EH0 T"), ("verb", "R IY0 S EH1 T"), verb_unless_noun),
    h("rewrite", ("noun", "R IY1 R AY2 T"), ("verb", "R IY0 R AY1 T"), verb_unless_noun),
    h("refill", ("noun", "R IY1 F IH0 L"), ("verb", "R IY0 F IH1 L"), verb_if_plain),
    h("recap", ("noun", "R IY1 K AE2 P"), ("verb", "R IH0 K AE1 P"), verb_if_plain),
    h("conduct", ("noun", "K AA1 N D AH0 K T"), ("verb", "K AA0 N D AH1 K T"), verb_base),
    h("combat", ("noun", "K AA1 M B AE0 T"), ("verb", "K AH0 M B AE1 T"), verb_base),
    h("torment", ("noun", "T AO1 R M EH2 N T"), ("verb", "T AO0 R M EH1 N T"), verb_base),
    h("invite", ("verb", "IH2 N V AY1 T"), ("noun", "IH1 N V AY2 T"), invite_noun),
    h("invites", ("verb", "IH2 N V AY1 T S"), ("noun", "IH1 N V AY2 T S"), invite_noun),
    h("addict", ("noun", "AE1 D IH2 K T"), ("verb", "AH0 D IH1 K T"), bare),
    h("addicts", ("noun", "AE1 D IH2 K T S"), ("verb", "AH0 D IH1 K T S"), never),
    h("upset", ("adj", "AH0 P S EH1 T"), ("noun", "AH1 P S EH2 T"), upset_noun),
    h("resume", ("verb", "R IH0 Z UW1 M"), ("noun", "R EH1 Z AH0 M EY2"), resume_noun),
    h("resumes", ("verb", "R IH0 Z UW1 M Z"), ("noun", "R EH1 Z AH0 M EY2 Z"), resume_noun),
    h("defect", ("noun", "D IY1 F EH0 K T"), ("verb", "D IH0 F EH1 K T"), verb_base),
    h("exploit", ("noun", "EH1 K S P L OY2 T"), ("verb", "EH2 K S P L OY1 T"), verb_unless_noun),
    h("exploits", ("noun", "EH1 K S P L OY2 T S"), ("verb", "EH2 K S P L OY1 T S"), verb_s),
    h("construct", ("noun", "K AA1 N S T R AH0 K T"), ("verb", "K AH0 N S T R AH1 K T"), verb_unless_noun),
    h("constructs", ("noun", "K AA1 N S T R AH0 K T S"), ("verb", "K AH0 N S T R AH1 K T S"), verb_s),
    h("transport", ("noun", "T R AE1 N S P AO0 R T"), ("verb", "T R AE0 N S P AO1 R T"), verb_if_plain),
    h("transports", ("noun", "T R AE1 N S P AO0 R T S"), ("verb", "T R AE0 N S P AO1 R T S"), verb_s),
    h("segment", ("noun", "S EH1 G M AH0 N T"), ("verb", "S EH2 G M EH1 N T"), verb_base),
    h("segments", ("noun", "S EH1 G M AH0 N T S"), ("verb", "S EH2 G M EH1 N T S"), verb_s),
    h("discharge", ("noun", "D IH1 S CH AA2 R JH"), ("verb", "D IH0 S CH AA1 R JH"), verb_unless_noun),
    h("compress", ("noun", "K AA1 M P R EH0 S"), ("verb", "K AH0 M P R EH1 S"), verb_unless_noun),
    h("offset", ("noun", "AO1 F S EH2 T"), ("verb", "AO0 F S EH1 T"), offset_verb),
    h("regress", ("noun", "R IY1 G R EH0 S"), ("verb", "R IH0 G R EH1 S"), verb_unless_noun),
    h("overflow", ("noun", "OW1 V ER0 F L OW2"), ("verb", "OW2 V ER0 F L OW1"), verb_base),
    h("override", ("noun", "OW1 V ER0 R AY2 D"), ("verb", "OW2 V ER0 R AY1 D"), verb_unless_noun),
    h("overrides", ("noun", "OW1 V ER0 R AY2 D Z"), ("verb", "OW2 V ER0 R AY1 D Z"), verb_s),
    h("overlap", ("noun", "OW1 V ER0 L AE2 P"), ("verb", "OW2 V ER0 L AE1 P"), verb_unless_noun),
    h("overlaps", ("noun", "OW1 V ER0 L AE2 P S"), ("verb", "OW2 V ER0 L AE1 P S"), verb_s),
    h("overhaul", ("noun", "OW1 V ER0 HH AO2 L"), ("verb", "OW2 V ER0 HH AO1 L"), verb_unless_noun),
    h("incline", ("noun", "IH1 N K L AY0 N"), ("verb", "IH2 N K L AY1 N"), verb_unless_noun),
    h("ferment", ("noun", "F ER1 M EH0 N T"), ("verb", "F ER0 M EH1 N T"), verb_unless_noun),
    h("commune", ("noun", "K AA1 M Y UW0 N"), ("verb", "K AH0 M Y UW1 N"), verb_base),
    h("conscript", ("noun", "K AA1 N S K R IH2 P T"), ("verb", "K AH0 N S K R IH1 P T"), verb_base),
    h("rebound", ("noun", "R IY1 B AW2 N D"), ("verb", "R IY0 B AW1 N D"), verb_unless_noun),
    h("combine", ("verb", "K AH0 M B AY1 N"), ("noun", "K AA1 M B AY0 N"), combine_noun),
    h("proceeds", ("verb", "P R AH0 S IY1 D Z"), ("noun", "P R OW1 S IY2 D Z"), proceeds_noun),
];

/// Words whose capital tells: Polish the people, Nice the city. word as written, at `low[i]`.
pub fn cased(word: &str, low: &[String], i: usize) -> Option<Vec<&'static str>> {
    let first = i == 0 || matches!(low[i - 1].as_str(), "." | "!" | "?" | ":");
    let a = At { t: low, i };
    let p = match word {
        // "Polish the silver" heads a sentence as the verb
        "Polish" if !(first && (is(a.next(), OBJ_START) || poss(a.next()))) => "P OW1 L IH0 SH",
        "Nice" if is(a.raw(-1), &["in", "from", "to", "of", "near", "visit", "visited", "visiting"])
            || (a.next().is_none() && low.get(i + 1).map_or(false, |w| w == ",") && low.get(i + 2).map_or(false, |w| w == "france")) =>
        {
            "N IY1 S"
        }
        _ => return None,
    };
    Some(p.split_whitespace().collect())
}

/// The sense of `t[i]` and its phones, if it is a heteronym. t holds words, lowercase, and stops.
pub fn choose(t: &[String], i: usize) -> Option<(&'static str, Vec<&'static str>)> {
    let het = HETS.iter().find(|x| x.word == t[i])?;
    let (name, phones) = if (het.b_if)(&At { t, i }) { het.b } else { het.a };
    Some((name, phones.split_whitespace().collect()))
}

// Word classes. Determiners that only start a noun phrase (not "that", "which": they also join
// clauses), and possessives.
const DET: &[&str] = &[
    "a", "an", "the", "this", "these", "those", "my", "your", "his", "her", "its", "our", "their", "thy",
    "no", "every", "each", "another", "whose", "either", "neither", "some", "any", "such", "what",
];
const NUM: &[&str] = &[
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "twenty", "thirty", "forty", "fifty", "hundred", "thousand", "million", "many", "few", "several",
    "first", "second", "third", "last", "next",
];
/// Adjectives common before a noun.
const ADJ: &[&str] = &[
    "own", "other", "great", "little", "small", "large", "big", "old", "young", "new", "long", "short",
    "whole", "same", "mortal", "human", "happy", "busy", "private", "simple", "quiet", "useful",
    "different", "various", "entire", "certain", "good", "bad", "poor", "rich", "dear", "sweet", "fine",
    "noble", "brave", "wise", "holy", "deep", "low", "high", "cold", "warm", "hot", "north", "south",
    "east", "west", "northern", "southern", "eastern", "western", "strong", "fierce", "gentle", "light",
    "fresh", "bitter", "keen", "wild", "soft", "sharp", "chill", "icy", "evening", "morning", "night",
    "summer", "winter", "autumn", "spring", "white", "black", "red", "blue", "green", "grey", "gray",
    "golden", "dark", "bright", "heavy", "main", "chief", "sole", "principal", "only", "real", "true",
    "single", "silent", "sad", "painful", "fatal", "slight", "severe", "terrible", "hard", "brief",
    "full", "free", "pure", "dull", "humble", "plain",
];
const PREP: &[&str] = &[
    "of", "in", "on", "at", "with", "by", "for", "from", "into", "onto", "upon", "under", "over",
    "about", "after", "before", "through", "without", "within", "among", "between", "against",
    "toward", "towards", "across", "behind", "beyond", "near", "like", "than", "as",
];
const OBJ: &[&str] = &[
    "me", "you", "him", "her", "it", "us", "them", "myself", "yourself", "himself", "herself", "itself",
    "ourselves", "yourselves", "themselves", "oneself", "thee",
];
/// Words that start a verb's object.
const OBJ_START: &[&str] = &[
    "me", "you", "him", "her", "it", "us", "them", "myself", "yourself", "himself", "herself", "itself",
    "ourselves", "yourselves", "themselves", "oneself", "thee", "the", "a", "an", "this", "these",
    "those", "his", "its", "their", "my", "your", "our", "thy", "some", "any", "no", "each", "every",
    "all", "both", "such", "another", "mine", "yours", "ours", "theirs", "hers",
];
const SUBJ: &[&str] = &["i", "you", "we", "they", "he", "she", "it", "who", "thou", "ye"];
/// Indefinite subjects: "does anyone object".
const SOMEONE: &[&str] = &[
    "anyone", "anybody", "everyone", "everybody", "someone", "somebody", "nobody", "one",
];
/// Words ending in s that are not plural nouns.
const NOT_PLURAL: &[&str] = &[
    "this", "always", "sometimes", "perhaps", "unless", "across", "towards", "afterwards", "besides",
    "whereas", "yes", "does", "was", "has", "hers", "ours", "yours", "theirs", "its", "his", "thus",
    "plus", "less", "news", "series", "species", "means", "sales", "sports", "arms", "goods", "savings",
    "earnings", "customs", "futures", "options", "securities", "operations", "services", "communications",
];
/// Subjects of a verb's bare form.
const SUBJ_PL: &[&str] = &["i", "you", "we", "they", "who", "ye"];
/// Subjects of a verb's -s form.
const SUBJ3: &[&str] = &[
    "he", "she", "it", "who", "which", "one", "nobody", "everybody", "everyone", "someone", "somebody",
    "anyone", "anybody", "nothing", "something", "everything",
];
/// Words a verb's bare form follows.
const VB: &[&str] = &[
    "to", "will", "would", "shall", "should", "can", "could", "may", "might", "must", "cannot", "can't",
    "couldn't", "won't", "wouldn't", "shan't", "shouldn't", "mustn't", "mightn't", "needn't", "mayn't",
    "i'll", "you'll", "he'll", "she'll", "we'll", "they'll", "it'll", "that'll", "there'll", "who'll",
    "i'd", "you'd", "he'd", "she'd", "we'd", "they'd", "who'd", "let's", "do", "does", "did",
    "don't", "doesn't", "didn't", "dost", "doth", "didst", "wilt", "shalt", "canst", "couldst",
    "wouldst", "shouldst", "mayst", "mightst",
];
/// "had better", "you'd better"
const HAD: &[&str] = &[
    "had", "i'd", "you'd", "he'd", "she'd", "we'd", "they'd", "who'd",
];
const BE: &[&str] = &[
    "be", "is", "are", "was", "were", "am", "been", "being", "i'm", "you're", "we're", "they're",
    "he's", "she's", "it's", "that's", "there's", "isn't", "aren't", "wasn't", "weren't", "art",
];
const HAVE: &[&str] = &[
    "have", "has", "had", "having", "i've", "you've", "we've", "they've", "hasn't", "haven't", "hadn't",
];
/// Adverbs passed over when looking back for what governs a word.
const ADV: &[&str] = &[
    "not", "never", "also", "always", "often", "ever", "only", "then", "now", "just", "still", "soon",
    "rather", "first", "hardly", "scarcely", "even", "sometimes", "seldom", "once", "quite", "all",
    "both", "too", "again", "thus", "therefore", "perhaps", "indeed", "almost", "nearly", "neither",
    "either",
];
/// Words that open a sentence before its verb: "now read it".
const OPENERS: &[&str] = &[
    "now", "no", "yes", "oh", "o", "pray", "but", "here", "look", "please", "just", "so", "well", "then",
    ",",
];
/// Words ending in -ly that are not adverbs.
const NOT_LY: &[&str] = &[
    "family", "lily", "belly", "july", "reply", "supply", "apply", "rely", "ally", "italy", "bully",
    "folly", "holly", "jelly", "rally", "tally", "sully", "curly", "early", "holy", "ugly", "lovely",
    "lonely", "lively", "friendly", "silly", "jolly", "homely", "comely", "burly", "surly", "wily",
    "oily", "hilly", "chilly", "woolly", "manly", "womanly", "godly", "ungodly", "heavenly", "deadly",
    "costly", "elderly", "orderly", "cowardly", "scholarly", "daily", "weekly", "monthly", "yearly",
    "likely", "unlikely", "lowly", "stately", "sickly", "ghastly", "portly", "earthly", "worldly",
    "unearthly", "princely", "kingly", "saintly", "shapely", "timely", "untimely", "melancholy",
    "assembly", "monopoly", "butterfly", "dragonfly", "firefly", "gully", "dally", "kelly", "emily",
    "molly", "polly", "dolly", "sally", "billy", "willy", "nelly", "beastly", "brotherly", "sisterly",
    "motherly", "fatherly", "neighbourly", "neighborly", "gentlemanly", "leisurely", "anomaly",
];

#[inline(never)]
fn is(w: Option<&str>, set: &[&str]) -> bool {
    w.map_or(false, |w| set.contains(&w))
}

/// Words in 's that are not possessives: "let's", "it's".
const NOT_POSS: &[&str] = &[
    "let's", "it's", "that's", "he's", "she's", "there's", "here's", "what's", "who's", "where's",
    "how's", "when's", "why's",
];

fn poss(w: Option<&str>) -> bool {
    w.map_or(false, |w| (w.ends_with("'s") || w.ends_with("s'")) && !NOT_POSS.contains(&w))
}

/// An adjective by its ending: "industrious lives", "useful lives".
fn adjectival(w: &str) -> bool {
    ADJ.contains(&w)
        || ["ous", "ful", "less", "ive", "al", "ic", "able", "ible", "ish", "y", "ed", "ing", "ent", "ant", "est", "er"]
            .iter()
            .any(|e| w.len() > e.len() + 2 && w.ends_with(e))
}

/// Verbs that open a question before its subject: "does the landlord permit pets".
const MODAL_Q: &[&str] = &[
    "do", "does", "did", "will", "would", "can", "could", "should", "may", "might", "must", "shall",
];
/// Words of degree a determiner leads with no noun after: "a bit upset", "a lot".
const DEGREE: &[&str] = &[
    "bit", "little", "lot", "very", "so", "too", "really", "quite", "rather", "most", "more", "much",
    "less", "least", "kind", "sort", "few", "couple",
];
/// Words a verb does not take as its object: "the exports fell", "trucks transport are".
const NOT_OBJECT: &[&str] = &[
    "and", "or", "but", "that", "which", "who", "fell", "rose", "grew", "went", "came", "hit", "said",
    "made", "took", "saw", "got", "began", "kept", "left", "led", "ran", "sank", "slid", "shrank",
    "stood", "remain", "rise", "fall", "grow", "increase", "decrease", "continue", "include", "show",
    "need", "make", "go", "come", "seem", "account", "totaled", "totalled", "take", "takes", "cost",
    "require", "allow", "let", "help", "add", "fix", "last", "vary", "expire", "apply", "mean", "become",
    "look", "keep", "get", "give", "say", "matter", "depend", "happen", "arrive", "begin", "fail",
    "follow", "appear", "exist", "provide", "affect", "reach", "rely", "tend", "stay", "jump", "surge",
    "soar", "plunge", "climb", "slip", "dip", "slump", "lag", "exceed", "reflect", "suggest",
    "indicate", "cause", "create", "face", "remained", "won't", "can't",
];

/// A plural noun by its ending.
fn plural(p: &str) -> bool {
    p.len() > 3
        && p.ends_with('s')
        && !["ss", "us", "is", "'s", "ous", "ics"].iter().any(|e| p.ends_with(e))
        && !NOT_PLURAL.contains(&p)
}

/// A word inside a noun phrase before its head: not a pronoun, verb, preposition or adverb.
fn plain(w: &str) -> bool {
    let w = Some(w);
    ![SUBJ, OBJ, VB, BE, HAVE, HAD, PREP, DET, DEGREE, SOMEONE, NOT_OBJECT].iter().any(|set| is(w, set))
        && !w.map_or(false, |w| adverb(w) || plural(w))
}

/// What a verb takes after it with no determiner: "transport goods", "imports most of its oil".
fn objectish(w: Option<&str>) -> bool {
    w.map_or(false, |n| {
        ![PREP, BE, VB, HAVE, NOT_OBJECT].iter().any(|set| is(Some(n), set)) && !n.ends_with("ed") && !adverb(n)
    })
}

fn adverb(w: &str) -> bool {
    ADV.contains(&w) || (w.len() > 4 && w.ends_with("ly") && !NOT_LY.contains(&w))
}

/// A word's place among the words and stops of what is said; its clause ends at a stop.
pub struct At<'a> {
    t: &'a [String],
    i: usize,
}

impl<'a> At<'a> {
    /// The word k places away (before if k < 0) in the clause.
    fn raw(&self, k: isize) -> Option<&'a str> {
        let mut j = self.i as isize;
        for _ in 0..k.abs() {
            j += k.signum();
            if j < 0 || j as usize >= self.t.len() || STOPS.contains(&self.t[j as usize].as_str()) {
                return None;
            }
        }
        Some(self.t[j as usize].as_str())
    }

    /// The nearest word before t[from] in the clause, past adverbs.
    fn before(&self, from: usize) -> Option<usize> {
        let mut j = from;
        while j > 0 {
            j -= 1;
            let w = self.t[j].as_str();
            if STOPS.contains(&w) {
                return None;
            }
            if !adverb(w) {
                return Some(j);
            }
        }
        None
    }

    fn prev(&self) -> Option<&'a str> {
        self.before(self.i).map(|j| self.t[j].as_str())
    }

    fn prev2(&self) -> Option<&'a str> {
        self.before(self.i).and_then(|j| self.before(j)).map(|j| self.t[j].as_str())
    }

    fn next(&self) -> Option<&'a str> {
        self.raw(1)
    }

    /// The first word of its sentence.
    fn sentence_start(&self) -> bool {
        self.i == 0 || matches!(self.t[self.i - 1].as_str(), "." | "!" | "?")
    }

    /// First in its sentence but for words that open one: "now read it", "no, read it".
    fn opens(&self) -> bool {
        let mut j = self.i;
        while j > 0 && OPENERS.contains(&self.t[j - 1].as_str()) {
            j -= 1;
        }
        j == 0 || matches!(self.t[j - 1].as_str(), "." | "!" | "?")
    }

    /// One of the n words before it in the clause is in set.
    fn near(&self, n: isize, set: &[&str]) -> bool {
        (1..=n).any(|k| is(self.raw(-k), set))
    }

    fn ahead(&self, n: isize, set: &[&str]) -> bool {
        (1..=n).any(|k| is(self.raw(k), set))
    }

    /// Right after a determiner, possessive, number or adjective: a noun or adjective.
    fn nominal(&self) -> bool {
        let p = self.raw(-1);
        is(p, DET) || poss(p) || is(p, NUM) || is(p, ADJ)
    }

    fn after_prep(&self) -> bool {
        is(self.raw(-1), PREP)
    }

    /// A subject then a modal or do before it: "will you read", "did he ever object".
    fn inverted(&self) -> bool {
        (is(self.prev(), SUBJ) || is(self.prev(), SOMEONE)) && self.prev2() != Some("to") && is(self.prev2(), VB)
    }

    /// An -s form after "this", which no plural follows: "this presents a problem".
    fn this_s(&self) -> bool {
        self.raw(-1) == Some("this") && self.t[self.i].ends_with('s') && !self.t[self.i].ends_with("ss")
    }

    /// A plural noun just before, then what follows a verb: "muscles contract when cold",
    /// "trucks transport goods".
    fn plural_subject(&self) -> bool {
        let p = match self.prev() {
            Some(p) => p,
            None => return false,
        };
        let led = self.prev2().map_or(true, |w| {
            is(Some(w), DET) || is(Some(w), NUM) || is(Some(w), ADJ) || is(Some(w), &["most", "all", "both"])
        });
        let n = self.next();
        plural(p)
            && !is(self.prev2(), PREP)
            && (is(n, &["against", "with", "when", "whenever", "because", "unless"])
                || (led && (n.map_or(true, adverb) || objectish(n) || (is(n, PREP) && n != Some("of")))))
    }

    /// A determiner two or three words before, only a noun's words between: "a steep incline",
    /// "the zero day exploit".
    fn det_phrase(&self) -> bool {
        (2..=3).any(|j| {
            (is(self.raw(-j), DET) || poss(self.raw(-j))) && (1..j).all(|k| self.raw(-k).map_or(false, plain))
        })
    }

    /// A singular subject, alone or after a determiner, then an object: "the app exports video",
    /// "Brazil exports coffee".
    fn det_subject(&self) -> bool {
        let at_start = self.raw(-2).is_none() && self.i >= 1 && !STOPS.contains(&self.t[self.i - 1].as_str());
        let modifier = |w: &str| {
            ["al", "ous", "ful", "ive", "ic", "ing", "ish", "able", "ible", "less"].iter().any(|e| w.len() > e.len() + 2 && w.ends_with(e))
        };
        ((is(self.raw(-2), DET) && !is(self.raw(-2), &["these", "those"])) || at_start)
            && self.raw(-1).map_or(false, |w| plain(w) && !ADJ.contains(&w) && !modifier(w))
            && (objectish(self.next()) || is(self.next(), &["with", "against", "when", "whenever", "because", "unless"]))
    }

    /// Where a verb's bare form goes: after to, a modal, do, please, "let me" or "had better".
    fn bare(&self) -> bool {
        is(self.prev(), VB)
            || self.inverted()
            || self.prev() == Some("please")
            || (is(self.prev(), OBJ) && is(self.prev2(), &["let", "lets", "help", "helps", "helped"]))
            // "does the landlord permit pets"
            || (is(self.raw(-3), MODAL_Q)
                && is(self.raw(-2), DET)
                && self.raw(-1).map_or(false, |w| plain(w) && !KIND.contains(&w)))
            // "don't let the sink overflow", "let the dough ferment overnight"
            || ((self.next().map_or(true, adverb)
                || is(self.next(), PREP)
                || is(self.next(), &["overnight", "tonight", "today", "again", "longer"]))
                && self.raw(-1).map_or(false, plain)
                && is(self.raw(-2), DET)
                && is(self.raw(-3), &["let", "lets", "letting", "watch", "watched"]))
            || (self.prev() == Some("better") && is(self.prev2(), HAD))
    }

    /// Not after a noun's words, and an object after it.
    fn takes_object(&self) -> bool {
        !self.nominal() && !self.after_prep() && (is(self.next(), OBJ_START) || poss(self.next()))
    }
}

fn always(_: &At) -> bool {
    true
}

fn never(_: &At) -> bool {
    false
}

fn bare(a: &At) -> bool {
    a.bare()
}

fn before_word(a: &At) -> bool {
    a.next().is_some()
}

/// Noun/verb pairs, bare form: the verb after to, a modal, do or a plural subject, or with an object.
fn verb_base(a: &At) -> bool {
    a.bare() || (!a.nominal() && is(a.prev(), SUBJ_PL)) || a.takes_object() || a.plural_subject()
}

/// Noun/verb pairs, -s form: the verb after a singular subject, or with an object.
fn verb_s(a: &At) -> bool {
    a.this_s()
        || (!a.nominal()
            && !a.after_prep()
            && (is(a.prev(), SUBJ3) || is(a.next(), OBJ_START) || poss(a.next()) || a.det_subject()))
}

/// What is recorded: "record audio", "the app records video".
const RECORDED: &[&str] = &[
    "audio", "video", "videos", "voice", "voices", "screen", "sound", "sounds", "calls", "meetings",
    "podcasts", "music", "songs", "everything", "lectures", "footage",
];

fn record_verb(a: &At) -> bool {
    verb_base(a) || (!a.nominal() && !a.after_prep() && is(a.next(), RECORDED))
}

fn records_verb(a: &At) -> bool {
    verb_s(a) || (!a.nominal() && !a.after_prep() && is(a.next(), RECORDED))
}

/// "convert the file to PDF", "convert to PDF"; "a convert to the faith" is nominal.
fn convert_verb(a: &At) -> bool {
    verb_base(a) || (!a.nominal() && !a.after_prep() && a.ahead(4, &["to", "into"]))
}

/// "extract text from images"; "extract from a letter" heads what follows.
fn extract_verb(a: &At) -> bool {
    verb_base(a) || (a.opens() && a.next().is_some() && a.next() != Some("from") && a.ahead(3, &["from"]))
}

/// -ate words: the verb after to, a modal, do or a subject, or with a pronoun or possessive
/// object.
fn ate_verb(a: &At) -> bool {
    // "students graduate in June"; "measures appropriate to the risk" keep the adjective
    let verbish = is(Some(a.t[a.i].as_str()), &["graduate", "estimate", "associate", "advocate", "delegate", "duplicate"]);
    a.bare()
        || (verbish && !a.nominal() && (a.plural_subject() || (a.prev().map_or(false, plural) && a.next() == Some("that"))))
        || (a.opens() && (a.next().is_none() || is(a.next(), DET) || is(a.next(), OBJ)))
        || (!a.nominal() && is(a.prev(), &["i", "you", "we", "they", "who", "which"]))
        || (!a.nominal()
            && !a.after_prep()
            && !is(a.raw(-1), &["however", "how", "so", "too", "very", "more", "most", "less", "quite", "rather"])
            && (is(a.next(), OBJ) || is(a.next(), &["my", "your", "our", "their", "his", "its"])))
}

/// Kinds of update, transfer, permit and the like: "software update", "bank transfer".
const KIND: &[&str] = &[
    "software", "status", "firmware", "security", "system", "app", "windows", "ios", "android", "news",
    "live", "price", "tax", "bank", "wire", "balance", "data", "file", "money", "cash", "fund", "funds",
    "parking", "work", "building", "travel", "residence", "prime", "chief", "murder", "terror", "police",
    "product", "vehicle", "safety", "food", "total", "factory", "password", "email", "customer",
    "employee", "student", "member", "calendar", "party", "wedding", "dinner", "drug", "opioid", "heroin",
    "student's", "add", "adds", "adding", "added", "armed", "military", "user", "staff", "market", "page",
    "weekly", "daily", "monthly", "quick", "latest", "major", "minor", "recent", "final", "big", "huge",
    "full", "partial", "instant", "cosmic", "climate", "trade", "gas", "oil", "car", "store", "season",
    "senior", "code", "web", "ticket", "fare", "bulk", "volume", "lung", "air", "rail", "road", "freight",
    "mass", "carbon", "manual", "birth", "zero", "day",
];
/// Words after a verb that heads a sentence: "Update now", "Transfer to savings".
const IMPERATIVE_NEXT: &[&str] = &[
    "now", "to", "from", "into", "here", "today", "tonight", "automatically", "immediately", "manually",
    "regularly", "how", "what", "when", "if", "before", "after", "via", "with", "using", "everything",
    "that",
];

/// Noun/verb pairs told apart by stress: Some(verb) where the words around decide, else None.
fn stressed(a: &At) -> Option<bool> {
    if a.bare() || a.this_s() {
        return Some(true);
    }
    if a.nominal() || a.after_prep() {
        return Some(false);
    }
    let p = a.raw(-1);
    if is(a.prev(), SUBJ_PL) || is(a.prev(), SOMEONE) || is(p, &["that", "which"]) {
        return Some(true);
    }
    if is(p, KIND) || p.map_or(false, |w| adjectival(w) && !adverb(w) && !is(Some(w), SUBJ) && !is(Some(w), OBJ)) {
        return Some(false);
    }
    if a.takes_object() || a.plural_subject() {
        return Some(true);
    }
    if a.det_phrase() {
        return Some(false);
    }
    // "Update now", "Transfer money to savings"; "Update available", "Transfer complete"
    if a.opens() {
        return Some(is(a.next(), IMPERATIVE_NEXT) || a.ahead(4, &["to", "into", "from"]));
    }
    None
}

fn verb_unless_noun(a: &At) -> bool {
    stressed(a).unwrap_or(true)
}

fn verb_if_plain(a: &At) -> bool {
    stressed(a).unwrap_or(false)
}

/// "his motives are suspect" is the adjective, said as the noun.
fn suspect_verb(a: &At) -> bool {
    !is(a.raw(-1), BE) && verb_unless_noun(a)
}

/// "as time permits"
fn permits_verb(a: &At) -> bool {
    verb_s(a) || (a.next().is_none() && is(a.raw(-2), &["as", "if", "when", "where", "unless"]))
}

fn invite_noun(a: &At) -> bool {
    a.nominal() || a.after_prep() || is(a.raw(-1), KIND)
}

/// "a stunning upset", "an upset win"; "an upset child" is upset.
fn upset_noun(a: &At) -> bool {
    (a.nominal() || a.det_phrase())
        && (a.next().is_none()
            || is(a.next(), PREP)
            || is(a.next(), &["win", "wins", "victory", "victories", "loss", "defeat"]))
}

/// "offset printing", "offset lithography"
fn offset_verb(a: &At) -> bool {
    verb_unless_noun(a) && !is(a.next(), &["printing", "printed", "press", "presses", "lithography", "smoker", "smokers"])
}

/// "progress slowly" after plural subjects; "make progress", "our progress".
fn progress_verb(a: &At) -> bool {
    a.bare() || (!a.nominal() && a.plural_subject())
}

/// "a combine harvester", "the combine"; "combine the flour and sugar".
fn combine_noun(a: &At) -> bool {
    is(a.next(), &["harvester", "harvesters"])
        || ((is(a.raw(-1), &["a", "an", "the", "my", "his", "her", "its", "our", "their", "your"]) || poss(a.raw(-1)))
            && !is(a.next(), &["with", "into", "to"]))
}

/// "the proceeds go to charity"; "he proceeds to explain".
fn proceeds_noun(a: &At) -> bool {
    a.nominal() || a.after_prep() || is(a.raw(-1), &["net", "gross", "sale", "ticket", "auction", "all"])
}

/// "send your resume", "resume writing"; "resume the game", "play resumes at noon".
fn resume_noun(a: &At) -> bool {
    a.nominal()
        || a.after_prep()
        || is(a.next(), &["writing", "template", "templates", "builder", "tips", "format", "examples", "sample", "samples", "review"])
        || is(a.raw(-1), &["send", "upload", "submit", "attach", "attached", "updated", "polished"])
        || (a.opens() && is(a.next(), &["are", "were", "should", "must"]))
}

/// What rises or falls: "a price increase", "a five percent decrease".
const CHANGED: &[&str] = &[
    "percent", "rent", "pay", "price", "tax", "wage", "salary", "rate", "fee", "cost", "demand",
    "traffic", "population", "temperature", "speed", "budget", "revenue", "risk", "crime", "significant",
    "slight", "steady", "sudden", "huge", "massive", "modest", "marked", "gradual", "rapid",
    "substantial", "dramatic", "overall", "annual", "net", "further", "notable", "corresponding",
];

fn change_noun(a: &At) -> bool {
    a.nominal() || is(a.raw(-1), &["of"]) || is(a.raw(-1), CHANGED)
}

fn nominal_or_prep(a: &At) -> bool {
    !a.this_s() && (a.nominal() || a.after_prep() || is(a.raw(-1), BE))
}

/// Things that are live: "live coals", "a live wire".
const LIVE_NOUNS: &[&str] = &[
    "stock", "oak", "oaks", "coal", "coals", "ember", "embers", "wire", "wires", "bait", "steam",
    "broadcast", "broadcasts", "music", "concert", "concerts", "recording", "recordings", "audience",
    "audiences", "shell", "shells", "ammunition", "round", "rounds", "animals", "show", "shows",
    "updates", "update", "coverage", "chat", "stream", "streams", "streaming", "blog", "feed", "feeds",
    "video", "videos", "demo", "demos", "data", "event", "events", "performance", "performances",
    "results", "scores", "tv", "television", "radio", "action", "footage", "webcast", "audio",
    "traffic", "tracking", "captions", "transcription", "translation", "preview",
];
/// Words for when: "went live yesterday", "goes live in five minutes".
const WHEN: &[&str] = &[
    "now", "today", "tonight", "tomorrow", "yesterday", "soon", "shortly", "later", "next", "last",
    "this", "early", "once",
];
const WHEN_UNITS: &[&str] = &[
    "second", "seconds", "minute", "minutes", "hour", "hours", "day", "days", "week", "weeks", "month",
    "months", "year", "years", "noon", "midnight", "monday", "tuesday", "wednesday", "thursday", "friday",
    "saturday", "sunday", "o'clock", "am", "pm",
];
/// Ways to be seen or heard live: "broadcast live", "reporting live".
const ON_AIR: &[&str] = &[
    "broadcast", "broadcasts", "broadcasting", "aired", "air", "airs", "airing", "stream", "streams",
    "streamed", "streaming", "televised", "filmed", "recorded", "performed", "perform", "performs",
    "performing", "play", "plays", "played", "playing", "speaking", "speaks", "spoke", "reporting",
    "reports", "reported", "appear", "appears", "appeared", "appearing", "shown", "showing", "watch",
    "watching", "sing", "sang", "singing", "carried", "covered",
];
/// Words that cannot be the noun after "live": its object, place or company.
const NOT_NOUN: &[&str] = &[
    "and", "or", "but", "nor", "so", "if", "that", "there", "here", "together", "alone", "apart",
    "again", "long", "well", "now", "then", "still", "yet", "up", "down", "out", "off", "away",
    "forever", "ever", "too", "also", "i", "you", "he", "she", "it", "we", "they", "me", "him", "us",
    "them", "who", "which", "what", "where", "when", "how", "why", "is", "are", "was", "were", "be",
    "not", "the", "a", "an", "his", "her", "my", "your", "our", "their", "its", "this", "these",
    "those", "all", "both", "each", "upon", "on", "in", "at", "with", "by", "for", "from", "to", "of",
    "under", "over", "near", "among", "without", "within", "through", "after", "before", "like",
    "than", "as", "amongst", "beside", "happily", "honestly", "simply", "quietly", "peacefully",
];

fn live_adj(a: &At) -> bool {
    let n = a.next();
    if is(n, LIVE_NOUNS) {
        return true;
    }
    if is(a.raw(-1), ON_AIR) {
        return true;
    }
    // "the site is now live", "we're live", "are we live"
    if is(a.prev(), BE) || (is(a.prev(), SUBJ) && is(a.prev2(), BE)) {
        return true;
    }
    // "Live from Kyiv", "Live: the vote"
    if a.opens() && (n == Some("from") || a.t.get(a.i + 1).map_or(false, |w| w == ":")) {
        return true;
    }
    // "went live yesterday", "going live in five minutes"; "go live with them" lives
    if is(a.raw(-1), &["go", "goes", "went", "going", "gone"])
        && (n.is_none()
            || is(n, WHEN)
            || (is(n, &["in", "at", "on", "by"]) && a.ahead(4, WHEN_UNITS))
            || (is(n, &["at", "by"]) && is(a.raw(2), NUM)))
    {
        return true;
    }
    // "watch it live tonight", "catch the band live at the Fillmore"
    if a.near(3, &["watch", "watching", "catch", "catching", "stream", "streaming"])
        && (n.is_none() || is(n, &["on", "at", "tonight", "today", "now", "online", "here", "from"]))
    {
        return true;
    }
    let p = a.prev();
    n.map_or(false, |n| !NOT_NOUN.contains(&n) && !adverb(n))
        && (is(p, DET) || poss(p) || is(p, NUM) || is(p, &["little", "small", "like", "real"]))
}

/// Where one lives.
const LIVES_AT: &[&str] = &[
    "in", "at", "on", "near", "there", "here", "alone", "with", "by", "among", "upon", "under",
    "happily", "still", "far", "close", "next", "opposite", "beyond", "across", "abroad", "nearby",
    "somewhere", "again", "forever", "apart", "after", "till", "until",
];

/// Verbs whose object is lives: "saved lives in the war".
const LIVES_OBJ: &[&str] = &[
    "save", "saves", "saved", "saving", "risk", "risks", "risked", "risking", "lose", "loses", "lost",
    "losing", "spend", "spends", "spent", "spending", "ruin", "ruins", "ruined", "cost", "costs",
    "claim", "claims", "claimed", "take", "takes", "took", "taken", "owe", "owes", "owed", "change",
    "changes", "changed", "touch", "touched", "touches", "lead", "leads", "led", "live", "lived",
    "sacrifice", "sacrificed", "end", "ended", "endanger", "endangered", "threaten", "threatened",
    "shape", "shaped", "transform", "transformed", "affect", "affected", "destroy", "destroyed",
];

fn lives_verb(a: &At) -> bool {
    if a.nominal() || a.after_prep() || is(a.prev(), LIVES_OBJ) {
        return false;
    }
    // "as long as he lives", "as god lives", "the evil that men do lives after them"
    is(a.prev(), SUBJ3)
        || is(a.prev(), &["that", "do", "does", "did"])
        || is(a.next(), LIVES_AT)
        || a.raw(-2) == Some("as")
        // "how the other half lives.": last in its clause after a noun, not an adjective
        || (a.next().is_none() && a.prev().map_or(false, |w| !adjectival(w) && !is(Some(w), &["and", "or", "all", "both"])))
}

/// Verbs whose object takes a bare verb: "let me read", "heard him read".
const CAUSE: &[&str] = &[
    "let", "lets", "make", "makes", "made", "help", "helps", "helped", "hear", "hears", "heard", "see",
    "sees", "saw", "watch", "watched", "bid", "bade",
];

/// Present tense elsewhere in the sentence: "kids who read for fun do better", "we read a chapter a day".
const NOW_CUES: &[&str] = &[
    "is", "are", "am", "isn't", "aren't", "do", "don't", "does", "doesn't", "can", "can't", "have",
    "has", "get", "gets", "see", "think", "know", "like", "love", "want", "need", "feel", "find",
    "say", "go", "tend", "prefer", "enjoy", "spend", "learn", "every", "each", "daily", "weekly",
    "nightly", "usually", "always", "often", "sometimes", "rarely", "seldom", "generally", "typically",
    "normally", "regularly", "nowadays", "lot", "lots", "per", "more", "less", "most", "few",
];
/// Past tense elsewhere in the sentence: "the kids read quietly while we cooked".
const THEN_CUES: &[&str] = &[
    "was", "were", "wasn't", "weren't", "did", "didn't", "had", "hadn't", "yesterday", "ago", "last",
    "once", "said", "went", "saw", "took", "came", "got", "made", "knew", "thought", "told", "found",
    "gave", "left", "felt", "sat", "stood", "wrote", "began", "ran", "heard", "kept", "brought",
    "bought", "spoke", "became", "sent", "held", "lost", "met", "paid", "fell", "grew", "drew",
    "threw", "taught", "caught", "slept", "woke", "won", "wore", "ate", "drank", "sang", "swam",
];

/// Subjects that leave read's tense open: "we", "they", "most people", "kids"; "she read" is past.
fn open_subject(w: Option<&str>) -> bool {
    is(w, SUBJ_PL) || is(w, &["people", "children", "men", "women", "folk"]) || w.map_or(false, plural)
}

/// The other words of the sentence say present and none say past.
fn present_sentence(a: &At) -> bool {
    let end = |w: &str| matches!(w, "." | "!" | "?" | ";");
    let mut s = a.i;
    while s > 0 && !end(&a.t[s - 1]) {
        s -= 1;
    }
    let mut e = a.i;
    while e + 1 < a.t.len() && !end(&a.t[e + 1]) {
        e += 1;
    }
    let (mut now, mut then) = (false, false);
    for j in s..=e {
        let w = a.t[j].as_str();
        // bare forms after to or a modal say nothing of the sentence's tense
        if j == a.i || (j > s && VB.contains(&a.t[j - 1].as_str())) {
            continue;
        }
        let before = if j > s { Some(a.t[j - 1].as_str()) } else { None };
        if NOW_CUES.contains(&w) && !(j < a.i && HAVE.contains(&w)) {
            now = true;
        }
        let ed = w.len() > 4 && w.ends_with("ed") && !w.ends_with("eed") && w != "used" && w != "hundred";
        if THEN_CUES.contains(&w) || (ed && !is(before, BE) && !is(before, DET)) {
            then = true;
        }
    }
    now && !then
}

fn read_pres(a: &At) -> bool {
    if a.bare() || a.opens() || (is(a.prev(), OBJ) && is(a.prev2(), CAUSE)) {
        return true;
    }
    // "i usually read the news"
    if is(a.raw(-1), &["usually", "often", "always", "sometimes", "rarely", "seldom", "generally", "typically", "normally", "regularly"])
        && is(a.raw(-2), SUBJ_PL)
    {
        return true;
    }
    // "you read" is present more than past; "have you read" past
    if a.prev() == Some("you") && !is(a.prev2(), HAVE) && !is(a.prev2(), BE) {
        return true;
    }
    // "to sit and read", "unlock and read": the bare form if the verb before "and" is
    if a.raw(-1) == Some("and") && a.i >= 2 {
        let x = At { t: a.t, i: a.i - 2 };
        if a.raw(-2).map_or(false, |w| !OBJ.contains(&w) && !DET.contains(&w) && !PREP.contains(&w)) {
            return is(x.prev(), VB) || x.sentence_start();
        }
    }
    open_subject(a.prev()) && present_sentence(a)
}

/// What keeps something close: "came close", "held her close".
const NEAR_BY: &[&str] = &[
    "so", "too", "very", "as", "more", "most", "quite", "rather", "come", "came", "comes", "coming",
    "draw", "drew", "drawn", "drawing", "held", "hold", "holds", "holding", "keep", "kept", "keeps",
    "keeping", "stay", "stayed", "sat", "sit", "stood", "stand", "lay", "lie", "lies", "lying",
    "pressed", "follow", "followed", "follows", "following", "get", "got", "gets", "getting", "crept",
    "clung", "huddled", "nestled", "hugged",
];

fn close_z(a: &At) -> bool {
    if a.bare() {
        return true;
    }
    // "the close of the day", "drew to a close"
    if is(a.raw(-1), &["the", "a", "its", "their", "his", "her"]) && (a.next().is_none() || a.next() == Some("of")) {
        return true;
    }
    if a.nominal() || a.after_prep() || is(a.prev(), NEAR_BY) || is(a.prev(), BE) {
        return false;
    }
    // "stores close early", "we close at nine"; "close at hand" is near
    if a.raw(-1).is_some()
        && (is(a.next(), &["early", "earlier", "higher", "lower", "today", "tonight", "tomorrow", "daily", "permanently", "temporarily"])
            || (a.next() == Some("at") && a.raw(2) != Some("hand") && (a.ahead(4, WHEN_UNITS) || a.ahead(4, NUM))))
    {
        return true;
    }
    (a.raw(-1).is_none() || is(a.raw(-1), &["and", "or", "then", "please"]) || is(a.prev(), SUBJ_PL))
        && (is(a.next(), OBJ_START) || poss(a.next()))
}

fn use_verb(a: &At) -> bool {
    if a.prev() == Some("to") {
        // "put to use"
        return !is(a.prev2(), &["put", "puts", "putting", "turn", "turned", "turns", "turning"]);
    }
    // "Use code SAVE20", "Use caution"; "use of force", "use case" name it
    if a.opens()
        && !a.nominal()
        && a.next().map_or(false, |n| {
            !is(Some(n), &["of", "case", "cases", "is", "was", "has", "will", "can", "and", "or", "makes", "made"])
        })
    {
        return true;
    }
    a.bare() || (!a.nominal() && (is(a.prev(), SUBJ_PL) || a.plural_subject())) || a.takes_object()
}

fn used_to(a: &At) -> bool {
    // "used often to walk"
    let k = if a.next().map_or(false, adverb) { 2 } else { 1 };
    if a.raw(k) != Some("to") {
        return false;
    }
    // "was used to it" (accustomed) against "was used to make" (employed)
    if is(a.prev(), BE) || is(a.prev(), &["get", "gets", "got", "getting", "become", "became", "grown", "grow", "grew"]) {
        let n2 = a.raw(k + 1);
        return is(n2, OBJ_START) || poss(n2) || n2.map_or(false, |w| w.ends_with("ing")) || is(n2, &["such", "that", "hard", "rough"]);
    }
    true
}

fn house_verb(a: &At) -> bool {
    is(a.prev(), VB) && (is(a.next(), OBJ_START) || is(a.next(), NUM) || poss(a.next()))
}

fn wind_verb(a: &At) -> bool {
    if a.nominal() || a.after_prep() {
        return false;
    }
    if a.bare() {
        return true;
    }
    (a.raw(-1).is_none() || is(a.raw(-1), &["and", "or", "then"]) || is(a.prev(), SUBJ))
        && (is(a.next(), OBJ_START) || is(a.next(), &["up", "down", "round", "around", "back"]))
}

fn winds_verb(a: &At) -> bool {
    if a.nominal() || a.after_prep() {
        return false;
    }
    is(a.prev(), SUBJ3)
        || is(a.next(), &[
            "its", "their", "his", "her", "along", "up", "round", "around", "through", "about", "away", "down",
            "past", "back", "out", "among", "between", "slowly", "gently", "a",
        ])
}

fn wound_up(a: &At) -> bool {
    if a.nominal() || a.raw(-1) == Some("to") {
        return false;
    }
    // "wound it in", "wound through", "had wound"; "I wound and I heal" injures
    is(a.next(), &["up", "round", "around", "itself", "himself", "herself", "themselves"])
        || (!a.after_prep() && (is(a.next(), OBJ_START) || is(a.next(), &["about", "through", "along", "among", "down", "from", "in"])))
        || is(a.prev(), BE)
        || is(a.prev(), HAVE)
}

fn tear_cry(a: &At) -> bool {
    if is(a.raw(-1), &["a", "the"])
        && a.next() == Some("in")
        && !a.ahead(6, &["eye", "eyes", "voice"])
        && !a.near(3, &["shed", "sheds", "shedding", "wiped", "dropped"])
    {
        return false;
    }
    a.nominal()
        || is(a.next(), &[
            "drop", "drops", "fell", "rolled", "trickled", "ran", "stole", "started", "stood", "glistened",
            "gathered", "dimmed", "stained", "falls", "rolls", "trickles", "gas", "duct", "ducts", "jerker",
            "jerkers", "streaked",
        ])
}

fn tears_rip(a: &At) -> bool {
    if is(a.prev(), &["he", "she", "it", "who", "one"]) {
        return true;
    }
    !a.nominal()
        && !a.after_prep()
        && !is(a.raw(-1), &["and", "or", "in", "into"])
        && is(a.next(), &["up", "off", "open", "apart", "away", "out", "at"])
}

const METALS: &[&str] = &[
    "copper", "tin", "iron", "zinc", "silver", "gold", "brass", "steel", "antimony", "mercury", "bismuth",
    "nickel", "sulphur", "sulfur", "arsenic", "pewter", "solder",
];

fn lead_metal(a: &At) -> bool {
    is(a.raw(-1), &["of", "like", "red", "white", "black", "sheet", "molten", "melted", "cast", "pig", "solid", "blue"])
        || is(a.next(), &[
            "pencil", "pencils", "pipe", "pipes", "poisoning", "mine", "mines", "ore", "shot", "weight",
            "weights", "soldier", "soldiers", "colored", "coloured", "roof", "roofs", "foil", "paint",
            "sinker", "sinkers", "bullet", "bullets", "piping", "lined", "coffin", "plummet", "seal",
            "levels", "level", "exposure", "contamination", "dust", "glass", "crystal", "oxide", "acetate",
            "nitrate", "carbonate", "free", "based", "apron", "balloon", "sheets", "sheeting", "flashing",
        ])
        || is(a.raw(-1), &["pencil", "contains", "contain", "contained", "containing", "toxic", "unleaded"])
        || (a.raw(-1) == Some("to") && is(a.raw(-2), &["exposure", "exposed", "exposing"]))
        || (a.raw(-1) == Some("for") && a.near(4, &["test", "tests", "tested", "testing", "screened", "screening"]))
        || (a.raw(-1) == Some("found") && a.next() == Some("in"))
        || a.near(3, METALS)
        || a.ahead(3, METALS)
        || (a.raw(-1) == Some("to") && is(a.raw(-2), &["turned", "turn", "turns", "changed", "change"]))
        || (a.raw(-1) == Some("as") && a.raw(-3) == Some("as"))
}

fn bow_ribbon(a: &At) -> bool {
    if a.bare() || is(a.prev(), SUBJ3) {
        return false;
    }
    (a.next() == Some("and") && is(a.raw(2), &["arrow", "arrows", "quiver", "spear", "spears"]))
        || is(a.next(), &["string", "strings", "strung", "shot", "shots", "legged", "tie", "ties", "window", "windows", "saw"])
        || is(a.raw(-1), &["cross", "fiddle", "violin", "rain", "long", "iron", "steel", "mighty", "hunting"])
        || a.near(3, &["drew", "draw", "draws", "drawing", "drawn", "strung", "like"])
        || a.near(5, &["tied", "tie", "tying", "wrapped", "wrap", "topped"])
        // "put a bow on it"
        || (is(a.raw(-1), &["a", "the"]) && is(a.raw(-2), &["put", "puts", "putting", "add", "adds", "added"]))
        || a.near(6, WEAPONS)
        || a.ahead(3, WEAPONS)
        || a.ahead(3, &["ribbon", "ribbons", "silk", "satin", "velvet", "lace", "flowers"])
}

const WEAPONS: &[&str] = &[
    "shoot", "shot", "arrow", "arrows", "quiver", "archer", "archers", "bowstring", "spear", "spears", "rifle",
    "sword", "lance", "ribbon", "ribbons",
];

fn dove_dived(a: &At) -> bool {
    !a.nominal()
        && is(a.next(), &[
            "into", "in", "under", "down", "overboard", "headlong", "deep", "off", "beneath", "after", "for",
            "back", "from", "below", "through", "toward", "towards",
        ])
}

fn sow_pig(a: &At) -> bool {
    a.nominal()
        && !is(a.next(), OBJ_START)
        && !is(a.next(), &["seed", "seeds", "wheat", "corn", "barley", "oats", "discord", "dissension"])
}

fn row_quarrel(a: &At) -> bool {
    if a.next() == Some("of") {
        return false;
    }
    is(a.next(), &["about", "between"])
        || (is(a.raw(-1), &["a", "the", "no", "such", "any", "your"])
            && a.next().is_none()
            && !is(a.raw(-2), &[
                "in", "into", "front", "back", "first", "second", "third", "last", "next", "one", "same",
                "delete", "deletes", "deleted", "add", "adds", "added", "insert", "inserted", "select",
                "selected", "remove", "removed", "highlight", "highlighted", "edit", "copy", "copied",
                "hide", "freeze", "drag", "click", "sort", "each", "every", "per",
            ]))
        || is(a.next(), &["broke", "erupted", "ensued", "blew", "flared"])
        // "a huge row over the will"
        || (a.next() == Some("over") && (is(a.raw(-1), DET) || is(a.raw(-2), DET)) && !a.ahead(3, &["lake", "river", "bay", "water", "sea"]))
        || a.near(3, &["make", "makes", "made", "making", "kick", "kicked", "kicking", "raise", "raised", "raising", "what's", "been"])
}

fn bass_fish(a: &At) -> bool {
    let fish = &[
        "fishing", "fished", "caught", "catch", "fish", "fisherman", "angler", "trout", "pike", "perch",
        "rod", "lure", "bait", "pickerel", "water",
    ];
    is(a.raw(-1), &["sea", "striped", "largemouth", "smallmouth", "rock"])
        || is(a.next(), &["fishing", "fish", "boat", "lake", "river", "pond"])
        || a.near(4, fish)
        || a.ahead(4, fish)
}

fn does_deer(a: &At) -> bool {
    is(a.raw(-1), &["the", "these", "those", "two", "three", "four", "five", "several", "many", "young", "wild"])
        || (is(a.raw(-1), &["and", "or"]) && is(a.raw(-2), &["bucks", "stags", "harts", "deer", "fawns"]))
}

fn minute_tiny(a: &At) -> bool {
    is(a.raw(-1), &["most", "more", "extremely", "exceedingly", "infinitely", "too"])
        || (!is(a.raw(-1), &["last", "every", "each", "per", "one", "any", "same", "this", "that"])
            && !is(a.raw(-1), NUM)
            && is(a.next(), &[
                "amounts", "amount", "traces", "trace", "changes", "variations", "variation", "fraction",
                "fractions", "adjustments", "adjustment", "doses", "dose",
            ]))
        || is(a.next(), &[
            "particles", "particle", "details", "detail", "examination", "examinations", "investigation",
            "investigations", "inspection", "inspections", "quantities", "quantity", "fragments", "fragment",
            "organisms", "observation", "observations", "description", "descriptions", "differences",
            "difference", "accuracy", "precision", "scrutiny", "portions", "portion", "grains", "grain",
            "drops", "points", "account", "study", "analysis",
        ])
}

fn present_verb(a: &At) -> bool {
    if a.nominal() || is(a.raw(-1), &["at", "for", "till", "until", "up", "the"]) {
        return false;
    }
    // "symptoms present as a rash", "patients present with fever"
    if a.prev().map_or(false, plural) && is(a.next(), &["as", "with"]) {
        return true;
    }
    a.bare() || is(a.prev(), SUBJ_PL) || (!a.after_prep() && (is(a.next(), OBJ) || is(a.next(), &["a", "an", "my", "his", "her", "their", "your", "our", "its"]) || poss(a.next())))
}

fn presents_verb(a: &At) -> bool {
    if a.this_s() || is(a.next(), &["itself", "himself", "herself", "themselves"]) {
        return true;
    }
    if a.nominal() || a.after_prep() {
        return false;
    }
    is(a.prev(), SUBJ3) || is(a.next(), &["itself", "himself", "herself", "themselves", "a", "an", "no", "such"]) || a.det_subject()
}

fn subject_verb(a: &At) -> bool {
    a.bare() && (is(a.next(), OBJ_START) || poss(a.next()))
}

fn subjects_verb(a: &At) -> bool {
    is(a.prev(), SUBJ3) && (is(a.next(), OBJ_START) || poss(a.next()))
}

fn object_verb(a: &At) -> bool {
    if a.nominal() || a.after_prep() {
        return false;
    }
    a.bare() || is(a.prev(), SUBJ_PL) || is(a.prev(), &["why"]) || a.next() == Some("to")
}

fn objects_verb(a: &At) -> bool {
    !a.nominal() && is(a.prev(), &["he", "she", "it", "who", "one", "nobody", "everybody", "everyone", "anyone", "someone", "somebody"])
}

/// What content is made, kept or done with: "content creators", "streaming content".
const CONTENT_NEXT: &[&str] = &[
    "creator", "creators", "creation", "moderation", "moderator", "moderators", "marketing", "management",
    "strategy", "type", "types", "warning", "warnings", "filter", "filters", "filtering", "policy",
    "policies", "delivery", "provider", "providers", "library", "feed", "team", "writer", "writers",
    "length", "id", "rating", "ratings", "farm", "farms", "network", "platform", "platforms", "security",
];
const CONTENT_PREV: &[&str] = &[
    "streaming", "digital", "online", "video", "web", "user", "original", "premium", "sponsored",
    "generated", "branded", "harmful", "explicit", "adult", "media", "social", "written", "audio",
    "exclusive", "more", "much", "paid", "free", "viral", "educational", "local", "news", "page",
    "site", "website", "app", "ai",
];

fn content_noun(a: &At) -> bool {
    // "to his heart's content" keeps the adjective's sound
    if a.raw(-1) == Some("heart's") {
        return false;
    }
    a.nominal() || a.next() == Some("of") || is(a.next(), CONTENT_NEXT) || is(a.raw(-1), CONTENT_PREV)
}

/// Readers say "ad-DRESS" for the noun as for the verb, but for the machine's addresses.
fn address_verb(a: &At) -> bool {
    !is(a.raw(-1), &[
        "email", "mail", "ip", "web", "mac", "memory", "internet", "url", "server", "network", "return",
        "forwarding", "mailing", "postal", "shipping", "billing", "delivery", "wallet", "home", "street",
        "physical", "bitcoin", "crypto", "residential", "permanent",
    ])
}

fn refuse_noun(a: &At) -> bool {
    if is(a.raw(-1), &["garden", "household", "kitchen", "food", "industrial", "domestic", "municipal", "city"]) {
        return true;
    }
    (a.nominal() || a.raw(-1) == Some("of")) && !is(a.next(), OBJ_START) && a.next() != Some("to")
}

fn produce_noun(a: &At) -> bool {
    a.nominal()
        || is(a.raw(-1), &[
            "fresh", "farm", "garden", "local", "raw", "agricultural", "annual", "total", "of", "organic",
            "seasonal", "frozen", "imported",
        ])
}

/// What is invalid, not valid: "an invalid password".
const NOT_VALID: &[&str] = &[
    "password", "passwords", "argument", "arguments", "ticket", "tickets", "input", "data", "request",
    "requests", "file", "address", "format", "value", "values", "entry", "entries", "option", "syntax",
    "token", "key", "number", "will", "contract", "contracts", "marriage", "claim", "claims", "inference",
    "signature", "certificate", "license", "licence", "passport", "vote", "votes", "ballot", "ballots",
    "response", "command", "email", "username", "reasoning", "proof", "result", "results",
];

fn invalid_adj(a: &At) -> bool {
    is(a.next(), NOT_VALID)
        || (!a.nominal()
            && is(a.prev(), &["be", "is", "are", "was", "were", "been", "become", "became", "rendered", "render", "declared", "deemed"]))
}

/// Before an -ed adjective: "the learned professor", "so learned a man".
const ED_ADJ: &[&str] = &[
    "most", "more", "so", "very", "as", "less", "least", "too", "truly", "deeply", "highly", "profoundly",
    "really", "how",
];

fn learned_adj(a: &At) -> bool {
    let p = a.raw(-1);
    is(p, DET) || poss(p) || is(p, NUM) || is(p, ED_ADJ)
}

fn blessed_adj(a: &At) -> bool {
    let p = a.raw(-1);
    is(p, DET) || poss(p) || is(p, NUM) || is(p, &["most", "more", "so", "thrice", "o", "oh", "how", "ever"])
        || ((p.is_none() || is(p, &["and", "but"])) && is(a.next(), &["is", "are", "be", "art", "was", "were"]))
}

fn beloved_verb(a: &At) -> bool {
    a.next() == Some("by") || is(a.raw(-1), BE) || is(a.raw(-1), &["much", "well", "greatly", "universally", "generally", "deeply"])
}

fn aged_adj(a: &At) -> bool {
    let p = a.raw(-1);
    (is(p, DET) || poss(p) || is(p, &["very", "most", "more", "so"]))
        && !is(a.next(), NUM)
        && !is(a.next(), &["about", "between", "from", "nearly", "over", "under", "upwards", "some"])
}

fn dogged_adj(a: &At) -> bool {
    let p = a.raw(-1);
    is(p, DET) || poss(p) || is(p, &["most", "more", "so", "very", "with"])
}
