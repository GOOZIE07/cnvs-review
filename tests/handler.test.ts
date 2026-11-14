// Backend tests. Run from the repo root: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseLink, parseSpotifyEmbed, matchScore, catalogStats, allowedAudio, handle, UserError,
} from "../supabase/functions/ai-music/handler.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("parses Spotify song links in their common shapes", () => {
  const id = "4cOdK2wGLETKBW3PvgPWqT";
  for (const s of [
    `https://open.spotify.com/track/${id}`,
    `https://open.spotify.com/track/${id}?si=abc123&context=x`,
    `https://open.spotify.com/intl-de/track/${id}`,
    `open.spotify.com/track/${id}`,
    `spotify:track:${id}`,
    `Never Gonna Give You Up by Rick Astley https://open.spotify.com/track/${id}?si=1`,
    `https://open.spotify.com/embed/track/${id}`,
  ]) assert.deepEqual(parseLink(s), { platform: "spotify", id }, s);
  assert.equal(parseLink("https://spotify.link/AbCdEf123").platform, "spotify-short");
});

test("parses Apple Music song links", () => {
  assert.deepEqual(
    parseLink("https://music.apple.com/us/album/never-gonna-give-you-up/1559523357?i=1559523359"),
    { platform: "apple", id: "1559523359", country: "us" },
  );
  assert.deepEqual(
    parseLink("https://music.apple.com/za/song/never-gonna-give-you-up/1559523359"),
    { platform: "apple", id: "1559523359", country: "za" },
  );
  assert.deepEqual(parseLink("https://music.apple.com/song/1559523359"), { platform: "apple", id: "1559523359", country: "us" });
  assert.deepEqual(
    parseLink("https://itunes.apple.com/gb/album/x/1559523357?i=1559523359&uo=4"),
    { platform: "apple", id: "1559523359", country: "gb" },
  );
});

test("rejects albums, playlists and other sites with a clear message", () => {
  for (const s of [
    "https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv",
    "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    "spotify:album:4LH4d3cOWNNsVw41Gqt2kv",
    "https://music.apple.com/us/album/3-originals/1559523357",
    "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb",
  ]) assert.throws(() => parseLink(s), (e: Error) => e instanceof UserError && /single song/.test(e.message), s);
  assert.throws(() => parseLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), /Only Spotify and Apple Music/);
  assert.throws(() => parseLink(""), /Paste a Spotify or Apple Music link/);
  assert.throws(() => parseLink("https://open.spotify.com/track/short"), /incomplete/);
});

