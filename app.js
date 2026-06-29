/* app.js — A320 Abnormals Trainer (iPad PWA).
 * Speak-then-tap/type drill + listen-through, grading via the verified Matcher.
 * Plays the bundled premium Deepgram WAVs; falls back to the device voice. */
"use strict";

const $ = (id) => document.getElementById(id);
const el = {
  menu: $("screen-menu"), drill: $("screen-drill"), done: $("screen-done"),
  listAbn: $("list-abn"), listRest: $("list-rest"), listMem: $("list-mem"),
  btnMenu: $("btn-menu"), progress: $("progress"),
  subflowBar: $("subflow-bar"), cueCard: $("cue-card"), cueKind: $("cue-kind"), cueItem: $("cue-item"), cueSub: $("cue-sub"),
  ecam: $("ecam"), ecamTitle: $("ecam-title"), ecamLines: $("ecam-lines"), ecamCaption: $("ecam-caption"),
  answerZone: $("answer-zone"), answer: $("answer"), verdict: $("verdict"),
  revealCard: $("reveal-card"), revealAction: $("reveal-action"),
  revealCallout: $("reveal-callout"), revealWhy: $("reveal-why"), revealCite: $("reveal-cite"),
  controls: $("controls"),
  doneScore: $("done-score"), donePct: $("done-pct"), doneMissed: $("done-missed"),
  btnAgain: $("btn-again"), btnBack: $("btn-back"), modeToggle: $("mode-toggle"), modeHint: $("mode-hint"),
};

let DATA = null;
let MODE = "drill";
const MAX_RETRIES = 1;

// ---- audio --------------------------------------------------------------
const audioEl = new Audio();
audioEl.preload = "auto";
let pickedVoice = null;

