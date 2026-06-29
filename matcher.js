/* matcher.js — faithful JS port of flow_trainer.py's mechanical matcher.
 * Grades a typed answer against the canonical action EXACTLY like the
 * PowerShell trainer (_tokens / match_answer / difflib.SequenceMatcher.ratio).
 * Verified against the Python --selftest cases (run `node matcher.js --test`).
 * UMD: usable in the browser (window.Matcher) and under Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Matcher = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STOP = new Set(["the", "a", "an", "and", "to", "is", "are", "it", "i",
    "please", "uh", "um", "yeah", "ok", "okay", "its", "im", "thats", "percent"]);

  const NUM = {
    zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
    seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
    thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
    eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40",
    fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100"
  };

  const SYN = {
    rqrd: "required", reqd: "required", req: "required", reqrd: "required",
    norm: "normal", stby: "standby", ign: "ignition",
    pb: "pushbutton", pbsw: "pushbutton", btn: "pushbutton", button: "pushbutton",
    sw: "switch", accu: "accumulator", elev: "elevation", strg: "steering",
    disc: "disconnect", xcheck: "crosscheck", crosschecked: "crosscheck",
    cstr: "constraint", constraints: "constraint", ref: "reference",
    lt: "light", lts: "light", rcvd: "received", recept: "receive",
    stowed: "stow", displayed: "display", neutral: "neutral",
    armed: "arm", tested: "test", checked: "check", selected: "select",
    of: "off", release: "off", released: "off",
    cl: "climb", rather: "rudder"
  };

  function stem(t) {
    for (const suf of ["ing", "ed", "es", "s"]) {
      if (t.endsWith(suf) && t.length - suf.length >= 3) return t.slice(0, t.length - suf.length);
    }
    return t;
  }

  const N_NUM = { one: "1", won: "1", "1": "1", two: "2", to: "2", too: "2", "2": "2" };

  function tokens(text) {
    text = (text || "").toLowerCase().replace(/\//g, " ").replace(/\./g, " ");
    text = text.replace(/[^a-z0-9 ]/g, " ");
    text = text.replace(/cross check/g, "crosscheck");
    text = text.replace(/\b(?:n|en|an|in|and)\s+(one|won|two|to|too|[12])\b/g,
      function (m, g1) { return "n" + (N_NUM[g1] || g1); });
    const out = [];
    for (let w of text.split(/\s+/)) {
      if (!w) continue;
      w = NUM[w] || w;
      w = SYN[w] || w;
      w = stem(w);
      if (w && !STOP.has(w)) out.push(w);
    }
    return out;
  }

  // --- difflib.SequenceMatcher.ratio() (Ratcliff/Obershelp), char-level ---
  function findLongestMatch(a, b, b2j, alo, ahi, blo, bhi) {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = {};
    for (let i = alo; i < ahi; i++) {
      const newj2len = {};
      const idxs = b2j[a[i]] || [];
      for (const j of idxs) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len[j - 1] || 0) + 1;
        newj2len[j] = k;
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  function ratio(a, b) {
    const n = b.length;
    const b2j = {};
    for (let i = 0; i < n; i++) { (b2j[b[i]] = b2j[b[i]] || []).push(i); }
    if (n >= 200) { // autojunk (won't trigger on our short strings, kept for fidelity)
      const ntest = Math.floor(n / 100) + 1;
      for (const elt of Object.keys(b2j)) if (b2j[elt].length > ntest) delete b2j[elt];
    }
    let matches = 0;
    const queue = [[0, a.length, 0, n]];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
      if (k) {
        matches += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    const T = a.length + b.length;
    return T ? (2.0 * matches) / T : 1.0;
  }

  function matchAnswer(spoken, action, threshold) {
    if (threshold === undefined) threshold = 0.6;
    const spokenArr = tokens(spoken);
    const spokenSet = new Set(spokenArr);
    if (spokenSet.size === 0) return { ok: false, score: 0 };

    const cov = (targetArr) => {
      const ts = new Set(targetArr);
      if (ts.size === 0) return 0;
      let inter = 0;
      for (const t of ts) if (spokenSet.has(t)) inter++;
      return inter / ts.size;
    };

    const full = tokens(action.replace(/\//g, " "));
    const fullCov = cov(full);
    const altParts = action.split(/\s*\/\s*|\s+or\s+/i);
    let bestAlt = 0;
    for (const part of altParts) { const c = cov(tokens(part)); if (c > bestAlt) bestAlt = c; }
    const aStr = tokens(action.replace(/\//g, " ")).join(" ");
    const bStr = Array.from(spokenSet).sort().join(" ");
    const r = ratio(aStr, bStr);
    const score = Math.max(fullCov, bestAlt, r);
    const ok = (bestAlt >= threshold) || (fullCov >= 0.75) || (r >= 0.72);
    return { ok: ok, score: score };
  }

  return { tokens: tokens, matchAnswer: matchAnswer, ratio: ratio };
});

// --- self-test (node matcher.js --test) — mirrors flow_trainer._selftest ---
if (typeof module === "object" && require.main === module && process.argv.includes("--test")) {
  const M = module.exports;
  const cases = [
    ["check test", "CHECK/TEST", true], ["checked and tested", "CHECK/TEST", true],
    ["normal", "NORM", true], ["norm", "NORM", true], ["on", "ON/AUTO", true],
    ["auto", "ON/AUTO", true], ["as required", "AS RQRD", true], ["arm", "ARM", true],
    ["ignition start", "IGN/START", true], ["check stowed", "CHECK STOWED", true],
    ["check not displayed", "CHECK NOT DISPLAYED", true], ["standby", "STBY", true],
    ["off", "ON/AUTO", false], ["banana", "CHECK", false], ["", "CHECK", false]
  ];
  let allOk = true;
  for (const [spoken, action, want] of cases) {
    const { ok, score } = M.matchAnswer(spoken, action);
    const flag = ok === want ? "OK  " : "FAIL";
    if (ok !== want) allOk = false;
    console.log(`  [${flag}] ${JSON.stringify(spoken).padEnd(26)} vs ${JSON.stringify(action).padEnd(22)} -> ${ok} (score ${score.toFixed(2)})`);
  }
  console.log("selftest:", allOk ? "PASS" : "FAIL");
  process.exit(allOk ? 0 : 1);
}
