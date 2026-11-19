// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Text to tokens (engine/testdata/front.tsv holds its cases).
//!
//! A word comes out lowercase, in capitals as written (FBI, NASA), or spelled letter by letter
//! (_U_S, _A_M, _F). Numbers are written out (money, units, dates, times, fractions, ranges, phone
//! numbers, versions, Roman numerals after names), abbreviations expanded, web addresses said,
//! accents dropped; what it cannot read is an error.

use crate::g2p::{G2p, PHONES};
use crate::hetero;
use crate::lexicon::Lexicon;
use crate::weights::{err, Error, Result};
use std::collections::HashMap;

pub const STOPS: [&str; 6] = [",", ".", "?", "!", ";", ":"];
pub const PAD: usize = 0;
pub const BOS: usize = 1;
pub const EOS: usize = 2;
pub const SPACE: usize = 3;

/// Token id of a stop or a phone.
pub fn symbol_id(s: &str) -> Option<usize> {
    if let Some(i) = STOPS.iter().position(|x| *x == s) {
        return Some(4 + i);
    }
    PHONES.iter().position(|x| *x == s).map(|i| 4 + STOPS.len() + i)
}

/// Symbol of a token id.
pub fn symbol(id: usize) -> &'static str {
    match id {
        PAD => "<pad>",
        BOS => "^",
        EOS => "$",
        SPACE => " ",
        i if i < 4 + STOPS.len() => STOPS[i - 4],
        i => PHONES[i - 4 - STOPS.len()],
    }
}

/// Typography to ASCII; letters with diacritics to their base (U+00C0 to U+024F, by NFKD).
const CHARS: [(char, &str); 262] = [
    ('\u{00a0}', " "), ('\u{00ab}', "\""), ('\u{00bb}', "\""), ('\u{00c0}', "A"), ('\u{00c1}', "A"), ('\u{00c2}', "A"),
    ('\u{00c3}', "A"), ('\u{00c4}', "A"), ('\u{00c5}', "A"), ('\u{00c6}', "AE"), ('\u{00c7}', "C"), ('\u{00c8}', "E"),
    ('\u{00c9}', "E"), ('\u{00ca}', "E"), ('\u{00cb}', "E"), ('\u{00cc}', "I"), ('\u{00cd}', "I"), ('\u{00ce}', "I"),
    ('\u{00cf}', "I"), ('\u{00d1}', "N"), ('\u{00d2}', "O"), ('\u{00d3}', "O"), ('\u{00d4}', "O"), ('\u{00d5}', "O"),
    ('\u{00d6}', "O"), ('\u{00d8}', "O"), ('\u{00d9}', "U"), ('\u{00da}', "U"), ('\u{00db}', "U"), ('\u{00dc}', "U"),
    ('\u{00dd}', "Y"), ('\u{00df}', "ss"), ('\u{00e0}', "a"), ('\u{00e1}', "a"), ('\u{00e2}', "a"), ('\u{00e3}', "a"),
    ('\u{00e4}', "a"), ('\u{00e5}', "a"), ('\u{00e6}', "ae"), ('\u{00e7}', "c"), ('\u{00e8}', "e"), ('\u{00e9}', "e"),
    ('\u{00ea}', "e"), ('\u{00eb}', "e"), ('\u{00ec}', "i"), ('\u{00ed}', "i"), ('\u{00ee}', "i"), ('\u{00ef}', "i"),
    ('\u{00f1}', "n"), ('\u{00f2}', "o"), ('\u{00f3}', "o"), ('\u{00f4}', "o"), ('\u{00f5}', "o"), ('\u{00f6}', "o"),
    ('\u{00f8}', "o"), ('\u{00f9}', "u"), ('\u{00fa}', "u"), ('\u{00fb}', "u"), ('\u{00fc}', "u"), ('\u{00fd}', "y"),
    ('\u{00ff}', "y"), ('\u{0100}', "A"), ('\u{0101}', "a"), ('\u{0102}', "A"), ('\u{0103}', "a"), ('\u{0104}', "A"),
    ('\u{0105}', "a"), ('\u{0106}', "C"), ('\u{0107}', "c"), ('\u{0108}', "C"), ('\u{0109}', "c"), ('\u{010a}', "C"),
    ('\u{010b}', "c"), ('\u{010c}', "C"), ('\u{010d}', "c"), ('\u{010e}', "D"), ('\u{010f}', "d"), ('\u{0112}', "E"),
    ('\u{0113}', "e"), ('\u{0114}', "E"), ('\u{0115}', "e"), ('\u{0116}', "E"), ('\u{0117}', "e"), ('\u{0118}', "E"),
    ('\u{0119}', "e"), ('\u{011a}', "E"), ('\u{011b}', "e"), ('\u{011c}', "G"), ('\u{011d}', "g"), ('\u{011e}', "G"),
    ('\u{011f}', "g"), ('\u{0120}', "G"), ('\u{0121}', "g"), ('\u{0122}', "G"), ('\u{0123}', "g"), ('\u{0124}', "H"),
    ('\u{0125}', "h"), ('\u{0128}', "I"), ('\u{0129}', "i"), ('\u{012a}', "I"), ('\u{012b}', "i"), ('\u{012c}', "I"),
    ('\u{012d}', "i"), ('\u{012e}', "I"), ('\u{012f}', "i"), ('\u{0130}', "I"), ('\u{0134}', "J"), ('\u{0135}', "j"),
    ('\u{0136}', "K"), ('\u{0137}', "k"), ('\u{0139}', "L"), ('\u{013a}', "l"), ('\u{013b}', "L"), ('\u{013c}', "l"),
    ('\u{013d}', "L"), ('\u{013e}', "l"), ('\u{0143}', "N"), ('\u{0144}', "n"), ('\u{0145}', "N"), ('\u{0146}', "n"),
    ('\u{0147}', "N"), ('\u{0148}', "n"), ('\u{014c}', "O"), ('\u{014d}', "o"), ('\u{014e}', "O"), ('\u{014f}', "o"),
    ('\u{0150}', "O"), ('\u{0151}', "o"), ('\u{0152}', "OE"), ('\u{0153}', "oe"), ('\u{0154}', "R"), ('\u{0155}', "r"),
    ('\u{0156}', "R"), ('\u{0157}', "r"), ('\u{0158}', "R"), ('\u{0159}', "r"), ('\u{015a}', "S"), ('\u{015b}', "s"),
    ('\u{015c}', "S"), ('\u{015d}', "s"), ('\u{015e}', "S"), ('\u{015f}', "s"), ('\u{0160}', "S"), ('\u{0161}', "s"),
    ('\u{0162}', "T"), ('\u{0163}', "t"), ('\u{0164}', "T"), ('\u{0165}', "t"), ('\u{0168}', "U"), ('\u{0169}', "u"),
    ('\u{016a}', "U"), ('\u{016b}', "u"), ('\u{016c}', "U"), ('\u{016d}', "u"), ('\u{016e}', "U"), ('\u{016f}', "u"),
    ('\u{0170}', "U"), ('\u{0171}', "u"), ('\u{0172}', "U"), ('\u{0173}', "u"), ('\u{0174}', "W"), ('\u{0175}', "w"),
    ('\u{0176}', "Y"), ('\u{0177}', "y"), ('\u{0178}', "Y"), ('\u{0179}', "Z"), ('\u{017a}', "z"), ('\u{017b}', "Z"),
    ('\u{017c}', "z"), ('\u{017d}', "Z"), ('\u{017e}', "z"), ('\u{017f}', "s"), ('\u{01a0}', "O"), ('\u{01a1}', "o"),
    ('\u{01af}', "U"), ('\u{01b0}', "u"), ('\u{01cd}', "A"), ('\u{01ce}', "a"), ('\u{01cf}', "I"), ('\u{01d0}', "i"),
    ('\u{01d1}', "O"), ('\u{01d2}', "o"), ('\u{01d3}', "U"), ('\u{01d4}', "u"), ('\u{01d5}', "U"), ('\u{01d6}', "u"),
    ('\u{01d7}', "U"), ('\u{01d8}', "u"), ('\u{01d9}', "U"), ('\u{01da}', "u"), ('\u{01db}', "U"), ('\u{01dc}', "u"),
    ('\u{01de}', "A"), ('\u{01df}', "a"), ('\u{01e0}', "A"), ('\u{01e1}', "a"), ('\u{01e6}', "G"), ('\u{01e7}', "g"),
    ('\u{01e8}', "K"), ('\u{01e9}', "k"), ('\u{01ea}', "O"), ('\u{01eb}', "o"), ('\u{01ec}', "O"), ('\u{01ed}', "o"),
    ('\u{01f0}', "j"), ('\u{01f4}', "G"), ('\u{01f5}', "g"), ('\u{01f8}', "N"), ('\u{01f9}', "n"), ('\u{01fa}', "A"),
    ('\u{01fb}', "a"), ('\u{0200}', "A"), ('\u{0201}', "a"), ('\u{0202}', "A"), ('\u{0203}', "a"), ('\u{0204}', "E"),
    ('\u{0205}', "e"), ('\u{0206}', "E"), ('\u{0207}', "e"), ('\u{0208}', "I"), ('\u{0209}', "i"), ('\u{020a}', "I"),
    ('\u{020b}', "i"), ('\u{020c}', "O"), ('\u{020d}', "o"), ('\u{020e}', "O"), ('\u{020f}', "o"), ('\u{0210}', "R"),
    ('\u{0211}', "r"), ('\u{0212}', "R"), ('\u{0213}', "r"), ('\u{0214}', "U"), ('\u{0215}', "u"), ('\u{0216}', "U"),
    ('\u{0217}', "u"), ('\u{0218}', "S"), ('\u{0219}', "s"), ('\u{021a}', "T"), ('\u{021b}', "t"), ('\u{021e}', "H"),
    ('\u{021f}', "h"), ('\u{0226}', "A"), ('\u{0227}', "a"), ('\u{0228}', "E"), ('\u{0229}', "e"), ('\u{022a}', "O"),
    ('\u{022b}', "o"), ('\u{022c}', "O"), ('\u{022d}', "o"), ('\u{022e}', "O"), ('\u{022f}', "o"), ('\u{0230}', "O"),
    ('\u{0231}', "o"), ('\u{0232}', "Y"), ('\u{0233}', "y"), ('\u{02bc}', "'"), ('\u{2013}', "--"), ('\u{2014}', "--"),
    ('\u{2018}', "'"), ('\u{2019}', "'"), ('\u{201c}', "\""), ('\u{201d}', "\""),];

/// Typography CHARS lacks: an ellipsis, dashes, spaces and arrows to ASCII, vulgar fractions to digits,
/// bullets and bars to a comma, math signs to words; marks not said (soft hyphen, zero width, joiners,
/// emoji selectors, footnote daggers, trade marks) to nothing.
const TYPO: &[(char, &str)] = &[
    ('\u{2026}', "..."), ('\u{2010}', "-"), ('\u{2011}', "-"), ('\u{2012}', "-"), ('\u{2212}', "-"),
    ('\u{2015}', "--"), ('\u{2e3a}', "--"), ('\u{2e3b}', "--"),
    ('\u{2000}', " "), ('\u{2001}', " "), ('\u{2002}', " "), ('\u{2003}', " "), ('\u{2004}', " "), ('\u{2005}', " "),
    ('\u{2006}', " "), ('\u{2007}', " "), ('\u{2008}', " "), ('\u{2009}', " "), ('\u{200a}', " "), ('\u{202f}', " "),
    ('\u{205f}', " "), ('\u{3000}', " "), ('\u{2028}', " "), ('\u{2029}', " "),
    ('\u{00ad}', ""), ('\u{200b}', ""), ('\u{200c}', ""), ('\u{200d}', ""), ('\u{2060}', ""), ('\u{feff}', ""),
    ('\u{fe0e}', ""), ('\u{fe0f}', ""), ('\u{20e3}', ""), ('\u{2122}', ""), ('\u{00ae}', ""), ('\u{2020}', ""),
    ('\u{2021}', ""), ('\u{00b6}', ""),
    ('\u{00a9}', " copyright "), ('\u{00a7}', " section "), ('\u{00b1}', " plus or minus "), ('\u{00d7}', "x"),
    ('\u{00f7}', " divided by "), ('\u{2248}', " approximately "), ('\u{2264}', " <= "), ('\u{2265}', " >= "),
    ('\u{2260}', " != "), ('\u{221e}', " infinity "), ('\u{221a}', " square root of "), ('\u{2206}', " delta "),
    ('\u{2116}', " number "), ('\u{2103}', "\u{00b0}C"), ('\u{2109}', "\u{00b0}F"), ('\u{2044}', "/"),
    ('\u{00bd}', " 1/2"), ('\u{00bc}', " 1/4"), ('\u{00be}', " 3/4"), ('\u{2153}', " 1/3"), ('\u{2154}', " 2/3"),
    ('\u{2155}', " 1/5"), ('\u{2156}', " 2/5"), ('\u{2157}', " 3/5"), ('\u{2158}', " 4/5"), ('\u{2159}', " 1/6"),
    ('\u{215a}', " 5/6"), ('\u{215b}', " 1/8"), ('\u{215c}', " 3/8"), ('\u{215d}', " 5/8"), ('\u{215e}', " 7/8"),
    ('\u{201a}', "'"), ('\u{201b}', "'"), ('\u{201e}', "\""), ('\u{201f}', "\""), ('\u{2039}', "\""), ('\u{203a}', "\""),
    ('\u{2032}', "'"), ('\u{2033}', "\""),
    ('\u{2022}', " , "), ('\u{2023}', " , "), ('\u{2043}', " , "), ('\u{2219}', " , "), ('\u{00b7}', " , "), ('\u{25e6}', " , "),
    ('\u{2192}', " -> "), ('\u{21d2}', " -> "), ('\u{27f6}', " -> "), ('\u{27f9}', " -> "), ('\u{2794}', " -> "),
    ('\u{279c}', " -> "), ('\u{27a1}', " -> "),
];
/// Greek letters by name; mu and omega are kept as signs (MICRO, OHM) for the units they go with.
const GREEK: &[(char, &str)] = &[
    ('\u{03b1}', "alpha"), ('\u{03b2}', "beta"), ('\u{03b3}', "gamma"), ('\u{03b4}', "delta"), ('\u{03b5}', "epsilon"),
    ('\u{03b6}', "zeta"), ('\u{03b7}', "eta"), ('\u{03b8}', "theta"), ('\u{03b9}', "iota"), ('\u{03ba}', "kappa"),
    ('\u{03bb}', "lambda"), ('\u{03bd}', "nu"), ('\u{03be}', "xi"), ('\u{03bf}', "omicron"), ('\u{03c0}', "pi"),
    ('\u{03c1}', "rho"), ('\u{03c2}', "sigma"), ('\u{03c3}', "sigma"), ('\u{03c4}', "tau"), ('\u{03c5}', "upsilon"),
    ('\u{03c6}', "phi"), ('\u{03c7}', "chi"), ('\u{03c8}', "psi"), ('\u{03c9}', "omega"),
    ('\u{0391}', "alpha"), ('\u{0392}', "beta"), ('\u{0393}', "gamma"), ('\u{0394}', "delta"), ('\u{0395}', "epsilon"),
    ('\u{0396}', "zeta"), ('\u{0397}', "eta"), ('\u{0398}', "theta"), ('\u{0399}', "iota"), ('\u{039a}', "kappa"),
    ('\u{039b}', "lambda"), ('\u{039c}', "mu"), ('\u{039d}', "nu"), ('\u{039e}', "xi"), ('\u{039f}', "omicron"),
    ('\u{03a0}', "pi"), ('\u{03a1}', "rho"), ('\u{03a3}', "sigma"), ('\u{03a4}', "tau"), ('\u{03a5}', "upsilon"),
    ('\u{03a6}', "phi"), ('\u{03a7}', "chi"), ('\u{03a8}', "psi"),
];
const MICRO: char = '\u{00b5}';
const OHM: char = '\u{03a9}';
/// Superscript digits and minus, as ASCII.
const SUPERSCRIPTS: [(char, char); 11] = [
    ('\u{2070}', '0'), ('\u{00b9}', '1'), ('\u{00b2}', '2'), ('\u{00b3}', '3'), ('\u{2074}', '4'), ('\u{2075}', '5'),
    ('\u{2076}', '6'), ('\u{2077}', '7'), ('\u{2078}', '8'), ('\u{2079}', '9'), ('\u{207b}', '-'),
];
/// Signs kept as they are, for the numbers they go with.
const SIGNS: [char; 15] = [
    '\u{00b0}', '\u{20ac}', '\u{00a3}', '\u{00a5}', '\u{00a2}', '\u{20b9}', '\u{20a9}', '\u{20bd}', '\u{20bf}', '\u{20aa}',
    '\u{20ba}', '\u{20b1}', '\u{20a6}', MICRO, OHM,
];
/// Emoji, pictographs, dingbats, arrows, shapes and the tags of flags: not said.
fn pictograph(c: char) -> bool {
    matches!(c as u32, 0x1f000..=0x1faff | 0x2600..=0x27bf | 0x2b00..=0x2bff | 0x2190..=0x21ff | 0x2300..=0x23ff
        | 0x25a0..=0x25ff | 0xe0020..=0xe007f)
}

