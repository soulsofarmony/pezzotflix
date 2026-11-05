import { describe, expect, it } from 'vitest';
import { type CapabilityEnv, deviceModel, probeCapabilities, type UserAgentDataLike } from './capabilities.ts';
import { parseMimeType } from './preflight.ts';

// One fake per browser measured in S2 (Windows 11, RTX 3060 Ti, SDR monitor).
interface Fake {
  codecs: readonly string[];
  hdr10: boolean;
  hlg: boolean;
  /** decodingInfo answers per size: max height and frame rate accepted. */
  maxHeight: number;
  maxFps: number;
  uad: UserAgentDataLike | null;
  ua: string;
}

const uad = (brand: string, version: string): UserAgentDataLike => ({
  mobile: false,
  platform: 'Windows',
  brands: [
    { brand: 'Chromium', version: '156' },
    { brand, version: version.split('.')[0] ?? '' },
  ],
  getHighEntropyValues: () =>
    Promise.resolve({
      fullVersionList: [
        { brand: 'Not_A Brand', version: '24.0.0.0' },
        { brand: 'Chromium', version: '156.0.8078.80' },
        { brand, version },
      ],
      platformVersion: '19.0.0',
      platform: 'Windows',
    }),
});

const BROWSERS: Record<'edge' | 'chrome' | 'firefox', Fake> = {
  edge: {
    codecs: ['avc1', 'hvc1', 'flac', 'opus', 'mp4a.40.2', 'ac-3', 'ec-3'],
    hdr10: true,
    hlg: true,
    maxHeight: 2160,
    maxFps: 60,
    uad: uad('Microsoft Edge', '156.0.4314.58'),
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
  },
  chrome: {
    codecs: ['avc1', 'hvc1', 'flac', 'opus', 'mp4a.40.2'],
    hdr10: true,
    hlg: true,
    maxHeight: 2160,
    maxFps: 60,
    uad: uad('Google Chrome', '156.0.8078.80'),
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  },
  firefox: {
    codecs: ['avc1', 'hvc1', 'flac', 'opus', 'mp4a.40.2'],
    hdr10: true,
    hlg: true,
    maxHeight: 2160,
    maxFps: 60,
    uad: null,
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0',
  },
};

function env(f: Fake, over: Partial<CapabilityEnv> = {}): CapabilityEnv {
  const supports = (codec: string) => f.codecs.some((p) => codec.startsWith(p));
  return {
    isTypeSupported: (t) => parseMimeType(t).codecs.every(supports),
    decodingInfo: (c) => {
      const v = c.video;
      if (!v) return Promise.resolve({ supported: false });
      const codec = parseMimeType(v.contentType).codecs[0] ?? '';
      let ok = supports(codec) && v.height <= f.maxHeight && v.framerate <= f.maxFps;
      // Firefox also says yes to HDR10+ (S2 H2): the probe never asks for it.
      if (v.transferFunction === 'pq') ok &&= f.hdr10;
      if (v.transferFunction === 'hlg') ok &&= f.hlg;
      return Promise.resolve({ supported: ok });
    },
    matchMedia: () => ({ matches: false }),
    canPlayType: (t) => (t === 'video/x-matroska' ? 'maybe' : ''),
    hlsSupported: () => true,
    hasWorker: true,
    hasRequestVideoFrameCallback: true,
    userAgent: f.ua,
    userAgentData: f.uad,
    appVersion: '0.1.0',
    ...over,
  };
}

const VIDEO_4K60 = { maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 };

