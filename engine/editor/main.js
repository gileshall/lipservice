// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The page as a browser starts it: where.js says where the site's engine and its models are. A
// first visit is greeted with an example.
import { boot } from "./page.js";
import { WEB, MODELS } from "./where.js";

window.editor = boot({ document, window, web: WEB, models: MODELS, welcome: true });