const TITLES: [(&str, &str); 21] = [
    ("Mr", "mister"), ("Mrs", "missus"), ("Ms", "ms"), ("Dr", "doctor"), ("Drs", "doctors"), ("Rev", "reverend"),
    ("Maj", "major"), ("Gen", "general"), ("Col", "colonel"), ("Capt", "captain"), ("Lt", "lieutenant"),
    ("Sgt", "sergeant"), ("Gov", "governor"), ("Messrs", "messieurs"), ("Hon", "honorable"), ("Prof", "professor"),
    ("Mt", "mount"), ("Ft", "fort"), ("Sen", "senator"), ("Rep", "representative"), ("Pres", "president"),
];
/// Abbreviations that end a sentence only at the end of the text.
const MIDS: [(&str, &str); 13] = [
    ("vs", "versus"), ("approx", "approximately"), ("Approx", "approximately"), ("Incl", "including"), ("incl", "including"), ("esp", "especially"), ("Fig", "figure"),
    ("fig", "figure"), ("Vol", "volume"), ("vol", "volume"), ("pp", "pages"), ("cf", "compare"), ("viz", "namely"),
];
const SUFFIXES: [(&str, &str); 19] = [
    ("Jr", "junior"), ("Sr", "senior"), ("Co", "company"), ("Inc", "incorporated"), ("Ltd", "limited"),
    ("etc", "et cetera"), ("Ave", "avenue"), ("Rd", "road"), ("Blvd", "boulevard"), ("Ln", "lane"),
    ("Hwy", "highway"), ("Pkwy", "parkway"), ("Apt", "apartment"), ("Dept", "department"), ("Corp", "corporation"),
    ("Bros", "brothers"), ("Univ", "university"), ("Bldg", "building"), ("al", "al"),
];
/// Abbreviations read only before a number: Fl. 3, p. 42, c. 1500, b. 1950.
const NUMBERED: [(&str, &str); 21] = [
    ("Fl", "floor"), ("Ste", "suite"), ("Ext", "extension"), ("ext", "extension"), ("Rm", "room"), ("Ch", "chapter"),
    ("ch", "chapter"), ("Sec", "section"), ("Ep", "episode"), ("p", "page"), ("est", "established"),
    ("Est", "established"), ("ca", "circa"), ("c", "circa"), ("b", "born"), ("d", "died"), ("Nos", "numbers"),
    ("Op", "opus"), ("op", "opus"), ("Ref", "reference"), ("ref", "reference"),
];
/// A month's, only before a number.
const MONTHS: [(&str, &str); 12] = [
    ("Jan", "january"), ("Feb", "february"), ("Mar", "march"), ("Apr", "april"), ("Jun", "june"), ("Jul", "july"),
    ("Aug", "august"), ("Sep", "september"), ("Sept", "september"), ("Oct", "october"), ("Nov", "november"),
    ("Dec", "december"),
];
const MONTH_NAMES: [&str; 12] = [
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november",
    "december",
];
/// A day's; Wed, Sat and Sun, words too, only before a comma, a number or a month.
const DAYS: [(&str, &str); 10] = [
    ("Mon", "monday"), ("Tue", "tuesday"), ("Tues", "tuesday"), ("Wed", "wednesday"), ("Thu", "thursday"),
    ("Thur", "thursday"), ("Thurs", "thursday"), ("Fri", "friday"), ("Sat", "saturday"), ("Sun", "sunday"),
];
const DAY_NAMES: [&str; 7] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/// Units after a number: said of one, said of more. JOINED ones only written against it (5W, 6').
const UNITS: &[(&str, &str, &str)] = &[
    ("km", "kilometer", "kilometers"), ("cm", "centimeter", "centimeters"), ("mm", "millimeter", "millimeters"),
    ("m", "meter", "meters"), ("kg", "kilogram", "kilograms"), ("g", "gram", "grams"), ("mg", "milligram", "milligrams"),
    ("lb", "pound", "pounds"), ("lbs", "pound", "pounds"), ("oz", "ounce", "ounces"), ("ft", "foot", "feet"),
    ("yd", "yard", "yards"), ("yds", "yard", "yards"), ("mi", "mile", "miles"), ("mph", "mile per hour", "miles per hour"),
    ("kph", "kilometer per hour", "kilometers per hour"), ("km/h", "kilometer per hour", "kilometers per hour"),
    ("ms", "millisecond", "milliseconds"), ("s", "second", "seconds"), ("sec", "second", "seconds"),
    ("secs", "second", "seconds"), ("min", "minute", "minutes"), ("mins", "minute", "minutes"), ("h", "hour", "hours"),
    ("hr", "hour", "hours"), ("hrs", "hour", "hours"), ("yr", "year", "years"), ("yrs", "year", "years"),
    ("ml", "milliliter", "milliliters"), ("mL", "milliliter", "milliliters"), ("L", "liter", "liters"),
    ("tsp", "teaspoon", "teaspoons"), ("tbsp", "tablespoon", "tablespoons"), ("KB", "kilobyte", "kilobytes"),
    ("kB", "kilobyte", "kilobytes"), ("MB", "megabyte", "megabytes"), ("GB", "gigabyte", "gigabytes"),
    ("TB", "terabyte", "terabytes"), ("Hz", "hertz", "hertz"), ("kHz", "kilohertz", "kilohertz"),
    ("MHz", "megahertz", "megahertz"), ("GHz", "gigahertz", "gigahertz"), ("kW", "kilowatt", "kilowatts"),
    ("kWh", "kilowatt hour", "kilowatt hours"), ("mAh", "milliamp hour", "milliamp hours"), ("px", "pixel", "pixels"),
    ("fps", "frame per second", "frames per second"), ("nm", "nanometer", "nanometers"),
    ("ns", "nanosecond", "nanoseconds"), ("\u{00b5}m", "micrometer", "micrometers"),
    ("\u{00b5}s", "microsecond", "microseconds"), ("\u{00b5}g", "microgram", "micrograms"),
    ("\u{00b5}L", "microliter", "microliters"), ("\u{00b5}l", "microliter", "microliters"),
    ("mcg", "microgram", "micrograms"), ("\u{03a9}", "ohm", "ohms"), ("k\u{03a9}", "kilo ohm", "kilo ohms"),
    ("M\u{03a9}", "mega ohm", "mega ohms"), ("kbps", "kilobit per second", "kilobits per second"),
    ("Mbps", "megabit per second", "megabits per second"), ("Gbps", "gigabit per second", "gigabits per second"),
    ("kcal", "kilocalorie", "kilocalories"), ("mmHg", "millimeter of mercury", "millimeters of mercury"),
    ("dB", "decibel", "decibels"), ("gal", "gallon", "gallons"), ("qt", "quart", "quarts"), ("mo", "month", "months"),
    ("wk", "week", "weeks"), ("wks", "week", "weeks"), ("bpm", "beat per minute", "beats per minute"),
    ("Tbsp", "tablespoon", "tablespoons"), ("Tbs", "tablespoon", "tablespoons"), ("tbs", "tablespoon", "tablespoons"),
    ("mpg", "mile per gallon", "miles per gallon"), ("mos", "month", "months"), ("kJ", "kilojoule", "kilojoules"),
    ("mol", "mole", "moles"), ("mmol", "millimole", "millimoles"), ("sqft", "square foot", "square feet"),
];
const JOINED: [(&str, &str, &str); 8] = [
    ("W", "watt", "watts"), ("V", "volt", "volts"), ("'", "foot", "feet"), ("\"", "inch", "inches"),
    ("BR", "bedroom", "bedrooms"), ("bd", "bedroom", "bedrooms"), ("BA", "bath", "baths"), ("ba", "bath", "baths"),
];

/// Money: the sign, then the unit and its hundredth, each of one and of more.
const CURRENCIES: [(char, [&str; 4]); 12] = [
    ('$', ["dollar", "dollars", "cent", "cents"]),
    ('\u{20ac}', ["euro", "euros", "cent", "cents"]),
    ('\u{00a3}', ["pound", "pounds", "penny", "pence"]),
    ('\u{00a5}', ["yen", "yen", "", ""]),
    ('\u{20b9}', ["rupee", "rupees", "paisa", "paise"]),
    ('\u{20a9}', ["won", "won", "", ""]),
    ('\u{20bd}', ["ruble", "rubles", "kopek", "kopeks"]),
    ('\u{20bf}', ["bitcoin", "bitcoin", "", ""]),
    ('\u{20aa}', ["shekel", "shekels", "agora", "agorot"]),
    ('\u{20ba}', ["lira", "lira", "", ""]),
    ('\u{20b1}', ["peso", "pesos", "centavo", "centavos"]),
    ('\u{20a6}', ["naira", "naira", "kobo", "kobo"]),
];
/// Written against an amount of money: $1.2M.
const MAGNITUDES: [(&str, &str); 12] = [
    ("k", "thousand"), ("K", "thousand"), ("m", "million"), ("M", "million"), ("mn", "million"), ("MM", "million"),
    ("b", "billion"), ("B", "billion"), ("bn", "billion"), ("BN", "billion"), ("t", "trillion"), ("T", "trillion"),
];
const MAGNITUDE_WORDS: [&str; 4] = ["thousand", "million", "billion", "trillion"];
/// Words before a year from 1001 to 1099 (in 1066), and eras after one.
const YEAR_CUES: [&str; 8] = ["in", "since", "until", "till", "by", "from", "year", "circa"];
const ERAS: [&str; 4] = ["AD", "BC", "BCE", "CE"];

/// Names a Roman numeral after reads as an ordinal (Henry VIII), and titles before a name that do
/// the same for any name (King Ramses II).
const REGNAL: [&str; 63] = [
    "Henry", "Elizabeth", "Louis", "George", "Edward", "Charles", "William", "James", "Richard", "John", "Paul",
    "Benedict", "Pius", "Leo", "Gregory", "Innocent", "Clement", "Urban", "Alexander", "Peter", "Catherine", "Mary",
    "Anne", "Victoria", "Philip", "Frederick", "Napoleon", "Ramesses", "Ramses", "Ptolemy", "Constantine", "Nicholas",
    "Ivan", "Alfonso", "Ferdinand", "Isabella", "Carlos", "Felipe", "Gustav", "Christian", "Olaf", "Olav", "Harald",
    "Haakon", "Wilhelm", "Friedrich", "Otto", "Rudolf", "Francis", "Stephen", "David", "Robert", "Edmund",
    "Harold", "Juan", "Pedro", "Sixtus", "Boniface", "Leopold", "Amenhotep", "Thutmose", "Darius", "Xerxes",
];
const ROYAL: [&str; 14] = [
    "King", "Queen", "Pope", "Emperor", "Empress", "Tsar", "Czar", "Pharaoh", "Sultan", "Prince", "Princess", "Duke",
    "Kaiser", "Saint",
];
/// Words a Roman numeral after reads as a number (World War II, Super Bowl LVII).
const DESIGNATORS: [&str; 23] = [
    "war", "bowl", "chapter", "part", "act", "volume", "book", "episode", "season", "phase", "stage", "type", "class",
    "level", "grade", "section", "article", "title", "scene", "round", "appendix", "psalm", "canto",
];
/// Top level domains read as words; others are spelled.
const TLD_WORDS: [&str; 11] = ["com", "org", "net", "gov", "co", "dev", "app", "info", "biz", "me", "ly"];
const TLD_SPELLED: [&str; 13] = ["edu", "io", "ai", "uk", "us", "ca", "de", "fr", "jp", "au", "tv", "gg", "xyz"];
/// Signs said as words between or beside others.
const SAID: [(char, &str); 7] = [
    ('&', "and"), ('+', "plus"), ('=', "equals"), ('@', "at"), ('%', "percent"), ('>', "greater than"), ('<', "less than"),
];
/// Separators in a web address or email.
const WEB_SAID: [(char, &str); 13] = [
    ('.', "dot"), ('/', "slash"), ('-', "dash"), ('_', "underscore"), ('@', "at"), (':', "colon"), ('?', "question mark"),
    ('=', "equals"), ('&', "and"), ('#', "hash"), ('~', "tilde"), ('%', "percent"), ('+', "plus"),
];

/// Comparisons and an arrow written alone.
const COMPARE: [(&str, &str); 5] = [
    (">", "greater than"), ("<", "less than"), (">=", "greater than or equal to"), ("<=", "less than or equal to"),
    ("!=", "not equal to"),
];
/// Short words in capitals said as words (I am SO tired), not spelled.
const CAPS_SAID: [&str; 26] = [
    "AN", "AS", "AT", "BE", "BY", "DO", "GO", "HE", "HI", "IF", "IN", "IS", "ME", "MY", "NO", "OF", "OH", "OK", "ON",
    "OR", "SO", "TO", "UP", "WE", "I'M", "I'D",
];
/// These only beside another word in capitals (I LOVE IT; the IT team).
const CAPS_SAID_BESIDE: [&str; 2] = ["IT", "AM"];
/// Words in capitals spelled, though the dictionary says them as words.
const CAPS_SPELLED: [&str; 4] = ["FYI", "LED", "ROI", "EST"];
/// These unless beside another word in capitals with no stop between (via UPS; UPS AND DOWNS); WHO after the.
const CAPS_SPELLED_ALONE: [&str; 3] = ["UPS", "RIP", "AKA"];
/// Words typed short, said in full, in lowercase or title case (Thx).
const SHORT: [(&str, &str); 22] = [
    ("thx", "thanks"), ("thnx", "thanks"), ("pls", "please"), ("plz", "please"), ("ppl", "people"), ("msg", "message"),
    ("msgs", "messages"), ("govt", "government"), ("mgmt", "management"), ("appt", "appointment"),
    ("appts", "appointments"), ("fwd", "forward"), ("tmrw", "tomorrow"), ("abt", "about"), ("bday", "birthday"),
    ("yoy", "year over year"), ("qoq", "quarter over quarter"), ("qty", "quantity"), ("wk", "week"), ("wks", "weeks"),
    ("mins", "minutes"), ("hrs", "hours"),
];
/// Short forms spelled, in lowercase or title case (omg, Idk).
const SHORT_SPELLED: [&str; 16] = [
    "omg", "idk", "imo", "imho", "tbh", "brb", "ttyl", "smh", "afaik", "irl", "btw", "fyi", "aka", "lmao", "ngl", "tbd",
];
/// Short forms only as written: YoY, MoM.
const SHORT_EXACT: [(&str, &str); 4] = [("YoY", "year over year"), ("QoQ", "quarter over quarter"), ("MoM", "month over month"), ("FWD", "forward")];
/// Labels before a colon: Ph: phone.
const LABELS: [(&str, &str); 5] = [("Ph", "phone"), ("Tel", "telephone"), ("Mob", "mobile"), ("Fw", "forward"), ("FW", "forward")];
/// Words written in humps said whole.
const HUMPED: [(&str, &str); 5] =
    [("SaaS", "sass"), ("PaaS", "pass"), ("PostgreSQL", "postgres _Q_L"), ("VMware", "_V_M ware"), ("PCIe", "_P_C_I_E")];