// iOS unlocks media + speech only inside a user gesture. Play a silent blip on
// the first flow tap so later programmatic plays (incl. live Deepgram TTS on a
// flow with no bundled audio) are allowed.
const SILENT_WAV = "data:audio/wav;base64,UklGRiQCAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQACAAAA" + "A".repeat(682) + "==";
let audioUnlocked = false;
let audioCtx = null;          // shared AudioContext (resumed in-gesture, reused for STT)
let micStream = null;         // shared mic stream for the whole drill (hands-free loop)
const AUTO = true;            // auto-arm mic after each prompt + auto-advance after grading
let R = {}, replayFn = null;  // memory-item recall exam state + "run again" dispatcher
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    audioEl.muted = true;
    audioEl.src = SILENT_WAV;
    const p = audioEl.play();
    const fin = () => { try { audioEl.pause(); } catch (e) {} audioEl.muted = false; };
    if (p && p.then) p.then(fin).catch(() => { audioEl.muted = false; });
    else fin();
  } catch (e) { audioEl.muted = false; }
  try { if ("speechSynthesis" in window) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } } catch (e) {}
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !audioCtx) audioCtx = new AC();
    if (audioCtx && audioCtx.state !== "running") audioCtx.resume();
  } catch (e) {}
}
async function primeMic() {
  // grab mic permission + a reusable stream during the start gesture, so the
  // mic can auto-arm on each item without a fresh prompt.
  if (!DG.hasProxy() || micStream) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
  } catch (e) { micStream = null; }   // denied -> manual 🎤 button still works
}
function stopMic() {
  try { if (micStream) micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  micStream = null;
}
function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  const vs = speechSynthesis.getVoices() || [];
  pickedVoice = vs.find(v => /en[-_]US/i.test(v.lang) && /Samantha|Aaron|Nicky|Siri/i.test(v.name))
    || vs.find(v => /en[-_]US/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
}
if ("speechSynthesis" in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

function ttsSpeak(t) {
  return new Promise((res) => {
    if (!t || !("speechSynthesis" in window)) return res();
    try {
      const u = new SpeechSynthesisUtterance(t);
      u.rate = 1.0; u.pitch = 1.0; u.lang = "en-US";
      if (pickedVoice) u.voice = pickedVoice;
      u.onend = () => res(); u.onerror = () => res();
      speechSynthesis.speak(u);
    } catch (e) { res(); }
  });
}
function playUrl(url, fallbackText) {
  return new Promise((res) => {
    audioEl.onended = () => res();
    audioEl.onerror = () => ttsSpeak(fallbackText).then(res);
    try {
      audioEl.src = url;
      const p = audioEl.play();
      if (p && p.catch) p.catch(() => ttsSpeak(fallbackText).then(res));
    } catch (e) { ttsSpeak(fallbackText).then(res); }
  });
}
// ---- audio cache + preload (kill per-item latency) ----------------------
const AUDIO_CACHE = "a320-audio-v1";
const bundledMem = new Map();
async function cachedBundled(url) {
  if (bundledMem.has(url)) return bundledMem.get(url);
  try {
    const cache = await caches.open(AUDIO_CACHE);
    let resp = await cache.match(url);
    if (!resp) { const r = await fetch(url); if (!r.ok) return url; await cache.put(url, r.clone()); resp = r; }
    const u = URL.createObjectURL(await resp.blob());
    bundledMem.set(url, u);
    return u;
  } catch (e) { return url; }            // no Cache API -> direct URL (still HTTP-cached)
}
async function audioUrl(obj) {
  if (!obj) return null;
  if (obj.a) return cachedBundled("./audio/" + obj.a);   // bundled WAV (abnormals)
  if (DG.hasProxy()) { try { const u = await DG.speak(obj.t); if (u) return u; } catch (e) {} }
  return null;                            // -> device-voice fallback
}
async function speak(obj) {
  if (!obj || !obj.t) return;
  const url = await audioUrl(obj);
  if (url) return playUrl(url, obj.t);
  return ttsSpeak(obj.t);
}

// Warm the cache for EVERY spoken line of a flow, in the background, so each
// item is already buffered (and instant + offline) by the time you reach it.
function collectLines(f, seat) {
  const out = [], push = (o) => { if (o && (o.a || o.t)) out.push(o); };
  push(f.sop_intro);
  const items = (f.seats[seat] && f.seats[seat].items) || [];
  for (const d of items) {
    push(d.sop_intro); push(d.condition); push(d.prompt); push(d.reveal);
    push(d.correct_line); push(d.explain); push(d.brief_line); push(d.narration);
  }
  const seen = new Set(), uniq = [];
  for (const o of out) { const k = o.a || o.t; if (!seen.has(k)) { seen.add(k); uniq.push(o); } }
  return uniq;
}
let preloadToken = 0;
async function preloadFlow(f, seat) {
  const my = ++preloadToken;
  const lines = collectLines(f, seat);
  let i = 0, done = 0;
  const worker = async () => {
    while (i < lines.length && my === preloadToken) {
      const obj = lines[i++];
      try { await audioUrl(obj); } catch (e) {}
      done++;
      if (el.progress && S.mode) el.progress.title = `buffered ${done}/${lines.length}`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, lines.length) }, worker));
}
function stopSpeak() {
  try { audioEl.pause(); } catch (e) {}
  try { if ("speechSynthesis" in window) speechSynthesis.cancel(); } catch (e) {}
}
async function speakSeq(list, gen) {
  for (const o of list) {
    if (gen !== S.gen) return;
    await speak(o);
  }
}

// ---- speech recognition -------------------------------------------------
// Aviation keyterm bias for Deepgram (mirrors stt_deepgram._KEYTERMS + abnormal vocab).
const KEYTERMS = [
  "QNH", "flight level", "altitude", "heading", "standard", "transition",
  "V1", "VR", "V2", "VREF", "VAPP", "green dot", "FLEX", "TOGA",
  "thrust idle", "climb thrust", "flaps", "gear up", "gear down", "speedbrake",
  "autobrake", "parking brake", "pull", "push", "managed", "selected",
  "approach", "localizer", "glideslope", "go around", "SRS", "MAN FLEX", "MAN TOGA",
  "ECAM", "FMA", "FCU", "MCDU", "PFD", "ND", "autopilot", "autothrust",
  "flight director", "anti ice", "packs", "bleed", "APU", "beacon", "strobe",
  "ignition", "TCAS", "transponder", "squawk", "radar", "checked", "rotate",
  "positive climb", "set", "cross check", "displayed", "stow", "reset",
  "reverse", "max reverse", "anti skid", "release", "PSI", "pull up", "windshear",
  "stall", "I have control", "MCT", "emergency descent", "unreliable speed", "terrain",
  // abnormal vocab
  "idle", "engine master", "engine fire pushbutton", "agent", "agent 1", "agent 2",
  "discharge", "shut down", "do not restart", "notify ATC", "cabin crew", "alert",
  "emergency evacuation", "evacuate", "land as soon as possible", "thrust lever",
  "hydraulic", "blue", "green", "yellow", "RAT", "status", "QRH", "confirm", "clear",
];
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micAvail = !!SR;
const voiceInAvail = () => DG.hasProxy() || micAvail;
let recognizer = null;

