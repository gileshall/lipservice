# A score: `lipservice score 1`

Several singers' parts and their mix as plain text. `score.js` reads and writes it. Each singer's
part is a whole `lipservice part 2` (`PART.md`) inside the score, so a part lifted out of a score
is a part's file, and nothing a part can say is said another way here.

```
lipservice score 1
title Row, Row, Row Your Boat: a round for three

master -2
effect reverb on seconds 1.4 predelay 20 damp 6000 mix 0.16
effect limiter on ceiling -1 release 80

singer
level 0
pan -0.55
mute 0
solo 0
lipservice part 2
title Finn
grid 480
...

singer
level -1.5
pan 0
mute 0
solo 0
lipservice part 2
title Cora
...
```

UTF-8, a line each, fields apart by spaces or tabs, blank lines meaning nothing, no comments. A
line the format does not have is an error, as is a missing one, and the error names the line (a
line inside a part by its line in the score).

## Before the singers

| Line | Is |
|---|---|
| `title TEXT` | the score's name, one line; may be empty |
| `master X` | the level after the chain, dB, -60 to 12 |
| `effect KIND on\|off NAME X ...` | one effect of the master's chain. The lines' order is the order the sound goes through them. Every setting of the kind is written, by name, in the kind's order |

## A singer

`singer` on a line of its own, then its strip, then its part:

| Line | Is |
|---|---|
| `level X` | dB, -60 to 12 |
| `pan X` | -1 (left) to 1 (right) |
| `mute 0\|1` | silent in the mix |
| `solo 0\|1` | while any singer is soloed, only the soloed sound |
| `lipservice part 2` ... | the part, to the next `singer` line or the file's end |

A singer's name is its part's title. A score has 1 to 16 singers.

The singers keep one time: every part has the first's `grid`, `tempo` lines and `meter` lines. A
score where they differ is refused, by the singer.

## The effects

The singers, each through its level and pan, are summed; the sum goes through the chain, then the
master's level. An effect that is `off` is passed by. `mix` is 0 for none of the effect and 1 for
all of it, the two crossed at equal power.

| Kind | Settings (least to most, as added) |
|---|---|
| `gain` | `db` -24 to 24 (0) |
| `filter` | `lowcut` Hz 20 to 2000 (80): what is under it cut. `highcut` Hz 500 to 11500 (11500): what is over it cut |
| `eq` | `low` dB -18 to 18 (0) and `lowhz` 40 to 600 (120): a shelf. `mid` dB (0), `midhz` 200 to 8000 (1000), `q` 0.3 to 8 (1): a bell. `high` dB (0) and `highhz` 1500 to 11000 (6000): a shelf |
| `compressor` | `threshold` dB -60 to 0 (-18), `ratio` 1 to 20 (3), `knee` dB 0 to 40 (6), `attack` ms 0 to 200 (10), `release` ms 10 to 1000 (150), `makeup` dB 0 to 24 (0) |
| `echo` | `ms` 20 to 1500 (375), `feedback` 0 to 0.9 (0.35), `mix` (0.2) |
| `reverb` | `seconds` to die away by 60 dB, 0.2 to 8 (1.8); `predelay` ms 0 to 150 (20); `damp` Hz 500 to 11500 (6000): the ring's top falls toward it; `mix` (0.2) |
| `limiter` | `ceiling` dB -12 to 0 (-1): no sample passes it. `release` ms 10 to 500 (80) |

A new score's chain is one limiter. The sound is 24 kHz, so nothing is above 12 kHz.

What these sound like is the editor's making (`mix.js`, the browser's audio nodes, and
`speaker.js` for the limiter); another program that reads a score may make them its own way. The
numbers are the format's.

## Not in a score

The loop, the click and the place Sing starts from are the editor's, kept in the browser. A MIDI
file holds one singer's part (`PART.md`); a score has no MIDI form yet.
