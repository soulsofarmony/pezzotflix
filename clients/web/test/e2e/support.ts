// Shared helpers of the e2e specs: profile setup through the API, item lookup, and the player state the page
// exposes as data-* attributes (PlayerPage). The specs need the Compose stack with the samples ingested.
import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page } from '@playwright/test';

export const PROFILE_NAME = process.env.PZF_E2E_PROFILE ?? 'E2E';
export const API = '/video/api/v1';

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** One S2 regression case (doc 05 §7.8.1), mapped to an item of the test library. */
export interface SampleCase {
  /** Item title as the catalog shows it (search query). */
  title: string;
  /** Expected delivery mode, e.g. direct_stream. */
  mode?: string;
  /** Substrings expected in stream.mimeType (codecs of the stream as served). */
  codecs?: string[];
  /** Subtitle track to select, by language (ISO 639-2), for the PGS cases. */
  subtitleLanguage?: string;
  /** A time (original timeline, ms) with a PGS cue on screen. */
  cueAtMs?: number;
  /**
   * Codec strings (RFC 6381) the browser must decode for this case, e.g. "hvc1.2.4.L153.B0" for an HEVC source;
   * on a browser without them the case is skipped (Edge without the HEVC Video Extensions, Chromium's headless shell).
   */
  requires?: string[];
}

export type SampleId =
  | 'h1'
  | 'h2'
  | 'h6'
  | 'c1'
  | 'c4'
  | 'c7'
  | 's3'
  | 'main'
  | 'directStream'
  | 'farSeek'
  | 'replan'
  // Stack smoke (smoke.spec.ts): a file that Direct Plays for a client with MKV, embedded PGS and text subtitles,
  // a source above 720p and up to 1080p for the Transcode.
  | 'directPlay'
  | 'pgsSubtitle'
  | 'textSubtitle'
  | 'transcode';

/** A file of the "Da verificare" queue that the stack setup resolves by hand (create_manual), so its item exists. */
export interface ManualMatch {
  /** Path of the file inside its library root, as the case shows it. */
  relPath: string;
  kind: 'movie' | 'series' | 'season' | 'episode' | 'extra';
  title: string;
  year?: number | null;
}

export type SamplesFile = Partial<Record<SampleId, SampleCase>> & { manualMatches?: ManualMatch[] };

/**
 * Samples come from a JSON file (PZF_E2E_SAMPLES, see samples.example.json): the test library depends on the
 * machine, so titles are not hard-coded. A case without an entry is skipped with its reason.
 */
export function loadSamples(): SamplesFile {
  const path = process.env.PZF_E2E_SAMPLES;
  if (!path) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as SamplesFile;
}

export const samples = loadSamples();

export function sampleOrSkip(test: { skip: (cond: boolean, reason: string) => void }, id: SampleId): SampleCase {
  const s = samples[id];
  test.skip(!s, `sample "${id}" not configured: set PZF_E2E_SAMPLES to a JSON file like test/e2e/samples.example.json`);
  return s as SampleCase;
}

/**
 * Skips the case when the page's browser does not decode every codec the sample requires, asked as the player asks
 * (MSE type, then decodingInfo). Firefox answers yes to HEVC until it knows its decoders, then no (measured on
 * Firefox 157 without the HEVC extension): it is asked for 2 s, and one no is enough.
 */
export async function skipUnlessDecodes(test: { skip: (cond: boolean, reason: string) => void }, page: Page, sample: SampleCase): Promise<void> {
  if (!sample.requires?.length) return;
  const missing = await page.evaluate(async (codecs) => {
    const type = (c: string) => `video/mp4; codecs="${c}"`;
    const decodes = async (c: string) => {
      if (!(window.MediaSource?.isTypeSupported(type(c)) ?? false)) return false;
      const info = await navigator.mediaCapabilities?.decodingInfo({ type: 'media-source', video: { contentType: type(c), width: 1920, height: 1080, framerate: 24, bitrate: 20e6 } });
      return info?.supported ?? true;
    };
    const no = new Set<string>();
    const until = performance.now() + (navigator.userAgent.includes('Firefox/') ? 2_000 : 0);
    for (;;) {
      for (const c of codecs) if (!(await decodes(c))) no.add(c);
      if (no.size === codecs.length || performance.now() >= until) return [...no];
      await new Promise((r) => setTimeout(r, 100));
    }
  }, sample.requires);
  test.skip(missing.length > 0, `"${sample.title}": this browser does not decode ${missing.join(', ')}`);
}