test("reads track details and the preview from Spotify's embed page", () => {
  const { track, previewUrl } = parseSpotifyEmbed(fixture("spotify-embed-track.html"));
  assert.equal(track.title, "Never Gonna Give You Up");
  assert.deepEqual(track.artists, ["Rick Astley"]);
  assert.equal(track.releaseDate, "1987-11-12");
  assert.equal(track.durationMs, 213573);
  assert.match(track.artwork!, /b273/); // the 640px image
  assert.match(previewUrl!, /^https:\/\/p\.scdn\.co\/mp3-preview\//);
});

test("matches the same recording across services", () => {
  const want = { title: "Never Gonna Give You Up", artists: ["Rick Astley"], durationMs: 213573 };
  assert.ok(matchScore(want, { title: "Never Gonna Give You Up", artist: "Rick Astley", durationMs: 214720 }) > 0.9);
  assert.ok(matchScore(want, { title: "Never Gonna Give You Up - 2022 Remaster", artist: "Rick Astley", durationMs: 213000 }) > 0.9);
  assert.equal(matchScore(want, { title: "Never Gonna Give You Up", artist: "Cover Band", durationMs: 213000 }), 0);
  assert.equal(matchScore(want, { title: "Together Forever", artist: "Rick Astley", durationMs: 213000 }), 0);
  assert.equal(matchScore(want, { title: "Never Gonna Give You Up", artist: "Rick Astley", durationMs: 330000 }), 0);
  // Remaster labels are the same recording; remixes and re-recordings are not.
  assert.ok(matchScore(want, { title: "Never Gonna Give You Up (Remastered 2022)", artist: "Rick Astley", durationMs: 213000 }) > 0.9);
  assert.equal(matchScore(want, { title: "Never Gonna Give You Up (Cake Mix)", artist: "Rick Astley", durationMs: 347000 }), 0);
  assert.ok(matchScore(want, { title: "Never Gonna Give You Up (Pianoforte)", artist: "Rick Astley", durationMs: 213000 }) < 0.85);
  assert.ok(matchScore({ ...want, durationMs: null }, { title: "Never Gonna Give You Up", artist: "Rick Astley", durationMs: null }) >= 0.85);
});

test("summarises an artist's release history", () => {
  const now = Date.parse("2026-11-14T00:00:00Z");
  const albums = [];
  for (let i = 0; i < 40; i++) {
    albums.push({ releaseDate: new Date(now - i * 9 * 86400000).toISOString(), trackCount: 2, primaryGenreName: ["Pop", "Rock", "Jazz", "Ambient", "Country"][i % 5] });
  }
  const c = catalogStats("Prolific", albums, now)!;
  assert.equal(c.releases, 40);
  assert.equal(c.tracks, 80);
  assert.equal(c.releasesLastYear, 40);
  assert.equal(c.medianGapDays, 9);
  assert.equal(c.genres.length, 5);
  assert.ok(c.tracksPerMonth > 6 && c.tracksPerMonth < 8, String(c.tracksPerMonth));

  const sparse = catalogStats("Slow", [
    { releaseDate: "2015-03-01T00:00:00Z", trackCount: 11 },
    { releaseDate: "2019-06-01T00:00:00Z", trackCount: 12 },
    { releaseDate: "2024-01-01T00:00:00Z", trackCount: 10 },
  ], now)!;
  assert.equal(sparse.releasesLastYear, 0);
  assert.ok(sparse.tracksPerMonth < 1);
  assert.equal(catalogStats("None", [], now), null);
});

test("only proxies audio from known preview hosts", () => {
  assert.ok(allowedAudio("https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/x.m4a"));
  assert.ok(allowedAudio("https://p.scdn.co/mp3-preview/40a780b2"));
  assert.ok(allowedAudio("https://cdnt-preview.dzcdn.net/api/1/1/c/b/5/0/x.mp3?hdnea=exp=1"));
  assert.ok(allowedAudio("https://cdns-preview-d.dzcdn.net/stream/c-d.mp3"));
  assert.equal(allowedAudio("http://p.scdn.co/mp3-preview/x"), null);
  assert.equal(allowedAudio("https://evil.example/p.scdn.co"), null);
  assert.equal(allowedAudio("https://p.scdn.co.evil.example/x"), null);
  assert.equal(allowedAudio("not a url"), null);
});

// A fake network for the end-to-end handler tests.
function fakeFetch(routes: Record<string, (u: URL) => Response>) {
  const calls: string[] = [];
  const f = async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(u.href);
    for (const [prefix, fn] of Object.entries(routes)) if (u.href.startsWith(prefix)) return fn(u);
    return new Response("not found", { status: 404 });
  };
  return { f: f as typeof fetch, calls };
}
const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });

const lookup = JSON.parse(fixture("itunes-lookup-song.json"));
const song = lookup.results[0];
const routes = {
  "https://open.spotify.com/embed/track/": () => new Response(fixture("spotify-embed-track.html")),
  "https://itunes.apple.com/search": () => jsonRes({ resultCount: 2, results: [
    { ...song, trackName: "Never Gonna Give You Up (Live)", trackTimeMillis: 260000, trackId: 1 },
    song,
  ] }),
  "https://itunes.apple.com/lookup?id=669771": () => jsonRes({ results: [
    { wrapperType: "artist", artistName: "Rick Astley" },
    { wrapperType: "collection", releaseDate: "1987-11-12T08:00:00Z", trackCount: 10, primaryGenreName: "Pop" },
    { wrapperType: "collection", releaseDate: "2016-06-10T07:00:00Z", trackCount: 12, primaryGenreName: "Pop" },
  ] }),
  "https://itunes.apple.com/lookup?id=1559523359": () => jsonRes(lookup),
  "https://api.deezer.com/search": () => jsonRes({ data: [
    { id: 781592622, title: "Never Gonna Give You Up", duration: 213, preview: "https://cdnt-preview.dzcdn.net/api/1/1/x.mp3", link: "https://www.deezer.com/track/781592622", artist: { id: 1, name: "Rick Astley" } },
  ] }),
};

