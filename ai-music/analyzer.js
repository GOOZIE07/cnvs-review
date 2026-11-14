// CNVS AI Music — audio analyzer.
//
// Most AI music generators turn a compact internal representation back into
// audio with learned upsampling layers. Those layers leave faint spectral
// lines spaced evenly across the high frequencies, a regular comb that
// recorded and mixed music doesn't have. This module averages the spectrum of
// a clip, removes the music's own smooth shape, and measures how strong and
// how regular any such comb is.
//
// Runs in the browser and in Node (no dependencies). Input: mono samples.

export const FFT_SIZE = 16384;
const BASELINE_HALF = 40;          // median baseline window: 81 bins (~218 Hz at 44.1 kHz)
// Two bands are checked: the upper mids, where generator artifacts are often
// strongest, and the highs above most melodic content.
const BANDS = [[1000, 8000], [5000, 19000]];
const MIN_BAND_HZ = 3000;
const SPACING_MIN_HZ = 15;
const SPACING_MAX_HZ = 1000;
// MP3's filterbank splits the spectrum into 32 bands, which can itself leave a
// faint ripple every sampleRate/64 Hz. Ignore spacings near it so ordinary MP3
// previews are not mistaken for AI artifacts.
const MP3_SUBBAND_DIVISOR = 64;

// ---------- FFT (iterative radix-2, cached tables) ----------
const fftCache = new Map();
function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  t = { rev, cos, sin };
  fftCache.set(n, t);
  return t;
}

