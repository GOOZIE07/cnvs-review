// CNVS AI Music — page logic.
import { analyzeAudio } from "./analyzer.js";
import { verdict, LEVEL } from "./verdict.js";

const API = document.querySelector('meta[name="cnvs-api"]').content;
const $ = id => document.getElementById(id);
const form = $("form"), input = $("link"), go = $("go"), err = $("err"), out = $("out"), pasteBtn = $("paste");

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SOURCE = { apple: "Apple Music", spotify: "Spotify", deezer: "Deezer" };
const ICON = {
  ok: '<path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5z"/><path d="m9 12 2 2 4-4"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  bad: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  none: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
};
const svgIcon = (k, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

let run = 0;
let player = null;

// ------------------------------------------------------------ input

if (navigator.clipboard && navigator.clipboard.readText) {
  pasteBtn.hidden = false;
  pasteBtn.addEventListener("click", async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) { input.value = text; check(text); }
    } catch { input.focus(); }
  });
}

form.addEventListener("submit", e => {
  e.preventDefault();
  check(input.value.trim());
});

const initial = new URLSearchParams(location.search).get("url");
if (initial) { input.value = initial; check(initial); }

function setError(msg) {
  err.hidden = !msg;
  err.textContent = msg || "";
}

// ------------------------------------------------------------ flow

async function check(link) {
  const id = ++run;
  stopPlayer();
  setError("");
  if (!link) { setError("Paste a Spotify or Apple Music song link first."); input.focus(); return; }
  if (!/spotify|apple\.com/i.test(link)) { setError("That doesn't look like a Spotify or Apple Music link."); input.focus(); return; }

  go.disabled = true;
  go.textContent = "Checking…";
  input.blur();
  out.innerHTML = "";
  const steps = progress();
  try {
    steps.set("find", "now");
    const data = await api(link);
    if (id !== run) return;
    steps.set("find", "done");
    out.prepend(trackCard(data));

    steps.set("fetch", "now");
    const audio = await loadPreview(data.previews);
    if (id !== run) return;
    steps.set("fetch", audio ? "done" : "skip");
    if (audio) attachPlayer(audio);

    steps.set("scan", "now");
    const analysis = audio ? await analyse(audio.decoded) : null;
    if (id !== run) return;
    steps.set("scan", analysis ? "done" : "skip");
    steps.set("history", data.catalog ? "done" : "skip");

    steps.remove();
    renderResult(data, analysis, audio);
    history.replaceState(null, "", `?url=${encodeURIComponent(link)}`);
  } catch (e) {
    if (id !== run) return;
    out.innerHTML = "";
    setError(e.message || "Something went wrong. Try again.");
  } finally {
    if (id === run) { go.disabled = false; go.textContent = "Check song"; }
  }
}

