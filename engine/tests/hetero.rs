// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Heteronyms: the sense chosen in sentences whose sense is plain, and the phones each reaches.

use lipservice::front::{self, words_and_stops, Phonemizer};
use lipservice::g2p::{G2p, PHONES};
use lipservice::hetero::{self, HETS};
use lipservice::inflect::Inflection;
use lipservice::lexicon::Lexicon;
use lipservice::ssml;
use lipservice::weights::Weights;

fn read(name: &str) -> Weights {
    Weights::read(&format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn phonemizer() -> Phonemizer {
    Phonemizer::new(Lexicon::load(&read("lexicon.lsw")).unwrap(), G2p::load(&read("g2p-i8.lsw")).unwrap()).unwrap()
}

/// sense, then the sentence with the word in brackets.
const CASES: &str = "
verb	We [live] here.
verb	Long [live] the king!
verb	Where do you [live]?
verb	They [live] in a small house.
verb	I want to [live] by the sea.
adj	Watch out for the [live] wire.
adj	The match was broadcast [live].
adj	It was a [live] recording of the concert.
adj	They caught a [live] mouse.
noun	Nine [lives] were lost.
noun	They saved many [lives].
noun	We risked our [lives].
noun	He wrote the [lives] of the saints.
verb	She [lives] in Paris.
verb	He [lives] alone.
verb	Who [lives] here?
verb	The evil that men do [lives] after them; the good is oft interred with their bones.
verb	Nobody knows how the other half [lives].
noun	Their [lives] after the war were hard.
noun	The doctors saved [lives] in the war.
noun	[Lives] were lost.
pres	I will [read] it tomorrow.
pres	Please [read] the letter aloud.
pres	Can you [read] this?
pres	I like to [read].
pres	[Read] the instructions first.
pres	Did you [read] it?
pres	Do you [read] French?
past	I have [read] that book.
past	She [read] the letter yesterday.
past	The book was [read] by millions.
past	He had [read] it twice.
past	Have you [read] it?
verb	Please [close] the door.
verb	They will [close] the shop at noon.
verb	[Close] your eyes.
verb	The bank is going to [close].
verb	We reached the [close] of the day.
adj	Stay [close] to me.
adj	The station is [close] to the hotel.
adj	We are [close] friends.
adj	That was a [close] call.
adj	He came [close] to winning.
verb	I [use] a pen.
verb	You can [use] my car.
verb	How do you [use] this?
verb	We [use] it every day.
noun	It is no [use].
noun	The tool has many [uses].
verb	She [uses] a pen.
noun	The [use] of force is wrong.
noun	It is for daily [use].
noun	Make good [use] of your time.
noun	What is the [use]?
to	He [used] to sing.
to	We [used] to live there.
to	I am [used] to it.
to	She got [used] to the noise.
verb	It was [used] to cut wood.
verb	He [used] a knife.
verb	They bought a [used] car.
verb	The money was [used] for food.
verb	[Excuse] me, sir.
verb	Please [excuse] my rudeness.
noun	There is no [excuse].
noun	That is a poor [excuse].
noun	He always has his [excuses].
verb	She [excuses] herself.
verb	Do not [abuse] the privilege.
noun	It was an [abuse] of power.
noun	We fought the [abuses] of the old order.
verb	He [abuses] his power.
noun	The [house] is big.
noun	We bought a [house] by the lake.
verb	The building will [house] two hundred people.
verb	They built camps to [house] the refugees.
noun	Open your [mouth].
verb	He would [mouth] the words.
z	Many [houses] burned.
noun	The [wind] blew hard.
noun	A cold [wind] came from the north.
verb	Do not forget to [wind] the clock.
verb	You must [wind] the watch.
noun	The [winds] howled all night.
verb	The road [winds] along the river.
verb	The path [winds] through the woods.
injury	He had a [wound] in his side.
injury	The [wound] healed slowly.
injury	He died of his [wound].
wound-up	He [wound] the rope around the post.
wound-up	She [wound] up the clock.
wound-up	The road [wound] through the hills.
cry	A [tear] rolled down her cheek.
rip	Do not [tear] the page.
rip	He began to [tear] the letter.
cry	[Tears] ran down her face.
cry	She burst into [tears].
cry	He was in [tears].
rip	He [tears] the paper.
verb	You [lead] the way.
verb	She will [lead] the team.
verb	This road will [lead] you home.
metal	The pipes are made of [lead].
metal	It was as heavy as [lead].
bend	He took a [bow].
bend	They [bow] to the queen.
ribbon	He drew his [bow] and arrow.
ribbon	She tied a [bow] in her hair.
bend	He [bows] to the queen.
ribbon	They carried [bows] and arrows.
bend	He was [bowing] to the crowd.
bird	A white [dove] flew past.
dived	He [dove] into the water.
plant	You reap what you [sow].
pig	The [sow] fed her piglets.
line	They lived in a [row] of houses.
line	He won three games in a [row].
quarrel	They had a [row] about money.
music	He plays the [bass].
music	She bought a [bass] guitar.
fish	He caught a striped [bass].
verb	He [does] his best.
verb	What [does] it mean?
deer	We saw the [does] and the bucks.
adj	It was a [perfect] day.
adj	It was [perfect].
verb	She worked to [perfect] the technique.
verb	You must [perfect] your aim.
put	He is [putting] it away.
before	[Four] men came.
before	I have [four] dogs.
before	Meet me at [four] o'clock.
end	[Four].
end	One, two, three, [four].
end	I counted [four], then stopped.
before	The cabin was [fore] and aft.
end	He came to the [fore].
time	Wait a [minute].
time	I will be there in a [minute].
tiny	He told it in [minute] detail.
tiny	The grains were extremely [minute].
noun	We live in the [present] day.
noun	She bought him a birthday [present].
noun	There is nothing to do at [present].
verb	She will [present] the award.
verb	We will [present] our findings.
noun	She opened her [presents].
verb	He [presents] the news.
noun	Let us change the [subject].
noun	She was the [subject] of the talk.
verb	They would [subject] him to torture.
noun	He was loved by his [subjects].
verb	He [subjects] them to tests.
verb	I [object] to that.
verb	Do you [object]?
noun	He found a strange [object].
noun	That was the [object] of the game.
noun	She collects small [objects].
verb	She [objects] to the plan.
adj	He was [content].
adj	She seemed [content] to wait.
noun	He read the [content] of the book.
noun	The [content] is free.
noun	We made [progress].
noun	The work is in [progress].
verb	They hope to [progress] to the next level.
noun	What is your email [address]?
verb	We must [address] the problem.
verb	He will [address] the crowd.
verb	I [refuse] to go.
verb	They [refuse] it.
noun	The streets were full of [refuse].
noun	They crossed the [desert].
noun	He was lost on a [desert] island.
verb	Do not [desert] me.
noun	We drove through the [deserts] of Arizona.
verb	He [deserts] his post.
noun	She sells fresh [produce].
verb	The factory will [produce] cars.
verb	They [produce] wine.
noun	He set a world [record].
noun	Let me say for the [record] that I was there.
verb	She wants to [record] a song.
verb	Please [record] this.
verb	We [record] every call.
noun	The [records] show that he was there.
verb	She [records] everything.
noun	In [contrast], the sea was calm.
verb	We will [contrast] the two.
noun	The [conflict] ended in spring.
verb	They [conflict] with each other.
noun	He was a [rebel] leader.
verb	The people will [rebel].
noun	The [rebels] fled.
verb	He [rebels] against authority.
noun	She won a singing [contest].
verb	We will [contest] the result.
noun	Sign the [contract].
verb	They [contract] in the cold.
noun	It is a chemical [compound].
verb	This will [compound] the problem.
adj	The ticket is [invalid].
adj	He typed an [invalid] password.
noun	Patience is a key [attribute].
verb	We [attribute] it to luck.
noun	He has many fine [attributes].
verb	She [attributes] it to luck.
noun	It was a peaceful [protest].
verb	We [protest] the decision.
noun	The [protests] continued.
verb	He [protests] too much.
noun	The [converse] is also true.
verb	We [converse] in French.
noun	It was a school [project].
verb	We will [project] the image on the wall.
noun	She has two new [projects].
verb	She [projects] confidence.
noun	He was an escaped [convict].
verb	The jury will [convict] him.
noun	The [convicts] escaped.
verb	It [convicts] him.
noun	Add a spoon of vanilla [extract].
verb	The dentist had to [extract] a tooth.
noun	He was born with [defects] of the heart.
verb	He [defects] to the west.
noun	He was a new [convert].
verb	We must [convert] the file.
noun	He bought a game [console].
verb	She tried to [console] her.
noun	She opened her powder [compact].
verb	They [compact] the soil.
noun	He spoke with a French [accent].
verb	You should [accent] the first syllable.
noun	The children played during [recess].
verb	The court will [recess].
noun	She was a close [ally].
verb	They chose to [ally] with France.
noun	We met our [allies].
verb	He [allies] himself with them.
noun	There was an [increase] in price.
noun	We saw a sharp [increase].
verb	Prices will [increase].
verb	We need to [increase] sales.
noun	There were [increases] in cost.
verb	It [increases] the risk.
noun	There was a [decrease] in sales.
verb	You must [decrease] the dose.
adj	He was a [learned] man.
verb	She [learned] to swim.
verb	I have [learned] a lot.
adj	[Blessed] are the meek.
verb	She [blessed] them.
adj	It was a [blessed] event.
adj	He found a [cursed] ring.
verb	He [cursed] loudly.
adj	She is my [beloved] wife.
verb	He was [beloved] by all.
adj	He cared for an [aged] man.
verb	He [aged] quickly.
adj	He worked with [dogged] determination.
verb	He was [dogged] by bad luck.
adj	She has a [separate] room.
verb	We had to [separate] them.
verb	[Separate] the eggs.
noun	It is a rough [estimate].
verb	We need to [estimate] the cost.
verb	We [estimate] the cost at ten dollars.
adj	Add a [moderate] amount of salt.
verb	She will [moderate] the debate.
noun	He is a college [graduate].
verb	She will [graduate] in June.
adj	He is an [intimate] friend.
verb	He meant to [intimate] that he knew.
adj	It was a [deliberate] act.
verb	The jury will [deliberate].
adj	That is an [appropriate] response.
verb	They tried to [appropriate] the funds.
adj	What is the [approximate] cost?
verb	We can [approximate] the curve.
noun	She is a business [associate].
verb	I [associate] it with summer.
noun	He is an [advocate] for change.
verb	We [advocate] reform.
adj	They meet on [alternate] days.
verb	You can [alternate] between them.
noun	She was a [delegate] to the convention.
verb	You must [delegate] tasks.
noun	He made a [duplicate] of the key.
verb	Can you [duplicate] the key?
adj	They made an [elaborate] plan.
verb	Please [elaborate].
adj	He is an [articulate] speaker.
verb	He tried to [articulate] his ideas.
adj	The rock is not an [animate] being.
verb	She wants to [animate] the drawing.
adj	It is a [subordinate] clause.
verb	He would [subordinate] his wishes to hers.
adj	He was a [degenerate] gambler.
verb	Things began to [degenerate].
noun	The [ally] stood firm.
noun	The [invalid] was carried in a chair.
noun	The latest [update] fixes the bug.
verb	Please [update] the app.
noun	Check for [updates].
verb	It [updates] every hour.
noun	An [upgrade] is available.
verb	[Upgrade] to Pro for more storage.
noun	Free [upgrades] for members.
verb	She [upgrades] her phone every year.
noun	You will get a full [refund].
verb	We will [refund] your money.
noun	Your [refunds] will arrive in a week.
verb	He [refunds] the fee.
noun	The bank [transfer] went through.
verb	[Transfer] money to your savings.
noun	Wire [transfers] take a day.
verb	She [transfers] the files.
noun	Please take our short [survey].
verb	They came to [survey] the damage.
noun	The [surveys] were sent last week.
verb	He [surveys] the room.
noun	The [suspect] fled on foot.
verb	I [suspect] he is lying.
noun	Two [suspects] were charged.
verb	She [suspects] nothing.
noun	You need a parking [permit].
verb	We do not [permit] smoking.
noun	Building [permits] take months.
verb	We'll go if time [permits].
noun	Students get a ten percent [discount].
verb	Don't [discount] the risk.
noun	The [impact] was huge.
verb	This will [impact] millions of people.
noun	The [import] failed.
verb	You can [import] a CSV file.
noun	[Imports] rose last month.
verb	It [imports] the data.
noun	[Export] controls were tightened.
verb	[Export] to PDF.
noun	[Exports] fell by ten percent.
verb	It [exports] the data.
verb	[Insert] the card into the slot.
noun	Press the [insert] key.
verb	I don't [recall] saying that.
noun	The car maker issued a [recall].
verb	It takes time to [digest] the news.
noun	Sign up for our weekly [digest].
noun	That was an [insult].
verb	Don't [insult] my intelligence.
noun	Their remarks were [insults].
verb	He [insults] everyone.
noun	He arrived with a police [escort].
verb	Guards will [escort] you out.
noun	Do a factory [reset].
verb	[Reset] your password.
noun	The script needs a [rewrite].
verb	We had to [rewrite] the code.
noun	The [refill] costs a dollar.
verb	[Refill] your glass.
noun	Here's a [recap] of the week.
verb	Let me [recap] the main points.
noun	The code of [conduct] applies to everyone.
verb	We will [conduct] a survey.
noun	He died in [combat].
verb	We must [combat] climate change.
noun	It was a [torment] to wait.
verb	Don't [torment] the cat.
noun	Send me an [invite].
verb	I'd like to [invite] you to dinner.
noun	All the [invites] went out.
verb	She [invites] us every year.
noun	He is a recovering [addict].
verb	Try not to [addict] them to sugar.
noun	Many [addicts] seek treatment.
adj	She was [upset] about the news.
noun	They pulled off a stunning [upset].
noun	Update your [resume] before you apply.
verb	We will [resume] at noon.
noun	We got a hundred [resumes].
verb	Play [resumes] at three.
noun	A birth [defect] can be detected early.
verb	Two players threatened to [defect] to the rival club.
noun	Hackers used a zero day [exploit] to get in.
verb	Scammers [exploit] people's fear of missing out.
verb	The malware [exploits] a flaw in the browser.
noun	His [exploits] in the war became legend.
noun	Gender is a social [construct].
verb	Engineers plan to [construct] a new bridge.
verb	The company [constructs] bridges and tunnels.
noun	These mental [constructs] shape how we think.
noun	Public [transport] is free on weekends.
verb	Trucks [transport] goods across the country.
verb	The ship [transports] cars to Europe.
noun	The troop [transports] were sunk.
noun	The next [segment] is about climate change.
verb	Marketers [segment] customers by age and income.
noun	The show has three [segments].
verb	The tool [segments] images automatically.
noun	The patient's [discharge] was delayed.
verb	The hospital will [discharge] him tomorrow.
noun	Apply a cold [compress] to the swelling.
verb	[Compress] the files before you upload them.
noun	Carbon [offset] programs are popular with airlines.
noun	The press used [offset] printing.
verb	Savings will [offset] the higher cost.
noun	The [regress] went on forever.
verb	Patients may [regress] under stress.
noun	A buffer [overflow] can crash the program.
verb	Don't let the sink [overflow].
noun	A manual [override] is available.
verb	Congress voted to [override] the veto.
verb	The child class [overrides] the parent method.
noun	The system logs all manual [overrides].
noun	There is some [overlap] between the two courses.
verb	The circles [overlap] in the middle.
verb	His schedule [overlaps] with mine.
noun	Remove the [overlaps] before printing.
noun	The engine needs a complete [overhaul].
verb	We need to [overhaul] our hiring process.
noun	The road has a steep [incline].
verb	I [incline] to agree with you.
noun	The country was in political [ferment].
verb	Let the dough [ferment] overnight.
noun	They lived on a [commune] in the sixties.
verb	She went outside to [commune] with nature.
noun	The [conscript] army was poorly trained.
verb	The country began to [conscript] young men.
noun	He grabbed the [rebound] and scored.
verb	Prices should [rebound] next quarter.
verb	[Combine] the flour and sugar in a bowl.
noun	The farmer drove a [combine] harvester.
noun	The [combine] broke down in the field.
verb	Several factors [combine] to cause the delay.
noun	All [proceeds] go to charity.
verb	He then [proceeds] to explain the rules.
verb	Talks [progress] slowly.
noun	Watch our [progress] this year.
verb	Does the landlord [permit] pets?
verb	Brazil [exports] coffee all over the world.
noun	Grain [exports] fell last year.
noun	Building [permits] take months.
noun	It was the biggest [upset] in tournament history.
adj	I was a bit [upset] about it.
";

/// The sense chosen for the bracketed word.
fn sense(line: &str) -> (String, &'static str) {
    let (pre, rest) = line.split_once('[').unwrap();
    let (word, post) = rest.split_once(']').unwrap();
    let word = word.to_ascii_lowercase();
    let t: Vec<String> =
        words_and_stops(&format!("{pre}{word}{post}")).unwrap().iter().map(|w| w.to_ascii_lowercase()).collect();
    let before = words_and_stops(pre).unwrap().iter().filter(|w| w.eq_ignore_ascii_case(&word)).count();
    let i = t.iter().enumerate().filter(|(_, w)| **w == word).nth(before).unwrap().0;
    let (name, _) = hetero::choose(&t, i).unwrap_or_else(|| panic!("{word} is not a heteronym"));
    (word, name)
}

#[test]
fn senses() {
    let (mut bad, mut n) = (Vec::new(), 0);
    for line in CASES.lines().filter(|l| !l.is_empty()) {
        let (want, text) = line.split_once('\t').unwrap();
        let (word, got) = sense(text);
        if !HETS.iter().any(|h| h.word == word && (h.a.0 == want || h.b.0 == want)) {
            panic!("{text}: {want} is not a sense of {word}");
        }
        n += 1;
        if got != want {
            bad.push(format!("{text}: want {want}, got {got}"));
        }
    }
    assert!(bad.is_empty(), "{} of {n} wrong:\n{}", bad.len(), bad.join("\n"));
}

/// Modern text: news, apps, chat and instructions, in the CASES format.
#[test]
fn modern() {
    let src = include_str!("../testdata/hetero_modern.tsv");
    let (mut bad, mut n) = (Vec::new(), 0);
    for line in src.lines().filter(|l| !l.is_empty()) {
        let (want, text) = line.split_once('\t').unwrap();
        let (_, got) = sense(text);
        n += 1;
        if got != want {
            bad.push(format!("{text}: want {want}, got {got}"));
        }
    }
    assert!(bad.is_empty(), "{} of {n} wrong:\n{}", bad.len(), bad.join("\n"));
}

/// Words read one way wherever they are: a case for either sense will do.
const ONE_SENSE: &[&str] = &["houses", "bowing", "putting", "addicts"];

#[test]
fn every_sense_has_a_case() {
    let mut seen = std::collections::HashSet::new();
    for line in CASES.lines().filter(|l| !l.is_empty()) {
        let (want, text) = line.split_once('\t').unwrap();
        seen.insert((sense(text).0, want.to_string()));
    }
    let mut missing = Vec::new();
    for h in HETS {
        let has = |name: &str| seen.contains(&(h.word.to_string(), name.to_string()));
        if ONE_SENSE.contains(&h.word) {
            if !has(h.a.0) && !has(h.b.0) {
                missing.push(h.word.to_string());
            }
            continue;
        }
        for name in [h.a.0, h.b.0] {
            if !has(name) {
                missing.push(format!("{} {name}", h.word));
            }
        }
    }
    assert!(missing.is_empty(), "no case for:\n{}", missing.join("\n"));
}

#[test]
fn table() {
    let mut words = std::collections::HashSet::new();
    for h in HETS {
        assert!(words.insert(h.word), "{} twice", h.word);
        assert_ne!(h.a.0, h.b.0, "{}", h.word);
        assert_ne!(h.a.1, h.b.1, "{}", h.word);
        for p in h.a.1.split(' ').chain(h.b.1.split(' ')) {
            assert!(PHONES.contains(&p), "{}: {p} is not a phone", h.word);
        }
    }
}

/// Every pronunciation testdata/cmudict.dict gives each word.
fn dict() -> std::collections::HashMap<String, Vec<String>> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/cmudict.dict");
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut all = std::collections::HashMap::<String, Vec<String>>::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap().trim();
        if line.is_empty() {
            continue;
        }
        let (head, p) = line.split_once(' ').unwrap();
        let word = match head.rfind('(') {
            Some(k) if head.ends_with(')') => &head[..k],
            _ => head,
        };
        all.entry(word.to_string()).or_default().push(p.split_whitespace().collect::<Vec<_>>().join(" "));
    }
    all
}

