// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// commands.js: keys written once and matched on a Mac and elsewhere, the table checked, the
// command a key runs, a right click's menu, the palette and the Keys help, against a stand-in
// document: page_smoke.mjs's, with what is marked "added" below. node commands_test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mac, chord, table, why, state, bound, find, items, laid, filter, menu, menubar, palette, help } from "./commands.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };

// ---- the document: page_smoke.mjs's El, and what the menu and the palette need besides
let clock = 0;
class El {
  constructor(tag, id = null) {
    Object.assign(this, { tagName: tag.toUpperCase(), id, on: {}, style: {}, children: [], value: "", checked: false, disabled: false, hidden: false, textContent: "", className: "", attrs: {}, files: [], open: false, clientWidth: 1200, clientHeight: 700 });
  }
  addEventListener(kind, f) { (this.on[kind] ??= []).push(f); }
  fire(kind, e = {}) {
    const event = { type: kind, target: this, preventDefault() {}, timeStamp: (clock += 1000), ...e };
    for (const f of this.on[kind] ?? []) f(event);
    return event;
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  replaceChildren(...els) { this.children = els; for (const el of els) el.parent = this; }
  append(...els) { this.children.push(...els); for (const el of els) el.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  all(cls) { return this.children.flatMap((c) => [...(String(c.className).split(" ").includes(cls) ? [c] : []), ...c.all(cls)]); }
  getContext() { return null; }
  // added: a size (page_smoke's gives only {left, top})
  getBoundingClientRect() { return { left: parseFloat(this.style.left ?? 0) || 0, top: parseFloat(this.style.top ?? 0) || 0, width: 220, height: 24 * this.children.length }; }
  // added: the palette keeps the row chosen in sight
  scrollIntoView() { this.scrolled = (this.scrolled ?? 0) + 1; }
  // added, for the focusout test only: page_smoke never fires focusout
  contains(el) { for (let e = el; e; e = e.parent) if (e === this) return true; return false; }
  focus() { const was = document.activeElement; document.activeElement = this; if (was && was !== this) was.fire("blur"); }
  select() {}
  blur() {}
  click() { this.fire("click"); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const document = {
  activeElement: null,
  createElement: (tag) => new El(tag),
  on: {},
  addEventListener(kind, f) { (this.on[kind] ??= []).push(f); },
};
document.documentElement = new El("html");
document.body = new El("body"); // added: where a menu and the palette open
// An event as a browser sends it: to the element, then each it is inside, then the document.
// Returns whether something prevented it.
const send = (el, kind, more = {}) => {
  let prevented = false;
  const e = { type: kind, target: el, preventDefault() { prevented = true; }, get defaultPrevented() { return prevented; }, ...more };
  for (let at = el; at; at = at.parent) for (const f of at.on[kind] ?? []) f(e);
  for (const f of document.on[kind] ?? []) f(e);
  return prevented;
};
const text = (el) => el.textContent + el.children.map(text).join("");
const kbds = (el) => (el.tagName === "KBD" ? [el.textContent] : el.children.flatMap(kbds));
const press = (key, more = {}) => ({ key, target: canvas, defaultPrevented: false, ...more });
const canvas = new El("canvas");

// ---- keys written once
{
  check(mac("MacIntel") && mac("macOS") && mac("iPad") && !mac("Win32") && !mac("Linux x86_64"), "a Mac told by its platform's name");
  check(threw(() => mac(undefined))?.includes("not a name"), "no platform is refused");
  const M = (s) => chord(s, "MacIntel"), W = (s) => chord(s, "Win32");
  check(equal(["mod+c", "mod+shift+z", "alt+left", "space", "plus", "minus", "delete", "b", "shift+up", "1"].map((s) => M(s).label),
    ["cmd C", "cmd shift Z", "alt left", "space", "+", "-", "delete", "B", "shift up", "1"]), "labels on a Mac: cmd C, cmd shift Z, alt left, space");
  check(W("mod+c").label === "ctrl C" && W("mod+shift+z").label === "ctrl shift Z", "and elsewhere ctrl");
  check(M("mod+c").match({ key: "c", metaKey: true }) && !M("mod+c").match({ key: "c", ctrlKey: true }) && !M("mod+c").match({ key: "c", metaKey: true, ctrlKey: true }), "on a Mac cmd C is cmd, not ctrl, and not both");
  check(W("mod+c").match({ key: "c", ctrlKey: true }) && !W("mod+c").match({ key: "c", metaKey: true }), "elsewhere it is ctrl");
  check(!M("mod+c").match({ key: "c" }) && !M("c").match({ key: "c", metaKey: true }) && !M("mod+c").match({ key: "c", metaKey: true, altKey: true }), "a modifier missing or one more is not the key");
  check(M("mod+shift+z").match({ key: "Z", metaKey: true, shiftKey: true }) && !M("mod+z").match({ key: "Z", metaKey: true, shiftKey: true }) && !M("mod+shift+z").match({ key: "z", metaKey: true }), "shift is part of a letter's keys");
  check(M("alt+l").match({ key: "¬", code: "KeyL", altKey: true }), "alt and a letter on a Mac, which types a sign, is the letter at its place");
  check(M("mod+c").match({ key: "с", code: "KeyC", metaKey: true }), "a letter of another alphabet is the letter at its place");
  check(M("mod+a").match({ key: "a", code: "KeyQ", metaKey: true }) && !M("mod+q").match({ key: "a", code: "KeyQ", metaKey: true }), "a Latin letter is the letter typed, not the place (AZERTY's A is not Q)");
  check(M("1").match({ key: "1", code: "Digit1" }) && M("1").match({ key: "&", code: "Digit1" }) && M("1").match({ key: "1", code: "Numpad1" }) && !M("1").match({ key: "!", code: "Digit1", shiftKey: true }), "a digit typed, or the digit's place where it types a sign; shifted it is not the digit");
  check(M("plus").match({ key: "+", shiftKey: true }) && M("plus").match({ key: "+" }) && M("=").match({ key: "=" }) && !M("=").match({ key: "+", shiftKey: true }), "a sign that takes shift to type is the sign, shift or not");
  check(M("space").match({ key: " " }) && M("left").match({ key: "ArrowLeft" }) && !M("left").match({ key: "ArrowLeft", shiftKey: true }) && M("shift+up").match({ key: "ArrowUp", shiftKey: true }), "named keys, shift as written");
  for (const [spec, said] of [["mod+", "plus"], ["ctrl+c", "not mod, shift or alt"], ["mod+mod+c", "twice"], ["foo", "not a letter"], ["constructor", "not a letter"], ["", "not a key"]]) check(threw(() => M(spec))?.includes(said), `"${spec}" refused: ${said}`);
  check(threw(() => M("mod+c").match({})).includes("no key"), "a press with no key is refused, not passed over");
}

// ---- the table
const ran = [];
const ctx = { chosen: 2, mixer: false };
const LIST = [
  { id: "copy", label: "Copy the chosen notes", group: "Edit", keys: ["mod+c"], where: ["note"], when: (c) => (c.chosen ? null : "choose a note first"), run: () => ran.push("copy") },
  { id: "paste", label: "Paste", group: "Edit", keys: ["mod+v"], where: ["note", "roll"], run: () => ran.push("paste") },
  { id: "save", label: "Save the score", group: "File", keys: ["mod+s"], typing: true, run: () => ran.push("save") },
  { id: "breath", label: "Breath before the note", group: "Notes", keys: ["b"], where: ["note"], when: (c) => (c.chosen ? null : "choose a note first"), run: () => ran.push("breath") },
  { id: "trill", label: "Trill", group: "Notes", under: "Ornament", where: ["note"], run: () => ran.push("trill") },
  { id: "mordent", label: "Mordent", group: "Notes", under: "Ornament", where: ["note"], when: () => "a mordent needs a note a step above", run: () => ran.push("mordent") },
  { id: "split", label: "Split the note in two", group: "Notes", keys: ["s"], where: ["note"], run: () => ran.push("split") },
  { id: "loop", label: "Loop on or off", group: "Sing", keys: ["o"], where: ["ruler"], run: () => ran.push("loop") },
  { id: "zoom-in", label: "Zoom in", group: "View", keys: ["plus", "="], run: () => ran.push("zoom-in") },
  { id: "undo", label: "Undo", group: "Edit", keys: ["mod+z"], run: () => ran.push("undo") },
  { id: "redo", label: "Redo", group: "Edit", keys: ["mod+shift+z", "mod+y"], run: () => ran.push("redo") },
  { id: "bad", label: "Says yes the wrong way", group: "View", keys: ["x"], when: () => false, run: () => ran.push("bad") },
];
const T = table(LIST, "MacIntel");
const P = table(LIST.filter((c) => c.id !== "bad"), "MacIntel"); // the palette's: every when as it should be
{
  check(T.length === LIST.length && Object.isFrozen(T) && Object.isFrozen(T[0]), "a command a line, frozen");
  check(equal(T.find((c) => c.id === "redo").keys, ["cmd shift Z", "cmd Y"]) && equal(table(LIST, "Win32").find((c) => c.id === "redo").keys, ["ctrl shift Z", "ctrl Y"]), "each command's keys named for the platform");
  const base = { id: "x", label: "X", group: "G", run() {} };
  for (const [list, said] of [
    [[base, base], "command x twice"],
    [[{ ...base, label: " " }], "command x has no label"],
    [[{ ...base, group: undefined }], "command x has no group"],
    [[{ ...base, keyes: ["a"] }], "command x: keyes is not a command's field"],
    [[{ ...base, run: undefined }], "command x has nothing to run"],
    [[{ ...base, when: "now" }], "when is not a function"],
    [[{ ...base, keys: "mod+c" }], "keys is a list"],
    [[{ ...base, keys: ["mod+frob"] }], "command x: keys \"mod+frob\""],
    [[{ ...base, where: "note" }], "where is a list of places"],
    [[{ ...base, keys: ["mod+c"] }, { ...base, id: "y", keys: ["mod+c"] }], "command y: cmd C is already x's"],
    [[{ ...base, keys: ["plus"] }, { ...base, id: "y", keys: ["shift+plus"] }], "command y: shift + is already x's"],
    [[{ ...base, keys: ["shift+="] }, { ...base, id: "y", keys: ["="] }], "command y: = is already x's"],
  ]) check(threw(() => table(list, "MacIntel")) === null ? false : threw(() => table(list, "MacIntel")).includes(said), `refused: ${said}`);
  check(table([{ ...base, keys: ["s"] }, { ...base, id: "y", keys: ["shift+s"] }], "MacIntel").length === 2, "S and shift S are two keys");
  check(threw(() => why(T.find((c) => c.id === "bad"), ctx))?.includes("command bad: when gave false"), "a when that gives neither null nor a reason is refused by name");
}

// ---- the command a key runs
{
  const at = (e, c = ctx) => find(T, e, c)?.id ?? null;
  check(at(press("c", { metaKey: true })) === "copy" && at(press("c", { metaKey: true }), { chosen: 0 }) === null, "cmd C copies while notes are chosen, and runs nothing while none is");
  check(bound(T, press("c", { metaKey: true }))?.id === "copy" && why(bound(T, press("c", { metaKey: true })), { chosen: 0 }) === "choose a note first", "the command bound is still found, with why it cannot run");
  check(at(press("Z", { metaKey: true, shiftKey: true })) === "redo" && at(press("y", { metaKey: true })) === "redo" && at(press("z", { metaKey: true })) === "undo", "undo and its two redos");
  check(at(press("+", { shiftKey: true })) === "zoom-in" && at(press("=")) === "zoom-in", "+ and = both zoom in");
  check(at(press("q")) === null && at(press("c", { ctrlKey: true })) === null, "keys bound to nothing run nothing");
  const field = new El("input"), button = new El("button");
  check(at(press("b", { target: field })) === null && at(press("s", { target: field, metaKey: true })) === "save", "in a text box B is a letter typed, cmd S still saves");
  check(at(press("b", { target: { tagName: "DIV", isContentEditable: true } })) === null, "and in anything typed into");
  check(at(press("Enter", { target: button })) === null && at(press(" ", { target: button })) === null && at(press("b", { target: button })) === "breath", "a button's own Enter and space are the button's");
  const tabbing = table([{ id: "next", label: "The next note", group: "Choose", keys: ["tab"], run() {} }, { id: "before", label: "The note before", group: "Choose", keys: ["shift+tab"], run() {} }], "MacIntel");
  check(["CANVAS", "BODY", "HTML"].every((tagName) => bound(tabbing, press("Tab", { target: { tagName } }))?.id === "next") && bound(tabbing, press("Tab", { shiftKey: true, target: { tagName: "CANVAS" } }))?.id === "before", "Tab and shift Tab are the commands' on the roll and on the page itself");
  check(["BUTTON", "DIV", "SELECT", "INPUT", "A"].every((tagName) => bound(tabbing, press("Tab", { target: { tagName } })) === null && bound(tabbing, press("Tab", { shiftKey: true, target: { tagName } })) === null), "on a button, a number (a pull field's div) or any other control, Tab moves the keys on");
  check(at(press("b", { defaultPrevented: true })) === null && at(press("b", { isComposing: true })) === null, "a press taken already, or a letter being composed, runs nothing");
}

// ---- the commands a right click offers
{
  const note = items(T, ctx, "note");
  check(equal(note.map((it) => (it === "-" ? "-" : it.label)), ["Copy the chosen notes", "Paste", "-", "Breath before the note", "Ornament", "Split the note in two"]), "a note's: its commands in the table's order, a line between groups, the ornaments under one name");
  check(equal(note[4].items.map((it) => [it.label, it.why]), [["Trill", null], ["Mordent", "a mordent needs a note a step above"]]), "the smaller menu holds its commands, each with why it cannot run");
  check(note[0].command.id === "copy" && equal(note[0].keys, ["cmd C"]) && note[0].why === null, "an item carries its command and its keys");
  check(items(T, { chosen: 0 }, "note")[0].why === "choose a note first", "greyed when it cannot run now");
  check(equal(items(T, ctx, "ruler").map((it) => it.label), ["Loop on or off"]) && items(T, ctx, "tab").length === 0, "each place its own");
}

// ---- words in any order
{
  const ids = (q, recent) => filter(T, q, recent).map((c) => c.id);
  check(equal(ids("notes copy"), ["copy"]) && equal(ids("copy notes"), ["copy"]), "words in any order");
  check(equal(ids("ornament"), ["trill", "mordent"]), "a smaller menu's name finds its commands");
  check(ids("s")[0] === "save" || ids("s")[0] === "split", "a word that starts a word of a label first");
  check(equal(ids("the note"), ["copy", "breath", "split"]), "every word must be there (note starts notes)");
  check(equal(ids("frobnicate"), []), "and nothing has words it lacks");
  check(equal(ids("", ["split", "undo"]).slice(0, 3), ["split", "undo", "copy"]), "with nothing typed, those used last first, then the table's order");
  check(equal(ids("  ZOOM  "), ["zoom-in"]), "case and spaces do not matter");
}

// ---- a right click's menu
{
  canvas.focus();
  let done = [];
  const list = items(T, { chosen: 0 }, "note");
  const m = menu(document, list, 100, 200, (it) => done.push(it));
  const root = document.body.children.at(-1);
  check(root.className === "cmd-menu" && root.attrs.role === "menu" && root.style.left === "100px" && root.style.top === "200px" && document.activeElement === root, "opened at the point, role menu, with the keys");
  const rows = root.children.filter((c) => c.attrs.role === "menuitem");
  check(rows.length === 5 && root.children.filter((c) => c.attrs.role === "separator").length === 1, "a row an item, a line between groups");
  check(rows[0].attrs["aria-disabled"] === "true" && rows[0].attrs.title === "choose a note first" && rows[1].attrs["aria-disabled"] === "false", "greyed where it cannot run, saying why");
  check(equal(kbds(rows[1]), ["cmd V"]) && rows[3].attrs["aria-haspopup"] === "menu" && rows[3].attrs["aria-expanded"] === "false", "each row's keys; the ornaments a smaller menu, closed");
  check(send(root, "keydown", { key: "ArrowDown" }) && document.activeElement === rows[0], "down: the first row, greyed but there to read");
  send(root, "keydown", { key: "Enter" });
  check(done.length === 0 && root.parent === document.body, "Enter on a greyed row chooses nothing");
  send(root, "keydown", { key: "ArrowUp" });
  check(document.activeElement === rows[4], "up from the first goes round to the last");
  send(root, "keydown", { key: "b" });
  check(document.activeElement === rows[2], "a letter goes to the next row it starts");
  send(root, "keydown", { key: "ArrowDown" });
  send(root, "keydown", { key: "ArrowRight" });
  const sub = rows[3].children.find((c) => c.attrs.role === "menu"), subRows = sub.children.filter((c) => c.attrs.role === "menuitem");
  check(rows[3].attrs["aria-expanded"] === "true" && document.activeElement === subRows[0] && subRows[1].attrs["aria-disabled"] === "true", "right opens the ornaments, the keys on its first");
  send(subRows[0], "keydown", { key: "ArrowLeft" });
  check(rows[3].attrs["aria-expanded"] === "false" && !rows[3].children.includes(sub) && document.activeElement === rows[3], "left folds it, the keys back on its row");
  send(root, "keydown", { key: " " });
  const sub2 = rows[3].children.find((c) => c.attrs.role === "menu");
  check(sub2 && document.activeElement === sub2.children[0], "space on it opens it too");
  send(sub2.children[0], "keydown", { key: "Escape" });
  check(done.length === 0 && root.parent === document.body && document.activeElement === rows[3], "Escape in it folds only it");
  send(rows[3], "keydown", { key: "ArrowRight" });
  send(document.activeElement, "keydown", { key: "ArrowDown" });
  send(document.activeElement, "keydown", { key: "Enter" });
  check(done.length === 0, "the greyed ornament cannot be chosen");
  send(document.activeElement, "keydown", { key: "ArrowUp" });
  check(send(document.activeElement, "keydown", { key: "Enter" }) && equal(done.map((it) => it.command.id), ["trill"]), "Enter on Trill chooses it, and the page's keys are kept from the press");
  check(root.parent === undefined || !document.body.children.includes(root), "and the menu is gone");
  check(document.activeElement === canvas, "the keys back where they were");
  m.close();
  check(done.length === 1, "told once");
}
{
  let done = [];
  menu(document, items(T, ctx, "note"), 10, 10, (it) => done.push(it));
  const root = document.body.children.at(-1), rows = root.children.filter((c) => c.attrs.role === "menuitem");
  send(rows[0], "pointermove");
  check(document.activeElement === rows[0], "the pointer over a row gives it the keys");
  send(rows[3], "pointermove");
  const sub = rows[3].children.find((c) => c.attrs.role === "menu");
  check(sub && rows[3].attrs["aria-expanded"] === "true" && document.activeElement === rows[3], "over the ornaments it opens them, the keys staying on the row");
  send(sub.children[0], "pointermove");
  check(document.activeElement === sub.children[0] && rows[3].attrs["aria-expanded"] === "true", "into the smaller menu, which stays open");
  send(rows[3], "pointermove");
  check(rows[3].attrs["aria-expanded"] === "true" && document.activeElement === rows[3], "back on its row it stays open");
  send(root, "keydown", { key: "ArrowDown" });
  check(rows[3].attrs["aria-expanded"] === "false" && document.activeElement === rows[4], "down from that row folds it");
  send(rows[3], "pointermove");
  send(rows[1], "pointermove");
  check(rows[3].attrs["aria-expanded"] === "false" && !rows[3].children.some((c) => c.attrs.role === "menu"), "over another row the smaller menu folds");
  send(rows[0], "click");
  check(equal(done.map((it) => it.command.id), ["copy"]), "a click chooses");
}
{
  let done = [];
  menu(document, items(T, ctx, "note"), 10, 10, (it) => done.push(it));
  const root = document.body.children.at(-1);
  send(root.children[0], "pointerdown");
  check(done.length === 0, "a press inside does not close it");
  check(send(root, "contextmenu"), "a right click on it opens no browser menu");
  send(canvas, "pointerdown");
  check(equal(done, [null]) && !document.body.children.includes(root), "a press outside closes it, choosing nothing");
  menu(document, items(T, ctx, "note"), 10, 10, (it) => done.push(it));
  menu(document, items(T, ctx, "ruler"), 10, 10, (it) => done.push(it));
  check(threw(() => palette(document, T, ctx, () => {}))?.includes("command bad: when gave false"), "a palette over a when that says neither is refused by name");
  check(equal(done, [null, null]) && document.body.children.filter((c) => c.className.startsWith("cmd-menu")).length === 1, "a second menu closes the first");
  const second = document.body.children.at(-1);
  send(second, "keydown", { key: "Escape" });
  check(equal(done, [null, null, null]), "Escape closes it");
  menu(document, items(T, ctx, "note"), 10, 10, (it) => done.push(it));
  send(document.body.children.at(-1), "focusout", { relatedTarget: document.body.children.at(-1).children[0] });
  check(done.length === 3, "the keys moving inside it keep it open");
  send(document.body.children.at(-1), "focusout", { relatedTarget: null });
  check(done.length === 4 && done[3] === null, "the keys leaving it (the window left) close it");
  menu(document, items(T, ctx, "note"), 10, 10, (it) => done.push(it));
  const tabbed = document.body.children.at(-1);
  check(!send(tabbed, "keydown", { key: "Tab" }) && done.length === 5, "Tab closes it, and Tab goes on as Tab");
  menu(document, items(T, ctx, "note"), 10, 10, (it) => done.push(it));
  check(!send(document.body.children.at(-1), "keydown", { key: "c", metaKey: true }), "cmd and a key is left to the page");
  document.body.children.at(-1).fire("keydown", { key: "Escape" });
}
{
  // near the corner it opens inside the page; near the right edge its smaller menus open leftward
  const done = [];
  menu(document, items(T, ctx, "note"), 1150, 680, (it) => done.push(it));
  const root = document.body.children.at(-1);
  check(root.style.left === `${1200 - 220}px` && root.style.top === `${700 - 24 * 6}px`, "kept inside the page");
  send(root, "keydown", { key: "Escape" });
  check(threw(() => menu(document, [], 0, 0, () => {}))?.includes("a menu of nothing") && threw(() => menu(document, ["-"], 0, 0, () => {}))?.includes("a menu of nothing"), "a menu of nothing is refused");
  check(threw(() => menu(document, [{ label: "x", why: false }], 0, 0, () => {}))?.includes("why is null or a reason") && threw(() => menu(document, [{ label: "" }], 0, 0, () => {}))?.includes("no label"), "an item that is not one is refused");
  check(threw(() => menu(document, [{ label: "x" }], NaN, 0, () => {}))?.includes("a menu at NaN"), "a menu at no point is refused");
  const body = document.body;
  document.body = null;
  check(threw(() => menu(document, [{ label: "x" }], 0, 0, () => {}))?.includes("no body"), "a document with no body is said");
  document.body = body;
}

// ---- the palette
{
  canvas.focus();
  const done = [];
  palette(document, P, ctx, (c) => done.push(c));
  const box = document.body.children.at(-1), [input, list, none] = box.children;
  const rows = () => list.children;
  check(box.tagName === "DIALOG" && box.open && box.className === "cmd-palette" && document.activeElement === input, "a dialog over the page, the keys in its box");
  check(list.attrs.role === "listbox" && input.attrs["aria-controls"] === list.id && rows().every((r) => r.attrs.role === "option"), "a listbox of options the box controls");
  check(rows().length === P.length && none.hidden, "every command, with nothing typed");
  check(rows()[0].attrs["aria-selected"] === "true" && input.attrs["aria-activedescendant"] === rows()[0].id, "the first chosen");
  const breath = rows()[3];
  check(equal(kbds(breath), ["B"]) && text(breath).includes("Notes"), "each row its keys and its group");
  const mordent = rows()[5];
  check(mordent.attrs["aria-disabled"] === "true" && text(mordent).includes("a mordent needs a note a step above") && text(mordent).includes("Ornament"), "a command that cannot run says why");
  input.value = "note split";
  input.fire("input");
  check(rows().length === 1 && text(rows()[0]).includes("Split the note in two") && rows()[0].attrs["aria-selected"] === "true", "words typed filter it");
  input.value = "zzz";
  input.fire("input");
  check(rows().length === 0 && !none.hidden, "none found is said");
  check(send(input, "keydown", { key: "Enter" }) && done.length === 0, "and Enter then takes nothing");
  input.value = "o";
  input.fire("input");
  const n = rows().length;
  send(input, "keydown", { key: "ArrowDown" });
  send(input, "keydown", { key: "ArrowDown" });
  check(rows()[2].attrs["aria-selected"] === "true" && rows()[0].attrs["aria-selected"] === "false" && rows()[2].scrolled > 0 && input.attrs["aria-activedescendant"] === rows()[2].id, "down moves the choice, kept in sight");
  for (let i = 0; i < n + 3; i++) send(input, "keydown", { key: "ArrowDown" });
  check(rows()[n - 1].attrs["aria-selected"] === "true", "and stops at the last");
  send(input, "keydown", { key: "PageUp" });
  check(rows()[Math.max(0, n - 9)].attrs["aria-selected"] === "true", "page up goes eight back");
  check(send(input, "keydown", { key: "Tab" }) && document.activeElement === input, "Tab keeps the keys in the box");
  input.value = "mordent";
  input.fire("input");
  send(input, "keydown", { key: "Enter" });
  rows()[0].fire("click");
  check(done.length === 0 && box.open, "a command that cannot run is not taken, by Enter or a click");
  input.value = "loop";
  input.fire("input");
  check(send(input, "keydown", { key: "Enter" }), "Enter is kept from the page");
  check(equal(done.map((c) => c.id), ["loop"]) && !box.open && !document.body.children.includes(box) && document.activeElement === canvas, "Enter takes the command, closes, and gives the keys back");
  check(ran.length === 0, "and runs nothing itself: the page runs it");
}
{
  const done = [];
  palette(document, P, ctx, (c) => done.push(c));
  let box = document.body.children.at(-1), [input, list] = box.children;
  check(list.children[0].children.some((s) => s.textContent === "Loop on or off"), "the command taken last comes first next time");
  send(list.children[2], "pointermove");
  check(list.children[2].attrs["aria-selected"] === "true", "the pointer chooses a row");
  list.children[2].fire("click");
  check(done[0]?.id === filter(P, "", ["loop"])[2].id, "a click takes it");
  palette(document, P, ctx, (c) => done.push(c));
  box = document.body.children.at(-1);
  [input] = box.children;
  check(send(input, "keydown", { key: "Escape" }) && done[1] === null && !box.open, "Escape closes it, taking nothing");
  palette(document, P, ctx, (c) => done.push(c));
  box = document.body.children.at(-1);
  box.fire("click", { target: box.children[1] });
  check(done.length === 2 && box.open, "a click in it does not close it");
  box.fire("click");
  check(done[2] === null && !box.open, "a click beside it (its backdrop) does");
  palette(document, P, ctx, (c) => done.push(c));
  box = document.body.children.at(-1);
  check(send(box, "cancel") && done[3] === null, "the browser's own cancel closes it as Escape does");
  palette(document, P, ctx, (c) => done.push(c));
  menu(document, [{ label: "x" }], 0, 0, (c) => done.push(c));
  check(done[4] === null && !document.body.children.at(-2)?.open, "a menu opened closes the palette");
  send(canvas, "pointerdown");
  check(done[5] === null, "and a press outside the menu closes it");
}

// ---- a command that turns something on or off; menus laid out by hand; the menu bar
{
  let on = false, ran = [];
  const t = table([
    { id: "loop", label: "Loop", group: "Sing", keys: ["o"], on: () => on, run: () => ran.push("loop") },
    { id: "sing", label: "Sing", group: "Sing", keys: ["space"], run: () => ran.push("sing") },
    { id: "cut", label: "Cut", group: "Edit", when: () => "nothing is chosen", run: () => ran.push("cut") },
  ], "MacIntel");
  check(state(t[0], {}) === false && state(t[1], {}) === null, "a toggle says whether it is on; another command says nothing");
  check(threw(() => table([{ id: "x", label: "x", group: "G", on: true, run() {} }], "MacIntel"))?.includes("on is not a function") && threw(() => state(table([{ id: "x", label: "x", group: "G", on: () => 1, run() {} }], "MacIntel")[0], {}))?.includes("not true or false"), "an on that is not a function, or gives no true or false, is refused");
  const L = laid(t, {}, ["sing", "-", { label: "More", items: ["loop", "cut"] }, { label: "Mine", run: () => ran.push("mine") }]);
  check(L[0].label === "Sing" && L[1] === "-" && L[2].items[0].checked === false && L[2].items[1].why === "nothing is chosen" && L[3].label === "Mine", "a menu laid out by id: lines, a smaller menu, a toggle unchecked, a greyed command, an item of the page's");
  check(threw(() => laid(t, {}, ["nope"]))?.includes("nope, which is no command") && threw(() => laid(t, {}, [7]))?.includes("an id"), "a layout naming no command, or holding something else, is refused");
  on = true;
  let done = [];
  menu(document, laid(t, {}, ["loop", "sing"]), 0, 0, (it) => done.push(it));
  let box = document.body.children.at(-1);
  check(box.className === "cmd-menu cmd-checks" && box.children[0].attrs.role === "menuitemcheckbox" && box.children[0].attrs["aria-checked"] === "true" && box.children[1].attrs.role === "menuitem" && box.children[1].attrs["aria-checked"] === undefined, "in a menu a toggle is a checkbox, checked while on");
  send(box, "keydown", { key: "Escape" });
  // the bar: a press opens a menu under its name, another press closes it; the pointer moves it to the next while one is open
  const host = new El("nav");
  document.body.append(host);
  const made = [];
  const bar = menubar(document, host, [
    { label: "Edit", items: () => { made.push("Edit"); return laid(t, {}, ["cut"]); } },
    { label: "Sing", items: () => { made.push("Sing"); return laid(t, {}, ["sing", "loop"]); } },
  ], (it) => done.push(it));
  const [e, sg] = bar.titles, menus = () => document.body.children.filter((c) => c.className.split(" ").includes("cmd-menu"));
  check(host.attrs.role === "menubar" && equal(host.children.map((c) => c.textContent), ["Edit", "Sing"]) && e.attrs["aria-haspopup"] === "menu", "a menu bar of names, each with a menu");
  send(e, "pointerdown", { button: 0 });
  check(menus().length === 1 && bar.opened === 0 && e.attrs["aria-expanded"] === "true" && equal(made, ["Edit"]), "a press opens its menu, made as it opens");
  send(sg, "pointerenter");
  check(menus().length === 1 && bar.opened === 1 && e.attrs["aria-expanded"] === "false" && sg.attrs["aria-expanded"] === "true", "the pointer on the next name opens that one in its place");
  send(document.body.children.at(-1), "keydown", { key: "ArrowRight" });
  check(menus().length === 1 && bar.opened === 0, "right goes on to the menu beside it, round the bar");
  send(document.body.children.at(-1), "keydown", { key: "ArrowLeft" });
  check(bar.opened === 1, "and left back");
  send(sg, "pointerdown", { button: 0 });
  check(menus().length === 0 && bar.opened === null && sg.attrs["aria-expanded"] === "false", "a press on its name again closes it");
  const before = done.length;
  send(sg, "pointerdown", { button: 0 });
  document.body.children.at(-1).children[0].fire("click");
  check(done.length === before + 1 && done.at(-1).command.id === "sing" && menus().length === 0 && bar.opened === null, "a row chosen is handed to the page, and the menu closes");
  send(e, "pointerdown", { button: 0 });
  send(e, "mousedown");
  check(menus().length === 1, "a press on the bar does not close the menu it opened");
  send(canvas, "pointerdown");
  check(menus().length === 0 && bar.opened === null, "a press outside does");
  check(threw(() => menubar(document, host, [], () => {}))?.includes("of nothing") && threw(() => menubar(document, host, [{ label: "x" }], () => {}))?.includes("a label and its items"), "a bar of nothing, or a menu with no items, is refused");
}

// ---- the Keys help
{
  const out = help(document, T, [{ keys: ["double click"], label: "an empty spot adds a note", group: "Notes" }, { keys: ["drag"], label: "along the ruler marks a loop", group: "Sing" }]);
  const groups = out.children;
  check(out.className === "cmd-help" && equal(groups.map((g) => g.children[0].textContent), ["Edit", "File", "Notes", "Sing", "View"]), "a heading a group, in the table's order");
  const lines = (g) => g.children.slice(1).map((r) => [kbds(r).join(" "), r.children[1].textContent]);
  check(equal(lines(groups[0]), [["cmd C", "Copy the chosen notes"], ["cmd V", "Paste"], ["cmd Z", "Undo"], ["cmd shift Z cmd Y", "Redo"]]), "a line a command with keys: its keys, what it does");
  check(equal(lines(groups[2]), [["B", "Breath before the note"], ["S", "Split the note in two"], ["double click", "an empty spot adds a note"]]), "commands with no keys are left to the palette; the mouse's lines in their group");
  check(equal(lines(groups[4]), [["+ =", "Zoom in"], ["X", "Says yes the wrong way"]]), "both keys of a command");
  check(threw(() => help(document, T, [{ keys: [], label: "x", group: "G" }]))?.includes("a gesture with no keys") && threw(() => help(document, T, [{ keys: ["drag"], group: "G" }]))?.includes("has no label"), "a mouse line that is not one is refused");
}

// ---- the page's keys today (page.js key()) fit in one table with no key twice
{
  const run = () => {};
  const today = [
    ["save", ["mod+s"]], ["open", ["mod+o"]], ["undo", ["mod+z"]], ["redo", ["mod+shift+z", "mod+y"]], ["all", ["mod+a"]], ["sing", ["space"]],
    ["mixer", ["m"]], ...Array.from({ length: 9 }, (_, i) => [`singer-${i + 1}`, [String(i + 1)]]), ["loop", ["o"]], ["click", ["k"]],
    ["remove", ["delete", "backspace"]], ["earlier", ["left"]], ["later", ["right"]], ["shorter", ["alt+left"]], ["longer", ["alt+right"]],
    ["up", ["up"]], ["down", ["down"]], ["octave-up", ["shift+up"]], ["octave-down", ["shift+down"]], ["word", ["enter"]], ["none", ["escape"]],
    ["breath", ["b"]], ["line", ["l"]], ["start", ["home"]], ["others", ["g"]], ["draw", ["d"]], ["fit", ["f"]], ["zoom-in", ["=", "plus"]], ["zoom-out", ["minus"]],
    ["palette", ["mod+k"]],
  ];
  const t = table(today.map(([id, keys]) => ({ id, label: id, group: "Today", keys, run })), "MacIntel");
  const at = (key, more = {}) => find(t, press(key, more), {})?.id ?? null;
  check(t.length === today.length, "every key key() has, and cmd K, in one table");
  check(equal([at("z", { metaKey: true }), at("ArrowUp", { shiftKey: true }), at("ArrowRight", { altKey: true }), at("3"), at("Backspace"), at("+", { shiftKey: true }), at("-"), at(" ")],
    ["undo", "octave-up", "longer", "singer-3", "remove", "zoom-in", "zoom-out", "sing"]), "and each found as page_smoke presses it");
}

// ---- the house's writing
{
  const here = (n) => fileURLToPath(new URL(n, import.meta.url));
  for (const f of ["commands.js", "commands_test.mjs", "menu.css"]) {
    const s = readFileSync(here(f), "utf8");
    check(!new RegExp(String.raw`[\u2013\u2014]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]`, "u").test(s), `${f}: no dashes of that kind and no emoji`);
  }
  // the custom properties menu.css takes are editor.css's
  const css = readFileSync(here("menu.css"), "utf8"), root = readFileSync(here("editor.css"), "utf8");
  const defined = new Set([...root.slice(0, root.indexOf("}")).matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  const used = [...new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]))];
  check(used.length > 0 && used.every((v) => defined.has(v)), `menu.css uses only editor.css's properties: ${used.join(" ")}`);
}

console.log(fails ? `${fails} failed` : "all ok");
process.exit(fails ? 1 : 0);
