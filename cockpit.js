/* cockpit.js — our own A320 control widgets + ECAM chimes, built from scratch.
 * No third-party assets: chimes are synthesized with Web Audio (oscillators);
 * switches are our own SVG/CSS. Cockpit.controlFor(item, action, onDone) returns
 * the contextual control a given ECAM step needs; operating it calls onDone(). */
(function (root) {
  "use strict";

  // ---- chimes (synthesized) ---------------------------------------------
  let _ac = null;
  function ac() {
    if (!_ac) { const AC = root.AudioContext || root.webkitAudioContext; _ac = AC ? new AC() : null; }
    if (_ac && _ac.state !== "running") { try { _ac.resume(); } catch (e) {} }
    return _ac;
  }
  function tone(freq, t0, dur, gain, type) {
    const a = ac(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || "triangle"; o.frequency.value = freq;
    o.connect(g); g.connect(a.destination);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain || 0.18, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }
  let crcTimer = null;
  function singleChime() { const a = ac(); if (!a) return; tone(845, a.currentTime, 0.28, 0.18); }
  function crcStart() {                       // continuous repetitive chime (red warning)
    crcStop();
    const beat = () => { const a = ac(); if (!a) return; tone(900, a.currentTime, 0.16, 0.16); tone(675, a.currentTime + 0.18, 0.16, 0.16); };
    beat(); crcTimer = setInterval(beat, 620);
  }
  function crcStop() { if (crcTimer) { clearInterval(crcTimer); crcTimer = null; } }

  // ---- control widgets ---------------------------------------------------
  function elt(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function fire(onDone, host) { host.classList.add("done"); if (onDone) onDone(); }

  function guardedPush(label, actLabel, onDone) {
    const w = elt("div", "ctl guarded");
    w.appendChild(elt("div", "ctl-label", label));
    const guard = elt("div", "ctl-guard", "▲ lift guard");
    const pb = elt("button", "ctl-pb locked", actLabel);
    guard.addEventListener("click", () => { w.classList.add("open"); guard.textContent = "guard up"; pb.classList.remove("locked"); });
    pb.addEventListener("click", () => { if (pb.classList.contains("locked")) return; fire(onDone, w); });
    w.appendChild(guard); w.appendChild(pb);
    return w;
  }
  function guardedToggle(label, target, onDone) {
    const w = elt("div", "ctl guarded");
    w.appendChild(elt("div", "ctl-label", label));
    const guard = elt("div", "ctl-guard", "▲ lift guard");
    const sw = elt("div", "ctl-toggle locked");
    const on = elt("button", "pos on", "ON"), off = elt("button", "pos off", target || "OFF");
    guard.addEventListener("click", () => { w.classList.add("open"); guard.textContent = "guard up"; sw.classList.remove("locked"); });
    off.addEventListener("click", () => { if (sw.classList.contains("locked")) return; on.classList.remove("sel"); off.classList.add("sel"); fire(onDone, w); });
    on.addEventListener("click", () => { if (sw.classList.contains("locked")) return; });
    sw.appendChild(on); sw.appendChild(off);
    w.appendChild(guard); w.appendChild(sw);
    return w;
  }
  function toggle(label, target, onDone) {
    const w = elt("div", "ctl");
    w.appendChild(elt("div", "ctl-label", label));
    const sw = elt("div", "ctl-toggle");
    const a = elt("button", "pos", target || "ON");
    a.addEventListener("click", () => { a.classList.add("sel"); fire(onDone, w); });
    sw.appendChild(a); w.appendChild(sw);
    return w;
  }
  function momentary(label, actLabel, onDone) {
    const w = elt("div", "ctl");
    w.appendChild(elt("div", "ctl-label", label));
    const pb = elt("button", "ctl-pb", actLabel);
    pb.addEventListener("click", () => fire(onDone, w));
    w.appendChild(pb);
    return w;
  }
  function lever(label, target, onDone) {
    const w = elt("div", "ctl");
    w.appendChild(elt("div", "ctl-label", label));
    const lv = elt("button", "ctl-lever", "▼ " + (target || "IDLE"));
    lv.addEventListener("click", () => fire(onDone, w));
    w.appendChild(lv);
    return w;
  }
  function confirm(label, actLabel, onDone) {
    const w = elt("div", "ctl plain");
    w.appendChild(elt("div", "ctl-label", label));
    const pb = elt("button", "ctl-pb confirm", "✓ " + (actLabel || "DONE"));
    pb.addEventListener("click", () => fire(onDone, w));
    w.appendChild(pb);
    return w;
  }

  function controlFor(item, action, onDone) {
    const t = ((item || "") + " " + (action || "")).toLowerCase();
    const A = (action || "").toUpperCase();
    if (/fire\s*(p\/?b|pushbutton|push\s*button|button)/.test(t) || (/fire/.test(t) && /push/.test(t)))
      return guardedPush("ENG FIRE P/B", "PUSH", onDone);
    if (/master/.test(t)) return guardedToggle("ENG MASTER", A.indexOf("OFF") >= 0 ? "OFF" : A, onDone);
    if (/agent/.test(t)) return momentary("AGENT", A.replace(/\s+AFTER.*/, "") || "DISCH", onDone);
    if (/thrust lever|thr lever|throttle/.test(t)) return lever("THR LEVER", "IDLE", onDone);
    if (/park/.test(t) && /brake|brk/.test(t)) return toggle("PARK BRK", "ON", onDone);
    return confirm((item || "").toUpperCase(), A, onDone);
  }

  root.Cockpit = { controlFor, singleChime, crcStart, crcStop, resume: ac };
})(window);
