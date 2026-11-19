// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The ways a site makes its sound. hifi: the latent voice (models/vox.lsw), speech and song. fast: the mel
// route for speech (models/melvoc.lsw) and the source-filter vocoder for song (models/vocoder.lsw), the
// earlier engine, about twice as quick. A site offers one or both, and a visitor's workers load only the
// one in use.
export const ROUTES = ["hifi", "fast"];

// The routes a site offers, from its models/site.json: {routes: [...]}, the first the one a visitor gets
// unasked; or {vox: true|false}, a site of one route.
export function routesOf(site) {
  if (site.routes !== undefined && site.vox !== undefined) throw new Error("models/site.json: routes or vox, not both");
  const routes = site.routes ?? (typeof site.vox === "boolean" ? [site.vox ? "hifi" : "fast"] : null);
  if (!Array.isArray(routes) || !routes.length || routes.some((r) => !ROUTES.includes(r)) || new Set(routes).size !== routes.length) {
    throw new Error(`models/site.json: routes is a list of ${ROUTES.join(" and ")}, or vox is true or false`);
  }
  return routes;
}