/// Senses the dictionary lacks.
const NOT_IN_DICT: &[(&str, &str)] = &[
    ("four", "before"),
    ("fore", "before"),
    ("used", "to"),
    ("house", "verb"),
    ("houses", "z"),
    ("mouth", "verb"),
    ("row", "quarrel"),
    ("does", "deer"),
    ("refuse", "noun"),
    ("blessed", "adj"),
    ("cursed", "adj"),
    ("dogged", "adj"),
    ("upgrade", "noun"),
    ("export", "verb"),
    ("exports", "verb"),
    ("invite", "noun"),
    ("invites", "noun"),
    ("exploits", "verb"),
    ("override", "verb"),
    ("overrides", "verb"),
    ("overlap", "verb"),
    ("overlaps", "verb"),
    ("overhaul", "verb"),
    ("rebound", "noun"),
    ("proceeds", "noun"),
];

#[test]
fn senses_are_the_dictionarys() {
    let d = dict();
    let mut bad = Vec::new();
    for h in HETS {
        let prons = d.get(h.word).unwrap_or_else(|| panic!("{} not in the dictionary", h.word));
        for (name, p) in [h.a, h.b] {
            if prons.iter().any(|x| x == p) == NOT_IN_DICT.contains(&(h.word, name)) {
                bad.push(format!("{} {name}: {p:?}, the dictionary {prons:?}", h.word));
            }
        }
    }
    assert!(bad.is_empty(), "\n{}", bad.join("\n"));
}

