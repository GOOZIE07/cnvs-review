// Audio analyzer tests on synthetic audio. Run from the repo root: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeAudio, fft } from "../ai-music/analyzer.js";

const SR = 44100;

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Music-like test signal: tilted noise plus notes that change every half second.
function fakeMusic(seconds, seed = 1) {
  const r = rng(seed), n = Math.round(seconds * SR), x = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) { lp = 0.92 * lp + 0.08 * (r() * 2 - 1); x[i] = 0.25 * lp + 0.002 * (r() * 2 - 1); }
  const step = SR / 2;
  for (let s = 0; s < n; s += step) {
    for (let v = 0; v < 3; v++) {
      const f0 = 110 * 2 ** (Math.floor(r() * 36) / 12), ph = r() * 6.28;
      for (let h = 1; h <= 12; h++) {
        const w = 2 * Math.PI * f0 * h * (1 + 0.0007 * h) / SR, a = 0.05 / h;
        for (let i = s; i < Math.min(n, s + step); i++) x[i] += a * Math.sin(w * i + ph * h);
      }
    }
  }
  return x;
}

// Faint, evenly spaced lines like a neural decoder's upsampling layers leave.
function addComb(x, spacingHz, relDb) {
  let rms = 0;
  for (const v of x) rms += v * v;
  rms = Math.sqrt(rms / x.length);
  const lines = Math.floor(19000 / spacingHz), amp = rms * 10 ** (relDb / 20) * Math.sqrt(2 / lines);
  const y = Float32Array.from(x);
  for (let k = 1; k <= lines; k++) {
    const w = 2 * Math.PI * k * spacingHz / SR, ph = (k * 2.4) % 6.28;
    for (let i = 0; i < y.length; i++) y[i] += amp * Math.cos(w * i + ph);
  }
  return y;
}

test("fft matches a direct DFT", () => {
  const n = 64, r = rng(7);
  const x = Array.from({ length: n }, () => r() - 0.5);
  const re = Float64Array.from(x), im = new Float64Array(n);
  fft(re, im);
  for (const k of [0, 1, 5, 31, 32, 63]) {
    let a = 0, b = 0;
    for (let t = 0; t < n; t++) { a += x[t] * Math.cos(2 * Math.PI * k * t / n); b -= x[t] * Math.sin(2 * Math.PI * k * t / n); }
    assert.ok(Math.abs(a - re[k]) < 1e-9 && Math.abs(b - im[k]) < 1e-9, `bin ${k}`);
  }
});

test("music without generator lines scores low", () => {
  for (const seed of [1, 2, 3]) {
    const r = analyzeAudio([fakeMusic(30, seed)], SR);
    assert.ok(r.ok);
    assert.ok(r.score < 0.25, `seed ${seed}: ${r.score}`);
  }
});

test("finds faint evenly spaced generator lines", () => {
  const r = analyzeAudio([addComb(fakeMusic(30, 4), SR / 512, -30)], SR);
  assert.ok(r.ok);
  assert.ok(r.score > 0.75, `score ${r.score}`);
  const ratio = r.spacingHz / (SR / 512);
  assert.ok(Math.abs(ratio - Math.round(ratio)) < 0.01, `spacing ${r.spacingHz}`);
  assert.ok(r.chart.ys.length > 100 && r.chart.zoom && r.chart.zoom.comb.length >= 5);
});

test("stereo input is mixed down", () => {
  const l = fakeMusic(20, 5), rch = fakeMusic(20, 6);
  const r = analyzeAudio([l, rch], SR);
  assert.ok(r.ok && r.score < 0.25);
});

test("refuses clips that are too short", () => {
  const r = analyzeAudio([fakeMusic(5, 1)], SR);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "too-short");
});
