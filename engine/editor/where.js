// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Where the editor finds what it sings with. WEB: the folder of the site's page files
// (lipservice.js, perform.js, room.js, routes.js, lipservice.wasm). MODELS: the folder of its
// models (site.json, voices.json, the weights); it may be another origin. As written here, the
// folder above the editor's and models/ in it. A site that keeps them elsewhere writes this
// file its own; nothing else in the editor says where they are.
export const WEB = new URL("../", import.meta.url).href;
export const MODELS = new URL("../models/", import.meta.url).href;
