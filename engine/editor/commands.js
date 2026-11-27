// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The editor's commands in one table, and what is made from it: the command a key runs, a menu
// at a point, the palette (cmd K) and the Keys help, so that each command is found in all four
// and the four cannot drift apart. Nothing here runs a command: the menu and the palette give
// the page the one chosen, and the page runs it, so that a failure is said in its status line and
// a change to several singers is one step of Undo.
//
// A command, as the page writes it:
//   {id, label, group, keys: ["mod+c"], where: ["note", "roll"], under: "Ornament", typing,
//    when(ctx), on(ctx), run(ctx)}
// - id: a name, one to a command. label: what it does, in plain words. group: where it is listed.
// - keys (optional): what presses it. Each is modifiers and a key joined by +: mod (cmd on a Mac,
//   ctrl elsewhere), shift, alt; then a letter, a digit, a sign (= - , . / [ ] ; ' ` \) or a name:
//   space enter escape tab delete backspace home end pageup pagedown left right up down plus minus.
//   No key is pressed by two commands.
// - where (optional): the places a right click offers it ("note", "roll", "ruler", "tab", ...).
// - under (optional): the menu shows it in a smaller menu of that name (Ornament: Trill).
// - typing (optional): its keys work while a text box has the keys (cmd S does; B does not).
// - when (optional): null where it may run now, or a reason it cannot, in plain words.
// - on (optional): a command that turns something on or off says whether it is on now; a menu
//   shows it checked.
// - run: what it does.

const MODS = ["mod", "shift", "alt"];
const NAMED = {
  space: [" ", "space"], enter: ["Enter", "Enter"], escape: ["Escape", "Escape"], tab: ["Tab", "Tab"],
  delete: ["Delete", "delete"], backspace: ["Backspace", "backspace"], home: ["Home", "Home"], end: ["End", "End"],
  pageup: ["PageUp", "page up"], pagedown: ["PageDown", "page down"],
  left: ["ArrowLeft", "left"], right: ["ArrowRight", "right"], up: ["ArrowUp", "up"], down: ["ArrowDown", "down"],
  plus: ["+", "+"], minus: ["-", "-"],
};
const SIGNS = "=-,./[];'`\\";
const FIELDS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const FIELD = new Set(["id", "label", "group", "keys", "where", "under", "typing", "when", "on", "run"]);

// whether keys are named for a Mac: platform is the browser's name for it ("MacIntel", "macOS")
export function mac(platform) {
  if (typeof platform !== "string" || !platform) throw new Error(`the platform is ${JSON.stringify(platform)}, not a name such as "MacIntel" or "Win32"`);
  return /mac|iphone|ipad|ipod/i.test(platform);
}