export function fft(re, im) {
  const n = re.length;
  const { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const a = start + k, b = a + half;
        const tr = re[b] * cos[w] - im[b] * sin[w];
        const ti = re[b] * sin[w] + im[b] * cos[w];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

const nextPow2 = n => 1 << Math.ceil(Math.log2(Math.max(2, n)));

function median(arr) {
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---------- Steps ----------

export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length, out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

// Long-term average power spectrum, skipping near-silent frames.
export function averageSpectrum(x, n = FFT_SIZE) {
  const hop = n / 2, bins = n / 2 + 1;
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  const P = new Float64Array(bins), G = new Float64Array(bins);
  const re = new Float64Array(n), im = new Float64Array(n);
  let frames = 0;
  for (let s = 0; s + n <= x.length; s += hop) {
    let e = 0;
    for (let i = 0; i < n; i++) e += x[s + i] * x[s + i];
    if (Math.sqrt(e / n) < 1e-4) continue;           // below about -80 dBFS
    for (let i = 0; i < n; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      P[k] += p;
      G[k] += Math.log10(p + 1e-20);
    }
    frames++;
  }
  // P: mean power. Ldb: mean of log power, which favours steady lines over
  // loud, changing musical content.
  const Ldb = new Float64Array(bins);
  if (frames) for (let k = 0; k < bins; k++) { P[k] /= frames; Ldb[k] = 10 * G[k] / frames; }
  return { P, Ldb, frames };
}

function toDb(P) {
  const L = new Float64Array(P.length);
  for (let k = 0; k < P.length; k++) L[k] = 10 * Math.log10(P[k] + 1e-20);
  return L;
}

// Running median: the music's smooth spectral shape, ignoring narrow lines.
function medianBaseline(L, half = BASELINE_HALF) {
  const n = L.length, B = new Float64Array(n), buf = new Float64Array(2 * half + 1);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - half), b = Math.min(n - 1, k + half), len = b - a + 1;
    for (let i = 0; i < len; i++) buf[i] = L[a + i];
    const w = buf.subarray(0, len).sort();
    B[k] = w[len >> 1];
  }
  return B;
}

// Where a lossy codec (or a low native sample rate) cuts the top off: the
// steepest sustained drop above 10 kHz, if it's a real cliff.
export function findCutoff(B, binHz, sampleRate) {
  const m = Math.max(4, Math.round(120 / binHz));
  let best = 0, bestK = -1;
  const k0 = Math.round(10000 / binHz);
  for (let k = k0; k < B.length - m; k++) {
    const drop = B[k - m] - B[k + m];
    if (drop > best) { best = drop; bestK = k; }
  }
  if (best >= 20) return { hz: bestK * binHz, dropDb: best, sharp: true };
  return { hz: sampleRate / 2, dropDb: best, sharp: false };
}

// ---------- Main ----------

export function analyzeAudio(channels, sampleRate, opts = {}) {
  const n = opts.fftSize || FFT_SIZE;
  const mono = Array.isArray(channels) ? mixToMono(channels) : channels;
  const maxSamples = Math.round((opts.maxSeconds || 45) * sampleRate);
  const x = mono.length > maxSamples ? mono.subarray(0, maxSamples) : mono;
  const seconds = x.length / sampleRate;
  const binHz = sampleRate / n;

  const { P, Ldb, frames } = averageSpectrum(x, n);
  if (frames < 8 || seconds < 8) return { ok: false, reason: "too-short", seconds, frames };

  const L = opts.average === "power" ? toDb(P) : Ldb;
  const B = medianBaseline(L);
  const cutoff = findCutoff(B, binHz, sampleRate);
  const top = Math.min(cutoff.hz - 400, sampleRate * 0.45);

  const bands = [];
  for (const [lo, hi0] of BANDS) {
    const hi = Math.min(hi0, top);
    if (hi - lo < MIN_BAND_HZ) continue;
    bands.push(analyzeBand(L, B, binHz, sampleRate, lo, hi));
  }
  if (!bands.length) return { ok: false, reason: "low-bandwidth", seconds, frames, cutoffHz: Math.round(cutoff.hz) };

  const best = bands.reduce((a, b) => (b.z > a.z ? b : a));
  const score = 1 / (1 + Math.exp(-2.2 * best.z));
  return {
    ok: true,
    score,
    seconds: round(seconds, 1), frames, sampleRate,
    cutoffHz: Math.round(cutoff.hz),
    codecCutoff: cutoff.sharp,
    bandHz: best.bandHz,
    periodicityDb: best.peakDb,
    spacingHz: best.spacingHz,
    lineContrastDb: best.contrastDb,
    lineHitRate: best.hitRate,
    bands: bands.map(({ chart, ...b }) => b),
    chart: best.chart,
  };
}

function analyzeBand(L, B, binHz, sampleRate, loHz, hiHz) {
  const k0 = Math.ceil(loHz / binHz), k1 = Math.floor(hiHz / binHz);
  const M = k1 - k0 + 1;

  // Residual: how far each bin pokes above the local median, in dB.
  const R = new Float64Array(M);
  for (let i = 0; i < M; i++) R[i] = L[k0 + i] - B[k0 + i];

  // Periodicity: the spectrum of the residual ("cepstrum"). An even comb of
  // lines every D Hz shows up as a sharp peak at quefrency Q·binHz/D.
  const Q = nextPow2(4 * M);
  const re = new Float64Array(Q), im = new Float64Array(Q);
  let mean = 0;
  for (let i = 0; i < M; i++) mean += Math.max(0, R[i]);
  mean /= M;
  for (let i = 0; i < M; i++) re[i] = (Math.max(0, R[i]) - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (M - 1)));
  fft(re, im);
  const qLo = Math.max(2, Math.floor(Q * binHz / SPACING_MAX_HZ));
  const qHi = Math.min(Q / 2 - 1, Math.ceil(Q * binHz / SPACING_MIN_HZ));
  const mp3Spacing = sampleRate / MP3_SUBBAND_DIVISOR;
  const ceps = new Float64Array(qHi + 1);
  const usable = [];
  for (let q = qLo; q <= qHi; q++) {
    ceps[q] = re[q] * re[q] + im[q] * im[q];
    const spacing = Q * binHz / q;
    let mp3 = false;   // skip (sub)multiples of the MP3 subband width, ±3%
    for (const f of [0.5, 1, 2, 3]) if (Math.abs(spacing / (mp3Spacing * f) - 1) < 0.03) mp3 = true;
    if (!mp3) usable.push(q);
  }
  const floor = median(usable.map(q => ceps[q])) || 1e-12;
  let qBest = usable[0];
  for (const q of usable) if (ceps[q] > ceps[qBest]) qBest = q;
  const peakDb = 10 * Math.log10(ceps[qBest] / floor);

  // Refine: the comb spacing that best lines up with peaks in the residual,
  // searched around the cepstral estimate and its multiples (the cepstrum can
  // lock onto a harmonic of the true spacing).
  const coarse = Q * binHz / qBest;
  let bestComb = { contrastDb: -Infinity, hitRate: 0, spacingHz: coarse, t: 0 };
  for (const mult of [1, 2, 3, 4]) {
    const centre = coarse * mult;
    if (centre > SPACING_MAX_HZ) break;
    for (let step = -40; step <= 40; step++) {
      const sp = centre * (1 + step * 0.0005);
      const c = combStats(R, k0, binHz, sp);
      if (c.t > bestComb.t) bestComb = { ...c, spacingHz: sp };
    }
  }

  // Evidence needs both a sharp cepstral peak and lines that really sit on
  // the comb (t-statistic of on-comb vs between-comb residual).
  const zPeriod = (peakDb - 27) / 3;
  const zLines = (bestComb.t - 18) / 4;
  const z = 0.5 * zPeriod + 0.5 * zLines;
  return {
    z: round(z, 3),
    bandHz: [Math.round(loHz), Math.round(hiHz)],
    peakDb: round(peakDb, 1),
    spacingHz: round(bestComb.spacingHz, 2),
    contrastDb: round(bestComb.contrastDb, 2),
    hitRate: round(bestComb.hitRate, 2),
    combT: round(bestComb.t, 1),
    chart: chartData(R, k0, binHz, bestComb.spacingHz, z > 0),
  };
}

