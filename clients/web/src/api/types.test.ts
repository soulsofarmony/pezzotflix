import { describe, expect, it } from 'vitest';
import { DEFAULT_HEARTBEAT_MS, type RawPlaybackSession, type RawSessionTrack, toAppEvent, toPlaybackSession, UnsupportedProtocolError } from './types.ts';

const rawTrack = (over: Partial<RawSessionTrack> = {}): RawSessionTrack => ({
  id: 't1',
  type: 'subtitle',
  index: 3,
  selected: true,
  switchWithoutRestart: true,
  ...over,
});

const rawSession = (over: Partial<RawPlaybackSession> = {}): RawPlaybackSession => ({
  sessionId: 's1',
  expiresAt: 1,
  mode: 'direct_stream',
  reasons: [],
  stream: { url: '/video/media/sessions/s1/main.m3u8', protocol: 'hls-fmp4' },
  tracks: { audio: [], subtitles: [rawTrack({ delivery: 'client_render', url: '/x.sup', availability: 'growing' })] },
  resumePositionMs: 0,
  durationMs: 1000,
  chapters: [],
  ...over,
});

describe('toPlaybackSession', () => {
  it('applies the contract defaults', () => {
    const s = toPlaybackSession(rawSession());
    expect(s.heartbeatIntervalMs).toBe(DEFAULT_HEARTBEAT_MS);
    expect(s.stream).toEqual({
      protocol: 'hls-fmp4',
      url: '/video/media/sessions/s1/main.m3u8',
      mimeType: null,
      mediaTimestampOffsetMs: 0,
      bitrate: { peakBps: null, averageBps: null, audioBps: null },
    });
    expect(s.tracks.subtitles[0]).toMatchObject({ delivery: 'client_render', availability: 'growing', forced: false, url: '/x.sup' });
  });

  it('keeps the given values', () => {
    const s = toPlaybackSession(
      rawSession({
        heartbeatIntervalMs: 5000,
        stream: { url: '/u', protocol: 'progressive', mimeType: 'video/x-matroska', mediaTimestampOffsetMs: 10_000, bitrate: { peakBps: 9, audioBps: 1 } },
      }),
    );
    expect(s.heartbeatIntervalMs).toBe(5000);
    expect(s.stream).toMatchObject({ protocol: 'progressive', mimeType: 'video/x-matroska', mediaTimestampOffsetMs: 10_000, bitrate: { peakBps: 9, averageBps: null, audioBps: 1 } });
  });

  it('treats a missing availability as complete and an unknown delivery as not local', () => {
    const s = toPlaybackSession(rawSession({ tracks: { audio: [], subtitles: [rawTrack({ delivery: 'teletext' as never })] } }));
    expect(s.tracks.subtitles[0]).toMatchObject({ availability: 'complete', delivery: null });
  });

  it('rejects an unknown protocol', () => {
    expect(() => toPlaybackSession(rawSession({ stream: { url: '/u', protocol: 'dash' as never } }))).toThrow(UnsupportedProtocolError);
  });
});

describe('toAppEvent', () => {
  it.each([
    ['library.item_updated', { itemId: 'i1', fileId: 'f1', reason: 'metadata' }, { type: 'library.item_updated', itemId: 'i1' }],
    ['identification.needs_review', { caseId: 'c1' }, { type: 'identification.needs_review', caseId: 'c1' }],
    ['ingest.progress', {}, { type: 'ingest.progress' }],
    ['playback.subtitle_ready', { sessionId: 's1', trackId: 't1', availability: 'complete' }, { type: 'playback.subtitle_ready', sessionId: 's1', trackId: 't1', availability: 'complete' }],
    ['playback.session_terminated', { sessionId: 's1', reason: 'admin' }, { type: 'playback.session_terminated', sessionId: 's1', reason: 'admin' }],
    ['playback.session_terminated', {}, { type: 'unknown', rawType: 'playback.session_terminated' }],
    ['playback.subtitle_ready', { sessionId: 's1' }, { type: 'unknown', rawType: 'playback.subtitle_ready' }],
    ['music.track_added', {}, { type: 'unknown', rawType: 'music.track_added' }],
  ])('%s %o', (type, payload, expected) => {
    expect(toAppEvent({ seq: 7, at: 8, type, payload })).toEqual({ seq: 7, at: 8, ...expected });
  });
});