// One binding written once: {spec, label (what the help shows, "cmd shift Z"), match(e) (whether a
// KeyboardEvent is it)}. A letter or digit is the key's own, or, where the key gives none (alt on
// a Mac, another alphabet), the one at its place on the keyboard. A sign that takes shift to type
// (+) is matched with shift up or down unless the binding names shift.
export function chord(spec, platform) {
  const named = mac(platform) ? "cmd" : "ctrl";
  if (typeof spec !== "string" || !spec) throw new Error(`keys ${JSON.stringify(spec)}: not a key such as "mod+c"`);
  const parts = spec.split("+");
  if (parts.some((p) => !p)) throw new Error(`keys "${spec}": write the + key as plus`);
  const last = parts.pop(), mods = parts.map((p) => p.toLowerCase());
  for (const m of mods) if (!MODS.includes(m)) throw new Error(`keys "${spec}": ${m} is not mod, shift or alt`);
  if (new Set(mods).size !== mods.length) throw new Error(`keys "${spec}": a modifier twice`);
  const want = { mod: mods.includes("mod"), shift: mods.includes("shift"), alt: mods.includes("alt") };
  let kind, key, shown;
  if (/^[a-z]$/i.test(last)) [kind, key, shown] = ["letter", last.toLowerCase(), last.toUpperCase()];
  else if (/^[0-9]$/.test(last)) [kind, key, shown] = ["digit", last, last];
  else if (last.length === 1 && SIGNS.includes(last)) [kind, key, shown] = ["sign", last, last];
  else if (Object.hasOwn(NAMED, last.toLowerCase())) {
    [key, shown] = NAMED[last.toLowerCase()];
    kind = key === "+" || key === "-" ? "sign" : "named";
  } else throw new Error(`keys "${spec}": ${last} is not a letter, a digit, a sign or a key's name`);
  const label = [...(want.mod ? [named] : []), ...(want.shift ? ["shift"] : []), ...(want.alt ? ["alt"] : []), shown].join(" ");
  const isMac = named === "cmd";
  const match = (e) => {
    if (typeof e?.key !== "string") throw new Error(`keys "${spec}": a key press with no key`);
    const mod = isMac ? !!e.metaKey : !!e.ctrlKey, other = isMac ? !!e.ctrlKey : !!e.metaKey;
    if (mod !== want.mod || other || !!e.altKey !== want.alt) return false;
    if (kind !== "sign" || want.shift) if (!!e.shiftKey !== want.shift) return false;
    if (kind === "letter") {
      const k = e.key.toLowerCase();
      return /^[a-z]$/.test(k) ? k === key : e.code === `Key${key.toUpperCase()}`;
    }
    if (kind === "digit") return /^[0-9]$/.test(e.key) ? e.key === key : e.code === `Digit${key}`;
    return e.key === key;
  };
  return Object.freeze({ spec, label, match, mod: want.mod, alt: want.alt, shift: kind === "sign" && !want.shift ? null : want.shift, key });
}

// two bindings one press could be
const clash = (a, b) => a.key === b.key && a.mod === b.mod && a.alt === b.alt && (a.shift === null || b.shift === null || a.shift === b.shift);

// The table made from the page's list: each command checked, its keys named and matched for the
// platform. Refuses, naming the command, what is not a command as above.
export function table(list, platform) {
  if (!Array.isArray(list)) throw new Error("the commands are not a list");
  mac(platform);
  const ids = new Set(), chords = [];
  return Object.freeze(list.map((c, i) => {
    const name = typeof c?.id === "string" && c.id ? `command ${c.id}` : `command ${i + 1}`;
    if (!c || typeof c !== "object") throw new Error(`${name} is not a command`);
    for (const k of Object.keys(c)) if (!FIELD.has(k)) throw new Error(`${name}: ${k} is not a command's field`);
    if (typeof c.id !== "string" || !c.id) throw new Error(`${name} has no id`);
    if (ids.has(c.id)) throw new Error(`${name} twice`);
    ids.add(c.id);
    for (const f of ["label", "group"]) if (typeof c[f] !== "string" || !c[f].trim()) throw new Error(`${name} has no ${f}`);
    if (c.under !== undefined && (typeof c.under !== "string" || !c.under.trim())) throw new Error(`${name}: under is the name of a menu`);
    if (typeof c.run !== "function") throw new Error(`${name} has nothing to run`);
    if (c.when !== undefined && typeof c.when !== "function") throw new Error(`${name}: when is not a function`);
    if (c.on !== undefined && typeof c.on !== "function") throw new Error(`${name}: on is not a function`);
    if (c.typing !== undefined && typeof c.typing !== "boolean") throw new Error(`${name}: typing is true or false`);
    if (c.where !== undefined && (!Array.isArray(c.where) || c.where.some((w) => typeof w !== "string" || !w))) throw new Error(`${name}: where is a list of places`);
    if (c.keys !== undefined && !Array.isArray(c.keys)) throw new Error(`${name}: keys is a list such as ["mod+c"]`);
    const mine = (c.keys ?? []).map((spec) => {
      let k;
      try {
        k = chord(spec, platform);
      } catch (e) {
        throw new Error(`${name}: ${e.message}`);
      }
      const other = chords.find((o) => clash(o.k, k));
      if (other) throw new Error(`${name}: ${k.label} is already ${other.id}'s`);
      chords.push({ k, id: c.id });
      return k;
    });
    return Object.freeze({
      id: c.id, label: c.label, group: c.group, under: c.under ?? null, where: Object.freeze([...(c.where ?? [])]), typing: c.typing ?? false,
      keys: Object.freeze(mine.map((k) => k.label)), chords: Object.freeze(mine),
      match: (e) => mine.some((k) => k.match(e)),
      when: c.when ?? null, on: c.on ?? null, run: c.run,
    });
  }));
}