function startListen(d) {
  if (S.listening) { if (S.recCtl) { S.recCtl.stop(); } return; }   // tap again = stop
  stopSpeak();
  if (DG.hasProxy()) return dgListen(d);
  return webSpeechListen(d);
}

async function dgListen(d) {
  const myGen = ++S.listenGen;
  S.listening = true; S.recCtl = null;
  el.verdict.textContent = "🎤 Listening… say the action (tap 🎤 to stop)";
  el.verdict.className = "listening";
  try {
    const txt = await DG.listen({
      keyterms: KEYTERMS,
      stream: micStream || undefined,
      audioContext: audioCtx || undefined,
      onPartial: (t) => { if (myGen === S.listenGen) el.answer.value = t; },
      register: (c) => { S.recCtl = c; },
      maxMs: 9000,
    });
    if (myGen !== S.listenGen) return;          // superseded (moved on / manual action)
    S.listening = false; S.recCtl = null;
    if (!txt) { el.verdict.textContent = "Didn't catch that — tap 🎤 to retry, or type."; el.verdict.className = "bad"; return; }
    el.answer.value = txt;
    onSubmit();
  } catch (e) {
    if (myGen !== S.listenGen) return;
    S.listening = false; S.recCtl = null;
    el.verdict.textContent = /denied|notallowed|permission/i.test(String(e))
      ? "Mic blocked — allow the microphone for this site in Safari, then tap 🎤."
      : "Voice unavailable — type instead, or tap 🎤 to retry.";
    el.verdict.className = "bad";
  }
}

function webSpeechListen(d) {
  if (!SR) { onSubmit(); return; }
  if (S.listening) return;
  stopSpeak();                       // free the mic from any TTS playback
  let rec;
  try { rec = new SR(); } catch (e) { el.verdict.textContent = "Mic unavailable — type instead."; el.verdict.className = "bad"; return; }
  recognizer = rec;
  rec.lang = "en-US";
  rec.continuous = false;
  rec.interimResults = false;
  rec.maxAlternatives = 5;
  S.listening = true;
  el.verdict.textContent = "🎤 Listening… say the action";
  el.verdict.className = "listening";
  rec.onresult = (e) => {
    S.listening = false;
    let alts = [];
    try { const r = e.results[0]; for (let k = 0; k < r.length; k++) alts.push(r[k].transcript || ""); } catch (_) {}
    const top = alts[0] || "";
    el.answer.value = top;
    // accept if ANY alternative the recognizer offered matches (STT leniency)
    let hit = alts.find(a => a && Matcher.matchAnswer(a, d.action).ok);
    if (hit) { el.answer.value = hit; markCorrect(d); }
    else { onSubmit(); }             // grade top transcript -> retry/reveal path
  };
  rec.onerror = (e) => {
    S.listening = false;
    el.verdict.textContent = (e && e.error === "not-allowed")
      ? "Mic blocked — allow microphone in Safari settings, or type."
      : "Didn't catch that — tap 🎤 again, or type.";
    el.verdict.className = "bad";
  };
  rec.onend = () => { S.listening = false; };
  try { rec.start(); }
  catch (e) { S.listening = false; el.verdict.textContent = "Couldn't start mic — type instead."; el.verdict.className = "bad"; }
}

// ---- state --------------------------------------------------------------
let S = {};
function resetState() {
  S = { flow: null, seat: "pf", mode: "drill", items: [], i: 0, attempts: 0,
        correct: 0, total: 0, missed: [], curSub: null, gen: 0, pendingIntro: [],
        listening: false, recCtl: null, listenGen: 0 };
}
function abortListen() {
  S.listenGen = (S.listenGen || 0) + 1;   // invalidate any pending recognizer result
  if (S.recCtl) { try { S.recCtl.stop(); } catch (e) {} S.recCtl = null; }
  S.listening = false;
}
async function speakThen(lines, andThen) {
  S.gen++; const gen = S.gen; stopSpeak();
  await speakSeq((lines || []).filter(Boolean), gen);
  if (AUTO && andThen && gen === S.gen) andThen();
}