async function api(link) {
  let r;
  try {
    r = await fetch(`${API}?url=${encodeURIComponent(link)}`);
  } catch {
    throw new Error("Couldn't reach CNVS. Check your connection and try again.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || "Something went wrong. Try again.");
  return j;
}

async function loadPreview(previews) {
  for (const p of previews || []) {
    try {
      const r = await fetch(`${API}?audio=${encodeURIComponent(p.url)}`);
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      const blob = new Blob([buf.slice(0)], { type: r.headers.get("content-type") || "audio/mpeg" });
      const decoded = await decode(buf);
      if (decoded.duration < 8) continue;
      return { ...p, blob, decoded };
    } catch { /* try the next preview */ }
  }
  return null;
}

function decode(buf) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(2, 44100, 44100);
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buf, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

function analyse(decoded) {
  const channels = [];
  for (let c = 0; c < Math.min(2, decoded.numberOfChannels); c++) channels.push(decoded.getChannelData(c).slice());
  const sampleRate = decoded.sampleRate;
  const here = () => analyzeAudio(channels, sampleRate);
  return new Promise(resolve => {
    let w;
    try { w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" }); }
    catch { resolve(here()); return; }
    const fallback = () => { w.terminate(); resolve(here()); };
    w.onmessage = e => { w.terminate(); e.data.ok ? resolve(e.data.result) : fallback(); };
    w.onerror = fallback;
    w.postMessage({ channels, sampleRate });
  });
}

// ------------------------------------------------------------ progress

function progress() {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<ol class="steps">
    <li data-k="find"><span class="dot"></span>Finding the song</li>
    <li data-k="fetch"><span class="dot"></span>Getting the 30-second preview</li>
    <li data-k="scan"><span class="dot"></span>Scanning the audio for AI fingerprints</li>
    <li data-k="history"><span class="dot"></span>Checking the artist's release history</li>
  </ol>`;
  out.append(el);
  return {
    set(k, state) {
      const li = el.querySelector(`[data-k="${k}"]`);
      li.className = state;
      li.setAttribute("aria-current", state === "now" ? "step" : "false");
    },
    remove() { el.remove(); },
  };
}

// ------------------------------------------------------------ rendering

function trackCard(d) {
  const t = d.track;
  const year = t.releaseDate ? t.releaseDate.slice(0, 4) : "";
  const dur = t.durationMs ? `${Math.floor(t.durationMs / 60000)}:${String(Math.round(t.durationMs / 1000) % 60).padStart(2, "0")}` : "";
  const sub = [t.album, year, dur].filter(Boolean).map(esc).join(" · ");
  const el = document.createElement("article");
  el.className = "card";
  el.innerHTML = `
    <div class="track">
      ${t.artwork ? `<img class="art" src="${esc(t.artwork)}" alt="" width="84" height="84">` : `<div class="art"></div>`}
      <div class="meta">
        <h2>${esc(t.title)}</h2>
        <p>${esc(t.artist)}</p>
        ${sub ? `<p class="sub">${sub}</p>` : ""}
      </div>
      <span id="playslot"></span>
    </div>
    <div class="chips">
      ${Object.entries(d.links || {}).map(([k, u]) =>
        `<a class="chip" href="${esc(u)}" target="_blank" rel="noopener">${esc(SOURCE[k] || k)}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg></a>`).join("")}
      ${t.explicit ? `<span class="chip">Explicit</span>` : ""}
    </div>`;
  return el;
}

function attachPlayer(audio) {
  const slot = $("playslot");
  if (!slot) return;
  const url = URL.createObjectURL(audio.blob);
  const a = new Audio(url);
  a.preload = "auto";
  const btn = document.createElement("button");
  btn.className = "play";
  btn.type = "button";
  const C = 2 * Math.PI * 21;
  const draw = () => {
    const playing = !a.paused;
    btn.setAttribute("aria-label", playing ? "Pause preview" : `Play the ${SOURCE[audio.source]} preview`);
    btn.innerHTML = `<svg class="ring" width="46" height="46" viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="21" fill="none" stroke="var(--accent-hi)" stroke-width="2"
      stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - (a.currentTime / (a.duration || 30)))}"/></svg>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${playing
        ? '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'
        : '<path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.7L9.5 4.6A1 1 0 0 0 8 5.5z"/>'}</svg>`;
  };
  btn.addEventListener("click", () => (a.paused ? a.play() : a.pause()));
  for (const ev of ["play", "pause", "ended", "timeupdate"]) a.addEventListener(ev, draw);
  draw();
  slot.replaceWith(btn);
  player = { a, url };
}

function stopPlayer() {
  if (!player) return;
  player.a.pause();
  URL.revokeObjectURL(player.url);
  player = null;
}

function renderResult(d, analysis, audio) {
  const v = verdict(analysis, d.catalog);
  const badge = { ok: "No AI signals found", warn: "Some AI signals", bad: "Strong AI signals", none: "Not checked" }[v.level];

  const verdictEl = document.createElement("article");
  verdictEl.className = `card verdict ${v.level}`;
  verdictEl.innerHTML = `
    <span class="badge">${svgIcon(v.level)}${esc(badge)}</span>
    <h3>${esc(v.title === badge ? headline(v.level) : v.title)}</h3>
    <p>${esc(v.body)}</p>
    <div class="meter" role="img" aria-label="AI signal score ${v.score} out of 100">
      <div class="bar"><div class="fill"></div></div>
      <div class="lbl"><span>Human-like</span><span>AI signal score <b>${v.score}</b>/100</span><span>AI-like</span></div>
    </div>`;

  out.append(verdictEl, audioCard(analysis, audio, v.audio), catalogCard(d.catalog, v.catalog, d.track));
  if (d.links && d.links.deezer) out.append(crossCheckCard(d.links.deezer));
  for (const note of d.notes || []) {
    const n = document.createElement("p");
    n.className = "fine";
    n.innerHTML = `${svgIcon("none", 14)}<span>${esc(note)}</span>`;
    out.append(n);
  }
  out.append(actions(), disclaimer());
  requestAnimationFrame(() => requestAnimationFrame(() => {
    verdictEl.querySelector(".fill").style.width = `${Math.max(3, v.score)}%`;
  }));
  verdictEl.setAttribute("tabindex", "-1");
  verdictEl.focus({ preventScroll: true });
  out.firstElementChild.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function headline(level) {
  return {
    ok: "Nothing in this song points to AI",
    warn: "This song has some AI signals",
    bad: "This song shows strong signs of AI generation",
    none: "Audio couldn't be checked",
  }[level];
}

function audioCard(a, audio, level) {
  const el = document.createElement("article");
  el.className = `card signal ${level}`;
  const label = { ok: "Clean", warn: "Faint pattern", bad: "Generator pattern", none: "Not checked" }[level];
  let body;
  if (!audio) body = "None of the services offered a preview of this song, so the audio couldn't be checked.";
  else if (!a || !a.ok) body = a && a.reason === "low-bandwidth"
    ? "The preview is too heavily compressed to check for generator artifacts."
    : "The preview was too short to check reliably.";
  else if (level === LEVEL.ok) body = "No regular, generator-style pattern in the preview's spectrum.";
  else if (level === LEVEL.warn) body = `A faint, evenly spaced pattern of spectral lines (about every ${fmtHz(a.spacingHz)}). It can come from AI generation, and occasionally from steady tones or audio processing.`;
  else body = `Evenly spaced spectral lines about every ${fmtHz(a.spacingHz)}, the kind of pattern AI music generators' upsampling layers leave behind.`;

  el.innerHTML = `<h4>Audio fingerprint <small>${esc(label)}</small></h4><p>${esc(body)}</p>
    ${a && a.ok ? chart(a.chart, level) : ""}
    ${a && a.ok ? `<p class="note">Checked ${Math.round(a.seconds)} seconds of the ${esc(SOURCE[audio.source])} preview, ${(a.bandHz[0] / 1000).toFixed(0)}–${(a.bandHz[1] / 1000).toFixed(0)} kHz.</p>` : ""}`;
  return el;
}

