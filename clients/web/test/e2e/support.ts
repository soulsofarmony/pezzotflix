// Shared helpers of the e2e specs: profile setup through the API, item lookup, and the player state the page
// exposes as data-* attributes (PlayerPage). The specs need the Compose stack with the samples ingested.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, expect, type Page } from '@playwright/test';
import type { components } from '../../src/api/schema.d.ts';

export type Session = components['schemas']['PlaybackSession'];

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

type Skipper = { skip: (cond: boolean, reason: string) => void };

/** The gitignored samples file of this machine, used when PZF_E2E_SAMPLES is not set. */
const DEFAULT_SAMPLES = fileURLToPath(new URL('./samples.json', import.meta.url));

/**
 * Samples come from a JSON file (see samples.example.json): the test library depends on the machine, so titles are
 * not hard-coded. PZF_E2E_SAMPLES names it; otherwise test/e2e/samples.json is used when it exists.
 */
export function loadSamples(): { samples: SamplesFile; source: string | null } {
  const path = process.env.PZF_E2E_SAMPLES || (existsSync(DEFAULT_SAMPLES) ? DEFAULT_SAMPLES : null);
  if (!path) return { samples: {}, source: null };
  return { samples: JSON.parse(readFileSync(path, 'utf8')) as SamplesFile, source: path };
}

const loaded = loadSamples();
export const samples = loaded.samples;

/**
 * Cases allowed to skip when their sample is missing from the samples file or from the catalog: PZF_E2E_ALLOW_SKIP=1
 * for all of them, or a comma list of sample ids (e.g. "c4,c7") for a library that lacks those files. Otherwise a
 * missing sample fails: a gate that skips everything would pass while testing nothing.
 */
const ALLOWED_SKIPS = new Set((process.env.PZF_E2E_ALLOW_SKIP ?? '').split(',').map((s) => s.trim()).filter(Boolean));

export function skipAllowed(id: SampleId): boolean {
  return ALLOWED_SKIPS.has('1') || ALLOWED_SKIPS.has(id);
}

/** Why a case has no sample, as the error (or skip reason) says it. */
export function missingSampleReason(id: SampleId): string {
  return loaded.source
    ? `sample "${id}" is not in ${loaded.source}`
    : `no samples file: create test/e2e/samples.json from samples.example.json, or set PZF_E2E_SAMPLES (sample "${id}")`;
}

export function missingSampleError(id: SampleId): Error {
  return new Error(`${missingSampleReason(id)}. Add it, or allow the skip with PZF_E2E_ALLOW_SKIP=${id}`);
}

/** The case's sample. Missing: a failure, or a skip when PZF_E2E_ALLOW_SKIP allows it. */
export function requireSample(test: Skipper, id: SampleId): SampleCase {
  const s = samples[id];
  if (s) return s;
  test.skip(skipAllowed(id), missingSampleReason(id));
  throw missingSampleError(id);
}

