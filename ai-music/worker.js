// Runs the audio analysis off the main thread so the page stays responsive.
import { analyzeAudio } from "./analyzer.js";

self.onmessage = e => {
  try {
    const { channels, sampleRate } = e.data;
    self.postMessage({ ok: true, result: analyzeAudio(channels, sampleRate) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