test("resolves a Spotify link end to end", async () => {
  const { f } = fakeFetch(routes);
  const res = await handle(new Request("https://fn.example/ai-music?url=" + encodeURIComponent("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=x")), f);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const j = await res.json();
  assert.equal(j.track.title, "Never Gonna Give You Up");
  assert.equal(j.track.album, "3 Originals");
  assert.deepEqual(j.previews.map((p: { source: string }) => p.source), ["apple", "spotify", "deezer"]);
  assert.equal(j.links.apple, "https://music.apple.com/us/album/never-gonna-give-you-up/1559523357?i=1559523359");
  assert.equal(j.catalog.releases, 2);
  assert.equal(j.catalog.tracks, 22);
});

test("resolves an Apple Music link end to end (POST)", async () => {
  const { f, calls } = fakeFetch(routes);
  const res = await handle(new Request("https://fn.example/ai-music", {
    method: "POST",
    body: JSON.stringify({ url: "https://music.apple.com/us/album/never-gonna-give-you-up/1559523357?i=1559523359" }),
  }), f);
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.equal(j.source.platform, "apple");
  assert.equal(j.track.artwork, "https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/69/5b/e3/695be316-9ddf-7262-177c-e37edd599602/0888880777768.jpg/600x600bb.jpg");
  assert.equal(j.previews[0].source, "apple");
  assert.ok(!calls.some(c => c.includes("spotify")));
});

test("returns friendly errors", async () => {
  const { f } = fakeFetch({ ...routes, "https://open.spotify.com/embed/track/": () => new Response("gone", { status: 404 }) });
  let res = await handle(new Request("https://fn.example/?url=" + encodeURIComponent("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT")), f);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /couldn't find that song/);

  res = await handle(new Request("https://fn.example/?url=" + encodeURIComponent("https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv")), f);
  assert.equal(res.status, 400);

  const broken = fakeFetch({ ...routes, "https://open.spotify.com/embed/track/": () => new Response("<html>changed</html>") });
  res = await handle(new Request("https://fn.example/?url=" + encodeURIComponent("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT")), broken.f);
  assert.equal(res.status, 502);
});

test("proxies preview audio with CORS and refuses other hosts", async () => {
  const { f } = fakeFetch({ "https://p.scdn.co/": () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg", "content-length": "3" } }) });
  let res = await handle(new Request("https://fn.example/?audio=" + encodeURIComponent("https://p.scdn.co/mp3-preview/abc")), f);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
  const apple = fakeFetch({ "https://audio-ssl.itunes.apple.com/": () => new Response(new Uint8Array([9]), { headers: { "content-type": "audio/x-m4p" } }) });
  res = await handle(new Request("https://fn.example/?audio=" + encodeURIComponent("https://audio-ssl.itunes.apple.com/a/b.plus.aac.p.m4a")), apple.f);
  assert.equal(res.headers.get("content-type"), "audio/mp4");
  res = await handle(new Request("https://fn.example/?format=base64&audio=" + encodeURIComponent("https://p.scdn.co/mp3-preview/abc")), f);
  assert.deepEqual(await res.json(), { ok: true, type: "audio/mpeg", base64: "AQID" });
  res = await handle(new Request("https://fn.example/?audio=" + encodeURIComponent("https://example.com/a.mp3")), f);
  assert.equal(res.status, 400);
});

test("answers CORS preflight", async () => {
  const res = await handle(new Request("https://fn.example/", { method: "OPTIONS" }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});