/// Which of the phone strings in senses the tokens hold.
fn sound(tokens: &[usize], senses: [&'static str; 2]) -> &'static str {
    let syms: Vec<&str> = tokens.iter().map(|&t| front::symbol(t)).collect();
    let has = |p: &str| syms.windows(p.split(' ').count()).any(|w| w.join(" ") == p);
    match senses.map(has) {
        [true, false] => senses[0],
        [false, true] => senses[1],
        _ => panic!("{syms:?}: not one of {senses:?}"),
    }
}

const LIVE: [&str; 2] = ["L IH1 V", "L AY1 V"];
const READ: [&str; 2] = ["R EH1 D", "R IY1 D"];

#[test]
fn encode_chooses() {
    let mut ph = phonemizer();
    assert_eq!(sound(&ph.encode("We live here.").unwrap(), LIVE), LIVE[0]);
    assert_eq!(sound(&ph.encode("Watch the live wire.").unwrap(), LIVE), LIVE[1]);
    // a word in capitals reads as itself
    assert_eq!(sound(&ph.encode("Watch the LIVE wire.").unwrap(), LIVE), LIVE[1]);
}

const POLISH: [&str; 2] = ["P AA1 L IH0 SH", "P OW1 L IH0 SH"];
const NICE: [&str; 2] = ["N AY1 S", "N IY1 S"];

#[test]
fn capitals_choose() {
    let mut ph = phonemizer();
    for (text, senses, want) in [
        ("Polish the silver.", POLISH, 0),
        ("Polish your shoes until they shine.", POLISH, 0),
        ("Use some polish on it.", POLISH, 0),
        ("I love Polish food.", POLISH, 1),
        ("Polish food is great.", POLISH, 1),
        ("She is Polish.", POLISH, 1),
        ("We stayed in Nice for a week.", NICE, 1),
        ("Nice, France is lovely.", NICE, 1),
        ("Nice work!", NICE, 0),
        ("That was nice.", NICE, 0),
    ] {
        assert_eq!(sound(&ph.encode(text).unwrap(), senses), senses[want], "{text}");
    }
}

#[test]
fn inflection_chooses() {
    let mut ph = phonemizer();
    for text in ["I have read it.", "I will read it."] {
        let inf = Inflection::new(&mut ph, &ssml::pieces(&format!("<speak>{text}</speak>")).unwrap()).unwrap();
        assert_eq!(inf.tokens, ph.encode(text).unwrap(), "{text}");
    }
    // a break ends the clause as a comma does
    let a = Inflection::new(&mut ph, &ssml::pieces(r#"<speak>I will <break time="300ms"/> read it.</speak>"#).unwrap()).unwrap();
    assert_eq!(sound(&a.tokens, READ), sound(&ph.encode("I will, read it.").unwrap(), READ));
    assert_ne!(sound(&a.tokens, READ), sound(&ph.encode("I will read it.").unwrap(), READ));
}

#[test]
fn singing_chooses() {
    use lipservice::score::ScoreModel;
    use lipservice::sing::{plan, Song, Style};
    let m = ScoreModel::load(&read("score-a-i8.lsw")).unwrap();
    let mut ph = phonemizer();
    let st = Style { shift: 0.0, vibrato: 0.0, vibrato_hz: 5.5, vibrato_delay: 0.25, vibrato_ramp: 0.2, glide: 9, dynamics: 0.0, consonants: 1.0, breathiness: 1.0, diction: false, motion: None, motion_scale: 1.0, seed: 0 };
    let mut sung = |song: &str| plan(&m, &mut ph, &Song::parse(&format!("bpm 120\n{song}")).unwrap(), 0, &st).unwrap().tokens;
    assert_eq!(sound(&sung("we C4:1\nlive D4:1\nhere E4:1\n"), LIVE), LIVE[0]);
    assert_eq!(sound(&sung("the C4:1\nlive D4:1\nwire E4:1 E4:1\n"), LIVE), LIVE[1]);
    // a rest ends the clause as a comma does
    assert_eq!(sound(&sung("i C4:1\nwill C4:1\nread D4:1\nit E4:1\n"), READ), READ[1]);
    assert_eq!(sound(&sung("i C4:1\nwill C4:1\nrest 1\nread D4:1\nit E4:1\n"), READ), READ[0]);
}