/// Kept as written: the capital tells the sense (Polish people, the city of Nice).
const CASED: [&str; 2] = ["Polish", "Nice"];
// Words that open a sentence and never name a saint or a doctor: Elm Dr. The house is blue.
const OPENERS: [&str; 36] = [
    "The", "A", "An", "This", "That", "These", "Those", "It", "Its", "He", "She", "We", "They", "You", "I", "There", "Then", "Here",
    "If", "When", "But", "And", "So", "Our", "Your", "My", "His", "Her", "Their", "Is", "Are", "Was", "Were", "Please", "Turn", "Go",
];
/// Words after a note's name that make Bb B flat.
const NOTE_NEXT: [&str; 6] = ["major", "minor", "chord", "scale", "key", "blues"];
/// Keys held before a plus: Ctrl+C.
const KEYS: [&str; 12] = ["ctrl", "cmd", "alt", "shift", "option", "opt", "fn", "win", "super", "meta", "control", "command"];
/// Words before a version read as two numbers (Python 3.12: three point twelve).
const VERSION_CUES: [&str; 22] = [
    "version", "Version", "Python", "iOS", "iPadOS", "macOS", "watchOS", "Android", "Node", "Ubuntu", "Debian", "Fedora",
    "Java", "Ruby", "PHP", "Perl", "Rust", "Swift", "Kotlin", "Firefox", "Linux", "kernel",
];
/// States not said after a town: degrees too (Jane Doe, MD), or words (Sure, OK.).
const NOT_AFTER_TOWN: [&str; 6] = ["MD", "PA", "MA", "MS", "OK", "HI"];
/// Words before a number read digit by digit (code 482915).
const CODE_CUES: [&str; 4] = ["code", "pin", "otp", "passcode"];
/// Words before a count of seconds written 30s (wait 30s; in the 30s is a decade).
const SECOND_CUES: [&str; 24] = ["to", "for", "every", "after", "wait", "waits", "waited", "take", "takes", "took", "within", "under", "than", "in", "of", "first", "last", "next", "lasts", "lasted", "another", "extra", "only", "just"];
/// States before a ZIP code (Portland, OR 97201); DC spelled.
const STATES: [(&str, &str); 52] = [
    ("AL", "alabama"), ("AK", "alaska"), ("AZ", "arizona"), ("AR", "arkansas"), ("CA", "california"),
    ("CO", "colorado"), ("CT", "connecticut"), ("DE", "delaware"), ("DC", ""), ("FL", "florida"), ("GA", "georgia"),
    ("HI", "hawaii"), ("ID", "idaho"), ("IL", "illinois"), ("IN", "indiana"), ("IA", "iowa"), ("KS", "kansas"),
    ("KY", "kentucky"), ("LA", "louisiana"), ("ME", "maine"), ("MD", "maryland"), ("MA", "massachusetts"),
    ("MI", "michigan"), ("MN", "minnesota"), ("MS", "mississippi"), ("MO", "missouri"), ("MT", "montana"),
    ("NE", "nebraska"), ("NV", "nevada"), ("NH", "new hampshire"), ("NJ", "new jersey"), ("NM", "new mexico"),
    ("NY", "new york"), ("NC", "north carolina"), ("ND", "north dakota"), ("OH", "ohio"), ("OK", "oklahoma"),
    ("OR", "oregon"), ("PA", "pennsylvania"), ("PR", "puerto rico"), ("RI", "rhode island"),
    ("SC", "south carolina"), ("SD", "south dakota"), ("TN", "tennessee"), ("TX", "texas"), ("UT", "utah"),
    ("VT", "vermont"), ("VA", "virginia"), ("WA", "washington"), ("WV", "west virginia"), ("WI", "wisconsin"),
    ("WY", "wyoming"),
];
/// Faces typed as a whole word: not said.
const EMOTICONS: [&str; 33] = [
    ":)", ":-)", ":(", ":-(", ";)", ";-)", ":D", ":-D", ":P", ":-P", ":p", ":-p", ":/", ":-/", ":O", ":-O", ":o", ":'(",
    "<3", "</3", "^_^", "^^", "-_-", "o_O", "O_o", ":|", ":-|", "XD", "xD", "=)", "=(", "T_T", ";P",
];
/// File extensions after a name and a dot: said as these words; FILE_SPELLED letter by letter (or as
/// a code, with digits).
const FILE_SAID: [(&str, &str); 13] = [
    ("json", "jason"), ("jpg", "jay peg"), ("jpeg", "jay peg"), ("gif", "gif"), ("zip", "zip"), ("docx", "doc _X"),
    ("doc", "doc"), ("wav", "wave"), ("yaml", "yaml"), ("wasm", "wasm"), ("tar", "tar"), ("toml", "tom el"),
    ("tiff", "tiff"),
];
const FILE_SPELLED: [&str; 58] = [
    "txt", "pdf", "csv", "tsv", "png", "svg", "bmp", "html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "rs",
    "md", "sh", "c", "h", "cpp", "hpp", "cs", "xml", "exe", "dll", "iso", "sql", "xls", "xlsx", "ppt", "pptx", "rb",
    "php", "apk", "dmg", "gz", "tgz", "xz", "ipynb", "yml", "cfg", "ini", "srt", "avi", "mkv", "mov", "webp", "rtf",
    "epub", "psd", "mp3", "mp4", "m4a", "bz2", "7z", "ogg",
];
/// Words a rate is per, besides units: $5/month.
const PER_WORDS: [&str; 22] = [
    "day", "week", "month", "year", "hour", "minute", "second", "night", "person", "head", "user", "seat", "unit",
    "item", "share", "visit", "serving", "dose", "page", "word", "game", "mile",
];
/// Words before a score (8/10 eight out of ten), or after one.
const SCORE_CUES: [&str; 16] = [
    "rated", "rating", "ratings", "scored", "score", "scores", "scoring", "got", "gets", "gave", "give", "gives",
    "earned", "earns", "received", "graded",
];
const SCORE_AFTER: [&str; 5] = ["stars", "star", "points", "pts", "marks"];
/// Words before two numbers and a slash that leave them as written, a date (on 3/7).
const DATE_CUES: [&str; 15] = [
    "on", "by", "due", "until", "till", "since", "from", "before", "after", "through", "thru", "dated", "expires",
    "starting", "ending",
];
/// Words after a fraction of ten or a hundred that keep it a fraction (3/10 of, 1/10 second).
const FRACTION_NEXT: [&str; 17] = [
    "of", "mile", "miles", "inch", "inches", "second", "seconds", "cup", "cups", "percent", "acre", "acres", "gallon",
    "gallons", "ounce", "ounces", "th",
];

const ONES: [&str; 20] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
pub const MAX_NUMBER: u64 = 999_999_999_999;

fn lookup<'a>(table: &[(&str, &'a str)], k: &str) -> Option<&'a str> {
    table.iter().find(|(a, _)| *a == k).map(|(_, b)| *b)
}

fn is_stop(c: char) -> bool {
    ",;:.!?".contains(c)
}

pub fn cardinal(n: u64) -> String {
    if n < 20 {
        return ONES[n as usize].into();
    }
    if n < 100 {
        let t = TENS[(n / 10) as usize];
        return if n % 10 == 0 { t.into() } else { format!("{t} {}", ONES[(n % 10) as usize]) };
    }
    if n < 1000 {
        let h = format!("{} hundred", ONES[(n / 100) as usize]);
        return if n % 100 == 0 { h } else { format!("{h} {}", cardinal(n % 100)) };
    }
    for (u, name) in [(1_000_000_000, "billion"), (1_000_000, "million"), (1000, "thousand")] {
        if n >= u {
            let a = format!("{} {name}", cardinal(n / u));
            return if n % u == 0 { a } else { format!("{a} {}", cardinal(n % u)) };
        }
    }
    unreachable!()
}

fn digits(d: &str) -> String {
    d.bytes().map(|c| ONES[(c - b'0') as usize]).collect::<Vec<_>>().join(" ")
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit())
}

/// Length of the integer at the start of s: digits in threes after commas, or plain digits.
fn int_prefix(s: &str) -> usize {
    let b = s.as_bytes();
    let lead = b.iter().take_while(|c| c.is_ascii_digit()).count();
    if lead == 0 {
        return 0;
    }
    if lead <= 3 {
        let mut i = lead;
        while i + 4 <= b.len() && b[i] == b',' && b[i + 1..i + 4].iter().all(|c| c.is_ascii_digit()) && b.get(i + 4).map_or(true, |c| !c.is_ascii_digit()) {
            i += 4;
        }
        if i > lead {
            return i;
        }
    }
    lead
}

fn parse_u64(plain: &str, written: &str) -> Result<u64> {
    if plain.len() > 12 {
        return err(format!("{written} is too large to say"));
    }
    let n: u64 = plain.parse().map_err(|_| Error(format!("{written}: not a number")))?;
    if n > MAX_NUMBER {
        return err(format!("{written} is too large to say"));
    }
    Ok(n)
}

/// An integer as written; a leading zero reads digit by digit; a year (1100 to 1999, 2010 to
/// 2099, no comma) reads in pairs.
fn integer(s: &str, year: bool) -> Result<String> {
    let plain: String = s.chars().filter(|&c| c != ',').collect();
    if plain.len() > 1 && plain.starts_with('0') {
        return Ok(digits(&plain));
    }
    let n = parse_u64(&plain, s)?;
    if year && !s.contains(',') && plain.len() == 4 && ((1100..=1999).contains(&n) || (2010..=2099).contains(&n)) {
        return Ok(pairs(n));
    }
    Ok(cardinal(n))
}

/// Three or four digits in pairs, as a year or a code has them: nineteen oh five, ten sixty six,
/// one fifty, nineteen hundred.
fn pairs(n: u64) -> String {
    let (hi, lo) = (n / 100, n % 100);
    let tail = if lo == 0 { "hundred".to_string() } else if lo < 10 { format!("oh {}", ONES[lo as usize]) } else { cardinal(lo) };
    format!("{} {tail}", cardinal(hi))
}

/// Digits beside letters as a code has them (B12, F150, 1080p): up to two as a number, three or
/// four in pairs unless a round thousand, more, or a leading zero, digit by digit.
fn code_digits(d: &str) -> String {
    if d.len() > 4 || (d.len() > 1 && d.starts_with('0')) {
        return digits(d);
    }
    let n: u64 = d.parse().unwrap();
    if d.len() <= 2 || n % 1000 == 0 {
        cardinal(n)
    } else {
        pairs(n)
    }
}

fn ordinal(n: u64) -> String {
    let c = cardinal(n);
    let (head, last) = match c.rsplit_once(' ') { Some((h, l)) => (format!("{h} "), l), None => (String::new(), c.as_str()) };
    let ord = match last {
        "one" => "first".into(), "two" => "second".into(), "three" => "third".into(), "five" => "fifth".into(),
        "eight" => "eighth".into(), "nine" => "ninth".into(), "twelve" => "twelfth".into(),
        l if l.ends_with('y') => format!("{}ieth", &l[..l.len() - 1]),
        l => format!("{l}th"),
    };
    format!("{head}{ord}")
}

fn ws(s: &str) -> Vec<String> {
    s.split(' ').map(String::from).collect()
}

fn time_of(tok: &str) -> Option<(u64, u64)> {
    let (h, m) = tok.split_once(':')?;
    if !all_digits(h) || h.len() > 2 || !all_digits(m) || m.len() != 2 {
        return None;
    }
    Some((h.parse().ok()?, m.parse().ok()?))
}

/// An hour said with am or pm: 1 to 12.
fn hour(s: &str) -> bool {
    all_digits(s) && s.len() <= 2 && (1..=12).contains(&s.parse::<u64>().unwrap())
}

/// Money as words: $5 $1.50 €20 £0.50 ¥3000 $1.2M 50¢, None if tok is not money. `then` is the
/// word after it, taken if a magnitude ($1.2 million); the bool says whether it was.
fn money(tok: &str, then: Option<&str>) -> Result<Option<(String, bool)>> {
    if let Some(n) = tok.strip_suffix('\u{00a2}') {
        if n.is_empty() || int_prefix(n) != n.len() {
            return Ok(None);
        }
        let c = parse_u64(&n.replace(',', ""), tok)?;
        return Ok(Some((format!("{} {}", integer(n, false)?, if c == 1 { "cent" } else { "cents" }), false)));
    }
    let Some((sign, names)) = CURRENCIES.iter().find(|(c, _)| tok.starts_with(*c)) else { return Ok(None) };
    let rest = &tok[sign.len_utf8()..];
    let k = int_prefix(rest);
    if k == 0 {
        return Ok(None);
    }
    let (i, mut tail) = rest.split_at(k);
    let mut frac = None;
    if let Some(t) = tail.strip_prefix('.') {
        let n = t.bytes().take_while(|c| c.is_ascii_digit()).count();
        if n == 0 {
            return Ok(None);
        }
        frac = Some(&t[..n]);
        tail = &t[n..];
    }
    let (mag, took) = if tail.is_empty() {
        match then.filter(|t| MAGNITUDE_WORDS.contains(t)) { Some(m) => (Some(m), true), None => (None, false) }
    } else {
        match lookup(&MAGNITUDES, tail) { Some(m) => (Some(m), false), None => return Ok(None) }
    };
    let whole = integer(i, false)?;
    let d = parse_u64(&i.replace(',', ""), tok)?;
    if let Some(m) = mag {
        let num = match frac { Some(f) => format!("{whole} point {}", digits(f)), None => whole };
        return Ok(Some((format!("{num} {m} {}", names[1]), took)));
    }
    let main = format!("{whole} {}", if d == 1 { names[0] } else { names[1] });
    let said = match frac {
        None => main,
        Some(f) if f.len() == 2 && !names[2].is_empty() => {
            let c: u64 = f.parse().unwrap();
            let sub = format!("{} {}", cardinal(c), if c == 1 { names[2] } else { names[3] });
            if d == 0 && c > 0 { sub } else if c > 0 { format!("{main} {sub}") } else { main }
        }
        Some(f) => format!("{whole} point {} {}", digits(f), names[1]),
    };
    Ok(Some((said, false)))
}

/// A number as written, as words; None if tok is not one: 1,234 1999 007 -5 3.14 40% $1.50 22nd 4:30
/// 1990s '90s.
pub fn number_words(tok: &str) -> Result<Option<String>> {
    if let Some((h, m)) = time_of(tok) {
        if h <= 24 && m < 60 {
            let hw = cardinal(h);
            return Ok(Some(if m == 0 { format!("{hw} o'clock") } else if m < 10 { format!("{hw} oh {}", ONES[m as usize]) } else { format!("{hw} {}", cardinal(m)) }));
        }
    }
    if let Some((w, _)) = money(tok, None)? {
        return Ok(Some(w));
    }
    let k = int_prefix(tok);
    if k > 0 {
        let (i, tail) = tok.split_at(k);
        let low = tail.to_ascii_lowercase();
        if ["st", "nd", "rd", "th"].contains(&low.as_str()) {
            let n = parse_u64(&i.replace(',', ""), tok)?;
            let t = n % 100;
            let want = if (11..=13).contains(&t) { "th" } else { match n % 10 { 1 => "st", 2 => "nd", 3 => "rd", _ => "th" } };
            if low != want {
                return Ok(None);
            }
            return Ok(Some(ordinal(n)));
        }
    }
    if let Some(t) = tok.strip_suffix('s') {
        let t = t.strip_suffix('\'').unwrap_or(t);
        let t = t.strip_prefix('\'').unwrap_or(t);
        if all_digits(t) {
            let w = integer(t, true)?;
            let (head, last) = match w.rsplit_once(' ') { Some((h, l)) => (format!("{h} "), l), None => (String::new(), w.as_str()) };
            let pl = if let Some(b) = last.strip_suffix('y') { format!("{b}ies") } else if last.ends_with('s') || last.ends_with('x') { format!("{last}es") } else { format!("{last}s") };
            return Ok(Some(format!("{head}{pl}")));
        }
    }
    let (neg, body) = match tok.strip_prefix('-') { Some(b) => (true, b), None => (false, tok) };
    let k = int_prefix(body);
    if k == 0 {
        return Ok(None);
    }
    let (i, mut tail) = body.split_at(k);
    let mut frac = None;
    if let Some(t) = tail.strip_prefix('.') {
        let n = t.bytes().take_while(|c| c.is_ascii_digit()).count();
        if n == 0 {
            return Ok(None);
        }
        frac = Some(&t[..n]);
        tail = &t[n..];
    }
    let pct = match tail { "" => false, "%" => true, _ => return Ok(None) };
    let mut parts = Vec::new();
    if neg {
        parts.push("minus".to_string());
    }
    parts.push(integer(i, !neg && frac.is_none() && !pct)?);
    if let Some(f) = frac {
        parts.push(format!("point {}", digits(f)));
    }
    if pct {
        parts.push("percent".into());
    }
    Ok(Some(parts.join(" ")))
}

/// A telephone number, each group digit by digit with a pause after it: 555-1234, 555-123-4567,
/// 555.123.4567, 1-800-555-1234 (an area code of round hundreds as a number), +44-20-7946-0958.
fn phone(s: &str) -> Option<Vec<String>> {
    if let Some(intl) = s.strip_prefix('+') {
        let g: Vec<&str> = intl.split('-').collect();
        let ok = (1..=3).contains(&g[0].len()) && g.len() >= 3 && g.iter().all(|x| all_digits(x)) && g[1..].iter().all(|x| (2..=4).contains(&x.len()));
        if !ok {
            return None;
        }
        let mut out = vec!["plus".to_string()];
        for (k, x) in g.iter().enumerate() {
            if k > 0 {
                out.push(",".into());
            }
            out.extend(ws(&digits(x)));
        }
        return Some(out);
    }
    let sep = if s.contains('-') { '-' } else { '.' };
    let g: Vec<&str> = s.split(sep).collect();
    if !g.iter().all(|x| all_digits(x)) {
        return None;
    }
    let lens: Vec<usize> = g.iter().map(|x| x.len()).collect();
    let (mut out, rest) = match lens.as_slice() {
        [3, 4] if sep == '-' && !g[0].starts_with(['0', '1']) => (vec![], &g[..]),
        [3, 3, 4] if !g[0].starts_with(['0', '1']) => (vec![], &g[..]),
        [1, 3, 3, 4] if g[0] == "1" => (vec!["one".to_string()], &g[1..]),
        _ => return None,
    };
    for (k, x) in rest.iter().enumerate() {
        if k > 0 {
            out.push(",".into());
        }
        if k == 0 && rest.len() == 3 && x.ends_with("00") && !x.starts_with('0') {
            out.extend(ws(&cardinal(x.parse().unwrap())));
        } else {
            out.extend(ws(&digits(x)));
        }
    }
    Some(out)
}

fn date(m: u64, d: u64, year: &str) -> Vec<String> {
    let mut w = vec![MONTH_NAMES[m as usize - 1].to_string()];
    w.extend(ws(&ordinal(d)));
    w.push(",".into());
    w.extend(ws(year));
    w
}

/// A date written year first: 2024-03-15.
fn iso_date(s: &str) -> Result<Option<Vec<String>>> {
    let g: Vec<&str> = s.split('-').collect();
    if g.len() != 3 || g[0].len() != 4 || g[1].len() != 2 || g[2].len() != 2 || !g.iter().all(|x| all_digits(x)) {
        return Ok(None);
    }
    let (m, d): (u64, u64) = (g[1].parse().unwrap(), g[2].parse().unwrap());
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Ok(None);
    }
    Ok(Some(date(m, d, &integer(g[0], true)?)))
}

/// Numbers either side of a slash, no leading zeros: (numerator, denominator).
fn slash_pair(s: &str) -> Option<(u64, u64)> {
    let (a, b) = s.split_once('/')?;
    let ok = |x: &str| all_digits(x) && x.len() <= 4 && !x.starts_with('0');
    if !ok(a) || !ok(b) {
        return None;
    }
    Some((a.parse().unwrap(), b.parse().unwrap()))
}

const DENOMINATORS: [u64; 12] = [2, 3, 4, 5, 6, 8, 10, 16, 32, 64, 100, 1000];