// whether a command that turns something on or off has it on now; null for one that does not
export function state(command, ctx) {
  if (!command.on) return null;
  const r = command.on(ctx);
  if (typeof r !== "boolean") throw new Error(`command ${command.id}: on gave ${JSON.stringify(r)}, not true or false`);
  return r;
}

// a command as a menu's item: its label, keys, why it cannot run now, and whether it is on
const itemOf = (c, ctx) => {
  const on = state(c, ctx);
  return { label: c.label, keys: c.keys, why: why(c, ctx), ...(on === null ? {} : { checked: on }), command: c };
};

// null where the command may run now, or why it cannot
export function why(command, ctx) {
  if (!command.when) return null;
  const r = command.when(ctx);
  if (r === null) return null;
  if (typeof r === "string" && r.trim()) return r;
  throw new Error(`command ${command.id}: when gave ${JSON.stringify(r)}, not null or a reason`);
}

// The command a key press is bound to, whether or not it may run now: null where none is, the
// press was taken already (a pull field's), it is a button's own Enter or space, it is a letter
// being composed, or a text box has the keys and the command is not one that works there. Tab is
// a command's only on the roll or the page itself (ROLL): on a button, a number or any other
// control it moves the keys on, as Tab does.
const ROLL = new Set(["CANVAS", "BODY", "HTML"]);
export function bound(commands, e) {
  if (e.defaultPrevented || e.isComposing) return null;
  const t = e.target, tag = t?.tagName;
  if (tag === "BUTTON" && (e.key === "Enter" || e.key === " ")) return null;
  if (e.key === "Tab" && tag && !ROLL.has(tag)) return null;
  const typing = FIELDS.has(tag) || t?.isContentEditable === true;
  const c = commands.find((c) => c.match(e));
  return c && (!typing || c.typing) ? c : null;
}

// the command a key press runs, or null where none may run now
export function find(commands, e, ctx) {
  const c = bound(commands, e);
  return c && why(c, ctx) === null ? c : null;
}

// The commands offered by a right click on a place, as menu() takes them: a line between groups,
// those with an `under` gathered into a smaller menu where the first of them would be. Each item
// carries its command; one that cannot run now is greyed, with why.
export function items(commands, ctx, place) {
  const out = [], subs = new Map();
  let group = null;
  for (const c of commands) {
    if (!c.where.includes(place)) continue;
    if (group !== null && c.group !== group) out.push("-");
    group = c.group;
    const item = itemOf(c, ctx);
    if (!c.under) {
      out.push(item);
      continue;
    }
    if (!subs.has(c.under)) {
      const sub = { label: c.under, items: [] };
      subs.set(c.under, sub);
      out.push(sub);
    }
    subs.get(c.under).items.push(item);
  }
  return out;
}

