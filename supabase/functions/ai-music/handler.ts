// CNVS AI Music — backend.
//
// GET ?url=<Spotify or Apple Music song link>  → track details, preview audio
//                                                 URLs and the artist's release
//                                                 history, as JSON.
// GET ?audio=<preview url>                     → the preview file itself, with
//                                                 CORS headers, so the browser
//                                                 can analyse it. Only known
//                                                 preview hosts are allowed.
//
// No API keys needed: Spotify's public embed page, Apple's iTunes Search API
// and Deezer's public API.

type Fetch = typeof fetch;

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const AUDIO_HOSTS = [
  /^audio-ssl\.itunes\.apple\.com$/,
  /^p\.scdn\.co$/,
  /^cdn[st]-preview(-[a-z0-9]+)?\.dzcdn\.net$/,
];
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- links

export type ParsedLink =
  | { platform: "spotify"; id: string }
  | { platform: "apple"; id: string; country: string }
  | { platform: "spotify-short"; url: string };

const SINGLE_SONG = "Paste a link to a single song, not an album, playlist or artist.";

export function parseLink(input: string): ParsedLink {
  const raw = (input || "").trim();
  if (!raw) throw new UserError("Paste a Spotify or Apple Music link.");

  const uri = raw.match(/^spotify:(track|album|playlist|artist|episode):([A-Za-z0-9]{22})$/);
  if (uri) {
    if (uri[1] !== "track") throw new UserError(SINGLE_SONG);
    return { platform: "spotify", id: uri[2] };
  }

  // People often paste "Song by Artist https://..." from share sheets.
  const found = raw.match(/https?:\/\/[^\s<>"]+/);
  let url: URL;
  try {
    url = new URL(found ? found[0] : raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    throw new UserError("That doesn't look like a link. Paste a Spotify or Apple Music song link.");
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "open.spotify.com" || host === "play.spotify.com") {
    const p = parts[0]?.startsWith("intl-") ? parts.slice(1) : parts;
    const kind = p[0] === "embed" ? p[1] : p[0];
    const id = p[0] === "embed" ? p[2] : p[1];
    if (kind !== "track") throw new UserError(kind ? SINGLE_SONG : "That Spotify link doesn't point to a song.");
    if (!id || !/^[A-Za-z0-9]{22}$/.test(id)) throw new UserError("That Spotify link looks incomplete.");
    return { platform: "spotify", id };
  }
  if (host === "spotify.link" || host === "spotify.app.link") {
    return { platform: "spotify-short", url: url.toString() };
  }

  if (host === "music.apple.com" || host === "geo.music.apple.com" || host === "itunes.apple.com") {
    const country = /^[a-z]{2}$/.test(parts[0] || "") ? parts[0] : "us";
    const p = country === parts[0] ? parts.slice(1) : parts;
    const kind = p[0];
    const i = url.searchParams.get("i");
    if (kind === "album" && i && /^\d+$/.test(i)) return { platform: "apple", id: i, country };
    if (kind === "song") {
      const id = [...p].reverse().find(s => /^\d+$/.test(s));
      if (id) return { platform: "apple", id, country };
    }
    if (kind === "album" || kind === "playlist" || kind === "artist" || kind === "music-video") {
      throw new UserError(SINGLE_SONG);
    }
    throw new UserError("That Apple Music link doesn't point to a song.");
  }

  throw new UserError("Only Spotify and Apple Music song links are supported.");
}

// ---------------------------------------------------------------- types

export type Track = {
  title: string;
  artist: string;
  artists: string[];
  album: string | null;
  releaseDate: string | null;
  durationMs: number | null;
  explicit: boolean;
  artwork: string | null;
  genre: string | null;
};

export type Preview = { source: "apple" | "spotify" | "deezer"; url: string; codec: "aac" | "mp3" };

export type Catalog = {
  source: "apple";
  artistName: string;
  releases: number;
  tracks: number;
  capped: boolean;
  firstRelease: string | null;
  lastRelease: string | null;
  releasesLastYear: number;
  tracksLastYear: number;
  tracksPerMonth: number;
  medianGapDays: number | null;
  genres: string[];
};

type AppleSong = {
  wrapperType: string;
  kind?: string;
  trackId: number;
  artistId: number;
  trackName: string;
  artistName: string;
  collectionName?: string;
  releaseDate?: string;
  trackTimeMillis?: number;
  trackExplicitness?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  primaryGenreName?: string;
  trackViewUrl?: string;
};

// ---------------------------------------------------------------- helpers

async function getJson(f: Fetch, url: string): Promise<any> {
  const r = await f(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return await r.json();
}

export function normalise(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\((feat|ft|with)\.?[^)]*\)|\[(feat|ft|with)\.?[^\]]*\]/g, "")
    .replace(/\s-\s.*(remaster|version|edit|mix|live|mono|stereo).*$/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// How well a catalogue result matches the track we're looking for (0..1).
export function matchScore(
  want: { title: string; artists: string[]; durationMs: number | null },
  got: { title: string; artist: string; durationMs: number | null },
): number {
  const wt = normalise(want.title), gt = normalise(got.title);
  const title = wt === gt ? 1 : wt && gt && (gt.startsWith(wt) || wt.startsWith(gt)) ? 0.7 : 0;
  const ga = normalise(got.artist);
  const artist = want.artists.some(a => normalise(a) === ga) ? 1
    : want.artists.some(a => { const n = normalise(a); return n && (ga.includes(n) || n.includes(ga)); }) ? 0.7 : 0;
  let dur = 0.5;
  if (want.durationMs && got.durationMs) {
    const d = Math.abs(want.durationMs - got.durationMs);
    dur = d <= 3000 ? 1 : d <= 8000 ? 0.6 : 0;
  }
  if (!title || !artist) return 0;
  return 0.45 * title + 0.35 * artist + 0.2 * dur;
}

const bigArtwork = (u?: string) => (u ? u.replace(/\/\d+x\d+bb\./, "/600x600bb.") : null);

// ---------------------------------------------------------------- Spotify

export function parseSpotifyEmbed(html: string) {
  const m = html.match(/<script[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Spotify page format changed");
  const data = JSON.parse(m[1]);
  const e = data?.props?.pageProps?.state?.data?.entity;
  if (!e || e.type !== "track") throw new Error("Spotify track not found in page");
  const images: { url: string; maxWidth?: number }[] = e.visualIdentity?.image || e.coverArt?.sources || [];
  const art = [...images].sort((a, b) => (b.maxWidth || 0) - (a.maxWidth || 0))[0]?.url || null;
  const artists: string[] = (e.artists || []).map((a: { name: string }) => a.name).filter(Boolean);
  return {
    track: {
      title: e.name || e.title,
      artist: artists.join(", "),
      artists,
      album: null,
      releaseDate: e.releaseDate?.isoString?.slice(0, 10) || null,
      durationMs: typeof e.duration === "number" ? e.duration : null,
      explicit: !!e.isExplicit,
      artwork: art,
      genre: null,
    } as Track,
    previewUrl: (e.audioPreview?.url as string) || null,
  };
}

async function resolveSpotify(f: Fetch, id: string) {
  const r = await f(`https://open.spotify.com/embed/track/${id}`, { headers: { "user-agent": UA, "accept-language": "en" } });
  if (r.status === 404) throw new UserError("Spotify couldn't find that song. Check the link.", 404);
  if (!r.ok) throw new Error(`Spotify answered ${r.status}`);
  return parseSpotifyEmbed(await r.text());
}

async function expandSpotifyShort(f: Fetch, url: string): Promise<string> {
  const r = await f(url, { headers: { "user-agent": UA }, redirect: "follow" });
  const finalUrl = r.url || url;
  if (/open\.spotify\.com\/(intl-[a-z-]+\/)?track\//.test(finalUrl)) return finalUrl;
  const body = await r.text();
  const m = body.match(/https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/[A-Za-z0-9]{22}/);
  if (m) return m[0];
  throw new UserError("Couldn't open that Spotify short link. Copy the song link from Spotify instead.");
}

// ---------------------------------------------------------------- Apple

async function appleLookup(f: Fetch, id: string, country: string): Promise<AppleSong | null> {
  const j = await getJson(f, `https://itunes.apple.com/lookup?id=${id}&country=${country}&entity=song`);
  const songs = (j.results || []).filter((x: AppleSong) => x.wrapperType === "track" && x.kind === "song");
  return songs.find((x: AppleSong) => String(x.trackId) === id) || songs[0] || null;
}

async function appleSearch(f: Fetch, want: Track, country = "us"): Promise<AppleSong | null> {
  const term = encodeURIComponent(`${want.artists[0] || want.artist} ${want.title}`.slice(0, 200));
  const j = await getJson(f, `https://itunes.apple.com/search?term=${term}&entity=song&limit=15&country=${country}`);
  let best: AppleSong | null = null, bestScore = 0.6;
  for (const s of (j.results || []) as AppleSong[]) {
    if (s.kind !== "song") continue;
    const sc = matchScore(want, { title: s.trackName, artist: s.artistName, durationMs: s.trackTimeMillis ?? null });
    if (sc > bestScore) { best = s; bestScore = sc; }
  }
  return best;
}

function appleTrack(s: AppleSong): Track {
  return {
    title: s.trackName,
    artist: s.artistName,
    artists: [s.artistName],
    album: s.collectionName || null,
    releaseDate: s.releaseDate?.slice(0, 10) || null,
    durationMs: s.trackTimeMillis ?? null,
    explicit: s.trackExplicitness === "explicit",
    artwork: bigArtwork(s.artworkUrl100),
    genre: s.primaryGenreName || null,
  };
}

export function catalogStats(
  artistName: string,
  albums: { releaseDate?: string; trackCount?: number; primaryGenreName?: string }[],
  now = Date.now(),
  capped = false,
): Catalog | null {
  const rel = albums
    .filter(a => a.releaseDate)
    .map(a => ({ t: Date.parse(a.releaseDate as string), n: a.trackCount || 1, g: a.primaryGenreName || "" }))
    .filter(a => Number.isFinite(a.t) && a.t <= now + 86400000 * 31)
    .sort((a, b) => a.t - b.t);
  if (!rel.length) return null;
  const year = now - 365 * 86400000;
  const tracks = rel.reduce((s, a) => s + a.n, 0);
  const first = rel[0].t, last = rel[rel.length - 1].t;
  const months = Math.max(1, (Math.max(last, Math.min(now, last + 30 * 86400000)) - first) / (30.44 * 86400000));
  const gaps: number[] = [];
  for (let i = 1; i < rel.length; i++) gaps.push((rel[i].t - rel[i - 1].t) / 86400000);
  gaps.sort((a, b) => a - b);
  const genres = [...new Set(rel.map(a => a.g).filter(Boolean))];
  return {
    source: "apple",
    artistName,
    releases: rel.length,
    tracks,
    capped,
    firstRelease: new Date(first).toISOString().slice(0, 10),
    lastRelease: new Date(last).toISOString().slice(0, 10),
    releasesLastYear: rel.filter(a => a.t >= year).length,
    tracksLastYear: rel.filter(a => a.t >= year).reduce((s, a) => s + a.n, 0),
    tracksPerMonth: Math.round((tracks / months) * 10) / 10,
    medianGapDays: gaps.length ? Math.round(gaps[gaps.length >> 1]) : null,
    genres,
  };
}

async function appleCatalog(f: Fetch, artistId: number, artistName: string, country: string) {
  const j = await getJson(f, `https://itunes.apple.com/lookup?id=${artistId}&entity=album&limit=200&sort=recent&country=${country}`);
  const albums = (j.results || []).filter((x: { wrapperType: string }) => x.wrapperType === "collection");
  return catalogStats(artistName, albums, Date.now(), albums.length >= 200);
}

// ---------------------------------------------------------------- Deezer

type DeezerTrack = { id: number; title: string; duration: number; preview?: string; link: string; artist: { id: number; name: string } };

async function deezerSearch(f: Fetch, want: Track): Promise<DeezerTrack | null> {
  const q = encodeURIComponent(`artist:"${want.artists[0] || want.artist}" track:"${want.title}"`);
  const j = await getJson(f, `https://api.deezer.com/search?q=${q}&limit=10`);
  let best: DeezerTrack | null = null, bestScore = 0.6;
  for (const t of (j.data || []) as DeezerTrack[]) {
    const sc = matchScore(want, { title: t.title, artist: t.artist?.name, durationMs: t.duration ? t.duration * 1000 : null });
    if (sc > bestScore) { best = t; bestScore = sc; }
  }
  return best;
}

// ---------------------------------------------------------------- resolve

export async function resolve(f: Fetch, input: string) {
  let link = parseLink(input);
  if (link.platform === "spotify-short") link = parseLink(await expandSpotifyShort(f, link.url));

  const notes: string[] = [];
  const previews: Preview[] = [];
  const links: Record<string, string> = {};
  let track: Track;
  let apple: AppleSong | null = null;
  let country = "us";

  if (link.platform === "spotify") {
    const sp = await resolveSpotify(f, link.id);
    track = sp.track;
    links.spotify = `https://open.spotify.com/track/${link.id}`;
    if (sp.previewUrl) previews.push({ source: "spotify", url: sp.previewUrl, codec: "mp3" });
    apple = await appleSearch(f, track).catch(() => null);
    if (apple) {
      track.album = apple.collectionName || null;
      track.genre = apple.primaryGenreName || null;
      if (apple.trackViewUrl) links.apple = apple.trackViewUrl.replace(/[?&]uo=\d+/, "");
    }
  } else if (link.platform === "apple") {
    country = link.country;
    apple = await appleLookup(f, link.id, country);
    if (!apple) throw new UserError("Apple Music couldn't find that song. It may not be available in this country.", 404);
    track = appleTrack(apple);
    if (apple.trackViewUrl) links.apple = apple.trackViewUrl.replace(/[?&]uo=\d+/, "");
  } else {
    throw new UserError("Only Spotify and Apple Music song links are supported.");
  }

  if (apple?.previewUrl) {
    // Apple's previews are 256 kbps AAC, the cleanest of the three for analysis.
    previews.unshift({ source: "apple", url: apple.previewUrl, codec: "aac" });
  }

  const [deezer, catalog] = await Promise.all([
    deezerSearch(f, track).catch(() => null),
    apple ? appleCatalog(f, apple.artistId, apple.artistName, country).catch(() => null) : Promise.resolve(null),
  ]);
  if (deezer) {
    links.deezer = deezer.link;
    if (deezer.preview) previews.push({ source: "deezer", url: deezer.preview, codec: "mp3" });
  }
  if (!apple) notes.push("This song wasn't found on Apple Music, so release history isn't available.");
  if (!previews.length) notes.push("None of the services offer a preview of this song, so the audio can't be checked.");

  return {
    ok: true,
    source: { platform: link.platform, id: link.id },
    track,
    links,
    previews,
    catalog,
    notes,
  };
}

// ---------------------------------------------------------------- audio proxy

export function allowedAudio(u: string): URL | null {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return null;
    return AUDIO_HOSTS.some(re => re.test(url.hostname)) ? url : null;
  } catch {
    return null;
  }
}

async function proxyAudio(f: Fetch, target: string): Promise<Response> {
  const url = allowedAudio(target);
  if (!url) return json({ ok: false, error: "That audio host isn't allowed." }, 400);
  const r = await f(url.toString(), { headers: { "user-agent": UA } });
  if (!r.ok || !r.body) return json({ ok: false, error: `The preview couldn't be fetched (${r.status}).` }, 502);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_AUDIO_BYTES) return json({ ok: false, error: "That preview is too large." }, 413);
  return new Response(r.body, {
    status: 200,
    headers: {
      ...CORS,
      "content-type": r.headers.get("content-type") || "audio/mpeg",
      ...(len ? { "content-length": String(len) } : {}),
      "cache-control": "public, max-age=3600",
    },
  });
}

// ---------------------------------------------------------------- entry

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", ...extra },
  });
}

export async function handle(req: Request, f: Fetch = fetch): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const u = new URL(req.url);
  try {
    const audio = u.searchParams.get("audio");
    if (audio) return await proxyAudio(f, audio);

    let link = u.searchParams.get("url") || "";
    if (!link && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      link = typeof body?.url === "string" ? body.url : "";
    }
    const result = await resolve(f, link);
    return json(result, 200, { "cache-control": "public, max-age=600" });
  } catch (e) {
    if (e instanceof UserError) return json({ ok: false, error: e.message }, e.status);
    console.error(e);
    return json({ ok: false, error: "Couldn't reach the music services just now. Try again in a moment." }, 502);
  }
}