/** The id of the sample's item, by exact title. Missing: a failure, or a skip when PZF_E2E_ALLOW_SKIP allows it. */
export async function requireItem(test: Skipper, request: APIRequestContext, token: string, id: SampleId, sample: SampleCase): Promise<string> {
  const itemId = await findItemId(request, token, sample.title);
  if (itemId) return itemId;
  const reason = `sample "${id}": no item titled exactly "${sample.title}" in the catalog`;
  test.skip(skipAllowed(id), reason);
  throw new Error(`${reason}. Fix the title in the samples file, or allow the skip with PZF_E2E_ALLOW_SKIP=${id}`);
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
    // Firefox without a platform HEVC decoder answers "supported" until its decoder check settles: about 0.5 s on
    // an idle host, more than 2 s under the load of a full run (2026-11-06), so a "no" in this window wins.
    const until = performance.now() + (navigator.userAgent.includes('Firefox/') ? 5_000 : 0);
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

/**
 * The item titled exactly `title`, or null. Never the first search hit: a near match would test another file.
 * Two items with that exact title fail, so a sample never picks one at random.
 */
export async function findItemId(request: APIRequestContext, token: string, title: string): Promise<string | null> {
  const res = await request.get(`${API}/search`, { params: { q: title, limit: 200 }, headers: bearer(token) });
  expect(res.ok(), `search "${title}": ${res.status()} ${await res.text()}`).toBe(true);
  const body = (await res.json()) as { items: { id: string; title: string; kind: string }[] };
  const exact = body.items.filter((i) => i.title === title);
  expect(exact.length, `more than one item titled "${title}": ${JSON.stringify(exact)}`).toBeLessThanOrEqual(1);
  return exact[0]?.id ?? null;
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

/** The video element's currentTime (player timeline, seconds). */
export function videoTime(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
}

/**
 * Waits until the player is ready and the video has played `minSeconds` with frames that advance. With `fromS` (a
 * player time, e.g. where a seek landed) the seconds count from there, in one played stretch, and only frames
 * decoded from this call on count: playback from before a seek does not satisfy it.
 */
export async function waitForPlayback(page: Page, minSeconds = 1, fromS?: number): Promise<void> {
  await expect(player(page)).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 });
  const frames0 = fromS === undefined ? 0 : await page.evaluate(() => document.querySelector('video')?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0);
  await page.waitForFunction(
    ({ min, from, frames0 }) => {
      const v = document.querySelector('video');
      if (!v || v.readyState < 2 || v.paused || v.seeking || v.played.length === 0) return false;
      if ((v.getVideoPlaybackQuality?.().totalVideoFrames ?? frames0 + 1) <= frames0) return false;
      if (from === null) return v.currentTime > 0 && v.played.end(v.played.length - 1) - v.played.start(0) >= min;
      for (let i = 0; i < v.played.length; i++) {
        // A small tolerance below: the seek may land a few frames before the requested time.
        if (v.played.start(i) <= from + 0.25 && v.played.end(i) >= from + min) return true;
      }
      return false;
    },
    { min: minSeconds, from: fromS ?? null, frames0 },
    { timeout: 60_000 },
  );
}

/** Sessions the page got from the server (StartPlayback, and the re-plans and changes that answer one). */
const SESSION_RESPONSE = /\/playback\/sessions(\/[^/]+\/(failure|tracks|version))?$/;

/** Records the latest PlaybackSession the page received; call before opening the player. */
export function watchSession(page: Page): () => Session | null {
  let latest: Session | null = null;
  page.on('response', (r) => {
    if (r.request().method() !== 'POST' || !r.ok() || !SESSION_RESPONSE.test(new URL(r.url()).pathname)) return;
    r.json().then(
      (s: Session) => {
        if (s?.sessionId) latest = s;
      },
      () => undefined,
    );
  });
  return () => latest;
}

/**
 * Selects, in the player's track menu, the session's subtitle track in `language` (ISO 639-2) and of `kind`, then
 * checks that the player took that track. Returns its id.
 */
export async function selectSubtitle(page: Page, session: () => Session | null, language: string, kind?: 'image' | 'text'): Promise<string> {
  await expect.poll(() => session() !== null, { message: 'no PlaybackSession seen by the page' }).toBe(true);
  const subs = session()?.tracks.subtitles ?? [];
  const index = subs.findIndex((t) => t.language === language && (!kind || t.subtitleKind === kind));
  const seen = JSON.stringify(subs.map((t) => ({ id: t.id, language: t.language, kind: t.subtitleKind })));
  expect(index, `no ${kind ?? ''} subtitle track in "${language}" in the session: ${seen}`).toBeGreaterThanOrEqual(0);
  const trackId = subs[index]?.id ?? '';
  await page.getByRole('button', { name: 'Audio e sottotitoli' }).click();
  // The menu lists "Nessuno", then the session's subtitle tracks in their order (TrackMenu).
  await page.getByRole('group', { name: 'Sottotitoli' }).getByRole('radio').nth(index + 1).check();
  await page.keyboard.press('Escape');
  await expect(player(page)).toHaveAttribute('data-subtitle', trackId);
  return trackId;
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
