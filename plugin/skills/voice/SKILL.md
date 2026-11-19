---
name: voice
description: Say something aloud or sing a song with the lipservice tools (voices, devices, say, sing). Use when the person wants to hear a sentence, wants a spoken or sung audio file, or asks for a song to be written and sung.
---

# Speaking and singing with Lip Service

The `lipservice` tools turn text into speech and a written score into singing, on this machine's
own CPU. There are sixteen voices and they speak English.

Three things to hold on to:

1. **You cannot hear what you make.** A file that was written is not a song that sounds right.
   Say what you made and where it is, and let the person listen.
2. **The engine refuses what it cannot sing, and says why.** Write the score, call `sing`, read
   the refusal, fix that one thing, call again.
3. **Give the person the score along with the sound.** It is plain text, and they can change it.

## Where the sound goes

`say` and `sing` put the sound where the call says, and nowhere else.

| the call gives | what happens |
|---|---|
| `device` | Played through that output. The call returns when it has played. |
| `out`, a full path | A WAV file (mono, 24 kHz) is written there. |
| `out`, a bare name | Written under that name in the server's own folder, if it has one. |
| both | Written, then played. |
| neither | A new file in the server's own folder. With no folder, the call is refused. |

Play through a device only when the person wants to hear it now. To play:

1. Call `devices`. Each output has an `id`, a `name`, and `default` true on the one the system
   uses.
2. If the person named an output ("the speakers", "my headphones"), pick it by name. If they did
   not, use the default one. Two outputs can share a name: when the person's words do not settle
   which, ask.
3. Pass that output's `id` as `device`, exactly as listed.

One clip plays at a time. A second call waits for the first.

## Voices

`voices` lists them: `ada`, `cora`, `eve`, `gwen`, `ivy`, `kate`, `mae`, `opal` are female
and `ben`, `dev`, `finn`, `hal`, `jack`, `leo`, `ned`, `pete` are male. One call is one voice. For a conversation between two speakers, make one call for each
line.

`quality` is `hifi` unless you say `fast`. Use `fast` while you are still getting a score to sing
at all.

## Speech

Plain text is read as written. Paragraphs are said one at a time with a pause between.

| argument | default | |
|---|---|---|
| `voice` | `ada` | who speaks |
| `quality` | `hifi` | or `fast` |
| `rate` | 1.0 | speed: 1.15 is 15% faster |
| `shift` | 0 | semitones up or down |
| `seed` | 0 | the same seed gives the same reading; change it for another take |
| `ssml` | false | the text is SSML |

For control inside a sentence, set `ssml` true and give one `<speak>` element:

```
<speak>
  <p>That is <emphasis level="strong">not</emphasis> what I said.</p>
  <p>Wait <break time="600ms"/> for it.
  The code is <say-as interpret-as="characters">LS24</say-as>.
  <prosody rate="slow" pitch="-2st">This part is slower and lower.</prosody>
  The word <phoneme alphabet="arpabet" ph="T AH0 M AA1 T OW0">tomato</phoneme>, said my way.</p>
</speak>
```

| tag | |
|---|---|
| `<p>` `<s>` | paragraphs and sentences |
| `<break time="600ms"/>` | a pause, by `time` or by `strength` |
| `<prosody rate pitch volume>` | speed, pitch and loudness of what is inside |
| `<emphasis level>` | `strong`, `moderate`, `reduced`, `none` |
| `<say-as interpret-as>` | `characters`, `spell-out`, `cardinal`, `ordinal`, `digits`, `time` (written `3:45`) |
| `<phoneme alphabet="arpabet" ph="...">` | the sounds, in ARPABET with stress digits |
| `<sub alias="...">` | say the alias in place of the text |

Anything else is refused by name, never skipped: `<voice>`, `<audio>`, `<mark>`, and `say-as`
with `date`. Text with no `<speak>` around it is refused too.

## Song

A song is text, passed as `score`. One line is one word and the notes it is sung on:

```score
bpm 100
twinkle C4:1 C4:1
twinkle G4:1 G4:1
little A4:1 A4:1
star G4:2
rest 1
how F4:1
I F4:1
wonder E4:1 E4:1
what D4:1
you D4:1
are C4:2
```

### The whole format

- `bpm N`: the tempo, beats a minute. Exactly once.
- `WORD GROUP GROUP ...`: one word, then one group for each syllable of it.
- A group is `NOTE:BEATS`, or several joined by `+` to move one syllable through several notes:
  `C4:1`, `B4:0.5+G4:0.5`.
- `NOTE` is a capital letter `A` to `G`, then `#` or `b` if any, then the octave. `C4` is middle
  C (MIDI 60), `A4` is 440 Hz. Or a MIDI number, 0 to 127, which may be fractional.
- `BEATS` is any number above zero.
- `rest BEATS`: silence.
- `vibrato SIZE ...`: the vibrato's size from here on, against the voice's own. `0` is a straight
  tone, `1` the voice's own, `2` twice that. `SIZE` jumps, `SIZE:BEATS` glides there over that
  many beats, several follow one another. It takes no time.
- A line starting with `#` is a comment. A comment cannot follow notes on the same line.
- Lines are sung in order. One voice, one note at a time, one tempo.