/// A proper fraction with a usual denominator: one half, three quarters; a half after a whole
/// number (`mixed`).
fn fraction(a: u64, b: u64, mixed: bool) -> Option<String> {
    if a == 0 || a >= b || !DENOMINATORS.contains(&b) {
        return None;
    }
    let (one, many) = match b {
        2 => ("half".to_string(), "halves".to_string()),
        4 => ("quarter".to_string(), "quarters".to_string()),
        100 => ("hundredth".to_string(), "hundredths".to_string()),
        1000 => ("thousandth".to_string(), "thousandths".to_string()),
        _ => (ordinal(b), format!("{}s", ordinal(b))),
    };
    Some(if a == 1 { format!("{} {one}", if mixed { "a" } else { "one" }) } else { format!("{} {many}", cardinal(a)) })
}

/// Numbers either side of slashes: a date (12/25/2024, month first unless it cannot be), a
/// fraction (3/4), else each number (24/7, 9/11).
fn slashed(s: &str) -> Result<Option<Vec<String>>> {
    let g: Vec<&str> = s.split('/').collect();
    if g.len() < 2 || g.len() > 3 || !g.iter().all(|x| all_digits(x)) {
        return Ok(None);
    }
    if g.len() == 3 {
        if g[0].len() > 2 || g[1].len() > 2 || !(g[2].len() == 2 || g[2].len() == 4) {
            return Ok(None);
        }
        let (a, b): (u64, u64) = (g[0].parse().unwrap(), g[1].parse().unwrap());
        let (m, d) = if (1..=12).contains(&a) && (1..=31).contains(&b) {
            (a, b)
        } else if (1..=12).contains(&b) && (13..=31).contains(&a) {
            (b, a)
        } else {
            return Ok(None);
        };
        let year = if g[2].len() == 4 {
            integer(g[2], true)?
        } else {
            let y: u64 = g[2].parse().unwrap();
            if y < 10 { format!("oh {}", ONES[y as usize]) } else { cardinal(y) }
        };
        return Ok(Some(date(m, d, &year)));
    }
    if let Some(f) = slash_pair(s).and_then(|(a, b)| fraction(a, b, false)) {
        return Ok(Some(ws(&f)));
    }
    let mut w = ws(&integer(g[0], true)?);
    w.extend(ws(&integer(g[1], true)?));
    Ok(Some(w))
}

/// Numbers either side of a colon that are not a time: 16:9.
fn ratio(s: &str) -> Result<Option<Vec<String>>> {
    let Some((a, b)) = s.split_once(':') else { return Ok(None) };
    if !all_digits(a) || !all_digits(b) || time_of(s).map_or(false, |(h, m)| h <= 24 && m < 60) {
        return Ok(None);
    }
    let mut w = ws(&integer(a, false)?);
    w.push("to".into());
    w.extend(ws(&integer(b, false)?));
    Ok(Some(w))
}

/// A time with seconds, or minutes with a fraction of a second, as a clock or a stopwatch is read:
/// 1:23:45.67 one twenty three forty five point six seven, 3:42.5 three forty two point five.
fn clock(s: &str) -> Result<Option<Vec<String>>> {
    let (body, frac) = match s.split_once('.') {
        Some((b, f)) if all_digits(f) => (b, Some(f)),
        Some(_) => return Ok(None),
        None => (s, None),
    };
    let g: Vec<&str> = body.split(':').collect();
    let sixty = |x: &&str| all_digits(x) && x.len() == 2 && x.as_bytes()[0] < b'6';
    if !(g.len() == 3 || (g.len() == 2 && frac.is_some())) || !all_digits(g[0]) || g[0].len() > 2 || !g[1..].iter().all(sixty) {
        return Ok(None);
    }
    let mut w = ws(&integer(g[0], false)?);
    for x in &g[1..] {
        let n: u64 = x.parse().unwrap();
        w.extend(ws(&if n < 10 { format!("oh {}", ONES[n as usize]) } else { cardinal(n) }));
    }
    if let Some(f) = frac {
        w.push("point".into());
        w.extend(ws(&digits(f)));
    }
    Ok(Some(w))
}

/// Three or more numbers between dots: a version (2.0.1 two point oh point one), or four of 0 to
/// 255, an address (192.168.1.1, dot between).
fn dotted_numbers(s: &str) -> Result<Option<Vec<String>>> {
    let g: Vec<&str> = s.split('.').collect();
    if g.len() < 3 || !g.iter().all(|x| all_digits(x)) {
        return Ok(None);
    }
    let ip = g.len() == 4 && g.iter().all(|x| x.len() <= 3 && (x.len() == 1 || !x.starts_with('0')) && x.parse::<u64>().unwrap() <= 255);
    let mut w = Vec::new();
    for (k, x) in g.iter().enumerate() {
        if k > 0 {
            w.push(if ip { "dot" } else { "point" }.to_string());
        }
        if *x == "0" && !ip {
            w.push("oh".into());
        } else {
            w.extend(ws(&integer(x, false)?));
        }
    }
    Ok(Some(w))
}

/// A number with no letters as words: a phone number, a date, a fraction, a stopwatch's time, a
/// ratio, a version, or what number_words reads; None if none of these.
fn figure(s: &str) -> Result<Option<Vec<String>>> {
    if s == "911" {
        return Ok(Some(ws("nine one one")));
    }
    if let Some(w) = phone(s) {
        return Ok(Some(w));
    }
    for f in [iso_date, slashed, clock, ratio, dotted_numbers] {
        if let Some(w) = f(s)? {
            return Ok(Some(w));
        }
    }
    Ok(number_words(s)?.map(|w| ws(&w)))
}

/// A count a unit can follow: 5, -3, 1,500, 2.5, 3/4.
fn quantity(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    let k = int_prefix(body);
    if k == 0 {
        return false;
    }
    let tail = &body[k..];
    tail.is_empty() || (tail.len() > 1 && tail.starts_with('.') && all_digits(&tail[1..])) || slash_pair(s).and_then(|(a, b)| fraction(a, b, false)).is_some()
}

/// A unit written after a number, said of one and of more; JOINED too if written against it.
fn unit(s: &str, joined: bool) -> Option<(&'static str, &'static str)> {
    let extra: &[(&'static str, &'static str, &'static str)] = if joined { &JOINED } else { &[] };
    UNITS.iter().chain(extra.iter()).find(|(u, _, _)| *u == s).map(|(_, a, b)| (*a, *b))
}

/// A unit as unit() has it, squared or cubed (m^2 square meters), or a rate of one per a unit or a
/// PER_WORD (mg/kg milligrams per kilogram, m/s^2 meters per second squared).
fn units(s: &str, joined: bool) -> Option<(String, String)> {
    if let Some((a, b)) = unit(s, joined) {
        return Some((a.into(), b.into()));
    }
    for (sup, word) in [("^2", "square"), ("^3", "cubic")] {
        if let Some((a, b)) = s.strip_suffix(sup).and_then(|base| unit(base, joined)) {
            return Some((format!("{word} {a}"), format!("{word} {b}")));
        }
    }
    let (n, d) = s.split_once('/')?;
    let (a, b) = units(n, joined)?;
    let per = match d.strip_suffix("^2") {
        Some(base) => format!("{} squared", unit(base, false)?.0),
        None => match unit(d, false) {
            Some((one, _)) => one.to_string(),
            None if PER_WORDS.contains(&d) => d.to_string(),
            None => return None,
        },
    };
    Some((format!("{a} per {per}"), format!("{b} per {per}")))
}

fn degrees(s: &str) -> Option<(&'static str, &'static str)> {
    match s {
        "\u{00b0}" => Some(("degree", "degrees")),
        "\u{00b0}C" => Some(("degree celsius", "degrees celsius")),
        "\u{00b0}F" => Some(("degree fahrenheit", "degrees fahrenheit")),
        _ => None,
    }
}

fn ampm_suffix(s: &str) -> Option<char> {
    match s.to_ascii_lowercase().as_str() {
        "am" | "a.m" => Some('a'),
        "pm" | "p.m" => Some('p'),
        _ => None,
    }
}

fn is_title_case(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_uppercase() && b[1..].iter().all(|c| c.is_ascii_lowercase())
}

/// A day's or a month's name, written out or short (Mon, Sept), in any case, as its full name.
fn named(s: &str, full: &[&str], short: &[(&str, &str)]) -> Option<String> {
    let low = s.to_ascii_lowercase();
    if full.contains(&low.as_str()) {
        return Some(low);
    }
    short.iter().find(|(k, _)| k.to_ascii_lowercase() == low).map(|(_, v)| v.to_string())
}

fn month_of(s: &str) -> Option<String> {
    named(s, &MONTH_NAMES, &MONTHS)
}

/// A chunk split from the stops after it.
fn split_stops(ch: &str) -> (&str, &str) {
    let cut = ch.trim_end_matches(is_stop).len();
    ch.split_at(cut)
}

/// The chunks about one, split from their stops, and the next as written.
#[derive(Clone, Copy)]
struct Around<'a> {
    prev: Option<(&'a str, &'a str)>,
    prev2: Option<(&'a str, &'a str)>,
    nxt: Option<(&'a str, &'a str)>,
    nxt_raw: Option<&'a str>,
}

const ALONE: Around<'static> = Around { prev: None, prev2: None, nxt: None, nxt_raw: None };

/// What a number takes in from the chunk after it, if `free` (no stop between): am or pm after a
/// time or an hour; a unit after a count, of one if `one` (6 ft 2 in); and whether it took it.
fn after(mut w: Vec<String>, core: &str, one: bool, free: bool, at: &Around) -> (Vec<String>, bool) {
    let (Some((nc, _)), Some(raw)) = (at.nxt, at.nxt_raw) else { return (w, false) };
    if !free {
        return (w, false);
    }
    if time_of(core).is_some() || hour(core) {
        if let Some((c, _)) = ampm(raw) {
            w.push(spelled(&format!("{c}m")));
            return (w, true);
        }
    }
    if quantity(core) {
        let inch = nc == "in" && at.prev.map_or(false, |(c, p)| p.is_empty() && ["ft", "feet", "foot"].contains(&c));
        let deg = degrees(nc).or(if inch { Some(("inch", "inches")) } else { None }).map(|(a, b)| (a.to_string(), b.to_string()));
        let minutes = if nc == "m" && after_hours(at) { Some(("minute".to_string(), "minutes".to_string())) } else { None };
        if let Some((a, b)) = minutes.or(units(nc, false)).or(deg) {
            w.extend(ws(if one { &a } else { &b }));
            return (w, true);
        }
    }
    (w, false)
}

/// A number as written with no year reading: 4.5 four point five, 1500 one thousand five hundred.
fn plain_words(x: &str) -> Result<Vec<String>> {
    let mut w = ws(&integer(x.split('.').next().unwrap(), false)?);
    if let Some((_, f)) = x.split_once('.') {
        w.push("point".into());
        w.extend(ws(&digits(f)));
    }
    Ok(w)
}

/// Two numbers either side of a slash as a score or a ratio, else None (a date, a fraction, or as
/// written: 3/7, 3/4, 24/7, 50/50). After a word for a date (on 3/4) one that could be a date is as
/// written. Out of after a word that gives a score (rated 4/5) or before one (4/5 stars), with a
/// decimal, or over ten or a hundred unless a fraction's word follows (3/10 of); else out of (45/60)
/// or over (120/80) unless it could be a date or a usual fraction, or the two are the same or make a
/// hundred.
fn out_of(core: &str, free: bool, at: &Around) -> Result<Option<Vec<String>>> {
    let Some((a, b)) = core.split_once('/') else { return Ok(None) };
    let plain = |x: &str| {
        let (i, f) = x.split_once('.').unwrap_or((x, "0"));
        all_digits(i) && all_digits(f) && i.len() <= 4 && f.len() <= 2 && (!i.starts_with('0') || (i == "0" && x.contains('.')))
    };
    if !plain(a) || !plain(b) {
        return Ok(None);
    }
    let word = |w: Option<(&str, &str)>| w.filter(|(_, p)| p.is_empty()).map(|(c, _)| c.to_ascii_lowercase());
    let prev = word(at.prev);
    let prev2 = if prev.is_some() { word(at.prev2) } else { None };
    let raw = if free { at.nxt.map(|(c, _)| c) } else { None };
    let next = raw.map(|c| c.to_ascii_lowercase());
    let (x, y): (f64, f64) = (a.parse().unwrap(), b.parse().unwrap());
    let (p, q) = (x as u64, y as u64);
    let whole = !a.contains('.') && !b.contains('.');
    let date = whole && (((1..=12).contains(&p) && (1..=31).contains(&q)) || ((1..=12).contains(&q) && (1..=31).contains(&p)));
    if prev.as_deref().map_or(false, |p| DATE_CUES.contains(&p)) {
        if !date {
            return Ok(None);
        }
        let mut w = ws(&integer(a, true)?);
        w.extend(ws(&integer(b, true)?));
        return Ok(Some(w));
    }
    let cue = [&prev, &prev2].iter().any(|w| w.as_deref().map_or(false, |p| SCORE_CUES.contains(&p)))
        || next.as_deref().map_or(false, |n| SCORE_AFTER.contains(&n));
    let said = |mid: &str| -> Result<Option<Vec<String>>> {
        let mut w = plain_words(a)?;
        w.extend(ws(mid));
        w.extend(plain_words(b)?);
        Ok(Some(w))
    };
    if cue {
        return said("out of");
    }
    if !whole {
        return said(if x <= y { "out of" } else { "over" });
    }
    if next.as_deref().map_or(false, |n| FRACTION_NEXT.contains(&n)) || raw.map_or(false, |n| unit(n, false).is_some()) || p + q == 100 || (p == q && q != 10 && q != 100) {
        return Ok(None);
    }
    if (q == 10 || q == 100) && p <= q {
        return said("out of");
    }
    if date || fraction(p, q, false).is_some() {
        return Ok(None);
    }
    said(if p <= q { "out of" } else { "over" })
}

/// A rate written with a slash after an amount: $5/month five dollars per month, 5mg/kg, 10/day.
fn per(core: &str, text: &str) -> Result<Option<Vec<String>>> {
    let Some((n, d)) = core.rsplit_once('/') else { return Ok(None) };
    if d.is_empty() || !d.bytes().all(|c| c.is_ascii_alphabetic()) || !n.starts_with(|c: char| c.is_ascii_digit() || CURRENCIES.iter().any(|(m, _)| *m == c)) {
        return Ok(None);
    }
    let den = match unit(d, false) {
        Some((one, _)) => one,
        None if PER_WORDS.contains(&d) => d,
        None => return Ok(None),
    };
    let (mut w, _) = numeric(n, false, &ALONE, text)?;
    w.push("per".into());
    w.extend(ws(den));
    Ok(Some(w))
}

/// Hours, minutes and seconds written together, two or more in that order: 1h30m, 5m30s.
fn duration(core: &str) -> Result<Option<Vec<String>>> {
    let b = core.as_bytes();
    let mut parts = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let st = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == st || i - st > 3 || i == b.len() {
            return Ok(None);
        }
        let Some(k) = b"hms".iter().position(|&u| u == b[i]) else { return Ok(None) };
        if parts.last().map_or(false, |&(_, l)| k <= l) {
            return Ok(None);
        }
        parts.push((&core[st..i], k));
        i += 1;
    }
    if parts.len() < 2 {
        return Ok(None);
    }
    let names = [("hour", "hours"), ("minute", "minutes"), ("second", "seconds")];
    let mut w = Vec::new();
    for (n, k) in parts {
        w.extend(ws(&integer(n, false)?));
        w.push(if n == "1" { names[k].0 } else { names[k].1 }.into());
    }
    Ok(Some(w))
}

/// A number and its unit written as one: true if the unit is one of these.
fn counts(c: &str, of: &[&str]) -> bool {
    let (n, r) = split_num(c);
    !n.is_empty() && of.contains(&r)
}

/// Hours just before, with their number or without: m after them is minutes (2h 15m, 2 h 15 m).
fn after_hours(at: &Around) -> bool {
    const H: [&str; 3] = ["h", "hr", "hrs"];
    at.prev.map_or(false, |(c, p)| p.is_empty() && (counts(c, &H) || H.contains(&c)))
}