describe('probeCapabilities with the S2 browsers', () => {
  it('Edge: HEVC, HDR10/HLG, every audio codec including AC-3 and E-AC-3', async () => {
    const caps = await probeCapabilities(env(BROWSERS.edge));
    expect(caps.video).toEqual([
      { codec: 'h264', profiles: ['high'], maxBitDepth: 8, ...VIDEO_4K60 },
      { codec: 'hevc', profiles: ['main', 'main10'], maxBitDepth: 10, ...VIDEO_4K60 },
    ]);
    expect(caps.hdr).toEqual(['HDR10', 'HLG']);
    expect(caps.audio.map((a) => a.codec)).toEqual(['flac', 'opus', 'aac', 'ac3', 'eac3']);
    expect(caps.audio.find((a) => a.codec === 'flac')?.maxChannels).toBe(8);
    expect(caps.audio.find((a) => a.codec === 'eac3')?.maxChannels).toBe(6);
    expect(caps.containers).toEqual(['mp4', 'mkv']);
    expect(caps.protocols).toEqual(['progressive', 'hls-fmp4']);
    expect(caps.audioTrackSelection).toBe(false);
    expect(caps.displayHdr).toBe(false);
    expect(caps.subtitles).toEqual({ text: ['webvtt'], image: ['pgs'], ass: false });
    expect(caps.device).toEqual({ class: 'desktop', model: 'Edge 156.0.4314.58; Windows 11', app: 'pezzotflix-web 0.1.0' });
  });

  it('Chrome: no AC-3/E-AC-3', async () => {
    const caps = await probeCapabilities(env(BROWSERS.chrome));
    expect(caps.audio.map((a) => a.codec)).toEqual(['flac', 'opus', 'aac']);
    expect(caps.device?.model).toBe('Chrome 156.0.8078.80; Windows 11');
  });

  it('Firefox: model from the user agent, without Windows 10/11', async () => {
    const caps = await probeCapabilities(env(BROWSERS.firefox));
    expect(caps.audio.map((a) => a.codec)).toEqual(['flac', 'opus', 'aac']);
    expect(caps.hdr).toEqual(['HDR10', 'HLG']);
    expect(caps.device?.model).toBe('Firefox 159.0; Windows');
  });

  it('declares the high tier HEVC probe when only H153 is accepted', async () => {
    const caps = await probeCapabilities(env(BROWSERS.chrome, { isTypeSupported: (t) => t.includes('avc1') || t.includes('H153') }));
    expect(caps.video.map((v) => v.codec)).toEqual(['h264', 'hevc']);
  });

  it('steps down 4K60 → 4K30 → 1080p60 → 1080p30', async () => {
    const at30 = await probeCapabilities(env({ ...BROWSERS.chrome, maxFps: 30 }));
    expect(at30.video[0]).toMatchObject({ maxWidth: 3840, maxHeight: 2160, maxFrameRate: 30 });
    const hd = await probeCapabilities(env({ ...BROWSERS.chrome, maxHeight: 1080 }));
    expect(hd.video[0]).toMatchObject({ maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60 });
    const none = await probeCapabilities(env({ ...BROWSERS.chrome, maxHeight: 720 }));
    expect(none.video).toEqual([]);
    expect(none.hdr).toEqual([]);
  });

  it('declares 1080p30 without mediaCapabilities, and no HDR', async () => {
    const caps = await probeCapabilities(env(BROWSERS.chrome, { decodingInfo: null }));
    expect(caps.video[1]).toMatchObject({ codec: 'hevc', maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 });
    expect(caps.hdr).toEqual([]);
  });

  it('never declares DV or HDR10+, even when decodingInfo says yes to everything', async () => {
    const caps = await probeCapabilities(env(BROWSERS.firefox, { decodingInfo: () => Promise.resolve({ supported: true }) }));
    expect(caps.hdr).toEqual(['HDR10', 'HLG']);
  });

  it('PGS only with Worker and requestVideoFrameCallback', async () => {
    expect((await probeCapabilities(env(BROWSERS.chrome, { hasRequestVideoFrameCallback: false }))).subtitles.image).toEqual([]);
    expect((await probeCapabilities(env(BROWSERS.chrome, { hasWorker: false }))).subtitles.image).toEqual([]);
  });

  it('without hls.js support only progressive; without Matroska only mp4; displayHdr from the media query', async () => {
    const caps = await probeCapabilities(env(BROWSERS.chrome, { hlsSupported: () => false, canPlayType: () => '', matchMedia: () => ({ matches: true }) }));
    expect(caps.protocols).toEqual(['progressive']);
    expect(caps.containers).toEqual(['mp4']);
    expect(caps.displayHdr).toBe(true);
  });

  it('mobile from userAgentData', async () => {
    const mobile = { ...uad('Google Chrome', '156.0.8078.80'), mobile: true };
    expect((await probeCapabilities(env(BROWSERS.chrome, { userAgentData: mobile }))).device?.class).toBe('mobile');
  });
});

describe('deviceModel', () => {
  it('Windows 10 below platformVersion 13', async () => {
    const u = { ...uad('Microsoft Edge', '156.0.4314.58'), getHighEntropyValues: () => Promise.resolve({ platformVersion: '10.0.0', platform: 'Windows' }) };
    expect(await deviceModel({ userAgent: '', userAgentData: u })).toBe('Edge 156; Windows 10');
  });

  it('falls back to the user agent when the hints are refused', async () => {
    const u = { ...uad('Microsoft Edge', '156.0.4314.58'), getHighEntropyValues: () => Promise.reject(new Error('denied')) };
    expect(await deviceModel({ userAgent: BROWSERS.edge.ua, userAgentData: u })).toBe('Edge 156.0.0.0; Windows');
  });
});