// A menu laid out by hand: `layout` a list of command ids, "-" for a line, {label, items: layout}
// for a smaller menu, or an item made by the page ({label, run, ...}, shown as it is). Each id is
// the table's, so that a menu cannot name a command there is not.
export function laid(commands, ctx, layout) {
  if (!Array.isArray(layout)) throw new Error("a menu's layout is a list");
  return layout.map((x) => {
    if (x === "-") return x;
    if (typeof x === "string") {
      const c = commands.find((c) => c.id === x);
      if (!c) throw new Error(`a menu names ${x}, which is no command`);
      return itemOf(c, ctx);
    }
    if (x && Array.isArray(x.items)) return { label: x.label, items: laid(commands, ctx, x.items) };
    if (x && typeof x.label === "string" && typeof x.run === "function") return x;
    throw new Error(`a menu's layout holds ${JSON.stringify(x)}: an id, "-", a smaller menu or an item`);
  });
}

// The commands whose words have every word typed in them, in any order, best first: a word that
// starts a word of the label, then one inside the label, then one in its group or smaller menu's
// name. With nothing typed, the ones used last first, then the table's order.
export function filter(commands, query, recent = []) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const last = (c) => {
    const i = recent.indexOf(c.id);
    return i < 0 ? recent.length : i;
  };
  const scored = [];
  commands.forEach((c, i) => {
    const label = c.label.toLowerCase(), starts = label.split(/[^a-z0-9]+/), more = `${c.under ?? ""} ${c.group}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      const s = starts.some((x) => x.startsWith(w)) ? 3 : label.includes(w) ? 2 : more.includes(w) ? 1 : 0;
      if (!s) return;
      score += s;
    }
    scored.push({ c, score, last: last(c), i });
  });
  scored.sort((a, b) => b.score - a.score || a.last - b.last || a.i - b.i);
  return scored.map((s) => s.c);
}

// ---------------------------------------------------------------- what is open

// One menu or palette open at a time, a document's: {holds(e) (a press inside it), close(chosen)}
const opened = new WeakMap();
const watched = new WeakSet();
const recents = new WeakMap(); // a document's commands chosen in the palette, the last first
let made = 0;
const fresh = () => `cmd-${++made}`;

const el = (document, tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const keysOf = (document, keys) => {
  const span = el(document, "span", "cmd-keys");
  span.append(...keys.map((k) => el(document, "kbd", null, k)));
  return span;
};
const shut = (document) => opened.get(document)?.close(null);
// a press anywhere outside what is open closes it
const watch = (document) => {
  if (watched.has(document)) return;
  watched.add(document);
  document.addEventListener("pointerdown", (e) => {
    const o = opened.get(document);
    if (o && !o.holds(e)) o.close(null);
  });
};
const body = (document) => {
  if (!document.body) throw new Error("the document has no body to open a menu in");
  return document.body;
};
const viewport = (document) => {
  const r = document.documentElement, w = r?.clientWidth, h = r?.clientHeight;
  if (!(w > 0 && h > 0)) throw new Error(`the page is ${w} by ${h}: a menu has nowhere to go`);
  return [w, h];
};
const size = (e) => {
  const r = e.getBoundingClientRect();
  if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) throw new Error("a menu with no size");
  return r;
};
const checkItems = (list, where) => {
  if (!Array.isArray(list) || list.every((it) => it === "-")) throw new Error(`${where}: a menu of nothing`);
  for (const it of list) {
    if (it === "-") continue;
    if (!it || typeof it.label !== "string" || !it.label.trim()) throw new Error(`${where}: an item with no label`);
    if (it.items !== undefined) checkItems(it.items, `${where}, ${it.label}`);
    else if (it.why !== undefined && it.why !== null && (typeof it.why !== "string" || !it.why.trim())) throw new Error(`${where}, ${it.label}: why is null or a reason`);
    if (it.keys !== undefined && (!Array.isArray(it.keys) || it.keys.some((k) => typeof k !== "string"))) throw new Error(`${where}, ${it.label}: keys is a list of names`);
    if (it.checked !== undefined && typeof it.checked !== "boolean") throw new Error(`${where}, ${it.label}: checked is true or false`);
  }
};
const greyed = (it) => (it.items ? it.items.every((x) => x === "-" || greyed(x)) : !!it.why);

// A menu at (x, y) in the window (a right click's clientX and clientY): role menu, a row an item.
// items: {label, keys (shown), why (null, or the reason it is greyed), ...the page's own} or
// {label, items} for a smaller menu, or "-" for a line. Up and down go from row to row, right
// opens a smaller menu and left closes it, Enter or space chooses, a letter goes to the next row
// it starts, Escape closes, as do Tab and a press outside. onDone(item) once, with the item
// chosen or null; a greyed item cannot be chosen. Focus goes back to where it was before onDone.
// An item with `checked` is one that turns something on or off, shown checked where it is on.
// opts: holds(e), a press outside the menu that does not close it (its menu bar); side(d), left
// (-1) or right (1) in the menu itself, past its smaller menus, as a menu bar goes to the next.
export function menu(document, list, x, y, onDone, opts = {}) {
  checkItems(list, "the menu");
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`a menu at ${x}, ${y}`);
  if (typeof onDone !== "function") throw new Error("a menu with nothing to tell what was chosen");
  shut(document);
  watch(document);
  const before = document.activeElement, inside = new WeakSet(), seen = new WeakSet();
  const [vw, vh] = viewport(document);
  let closed = false;
  // the menus open, the first the whole: {el, rows: [{el, item, sub}], at (its row last gone to), parent (the row it opens from), up (that row's menu)}
  const levels = [];
  let keys = null; // the menu the keys are in

  const root = el(document, "div", "cmd-menu");
  const level = (box, list, parent, up) => {
    // a menu with a check in it keeps the room for one before every row, so their words line up
    if (list.some((it) => it !== "-" && it.checked !== undefined)) box.className = "cmd-menu cmd-checks";
    box.setAttribute("role", "menu");
    box.setAttribute("aria-orientation", "vertical");
    box.tabIndex = -1;
    const L = { el: box, rows: [], at: -1, parent, up };
    // a press or a move inside a smaller menu is not the row it opens from
    for (const kind of ["pointermove", "click"]) box.addEventListener(kind, (e) => seen.add(e));
    for (const it of list) {
      if (it === "-") {
        const line = el(document, "div", "cmd-line");
        line.setAttribute("role", "separator");
        box.append(line);
        continue;
      }
      const row = el(document, "div", it.items ? "cmd-item cmd-sub" : "cmd-item");
      row.setAttribute("role", it.checked === undefined ? "menuitem" : "menuitemcheckbox");
      if (it.checked !== undefined) row.setAttribute("aria-checked", String(it.checked));
      row.tabIndex = -1;
      row.setAttribute("aria-disabled", String(greyed(it)));
      if (it.items) {
        row.setAttribute("aria-haspopup", "menu");
        row.setAttribute("aria-expanded", "false");
      }
      if (it.why) row.setAttribute("title", it.why);
      row.append(el(document, "span", "cmd-label", it.label));
      if (it.keys?.length) row.append(keysOf(document, it.keys));
      const r = { el: row, item: it, sub: null };
      const n = L.rows.length;
      L.rows.push(r);
      // the innermost row under the pointer has it: its menu and the one it opens stay
      row.addEventListener("pointermove", (e) => {
        if (closed || seen.has(e)) return;
        seen.add(e);
        go(L, n, r.sub ?? L);
        if (it.items && !greyed(it)) unfold(L, n, false);
      });
      row.addEventListener("click", (e) => {
        if (closed || seen.has(e)) return;
        seen.add(e);
        go(L, n, r.sub ?? L);
        pick(L);
      });
      box.append(row);
    }
    return L;
  };
  // the keys to row n of L, the menus open past `last` folded
  const go = (L, n, last = L) => {
    while (levels.at(-1) !== last) fold();
    L.at = n;
    keys = L;
    L.rows[n].el.focus();
  };
  // the smaller menu open last folded, the keys back on the row it opened from
  const fold = () => {
    const L = levels.pop(), row = L.parent;
    row.sub = null;
    row.el.setAttribute("aria-expanded", "false");
    row.el.className = "cmd-item cmd-sub";
    if (keys === L) {
      keys = L.up;
      row.el.focus();
    }
    L.el.remove();
  };
  // row n's smaller menu opened, the keys taken into it where keyed
  const unfold = (L, n, keyed) => {
    const row = L.rows[n];
    if (row.sub) return keyed && go(row.sub, 0);
    const box = el(document, "div", "cmd-menu");
    const S = level(box, row.item.items, row, L);
    row.sub = S;
    row.el.setAttribute("aria-expanded", "true");
    row.el.className = "cmd-item cmd-sub cmd-open";
    row.el.append(box);
    levels.push(S);
    // fixed beside its row, so a menu that scrolls does not cut it off; on the side with room
    const at = size(row.el), r = size(box);
    const right = at.left + at.width, left = right + 3 + r.width <= vw ? right + 3 : Math.max(0, at.left - 3 - r.width);
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(0, Math.min(at.top - 5, vh - r.height))}px`;
    if (keyed) go(S, 0);
  };
  const pick = (L) => {
    const row = L.rows[L.at];
    if (!row || greyed(row.item)) return;
    if (row.item.items) return unfold(L, L.at, true);
    close(row.item);
  };
  const close = (chosen) => {
    if (closed) return;
    closed = true;
    opened.delete(document);
    root.remove();
    if (before && before.focus) before.focus();
    onDone(chosen);
  };

  root.addEventListener("pointerdown", (e) => inside.add(e));
  root.addEventListener("contextmenu", (e) => e.preventDefault());
  root.addEventListener("focusout", (e) => {
    if (!closed && !(e.relatedTarget && root.contains(e.relatedTarget))) close(null);
  });
  // the keys the menu takes are not the page's: each is prevented, so key() leaves it
  root.addEventListener("keydown", (e) => {
    if (closed || e.metaKey || e.ctrlKey) return;
    const L = keys, n = L.rows.length, k = e.key, row = L.rows[L.at];
    if (k === "Tab") return close(null);
    const opens = row?.item.items && !greyed(row.item);
    const act = {
      ArrowDown: () => go(L, (L.at + 1) % n),
      ArrowUp: () => go(L, L.at <= 0 ? n - 1 : L.at - 1),
      Home: () => go(L, 0),
      End: () => go(L, n - 1),
      ArrowRight: () => (opens ? unfold(L, L.at, true) : opts.side?.(1)),
      ArrowLeft: () => (L.up ? go(L.up, L.up.at) : opts.side?.(-1)),
      Enter: () => pick(L),
      " ": () => pick(L),
      Escape: () => (L.up ? go(L.up, L.up.at) : close(null)),
    }[k];
    if (act) {
      e.preventDefault();
      return act();
    }
    if (k.length !== 1 || !k.trim() || e.altKey) return;
    e.preventDefault();
    const c = k.toLowerCase();
    for (let i = 1; i <= n; i++) {
      const j = (L.at + i + n) % n;
      if (L.rows[j].item.label.trim().toLowerCase().startsWith(c)) return go(L, j);
    }
  });

  levels.push((keys = level(root, list, null, null)));
  opened.set(document, { holds: (e) => inside.has(e) || Boolean(opts.holds?.(e)), close });
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;
  body(document).append(root);
  const r = size(root);
  const left = x + r.width > vw ? Math.max(0, vw - r.width) : x, top = y + r.height > vh ? Math.max(0, vh - r.height) : y;
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  root.focus();
  return { close: () => close(null) };
}