/// A chunk with digits in it, or money, as words, and whether it takes in the chunk after it,
/// which it may only if `free`: 5 km, $1.2 million, 9 am, 72\u{00b0} F. Units are of one after a or an
/// (a 5 km run).
fn numeric(core: &str, free: bool, at: &Around, text: &str) -> Result<(Vec<String>, bool)> {
    let then = if free { at.nxt.map(|n| n.0) } else { None };
    if core.starts_with('+') {
        if let Some(w) = phone(core) {
            return Ok((w, false));
        }
    }
    if let Some((w, took)) = money(core, then)? {
        return Ok((ws(&w), took));
    }
    // $35+, 5+ yrs: plus after the number, before its unit
    if let Some(body) = core.strip_suffix('+').filter(|b| !b.ends_with('+') && b.starts_with(|c: char| c.is_ascii_digit() || CURRENCIES.iter().any(|(m, _)| *m == c))) {
        let n = numeric(body, false, at, text)?.0.len();
        let (mut w, took) = numeric(body, free, at, text)?;
        w.insert(n.min(w.len()), "plus".into());
        return Ok((w, took));
    }
    if let Some(w) = per(core, text)? {
        return Ok((w, false));
    }
    // 3BR/2BA three bedroom two bath
    if let Some((a, b)) = core.split_once('/') {
        let room = |x: &str| {
            let (n, r) = split_num(x);
            (all_digits(n) && n.len() <= 2 && ["BR", "bd", "BA", "ba"].contains(&r)).then(|| (n.parse::<u64>().unwrap(), unit(r, true).unwrap().0))
        };
        if let (Some((na, ua)), Some((nb, ub))) = (room(a), room(b)) {
            let mut w = ws(&cardinal(na));
            w.push(ua.into());
            w.extend(ws(&cardinal(nb)));
            w.push(ub.into());
            return Ok((w, false));
        }
    }
    // wait 30s, every 5s; from the 20s to 30s stays decades
    if let Some(n) = core.strip_suffix('s').filter(|n| all_digits(n) && n.len() <= 3) {
        let cued = at.prev.map_or(false, |(c, p)| p.is_empty() && SECOND_CUES.contains(&c.to_ascii_lowercase().as_str()));
        let decades = at.prev.map_or(false, |(c, _)| c == "to") && at.prev2.map_or(false, |(c, _)| c.ends_with('s') && c.starts_with(|c: char| c.is_ascii_digit()));
        if cued && !decades {
            if let Some(mut w) = figure(n)? {
                w.push(if n == "1" { "second" } else { "seconds" }.into());
                return Ok((w, false));
            }
        }
    }
    // #A12345 an order's number, #covid19 a tag
    if let Some(rest) = core.strip_prefix('#').filter(|r| r.starts_with(|c: char| c.is_ascii_alphabetic())) {
        let run = rest.split(|c: char| !c.is_ascii_alphabetic()).map(str::len).max().unwrap_or(0);
        let mut w = vec![if run >= 3 { "hashtag" } else { "number" }.to_string()];
        w.extend(if run >= 3 { numeric(rest, false, at, text)?.0 } else { code(rest, text)? });
        return Ok((w, false));
    }
    for (sign, said) in [('#', "number"), ('~', "about"), ('+', "plus"), ('>', "more than"), ('<', "less than")] {
        if let Some(rest) = core.strip_prefix(sign) {
            if rest.starts_with(|c: char| c.is_ascii_digit() || CURRENCIES.iter().any(|(m, _)| *m == c)) {
                let (mut w, took) = numeric(rest, free, at, text)?;
                w.splice(0..0, ws(said));
                return Ok((w, took));
            }
        }
    }
    let cue = |x: Option<(&str, &str)>| x.map_or(false, |(c, p)| (p.is_empty() || p == ":") && CODE_CUES.contains(&c.to_ascii_lowercase().as_str()));
    let linked = at.prev.map_or(false, |(c, p)| p.is_empty() && (c == "is" || c == "was"));
    if all_digits(core) && core.len() >= 4 && (cue(at.prev) || (linked && cue(at.prev2))) {
        return Ok((ws(&digits(core)), false));
    }
    // port 8080 eighty eighty; ext. 4417 digit by digit, ext. 42 a number
    if let Some((c, p)) = at.prev.filter(|_| all_digits(core) && core.len() >= 2) {
        let c = c.to_ascii_lowercase();
        if p.is_empty() && c == "port" {
            return Ok((ws(&code_digits(core)), false));
        }
        if (p.is_empty() || p == ".") && (c == "ext" || c == "extension") && core.len() >= 3 {
            return Ok((ws(&digits(core)), false));
        }
    }
    // Python 3.12
    if at.prev.map_or(false, |(c, p)| p.is_empty() && VERSION_CUES.contains(&c)) {
        if let Some((a, b)) = core.split_once('.').filter(|(a, b)| all_digits(a) && a.len() <= 2 && all_digits(b) && b.len() == 2 && !b.starts_with('0')) {
            let mut w = ws(&integer(a, false)?);
            w.push("point".into());
            w.extend(ws(&integer(b, false)?));
            return Ok((w, false));
        }
    }
    if free && at.nxt.map_or(false, |(c, _)| c == "mmHg") {
        if let Some((a, b)) = core.split_once('/').filter(|(a, b)| all_digits(a) && all_digits(b) && a.len() <= 3 && b.len() <= 3) {
            let mut w = ws(&integer(a, false)?);
            w.push("over".into());
            w.extend(ws(&integer(b, false)?));
            w.extend(ws("millimeters of mercury"));
            return Ok((w, true));
        }
    }
    let adj = at.prev.map_or(false, |(c, p)| p.is_empty() && (c.eq_ignore_ascii_case("a") || c.eq_ignore_ascii_case("an")));
    if all_digits(core) && core.len() <= 4 {
        let n: u64 = core.parse().unwrap();
        let after_month = at.prev.map_or(false, |(c, p)| {
            (p.is_empty() && is_title_case(c) && MONTH_NAMES.contains(&c.to_ascii_lowercase().as_str())) || ((p == "." || p.is_empty()) && lookup(&MONTHS, c).is_some())
        });
        if core.len() <= 2 && (1..=31).contains(&n) && after_month {
            return Ok((ws(&ordinal(n)), false));
        }
        let month_next = free && at.nxt.map_or(false, |(c, _)| (is_title_case(c) && MONTH_NAMES.contains(&c.to_ascii_lowercase().as_str())) || lookup(&MONTHS, c).is_some());
        if day_num(core) && month_next {
            let mut w = if at.prev.map_or(false, |(c, _)| c.eq_ignore_ascii_case("the")) { vec![] } else { vec!["the".to_string()] };
            w.extend(ws(&ordinal(n)));
            w.push("of".into());
            return Ok((w, false));
        }
        let cued = at.prev.map_or(false, |(c, p)| p.is_empty() && YEAR_CUES.contains(&c.to_ascii_lowercase().as_str())) || then.map_or(false, |t| ERAS.contains(&t));
        if core.len() == 4 && (1001..=1099).contains(&n) && cued {
            return Ok((ws(&pairs(n)), false));
        }
    }
    if at.prev.map_or(false, |(c, p)| p.is_empty() && all_digits(c)) {
        if let Some(f) = slash_pair(core).and_then(|(a, b)| fraction(a, b, true)) {
            let mut w = vec!["and".to_string()];
            w.extend(ws(&f));
            return Ok(after(w, core, false, free, at));
        }
    }
    if let Some(w) = out_of(core, free, at)? {
        return Ok((w, false));
    }
    if let Some(w) = figure(core)? {
        let one = core == "1" || adj || slash_pair(core).and_then(|(a, b)| fraction(a, b, false)).is_some();
        return Ok(after(w, core, one, free, at));
    }
    if let Some(w) = duration(core)? {
        return Ok((w, false));
    }
    if !core.contains('^') && core.strip_prefix('-').unwrap_or(core).contains('-') {
        return dashed(core, free, at, text);
    }
    let (num, rest) = split_num(core);
    if !num.is_empty() && !rest.is_empty() {
        if let Some(mut w) = figure(num)? {
            // the 49ers, the 76ers
            if rest == "ers" && all_digits(num) {
                let last = w.pop().unwrap();
                w.push(if last.ends_with('e') { format!("{last}rs") } else { format!("{last}ers") });
                return Ok((w, false));
            }
            if ["st", "nd", "rd", "th"].contains(&rest.to_ascii_lowercase().as_str()) {
                return err(format!("{core} is not an ordinal, in {text:?}"));
            }
            let one = num == "1" || adj;
            if let Some(m) = magnitude(num, rest) {
                w.push(m.into());
                return Ok((w, false));
            }
            if let Some(c) = ampm_suffix(rest) {
                if time_of(num).is_some() || hour(num) {
                    w.push(spelled(&format!("{c}m")));
                    return Ok((w, false));
                }
            }
            if quantity(num) {
                let hours = after_hours(at);
                let secs = free && at.nxt.map_or(false, |(c, _)| counts(c, &["s", "sec", "secs"]));
                if rest == "m" && (hours || secs) {
                    w.push(if one { "minute" } else { "minutes" }.into());
                    return Ok((w, false));
                }
                if let Some(inches) = rest.strip_prefix('\'') {
                    let inches = inches.strip_suffix('"').unwrap_or(inches);
                    if all_digits(inches) && inches.len() <= 2 && inches.parse::<u64>().unwrap() <= 11 {
                        w.push(if one { "foot" } else { "feet" }.into());
                        w.extend(ws(&cardinal(inches.parse().unwrap())));
                        w.push(if inches == "1" || adj { "inch" } else { "inches" }.into());
                        return Ok((w, false));
                    }
                }
                if let Some((a, b)) = units(rest, true) {
                    w.extend(ws(if one { &a } else { &b }));
                    return Ok((w, false));
                }
                if let Some((a, b)) = degrees(rest) {
                    w.extend(ws(if one { a } else { b }));
                    if rest == "\u{00b0}" && free {
                        if let Some((nc @ ("C" | "F"), _)) = at.nxt {
                            w.push(if nc == "C" { "celsius" } else { "fahrenheit" }.into());
                            return Ok((w, true));
                        }
                        // 40.7° N
                        if let Some((nc @ ("N" | "S" | "E" | "W"), _)) = at.nxt {
                            w.push(match nc { "N" => "north", "S" => "south", "E" => "east", _ => "west" }.into());
                            return Ok((w, true));
                        }
                    }
                    return Ok((w, false));
                }
                if rest == "x" {
                    w.push("times".into());
                    return Ok((w, false));
                }
            }
            // 0x80070005, a number in hex, each digit
            if let Some(h) = rest.strip_prefix('x').filter(|h| num == "0" && h.len() >= 2 && h.bytes().all(|c| c.is_ascii_hexdigit())) {
                let mut w = vec!["zero".to_string(), spelled("x")];
                w.extend(h.chars().map(|c| if c.is_ascii_digit() { ONES[c as usize - '0' as usize].to_string() } else { spelled(&c.to_string()) }));
                return Ok((w, false));
            }
            if let Some(d) = rest.strip_prefix('x') {
                let parts: Vec<&str> = d.split('x').collect();
                if all_digits(num) && parts.iter().all(|p| all_digits(p)) {
                    let mut w = ws(&code_digits(num));
                    for p in parts {
                        w.push("by".into());
                        w.extend(ws(&code_digits(p)));
                    }
                    return Ok((w, false));
                }
            }
        }
    }
    Ok((code(core, text)?, false))
}

/// A count written short after a number: 2.3M two point three million, 1.5k, 10M, 3bn; not 3M,
/// 7B or 4K.
fn magnitude(num: &str, rest: &str) -> Option<&'static str> {
    if !quantity(num) || num.contains('/') {
        return None;
    }
    let decimal = num.contains('.');
    match rest {
        "k" | "K" if decimal => Some("thousand"),
        "M" if decimal || num.len() >= 2 => Some("million"),
        "B" if decimal => Some("billion"),
        "mn" | "MM" => Some("million"),
        "bn" => Some("billion"),
        _ => None,
    }
}

/// The number at the start of s (a minus, digits, and . , : / between digits) and the rest.
fn split_num(s: &str) -> (&str, &str) {
    let b = s.as_bytes();
    let mut i = usize::from(b.first() == Some(&b'-'));
    if !(i < b.len() && b[i].is_ascii_digit()) {
        return ("", s);
    }
    while i < b.len() {
        if b[i].is_ascii_digit() || (b".,:/".contains(&b[i]) && i + 1 < b.len() && b[i + 1].is_ascii_digit()) {
            i += 1;
        } else {
            break;
        }
    }
    s.split_at(i)
}

/// A word in capitals said as a word (SO; IT beside another word in capitals), or spelled though
/// the dictionary says it (LED).
fn caps_word(core: &str, punct: &str, at: &Around) -> Option<Vec<String>> {
    let shouted = |c: &str| c == "I" || (c.bytes().filter(|b| b.is_ascii_uppercase()).count() >= 2 && c.bytes().all(|b| b.is_ascii_uppercase() || b == b'\''));
    let beside = at.prev.map_or(false, |(c, _)| shouted(c)) || at.nxt.map_or(false, |(c, _)| shouted(c));
    let joined = at.prev.map_or(false, |(c, p)| p.is_empty() && shouted(c)) || (punct.is_empty() && at.nxt.map_or(false, |(c, _)| shouted(c)));
    let the = at.prev.map_or(false, |(c, p)| p.is_empty() && c.eq_ignore_ascii_case("the"));
    if CAPS_SAID.contains(&core) || (CAPS_SAID_BESIDE.contains(&core) && beside) {
        Some(vec![core.to_ascii_lowercase()])
    } else if CAPS_SPELLED.contains(&core) || (CAPS_SPELLED_ALONE.contains(&core) && !joined) || (core == "WHO" && the) {
        Some(vec![spelled(core)])
    } else {
        None
    }
}

/// A word typed short (thx, omg, YoY) as said, or a label before a colon (Ph: phone).
fn short_word(core: &str, punct: &str) -> Option<Vec<String>> {
    if let Some(w) = lookup(&SHORT_EXACT, core) {
        return Some(ws(w));
    }
    if punct.starts_with(':') {
        if let Some(w) = lookup(&LABELS, core) {
            return Some(ws(w));
        }
    }
    let low = core.to_ascii_lowercase();
    if !(is_lower(core) || is_title_case(core)) {
        return None;
    }
    if let Some(w) = lookup(&SHORT, &low) {
        return Some(ws(w));
    }
    SHORT_SPELLED.contains(&low.as_str()).then(|| vec![spelled(&low)])
}

/// A party and a state written together, as after a lawmaker's name: D-CA democrat of california.
fn party(core: &str) -> Option<Vec<String>> {
    let (p, st) = core.split_once('-')?;
    let side = match p { "D" => "democrat", "R" => "republican", "I" => "independent", _ => return None };
    let name = lookup(&STATES, st).filter(|n| !n.is_empty())?;
    let mut w = vec![",".to_string(), side.into(), "of".into()];
    w.extend(ws(name));
    w.push(",".into());
    Some(w)
}

/// A ZIP code: 02139 or 94103-1234.
fn zip(c: &str) -> bool {
    let b = c.as_bytes();
    (b.len() == 5 || (b.len() == 10 && b[5] == b'-')) && b.iter().enumerate().all(|(k, x)| k == 5 || x.is_ascii_digit())
}

/// A state before a ZIP code, by name, and the code after it digit by digit (OR 97201: oregon nine
/// seven two zero one).
fn address(core: &str, punct: &str, at: &Around) -> Option<Vec<String>> {
    if punct.is_empty() && at.nxt.map_or(false, |(c, _)| zip(c)) {
        if let Some(name) = lookup(&STATES, core) {
            return Some(if name.is_empty() { vec![spelled(core)] } else { ws(name) });
        }
    }
    // Austin, TX.
    if at.prev.map_or(false, |(c, p)| p == "," && is_title_case(c))
        && (punct == "," || punct == "." || at.nxt.is_none())
        && !NOT_AFTER_TOWN.contains(&core)
    {
        if let Some(name) = lookup(&STATES, core).filter(|n| !n.is_empty()) {
            return Some(ws(name));
        }
    }
    let (c, p) = at.prev?;
    if !zip(core) || !p.is_empty() || lookup(&STATES, c).is_none() {
        return None;
    }
    let mut out = ws(&digits(&core[..5]));
    if core.len() == 10 {
        out.push(",".into());
        out.extend(ws(&digits(&core[6..])));
    }
    Some(out)
}

/// Two days' or two months' names with a dash between: Mon-Fri, June-August, M-F.
fn named_range(core: &str) -> Option<Vec<String>> {
    if core == "M-F" {
        return Some(ws("monday to friday"));
    }
    let (a, b) = core.split_once('-')?;
    // Mon.-Fri.
    let a = a.strip_suffix('.').filter(|s| lookup(&DAYS, s).is_some() || lookup(&MONTHS, s).is_some()).unwrap_or(a);
    for (full, short) in [(&DAY_NAMES[..], &DAYS[..]), (&MONTH_NAMES[..], &MONTHS[..])] {
        if let (Some(x), Some(y)) = (named(a, full, short), named(b, full, short)) {
            return Some(vec![x, "to".into(), y]);
        }
    }
    None
}

/// A chunk with dashes inside: a range (9-5, 1990-95, 10-20%, 9am-5pm, Mon-Fri, Q1-Q4; and after
/// between), a count and its unit of one (a 30-yr loan), three or more groups of digits digit by
/// digit (123-45-6789), else each part.
fn dashed(core: &str, free: bool, at: &Around, text: &str) -> Result<(Vec<String>, bool)> {
    if let Some(w) = named_range(core) {
        return Ok((w, false));
    }
    let parts: Vec<&str> = core.split('-').collect();
    if let [a, b] = parts[..] {
        let (la, da) = a.split_at(a.find(|c: char| c.is_ascii_digit()).unwrap_or(a.len()));
        if (1..=2).contains(&la.len()) && la.bytes().all(|c| c.is_ascii_uppercase()) && all_digits(da) && b.strip_prefix(la).map_or(false, all_digits) {
            let mut w = code(a, text)?;
            w.push("to".into());
            w.extend(code(b, text)?);
            return Ok((w, false));
        }
        if let (true, Some((one, _))) = (quantity(a), units(b, false)) {
            if let Some(mut w) = figure(a)? {
                w.extend(ws(&one));
                return Ok((w, false));
            }
        }
        let starts = |s: &str| s.starts_with(|c: char| c.is_ascii_digit() || CURRENCIES.iter().any(|(m, _)| *m == c));
        if starts(a) && starts(b) {
            let first = Around { prev: at.prev, ..ALONE };
            let (mut w, _) = numeric(a, false, &first, text)?;
            let (wb, took) = numeric(b, free, &Around { prev2: None, ..*at }, text)?;
            let between = at.prev.map_or(false, |(c, p)| p.is_empty() && c.eq_ignore_ascii_case("between"));
            w.push(if between { "and" } else { "to" }.into());
            w.extend(wb);
            return Ok((w, took));
        }
    }
    let iso = parts.iter().map(|p| p.len()).eq([4, 2, 2]);
    if parts.len() >= 3 && parts.iter().all(|p| all_digits(p)) && !iso {
        let mut w = Vec::new();
        for (k, p) in parts.iter().enumerate() {
            if k > 0 {
                w.push(",".into());
            }
            w.extend(ws(&digits(p)));
        }
        return Ok((w, false));
    }
    let mut w = Vec::new();
    for p in parts {
        if p.is_empty() {
            continue;
        }
        if p.chars().any(|c| c.is_ascii_digit()) {
            w.extend(numeric(p, false, &ALONE, text)?.0);
        } else {
            w.extend(scan(p, text)?);
        }
    }
    Ok((w, false))
}