interface Profile {
  id: string;
  name: string;
}

/**
 * Creates the e2e profile if missing and returns its token. It also closes the profile's sessions left open by an
 * earlier test (one that failed before pagehide), so the one streaming slot of the MVP is free.
 */
export async function ensureProfile(request: APIRequestContext): Promise<{ id: string; token: string }> {
  const list = (await (await request.get(`${API}/profiles`)).json()) as { profiles: Profile[] };
  let p = list.profiles.find((x) => x.name === PROFILE_NAME);
  if (!p) {
    const res = await request.post(`${API}/profiles`, { data: { name: PROFILE_NAME } });
    expect(res.ok(), await res.text()).toBe(true);
    p = (await res.json()) as Profile;
  }
  const sel = (await (await request.post(`${API}/profiles/${p.id}/select`)).json()) as { profileToken: string };
  const sessions = (await (await request.get(`${API}/playback/sessions`, { headers: bearer(sel.profileToken) })).json()) as { sessions: { sessionId: string; profileId: string }[] };
  for (const s of sessions.sessions) {
    if (s.profileId === p.id) await request.delete(`${API}/playback/sessions/${s.sessionId}`, { headers: bearer(sel.profileToken) });
  }
  return { id: p.id, token: sel.profileToken };
}

/** Selects the e2e profile in the page the way the app stores it (localStorage), then opens a path. */
export async function openAs(page: Page, request: APIRequestContext, path: string): Promise<{ token: string }> {
  const { id, token } = await ensureProfile(request);
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    ['pezzotflix.profile', JSON.stringify({ id, name: PROFILE_NAME, token })] as const,
  );
  await page.goto(path);
  return { token };
}

export async function findItemId(request: APIRequestContext, token: string, title: string): Promise<string | null> {
  const res = await request.get(`${API}/search`, { params: { q: title }, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok()) return null;
  const body = (await res.json()) as { items: { id: string; title: string }[] };
  return (body.items.find((i) => i.title === title) ?? body.items[0])?.id ?? null;
}

export async function clearProgress(request: APIRequestContext, token: string, itemId: string): Promise<void> {
  await request.delete(`${API}/items/${itemId}/progress`, { headers: { Authorization: `Bearer ${token}` } });
}

// ---------------------------------------------------------------- player

export const player = (page: Page) => page.locator('[data-phase]');

export async function phase(page: Page): Promise<string | null> {
  return player(page).getAttribute('data-phase');
}

export async function positionMs(page: Page): Promise<number> {
  return Number(await player(page).getAttribute('data-position-ms'));
}

/** Waits until the player is ready and the video shows frames that advance. */
export async function waitForPlayback(page: Page, minSeconds = 1): Promise<void> {
  await expect(player(page)).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 });
  await page.waitForFunction(
    (min) => {
      const v = document.querySelector('video');
      return !!v && v.readyState >= 2 && !v.paused && v.currentTime > 0 && (v.getVideoPlaybackQuality?.().totalVideoFrames ?? 1) > 0 && v.played.length > 0 && v.played.end(v.played.length - 1) - v.played.start(0) >= min;
    },
    minSeconds,
    { timeout: 60_000 },
  );
}

/** Media facts the S2 regression reads: decoded frames, dropped frames, audio decoded (Chromium). */
export function mediaFacts(page: Page) {
  return page.evaluate(() => {
    const v: (HTMLVideoElement & { webkitAudioDecodedByteCount?: number }) | null = document.querySelector('video');
    if (!v) return null;
    const q = v.getVideoPlaybackQuality();
    return { currentTime: v.currentTime, frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, audioBytes: v.webkitAudioDecodedByteCount ?? null, width: v.videoWidth, height: v.videoHeight, error: v.error?.code ?? null };
  });
}

/**
 * True when the libpgs canvas next to the video has visible pixels. libpgs draws from a worker (the canvas has
 * transferred its control to an OffscreenCanvas), so getContext fails on it: its last frame is read through
 * createImageBitmap instead.
 */
export function pgsCanvasHasPixels(page: Page) {
  return page.evaluate(async () => {
    const canvas = document.querySelector('video')?.parentElement?.querySelector('canvas');
    if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
    const bitmap = await createImageBitmap(canvas);
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = copy.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
    for (let i = 3; i < data.length; i += 4 * 64) if ((data[i] ?? 0) > 0) return true;
    return false;
  });
}