A song lasts its beats times 60 over the bpm, plus about a quarter of a second. The answer gives
the seconds: check them against that. If they differ, a line is missing or a note has the wrong
length.

### The mistakes you will make

**Syllables.** The engine counts syllables the way it says the word. You will get some wrong, and
the refusal hands you the answer:

```score
bpm 90
every C4:1 D4:1
```
Refused: `every: 3 syllables (EH1 V ER0 IY0), 2 notes`

Count the sounds that end in a digit: `EH1`, `ER0`, `IY0`. Three vowels, three groups. Words
that are often miscounted: `every` 3, `different` 3, `family` 3, `fire` 2, `hour` 2, `our` 2,
`flower` 2, `heaven` 2, `evening` 2, `chocolate` 2, `choir` 2, `quiet` 2, `prayer` 1, `world` 1.

When the tune has more notes than the word has syllables, join notes with `+`. When the word has
more syllables than the tune has notes, divide a note between them (`heaven G4:1.5 G4:0.5`). Do
not drop a syllable and do not respell the word.

**Lowercase notes.** `c4` is refused. Write `C4`.

**Two words on a line, punctuation, hyphens.** One bare word a line. `star,` and `merry-go` are
refused; split a hyphenated word into its words. Capitals and apostrophes are fine.

**The words `rest`, `bpm` and `vibrato`.** At the start of a line they are instructions. To sing
one, capitalise it: `Rest E4:1`.

**Notes too short.** A note must be long enough for the consonants around its vowel:

```score
bpm 250
strengths C4:0.25
```
Refused: `strengths: 3 frames for 4 consonants; the note is too short`

A frame is 10 ms. Lengthen the note or lower the bpm.

**A meter in threes.** There is no time signature. For 6/8, make the eighth note the beat and
set the bpm to eighths a minute.

**Range.** A song is sung where it is written, by any voice. For a male voice, keep the score
and pass `shift` -12.

### What a refusal means

A refusal names the thing that tripped the engine, which is not always the mistake behind it:

| the refusal | the usual cause |
|---|---|
| `line N: X: a note is NOTE:BEATS` | `X` stands where a note should and is not one: a second word on the line, a `#` comment after the notes, or a note with no `:BEATS` |
| `line N: X: beats must be a positive number` | a length or a tempo of zero, or the word `rest` being sung: write `Rest` |
| `line N: X: not a note (C4, F#3, Bb2 or a MIDI number)` | a lowercase letter, or a letter past `G` |
| `line N: bpm takes one number` | `bpm` with nothing after it |
| `the song has no bpm line`, `line N: bpm given twice` | exactly one `bpm` line a song |
| `WORD: N syllables (...), M notes` | one group for each vowel listed |
| `WORD: one word a line` | punctuation or a hyphen on the word |
| `WORD: N frames for M consonants; the note is too short` | a longer note, or a lower bpm |

Fix one refusal a call. The next one may be further down the song, or back up it: mistakes in how
a line is written are found before mistakes in how a word fits its notes.

### Options for a song

`voice`, `quality`, `shift` and `seed` as for speech, and:

| argument | default | |
|---|---|---|
| `vibrato` | 0.25 | the vibrato's peak, semitones. 0 for none anywhere |
| `vibrato_hz` | 5.5 | its speed |
| `vibrato_delay` | 0.25 | seconds into a vowel before it starts |
| `motion` | none | a trained singer's pitch movement in place of the plain vibrato: `straight`, `vibrato` or `wide` |
| `motion_scale` | 1.0 | the size of that movement, times |
| `glide` | 9 | hundredths of a second the pitch takes between notes |
| `dynamics` | 0.0 | how far loudness follows the melody |
| `breathiness` | 1.0 | breath in the sung vowels, times |
| `diction` | false | every vowel sung as a stressed one |

## Songs to learn from

Both are in the public domain.

Amazing Grace: in three, starting on the third beat of the bar. The turns on `-zing` and `a` are
two notes on one syllable.

```score
bpm 90
rest 0.5
amazing D4:1 G4:2 B4:0.5+G4:0.5
grace B4:2
how A4:1
sweet G4:2
the E4:1
sound D4:2
that D4:1
saved G4:2
a B4:0.5+G4:0.5
wretch B4:2
like A4:1
me D5:3
rest 0.5
```

Row, Row, Row Your Boat: in 6/8. The beat is the eighth note, so a dotted quarter is 3 and the
bpm is three times the tempo you would tap. `merrily` is three quick syllables.

```score
bpm 240
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
```

## Writing a song of your own

1. Write the words, one a line.
2. Give each word one group for each syllable. Choose the beat so the notes are plain numbers:
   1, 2, 0.5, 1.5.
3. Put a `rest` wherever the singer would breathe.
4. Sing it on `fast`, to a file. Fix what is refused, one refusal at a time.
5. Check the seconds in the answer against the beats.
6. Sing it on `hifi`, to a file or through the device the person asked for. Give them the score,
   say where the sound is, and ask how it sounds.

## What you cannot do with it

- Hear the result, or judge it. Hand it over.
- Chords, harmony or two voices in one call. One call is one voice singing one line.
- A change of tempo inside a song.
- Any language but English.
- Clone a voice. The sixteen voices are the voices.