// A row of menus' names in `host` (role menubar): a press on a name opens its menu under it, and a
// press on it again closes it; while one is open, the pointer on another name opens that one, and
// left and right go to the menu beside it. A name pressed keeps the keys where they were, so that
// the menu's command acts on what had them. menus: [{label, items: () => a menu's items, as
// menu() takes them}], made as each opens. onDone(item) with each item chosen.
export function menubar(document, host, menus, onDone) {
  if (!Array.isArray(menus) || !menus.length) throw new Error("a menu bar of nothing");
  if (typeof onDone !== "function") throw new Error("a menu bar with nothing to tell what was chosen");
  menus.forEach((m, i) => {
    if (typeof m?.label !== "string" || !m.label.trim() || typeof m.items !== "function") throw new Error(`menu ${i + 1} of the bar: a label and its items`);
  });
  host.setAttribute("role", "menubar");
  let open = null; // the menu open, by its place
  const holds = (e) => host.contains(e.target);
  const shown = (i, on) => {
    titles[i].setAttribute("aria-expanded", String(on));
    titles[i].className = on ? "cmd-title cmd-open" : "cmd-title";
  };
  const show = (i) => {
    const r = size(titles[i]);
    menu(document, menus[i].items(), r.left, r.top + r.height, (it) => {
      if (open === i) open = null;
      shown(i, false);
      if (it) onDone(it);
    }, { holds, side: (d) => show((i + d + menus.length) % menus.length) });
    open = i;
    shown(i, true);
  };
  const titles = menus.map((m, i) => {
    const t = el(document, "button", "cmd-title", m.label);
    t.type = "button";
    t.tabIndex = -1;
    t.setAttribute("role", "menuitem");
    t.setAttribute("aria-haspopup", "menu");
    t.setAttribute("aria-expanded", "false");
    t.addEventListener("mousedown", (e) => e.preventDefault());
    t.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      if (open === i) shut(document);
      else show(i);
    });
    t.addEventListener("pointerenter", () => { if (open !== null && open !== i) show(i); });
    return t;
  });
  host.replaceChildren(...titles);
  return { titles, open: (i) => show(i), get opened() { return open; } };
}

