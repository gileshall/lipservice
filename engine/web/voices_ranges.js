// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Each voice's range as measured: the highest note it holds (MIDI, as it sounds), every semitone sung on "la" by the
// engine as the Sing box runs it. A note is held while its 1-4 kHz sound repeats with the pitch (rasp under -10 dB)
// and it is within 12 dB of the voice's middle level; the top is the last held note before two in a row are not.
// A soft limit: nothing stops a note over it; the page says so, and no piece is cast over it (perform_test.mjs).
// No low end is given: by these measures a voice holds its pitch as low as it was tried and only gets quieter.
// A route's own (choirs.js ROUTES): the fast route's women lose the note about a third lower than the latent
// voice's, and its men hold every note tried. The pieces are cast to the latent voice's tops.
// To be measured again when the models change.
export const RANGES = {
  hifi: {
    "4446": { top: 80 }, // Ada: G#5
    "2428": { top: 76 }, // Ben: E5, the highest note tried
    "6345": { top: 78 }, // Cora: F#5
    "3752": { top: 68 }, // Dev: G#4
    "1088": { top: 80 }, // Eve: G#5
    "6209": { top: 71 }, // Finn: B4
    "6147": { top: 81 }, // Gwen: A5
    "8088": { top: 70 }, // Hal: A#4
    "5561": { top: 69 }, // Ivy: A4
    "3486": { top: 69 }, // Jack: A4
    "8324": { top: 80 }, // Kate: G#5
    "78": { top: 68 }, // Leo: G#4
    "7178": { top: 80 }, // Mae: G#5
    "8838": { top: 76 }, // Ned: E5, the highest note tried
    "2836": { top: 80 }, // Opal: G#5
    "7402": { top: 76 }, // Pete: E5, the highest note tried
  },
  fast: {
    "4446": { top: 76 }, // Ada: E5
    "2428": { top: 76 }, // Ben: E5, the highest note tried
    "6345": { top: 71 }, // Cora: B4
    "3752": { top: 73 }, // Dev: C#5
    "1088": { top: 75 }, // Eve: D#5
    "6209": { top: 76 }, // Finn: E5, the highest note tried
    "6147": { top: 77 }, // Gwen: F5
    "8088": { top: 76 }, // Hal: E5, the highest note tried
    "5561": { top: 76 }, // Ivy: E5
    "3486": { top: 76 }, // Jack: E5, the highest note tried
    "8324": { top: 76 }, // Kate: E5
    "78": { top: 75 }, // Leo: D#5
    "7178": { top: 74 }, // Mae: D5
    "8838": { top: 76 }, // Ned: E5, the highest note tried
    "2836": { top: 77 }, // Opal: F5
    "7402": { top: 73 }, // Pete: C#5
  },
};
