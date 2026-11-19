// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A number's field made for the mouse: press and pull (right or up for more, shift for a tenth
// of the pace) and it changes as it is pulled; a click that does not pull types into it; alt and
// a click puts it back as it was made. With the keys, when it has them: the arrows step it (shift
// finer, page up and down ten at a time), enter or a digit types, delete puts it back. The wheel
// steps it while it has the keys. A bar behind the number shows where it is in its range.
//
//   pull(document, o)  ->  {el, set(value), able(yes), typed(text), o}
//   o: min, max        the pull's range (max Infinity: no end, `per` a pixel)
//      lo, hi          what a typed number may be, where wider than the pull's range
//      step, fine      what a pull and an arrow move by, and with shift (fine: step / 10)
//      whole           no fractions: fine is step
//      log             pulled by ratio
//      def             what alt and a click put it back to
//      origin          where the bar starts (0 for a setting that goes both ways)
//      per             a pixel's worth, where the range has no end
//      unit, label
//      show(v), text(v), read(text)   as shown, as typed over, and a typed text's value (throws)
//      begin(), change(v), end()      a pull's start, each new value, its end; a typed value or
//                                     a step is all three at once
//      said(message)                  what is wrong with a typed text, or null

const PIXELS = 220; // a pull across the range
const SLOP = 3; // pixels a press may move and still be a click

const places = (step) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));

