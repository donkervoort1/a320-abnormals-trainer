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

  async function speak(text) {
    if (!proxy() || !text) return null;
    if (ttsCache.has(text)) return ttsCache.get(text);
    const r = await fetch(proxy() + "/api/speak", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: VOICE }),
    });
    if (!r.ok) throw new Error("tts " + r.status);
    const u = URL.createObjectURL(await r.blob());
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
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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

      ws.onopen = () => {
        srcNode.connect(proc); proc.connect(ac.destination);
        proc.onaudioprocess = (e) => {
          if (finished || ws.readyState !== 1) return;
          ws.send(floatTo16(downsample(e.inputBuffer.getChannelData(0), inRate, 16000)));
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