function chart(ch, level) {
  // When lines were found, show a close-up where each one is visible;
  // otherwise the whole band.
  const view = ch.zoom || ch;
  const W = 320, H = 92, top = 10, bottom = H - 4;
  const max = Math.max(8, ...view.ys);
  const y = v => (bottom - ((v + 3) / (max + 3)) * (bottom - top)).toFixed(1);
  const pts = view.ys.map((v, i) => `${((i / (view.ys.length - 1)) * W).toFixed(1)},${y(v)}`).join(" ");
  const col = level === LEVEL.bad ? "var(--bad)" : level === LEVEL.warn ? "var(--warn)" : "var(--teal)";
  const ticks = (ch.zoom ? ch.zoom.comb : []).map(f => {
    const x = (((f - view.loHz) / (view.hiHz - view.loHz)) * W).toFixed(1);
    return `<line x1="${x}" x2="${x}" y1="0" y2="6" stroke="${col}" stroke-width="1.5"/>`;
  }).join("");
  const kHz = hz => (hz / 1000).toFixed(ch.zoom ? 1 : 0);
  const caption = ch.zoom ? `Close-up: markers every ${fmtHz(ch.spacingHz)}` : "Spikes above the music's own shape";
  return `<div class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spectrum of the preview with the music's own shape removed${ch.zoom ? `, close-up with markers every ${fmtHz(ch.spacingHz)}` : ""}">
      ${ticks}
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>
    <div class="axis"><span>${kHz(view.loHz)} kHz</span><span>${esc(caption)}</span><span>${kHz(view.hiHz)} kHz</span></div>
  </div>`;
}

