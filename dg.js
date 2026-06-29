/* dg.js — Deepgram via the Cloudflare proxy.
 *  DG.speak(text)            -> objectURL of a premium Aura WAV (cached)
 *  DG.listen({keyterms,...}) -> Promise<finalTranscript> streaming mic -> Deepgram
 * Proxy base URL comes from window.DG_PROXY (set in config.js). If empty, the
 * app falls back to the device voice / iOS Web Speech (no key needed). */
(function (root) {
  "use strict";
  const proxy = () => (root.DG_PROXY || "").replace(/\/+$/, "");
  const VOICE = "aura-2-arcas-en";
  const ttsCache = new Map();

  async function synth(text) {
    const r = await fetch(proxy() + "/api/speak", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: VOICE }),
    });
    if (!r.ok) throw new Error("tts " + r.status);
    return r.blob();
  }
  async function speak(text) {
    if (!proxy() || !text) return null;
    if (ttsCache.has(text)) return ttsCache.get(text);     // in-memory (this session)
    const key = "https://tts.local/" + encodeURIComponent(VOICE + "|" + text);
    let blob = null;
    try {
      const c = await caches.open("a320-tts-v1");           // persistent (survives reloads, offline)
      let resp = await c.match(key);
      if (!resp) { blob = await synth(text); await c.put(key, new Response(blob, { headers: { "Content-Type": "audio/wav" } })); }
      else blob = await resp.blob();
    } catch (e) { blob = await synth(text); }               // Cache API unavailable -> just synth
    const u = URL.createObjectURL(blob);
    ttsCache.set(text, u);
    return u;
  }

  function downsample(buf, inRate, outRate) {
    if (outRate >= inRate) return buf;
    const ratio = inRate / outRate, len = Math.floor(buf.length / ratio), out = new Float32Array(len);
    let i = 0, o = 0;
    while (o < len) {
      const next = Math.floor((o + 1) * ratio);
      let sum = 0, c = 0;
      for (; i < next && i < buf.length; i++) { sum += buf[i]; c++; }
      out[o++] = c ? sum / c : 0;
    }
    return out;
  }
  function floatTo16(buf) {
    const out = new Int16Array(buf.length);
    for (let i = 0; i < buf.length; i++) { const s = Math.max(-1, Math.min(1, buf[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return out.buffer;
  }

  async function listen(opts) {
    opts = opts || {};
    if (!proxy()) throw new Error("no proxy");
    const kt = (opts.keyterms || []).map(t => "keyterm=" + encodeURIComponent(t)).join("&");
    const qs = "model=nova-3&encoding=linear16&sample_rate=16000&channels=1"
      + "&interim_results=true&endpointing=300&smart_format=false&punctuate=false" + (kt ? "&" + kt : "");
    // reuse an injected mic stream + AudioContext (hands-free loop) or make our own
    let stream = opts.stream, ownStream = false;
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
      ownStream = true;
    }
    const wsBase = proxy().replace(/^http/i, "ws");   // stream through the Worker relay
    const ws = new WebSocket(wsBase + "/api/listen?" + qs);
    ws.binaryType = "arraybuffer";
    const AC = root.AudioContext || root.webkitAudioContext;
    let ac = opts.audioContext, ownCtx = false;
    if (!ac) { ac = new AC(); ownCtx = true; }
    try { if (ac.state !== "running") await ac.resume(); } catch (e) {}
    const srcNode = ac.createMediaStreamSource(stream);
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const inRate = ac.sampleRate;
    let transcript = "", finished = false, resolved = false, timer = null;

    function cleanup() {
      if (finished) return; finished = true;
      try { proc.disconnect(); } catch (e) {}
      try { srcNode.disconnect(); } catch (e) {}
      if (ownStream) { try { stream.getTracks().forEach(t => t.stop()); } catch (e) {} }
      if (ownCtx) { try { ac.close(); } catch (e) {} }
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "CloseStream" })); } catch (e) {}
      try { ws.close(); } catch (e) {}
      if (timer) clearTimeout(timer);
    }

    return new Promise((resolve, reject) => {
      const done = (t) => { if (resolved) return; resolved = true; cleanup(); resolve((t || "").trim()); };
      if (opts.register) opts.register({ stop: () => done(transcript) });
      timer = setTimeout(() => done(transcript), opts.maxMs || 9000);

      // --- adaptive noise gate (VAD) ---------------------------------------
      // Only stream audio while you're actually speaking; send silence otherwise,
      // so steady background noise never reaches Deepgram (no junk transcripts,
      // clean utterance-end). Threshold adapts to the room's noise floor.
      const G = root.DG_GATE || {};
      const ABS_MIN = G.absMin != null ? G.absMin : 0.010;   // hard floor for "speech"
      const OPEN_RATIO = G.ratio != null ? G.ratio : 2.2;    // speech must beat noiseFloor * this
      const HANG_MS = G.hangoverMs != null ? G.hangoverMs : 600; // keep open after last voiced
      const FLOOR_CAP = G.floorCap != null ? G.floorCap : 0.05;
      const WIN = G.win != null ? G.win : 14;                // noise-floor window (~1.2s)
      const ring = new Array(WIN).fill(0.010); let ri = 0, filled = 0;
      let voiced = false, lastVoiced = 0;
      const nowMs = () => (root.performance && performance.now ? performance.now() : Date.now());
      ws.onopen = () => {
        srcNode.connect(proc); proc.connect(ac.destination);
        proc.onaudioprocess = (e) => {
          if (finished || ws.readyState !== 1) return;
          const input = e.inputBuffer.getChannelData(0);
          let s = 0; for (let i = 0; i < input.length; i++) s += input[i] * input[i];
          const r = Math.sqrt(s / input.length);
          // noise floor = recent MINIMUM RMS (the quiet gaps), robust to loud rooms
          ring[ri] = r; ri = (ri + 1) % WIN; if (filled < WIN) filled++;
          let mn = Infinity; for (let i = 0; i < filled; i++) if (ring[i] < mn) mn = ring[i];
          const thr = Math.max(ABS_MIN, Math.min(FLOOR_CAP, mn) * OPEN_RATIO);
          const now = nowMs();
          if (r > thr) { voiced = true; lastVoiced = now; }
          else if (now - lastVoiced > HANG_MS) voiced = false;
          const down = downsample(input, inRate, 16000);
          if (!voiced) down.fill(0);                      // gate closed -> send silence
          ws.send(floatTo16(down));
        };
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        const alt = m.channel && m.channel.alternatives && m.channel.alternatives[0];
        const txt = alt && alt.transcript ? alt.transcript : "";
        if (txt && opts.onPartial) opts.onPartial(txt);
        if (txt && m.is_final) transcript = (transcript + " " + txt).trim();
        if (m.speech_final) done(transcript);
      };
      ws.onerror = () => { if (!resolved) { cleanup(); reject(new Error("ws error")); } };
      ws.onclose = () => { if (!resolved) done(transcript); };
    });
  }

  root.DG = { speak, listen, hasProxy: () => !!proxy() };
})(window);
