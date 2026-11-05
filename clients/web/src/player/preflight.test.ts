import { describe, expect, it } from 'vitest';
import { parseMimeType, preflight, suspectFromCodecs, type PreflightEnv } from './preflight.ts';

// isTypeSupported as measured in S2.
const SUPPORTED: Record<string, readonly string[]> = {
  edge: ['avc1', 'hvc1', 'hev1', 'flac', 'opus', 'mp4a.40.2', 'ac-3', 'ec-3'],
  chrome: ['avc1', 'hvc1', 'hev1', 'flac', 'opus', 'mp4a.40.2'],
  firefox: ['avc1', 'hvc1', 'flac', 'opus', 'mp4a.40.2'],
};

function isTypeSupported(browser: string) {
  const ok = SUPPORTED[browser] ?? [];
  return (type: string) => {
    if (!type.startsWith('video/mp4') && !type.startsWith('audio/mp4')) return false;
    const { codecs } = parseMimeType(type);
    return codecs.length > 0 && codecs.every((c) => ok.some((p) => c.startsWith(p)));
  };
}

const env = (browser: string, canPlay = 'maybe'): PreflightEnv => ({ isTypeSupported: isTypeSupported(browser), canPlayType: () => canPlay });

describe('parseMimeType', () => {
  it('splits container and codecs', () => {
    expect(parseMimeType('video/mp4; codecs="hvc1.2.4.L153.B0, flac"')).toEqual({ container: 'video/mp4', codecs: ['hvc1.2.4.L153.B0', 'flac'] });
    expect(parseMimeType('video/x-matroska')).toEqual({ container: 'video/x-matroska', codecs: [] });
    expect(parseMimeType('video/mp4;codecs=avc1.640028')).toEqual({ container: 'video/mp4', codecs: ['avc1.640028'] });
  });
});

describe('suspectFromCodecs', () => {
  it.each([
    ['only the audio refused', 'chrome', 'video/mp4; codecs="avc1.640028, ec-3"', 'audio'],
    ['only the video refused (DV)', 'chrome', 'video/mp4; codecs="dvh1.08.06, flac"', 'video'],
    ['both refused', 'chrome', 'video/mp4; codecs="dvh1.08.06, ec-3"', 'unknown'],
    ['neither refused alone', 'chrome', 'video/mp4; codecs="avc1.640028, flac"', 'unknown'],
    ['hev1 counts as video', 'firefox', 'video/mp4; codecs="hev1.2.4.L153.B0, flac"', 'video'],
  ])('%s', (_name, browser, mime, suspect) => {
    expect(suspectFromCodecs(mime, isTypeSupported(browser))).toBe(suspect);
  });

  it('is unknown without MSE or codecs', () => {
    expect(suspectFromCodecs('video/mp4; codecs="ec-3"', null)).toBe('unknown');
    expect(suspectFromCodecs('video/mp4', isTypeSupported('chrome'))).toBe('unknown');
  });
});

describe('preflight (doc 05 §7.8.3)', () => {
  it.each([
    ['hls E-AC-3 in Edge passes', 'hls-fmp4', 'video/mp4; codecs="hvc1.2.4.L153.B0, ec-3"', 'edge', { ok: true }],
    ['hls E-AC-3 in Chrome → audio', 'hls-fmp4', 'video/mp4; codecs="hvc1.2.4.L153.B0, ec-3"', 'chrome', { ok: false, suspect: 'audio' }],
    ['hls FLAC in Firefox passes', 'hls-fmp4', 'video/mp4; codecs="hvc1.2.4.L153.B0, flac"', 'firefox', { ok: true }],
    ['progressive MP4 checks MSE too', 'progressive', 'video/mp4; codecs="avc1.640028, ac-3"', 'chrome', { ok: false, suspect: 'audio' }],
  ] as const)('%s', (_name, protocol, mimeType, browser, expected) => {
    expect(preflight({ protocol, mimeType }, env(browser))).toEqual(expected);
  });

  it('skips the check without a mimeType', () => {
    expect(preflight({ protocol: 'hls-fmp4', mimeType: null }, env('chrome'))).toEqual({ ok: true, skipped: 'no_mime_type' });
  });

  it('MKV in Direct Play: only the container, via canPlayType, never decomposed', () => {
    const mkv = 'video/x-matroska; codecs="avc1.640028, ec-3"';
    expect(preflight({ protocol: 'progressive', mimeType: mkv }, env('chrome', 'maybe'))).toEqual({ ok: true });
    expect(preflight({ protocol: 'progressive', mimeType: mkv }, env('chrome', ''))).toEqual({ ok: false, suspect: 'container' });
  });

  it('progressive MP4 without MSE uses canPlayType', () => {
    const noMse = (canPlay: string): PreflightEnv => ({ isTypeSupported: null, canPlayType: () => canPlay });
    expect(preflight({ protocol: 'progressive', mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"' }, noMse('probably'))).toEqual({ ok: true });
    expect(preflight({ protocol: 'progressive', mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"' }, noMse(''))).toEqual({ ok: false, suspect: 'unknown' });
  });

  it('treats a throwing isTypeSupported as refused', () => {
    const throwing: PreflightEnv = {
      isTypeSupported: () => {
        throw new Error('boom');
      },
      canPlayType: () => '',
    };
    expect(preflight({ protocol: 'hls-fmp4', mimeType: 'video/mp4; codecs="avc1.640028, flac"' }, throwing)).toEqual({ ok: false, suspect: 'unknown' });
  });
});