// ---- menu ---------------------------------------------------------------
function show(screen) {
  el.menu.hidden = screen !== "menu";
  el.drill.hidden = screen !== "drill";
  el.done.hidden = screen !== "done";
  el.btnMenu.hidden = screen === "menu";
  if (screen === "menu") el.progress.textContent = "";
}

function flowCard(f) {
  const card = document.createElement("div");
  card.className = "card" + (f.abnormal ? " abn" : "");
  const seats = Object.keys(f.seats).filter(s => f.seats[s].items.length);
  const badges = (f.abnormal ? '<span class="badge abnb">ABNORMAL</span>' : "")
    + (f.has_audio ? '<span class="badge audio">VOICE</span>' : "");
  const seatBtns = seats.map(s => {
    const g = f.seats[s].gradable;
    return `<button data-key="${f.key}" data-seat="${s}">${s.toUpperCase()}<span class="n">${g} drill</span></button>`;
  }).join("");
  card.innerHTML =
    `<div class="card-top"><span class="card-name">${f.name}</span>${badges}</div>`
    + (f.source ? `<div class="card-src">${f.source}</div>` : "")
    + `<div class="seat-btns">${seatBtns}</div>`;
  card.querySelectorAll(".seat-btns button").forEach(b => {
    b.addEventListener("click", () => startDrill(b.dataset.key, b.dataset.seat, MODE));
  });
  return card;
}
function memCard(f) {
  const card = document.createElement("div");
  card.className = "card mem";
  card.innerHTML =
    `<div class="card-top"><span class="card-name">${memName(f)}</span><span class="badge memb">MEMORY</span></div>`
    + `<div class="seat-btns"><button class="recite-b">🎤 Recite end-to-end</button>`
    + `<button class="drill-b">Drill actions</button></div>`;
  card.querySelector(".recite-b").addEventListener("click", () => startRecallOne(f.key));
  card.querySelector(".drill-b").addEventListener("click", () => startDrill(f.key, "pf", "drill"));
  return card;
}
function renderMenu() {
  el.listAbn.innerHTML = ""; el.listRest.innerHTML = ""; if (el.listMem) el.listMem.innerHTML = "";
  DATA.flows.forEach(f => {
    if (f.key.indexOf("mem_") === 0) { if (el.listMem) el.listMem.appendChild(memCard(f)); }
    else if (f.abnormal) el.listAbn.appendChild(flowCard(f));
    else el.listRest.appendChild(flowCard(f));
  });
}

// ---- drill --------------------------------------------------------------
async function startDrill(key, seat, mode) {
  const f = DATA.flows.find(x => x.key === key);
  if (!f || !f.seats[seat]) return;
  unlockAudio();
  resetState();
  S.flow = f; S.seat = seat; S.mode = mode;
  S.ecam = !!f.abnormal;                             // abnormal flows render as ECAM read-and-do
  S.items = f.seats[seat].items;
  S.total = f.seats[seat].gradable;
  S.pendingIntro = f.sop_intro ? [f.sop_intro] : [];
  replayFn = () => startDrill(key, seat, mode);
  show("drill");
  preloadFlow(f, seat);                              // background pre-buffer of all audio
  if (mode === "drill" && AUTO) await primeMic();   // one mic prompt up front, then hands-free
  showItem();
}

function setControls(buttons) {
  el.controls.innerHTML = "";
  buttons.forEach(b => {
    const btn = document.createElement("button");
    btn.textContent = b.label;
    if (b.cls) btn.className = b.cls;
    btn.addEventListener("click", b.on);
    el.controls.appendChild(btn);
  });
}
function hideReveal() { el.revealCard.hidden = true; }
function showReveal(d) {
  el.revealAction.textContent = d.action || "";
  el.revealCallout.textContent = d.callout ? "Callout: " + d.callout : "";
  el.revealCallout.hidden = !d.callout;
  el.revealWhy.textContent = d.why || d.why_full || "";
  el.revealWhy.hidden = !(d.why || d.why_full);
  el.revealCite.textContent = d.cite || "";
  el.revealCite.hidden = !d.cite;
  el.revealCard.hidden = false;
}
function updateProgress() {
  if (S.mode === "drill" && S.total) {
    const graded = S.correct + S.missed.length;
    el.progress.textContent = `${graded}/${S.total} · ${S.correct}✓`;
  } else {
    el.progress.textContent = `${Math.min(S.i + 1, S.items.length)}/${S.items.length}`;
  }
}

