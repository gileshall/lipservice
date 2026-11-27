<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/lockup-dark.png">
    <img src="assets/lockup.png" alt="Lip Service" width="440">
  </picture>
</p>

<p align="center"><b>Talk is cheap. Singing is free.</b></p>

<p align="center">
  <a href="https://lipservice.dev">Hear it in your browser</a> ·
  <a href="https://lipservice.dev/editor/">Write a song</a> ·
  <a href="https://pypi.org/project/lipservice/">PyPI</a>
</p>

<p align="center">
  <a href="https://github.com/gileshall/lipservice/actions/workflows/ci.yml"><img src="https://github.com/gileshall/lipservice/actions/workflows/ci.yml/badge.svg" alt="build"></a>
  <a href="https://pypi.org/project/lipservice/"><img src="https://img.shields.io/pypi/v/lipservice?color=dc2a6c" alt="PyPI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-dc2a6c" alt="AGPL-3.0"></a>
</p>

Sixteen voices that sing what you write and say what you type. It is an instrument as much as a
speech engine, and it runs on your own CPU: no GPU, no service, no dependencies.

Lip Service is before 1.0. The song format, the Python API and the command line will change in
breaking ways until 1.0, with no converters.

```bash
pip install lipservice
lipservice say "Hello there."
```

or, from Rust, the same command line, choirs and timing included (it fetches the models with `curl`):

```bash
cargo install lipservice
lipservice say "Hello there." -o hello.wav
```

The first call fetches the models, about 56 MB, and keeps them. The sound is made on your machine,
and after that no server is asked anything; `lipservice fetch` checks for changed models.

On one core of an Apple M3 Max it reads 12 times faster than real time on `hifi` and 23 times
on `fast` (measured 2026-11-18 with this package, the models already loaded). No x86-64 machine
has been timed yet.

## Sing

A song is text: a word a line, with a note for each of its syllables. Save this as `song.txt`:

```score song.txt
%bpm 100
twinkle C4:1 C4:1
twinkle G4:1 G4:1
little A4:1 A4:1
star G4:2
how F4:1
I F4:1
wonder E4:1 E4:1
what D4:1
you D4:1
are C4:2
```

```bash
lipservice sing song.txt -o star.wav
lipservice sing song.txt --voice ben --shift -12 -o ben.wav
```

A note is `NOTE:BEATS`. `C4` is middle C; sharps and flats are `F#3` and `Bb2`. `%bpm` sets the
beats a minute. A song is sung where it is written, by whichever voice: `--shift -12` takes this
one down an octave for a man's voice.

From Python, the song is a string:

```python
import lipservice as lip

song = open("song.txt").read()
clip = lip.sing(song, voice="cora", motion="vibrato")
clip.save("cora.wav")
```

[SCORE.md](SCORE.md) is the whole format: syllables, slurs, rests, vibrato, and what the engine
refuses and why.

## Speak

```python
import lipservice as lip

lip.say("Hello there.").save("hello.wav")
lip.say("And now, a little faster.", voice="ben", rate=1.15).play()
```

