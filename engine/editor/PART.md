# A singer's part: `lipservice part 2`

One singer's part as plain text: who sings, how, the notes, the syllable under each, the vibrato
along them, the tempo. A person can read it and mend it; a program writes it. `part.js` reads and
writes it, `midi.js` carries it in and out of MIDI files. `ROADMAP.md` says what of it is sung
today.

A part does not have to be singable to be a file. Notes with no words, two notes sounding at once,
a word with too few notes: all of these read and save. What stops a part being sung is found when
it is sung, and named by its beat.

## The text

UTF-8. A line each, its fields apart by spaces or tabs. Blank lines mean nothing. The first line
is `lipservice part 2`. There are no comments: everything in the file is the part, and all of it
comes back when the file is read and written again. A line the format does not have is an error,
as is a missing one, and the error names the line.

```
lipservice part 2
title Mary Had a Little Lamb
grid 480

voice 6147
seed 3
shift 0
join 0
glide 9
dynamics 1.3
breathiness 0.35
diction 1
motion vibrato
sway 1
jitter 2
detune 3
spread 0
breath 0.85

tempo 0 96
meter 0 4/4

note 4 1 E4 96 0 Ma-
note 5 1 D4 96 0 ry
note 6 1 C4 96 0 had
note 7 1 D4 96 0 a
note 8 1 E4 96 0 lit-
note 9 1 E4 96 0 tle
note 10 1.5 E4 96 0 lamb,/

vibrato 0 0.625
vibrato 10.125 0.671875
vibrato 11.5 0.625

mark 12 breath
```

### Time

A beat is a quarter note, whatever the meter. Beat 0 is the part's start.