function introLinesFor(d) {
  const lines = S.pendingIntro.slice();
  S.pendingIntro = [];
  if (d.subflow !== S.curSub) {
    S.curSub = d.subflow;
    el.subflowBar.textContent = d.subflow || "";
    if (d.sop_intro) lines.push(d.sop_intro);
    if (d.condition) lines.push(d.condition);
  }
  return lines;
}

// ---- ECAM E/WD rendering (abnormal flows) -------------------------------
function ecamTitle(f) {
  const m = (f.name || "").match(/\(([^)]+)\)/);
  return (m ? m[1] : (f.name || "")).toUpperCase();
}
function ecamIsRed(title) {
  return /FIRE|SMOKE|STALL|EMER|PULL\s*UP|WINDSHEAR|EVAC|UNRELIABLE|DUAL ENG|ALL ENG/i.test(title);
}
function ecamLabel(item) {
  return (item || "").replace(/^(the|affected)\s+/i, "").toUpperCase();
}
function renderEcam(d) {
  const title = ecamTitle(S.flow);
  el.ecamTitle.textContent = title;
  el.ecamTitle.className = ecamIsRed(title) ? "" : "caution";
  const lines = [];
  for (let k = 0; k < S.items.length; k++) {
    const x = S.items[k];
    if (x.subflow === d.subflow && x.gradable) lines.push({ x, k });
  }
  el.ecamLines.innerHTML = "";
  if (lines.length) {
    for (const ln of lines) {
      const st = ln.k < S.i ? "done" : (ln.k === S.i ? "cur" : "pending");
      const row = document.createElement("div");
      row.className = "ecam-line " + st;
      const act = (st === "done" ? "✓ " : "") + (ln.x.action || "").toUpperCase();
      row.innerHTML = `<span class="ecl-label">${ecamLabel(ln.x.item)}</span>`
        + `<span class="ecl-dots"></span><span class="ecl-act">${act}</span>`;
      el.ecamLines.appendChild(row);
    }
  } else {
    const info = document.createElement("div");
    info.className = "ecam-info";
    info.textContent = d.item + (d.action ? " — " + d.action : "");
    el.ecamLines.appendChild(info);
  }
  let cap = "";
  if (d.callout) cap += `<div class="ecl-call">${d.callout}</div>`;
  const why = d.why || d.why_full;
  if (why) cap += `<div class="ecl-why">${why}</div>`;
  el.ecamCaption.innerHTML = cap;
  el.revealCard.hidden = true;          // ECAM panel + caption replace the reveal card
}
function ecamMarkCurDone() {
  const cur = el.ecamLines.querySelector(".ecam-line.cur");
  if (!cur) return;
  cur.classList.remove("cur"); cur.classList.add("done");
  const act = cur.querySelector(".ecl-act");
  if (act && act.textContent.indexOf("✓") !== 0) act.textContent = "✓ " + act.textContent;
}
function maybeReveal(d) { if (!S.ecam) showReveal(d); }   // ECAM shows everything in the panel

function showItem() {
  abortListen();
  if (S.i >= S.items.length) return finish();
  const d = S.items[S.i];
  S.attempts = 0;
  hideReveal();
  el.verdict.textContent = ""; el.verdict.className = "";
  el.answer.value = "";
  const intro = introLinesFor(d);
  S.gen++;
  const gen = S.gen;
  stopSpeak();
  updateProgress();

  if (S.ecam) { el.ecam.hidden = false; el.cueCard.hidden = true; renderEcam(d); }
  else { el.ecam.hidden = true; el.cueCard.hidden = false; }

  const ask = S.mode === "drill" && d.gradable;
  if (ask) renderAsk(d, intro, gen);
  else renderTeach(d, intro, gen);
}