/// Letters in a code: one, or lowercase with no vowel, spelled; capitals kept; else lowercase.
fn code_letters(l: &str) -> String {
    if l.len() == 1 || (is_lower(l) && !l.bytes().any(|c| b"aeiouy".contains(&c))) {
        spelled(l)
    } else if is_upper(l) {
        l.to_string()
    } else {
        l.to_ascii_lowercase()
    }
}

/// A chunk mixing letters, digits and signs (Q3, 221B, MP3, 2+2=4) a run at a time: digits beside
/// letters as a code has them, others as numbers; letters as code_letters; signs as words, a dash
/// between letters and digits not said (JR-20419), # after a note sharp (F#7). With six digits or
/// more and no signs, each digit and letter (1Z999AA1012).
fn code(core: &str, text: &str) -> Result<Vec<String>> {
    if core.bytes().all(|c| c.is_ascii_alphanumeric()) && core.bytes().any(|c| c.is_ascii_alphabetic()) && core.bytes().filter(|c| c.is_ascii_digit()).count() >= 6 {
        return Ok(core.chars().map(|c| if c.is_ascii_digit() { ONES[c as usize - '0' as usize].to_string() } else { spelled(&c.to_string()) }).collect());
    }
    let b: Vec<char> = core.chars().collect();
    let mut runs: Vec<(u8, String)> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let s = i;
        if b[i].is_ascii_digit() {
            while i < b.len() && (b[i].is_ascii_digit() || ((b[i] == '.' || b[i] == ',') && i + 1 < b.len() && b[i + 1].is_ascii_digit())) {
                i += 1;
            }
            runs.push((0, b[s..i].iter().collect()));
        } else if b[i].is_ascii_alphabetic() {
            while i < b.len() && b[i].is_ascii_alphabetic() {
                i += 1;
            }
            runs.push((1, b[s..i].iter().collect()));
        } else {
            i += 1;
            runs.push((2, b[s].to_string()));
        }
    }
    let mut out = Vec::new();
    let mut bad = Vec::new();
    let mut k = 0;
    while k < runs.len() {
        let (kind, r) = &runs[k];
        k += 1;
        if r == "^" {
            let minus = runs.get(k).map_or(false, |x| x.1 == "-") && runs.get(k + 1).map_or(false, |x| x.0 == 0);
            match runs.get(k + usize::from(minus)) {
                Some((0, d)) if all_digits(d) && d.len() <= 3 => {
                    if minus {
                        out.extend(ws("to the minus"));
                        out.extend(ws(&ordinal(d.parse().unwrap())));
                    } else if d == "2" || d == "3" {
                        out.push(if d == "2" { "squared" } else { "cubed" }.into());
                    } else {
                        out.extend(ws("to the"));
                        out.extend(ws(&ordinal(d.parse().unwrap())));
                    }
                    k += 1 + usize::from(minus);
                }
                _ => out.extend(ws("to the")),
            }
            continue;
        }
        if r == "_" {
            continue;
        }
        // Alt+F4
        if r == "+" && k >= 2 && runs[k - 2].0 == 1 && KEYS.contains(&runs[k - 2].1.to_ascii_lowercase().as_str()) && runs.get(k).map_or(false, |x| x.0 != 2) {
            continue;
        }
        match kind {
            0 => {
                let dash_letters = k > 2 && runs[k - 2].1 == "-" && runs[k - 3].0 == 1;
                let beside = (k > 1 && runs[k - 2].0 == 1) || runs.get(k).map_or(false, |x| x.0 == 1) || dash_letters;
                if beside && all_digits(r) {
                    out.extend(ws(&code_digits(r)));
                } else {
                    match figure(r)? {
                        Some(w) => out.extend(w),
                        None => bad.extend(r.chars().filter(|c| !c.is_ascii_digit())),
                    }
                }
            }
            1 => match humps(r) {
                Some(h) => out.extend(h),
                None => out.push(code_letters(r)),
            },
            _ => {
                let c = r.chars().next().unwrap();
                let note = k >= 2 && runs[k - 2].0 == 1 && ["A", "B", "C", "D", "E", "F", "G"].contains(&runs[k - 2].1.as_str());
                let between = k >= 2 && runs[k - 2].0 != 2 && runs.get(k).map_or(false, |x| x.0 != 2);
                match SAID.iter().find(|(s, _)| *s == c) {
                    Some((_, w)) => out.extend(ws(w)),
                    None if c == '/' => out.push("slash".into()),
                    None if c == '#' => out.push(if note { "sharp" } else { "number" }.into()),
                    None if c == '-' && between => {}
                    None => bad.push(c),
                }
            }
        }
    }
    if !bad.is_empty() {
        bad.sort();
        bad.dedup();
        return err(format!("characters outside the front end: {bad:?} in {text:?}"));
    }
    Ok(out)
}

/// A Roman numeral of I, V, X and L, as written the usual way, and its value.
fn roman(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|c| b"IVXL".contains(&c)) {
        return None;
    }
    let v = |c: u8| match c { b'I' => 1i64, b'V' => 5, b'X' => 10, _ => 50 };
    let b = s.as_bytes();
    let mut n = 0i64;
    for k in 0..b.len() {
        let x = v(b[k]);
        if k + 1 < b.len() && x < v(b[k + 1]) { n -= x } else { n += x }
    }
    if n <= 0 {
        return None;
    }
    let mut m = n as u64;
    let mut canon = String::new();
    for (val, r) in [(50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")] {
        while m >= val {
            canon.push_str(r);
            m -= val;
        }
    }
    (canon == s && n < 90).then_some(n as u64)
}

/// A Roman numeral after a name or a capitalized word that numbers things: Henry VIII the eighth,
/// World War II two, Rocky III three. One letter only after such a name or word; I only after a
/// title and a name (King Charles I), or such a word and not before a word as the pronoun is (Book
/// I mean); never XL.
fn roman_words(core: &str, punct: &str, at: &Around) -> Option<Vec<String>> {
    let n = roman(core)?;
    let (pc, pp) = at.prev?;
    if !pp.is_empty() || core == "XL" {
        return None;
    }
    let royal = at.prev2.map_or(false, |(c, p)| p.is_empty() && ROYAL.contains(&c));
    if (REGNAL.contains(&pc) || (royal && is_title_case(pc))) && (core != "I" || royal) {
        let mut w = vec!["the".to_string()];
        w.extend(ws(&ordinal(n)));
        return Some(w);
    }
    let pronoun = core == "I"
        && punct.is_empty()
        && at.nxt.map_or(false, |(c, _)| is_lower(c) && !["and", "or", "of"].contains(&c))
        && !(pc == "War" && at.prev2 == Some(("World", "")));
    if (is_title_case(pc) && DESIGNATORS.contains(&pc.to_ascii_lowercase().as_str()) && !pronoun) || (core.len() >= 2 && is_title_case(pc)) {
        return Some(ws(&cardinal(n)));
    }
    None
}

fn domain(s: &str) -> bool {
    let host = s.split('/').next().unwrap();
    let host = host.split_once(':').filter(|(_, p)| all_digits(p)).map_or(host, |(h, _)| h);
    let labels: Vec<&str> = host.split('.').collect();
    let tld = labels[labels.len() - 1];
    labels.len() >= 2
        && labels.iter().all(|l| !l.is_empty() && l.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
        && (TLD_WORDS.contains(&tld) || TLD_SPELLED.contains(&tld))
        && labels[0].bytes().any(|c| c.is_ascii_alphabetic())
}

/// An IP address with a port or a path: 127.0.0.1:8080.
fn ip_port(s: &str) -> bool {
    let Some(k) = s.find([':', '/']) else { return false };
    let g: Vec<&str> = s[..k].split('.').collect();
    g.len() == 4 && g.iter().all(|x| all_digits(x) && x.len() <= 3 && x.parse::<u64>().unwrap() <= 255)
}

/// A web address or an email as said: jane dot doe at example dot com; W W W dot example dot org
/// slash about; localhost colon thirty thirty, a port as a code has it. None if core is neither.
fn web(core: &str, text: &str) -> Result<Option<Vec<String>>> {
    let low = core.to_ascii_lowercase();
    let body = low.strip_prefix("https://").or_else(|| low.strip_prefix("http://"));
    let mail = low.split_once('@').map_or(false, |(l, d)| !l.is_empty() && domain(d) && !d.contains('/'));
    let local = low.starts_with("localhost:") || low.starts_with("localhost/") || ip_port(&low);
    if !(body.is_some() || low.starts_with("www.") || mail || local || domain(&low)) {
        return Ok(None);
    }
    let s = body.unwrap_or(&low).trim_end_matches('/');
    let b: Vec<char> = s.chars().collect();
    let host_end = if mail { b.len() } else { b.iter().position(|&c| c == '/').unwrap_or(b.len()) };
    let mut out = Vec::new();
    let mut bad = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let st = i;
        if b[i].is_ascii_alphanumeric() {
            while i < b.len() && b[i].is_ascii_alphanumeric() {
                i += 1;
            }
            let r: String = b[st..i].iter().collect();
            if r == "www" || (i == host_end && TLD_SPELLED.contains(&r.as_str())) {
                out.push(spelled(&r));
            } else if i == host_end && TLD_WORDS.contains(&r.as_str()) {
                out.push(r);
            } else if all_digits(&r) && st > 0 && b[st - 1] == ':' {
                out.extend(ws(&code_digits(&r)));
            } else if all_digits(&r) {
                out.extend(ws(&integer(&r, false)?));
            } else if r.bytes().any(|c| c.is_ascii_digit()) {
                out.extend(code(&r, text)?);
            } else if !r.bytes().any(|c| b"aeiouy".contains(&c)) {
                out.push(spelled(&r));
            } else {
                out.push(r);
            }
        } else {
            match WEB_SAID.iter().find(|(c, _)| *c == b[i]) {
                Some((_, w)) => out.extend(ws(w)),
                None => bad.push(b[i]),
            }
            i += 1;
        }
    }
    if !bad.is_empty() {
        bad.sort();
        bad.dedup();
        return err(format!("characters outside the front end: {bad:?} in {text:?}"));
    }
    Ok(Some(out))
}

/// One stop for a run of them: a question or an exclamation wins, else the last.
fn stop_of(run: &str) -> String {
    if run.contains('?') {
        "?".into()
    } else if run.contains('!') {
        "!".into()
    } else {
        run[run.len() - 1..].into()
    }
}

fn spelled(letters: &str) -> String {
    letters.chars().map(|c| format!("_{}", c.to_ascii_uppercase())).collect()
}

fn is_upper(s: &str) -> bool {
    s.chars().any(|c| c.is_ascii_uppercase()) && !s.chars().any(|c| c.is_ascii_lowercase())
}

pub fn is_lower(s: &str) -> bool {
    s.chars().any(|c| c.is_ascii_lowercase()) && !s.chars().any(|c| c.is_ascii_uppercase())
}

/// Prefixes a capital follows inside one name (McDonald, DiCaprio, LeBron).
const NAME_PREFIXES: [&str; 10] = ["Mc", "Mac", "Le", "La", "De", "Di", "Da", "Du", "Van", "Von"];

/// A word written in humps (OpenAI, ChatGPT, iPhone, macOS, APIs) as the words in it, or None: a
/// capital after a lowercase letter starts a word, as does the last of a run of capitals before a
/// lowercase letter, but a final s after capitals is their plural and a final capital vowel after
/// lowercase stays (AbilenA). Each as code_letters has it, a plural or a final 's on capitals as the
/// possessive. A name after a prefix, in title case or three or more capitals, stays one word. A part
/// with no vowel is spelled unless in capitals (Ph in PhD), as are its capitals (SQL).
fn humps(t: &str) -> Option<Vec<String>> {
    let (stem, poss) = match t.strip_suffix("'s") {
        Some(s) => (s, true),
        None => (t, false),
    };
    let b = stem.as_bytes();
    if b.is_empty()
        || !b.iter().all(|c| c.is_ascii_alphabetic())
        || !b[1..].iter().any(|c| c.is_ascii_uppercase())
        || !b.iter().any(|c| c.is_ascii_lowercase())
        || NAME_PREFIXES.iter().any(|p| stem.strip_prefix(p).is_some_and(|r| is_title_case(r) || (r.len() >= 3 && is_upper(r))))
    {
        return None;
    }
    let n = b.len();
    let mut cuts = vec![0];
    for i in 1..n {
        let (a, c) = (b[i - 1], b[i]);
        let before_lower = i + 1 < n && b[i + 1].is_ascii_lowercase() && !(i + 2 == n && b[i + 1] == b's');
        let vowel_end = i + 1 == n && b"AEIOUY".contains(&c);
        if (a.is_ascii_lowercase() && c.is_ascii_uppercase() && !vowel_end) || (a.is_ascii_uppercase() && c.is_ascii_uppercase() && before_lower) {
            cuts.push(i);
        }
    }
    cuts.push(n);
    let last = cuts.len() - 2;
    Some(
        (0..=last)
            .map(|k| {
                let p = &stem[cuts[k]..cuts[k + 1]];
                let m = p.len();
                let letters = m == 1 || !(is_upper(p) || p.bytes().any(|c| b"aeiouy".contains(&c.to_ascii_lowercase())));
                if poss && k == last {
                    format!("{}'s", if is_upper(p) || letters { p.to_ascii_uppercase() } else { p.to_ascii_lowercase() })
                } else if m >= 2 && p.ends_with('s') && is_upper(&p[..m - 1]) {
                    format!("{}'s", &p[..m - 1])
                } else if letters {
                    spelled(p)
                } else {
                    code_letters(p)
                }
            })
            .collect(),
    )
}

/// Words and stops in a chunk with no numbers. A word in capitals keeps them, one in humps is
/// parted (humps); a capital beside a sign is spelled (Q&A). Signs between words as words (& and, + plus, C# sharp, #tag hashtag,
/// his/her or); * for emphasis, - and _ between words are not said.
fn scan(core: &str, text: &str) -> Result<Vec<String>> {
    let b: Vec<char> = core.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut bad = Vec::new();
    let mut i = 0;
    let letter = |i: usize| i < b.len() && b[i].is_ascii_alphabetic();
    while i < b.len() {
        if letter(i) {
            let s = i;
            while letter(i) {
                i += 1;
            }
            while i < b.len() && b[i] == '\'' && letter(i + 1) {
                i += 1;
                while letter(i) {
                    i += 1;
                }
            }
            if i < b.len() && b[i] == '\'' {
                i += 1;
            }
            let t: String = b[s..i].iter().collect();
            let letters: String = t.chars().filter(|&c| c != '\'').collect();
            let caps = letters.len() >= 2 && (is_upper(&letters) || (t.ends_with("'s") && is_upper(&t[..t.len() - 2].replace('\'', ""))));
            let signed = (s > 0 && "&+/#".contains(b[s - 1])) || (i < b.len() && "&+/#".contains(b[i]));
            let owner = t.strip_suffix("'s").filter(|b| lookup(&HUMPED, b).is_some());
            if let Some(w) = lookup(&HUMPED, owner.unwrap_or(&t)) {
                let mut v = ws(w);
                // VMware's, PostgreSQL's
                if owner.is_some() {
                    let last = v.pop().unwrap();
                    v.push(format!("{}'s", last.replace('_', "")));
                }
                out.extend(v);
            } else if let Some(ws) = humps(&t) {
                out.extend(ws);
            } else {
                // M&Ms: a capital and its plural beside a sign
                let plural_letter = t.len() == 2 && b[s].is_ascii_uppercase() && b[s + 1] == 's' && s > 0 && b[s - 1] == '&';
                out.push(if caps || CASED.contains(&t.as_str()) {
                    t
                } else if t.len() == 1 && is_upper(&t) && signed {
                    spelled(&t)
                } else if plural_letter {
                    format!("{}'s", &t[..1])
                } else {
                    t.to_ascii_lowercase()
                });
            }
        } else if is_stop(b[i]) {
            let s = i;
            while i < b.len() && is_stop(b[i]) {
                i += 1;
            }
            out.push(stop_of(&b[s..i].iter().collect::<String>()));
        } else {
            let c = b[i];
            if c == '&' && i >= 1 && b[i - 1] == '&' {
                // a && b
            } else if c == '+'
                && out.last().map_or(false, |l| KEYS.contains(&l.to_ascii_lowercase().as_str()))
                && i + 1 < b.len()
                && b[i + 1].is_ascii_alphanumeric()
            {
                // Ctrl+C
            } else if let Some((_, w)) = SAID.iter().find(|(s, _)| *s == c) {
                out.extend(ws(w));
            } else if c == '#' && letter(i + 1) {
                out.push("hashtag".into());
            } else if c == '#' && i >= 1 && letter(i - 1) && !(i >= 2 && letter(i - 2)) && !letter(i + 1) {
                out.push("sharp".into());
            } else if c == '/'
                && i >= 1
                && b[i - 1].is_ascii_uppercase()
                && !(i >= 2 && letter(i - 2))
                && i + 1 < b.len()
                && b[i + 1].is_ascii_uppercase()
                && !letter(i + 2)
            {
                // A/C, I/O: a letter on each side, said as letters
                if let Some(l) = out.last_mut() {
                    if l.starts_with('_') {
                        l.push('_');
                        l.push(b[i + 1]);
                        i += 1;
                    }
                }
            } else if c == '/' && i >= 1 && letter(i - 1) && letter(i + 1) {
                if out.last().map_or(true, |w| w != "and") {
                    out.push("or".into());
                }
            } else if c == '#' {
                out.push("number".into());
            } else if c == MICRO || c == OHM {
                out.push(if c == MICRO { "mu" } else { "omega" }.into());
            } else if c == '^' {
                out.extend(ws("to the"));
            } else if !(c.is_whitespace() || c == '\'' || c == '-' || c == '*' || c == '_') && !bad.contains(&c) {
                bad.push(c);
            }
            i += 1;
        }
    }
    if !bad.is_empty() {
        bad.sort();
        return err(format!("characters outside the front end: {bad:?} in {text:?}"));
    }
    Ok(out)
}