export function pull(document, o) {
  o = { step: 1, origin: null, unit: "", log: false, whole: false, said: () => {}, begin: () => {}, end: () => {}, ...o };
  const el = document.createElement("div"), bar = document.createElement("span"), shown = document.createElement("span");
  el.className = "pull";
  bar.className = "pull-bar";
  shown.className = "pull-v";
  el.tabIndex = 0;
  el.setAttribute("role", "spinbutton");
  if (o.label) el.setAttribute("aria-label", o.label);
  el.title = o.title ?? "drag to change (hold shift for small steps); click to type; alt + click resets it";
  el.append(bar, shown);
  let value = null, on = true, drag = null, input = null;

  const lo = () => o.lo ?? o.min, hi = () => o.hi ?? o.max;
  const fine = () => (o.whole ? o.step : o.fine ?? o.step / 10);
  const round = (v, by) => Number((Math.round(v / by) * by).toFixed(places(by)));
  const fit = (v, by) => Math.max(lo(), Math.min(hi(), round(v, by)));
  const show = (v) => (o.show ? o.show(v) : `${v.toFixed(places(o.step))}${o.unit ? `${o.unit.startsWith(":") ? "" : " "}${o.unit}` : ""}`);
  const text = (v) => (o.text ? o.text(v) : String(v));
  const read = (s) => {
    if (o.read) return o.read(s);
    if (!/^-?\d+(\.\d+)?$/.test(s.trim())) throw new Error(`${s}: not a number`);
    const v = Number(s);
    if (v < lo() || v > hi()) throw new Error(`${s}: ${lo()} to ${hi()}`);
    if (o.whole && !Number.isInteger(v)) throw new Error(`${s}: a whole number`);
    return v;
  };
  // where a value is along the bar, 0 to 1
  const along = (v) => {
    const c = Math.max(o.min, Math.min(o.max, v));
    return o.log ? Math.log(c / o.min) / Math.log(o.max / o.min) : (c - o.min) / (o.max - o.min);
  };

  function draw() {
    shown.textContent = value === null || !on ? "" : show(value);
    el.className = `pull${on ? "" : " off"}${drag?.pulled ? " pulling" : ""}${input ? " typing" : ""}`;
    el.setAttribute("aria-disabled", String(!on));
    if (value === null || !on || !Number.isFinite(o.max)) {
      bar.style.width = "0";
      return;
    }
    el.setAttribute("aria-valuenow", String(value));
    el.setAttribute("aria-valuetext", show(value));
    const a = along(value), b = o.origin === null ? 0 : along(o.origin);
    bar.style.left = `${Math.min(a, b) * 100}%`;
    bar.style.width = `${Math.abs(a - b) * 100}%`;
  }

  // one change, whole
  function once(v) {
    if (v === value) return;
    o.begin();
    o.change(v);
    o.end();
  }

  function type(first = null) {
    if (!on || input) return;
    input = document.createElement("input");
    input.className = "pull-in";
    input.value = first ?? text(value);
    input.spellcheck = false;
    const done = (keep) => {
      if (!input) return;
      const was = input;
      if (keep) {
        let v;
        try {
          v = read(was.value);
        } catch (e) {
          o.said(e.message);
          was.className = "pull-in bad";
          return false;
        }
        input = null;
        o.said(null);
        once(v);
      } else {
        input = null;
        o.said(null);
      }
      was.remove?.();
      el.replaceChildren(bar, shown);
      draw();
      return true;
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation?.();
      if (e.key === "Enter" || e.key === "Tab") {
        if (e.key === "Enter") e.preventDefault();
        if (done(true) && e.key === "Enter") el.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        done(false);
        el.focus();
      }
    });
    input.addEventListener("blur", () => { if (input && done(true) === false) done(false); });
    for (const kind of ["pointerdown", "pointermove", "pointerup", "wheel"]) input.addEventListener(kind, (e) => e.stopPropagation?.());
    el.replaceChildren(bar, shown, input);
    draw();
    input.focus();
    if (first === null) input.select();
  }

  function pulled(e) {
    const d = (e.clientX - drag.x) - (e.clientY - drag.y), by = e.shiftKey ? fine() : o.step, slow = e.shiftKey ? 0.1 : 1;
    let v;
    if (!Number.isFinite(o.max) || o.per) v = drag.value + d * slow * (o.per ?? o.step / 4);
    else if (o.log) v = Math.max(o.min, drag.value) * (o.max / o.min) ** (d * slow / PIXELS);
    else v = drag.value + d * slow * (o.max - o.min) / PIXELS;
    return fit(v, by);
  }

  el.addEventListener("pointerdown", (e) => {
    if (!on || input || e.button > 0) return;
    e.preventDefault();
    el.focus();
    el.setPointerCapture?.(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, value, pulled: false, alt: e.altKey };
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.pulled) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < SLOP) return;
      drag.pulled = true;
      o.begin();
    }
    const v = pulled(e);
    if (v !== value) o.change(v);
    draw();
  });
  const up = (e) => {
    if (!drag) return;
    el.releasePointerCapture?.(e.pointerId);
    const was = drag;
    drag = null;
    if (was.pulled) o.end();
    else if (e.type === "pointerup") {
      if (was.alt) {
        if (o.def !== undefined) once(o.def);
      } else type();
    }
    draw();
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("keydown", (e) => {
    if (!on || input || e.target !== el || e.metaKey || e.ctrlKey) return;
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (dir !== undefined) {
      // a step; where the field goes by ratio, a sixtieth of its range, and a step at the least
      const by = e.shiftKey ? fine() : o.step;
      let v = fit(o.log ? value * (o.max / o.min) ** (dir * (e.shiftKey ? 0.1 : 1) / 60) : value + dir * by, by);
      if (v === value) v = fit(value + Math.sign(dir) * by, by);
      once(v);
    }
    else if (e.key === "Enter") type();
    else if (/^[0-9.\-]$/.test(e.key)) type(e.key);
    else if ((e.key === "Delete" || e.key === "Backspace") && o.def !== undefined) once(o.def);
    else if (e.key === "Home" && Number.isFinite(o.min)) once(o.min);
    else if (e.key === "End" && Number.isFinite(o.max)) once(o.max);
    else return;
    e.preventDefault();
    e.stopPropagation?.();
  });
  el.addEventListener("wheel", (e) => {
    if (!on || input || document.activeElement !== el) return;
    e.preventDefault();
    once(fit(value - Math.sign(e.deltaY) * (e.shiftKey ? fine() : o.step), e.shiftKey ? fine() : o.step));
  });

  draw();
  return {
    el, o,
    set(v) {
      if (v === value) return;
      value = v;
      draw();
    },
    able(yes) {
      if (yes === on) return;
      on = yes;
      draw();
    },
    // a text typed over the number, as the field's own typing takes it: false where it is refused
    typed(s) {
      let v;
      try {
        v = read(s);
      } catch (e) {
        o.said(e.message);
        return false;
      }
      o.said(null);
      once(v);
      return true;
    },
    get value() { return value; },
    get busy() { return Boolean(drag || input); },
  };
}
