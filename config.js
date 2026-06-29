/* config.js — runtime config. DG_PROXY is the Cloudflare Worker that holds the
 * Deepgram key server-side (premium Aura TTS + live STT relay). If blanked, the
 * app falls back to the device voice + iOS Web Speech (no key needed). */
window.DG_PROXY = "https://a320-dg.robertosoares1985.workers.dev";

// Voice gate (noise rejection). Raise absMin/ratio if background noise still
// leaks through; lower them if quiet speech gets cut. hangoverMs keeps the gate
// open briefly after the last loud sound so word-tails aren't clipped.
window.DG_GATE = { absMin: 0.010, ratio: 2.2, hangoverMs: 600, floorCap: 0.05 };