fn is_dotted(core: &str) -> bool {
    let b = core.as_bytes();
    b.len() >= 3 && b.len() % 2 == 1 && b.iter().enumerate().all(|(i, c)| if i % 2 == 0 { c.is_ascii_alphabetic() } else { *c == b'.' })
}

fn ampm(nxt: &str) -> Option<(char, &str)> {
    let b = nxt.as_bytes();
    if b.len() >= 2 && b"aApP".contains(&b[0]) && b"mM".contains(&b[1]) && nxt[2..].chars().all(is_stop) {
        Some(((b[0] as char).to_ascii_lowercase(), &nxt[2..]))
    } else {
        None
    }
}

/// Text as ASCII, SIGNS kept; an error names what the front end cannot read. An en dash between
/// digits is a hyphen (1914\u{2013}1918); superscripts after a digit or a bracket are a power (10^6), \u{00b2}
/// and \u{00b3} after a letter too (m^2), others after a letter footnotes, not said; mu as MICRO and the
/// ohm sign as OHM; Greek letters by name; emoji and pictographs a space.
fn ascii(text: &str) -> Result<String> {
    let t: Vec<char> = text.chars().collect();
    let sup = |c: char| SUPERSCRIPTS.iter().find(|(k, _)| *k == c).map(|(_, v)| *v);
    let mut s = String::with_capacity(text.len());
    let mut bad = Vec::new();
    let mut i = 0;
    while i < t.len() {
        let c = t[i];
        if c == '\u{2013}' && i > 0 && t[i - 1].is_ascii_digit() && t.get(i + 1).map_or(false, |n| n.is_ascii_digit() || CURRENCIES.iter().any(|(m, _)| m == n)) {
            s.push('-');
        } else if sup(c).is_some() {
            let st = i;
            let mut run = String::new();
            while let Some(d) = t.get(i).and_then(|&c| sup(c)) {
                run.push(d);
                i += 1;
            }
            let before = if st > 0 { t[st - 1] } else { ' ' };
            if before.is_ascii_digit() || before == ')' || (before.is_ascii_alphabetic() && (run == "2" || run == "3")) {
                s.push('^');
                s.push_str(&run);
            }
            continue;
        } else if c.is_ascii() || SIGNS.contains(&c) {
            s.push(c);
        } else if c == '\u{03bc}' {
            s.push(MICRO);
        } else if c == '\u{2126}' {
            s.push(OHM);
        } else if let Some((_, m)) = CHARS.iter().chain(TYPO.iter()).find(|(k, _)| *k == c) {
            s.push_str(m);
        } else if let Some((_, m)) = GREEK.iter().find(|(k, _)| *k == c) {
            s.push_str(&format!(" {m} "));
        } else if pictograph(c) {
            s.push(' ');
        } else if !bad.contains(&c) {
            bad.push(c);
        }
        i += 1;
    }
    if !bad.is_empty() {
        bad.sort();
        return err(format!("characters outside the front end: {bad:?} in {text:?}"));
    }
    Ok(s)
}