async function renderAsk(d, intro, gen) {
  el.answerZone.hidden = false;
  const v = voiceInAvail();
  el.cueKind.textContent = v
    ? "Your call — tap 🎤 and say the action (or type)"
    : "Your call — say it aloud, then type";
  el.cueItem.textContent = d.item;
  el.cueSub.textContent = "";
  const ctrls = [];
  if (v) ctrls.push({ label: S.ecam ? "🎤 Make the call" : "🎤 Speak answer", cls: "primary wide", on: () => startListen(d) });
  ctrls.push({ label: v ? "Submit typed" : "Submit", cls: v ? "" : "primary wide", on: onSubmit });
  if (S.ecam) ctrls.push({ label: "✓ Confirm", cls: "good", on: () => markCorrect(d) });   // actioned without voice
  else ctrls.push({ label: "Reveal", on: () => revealSelfMark(d) });
  ctrls.push({ label: "Skip", on: () => skip(d) });
  ctrls.push({ label: "Explain", cls: "icon", on: () => explain(d) });
  ctrls.push({ label: "🔊 Replay", cls: "wide icon", on: () => { S.gen++; stopSpeak(); speakSeq([d.prompt], S.gen); } });
  setControls(ctrls);
  await speakSeq([...intro, d.prompt], gen);
  // hands-free: arm the mic once the item has been read (and nothing superseded it)
  if (AUTO && gen === S.gen && DG.hasProxy() && micStream) startListen(d);
}

function onSubmit() {
  if (S.listening) abortListen();   // manual "Submit typed" mid-listen
  const d = S.items[S.i];
  const ans = el.answer.value.trim();
  if (!ans) { el.answer.focus(); return; }
  const { ok } = Matcher.matchAnswer(ans, d.action);
  if (ok) return markCorrect(d);
  S.attempts++;
  if (S.attempts > MAX_RETRIES) return revealForced(d);
  el.verdict.textContent = "Not quite — try again, or Reveal.";
  el.verdict.className = "bad";
  if (AUTO && DG.hasProxy() && micStream) startListen(d);   // hands-free retry
  else el.answer.select();
}

function markCorrect(d) {
  S.correct++;
  el.verdict.textContent = S.ecam ? "✓ Actioned" : "Correct ✓";
  el.verdict.className = "good";
  el.answerZone.hidden = true;
  if (S.ecam) ecamMarkCurDone(); else showReveal(d);
  setControls([{ label: "Next ▶", cls: "primary wide", on: next }]);
  updateProgress();
  speakThen([d.correct_line], next);          // auto-advance after confirming
}
function revealForced(d) {
  S.missed.push(d.item);
  el.verdict.textContent = "Missed — here's the answer.";
  el.verdict.className = "bad";
  el.answerZone.hidden = true;
  maybeReveal(d);
  setControls([{ label: "Next ▶", cls: "primary wide", on: next }]);
  updateProgress();
  speakThen([d.reveal, d.explain].filter(Boolean), next);   // hear the answer, then advance
}
function revealSelfMark(d) {
  if (S.listening) abortListen();
  el.answerZone.hidden = true;
  el.verdict.textContent = "Did you say it right?";
  el.verdict.className = "";
  maybeReveal(d);
  S.gen++; stopSpeak(); speakSeq([d.reveal], S.gen);
  setControls([
    { label: "I got it ✓", cls: "good", on: () => { S.correct++; next(); } },
    { label: "Missed ✗", cls: "bad", on: () => { S.missed.push(d.item); next(); } },
  ]);
  updateProgress();
}
function skip(d) {
  if (S.listening) abortListen();
  S.missed.push(d.item);
  el.answerZone.hidden = true;
  el.verdict.textContent = "Skipped.";
  el.verdict.className = "bad";
  maybeReveal(d);
  setControls([{ label: "Next ▶", cls: "primary wide", on: next }]);
  updateProgress();
  speakThen([d.reveal], next);
}
function explain(d) {
  if (S.listening) abortListen();
  maybeReveal(d);
  const ex = d.explain || (d.why_full ? { t: d.why_full } : (d.why ? { t: d.why } : null));
  S.gen++; stopSpeak(); speakSeq([ex].filter(Boolean), S.gen);
}

