// End-to-end smoke of the Compose stack through the gateway (doc 06 §4), API only: StartPlayback for each delivery
// mode, then the first data-plane bytes (a 206 Range, or the HLS init and first media segment), the extracted
// embedded subtitles, and the progress saved by ReportProgress and StopPlayback. Runs after stack.setup.ts.
import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';
import type { components } from '../../src/api/schema.d.ts';
import { API, bearer, clearProgress, ensureProfile, findItemId, type SampleCase, sampleOrSkip } from './support.ts';

type Caps = components['schemas']['ClientCapabilities'];
type Session = components['schemas']['PlaybackSession'];
type SessionTrack = Session['tracks']['subtitles'][number];
type ItemDetail = components['schemas']['ItemDetail'];

/** A desktop browser as the web client declares it on Windows with HEVC (S2): no MKV, PGS rendered client-side. */
const BROWSER: Caps = {
  device: { class: 'desktop', model: 'Smoke; Windows 11', app: 'pezzotflix-smoke' },
  containers: ['mp4'],
  audioTrackSelection: false,
  protocols: ['progressive', 'hls-fmp4'],
  video: [
    { codec: 'h264', profiles: ['high'], maxBitDepth: 8, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 },
    { codec: 'hevc', profiles: ['main', 'main10'], maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 },
  ],
  hdr: ['HDR10', 'HLG'],
  displayHdr: false,
  audio: [
    { codec: 'flac', maxChannels: 8, mode: 'decode' },
    { codec: 'opus', maxChannels: 6, mode: 'decode' },
    { codec: 'aac', maxChannels: 6, mode: 'decode' },
  ],
  subtitles: { text: ['webvtt'], image: ['pgs'], ass: false },
};
/** The same browser with MKV playable directly. */
const BROWSER_MKV: Caps = { ...BROWSER, containers: ['mp4', 'mkv'] };
/** A small screen: H.264 up to 720p only, so a 1080p source needs the software Transcode (P2). */
const SMALL_SCREEN: Caps = {
  ...BROWSER,
  device: { class: 'mobile', model: 'Smoke 720p', app: 'pezzotflix-smoke' },
  video: [{ codec: 'h264', profiles: ['high'], maxBitDepth: 8, maxWidth: 1280, maxHeight: 720, maxFrameRate: 60 }],
  hdr: [],
};

const RETRY_MAX_MS = 90_000;
/** A position the server keeps as resumable: above its 30 s minimum (profiles RESUME_MIN_POSITION_MS). */
const RESUME_AT_MS = 45_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Repeats a request while it answers 503 (STREAM_PREPARING, or a segment not ready yet), after Retry-After. */
async function retrying503(send: () => Promise<APIResponse>): Promise<APIResponse> {
  const deadline = Date.now() + RETRY_MAX_MS;
  for (;;) {
    const res = await send();
    if (res.status() !== 503 || Date.now() > deadline) return res;
    const after = Number(res.headers()['retry-after'] ?? '1');
    await sleep(Math.max(250, Math.min(5_000, (Number.isFinite(after) ? after : 1) * 1_000)));
  }
}

const absolute = (url: string, base: string) => new URL(url, base).toString();

function boxTypes(bytes: Buffer, limit = 8): string[] {
  const out: string[] = [];
  let at = 0;
  while (at + 8 <= bytes.length && out.length < limit) {
    const size = bytes.readUInt32BE(at);
    out.push(bytes.toString('latin1', at + 4, at + 8));
    if (size < 8) break;
    at += size;
  }
  return out;
}

class Smoke {
  readonly request: APIRequestContext;
  readonly token: string;
  readonly baseURL: string;

  constructor(request: APIRequestContext, token: string, baseURL: string) {
    this.request = request;
    this.token = token;
    this.baseURL = baseURL;
  }

  async item(title: string): Promise<string> {
    const id = await findItemId(this.request, this.token, title);
    expect(id, `"${title}" is not in the catalog`).not.toBeNull();
    return id ?? '';
  }

  async detail(itemId: string): Promise<ItemDetail> {
    const res = await this.request.get(`${API}/items/${itemId}`, { headers: bearer(this.token) });
    expect(res.ok(), await res.text()).toBe(true);
    return (await res.json()) as ItemDetail;
  }

  async start(body: components['schemas']['StartPlaybackRequest']): Promise<{ session: Session; ms: number }> {
    const t0 = Date.now();
    const res = await retrying503(() => this.request.post(`${API}/playback/sessions`, { headers: bearer(this.token), data: body }));
    expect(res.status(), await res.text()).toBe(201);
    return { session: (await res.json()) as Session, ms: Date.now() - t0 };
  }

  async progress(session: Session, positionMs: number): Promise<void> {
    const res = await this.request.post(`${API}/playback/sessions/${session.sessionId}/progress`, {
      headers: bearer(this.token),
      data: { positionMs, state: 'playing', clientTs: Date.now() },
    });
    expect(res.status()).toBe(204);
  }

