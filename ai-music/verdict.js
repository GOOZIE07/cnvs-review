// Turns the raw signals into levels, a combined score and plain-language copy.
// Pure functions so they can be tested in Node.

export const LEVEL = { ok: "ok", warn: "warn", bad: "bad", none: "none" };

// Audio fingerprint (0..1 from the analyzer).
export function audioLevel(analysis) {
  if (!analysis || !analysis.ok) return LEVEL.none;
  if (analysis.score >= 0.75) return LEVEL.bad;
  if (analysis.score >= 0.25) return LEVEL.warn;
  return LEVEL.ok;
}

// Release pattern (0..1). Mass-produced AI catalogues release far more often,
// at a steadier rhythm and across more genres than people tend to.
export function catalogScore(c, now = Date.now()) {
  if (!c) return null;
  let s = 0;
  if (c.tracksLastYear >= 120) s += 0.6;
  else if (c.tracksLastYear >= 60) s += 0.35;
  else if (c.tracksLastYear >= 36) s += 0.15;
  if (c.medianGapDays !== null && c.medianGapDays <= 10 && c.releasesLastYear >= 8) s += 0.2;
  if (c.genres.length >= 5) s += 0.1;
  const first = Date.parse(c.firstRelease);
  if (Number.isFinite(first) && now - first < 3 * 365 * 86400000 && c.tracks >= 60) s += 0.15;
  return Math.min(1, s);
}

export function catalogLevel(score) {
  if (score === null || score === undefined) return LEVEL.none;
  if (score >= 0.5) return LEVEL.bad;
  if (score >= 0.25) return LEVEL.warn;
  return LEVEL.ok;
}

// Combined 0..100. Audio is the main evidence; an unusual release pattern on
// its own can lift the score to "some signals" (50) but never to "strong".
export function combine(audioScore, catScore) {
  const A = audioScore ?? 0, C = catScore ?? 0;
  return Math.round(100 * (1 - (1 - A) * (1 - 0.5 * C)));
}

export function verdict(analysis, catalog, now = Date.now()) {
  const aLevel = audioLevel(analysis);
  const cScore = catalogScore(catalog, now);
  const cLevel = catalogLevel(cScore);
  const audioOk = aLevel !== LEVEL.none;
  const score = combine(audioOk ? analysis.score : null, cScore);

  let level, title, body;
  if (!audioOk) {
    level = cLevel === LEVEL.bad ? LEVEL.warn : LEVEL.none;
    title = "Audio couldn't be checked";
    body = cLevel === LEVEL.bad
      ? "No usable preview was available. The artist's release pattern does look like a mass-produced catalogue."
      : "No usable preview was available, so this result rests on the artist's release history alone.";
  } else if (score >= 70) {
    level = LEVEL.bad;
    title = "Strong AI signals";
    body = "The audio carries the regular spectral pattern that AI music generators leave behind."
      + (cLevel === LEVEL.bad ? " The artist's release pattern also looks mass-produced." : "");
  } else if (score >= 25) {
    level = LEVEL.warn;
    title = "Some AI signals";
    const why = [];
    if (aLevel !== LEVEL.ok) why.push("the audio shows a faint, regular pattern like the one AI generators leave");
    if (cLevel !== LEVEL.ok && cLevel !== LEVEL.none) why.push("the artist releases music at a pace typical of mass-produced catalogues");
    body = (why.length ? cap(why.join(", and ")) + ". " : "") + "Worth a closer look before you rely on it.";
  } else {
    level = LEVEL.ok;
    title = "No AI signals found";
    body = "We couldn't find signs of AI generation in this song's audio or release pattern. That isn't proof it's fully human-made.";
  }
  return { level, title, body, score, audio: aLevel, catalog: cLevel, catalogScore: cScore };
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