// The palette: a box to type in over the page, the commands beneath it (role listbox) filtered by
// the words typed in any order, each row with its keys, or why it cannot run now. Up and down
// choose a row, Enter or a click takes it, Escape or a click beside it closes. onDone(command)
// once, with the command taken or null; one that cannot run now cannot be taken. Those taken
// come first the next time, while the page is open.
export function palette(document, commands, ctx, onDone) {
  if (typeof onDone !== "function") throw new Error("a palette with nothing to tell what was chosen");
  const reasons = new Map(commands.map((c) => [c, why(c, ctx)]));
  shut(document);
  watch(document);
  const before = document.activeElement;
  const recent = recents.get(document) ?? [];
  recents.set(document, recent);
  let closed = false, shown = [], at = 0;

  const box = el(document, "dialog", "cmd-palette");
  box.setAttribute("aria-label", "Commands");
  const input = el(document, "input", "cmd-find"), list = el(document, "div", "cmd-list"), none = el(document, "div", "cmd-none", "No command has those words");
  const listId = fresh();
  list.id = listId;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Commands");
  input.type = "text";
  input.placeholder = "Type to find a command";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", listId);
  input.setAttribute("aria-autocomplete", "list");
  none.hidden = true;
  box.append(input, list, none);

  const rows = new Map(); // a command's row, made once
  const row = (c, i) => {
    let r = rows.get(c);
    if (!r) {
      r = el(document, "div", "cmd-row");
      r.id = fresh();
      r.setAttribute("role", "option");
      const w = reasons.get(c);
      r.setAttribute("aria-disabled", String(w !== null));
      if (c.under) r.append(el(document, "span", "cmd-under", c.under));
      r.append(el(document, "span", "cmd-label", c.label));
      if (w !== null) r.append(el(document, "span", "cmd-why", w));
      else r.append(el(document, "span", "cmd-group", c.group));
      const on = state(c, ctx);
      if (on !== null) r.append(el(document, "span", on ? "cmd-state cmd-on" : "cmd-state", on ? "on" : "off"));
      if (c.keys.length) r.append(keysOf(document, c.keys));
      r.addEventListener("pointermove", () => { if (shown[at] !== c) to(shown.indexOf(c), false); });
      r.addEventListener("click", () => take(c));
      rows.set(c, r);
    }
    r.setAttribute("aria-selected", String(i === at));
    return r;
  };
  const to = (i, scroll) => {
    if (!shown.length) return;
    rows.get(shown[at]).setAttribute("aria-selected", "false");
    at = i;
    const r = rows.get(shown[at]);
    r.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", r.id);
    if (scroll) r.scrollIntoView({ block: "nearest" });
  };
  const fill = () => {
    shown = filter(commands, input.value, recent);
    at = 0;
    list.replaceChildren(...shown.map(row));
    none.hidden = shown.length > 0;
    if (shown.length) to(0, true);
    else input.setAttribute("aria-activedescendant", "");
  };
  const take = (c) => {
    if (closed || !c || reasons.get(c) !== null) return;
    const i = recent.indexOf(c.id);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift(c.id);
    recent.length = Math.min(recent.length, 8);
    close(c);
  };
  const close = (chosen) => {
    if (closed) return;
    closed = true;
    opened.delete(document);
    box.close();
    box.remove();
    if (before && before.focus) before.focus();
    onDone(chosen);
  };

  input.addEventListener("input", fill);
  input.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp" || k === "PageDown" || k === "PageUp") {
      e.preventDefault();
      const d = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[k];
      if (shown.length) to(Math.max(0, Math.min(shown.length - 1, at + d)), true);
    } else if (k === "Enter") {
      e.preventDefault();
      take(shown[at]);
    } else if (k === "Escape") {
      e.preventDefault();
      close(null);
    } else if (k === "Tab") e.preventDefault();
  });
  box.addEventListener("cancel", (e) => {
    e.preventDefault();
    close(null);
  });
  // a click beside the box lands on the dialog itself, its backdrop
  box.addEventListener("click", (e) => { if (e.target === box) close(null); });

  // modal: the page under it cannot be pressed
  opened.set(document, { holds: () => true, close });
  body(document).append(box);
  box.showModal();
  input.focus();
  fill();
  return { close: () => close(null) };
}