async function renderTeach(d, intro, gen) {
  el.answerZone.hidden = true;
  const kind = d.brief ? "Briefing" : (d.gradable ? "Review" : (d.callout ? "Callout" : "Note"));
  el.cueKind.textContent = kind;
  el.cueItem.textContent = d.item;
  el.cueSub.textContent = "";
  // teaching detail card (ECAM mode shows it all in the panel instead)
  if (!S.ecam && (d.action || d.why || d.callout || d.why_full)) {
    showReveal(d);
  } else if (!S.ecam) { hideReveal(); }
  // what to say
  let lines;
  if (S.mode === "listen" && d.gradable) lines = [d.prompt, d.reveal, d.explain];
  else if (d.brief && d.brief_line) lines = [d.brief_line];
  else if (d.narration) lines = [d.narration];
  else lines = [d.prompt || d.reveal];
  setControls([
    { label: "Next ▶", cls: "primary wide", on: next },
    { label: "🔊 Replay", cls: "wide icon", on: () => { S.gen++; stopSpeak(); speakSeq(lines.filter(Boolean), S.gen); } },
  ]);
  await speakSeq([...intro, ...lines.filter(Boolean)], gen);
  if (AUTO && gen === S.gen) next();          // hands-free: advance after narration
}

function next() { S.i++; showItem(); }

function finish() {
  abortListen();
  stopMic();
  stopSpeak();
  show("done");
  if (S.mode === "listen" || !S.total) {
    el.doneScore.textContent = "Review complete";
    el.donePct.textContent = `${S.items.length} steps · ${S.flow.name}`;
    el.doneMissed.innerHTML = "";
  } else {
    const pct = Math.round((100 * S.correct) / S.total);
    el.doneScore.textContent = `${S.correct} / ${S.total}`;
    el.donePct.textContent = `${pct}% · ${S.flow.name} (${S.seat.toUpperCase()})`;
    if (S.missed.length) {
      el.doneMissed.innerHTML = "<h4>Review these</h4>" +
        S.missed.map(m => `• ${m}`).join("<br>");
    } else {
      el.doneMissed.innerHTML = "<h4>Clean run — no misses ✓</h4>";
    }
  }
}

