/* app.js — A320 Abnormals Trainer (iPad PWA).
 * Speak-then-tap/type drill + listen-through, grading via the verified Matcher.
 * Plays the bundled premium Deepgram WAVs; falls back to the device voice. */
"use strict";

const $ = (id) => document.getElementById(id);
const el = {
  menu: $("screen-menu"), drill: $("screen-drill"), done: $("screen-done"),
  listAbn: $("list-abn"), listRest: $("list-rest"),
  btnMenu: $("btn-menu"), progress: $("progress"),
  subflowBar: $("subflow-bar"), cueKind: $("cue-kind"), cueItem: $("cue-item"), cueSub: $("cue-sub"),
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
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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
async function speak(obj) {
  if (!obj || !obj.t) return;
  if (obj.a) return playUrl("./audio/" + obj.a, obj.t);     // bundled premium (abnormals)
  if (DG.hasProxy()) {                                       // live premium Aura (every other flow)
    try { const u = await DG.speak(obj.t); if (u) return playUrl(u, obj.t); } catch (e) {}
  }
  return ttsSpeak(obj.t);                                    // last resort: device voice
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
function renderMenu() {
  el.listAbn.innerHTML = ""; el.listRest.innerHTML = "";
  DATA.flows.forEach(f => (f.abnormal ? el.listAbn : el.listRest).appendChild(flowCard(f)));
}

// ---- drill --------------------------------------------------------------
async function startDrill(key, seat, mode) {
  const f = DATA.flows.find(x => x.key === key);
  if (!f || !f.seats[seat]) return;
  unlockAudio();
  resetState();
  S.flow = f; S.seat = seat; S.mode = mode;
  S.items = f.seats[seat].items;
  S.total = f.seats[seat].gradable;
  S.pendingIntro = f.sop_intro ? [f.sop_intro] : [];
  show("drill");
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
  if (v) ctrls.push({ label: "🎤 Speak answer", cls: "primary wide", on: () => startListen(d) });
  ctrls.push({ label: v ? "Submit typed" : "Submit", cls: v ? "" : "primary wide", on: onSubmit });
  ctrls.push({ label: "Reveal", on: () => revealSelfMark(d) });
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
  el.verdict.textContent = "Correct ✓";
  el.verdict.className = "good";
  el.answerZone.hidden = true;
  showReveal(d);
  setControls([{ label: "Next ▶", cls: "primary wide", on: next }]);
  updateProgress();
  speakThen([d.correct_line], next);          // auto-advance after confirming
}
function revealForced(d) {
  S.missed.push(d.item);
  el.verdict.textContent = "Missed — here's the answer.";
  el.verdict.className = "bad";
  el.answerZone.hidden = true;
  showReveal(d);
  setControls([{ label: "Next ▶", cls: "primary wide", on: next }]);
  updateProgress();
  speakThen([d.reveal, d.explain].filter(Boolean), next);   // hear the answer, then advance
}
function revealSelfMark(d) {
  if (S.listening) abortListen();
  el.answerZone.hidden = true;
  el.verdict.textContent = "Did you say it right?";
  el.verdict.className = "";
  showReveal(d);
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
  showReveal(d);
  setControls([{ label: "Next ▶", cls: "primary wide", on: next }]);
  updateProgress();
  speakThen([d.reveal], next);
}
function explain(d) {
  if (S.listening) abortListen();
  showReveal(d);
  const ex = d.explain || (d.why_full ? { t: d.why_full } : (d.why ? { t: d.why } : null));
  S.gen++; stopSpeak(); speakSeq([ex].filter(Boolean), S.gen);
}

async function renderTeach(d, intro, gen) {
  el.answerZone.hidden = true;
  const kind = d.brief ? "Briefing" : (d.gradable ? "Review" : (d.callout ? "Callout" : "Note"));
  el.cueKind.textContent = kind;
  el.cueItem.textContent = d.item;
  el.cueSub.textContent = "";
  // teaching detail card
  if (d.action || d.why || d.callout || d.why_full) {
    showReveal(d);
  } else { hideReveal(); }
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

// ---- wiring -------------------------------------------------------------
el.answer.addEventListener("keydown", (e) => { if (e.key === "Enter") onSubmit(); });
el.btnMenu.addEventListener("click", () => { abortListen(); stopMic(); stopSpeak(); show("menu"); });
el.btnBack.addEventListener("click", () => { abortListen(); stopMic(); stopSpeak(); show("menu"); });
el.btnAgain.addEventListener("click", () => startDrill(S.flow.key, S.seat, S.mode));
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