/// Marks not said, or said otherwise. At a line's start: a quote's > (before a space), a heading's
/// hashes (the heading then between full stops), a bullet (- * +). A comma before a bullet, or where
/// lines change from quote to not, if the line before has no stop. Citations ([1], [a], [citation needed]) and emoticons, as whole words, not said;
/// backticks a space; a bar a comma; arrows (-> =>) and comparisons (>= <= !=) set apart.
fn marks(s: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut was = 0;
    for line in s.split('\n') {
        let mut t = line.trim_start_matches([' ', '\t']);
        let mut kind = 0;
        while let Some(q) = t.strip_prefix('>').filter(|q| q.is_empty() || q.starts_with([' ', '\t', '>'])) {
            t = q.trim_start_matches([' ', '\t']);
            kind = 2;
        }
        let h = t.len() - t.trim_start_matches('#').len();
        if (1..=6).contains(&h) && t[h..].starts_with(' ') {
            let body = t[h + 1..].trim_end_matches([' ', '\t', '\r']);
            let stop = !body.is_empty() && !body.ends_with(is_stop);
            lines.push(format!(". {body}{}", if stop { "." } else { "" }));
            was = 3;
            continue;
        }
        if t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ") {
            t = &t[2..];
            kind = 1;
        }
        let stopped = lines.last().map_or(true, |l| l.trim_end().ends_with(is_stop));
        let pause = !stopped && (kind == 1 || kind != was);
        lines.push(format!("{}{t}", if pause { ", " } else { "" }));
        was = kind;
    }
    let s = lines.join("\n");
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'[' {
            if let Some(k) = b[i + 1..].iter().position(|&c| c == b']' || c == b'[') {
                let inner = &s[i + 1..i + 1 + k];
                let cite = (1..=3).contains(&inner.len()) && all_digits(inner)
                    || (inner.len() == 1 && inner.as_bytes()[0].is_ascii_lowercase())
                    || inner.ends_with(" needed");
                if b[i + 1 + k] == b']' && cite {
                    i += k + 2;
                    continue;
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    let mut s = String::with_capacity(out.len());
    let mut word = String::new();
    for c in out.chars().chain(std::iter::once(' ')) {
        if c.is_whitespace() {
            if !word.is_empty() {
                s.push_str(if EMOTICONS.contains(&word.as_str()) { " " } else { &word });
                word.clear();
            }
            s.push(c);
        } else {
            word.push(c);
        }
    }
    s.pop();
    s.replace('`', " ").replace('|', " , ").replace("->", " -> ").replace("=>", " -> ").replace(">=", " >= ").replace("<=", " <= ").replace("!=", " != ")
}

/// A telephone number's area code in brackets, (617) 555-0199, as 617-555-0199.
fn area_codes(s: &str) -> String {
    let b = s.as_bytes();
    let d = |j: usize, n: usize| j + n <= b.len() && b[j..j + n].iter().all(|c| c.is_ascii_digit());
    let mut out = String::with_capacity(s.len());
    let (mut last, mut i) = (0, 0);
    while i < b.len() {
        if b[i] == b'(' && d(i + 1, 3) && b.get(i + 4) == Some(&b')') {
            let j = if b.get(i + 5) == Some(&b' ') { i + 6 } else { i + 5 };
            if d(j, 3) && b.get(j + 3) == Some(&b'-') && d(j + 4, 4) && !b.get(j + 8).map_or(false, |c| c.is_ascii_digit()) {
                out.push_str(&s[last..i]);
                out.push_str(&s[i + 1..i + 4]);
                out.push('-');
                out.push_str(&s[j..j + 8]);
                i = j + 8;
                last = i;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&s[last..]);
    out
}

/// A telephone number with a country code, its groups apart (+1 555 123 4567), as one word with
/// dashes between: + and 1 to 3 digits, then 2 to 5 groups of 2 to 4.
fn intl_phones(s: &str) -> String {
    let b = s.as_bytes();
    let run = |j: usize| b[j.min(b.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
    let mut out = String::with_capacity(s.len());
    let (mut last, mut i) = (0, 0);
    while i < b.len() {
        if b[i] == b'+' && (i == 0 || !b[i - 1].is_ascii_alphanumeric()) && (1..=3).contains(&run(i + 1)) {
            let mut j = i + 1 + run(i + 1);
            let mut groups = 0;
            while groups < 5 && j < b.len() && (b[j] == b' ' || b[j] == b'-') && (2..=4).contains(&run(j + 1)) {
                j += 1 + run(j + 1);
                groups += 1;
            }
            if groups >= 2 {
                out.push_str(&s[last..i]);
                out.push_str(&s[i..j].replace(' ', "-"));
                i = j;
                last = j;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&s[last..]);
    out
}

/// Quotes and brackets as spaces, but a double quote after a digit with no quote open is an inch
/// mark (12", 5'7"), and a letter in brackets after a number, or a letter or digit after that, part
/// of it (401(k), 501(c)(3)).
fn unquote(s: &str) -> String {
    let t: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut open = false;
    let mut prev = ' ';
    let mut glued = false;
    let mut i = 0;
    while i < t.len() {
        let c = t[i];
        let inner = t.get(i + 1).copied().unwrap_or(' ');
        let part = (prev.is_ascii_digit() && inner.is_ascii_alphabetic()) || (prev == ')' && glued && inner.is_ascii_alphanumeric());
        if c == '(' && part && t.get(i + 2) == Some(&')') {
            out.push(inner);
            prev = ')';
            glued = true;
            i += 3;
            continue;
        }
        glued = false;
        i += 1;
        if c == '"' {
            if !open && prev.is_ascii_digit() {
                out.push(c);
            } else {
                open = !open;
                out.push(' ');
            }
        } else if "()[]{}".contains(c) {
            out.push(' ');
        } else {
            out.push(c);
        }
        prev = c;
    }
    out
}

/// A day's short name with its dot read as the day: Wed, Sat and Sun only before a comma, a number
/// or a month, or after a word for when (through Sun.).
fn day_said(core: &str, punct: &str, at: &Around) -> bool {
    if !["Wed", "Sat", "Sun"].contains(&core) {
        return true;
    }
    let when = at.prev.map_or(false, |(c, p)| p.is_empty() && ["through", "thru", "until", "till", "til", "by"].contains(&c.to_ascii_lowercase().as_str()));
    when || punct[1..].starts_with(',') || at.nxt.map_or(false, |(c, _)| c.starts_with(|c: char| c.is_ascii_digit()) || month_of(c).is_some())
}

/// A day's short name with no dot read as the day: before a number or a month, Wed, Sat and Sun
/// only before a month, a time or a range of hours, or a comma and a number.
fn day_bare(core: &str, punct: &str, nxt: Option<(&str, &str)>) -> bool {
    let Some((c, _)) = nxt else { return false };
    let digit = c.starts_with(|c: char| c.is_ascii_digit());
    let month = is_title_case(c) && month_of(c).is_some();
    if !["Wed", "Sat", "Sun"].contains(&core) {
        return digit || month;
    }
    let first = c.split('-').next().unwrap();
    let (num, rest) = split_num(first);
    let time = time_of(first).is_some() || (ampm_suffix(rest).is_some() && (time_of(num).is_some() || hour(num)));
    // Sat 1-4 PM
    let hours = c.split_once('-').map_or(false, |(a, b)| (hour(a) || time_of(a).is_some()) && (hour(b) || time_of(b).is_some()));
    month || time || hours || (punct == "," && digit)
}

/// A day of the month as a number: 1 to 31.
fn day_num(c: &str) -> bool {
    all_digits(c) && c.len() <= 2 && (1..=31).contains(&c.parse::<u64>().unwrap())
}

/// A day of the month (1 to 31, 1st to 31st) or a year of four digits, after a month's short name.
fn day_or_year(c: &str) -> bool {
    let (num, rest) = split_num(c);
    (day_num(num) && (rest.is_empty() || ["st", "nd", "rd", "th"].contains(&rest)))
        || (all_digits(c) && c.len() == 4)
        || c.split_once('-').map_or(false, |(a, b)| day_num(a) && day_num(b))
}

/// A flag on a command line, spelled: -b dash B, -rf, -xvf; not a dash before a word (-and).
fn flag(core: &str) -> Option<Vec<String>> {
    let rest = core.strip_prefix('-')?;
    if rest.is_empty() || !rest.bytes().all(|c| c.is_ascii_lowercase()) || !(rest.len() <= 2 || unvoweled(rest)) {
        return None;
    }
    Some(vec!["dash".into(), spelled(rest)])
}

/// Fluid ounces and square units after a number, written fl oz, fl. oz., sq ft or sq. ft.
fn fluid(core: &str, punct: &str, at: &Around) -> Option<Vec<String>> {
    let count = |x: Option<(&str, &str)>| x.map_or(false, |(c, p)| p.is_empty() && quantity(c));
    let short = punct.is_empty() || punct == ".";
    let after = |w: &str| at.prev.map_or(false, |(c, p)| c == w && (p.is_empty() || p == ".")) && count(at.prev2);
    let one = at.prev2.map_or(false, |(c, _)| c == "1");
    match core {
        "fl" if short && count(at.prev) && at.nxt.map_or(false, |(c, _)| c == "oz") => Some(vec!["fluid".into()]),
        "oz" if after("fl") => Some(vec![if one { "ounce" } else { "ounces" }.into()]),
        "sq" if short && count(at.prev) && at.nxt.map_or(false, |(c, _)| unit(c, false).is_some()) => Some(vec!["square".into()]),
        u if after("sq") => unit(u, false).map(|(a, b)| ws(if one { a } else { b })),
        _ => None,
    }
}

/// A name in a path or after a dot: a file's name, else its parts with dot between (.env.local).
fn segment(p: &str, text: &str) -> Result<Vec<String>> {
    if let Some(w) = filename(p, text)? {
        return Ok(w);
    }
    let mut w = Vec::new();
    for (k, x) in p.split('.').enumerate() {
        if k > 0 {
            w.push("dot".into());
        }
        if !x.is_empty() {
            w.extend(if x.chars().any(|c| c.is_ascii_digit()) { numeric(x, false, &ALONE, text)?.0 } else { scan(x, text)? });
        }
    }
    Ok(w)
}

/// A path with slash between its parts: docs/api.md, /usr/local/bin, ~/code, ./run.sh. Only with a
/// slash at the start, ~ or dots before the first slash, or a known file at the end.
fn path(core: &str, text: &str) -> Result<Option<Vec<String>>> {
    let s = core.trim_end_matches('/');
    if !s.contains('/') || !s.bytes().all(|c| c.is_ascii_alphanumeric() || b"/._-~".contains(&c)) || !s.bytes().any(|c| c.is_ascii_alphabetic()) {
        return Ok(None);
    }
    let parts: Vec<&str> = s.split('/').collect();
    let rooted = parts[0].is_empty() || ["~", ".", ".."].contains(&parts[0]);
    if !rooted && filename(parts[parts.len() - 1], text)?.is_none() {
        return Ok(None);
    }
    let mut w = Vec::new();
    for (k, p) in parts.iter().enumerate() {
        if k > 0 {
            w.push("slash".into());
        }
        match *p {
            "" => {}
            "~" => w.push("tilde".into()),
            "." => w.push("dot".into()),
            ".." => w.extend(ws("dot dot")),
            _ => w.extend(segment(p, text)?),
        }
    }
    Ok(Some(w))
}

/// A name after a dot, as a hidden file has it: .env dot env, .gitignore.
fn dotfile(core: &str, text: &str) -> Result<Option<Vec<String>>> {
    let b = core.as_bytes();
    if b.len() < 2 || b[0] != b'.' || !b[1].is_ascii_alphabetic() || !b.iter().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(c)) {
        return Ok(None);
    }
    Ok(Some(segment(core, text)?))
}

/// A file's name: its stem said, then dot and a known extension (notes.txt, data.json, IMG_0042.JPG).
fn filename(core: &str, text: &str) -> Result<Option<Vec<String>>> {
    let parts: Vec<&str> = core.split('.').collect();
    let ext = parts[parts.len() - 1].to_ascii_lowercase();
    let known = lookup(&FILE_SAID, &ext).is_some() || FILE_SPELLED.contains(&ext.as_str());
    let named = |p: &&str| p.chars().any(|c| c.is_ascii_alphanumeric()) && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if parts.len() < 2 || !known || !parts.iter().all(named) {
        return Ok(None);
    }
    let mut w = Vec::new();
    for p in &parts[..parts.len() - 1] {
        w.extend(if p.chars().any(|c| c.is_ascii_digit()) { numeric(p, false, &ALONE, text)?.0 } else { scan(p, text)? });
        w.push("dot".into());
    }
    match lookup(&FILE_SAID, &ext) {
        Some(said) => w.extend(ws(said)),
        None if ext.chars().any(|c| c.is_ascii_digit()) => w.extend(code(&ext, text)?),
        None => w.push(spelled(&ext)),
    }
    Ok(Some(w))
}

pub fn words_and_stops(text: &str) -> Result<Vec<String>> {
    let s = unquote(&intl_phones(&area_codes(&marks(&ascii(text)?))).replace("--", " -- "));
    let chunks: Vec<&str> = s.split_whitespace().collect();
    let mut out: Vec<String> = Vec::new();
    let emit = |items: Vec<String>, out: &mut Vec<String>| {
        for it in items {
            // "the hashtag #tag" says it once
            if it == "hashtag" && out.last().map_or(false, |w| w == "hashtag") {
                continue;
            }
            if it.starts_with(is_stop) {
                if out.is_empty() {
                    continue;
                }
                let last = out.last_mut().unwrap();
                if last.starts_with(is_stop) {
                    *last = stop_of(&format!("{last}{it}"));
                    continue;
                }
            }
            out.push(it);
        }
    };
    let mut i = 0;
    while i < chunks.len() {
        let (core, mut punct) = split_stops(chunks[i]);
        let nxt = chunks.get(i + 1).copied();
        let at = Around {
            prev: (i > 0).then(|| split_stops(chunks[i - 1])),
            prev2: (i > 1).then(|| split_stops(chunks[i - 2])),
            nxt: nxt.map(split_stops),
            nxt_raw: nxt,
        };
        let cap_next = nxt.map_or(false, |n| n.starts_with(|c: char| c.is_ascii_uppercase()));
        let named_next = cap_next && !at.nxt.map_or(false, |(c, _)| OPENERS.contains(&c));
        let dot = punct.starts_with('.');
        let low = core.to_ascii_lowercase();
        // A, the letter: the article never comes before a stop or these.
        let letter_a = core == "A" && (!punct.is_empty() || at.nxt.map_or(true, |(c, _)| ["and", "or", "vs", "versus", "->"].contains(&c)));
        let words: Vec<String>;
        let mut extra_punct = String::new();
        let mut took = false;
        if dot && (low == "e.g" || low == "i.e") {
            words = ws(if low == "e.g" { "for example" } else { "that is" });
            punct = &punct[1..];
        } else if is_dotted(core) || core == "Ph.D" {
            words = vec![spelled(&core.replace('.', ""))];
            if dot {
                punct = &punct[1..];
                if punct.is_empty() && nxt.is_none() {
                    extra_punct.push('.');
                }
            }
        } else if dot
            && core == "Dr"
            && at.prev.map_or(false, |(c, p)| p.is_empty() && is_title_case(c))
            && at.prev2.map_or(false, |(_, p)| !p.ends_with(['.', '!', '?']))
            && !(named_next && punct.len() == 1)
        {
            // Elm Dr. near the park; Dr. Patel
            words = vec!["drive".into()];
            punct = &punct[1..];
            if punct.is_empty() && (nxt.is_none() || cap_next) {
                extra_punct.push('.');
            }
        } else if dot
            && core == "v"
            && cap_next
            && at.prev.map_or(false, |(c, p)| p.is_empty() && c.starts_with(|c: char| c.is_ascii_uppercase()))
        {
            // Roe v. Wade
            words = vec!["versus".into()];
            punct = &punct[1..];
        } else if dot && lookup(&TITLES, core).is_some() {
            words = vec![lookup(&TITLES, core).unwrap().into()];
            punct = &punct[1..];
        } else if dot && lookup(&MIDS, core).is_some() {
            words = ws(lookup(&MIDS, core).unwrap());
            punct = &punct[1..];
            if punct.is_empty() && nxt.is_none() {
                extra_punct.push('.');
            }
        } else if dot && core == "St" {
            let saint = named_next && punct.len() == 1;
            words = vec![if saint { "saint" } else { "street" }.into()];
            punct = &punct[1..];
            if !saint && punct.is_empty() && (nxt.is_none() || cap_next) {
                extra_punct.push('.');
            }
        } else if dot && lookup(&SUFFIXES, core).is_some() {
            words = ws(lookup(&SUFFIXES, core).unwrap());
            punct = &punct[1..];
            let chained = at.nxt.map_or(false, |(c, p)| p.starts_with('.') && lookup(&SUFFIXES, c).is_some());
            if punct.is_empty() && (nxt.is_none() || cap_next) && !chained {
                extra_punct.push('.');
            }
        } else if dot && lookup(&DAYS, core).is_some() && day_said(core, punct, &at) {
            words = vec![lookup(&DAYS, core).unwrap().into()];
            punct = &punct[1..];
            let dated = at.nxt.map_or(false, |(c, _)| c.starts_with(|c: char| c.is_ascii_digit()) || month_of(c).is_some());
            if punct.is_empty() && !dated && (nxt.is_none() || cap_next) {
                extra_punct.push('.');
            }
        } else if punct == "." && core.len() == 1 && core.starts_with(|c: char| c.is_ascii_uppercase()) && cap_next {
            words = vec![spelled(core)];
            punct = "";
        } else if dot && lookup(&MONTHS, core).is_some() && nxt.map_or(false, |n| n.starts_with(|c: char| c.is_ascii_digit())) {
            words = vec![lookup(&MONTHS, core).unwrap().into()];
            punct = &punct[1..];
        } else if dot && core == "No" && nxt.map_or(false, |n| n.starts_with(|c: char| c.is_ascii_digit() || c == '$')) {
            words = vec!["number".into()];
            punct = &punct[1..];
        } else if dot && lookup(&NUMBERED, core).is_some() && nxt.map_or(false, |n| n.starts_with(|c: char| c.is_ascii_digit() || c == '#')) {
            words = ws(lookup(&NUMBERED, core).unwrap());
            punct = &punct[1..];
        } else if dot && core == "in" && at.prev.map_or(false, |(c, p)| p.is_empty() && (quantity(c) || c.split_once('-').map_or(false, |(a, b)| quantity(a) && quantity(b)))) {
            // 2-4 in. of snow
            let one = at.prev.map_or(false, |(c, _)| c == "1") || at.prev2.map_or(false, |(c, p)| p.is_empty() && (c.eq_ignore_ascii_case("a") || c.eq_ignore_ascii_case("an")));
            words = vec![if one { "inch" } else { "inches" }.into()];
            punct = &punct[1..];
            if punct.is_empty() && (nxt.is_none() || cap_next) {
                extra_punct.push('.');
            }
        } else if core == "exp" && at.prev.map_or(false, |(c, p)| p.is_empty() && ["yr", "yrs", "year", "years"].contains(&c)) {
            // 5+ yrs exp.
            words = vec!["experience".into()];
            if dot {
                punct = &punct[1..];
                if punct.is_empty() && (nxt.is_none() || cap_next) {
                    extra_punct.push('.');
                }
            }
        } else if punct.is_empty() && lookup(&MONTHS, core).is_some() && at.nxt.map_or(false, |(c, _)| day_or_year(c)) {
            words = vec![lookup(&MONTHS, core).unwrap().into()];
        } else if lookup(&MONTHS, core).is_some() && at.prev.map_or(false, |(c, p)| p.is_empty() && day_num(c)) {
            words = vec![lookup(&MONTHS, core).unwrap().into()];
            if dot {
                punct = &punct[1..];
                if punct.is_empty() && (nxt.is_none() || cap_next) {
                    extra_punct.push('.');
                }
            }
        } else if (punct.is_empty() || punct == ",") && lookup(&DAYS, core).is_some() && day_bare(core, punct, at.nxt) {
            words = vec![lookup(&DAYS, core).unwrap().into()];
        } else if core.is_empty() {
            words = vec![];
        } else if core == "-" || core == "--" {
            // A dash set apart: minus in a sum, to (and after between) in a range, else a pause.
            let joined = punct.is_empty() && at.prev.map_or(false, |(_, p)| p.is_empty());
            let num = |x: Option<(&str, &str)>| x.map_or(false, |(c, _)| c.starts_with(|c: char| c.is_ascii_digit() || CURRENCIES.iter().any(|(m, _)| *m == c)));
            let sum = chunks.get(i + 2).map_or(false, |n| split_stops(n).0 == "=");
            let between = at.prev2.map_or(false, |(c, p)| p.is_empty() && c.eq_ignore_ascii_case("between"));
            words = vec![if joined && sum {
                "minus"
            } else if joined && num(at.prev) && num(at.nxt) {
                if between { "and" } else { "to" }
            } else {
                ","
            }
            .into()];
        } else if core == "->" {
            let word = out.last().map_or(false, |w| !w.starts_with(is_stop));
            words = if word && nxt.is_some() { vec!["to".into()] } else { vec![] };
        } else if core == ">" && at.prev.map_or(false, |(c, p)| p.is_empty() && is_title_case(c)) && at.nxt.map_or(false, |(c, _)| is_title_case(c)) {
            // Settings > Privacy, a menu's path
            words = vec![",".into()];
        } else if let Some(w) = lookup(&COMPARE, core) {
            words = ws(w);
        } else if ["'n'", "'n", "n'"].contains(&low.as_str()) {
            words = vec!["'n".into()];
        } else if low == "w/" || low == "w/o" || low == "n/a" {
            words = vec![match low.as_str() { "w/" => "with".into(), "w/o" => "without".into(), _ => spelled("na") }];
        } else if core == "x"
            && punct.is_empty()
            && at.prev.map_or(false, |(c, p)| p.is_empty() && c.starts_with(|c: char| c.is_ascii_digit()) && c.ends_with(['\'', '"']))
            && nxt.map_or(false, |n| n.starts_with(|c: char| c.is_ascii_digit()))
        {
            // 12' x 15'
            words = vec!["by".into()];
        } else if (core == "x" || core == "*") && punct.is_empty() && at.prev.map_or(false, |(c, p)| p.is_empty() && quantity(c)) && nxt.map_or(false, |n| n.starts_with(|c: char| c.is_ascii_digit())) {
            words = vec!["times".into()];
        } else if core == "*" || core == "/" {
            words = vec![",".into()];
        } else if let Some(w) = party(core) {
            words = w;
        } else if core.len() == 2 && core.starts_with(['A', 'B', 'C', 'D', 'E', 'F', 'G']) && core.ends_with('b') && at.nxt.map_or(false, |(c, _)| NOTE_NEXT.contains(&c)) {
            // Bb major
            words = vec![spelled(&core[..1]), "flat".into()];
        } else if let Some(w) = address(core, punct, &at) {
            words = w;
        } else if let Some(w) = caps_word(core, punct, &at) {
            words = w;
        } else if let Some(w) = short_word(core, punct) {
            words = w;
        } else if let Some(w) = flag(core) {
            words = w;
        } else if let Some(w) = fluid(core, punct, &at) {
            words = w;
            if core == "fl" || core == "sq" || (punct == "." && nxt.map_or(false, |n| n.starts_with(|c: char| c.is_ascii_lowercase()))) {
                punct = "";
            }
        } else if let Some(w) = web(core, text)? {
            words = w;
        } else if let Some(w) = path(core, text)? {
            words = w;
        } else if let Some(w) = dotfile(core, text)? {
            words = w;
        } else if let Some(w) = filename(core, text)? {
            words = w;
        } else if let Some(w) = roman_words(core, punct, &at) {
            words = w;
        } else if let Some(w) = named_range(core) {
            words = w;
            // Mon.-Sat. 10am: the dot is the abbreviation's
            let last = core.rsplit('-').next().unwrap();
            if dot && (lookup(&DAYS, last).is_some() || lookup(&MONTHS, last).is_some()) {
                punct = &punct[1..];
                if punct.is_empty() && (nxt.is_none() || cap_next) {
                    extra_punct.push('.');
                }
            }
        } else if letter_a {
            words = vec![spelled(core)];
        } else if let Some((_, b)) = units(core, false).filter(|_| core.contains(['/', '^', MICRO, OHM])) {
            words = ws(&b);
        } else if core.chars().any(|c| c.is_ascii_digit()) || core.starts_with(|c: char| CURRENCIES.iter().any(|(m, _)| *m == c)) || core.ends_with('\u{00a2}') {
            let (w, t) = numeric(core, punct.is_empty(), &at, text)?;
            words = w;
            took = t;
        } else {
            words = scan(core, text)?;
        }
        if took {
            punct = at.nxt.unwrap().1;
            i += 1;
            if punct.starts_with('.') && chunks.get(i + 1).map_or(false, |n| n.starts_with(|c: char| c.is_ascii_lowercase())) {
                punct = &punct[1..];
            }
        }
        emit(words, &mut out);
        let p = format!("{punct}{extra_punct}");
        if !p.is_empty() {
            emit(vec![stop_of(&p)], &mut out);
        }
        i += 1;
    }
    Ok(out)
}

/// Letters with no vowel and none doubled, spelled if the lexicon lacks them (npm, tbh; not hmmm).
pub fn unvoweled(word: &str) -> bool {
    let b = word.as_bytes();
    b.len() >= 2 && b.iter().all(|c| c.is_ascii_lowercase() && !b"aeiouy".contains(c)) && b.windows(2).all(|p| p[0] != p[1])
}

/// Words to phones: the lexicon's first pronunciation, then the G2P (remembered).
pub struct Phonemizer {
    lex: Lexicon,
    letters: HashMap<char, Vec<&'static str>>,
    g2p: G2p,
    known: HashMap<String, Vec<&'static str>>,
    /// Words outside the lexicon and the G2P's phones for them, in the order first met.
    pub guessed: Vec<(String, Vec<&'static str>)>,
}

impl Phonemizer {
    pub fn new(lex: Lexicon, g2p: G2p) -> Result<Phonemizer> {
        if let Some(d) = lex.g2p() {
            if d != g2p.digest {
                return err(format!("the lexicon leaves words to the G2P with digest {d:016x}, not this one ({:016x})", g2p.digest));
            }
        }
        let mut letters = HashMap::new();
        for c in 'b'..='z' {
            let w = c.to_string();
            match lex.get(&w) {
                Some(p) if p.is_empty() => letters.insert(c, g2p.phones(&w)?),
                Some(p) => letters.insert(c, p),
                None => return err(format!("the lexicon lacks the letter {c}")),
            };
        }
        letters.insert('a', vec!["EY1"]);
        Ok(Phonemizer { lex, letters, g2p, known: HashMap::new(), guessed: Vec::new() })
    }

    fn spell(&self, letters: &str) -> Vec<&'static str> {
        letters.chars().flat_map(|c| self.letters[&c.to_ascii_lowercase()].iter().copied()).collect()
    }

    /// The lexicon's phones for word, from the G2P if it leaves them there.
    fn lexicon(&mut self, word: &str) -> Result<Option<Vec<&'static str>>> {
        match self.lex.get(word) {
            Some(p) if p.is_empty() => Ok(Some(self.g2p_phones(word, false)?)),
            p => Ok(p),
        }
    }

    fn g2p_phones(&mut self, word: &str, guess: bool) -> Result<Vec<&'static str>> {
        if let Some(p) = self.known.get(word) {
            return Ok(p.clone());
        }
        let p = self.g2p.phones(word)?;
        if p.is_empty() {
            return err(format!("G2P gave no phones for {word:?}"));
        }
        if guess {
            self.guessed.push((word.to_string(), p.clone()));
        }
        self.known.insert(word.to_string(), p.clone());
        Ok(p)
    }

    /// Spelled words letter by letter; a word in capitals from the lexicon if three letters or
    /// more, else spelled (a final 's as Z, after S, X or H as IH0 Z).
    pub fn phones(&mut self, word: &str) -> Result<Vec<&'static str>> {
        if word.starts_with('_') {
            return Ok(self.spell(&word.replace('_', "")));
        }
        if !is_lower(word) {
            let letters = word.replace('\'', "");
            let low = word.to_ascii_lowercase();
            if letters.len() >= 3 {
                if let Some(p) = self.lexicon(&low)? {
                    return Ok(p);
                }
            }
            if let Some(w) = word.strip_suffix("'s") {
                let mut p = self.spell(&w.replace('\'', ""));
                if p.last().map_or(false, |l| ["S", "Z", "SH", "ZH", "CH", "JH"].contains(l)) {
                    p.push("IH0");
                }
                p.push("Z");
                return Ok(p);
            }
            return Ok(self.spell(&letters));
        }
        if let Some(p) = self.lexicon(word)? {
            return Ok(p);
        }
        if unvoweled(word) {
            return Ok(self.spell(word));
        }
        self.g2p_phones(word, true)
    }

    /// Phones for word, at `low[i]` among the lowercase words and stops of what is said: a
    /// heteronym's by its sense there, else as phones() has them.
    pub fn phones_in(&mut self, word: &str, low: &[String], i: usize) -> Result<Vec<&'static str>> {
        if let Some(p) = hetero::cased(word, low, i) {
            return Ok(p);
        }
        if !word.starts_with('_') && (is_lower(word) || word.replace('\'', "").len() >= 3) {
            if let Some((_, p)) = hetero::choose(low, i) {
                return Ok(p);
            }
        }
        self.phones(word)
    }

    /// Token ids: ^ word (space word)* with stops after their words, then $.
    pub fn encode(&mut self, text: &str) -> Result<Vec<usize>> {
        let mut out = vec![BOS];
        let mut prev_word = false;
        let toks = words_and_stops(text)?;
        let low: Vec<String> = toks.iter().map(|t| t.to_ascii_lowercase()).collect();
        for (i, tok) in toks.iter().enumerate() {
            if let Some(id) = STOPS.iter().position(|s| s == tok) {
                out.push(4 + id);
                prev_word = false;
                continue;
            }
            if prev_word || out.len() > 1 {
                out.push(SPACE);
            }
            for p in self.phones_in(tok, &low, i)? {
                out.push(symbol_id(p).unwrap());
            }
            prev_word = true;
        }
        out.push(EOS);
        Ok(out)
    }
}
