// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A walk round a page: each step rings one area and says, beside it, how the area is used. The
// page stays live under it, so what a step says can be tried at once. A step:
//   { title, where, text: [lines], need: () => null | { where, text }, act: () => null | { label, run }, show: () => {} }
// `where` is the id of the area. `need` says what must be done first when the area is not there
// yet, and where; `act` is a button the step offers; `show` is run on coming to the step, to open
// the area.
const el = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};
const button = (id, cls, label, run, off = false) => {
  const b = el("button", cls, label);
  b.setAttribute("id", id);
  b.disabled = off;
  b.addEventListener("click", run);
  return b;
};

export const tour = (root, steps) => {
  const ring = el("div", "ring"), note = el("div", "guide");
  note.setAttribute("id", "guide");
  root.replaceChildren(ring, note);
  let at = null, ringed = null;
  // the area a step is about as things stand, and what the step says of it
  const now = () => {
    const s = steps[at], need = s.need?.() ?? null;
    return { s, need, where: need ? need.where : s.where };
  };
  const reach = (where) => {
    const target = document.getElementById(where);
    if (!target) throw new Error(`the tour's step ${at + 1} points at ${where}, which is not on the page`);
    scrollTo(scrollX, Math.max(0, scrollY + target.getBoundingClientRect().top - 90));
  };
  const render = () => {
    if (at === null) return;
    const { s, need, where } = now(), act = need ? null : s.act?.() ?? null;
    note.replaceChildren(
      el("div", "soft", `${at + 1} of ${steps.length}`),
      el("h2", "", s.title),
      ...(need ? [el("p", "first", need.text)] : s.text.map((t) => el("p", "", t))),
      el("div", "row",
        button("tour-back", "", "Back", () => go(at - 1), at === 0),
        at + 1 < steps.length ? button("tour-next", "main", "Next", () => go(at + 1)) : button("tour-next", "main", "Done", close),
        act && button("tour-act", "", act.label, act.run),
        at + 1 < steps.length && button("tour-close", "", "Close", close)));
    // the area a step waited for has come: go to it
    if (where !== ringed) { ringed = where; reach(where); }
  };
  const go = (k) => { at = k; ringed = null; root.className = "on"; steps[k].show?.(); render(); };
  const close = () => { at = null; ringed = null; root.className = ""; };
  // the ring follows its area as the page is scrolled and redrawn; the words keep out of its way
  const place = () => {
    if (at === null) return;
    const target = document.getElementById(ringed);
    if (!target) { ring.style.display = "none"; return; }
    const r = target.getBoundingClientRect(), tall = note.getBoundingClientRect().height;
    Object.assign(ring.style, { display: "block", left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
    const above = r.bottom > innerHeight - tall - 24 && r.top > tall + 24;
    Object.assign(note.style, above ? { top: "12px", bottom: "auto" } : { top: "auto", bottom: "12px" });
  };
  return { open: () => go(0), close, render, place, get at() { return at; } };
};