`grid N` is how many ticks a beat has, 1 to 32767 (a MIDI file's division). It comes before any
line with a beat in it. Every beat and every length in the file is a whole number of ticks,
written in beats as a decimal of up to six places: a third of a beat on a grid of 960 is 320 ticks
and is written `0.333333`. A number more than a twentieth of a tick from a whole tick is an error.
A part made in the editor has a grid of 960; one read from a MIDI file keeps that file's.

### The part and its singer

Each of these once.

| Line | What it is |
|---|---|
| `title TEXT` | the part's name, to the end of the line; `title` alone for none |
| `grid N` | ticks a beat |
| `voice NAME` | a voice of the models' list |
| `seed N` | which singer of that voice: its timing, its pitch, its breaths, its vibrato. A whole number, 0 to 4294967295 |
| `shift X` | semitones on every note |
| `join X` | a gap between words of this many beats or less is sung through |
| `glide N` | frames (10 ms) the pitch takes from note to note, 1 or more |
| `dynamics X` | how much the singer shapes loudness unasked: higher notes louder, long notes swelled, a phrase's last note let fall. 0 for none |
| `breathiness X` | the breath noise in the sung vowels against the voice's own, 0 or more |
| `diction 0` or `1` | sung diction: every vowel stressed |
| `motion NAME` or `-` | how the pitch moves on a held note: a trained singer's (`straight`, `vibrato`, `wide`), or `-` for a vibrato drawn for the singer |
| `sway X` | that movement against its own size, 0 or more |
| `jitter N` | frames each phrase and note may move off the beat by, a whole number |
| `detune X` | cents the singer may be off the pitch by |
| `spread X` | seconds the whole part may start off by |
| `breath X` | the chance of a breath before a phrase, 0 to 1 |

A number is written as digits, with a point and more digits if it needs them, and a `-` before it
where it may be below zero. No exponents.

### Tempo and meter

`tempo BEAT BPM`: from this beat on, this many beats a minute. `meter BEAT N/D`: from this beat on,
bars of N notes of a Dth (D one of 1, 2, 4, 8, 16, 32; N 1 to 255). Each kind in the order of its
beats, no two on one beat, the first of each on beat 0. A tempo holds until the next: there are no
ramps, as in a MIDI file. A tempo is from 4 to 60000000.

### Notes

```
note START BEATS PITCH VELOCITY RELEASE [SYLLABLE]
```

In the order of their starts; of two that start together, the lower key first.

- `START`, `BEATS`: where the note starts and how long it is, in beats. A length is a tick at least.
- `PITCH`: a key by name, `C4` (middle C, MIDI 60), `F#3`, `Bb2`, from `C-1` to `G9`, with the
  cents it is off by where it is off: `E4+14`, `B3-15.6`. Under 100 cents either way. The name is
  kept as spelled.
- `VELOCITY`: how hard the key went down, 1 to 127: the note's loudness.
- `RELEASE`: how fast the key came up, 0 to 127: how the note ends.
- `SYLLABLE`: what is sung on the note.
  - `Ma-`: a syllable, and its word goes on with the next note that has one.
  - `ry`: a syllable that ends its word.
  - `_`: the note holds the syllable before it.
  - none: no words here yet.
  - a `/` at the end (`lamb,/`, `Ma-/`): a line of the lyric ends here.

  A syllable has no space, `_` or `/` in it. Punctuation stays with it and is not sung. A word is
  its syllables joined: `lit-` and `tle` are sung as `little`, in as many syllables as the engine
  says the word in, however it is split here. Where that count is not the count written, the part
  is not sung, and the word is named.

### Lanes

A lane is a value drawn along the part. There is one so far.

```
vibrato BEAT VALUE [line]
```

The vibrato's size against the voice's own: 0 none, 1 the voice's own, 2 twice it. It is 1 before
the first point. At a point's beat the value becomes VALUE and holds there until the next point.
With `line` it has instead moved there in a straight line from the point before, reaching VALUE at
BEAT. In the order of their beats. Two points may share a beat where the first is reached by a
line and the second is not: the value arrives, then jumps. The first point is not a `line`.

### Marks

```
mark BEAT breath
mark BEAT nobreath
```

A rest is the silence before a phrase: before the first note, or between two notes with a gap
longer than `join`. Without a mark a singer breathes in a rest by chance (`breath`). A mark whose
beat falls in a rest, or on the note that ends it, settles it: `breath` and the singer breathes
there, `nobreath` and it does not. A `breath` on a word's first note, where no rest comes before
it, is taken there all the same, its time out of the note before, as a breath mark over a staff
is; a `nobreath` there settles nothing. In the order of their beats, one to a beat. A mark inside
a word or inside a note, a second mark in one rest, or a breath marked where none fits, stops the
part being sung.

## In a MIDI file

A MIDI file written from a part says everything a MIDI file can say in the standard way, for any
program to read, and carries the part's own text inside it, for lipservice.

Format 0, one track, channel 1, its division the part's `grid`.

| Of the part | In the file |
|---|---|
| the whole text | a system exclusive event at tick 0 (below) |
| `title` | the track's name (FF 03), where there is one |
| `tempo` | a tempo event (FF 51), microseconds a beat, to the nearest |
| `meter` | a time signature (FF 58), a click to each Dth, eight 32nds a beat |
| a note | note on with its velocity, note off (80) with its release |
| its cents | pitch bend before its note on, where the bend standing is not the note's; the bend's range set to 2 semitones at tick 0 (RPN 0) in a part that has cents |
| its syllable | a lyric event (FF 05) at its start, before the note on: `Ma-`; `ry ` with a space, which ends the word; a line's end as a line feed in the space's place. A held note and a note with no words have none |
| `vibrato` | the mod wheel (controller 1): 0 none, 64 the voice's own, 127 twice it. A point that holds is one move; a line is a move at each tick where the wheel's step changes. The wheel is set to 64 at tick 0 where the lane's first point comes later |
| the singer's settings, `mark`, a lane's lines, a size over 2, a key's spelling, `_` told from no words | only in the text inside |

Two notes of one key sounding at once cannot be told apart in a MIDI file: such a part is not
written to one, and the error names the beat.

### The part inside

```
F0 7D 6C 69 70 73 65 72 76 69 63 65 KIND ... F7
```

7D is the manufacturer's number MIDI keeps for use outside commerce; the ten bytes after it are
`lipservice` in ASCII, which is what tells this from any other 7D message. KIND 01 is a part: the
rest, up to the F7, is the part's text, each byte over 7F and each `%` written as `%` and its two
hexadecimal digits (capitals), since a system exclusive message holds no byte over 7F. The other
kinds are free: singing live over a cable will want a syllable sent ahead of its note.

### Reading a MIDI file

Format 0 or 1, timed in ticks a beat. The notes are one track's, on one channel: where notes are
on more than one, the reader is told which, and is refused until it is. Tempo and meter are taken
from every track. The lyrics are the chosen track's and those of any track with no notes; each
sits on the start of a note. The wheel and the bend are the chosen track's and channel's. A note
on of no force is a note off with a release of 64, as MIDI says. A key struck again while down
ends there. A file with no tempo is at 120 and one with no meter in 4/4, as MIDI says.

A file with a part inside is first read as if it had none. If what that gives (the name, the
tempo and meter, the notes with their velocities, the lyrics, the wheel, the bend) is what the
part inside would have written, beat for beat, the file is as lipservice left it and the part
inside is the part: nothing is lost. If it is not, another program has changed the file: the
part is what the events say, the singer is the one inside, and the reading says so.

A file with no part inside, or one changed elsewhere, is read from its events:

- A lyric as files write them: a syllable ending in `-` goes on; one ending in a space or a line
  end ends its word, as does one the next begins with a space after; one ending in neither goes
  on. A line feed or carriage return in it ends the lyric's line. Once the lyrics have begun, a
  note with none holds the syllable before it.
- The wheel as points that hold, one to a tick, none that leaves the size as it was.
- The bend standing as a note starts is the note's cents. Its range is 2 semitones unless the
  file sets it (RPN 0).
- A file with no part inside is given a singer by whoever reads it.

Whatever else the file has is left, and the reading lists it by kind and count: other tracks and
channels, other controllers, programs, pressure, bends inside a note, text and markers, key
signatures, system exclusive messages that are not lipservice's. A file that cannot be read as
written here (a lyric that is on no note's start, a lyric that is two words, a note never let go,
a bend past 100 cents at a note's start) is refused, and the error says what and where.