  async stop(session: Session, positionMs: number): Promise<void> {
    const res = await this.request.post(`${API}/playback/sessions/${session.sessionId}/stop`, { headers: bearer(this.token), data: { positionMs } });
    expect(res.status()).toBe(204);
  }

  async get(url: string, headers: Record<string, string> = {}): Promise<APIResponse> {
    return retrying503(() => this.request.get(absolute(url, this.baseURL), { headers }));
  }

  /** HLS: multivariant → media playlist → init and first media segment; returns the time to the first segment. */
  async firstSegment(session: Session): Promise<{ ms: number; segmentBytes: number; segments: number }> {
    const t0 = Date.now();
    const mainUrl = absolute(session.stream.url, this.baseURL);
    const main = await this.get(mainUrl);
    expect(main.status()).toBe(200);
    expect(main.headers()['content-type']).toContain('mpegurl');
    const mediaUri = (await main.text()).split('\n').find((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(mediaUri, 'no media playlist in main.m3u8').toBeTruthy();
    const mediaUrl = absolute(mediaUri ?? '', mainUrl);
    const media = await (await this.get(mediaUrl)).text();
    const initUri = /#EXT-X-MAP:URI="([^"]+)"/.exec(media)?.[1];
    const segUris = media.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(initUri, 'no EXT-X-MAP in the media playlist').toBeTruthy();
    expect(segUris.length).toBeGreaterThan(0);

    const init = await this.get(absolute(initUri ?? '', mediaUrl));
    expect(init.status()).toBe(200);
    expect(boxTypes(await init.body())).toEqual(expect.arrayContaining(['ftyp', 'moov']));
    const seg = await this.get(absolute(segUris[0] ?? '', mediaUrl));
    expect(seg.status()).toBe(200);
    const segBody = await seg.body();
    expect(boxTypes(segBody)).toEqual(expect.arrayContaining(['moof', 'mdat']));
    return { ms: Date.now() - t0, segmentBytes: segBody.length, segments: segUris.length };
  }

  /** Direct Play: a 206 for a range at the start and one in the middle of the file. */
  async ranges(session: Session): Promise<{ ms: number; size: number }> {
    const t0 = Date.now();
    const first = await this.get(session.stream.url, { Range: 'bytes=0-65535' });
    expect(first.status()).toBe(206);
    expect((await first.body()).length).toBe(65_536);
    const size = Number(/\/(\d+)$/.exec(first.headers()['content-range'] ?? '')?.[1]);
    expect(size).toBeGreaterThan(65_536);
    const mid = Math.floor(size / 2);
    const middle = await this.get(session.stream.url, { Range: `bytes=${mid}-${mid + 1_048_575}` });
    expect(middle.status()).toBe(206);
    expect(middle.headers()['content-range']).toBe(`bytes ${mid}-${mid + 1_048_575}/${size}`);
    expect((await middle.body()).length).toBe(1_048_576);
    return { ms: Date.now() - t0, size };
  }

  /** Reads a subtitle track to the end of its first pass (a growing response ends there). */
  async subtitle(track: SessionTrack): Promise<{ ms: number; body: Buffer }> {
    expect(track.url, `track ${track.id} has no url`).toBeTruthy();
    const t0 = Date.now();
    const res = await this.get(track.url ?? '');
    expect([200, 206], `subtitle ${track.id}: ${res.status()}`).toContain(res.status());
    return { ms: Date.now() - t0, body: await res.body() };
  }
}

/** An embedded subtitle track of the item's first version, of one kind, preferably in a language. */
async function embeddedSubtitle(smoke: Smoke, itemId: string, kind: 'image' | 'text', language?: string): Promise<{ fileId: string; trackId: string }> {
  const version = (await smoke.detail(itemId)).versions[0];
  expect(version, 'the item has no version').toBeTruthy();
  const subs = (version?.tracks ?? []).filter((t) => t.type === 'subtitle' && !t.external && t.subtitleKind === kind);
  const track = subs.find((t) => !language || t.language === language) ?? subs[0];
  expect(track, `no embedded ${kind} subtitle track`).toBeTruthy();
  return { fileId: version?.fileId ?? '', trackId: track?.id ?? '' };
}

async function setupSmoke(request: APIRequestContext, sample: SampleCase): Promise<{ smoke: Smoke; itemId: string }> {
  // ensureProfile also closes the sessions an earlier run left open.
  const { token } = await ensureProfile(request);
  const smoke = new Smoke(request, token, test.info().project.use.baseURL ?? 'http://localhost:8080');
  const itemId = await smoke.item(sample.title);
  await clearProgress(request, token, itemId);
  return { smoke, itemId };
}

const note = (type: string, description: string) => test.info().annotations.push({ type, description });

test.describe.configure({ mode: 'serial' });

test('Direct Play: 206 Range on the original file', async ({ request }) => {
  const sample = sampleOrSkip(test, 'directPlay');
  const { smoke, itemId } = await setupSmoke(request, sample);
  const { session, ms } = await smoke.start({ itemId, capabilities: BROWSER_MKV });
  try {
    expect(session.mode).toBe('direct_play');
    expect(session.stream.protocol).toBe('progressive');
    const r = await smoke.ranges(session);
    note('timing', `StartPlayback ${ms} ms, two Range reads ${r.ms} ms, file ${r.size} B`);
  } finally {
    await smoke.stop(session, 0);
  }
});

test('Direct Stream: first HLS segment, progress saved and resumed', async ({ request }) => {
  // The long sample of the main flow: the smoke has no browser, so its codecs do not matter, and it is long enough
  // for a resume.
  const sample = sampleOrSkip(test, 'main');
  const { smoke, itemId } = await setupSmoke(request, sample);
  const { session, ms } = await smoke.start({ itemId, capabilities: BROWSER });
  // Past RESUME_MIN_POSITION_MS (30 s) when the file is long enough, so that the resume position is checked too.
  const position = Math.floor(Math.min(RESUME_AT_MS, session.durationMs / 2));
  try {
    expect(session.mode).toBe(sample.mode ?? 'direct_stream');
    expect(session.stream.protocol).toBe('hls-fmp4');
    for (const c of sample.codecs ?? []) expect(session.stream.mimeType ?? '').toContain(c);
    const seg = await smoke.firstSegment(session);
    note('timing', `StartPlayback ${ms} ms, first segment ${seg.ms} ms (${seg.segmentBytes} B, ${seg.segments} segments)`);
    await smoke.progress(session, position);
  } finally {
    await smoke.stop(session, position);
  }
  const state = (await smoke.detail(itemId)).state;
  expect(state?.progressPercent ?? 0).toBeCloseTo((position / session.durationMs) * 100, 0);
  if (position < RESUME_AT_MS) {
    note('resume', `not checked: "${sample.title}" is shorter than ${(2 * RESUME_AT_MS) / 1000} s`);
    return;
  }
  expect(state?.resumePositionMs ?? 0).toBeGreaterThanOrEqual(position - 1_000);
  expect(state?.resumePositionMs ?? 0).toBeLessThanOrEqual(position + 1_000);

  // A new session resumes there.
  const again = await smoke.start({ itemId, capabilities: BROWSER });
  try {
    expect(Math.abs(again.session.resumePositionMs - position)).toBeLessThanOrEqual(1_000);
  } finally {
    await smoke.stop(again.session, position);
  }
});

test('embedded PGS extracted as .sup for the client renderer', async ({ request }) => {
  const sample = sampleOrSkip(test, 'pgsSubtitle');
  const { smoke, itemId } = await setupSmoke(request, sample);
  const pgs = await embeddedSubtitle(smoke, itemId, 'image', sample.subtitleLanguage);
  const { session } = await smoke.start({ itemId, capabilities: BROWSER, fileId: pgs.fileId, subtitleTrackId: pgs.trackId });
  try {
    const track = session.tracks.subtitles.find((t) => t.id === pgs.trackId);
    expect(track?.selected).toBe(true);
    expect(track?.delivery).toBe('client_render');
    const sub = await smoke.subtitle(track as SessionTrack);
    // PGS segments start with the "PG" magic.
    expect(sub.body.length).toBeGreaterThan(13);
    expect(sub.body.toString('latin1', 0, 2)).toBe('PG');
    note('timing', `.sup ${sub.body.length} B in ${sub.ms} ms`);
  } finally {
    await smoke.stop(session, 0);
  }
});

test('embedded text subtitle extracted as WebVTT', async ({ request }) => {
  const sample = sampleOrSkip(test, 'textSubtitle');
  const { smoke, itemId } = await setupSmoke(request, sample);
  const text = await embeddedSubtitle(smoke, itemId, 'text', sample.subtitleLanguage);
  const { session } = await smoke.start({ itemId, capabilities: BROWSER, fileId: text.fileId, subtitleTrackId: text.trackId });
  try {
    const track = session.tracks.subtitles.find((t) => t.id === text.trackId);
    expect(track?.selected).toBe(true);
    expect(track?.delivery).toBe('sidecar');
    const sub = await smoke.subtitle(track as SessionTrack);
    const vtt = sub.body.toString('utf8');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('-->');
    note('timing', `.vtt ${sub.body.length} B in ${sub.ms} ms`);
  } finally {
    await smoke.stop(session, 0);
  }
});

test('Transcode (source up to 1080p): first HLS segment in H.264', async ({ request }) => {
  const sample = sampleOrSkip(test, 'transcode');
  const { smoke, itemId } = await setupSmoke(request, sample);
  const { session, ms } = await smoke.start({ itemId, capabilities: SMALL_SCREEN });
  try {
    expect(session.mode).toBe('transcode');
    expect(session.stream.protocol).toBe('hls-fmp4');
    expect(session.stream.mimeType ?? '').toContain('avc1');
    const seg = await smoke.firstSegment(session);
    note('timing', `StartPlayback ${ms} ms, first segment ${seg.ms} ms (${seg.segmentBytes} B)`);
  } finally {
    await smoke.stop(session, 0);
  }
});