`say`, `sing` and `choir` return a `Clip`. `save(path)` writes a WAV file, `play()` plays it,
`seconds` is its length, `samples` is the sound as floats (24 kHz; mono, a choir's stereo), and a
notebook shows it as a player.

| option | what it does |
|---|---|
| `voice` | one of the sixteen, `"ada"` unless you say |
| `quality` | `"hifi"` (the default) or `"fast"` |
| `rate` | speed: 1.15 is 15% faster |
| `shift` | semitones up or down from the voice's own register |
| `seed` | on one machine the same seed says it the same way; another seed reads it differently. A song is the same on every machine; speech can differ slightly between them |
| `ssml` | the text is SSML |

Paragraphs are said one at a time, with a pause between.

With `ssml=True` the text is SSML, inside one `<speak>` element:

```python
lip.say("""<speak>
  That is <emphasis>not</emphasis> what I said.
  <break time="400ms"/>
  The code is <say-as interpret-as="characters">LS24</say-as>,
  said <prosody rate="slow">slowly</prosody>.
</speak>""", ssml=True).save("ssml.wav")
```

It takes `p`, `s`, `break`, `prosody` (rate, pitch, volume), `emphasis`, `say-as` (characters,
spell-out, cardinal, ordinal, digits, time as `3:45`), `phoneme` (ARPABET), `sub`, `w` and `token`. A tag
it does not know is an error that names the tag, never skipped in silence.

## Choirs

```python
import lipservice as lip

print(lip.choirs())
tag = lip.choir("Barbershop tag", seed=2)
tag.save("tag.wav")
```

`choir` sings a piece for several voices as [lipservice.dev](https://lipservice.dev) sings its
choirs. Each singer is a little off the beat and the pitch and takes breaths in the rests, the
singers are seated left to right, and the whole goes through a room, in stereo. `choirs()` names
the pieces that come with it: rounds, folk songs in parts, a barbershop tag.

```python
duet = {
    "room": "card",
    "style": {"glide": 9, "dynamics": 1.0, "breathiness": 0.6, "breath": 0.8},
    "parts": [
        {"name": "High", "voice": "cora", "song": "%bpm 90\nsing C5:1\nwith B4:1\nme C5:2\n%rest 1\n"},
        {"name": "Low", "voice": "ben", "song": "%bpm 90\nsing E4:1\nwith G4:1\nme E4:2\n%rest 1\n"},
    ],
}
lip.choir(duet).save("duet.wav")
```

A choir of your own is a dict: its `room` (`ROOMS`: `card`, `drier`, `driest`, `bare`, from most
room to none), its `style` (`glide`, `dynamics` and `breathiness` as `sing` has them, and `breath`,
the chance of a breath in each rest), and its `parts`, a singer each, seated left to right: a name,
a voice and a song. Every part is written where a woman sings it; a man's voice sings its part an
octave down. `load("piece.json")` reads one from a file.

Keyword arguments change how a piece is sung, and `None` keeps the piece's own:

| option | what it does |
|---|---|
| `seed` | the singers' draws: the same seed gives the same performance |
| `voices`, `songs` | a voice or a song by part, in place of the part's own; `None` in the list keeps it |
| `room` | one of `ROOMS` |
| `motion` | a trained singer's pitch motion for every part (`MOTIONS`), or `"none"` for the plain vibrato |
| `sway`, `vibrato`, `loose` | the singers' vibrato and drift, the vibrato alone, and how far off the beat and the pitch each is, against the piece's own: 0 to 2 |
| `glide`, `dynamics`, `breath`, `breathiness` | the style's own, by another number (`HOW` has each one's range) |

```bash
lipservice choirs
lipservice choir "Barbershop tag" -o tag.wav
```

## Timing, for pictures

```python
import lipservice as lip

clip = lip.sing("%bpm 90\nhello C4:1 E4:1\nthere G4:2\n", voice="cora")
clip.save("hello.wav")
clip.save_timing("hello.json")
f = lip.frames(clip.timing, fps=24)
print(f["frames"], f["parts"][0]["mouth_open"][:12], f["beat"][:4])
```

Every clip from `say`, `sing` and `choir` carries `timing`, plain data in samples of the clip:
for each voice its phones, words, sung notes, breaths, pitch and loudness, and for a song its tempo
and where beat 0 falls. That is enough to sync lips, show a breath, or cut on the beat.

`frames(timing, fps)` reads it a video frame at a time: how open and how round each mouth is,
whether it sings, how far into a breath it is and how full its lungs are, its level and pitch, and
the beat. `save_timing` writes it as JSON beside the sound and `load_timing` reads it back, so
another program can drive pictures from the same file. On the command line, `--timing FILE.json`
writes it.

## Voices

| | | | |
|---|---|---|---|
| `ada` | female | `ben` | male |
| `cora` | female | `dev` | male |
| `eve` | female | `finn` | male |
| `gwen` | female | `hal` | male |
| `ivy` | female | `jack` | male |
| `kate` | female | `leo` | male |
| `mae` | female | `ned` | male |
| `opal` | female | `pete` | male |

The voices were trained on LibriTTS-R: volunteers reading public-domain books for LibriVox, who
released their recordings into the public domain. The names are invented. No reader made,
endorses or is associated with anything made with these voices.

`lipservice voices` prints each voice with its reader's number in LibriTTS-R.

## Two qualities

`quality="hifi"` is the default. `quality="fast"` is quicker. Both are in the one package, with
the same sixteen voices, and each fetches only what it needs: 56 MB before the first word on
`hifi`, 52 MB on `fast`, 99 MB for everything, the choirs and their breaths in it.

## The command line

```bash
lipservice say "Hello there." -o hello.wav
lipservice say "Hello there." --voice ben --rate 1.15 --quality fast -o ben.wav
lipservice sing song.txt --voice cora --motion vibrato -o cora.wav
lipservice choir "Barbershop tag" --room drier -o tag.wav --timing tag.json
lipservice voices
lipservice choirs
lipservice --version
```

Without `-o` the sound is played. `-` in place of the text, the song or the piece reads it from
standard input. `choir` takes one of `lipservice choirs` by name, or a piece's JSON file.
`lipservice say --help`, `lipservice sing --help` and `lipservice choir --help` list every option.


## Models, and working offline

The models are not in the package. The first run reads the list of model files from
`models.lipservice.dev`, with each file's size and SHA-256, and keeps it. A file is fetched the
first time it is needed and checked against that list before it is kept. After that no server is
asked anything: `lipservice fetch` reads the list again, and so brings a model fix or a new file.

| | |
|---|---|
| `lipservice fetch` | read the server's list again and fetch everything `hifi` needs, all sixteen voices and the choirs, 67 MB. `--quality fast` for the other, 62 MB |
| `lipservice fetch --quality all` | everything, 99 MB |
| `LIPSERVICE_CACHE` | where fetched files are kept. By default `~/Library/Caches/lipservice` on macOS and `~/.cache/lipservice` on Linux |
| `LIPSERVICE_MODELS` | a folder that already holds the models and their `manifest.json`. Nothing is fetched and the network is not used |
| `LIPSERVICE_SOURCES` | where the models are served, in place of `https://models.lipservice.dev`: one URL, or several separated by spaces, tried in order |
| `LIPSERVICE_ACCEL` | `require` to stop on a processor the engine has no fast kernels for, in place of warning and running many times slower. See [What it runs on](#what-it-runs-on) |

A run that needs a file the kept list does not have, or one the server has since changed, stops
and names `lipservice fetch`.

## What it runs on

Python 3.9 or later. English only.

There are wheels for macOS 11 and later on Apple silicon, and Linux on x86-64 and arm64, with
glibc 2.17 or later or musl 1.2 or later. Each was checked against the engine built for the same
machine: the Linux ones in containers, on a machine of their own architecture. The arm64 Linux
wheel was also checked on a Raspberry Pi 4 with 64-bit Debian 12, where four seconds of speech
take about 7 seconds to make at `fast` and 12 at `hifi`. It has not been run on any other ARM
board or embedded device.

The engine has fast kernels for arm64, for x86-64 with AVX2 and FMA (Intel from 2013, AMD from
2015) and for WebAssembly. An arm64 processor without the dotprod extension, a Raspberry Pi 3 or 4
among them, takes a second set of int8 kernels that give the same samples in about twice the time.
On any other processor it writes the same samples about ten times
slower, and says so on stderr each run. With `LIPSERVICE_ACCEL=require` it stops there instead.

On an Intel Mac and on Windows there is no wheel: `pip` builds it from source with a Rust
toolchain. 0.1.1 was the last release with an Intel Mac wheel. The Windows build is tested as far
as loading the engine; no sound has been made on Windows.

`play()` uses `afplay` on macOS and `aplay` on Linux.

## For models and agents

[AGENTS.md](AGENTS.md) is written for a language model using Lip Service: the commands, the
score format in full, the mistakes the engine refuses, choirs, and example songs.

## Build it

The engine is Rust with no third-party crates. A stable toolchain and Python are all it needs:

```bash
git clone https://github.com/gileshall/lipservice
cd lipservice
pip install .
```

[engine/README.md](engine/README.md) is for working on the engine itself: its command line, the
C ABI, the browser build and the tests.

## License

Copyright (C) 2026 Giles Hall.

Lip Service is free software under the GNU Affero General Public License, version 3
([LICENSE](LICENSE)): the engine and all sixteen voices. Nothing is held back from the free
version. It comes with no warranty.

In short: use it for anything. If you give the software to someone else, or let people use a
changed version over a network, you offer them the source under the same license. The license
covers the software, not the audio you make with it.

A commercial license is for one thing: putting Lip Service inside something whose source you
will not publish. It is the same software on different terms. Write to
licensing@lipservice.dev, or see https://lipservice.dev/licensing/.

## Credits

The models were trained on LibriTTS-R (Koizumi et al., 2023, CC BY 4.0), which comes from
LibriTTS (Zen et al., 2019) and, before that, from LibriVox recordings. Training started from a
model trained on LJ Speech. The sung pitch motion was measured from VocalSet, and pronunciation
comes from the CMU Pronouncing Dictionary. The `fast` quality includes the Vocos vocoder's
weights (MIT), and the pause model learned in part from BERT (Apache-2.0).
[NOTICE](NOTICE) gives each one, its authors and its license.

## Contributing

Bug reports and ideas are welcome as issues. Code from outside is not being merged yet;
[CONTRIBUTING.md](CONTRIBUTING.md) says why. Report a security problem privately, as
[SECURITY.md](SECURITY.md) says.

"Lip Service" is the project's name. Say that your work uses it; do not name your own product,
fork or service with it.
