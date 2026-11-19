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

```bash
pip install lipservice
lipservice say "Hello there."
```

The first call fetches the models, about 56 MB, and keeps them. The sound is made on your machine;
each run checks lipservice.dev's server for changed models first.

## From Python

```python
import lipservice as lip

lip.say("Hello there.").save("hello.wav")
lip.say("And now, a little faster.", voice="ben", rate=1.15).play()

song = """
bpm 90
Twinkle C4:1 C4:1
twinkle G4:1 G4:1
little A4:1 A4:1
star G4:2
"""
lip.sing(song, voice="cora").save("star.wav")
```

`say` and `sing` return a `Clip`: `save(path)` writes a WAV file, `play()` plays it, `samples` is
the sound as floats at 24 kHz, and a notebook shows it as a player.

## Voices

`lipservice voices` lists them: ada, ben, cora, dev, eve, finn, gwen, hal, ivy, jack, kate,
leo, mae, ned, opal, pete.

## Two qualities

`quality="hifi"` is the default. `quality="fast"` is quicker. Both are in the one package.

## A song is text

Save this as `song.txt`:

```score song.txt
bpm 90
amazing D4:1 G4:2 B4:0.5+G4:0.5
grace B4:2
rest 1
how A4:1
sweet G4:2
the E4:1
sound D4:2
```

A word a line, and a note for each of its syllables: `NOTE:BEATS`, with the note as `C4`, `F#3`,
`Bb2` or a MIDI number. `+` joins notes on one syllable. `rest BEATS` is silence and `bpm N` sets
the tempo. Songs are sung where they are written: `shift=-12` puts one written for a woman in a
man's range. The whole format, and what the engine refuses, is in SCORE.md in the repository.

## From the command line

```bash
lipservice say "Hello there." -o hello.wav --voice ben
lipservice sing song.txt --voice cora --motion vibrato
lipservice voices
lipservice fetch
```

Without `-o` the sound is played.

## Choosing where it plays

`lipservice devices` lists this machine's sound outputs: an id, a name, and `*` on the system's
default. `--device ID` plays through one of them, and so does `clip.play(device=ID)`, with
`lip.devices()` for the list. Two outputs can share a name; the id tells them apart.

## For a model: the MCP server

`lipservice mcp` serves speech and song to a language model over the Model Context Protocol, on
stdin and stdout. It offers four tools: `voices`, `devices`, `say` and `sing`. A client that takes
MCP servers as JSON is given:

```json
{
  "mcpServers": {
    "lipservice": {"command": "lipservice", "args": ["mcp", "--out", "/path/to/a/folder"]}
  }
}
```

Each `say` and `sing` puts its sound where the call says: `device`, the id of an output, plays it
there and returns when it has played; `out` writes a WAV file. A call that gives neither writes a
new file in the server's folder, which is `--out DIR` or the `LIPSERVICE_OUT` variable. With no
folder, such a call is refused. Nothing is played that a call did not name a device for.

One clip plays at a time. A call the client cancels stops playing.

The repository's `plugin/` folder is this server and a skill that teaches the score format,
packaged for Claude Code, Codex, Gemini CLI and Antigravity. For Claude Code the repository is a
plugin marketplace: `claude plugin marketplace add` it, then `claude plugin install
lipservice@lipservice`; for Codex, `codex plugin marketplace add` it. Each needs `lipservice`
installed where the client runs.

## License

AGPL-3.0-only. A commercial license is available for use the AGPL does not suit: see
https://lipservice.dev.
