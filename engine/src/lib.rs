// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Lipservice: fast CPU speech and singing synthesis.

pub mod dsp;
pub mod fft;
pub mod nn;
pub mod rng;
pub mod vocoder;
pub mod wav;
pub mod weights;
pub mod attn;
pub mod g2p;
pub mod score;
pub mod breaks;
pub mod pitchflow;
pub mod front;
pub mod hetero;
pub mod lexicon;
pub mod stream;
pub mod passage;
pub mod sharpen;
pub mod voice;
pub mod diction;
pub mod song;
pub mod sing;
pub mod ssml;
pub mod inflect;
pub mod melvoc;
pub mod pause;
pub mod release;
pub mod vox;
pub mod json;
pub mod part;
pub mod home;
pub mod alone;
pub mod room;
pub mod choir;
pub mod timing;
pub mod piece;
