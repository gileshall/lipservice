# The engine

The part of Lip Service that makes the sound. It is Rust with no third-party crates: it reads
text or a song, and trained models (`.lsw` files), and writes 24 kHz mono audio on the CPU. It
runs models and never trains them.

Most people want the Python package at the top of this repository, which builds the engine and
fetches the models. This page is for working on the engine itself.

## What is here

| | |
|---|---|
| `src/` | the library, and `main.rs`, its command line. Each file begins with what it holds |
| `wasm/` | the C ABI over the library: a shared library for the Python package, a wasm module for the browser |
| `web/` | the browser page that speaks and sings with that module, and its tests |
| `tests/`, `testdata/` | the tests, and two tables of cases |
| `examples/` | small programs that time parts of the engine |

## Build

```bash
cd engine
cargo build --release
```

That leaves `target/release/lipservice`. It is the engine's own bench, not the `lipservice`
command the package installs: it takes each model file by path. Run it with no arguments and it
prints what it takes (`say`, `sing`, `perform`, `roll`, `vox`, `words`, `tokens`, `g2p`,
`vocode`, `bench`). `words` needs no models:

```bash
printf 'Dr. Smith paid $1.50 at 4:30 pm.\n' | target/release/lipservice words
```

```
doctor smith paid one dollar fifty cents at four thirty _P_M .
```

The scripts that train and export the models are not in this repository.

## The C ABI

`wasm/src/lib.rs` is the engine as C functions (`ls_say`, `ls_sing`, and the rest, 27 in all): a
call that fails returns -1 and leaves its message at `ls_error`. Built for this machine it is the
shared library the Python package loads (`python/lipservice/_engine.py`), which `pip install .`
at the top of the repository does for you:

```bash
cd engine/wasm
cargo build --release
```

Built for the browser it is the module `web/lipservice.js` drives:

```bash
cd engine/wasm
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown
```

Built here with Homebrew's rust and rust-wasm, which need two more flags: `web/build.sh` says
which.

## The page

`web/` is the source of the demo page: speech, songs and choirs in the browser, with no server
behind it. `web/build.sh` builds the module and assembles the page with the model files.

The page cannot be built from the published models yet: `build.sh` takes the models in the
layout the demo site is built from, which is not published.

## Tests

These need nothing but the repository:

```bash
cd engine
cargo test --release --lib --test front --test linear
```

`web/`'s tests of the page's stage, room, parts, mixer and a lone voice's level run them through
the engine, and take the built module:

```bash
cd engine/web
W=../wasm/target/wasm32-unknown-unknown/release/lipservice_wasm.wasm
node stage_test.mjs $W
node room_test.mjs $W
node perform_test.mjs $W
node choir_test.mjs $W
node alone_test.mjs $W
```

The other sixteen files in `tests/` hold the engine against the models it was trained as, and
read test models from `testdata/` that are not published. From a clone they fail on the missing
files.

From a clone, `cargo test --release --lib` passes. The tests under `tests/` read test models
that are not published, so most of them fail for a file that is not there.

`web/files_test.mjs` needs `ffmpeg`, `flac` and `lame`. `web/page_smoke.mjs` and
`web/choir_check.mjs` need a built page.

The package has two checks of its own, run against an installed wheel: `python/tests/check.py`
(the package and this command line must write the same bytes) and `python/tests/docs.py` (every
example in the README, SCORE.md and AGENTS.md is run).

## The model files

A `.lsw` file is named tensors, 32-bit float or int8. `src/weights.rs` reads them. They are not
in the repository: the package fetches them, and NOTICE at the top says what each was made from.
