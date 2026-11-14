// Scoring tests. Run from the repo root: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, catalogScore, combine } from "../ai-music/verdict.js";

const now = Date.parse("2026-11-14T00:00:00Z");
const typical = {
  releases: 9, tracks: 95, tracksLastYear: 12, releasesLastYear: 1, medianGapDays: 400,
  genres: ["Pop"], firstRelease: "2012-03-01", tracksPerMonth: 0.6,
};
const flood = {
  releases: 160, tracks: 410, tracksLastYear: 300, releasesLastYear: 120, medianGapDays: 3,
  genres: ["Pop", "Rock", "Jazz", "Country", "Ambient", "Dance"], firstRelease: "2025-02-01", tracksPerMonth: 19,
};
const clean = { ok: true, score: 0.03, spacingHz: 120 };
const faint = { ok: true, score: 0.5, spacingHz: 86.1 };
const strong = { ok: true, score: 0.98, spacingHz: 86.1 };

test("release pattern score", () => {
  assert.equal(catalogScore(typical, now), 0);
  assert.equal(catalogScore(flood, now), 1);
  assert.equal(catalogScore(null, now), null);
});

test("combined score keeps release pattern below 'strong' on its own", () => {
  assert.equal(combine(0, 1), 50);
  assert.equal(combine(1, 0), 100);
  assert.equal(combine(0.03, 0), 3);
});

test("clean audio and typical releases: no AI signals", () => {
  const v = verdict(clean, typical, now);
  assert.equal(v.level, "ok");
  assert.equal(v.title, "No AI signals found");
  assert.match(v.body, /isn't proof/);
});

test("clean audio but mass-produced catalogue: some signals", () => {
  const v = verdict(clean, flood, now);
  assert.equal(v.level, "warn");
  assert.match(v.body, /pace typical of mass-produced/);
});

test("faint pattern: some signals; strong pattern: strong signals", () => {
  assert.equal(verdict(faint, typical, now).level, "warn");
  const v = verdict(strong, null, now);
  assert.equal(v.level, "bad");
  assert.equal(v.title, "Strong AI signals");
});

test("no preview: says so instead of claiming the song is clean", () => {
  const v = verdict(null, typical, now);
  assert.equal(v.level, "none");
  assert.equal(v.title, "Audio couldn't be checked");
  assert.equal(verdict({ ok: false, reason: "too-short" }, flood, now).level, "warn");
});
