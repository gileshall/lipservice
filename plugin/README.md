# Lip Service for Claude

Gives Claude a voice. Claude can say text aloud and sing scores it writes, alone or as a choir in
parts, in English, with the
sound made on your own computer's CPU. Nothing is sent to a speech service.

## What you need

[uv](https://docs.astral.sh/uv/getting-started/installation/), for the `uvx` command. Nothing else:
the plugin installs the engine itself.

## What it does on your computer

- **Starts the server.** The plugin runs `uvx lipservice@0.2.1 mcp`. The first time, uv downloads
  the `lipservice` package, version 0.2.1 exactly, from [PyPI](https://pypi.org/project/lipservice/).
  The engine is compiled into that package.
- **Fetches the models.** On first use the engine downloads its model files from
  `https://models.lipservice.dev`, about 56 MB for the default quality. Each file's size and
  SHA-256 hash are checked against the published manifest before it is used. The manifest is kept
  with the files in your user cache folder, and the server is not asked again: `uvx lipservice@0.2.1
  fetch` reads it again, for a model fix. Set `LIPSERVICE_CACHE` to keep them somewhere else.
- **Makes sound.** Speech and singing are computed locally. The sound is played through an output
  device you name, or written as a WAV file.

It sends nothing about you or what you type anywhere, stores nothing but the model files and the
WAV files you ask for, and needs no account or key. The only network requests are to PyPI (through
uv) and to `models.lipservice.dev`, for the files above.

## Tools

- `voices`: the voices there are.
- `devices`: the output devices it can play through.
- `say`: speak text, played through a device or written to a WAV file.
- `sing`: sing a written score, played or written the same way.
- `choir`: sing a piece for several voices that Claude writes, in stereo.

`say`, `sing` and `choir` can also write what each voice did when (words, notes, breaths, pitch,
the beat) as a JSON file beside the sound, for lip sync and other pictures.

The `voice` skill teaches Claude the score format and how to use the tools.

## Setting

**Folder for sound**: where a WAV file goes when a call names neither a device nor a full path.
Leave it empty and such a call is refused.

## More

[lipservice.dev](https://lipservice.dev) has the engine in your browser, and
[github.com/gileshall/lipservice](https://github.com/gileshall/lipservice) has the source.
License: AGPL-3.0-only.