// ---- memory-item free-recall exam ---------------------------------------
// Recite each memory item's whole sequence from memory, back-to-back, no
// teaching, no per-item feedback; coverage scored against the action list at the end.
function memName(f) { return f.name.replace(/\s*\(memory item\)\s*$/i, "").trim(); }
async function startRecall(flows) {
  if (!flows || !flows.length) return;
  unlockAudio();
  R = { flows, idx: 0, results: [], seat: "pf", recCtl: null, gen: 0 };
  replayFn = () => startRecall(flows);
  resetState(); S.mode = "recall";
  show("drill");
  el.answerZone.hidden = true;
  await primeMic();
  recallNext();
}
function startRecallExam() {
  return startRecall(DATA.flows.filter(f => f.key.indexOf("mem_") === 0 && f.seats.pf && f.seats.pf.gradable));
}
function startRecallOne(key) {
  const f = DATA.flows.find(x => x.key === key);
  if (f && f.seats.pf && f.seats.pf.gradable) return startRecall([f]);
}
async function recallNext() {
  if (R.idx >= R.flows.length) return finishRecall();
  const gen = ++R.gen;
  const f = R.flows[R.idx];
  hideReveal();
  el.ecam.hidden = true; el.cueCard.hidden = false;
  el.answerZone.hidden = true;
  el.progress.textContent = `${R.idx + 1}/${R.flows.length}`;
  el.subflowBar.textContent = `Memory item ${R.idx + 1} of ${R.flows.length}`;
  el.cueKind.textContent = "Recite the whole memory item from memory";
  el.cueItem.textContent = memName(f);
  el.cueSub.textContent = "";
  el.verdict.textContent = ""; el.verdict.className = "";
  setControls([
    { label: "✓ Done — next item", cls: "primary wide", on: () => { if (R.recCtl) R.recCtl.stop(); } },
    { label: "Skip", on: () => { if (gen !== R.gen) return; if (R.recCtl) { try { R.recCtl.stop(); } catch (e) {} R.recCtl = null; } advanceRecall(gen, "skip", ""); } },
  ]);
  stopSpeak();
  await speak({ t: memName(f) + ". Recite." });
  if (gen !== R.gen) return;        // skipped during the announce
  recallListen(gen);
}
async function recallListen(gen) {
  el.verdict.textContent = "🎤 Reciting… say the full sequence, then tap Done";
  el.verdict.className = "listening";
  try {
    const txt = await DG.listen({
      keyterms: KEYTERMS, stream: micStream || undefined, audioContext: audioCtx || undefined,
      continuous: true, silenceMs: 4000, maxMs: 45000,
      onPartial: (t) => { if (gen === R.gen) el.cueSub.textContent = t; },
      register: (c) => { R.recCtl = c; },
    });
    if (gen !== R.gen) return;
    R.recCtl = null; advanceRecall(gen, "graded", txt);
  } catch (e) { if (gen !== R.gen) return; R.recCtl = null; advanceRecall(gen, "graded", ""); }
}
function advanceRecall(gen, kind, transcript) {
  if (gen !== R.gen) return;        // already advanced / superseded
  R.gen++;                          // invalidate this item so nothing double-fires
  const f = R.flows[R.idx];
  const items = ((f.seats[R.seat] && f.seats[R.seat].items) || []).filter(d => d.gradable);
  let hit = 0; const missed = [];
  for (const d of items) {
    if (kind === "graded" && transcript && Matcher.matchAnswer(transcript, d.action).ok) hit++;
    else missed.push(`${d.item} — ${d.action}`);
  }
  R.results.push({ name: memName(f), hit, total: items.length, missed });
  R.idx++;
  recallNext();
}
function finishRecall() {
  if (R.recCtl) { try { R.recCtl.stop(); } catch (e) {} R.recCtl = null; }
  stopMic(); stopSpeak();
  show("done");
  const hit = R.results.reduce((a, r) => a + r.hit, 0);
  const tot = R.results.reduce((a, r) => a + r.total, 0);
  const pct = tot ? Math.round(100 * hit / tot) : 0;
  el.doneScore.textContent = `${hit} / ${tot}`;
  el.donePct.textContent = `${pct}% — memory items recalled`;
  let html = "<h4>Per memory item</h4>";
  for (const r of R.results) {
    const ip = r.total ? Math.round(100 * r.hit / r.total) : 0;
    const col = ip >= 100 ? "var(--good)" : (ip >= 60 ? "var(--amber)" : "var(--bad)");
    html += `<div style="margin:10px 0"><b>${r.name}</b> — <span style="color:${col}">${r.hit}/${r.total} (${ip}%)</span>`;
    if (r.missed.length) html += `<br><span style="color:var(--dim)">missed: ${r.missed.join("; ")}</span>`;
    html += "</div>";
  }
  el.doneMissed.innerHTML = html;
}

// ---- wiring -------------------------------------------------------------
el.answer.addEventListener("keydown", (e) => { if (e.key === "Enter") onSubmit(); });
function bailToMenu() {
  abortListen();
  if (R && R.recCtl) { try { R.recCtl.stop(); } catch (e) {} R.recCtl = null; }
  R.gen = (R.gen || 0) + 1;     // invalidate any pending recall step
  stopMic(); stopSpeak(); show("menu");
}
el.btnMenu.addEventListener("click", bailToMenu);
el.btnBack.addEventListener("click", bailToMenu);
el.btnAgain.addEventListener("click", () => { if (replayFn) replayFn(); });
const btnRecall = document.getElementById("btn-recall");
if (btnRecall) btnRecall.addEventListener("click", startRecallExam);
el.modeToggle.querySelectorAll("button").forEach(b => {
  b.addEventListener("click", () => {
    MODE = b.dataset.mode;
    el.modeToggle.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
    el.modeHint.textContent = MODE === "drill"
      ? "Drill: I say the item; tap 🎤 to speak your answer (or type it), and it grades you."
      : "Listen: I read every item, the action and the why straight through — nothing to answer.";
  });
});

fetch("./flows.json").then(r => r.json()).then(d => {
  DATA = d; resetState(); renderMenu(); show("menu");
}).catch(e => {
  el.listAbn.innerHTML = `<div class="card">Failed to load flows.json: ${e}</div>`;
});
