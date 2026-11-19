# Writing a song

A song is plain text. Each line is one word and the notes it is sung on:

```score song.txt
bpm 100
twinkle C4:1 C4:1
twinkle G4:1 G4:1
little A4:1 A4:1
star G4:2
```

```bash
lipservice sing song.txt -o song.wav
```

`twinkle` has two syllables, so it takes two notes. `C4:1` is middle C for one beat. `bpm 100` is
a hundred beats a minute. That is most of the format.

## The lines

| line | what it is |
|---|---|
| `bpm N` | the tempo, in beats a minute. Once a song, anywhere in it |
| `WORD NOTE:BEATS ...` | a word, with a note for each syllable |
| `rest BEATS` | silence |
| `vibrato SIZE ...` | the size of the vibrato from here on. Takes no time |
| `# anything` | a comment: the whole line. Blank lines are skipped too |

Lines are sung in order, one after another. There is one voice and one note at a time.

## Notes

A note is `NOTE:BEATS`.

- **The note** is a letter from `A` to `G`, in capitals, then any sharps (`#`) or flats (`b`),
  then the octave: `C4`, `F#3`, `Bb2`. `C4` is middle C and `A4` is 440 Hz. The octave changes
  at C, so `B3` is the note just under `C4`.
- Or it is a MIDI number from 0 to 127, where 60 is middle C. It may have a fraction: `60.5` is
  a quarter tone above middle C.
- **The beats** are any number above zero: `1`, `2`, `0.5`, `1.5`, `0.25`.

A lowercase note is not a note:

```score
bpm 100
star g4:2
```
Refused: `line 2: g4: not a note (C4, F#3, Bb2 or a MIDI number)`

## Words and syllables

A word takes one note for each syllable, and the engine counts the syllables the way it says the
word. When the count is off, the refusal shows you how it hears the word:

```score
bpm 90
amazing D4:1 G4:2
```
Refused: `amazing: 3 syllables (AH0 M EY1 Z IH0 NG), 2 notes`

The sounds in the brackets are the word as it will be sung. Each one that ends in a digit is a
vowel, and each vowel is a syllable: `AH0`, `EY1`, `IH0`. So `amazing` needs three notes:

```score
bpm 90
amazing D4:1 G4:2 B4:1
```

The count is the spoken one, which is not always the hymnal's:

| syllables | words |
|---|---|
| 1 | `the` `a` `oh` `prayer` `real` `world` `ne'er` `'tis` |
| 2 | `fire` `hour` `our` `flower` `heaven` `evening` `being` `cruel` `quiet` `poem` `lion` `choir` `towards` `chocolate` `over` `o'er` `e'er` |
| 3 | `every` `different` `family` `wandering` `idea` `radio` `merrily` |

**More notes than syllables:** join the notes with `+`. The syllable's vowel moves through them:

```score
bpm 90
grace B4:1+A4:1
```

**More syllables than notes:** the tune gives `heaven` one note and the engine says it in two
syllables. Divide the note between them, which is what a singer does:

```score
bpm 90
heaven G4:1.5 G4:0.5
```

Words the engine has never seen are sung as they are spelled, so made-up words work. For a word
with no meaning, `la`, `ah`, `oh`, `ooh` and `hum` are one syllable each. `mm` and `hmm` have no
vowel and cannot take a note.

### One word a line

No punctuation and no hyphens. Capitals and apostrophes are fine.

```score
bpm 100
star, G4:2
```
Refused: `star,: one word a line`

Two words on a line read as a word followed by a bad note:

```score
bpm 100
little star A4:1 A4:1 G4:2
```
Refused: `line 2: star: a note is NOTE:BEATS`

A line that starts with `rest`, `bpm` or `vibrato` is that instruction, not a word. To sing one
of those words, give it a capital:

```score
bpm 132
God E4:1
Rest E4:1
ye B4:1
merry B4:1 A4:1
gentlemen G4:1 F#4:1 E4:1
```

## Rests

`rest BEATS` is silence for that many beats. Use it between phrases, and wherever the tune
rests:

```score
bpm 100
star G4:2
rest 1
how F4:1
```

## Tempo and the beat

`bpm` is given once and holds for the whole song. There is no time signature and there are no
bar lines: a beat is whatever you count.

