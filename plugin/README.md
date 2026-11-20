# Lip Service for Claude

Gives Claude a voice. Claude can say text aloud and sing scores it writes, in English, with the
sound made on your own computer's CPU. Nothing is sent to a speech service.

## What you need

[uv](https://docs.astral.sh/uv/getting-started/installation/), for the `uvx` command. Nothing else:
the plugin installs the engine itself.

## What it does on your computer

- **Starts the server.** The plugin runs `uvx lipservice@0.1.1 mcp`. The first time, uv downloads
  the `lipservice` package, version 0.1.1 exactly, from [PyPI](https://pypi.org/project/lipservice/).
  The engine is compiled into that package.
- **Fetches the models.** On first use the engine downloads its model files from
  `https://models.lipservice.dev`, about 56 MB for the default quality. Each file's size and
  SHA-256 hash are checked against the published manifest before it is used. Each run reads that
  manifest again, so a model fix reaches you without a new plugin. The files are kept in your user
  cache folder. Set `LIPSERVICE_CACHE` to keep them somewhere else.
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

The `voice` skill teaches Claude the score format and how to use the tools.

## Setting

**Folder for sound**: where a WAV file goes when a call names neither a device nor a full path.
Leave it empty and such a call is refused.

## More

[lipservice.dev](https://lipservice.dev) has the engine in your browser, and
[github.com/gileshall/lipservice](https://github.com/gileshall/lipservice) has the source.
License: AGPL-3.0-only.
