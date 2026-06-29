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
function speak(obj) {
  return new Promise((res) => {
    if (!obj || !obj.t) return res();
    if (obj.a) {
      audioEl.onended = () => res();
      audioEl.onerror = () => ttsSpeak(obj.t).then(res);
      try {
        audioEl.src = "./audio/" + obj.a;
        const p = audioEl.play();
        if (p && p.catch) p.catch(() => ttsSpeak(obj.t).then(res));
      } catch (e) { ttsSpeak(obj.t).then(res); }
    } else {
      ttsSpeak(obj.t).then(res);
    }
  });
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

// ---- state --------------------------------------------------------------
let S = {};
function resetState() {
  S = { flow: null, seat: "pf", mode: "drill", items: [], i: 0, attempts: 0,
        correct: 0, total: 0, missed: [], curSub: null, gen: 0, pendingIntro: [] };
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
function startDrill(key, seat, mode) {
  const f = DATA.flows.find(x => x.key === key);
  if (!f || !f.seats[seat]) return;
  resetState();
  S.flow = f; S.seat = seat; S.mode = mode;
  S.items = f.seats[seat].items;
  S.total = f.seats[seat].gradable;
  S.pendingIntro = f.sop_intro ? [f.sop_intro] : [];
  show("drill");
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

function renderAsk(d, intro, gen) {
  el.answerZone.hidden = false;
  el.cueKind.textContent = "Your call — say it, then type";
  el.cueItem.textContent = d.item;
  el.cueSub.textContent = "";
  setControls([
    { label: "Submit", cls: "primary wide", on: onSubmit },
    { label: "Reveal", on: () => revealSelfMark(d) },
    { label: "Skip", on: () => skip(d) },
    { label: "🔊 Replay", cls: "wide icon", on: () => { S.gen++; stopSpeak(); speakSeq([d.prompt], S.gen); } },
    { label: "Explain", cls: "wide icon", on: () => explain(d) },
  ]);
  el.answer.focus();
  speakSeq([...intro, d.prompt], gen);
}

function onSubmit() {
  const d = S.items[S.i];
  const ans = el.answer.value.trim();
  if (!ans) { el.answer.focus(); return; }
  const { ok } = Matcher.matchAnswer(ans, d.action);
  if (ok) return markCorrect(d);
  S.attempts++;
  if (S.attempts > MAX_RETRIES) return revealForced(d);
  el.verdict.textContent = "Not quite — try again, or Reveal.";
  el.verdict.className = "bad";
  el.answer.select();
}

function markCorrect(d) {
  S.correct++;
  el.verdict.textContent = "Correct ✓";
  el.verdict.className = "good";
  el.answerZone.hidden = true;
  showReveal(d);
  S.gen++; stopSpeak(); speakSeq([d.correct_line], S.gen);
  setControls([{ label: "Next ▶", cls: "primary wide", on: next }]);
  updateProgress();
}
function revealForced(d) {
  S.missed.push(d.item);
  el.verdict.textContent = "Missed — here's the answer.";
  el.verdict.className = "bad";
  el.answerZone.hidden = true;
  showReveal(d);
  S.gen++; stopSpeak(); speakSeq([d.reveal, d.explain].filter(Boolean), S.gen);
  setControls([{ label: "Next ▶", cls: "primary wide", on: next }]);
  updateProgress();
}
function revealSelfMark(d) {
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
  S.missed.push(d.item);
  el.answerZone.hidden = true;
  el.verdict.textContent = "Skipped.";
  el.verdict.className = "bad";
  showReveal(d);
  S.gen++; stopSpeak(); speakSeq([d.reveal], S.gen);
  setControls([{ label: "Next ▶", cls: "primary wide", on: next }]);
  updateProgress();
}
function explain(d) {
  showReveal(d);
  const ex = d.explain || (d.why_full ? { t: d.why_full } : (d.why ? { t: d.why } : null));
  S.gen++; stopSpeak(); speakSeq([ex].filter(Boolean), S.gen);
}

function renderTeach(d, intro, gen) {
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
  speakSeq([...intro, ...lines.filter(Boolean)], gen);
}

function next() { S.i++; showItem(); }

function finish() {
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
el.btnMenu.addEventListener("click", () => { stopSpeak(); show("menu"); });
el.btnBack.addEventListener("click", () => { stopSpeak(); show("menu"); });
el.btnAgain.addEventListener("click", () => startDrill(S.flow.key, S.seat, S.mode));
el.modeToggle.querySelectorAll("button").forEach(b => {
  b.addEventListener("click", () => {
    MODE = b.dataset.mode;
    el.modeToggle.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
    el.modeHint.textContent = MODE === "drill"
      ? "Drill: I say the item, you say the action out loud, then type it (or tap Reveal) to grade."
      : "Listen: I read every item, the action and the why straight through — nothing to answer.";
  });
});

fetch("./flows.json").then(r => r.json()).then(d => {
  DATA = d; resetState(); renderMenu(); show("menu");
}).catch(e => {
  el.listAbn.innerHTML = `<div class="card">Failed to load flows.json: ${e}</div>`;
});