function combStats(R, k0, binHz, spacingHz) {
  const M = R.length, kLo = k0, kHi = k0 + M - 1;
  const at = f => {
    const c = Math.round(f / binHz);
    let v = -Infinity;
    for (let k = c - 1; k <= c + 1; k++) if (k >= kLo && k <= kHi) v = Math.max(v, R[k - k0]);
    return v;
  };
  const diffs = [], on = [];
  for (let j = Math.ceil(kLo * binHz / spacingHz); (j + 0.5) * spacingHz <= kHi * binHz; j++) {
    const a = at(j * spacingHz), b = at((j + 0.5) * spacingHz);
    if (Number.isFinite(a) && Number.isFinite(b)) { diffs.push(a - b); on.push(a); }
  }
  if (diffs.length < 8) return { contrastDb: 0, hitRate: 0, t: 0 };
  const m = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - m) ** 2, 0) / (diffs.length - 1)) || 1e-9;
  return {
    contrastDb: m,
    hitRate: on.filter(v => v > 3).length / on.length,
    t: m / (sd / Math.sqrt(diffs.length)),
  };
}

function chartData(R, k0, binHz, spacingHz, showComb) {
  const points = 320, M = R.length, per = M / points, ys = [];
  for (let p = 0; p < points; p++) {
    let v = -Infinity;
    for (let i = Math.floor(p * per); i < Math.max(Math.floor(p * per) + 1, Math.floor((p + 1) * per)); i++) v = Math.max(v, R[i]);
    ys.push(round(Math.max(-3, v), 2));
  }
  const loHz = k0 * binHz, hiHz = (k0 + M - 1) * binHz;
  const out = { loHz: Math.round(loHz), hiHz: Math.round(hiHz), spacingHz: round(spacingHz, 1), ys, comb: [], zoom: null };
  if (!showComb) return out;
  // The whole band is too wide to show individual lines on a phone, so also
  // return a close-up of about a dozen of them from the middle of the band.
  const width = Math.min(1500, Math.max(500, spacingHz * 12));
  const zLo = Math.max(loHz, (loHz + hiHz) / 2 - width / 2), zHi = Math.min(hiHz, zLo + width);
  const zk0 = Math.round(zLo / binHz) - k0, zk1 = Math.round(zHi / binHz) - k0;
  const comb = [];
  for (let j = Math.ceil(zLo / spacingHz); j * spacingHz <= zHi; j++) comb.push(Math.round(j * spacingHz));
  out.zoom = {
    loHz: Math.round((zk0 + k0) * binHz),
    hiHz: Math.round((zk1 + k0) * binHz),
    ys: Array.from(R.subarray(zk0, zk1 + 1), v => round(Math.max(-3, v), 2)),
    comb,
  };
  return out;
}

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }
