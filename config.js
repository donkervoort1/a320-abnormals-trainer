/* config.js — runtime config. DG_PROXY is the Cloudflare Worker that holds the
 * Deepgram key server-side (premium Aura TTS + live STT relay). If blanked, the
 * app falls back to the device voice + iOS Web Speech (no key needed). */
window.DG_PROXY = "https://a320-dg.robertosoares1985.workers.dev";