In a tune that swings in threes, count the short note and set `bpm` to match. This one is in
6/8 at 80 dotted quarters a minute, so the beat here is the eighth note, at 240:

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
```

A song lasts its beats times 60 over the `bpm`, plus about a quarter of a second: a moment of
silence before the first word and after the last note.

A vowel lands on its beat. The consonants in front of it are sung just ahead of the beat, as a
singer places them.

## Notes too short to sing

Consonants take time, and a note has to be long enough to hold the ones around its vowel. One
that is not is refused:

```score
bpm 250
strengths C4:0.25
```
Refused: `strengths: 3 frames for 4 consonants; the note is too short`

A frame is a hundredth of a second. Give the word a longer note or slow the song down. Quick
syllables with few consonants are fine: `la` on a quarter of a beat at 120 is sung.

## Vibrato

Every held note has a little vibrato unless you say otherwise. A `vibrato` line changes its
size from that point in the song. It takes no time of its own.

- The size is against the voice's own: `1` is the voice's own vibrato, `0` is a straight tone,
  `2` is twice as wide.
- `SIZE` jumps to that size. `SIZE:BEATS` glides to it over that many beats.
- Several on a line follow one another, and the last size holds until the next `vibrato` line.

```score
bpm 72
# a straight tone
vibrato 0
ah C4:4
# straight, then growing to the voice's own over four beats
vibrato 0 1:4
ah E4:4
# swelling to twice the size over two beats, and back to none over two
vibrato 2:2 0:2
ah G4:2+E4:2+C4:4
```

## Where a song sits

A song is sung at the pitch it is written, whichever voice sings it. The `shift` option moves
the whole song by semitones without changing the file: `shift=-12`, or `--shift -12`, takes a
song written around middle C down an octave for a man's voice.

## Options for the whole song

These are arguments to `lip.sing` and flags to `lipservice sing` (`vibrato_hz` is `--vibrato-hz`).

| option | default | what it does |
|---|---|---|
| `voice` | `ada` | who sings |
| `quality` | `hifi` | `hifi` or `fast` |
| `shift` | 0 | semitones, the whole song |
| `seed` | 0 | the same seed sings it the same way |
| `vibrato` | 0.25 | the vibrato's peak, in semitones |
| `vibrato_hz` | 5.5 | its speed |
| `vibrato_delay` | 0.25 | seconds into a vowel before it starts |
| `motion` | none | a trained singer's pitch movement in place of the plain vibrato: `straight`, `vibrato` or `wide`. The seed picks the singer |
| `motion_scale` | 1 | the size of that movement, times |
| `glide` | 9 | hundredths of a second the pitch takes to move between notes |
| `dynamics` | 0 | how far loudness and brightness follow the melody. 0 is none |
| `breathiness` | 1 | the breath in the sung vowels, times. Under 1 is less |
| `diction` | off | every vowel sung as a stressed one |

## What the engine refuses

A song with a mistake in it is not sung. The refusal says what is wrong, with the line number
when the mistake is in how a line is written, or the word when it is in how the word fits its
notes.

| the refusal | what to do |
|---|---|
| `the song has no bpm line` | add `bpm N` |
| `line N: bpm given twice` | one tempo a song |
| `line N: bpm takes one number` | `bpm` with nothing after it |
| `the song has no words` | a song of rests is not a song |
| `line N: X: not a note (C4, F#3, Bb2 or a MIDI number)` | capital letter, then `#` or `b`, then the octave |
| `line N: X: a note is NOTE:BEATS` | the beats are missing, there are two words on the line, or a comment follows the notes |
| `line N: X: beats must be a positive number` | beats and tempo above zero. Also what a sung `rest` gets: write `Rest` |
| `WORD: N syllables (...), M notes` | one note for each vowel listed. Join extra notes with `+`, or divide a note |
| `WORD: one word a line` | take off the punctuation or the hyphen |
| `WORD: N frames for M consonants; the note is too short` | a longer note, or a slower song |

## A whole song

```score amazing-grace.txt
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

```bash
lipservice sing amazing-grace.txt -o grace.wav
lipservice sing amazing-grace.txt --voice hal --shift -12 --motion vibrato -o hal.wav
```

It is in three, so each bar is three beats: the tune starts on the third beat of a bar
(`amazing D4:1`), and the two-note turns on `-zing` and `a` are written with `+`.

More songs are in [AGENTS.md](AGENTS.md).

## What it does not do

- One voice and one note at a time. No chords and no harmony in a single song.
- One tempo. No slowing down or speeding up inside a song.
- No dynamics, accents or breath marks in the score.
- English words only.