// The Keys help made from the table: a heading a group, in the table's order, and a line a
// command with keys: its keys, then what it does. gestures: lines for what the mouse does,
// {keys: ["double click"], label, group}, each listed in its group with the keys.
export function help(document, commands, gestures = []) {
  if (!Array.isArray(gestures)) throw new Error("the gestures are not a list");
  for (const g of gestures) {
    if (!Array.isArray(g?.keys) || !g.keys.length || g.keys.some((k) => typeof k !== "string" || !k)) throw new Error(`a gesture with no keys: ${JSON.stringify(g)}`);
    for (const f of ["label", "group"]) if (typeof g[f] !== "string" || !g[f].trim()) throw new Error(`the gesture ${g.keys.join(" ")} has no ${f}`);
  }
  const groups = new Map();
  for (const line of [...commands.filter((c) => c.keys.length), ...gestures]) {
    if (!groups.has(line.group)) groups.set(line.group, []);
    groups.get(line.group).push(line);
  }
  const out = el(document, "div", "cmd-help");
  for (const [group, lines] of groups) {
    const g = el(document, "div", "cmd-help-group");
    g.append(el(document, "h3", null, group));
    for (const line of lines) {
      const r = el(document, "div", "cmd-help-row");
      r.append(keysOf(document, line.keys), el(document, "span", "cmd-label", line.under ? `${line.under}: ${line.label}` : line.label));
      g.append(r);
    }
    out.append(g);
  }
  return out;
}