function catalogCard(c, level, track) {
  const el = document.createElement("article");
  el.className = `card signal ${level}`;
  const label = { ok: "Typical", warn: "Busy", bad: "Mass-produced", none: "Not available" }[level];
  if (!c) {
    el.innerHTML = `<h4>Release pattern <small>${label}</small></h4><p>${esc(track.artist)} wasn't found on Apple Music, so release history isn't available.</p>`;
    return el;
  }
  const since = c.firstRelease ? new Date(c.firstRelease).toLocaleDateString("en", { month: "short", year: "numeric" }) : "";
  const releases = c.capped ? `${c.releases}+` : String(c.releases);
  let body;
  if (level === LEVEL.bad) body = `${c.artistName} released ${c.tracksLastYear} tracks in the last 12 months${c.medianGapDays !== null ? `, about one release every ${c.medianGapDays} days` : ""}${c.genres.length > 2 ? `, across ${c.genres.length} genres` : ""}. That pace is typical of mass-produced AI catalogues, though some human producers work this fast too.`;
  else if (level === LEVEL.warn) body = `${c.artistName} releases more often than most artists: ${c.tracksLastYear} tracks in the last 12 months. Busy, but not unusual on its own.`;
  else body = `${c.artistName} has ${releases} release${c.releases === 1 ? "" : "s"} on Apple Music${since ? ` since ${since}` : ""}, a typical pace.`;
  el.innerHTML = `<h4>Release pattern <small>${label}</small></h4><p>${esc(body)}</p>
    <ul class="facts">
      <li><b>${c.tracksLastYear}</b><span>tracks in last 12 months</span></li>
      <li><b>${releases}</b><span>releases since ${esc(since || "start")}</span></li>
      <li><b>${c.medianGapDays === null ? "—" : `${c.medianGapDays} d`}</b><span>typical gap between releases</span></li>
      <li><b>${c.genres.length}</b><span>genre${c.genres.length === 1 ? "" : "s"}</span></li>
    </ul>`;
  return el;
}

function crossCheckCard(deezerUrl) {
  const el = document.createElement("article");
  el.className = "card signal";
  el.innerHTML = `<h4>Cross-check on Deezer</h4>
    <p>Deezer runs its own AI detector and labels albums that contain AI-generated tracks. Open this song on Deezer to see whether its album carries the "AI-generated content" label.</p>
    <div class="chips"><a class="chip" href="${esc(deezerUrl)}" target="_blank" rel="noopener">Open on Deezer<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg></a></div>`;
  return el;
}

function actions() {
  const el = document.createElement("div");
  el.className = "actions";
  el.innerHTML = `<button type="button" class="ghost" id="again">Check another</button>
    <button type="button" class="ghost" id="share">Share result</button>`;
  el.querySelector("#again").addEventListener("click", () => {
    run++;
    stopPlayer();
    out.innerHTML = "";
    input.value = "";
    history.replaceState(null, "", location.pathname);
    window.scrollTo({ top: 0 });
    input.focus();
  });
  el.querySelector("#share").addEventListener("click", async e => {
    const url = location.href;
    try {
      if (navigator.share) await navigator.share({ title: "CNVS AI Music", url });
      else { await navigator.clipboard.writeText(url); e.target.textContent = "Link copied"; }
    } catch { /* cancelled */ }
  });
  return el;
}

function disclaimer() {
  const el = document.createElement("p");
  el.className = "fine";
  el.innerHTML = `${svgIcon("none", 14)}<span>This is an estimate from a 30-second preview and public release data, not proof of how the song was made.</span>`;
  return el;
}

const fmtHz = hz => (hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`);
