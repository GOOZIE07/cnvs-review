# CNVS AI Music

Paste a Spotify or Apple Music song link and get an estimate of whether the song was made with AI.

## How it works

1. **Find the song.** The `ai-music` Supabase Edge Function (`supabase/functions/ai-music`) reads the link, looks the song up (Spotify's public embed page, Apple's iTunes Search API, Deezer's public API) and returns the track details, 30-second preview URLs and the artist's release history from Apple Music. It needs no API keys.
2. **Scan the audio.** The browser downloads a preview through the same function, which only forwards audio from Apple, Spotify and Deezer preview hosts. `analyzer.js` then looks for the evenly spaced spectral lines that AI generators' upsampling layers leave behind. This runs in a Web Worker on the visitor's device.
3. **Check the release pattern.** `verdict.js` flags release volume, rhythm and genre spread typical of mass-produced catalogues, and combines both signals into a 0–100 score and a verdict.

## Files

| Path | What |
| --- | --- |
| `ai-music/index.html`, `app.js` | The page |
| `ai-music/analyzer.js`, `worker.js` | Audio fingerprint analysis |
| `ai-music/verdict.js` | Scoring and result copy |
| `supabase/functions/ai-music/` | Backend: link lookup and preview proxy |
| `tests/` | Unit tests (`node --test tests/*.test.*`, Node 22.18+) |

## Deploy

**Backend.** Deploy the function to the CANVAS Supabase project with JWT verification off, so the public page can call it:

```sh
supabase functions deploy ai-music --project-ref nqpbthaweigsrpdyhryr --no-verify-jwt
```

**Page.** The `ai-music/` folder is static. Host it anywhere (GitHub Pages, Netlify). The function URL is set in the `cnvs-api` meta tag in `index.html`.

## Accuracy and limits

- The audio thresholds were tuned so that none of 15 human recordings scored above 0.04, as originals or re-encoded like the services' previews (MP3 96 kbps, AAC 256 kbps). Output from a GAN music generator (Musika) scored 1.00, and decoder-style lines added to real recordings were caught down to 50–70 dB below the music in most mixes.
- It has **not** yet been checked against a labelled set of Suno and Udio songs. Do that before quoting accuracy numbers.
- Autoencoder reconstructions (Encodec, LAC) that had been saved as MP3 were not detected.
- Heavy processing, re-recording, or songs that only use AI for part of the work can hide the fingerprint.
- The release-pattern signal can flag prolific human producers. On its own it can raise the score to 50 ("Some AI signals") but never to "Strong".
- The Spotify lookup reads Spotify's embed page, which is not a documented API and may change.
