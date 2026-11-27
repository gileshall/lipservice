<p align="center">
  <img src="https://raw.githubusercontent.com/gileshall/lipservice/main/assets/lockup.png" alt="Lip Service" width="440">
</p>

<p align="center"><b>Talk is cheap. Singing is free.</b></p>

<p align="center">
  <a href="https://lipservice.dev">Hear it in your browser</a> ·
  <a href="https://lipservice.dev/editor/">Write a song</a> ·
  <a href="https://github.com/gileshall/lipservice">GitHub</a>
</p>

<!-- mcp-name: dev.lipservice/lipservice -->

Sixteen voices that sing what you write and say what you type. It is an instrument as much as a
speech engine, and it runs on your own CPU: no GPU, no service, no dependencies.

Lip Service is before 1.0. The song format, the Python API and the command line will change in
breaking ways until 1.0, with no converters.

```bash
pip install lipservice
lipservice say "Hello there."
```

The first call fetches the models, about 56 MB, and keeps them. The sound is made on your machine,
and after that no server is asked anything; `lipservice fetch` checks for changed models.

## From Python

```python
import lipservice as lip

lip.say("Hello there.").save("hello.wav")
lip.say("And now, a little faster.", voice="ben", rate=1.15).play()

song = """
%bpm 90
Twinkle C4:1 C4:1
twinkle G4:1 G4:1
little A4:1 A4:1
star G4:2
"""
lip.sing(song, voice="cora").save("star.wav")
```

`say`, `sing` and `choir` return a `Clip`: `save(path)` writes a WAV file, `play()` plays it,
`samples` is the sound as floats at 24 kHz, and a notebook shows it as a player.

## Voices

`lipservice voices` lists them: ada, ben, cora, dev, eve, finn, gwen, hal, ivy, jack, kate,
leo, mae, ned, opal, pete.

## Two qualities

`quality="hifi"` is the default. `quality="fast"` is quicker. Both are in the one package.

## A song is text

Save this as `song.txt`:

```score song.txt
%bpm 90
amazing D4:1 G4:2 B4:0.5+G4:0.5
grace B4:2
%rest 1
how A4:1
sweet G4:2
the E4:1
sound D4:2
```

A word a line, and a note for each of its syllables: `NOTE:BEATS`, with the note as `C4`, `F#3`,
`Bb2` or a MIDI number. `+` joins notes on one syllable. A line that starts with `%` is an
instruction: `%bpm N` sets the tempo and `%rest BEATS` is silence. Songs are sung where they are written: `shift=-12` puts one written for a woman in a
man's range. The whole format, and what the engine refuses, is in SCORE.md in the repository.

## Choirs

```python
import lipservice as lip

print(lip.choirs())
tag = lip.choir("Barbershop tag", seed=2)
tag.save("tag.wav")
for part in tag.timing["parts"]:
    print(part["name"], part["voice"], part["start"] / lip.RATE, len(part["breaths"]))
```

`choir` sings a piece for several voices as lipservice.dev sings its choirs. Each singer is a little
off the beat and the pitch and takes breaths in the rests, the singers are seated left to right, and
the whole goes through a room, in stereo. A piece is a name from `choirs()`, a choir as a dict, or
`load("piece.json")`. Keyword arguments change how it is sung: `voices` and `songs` by part, `room`
(`ROOMS`), `motion` (`MOTIONS` or `"none"`), `seed`, and the ones in `HOW` (`sway`, `vibrato`,
`loose`, `glide`, `dynamics`, `breath`, `breathiness`). None keeps the piece's own. `timing` says
how each part was sung: its song as sung, the sample of the clip it starts on, its length, and its
breaths.

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
and where beat 0 falls. `frames(timing, fps)` reads it a video frame at a time: how open and how
round each mouth is, whether it sings, how far into a breath it is, its level and pitch, and the
beat. `save_timing` writes it as JSON beside the sound and `load_timing` reads it back, so another
program can drive pictures from the same file. On the command line, `--timing FILE.json` writes it.

## Sound as it is made

```python
import lipservice as lip

song = "%bpm 100\ntwinkle C4:1 C4:1\ntwinkle G4:1 G4:1\nlittle A4:1 A4:1\nstar G4:2\n"
with open("star.f32", "wb") as sink:
    for chunk in lip.sing_stream(song, voice="cora", chunk=0.25):
        sink.write(chunk)  # float32 samples, mono, 24 kHz
```

`say_stream` and `sing_stream` take what `say` and `sing` take and give the sound a chunk at a
time, each made as it is asked for: bytes of float32 samples, about `chunk` seconds of them, which
joined are the clip the whole call gives. A small chunk gives the first sound sooner. Any number
of songs are sung at once, their chunks in turn; a quality says one text at a time, so read a
`say_stream` to its end or `close()` it before the next thing is said in that quality.

## From the command line

```bash
lipservice say "Hello there." -o hello.wav --voice ben
lipservice sing song.txt --voice cora --motion vibrato
lipservice choir "Barbershop tag" -o tag.wav --timing tag.json
lipservice voices
lipservice choirs
lipservice fetch
```

Without `-o` the sound is played. `choir` takes one of `lipservice choirs` by name, or a piece's
JSON file.

## Choosing where it plays

`lipservice devices` lists this machine's sound outputs: an id, a name, and `*` on the system's
default. `--device ID` plays through one of them, and so does `clip.play(device=ID)`, with
`lip.devices()` for the list. Two outputs can share a name; the id tells them apart.

## For a model: the MCP server

`lipservice mcp` serves speech and song to a language model over the Model Context Protocol, on
stdin and stdout. It offers six tools: `voices`, `devices`, `choirs`, `say`, `sing` and `choir`. A client that takes
MCP servers as JSON is given:

```json
{
  "mcpServers": {
    "lipservice": {"command": "lipservice", "args": ["mcp", "--out", "/path/to/a/folder"]}
  }
}
```

Each `say`, `sing` and `choir` puts its sound where the call says: `device`, the id of an output, plays it
there and returns when it has played; `out` writes a WAV file. A call that gives neither writes a
new file in the server's folder, which is `--out DIR` or the `LIPSERVICE_OUT` variable. With no
folder, such a call is refused. Nothing is played that a call did not name a device for. With
`timing` true a call also writes its timing as JSON beside the WAV file.

One clip plays at a time. A call the client cancels stops playing.

The repository's `plugin/` folder is this server and a skill that teaches the score format,
packaged for Claude Code, Codex, Gemini CLI and Antigravity. For Claude Code the repository is a
plugin marketplace: `claude plugin marketplace add` it, then `claude plugin install
lipservice@lipservice`; for Codex, `codex plugin marketplace add` it. Each needs `lipservice`
installed where the client runs.

## License

AGPL-3.0-only. A commercial license is available for use the AGPL does not suit: see
https://lipservice.dev.
