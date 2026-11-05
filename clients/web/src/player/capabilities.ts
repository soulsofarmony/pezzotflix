// Capability probing at every StartPlayback (doc 03 I6, doc 04 §5, doc 05 §7.8.2, S2).
// The browser is asked about a fixed list of codec strings; the answers are declared with the fixed vocabulary.
import type { ClientCapabilities } from './types.ts';

type VideoCap = ClientCapabilities['video'][number];
type AudioCap = ClientCapabilities['audio'][number];

/** The browser APIs the probe reads. Tests pass one fake per browser measured in S2. */
export interface CapabilityEnv {
  isTypeSupported: ((type: string) => boolean) | null;
  decodingInfo: ((config: MediaDecodingConfiguration) => Promise<{ supported: boolean }>) | null;
  matchMedia: ((query: string) => { matches: boolean }) | null;
  canPlayType: (type: string) => string;
  hlsSupported: () => boolean;
  hasWorker: boolean;
  hasRequestVideoFrameCallback: boolean;
  userAgent: string;
  userAgentData: UserAgentDataLike | null;
  appVersion: string;
}

export interface UserAgentDataLike {
  mobile: boolean;
  platform: string;
  brands: { brand: string; version: string }[];
  getHighEntropyValues(hints: string[]): Promise<{ fullVersionList?: { brand: string; version: string }[]; platformVersion?: string; platform?: string }>;
}

const mp4 = (codec: string) => `video/mp4; codecs="${codec}"`;

export const H264_PROBE = 'avc1.640028';
/** Main and Main10, tier Main at level 5.1 and 6.1, tier High at 5.1 (S2: h6 played as H153 but was not probed). */
export const HEVC_PROBES = ['hvc1.2.4.L153.B0', 'hvc1.2.4.H153.B0', 'hvc1.2.4.L183.B0'] as const;

const AUDIO_PROBES: readonly { probe: string; cap: AudioCap }[] = [
  { probe: 'flac', cap: { codec: 'flac', maxChannels: 8, mode: 'decode' } },
  { probe: 'opus', cap: { codec: 'opus', maxChannels: 6, mode: 'decode' } },
  { probe: 'mp4a.40.2', cap: { codec: 'aac', maxChannels: 6, mode: 'decode' } },
  { probe: 'ac-3', cap: { codec: 'ac3', maxChannels: 6, mode: 'decode' } },
  // 7.1 with a dependent substream is not measured (S2): declare 6.
  { probe: 'ec-3', cap: { codec: 'eac3', maxChannels: 6, mode: 'decode' } },
];

const SIZES = [
  { width: 3840, height: 2160, framerate: 60, bitrate: 100_000_000 },
  { width: 3840, height: 2160, framerate: 30, bitrate: 100_000_000 },
  { width: 1920, height: 1080, framerate: 60, bitrate: 40_000_000 },
  { width: 1920, height: 1080, framerate: 30, bitrate: 40_000_000 },
] as const;

async function decodes(env: CapabilityEnv, video: VideoConfiguration): Promise<boolean> {
  if (!env.decodingInfo) return false;
  try {
    return (await env.decodingInfo({ type: 'media-source', video })).supported;
  } catch {
    return false;
  }
}

/**
 * Largest size and frame rate decodingInfo accepts for a codec string: 4K60, then 4K30, 1080p60, 1080p30.
 * Without mediaCapabilities the codec is declared at 1080p30 (judgment: the safe floor); when every size is
 * refused, null drops the codec although isTypeSupported accepted the string.
 */
async function maxSize(env: CapabilityEnv, codec: string): Promise<Pick<VideoCap, 'maxWidth' | 'maxHeight' | 'maxFrameRate'> | null> {
  if (!env.decodingInfo) return { maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 };
  for (const s of SIZES) {
    if (await decodes(env, { contentType: mp4(codec), width: s.width, height: s.height, framerate: s.framerate, bitrate: s.bitrate })) {
      return { maxWidth: s.width, maxHeight: s.height, maxFrameRate: s.framerate };
    }
  }
  return null;
}

/** HDR10 and HLG from decodingInfo on HEVC Main10 4K. Never DV (no browser plays it, S2 H3), never HDR10+ (S2 H2). */
async function probeHdr(env: CapabilityEnv, hevc: string): Promise<string[]> {
  const base = { contentType: mp4(hevc), width: 3840, height: 2160, framerate: 30, bitrate: 60_000_000, colorGamut: 'rec2020' as const };
  const out: string[] = [];
  if (await decodes(env, { ...base, transferFunction: 'pq', hdrMetadataType: 'smpteSt2086' })) out.push('HDR10');
  if (await decodes(env, { ...base, transferFunction: 'hlg' })) out.push('HLG');
  return out;
}

const BRAND_NAMES: readonly [string, string][] = [
  ['Microsoft Edge', 'Edge'],
  ['Google Chrome', 'Chrome'],
  ['Opera', 'Opera'],
  ['Brave', 'Brave'],
  ['Vivaldi', 'Vivaldi'],
  ['Chromium', 'Chromium'],
];

function chromiumPlatform(platform: string, platformVersion: string | undefined): string {
  if (platform === 'Windows') {
    const major = Number((platformVersion ?? '').split('.')[0]);
    if (Number.isFinite(major) && major >= 13) return 'Windows 11';
    if (Number.isFinite(major) && major >= 1) return 'Windows 10';
    return 'Windows';
  }
  return platform || 'unknown';
}

function uaPlatform(ua: string): string {
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'unknown';
}

/**
 * device.model: browser, version and OS, e.g. "Edge 156.0.4314.58; Windows 11" (server-side overrides, doc 03 I2).
 * Chromium reports Windows 11 through platformVersion >= 13; Firefox always says "Windows NT 10.0", so it stays
 * "Windows" (doc 05 §7.8.2).
 */
export async function deviceModel(env: Pick<CapabilityEnv, 'userAgent' | 'userAgentData'>): Promise<string> {
  const uad = env.userAgentData;
  if (uad) {
    try {
      const hi = await uad.getHighEntropyValues(['fullVersionList', 'platformVersion']);
      const list = hi.fullVersionList ?? uad.brands;
      for (const [brand, name] of BRAND_NAMES) {
        const b = list.find((x) => x.brand === brand);
        if (b) return `${name} ${b.version}; ${chromiumPlatform(hi.platform ?? uad.platform, hi.platformVersion)}`;
      }
    } catch {
      // High-entropy hints refused: fall back to the user agent string.
    }
  }
  const ua = env.userAgent;
  const ff = /Firefox\/([\d.]+)/.exec(ua);
  if (ff) return `Firefox ${ff[1]}; ${uaPlatform(ua)}`;
  const edge = /Edg\/([\d.]+)/.exec(ua);
  if (edge) return `Edge ${edge[1]}; ${uaPlatform(ua)}`;
  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  if (chrome) return `Chrome ${chrome[1]}; ${uaPlatform(ua)}`;
  const safari = /Version\/([\d.]+).*Safari\//.exec(ua);
  if (safari) return `Safari ${safari[1]}; ${uaPlatform(ua)}`;
  return `unknown; ${uaPlatform(ua)}`;
}

export async function probeCapabilities(env: CapabilityEnv): Promise<ClientCapabilities> {
  const supported = (codec: string) => {
    try {
      return env.isTypeSupported?.(mp4(codec)) ?? false;
    } catch {
      return false;
    }
  };

  const video: VideoCap[] = [];
  if (supported(H264_PROBE)) {
    const size = await maxSize(env, H264_PROBE);
    if (size) video.push({ codec: 'h264', profiles: ['high'], maxBitDepth: 8, ...size });
  }
  const hevc = HEVC_PROBES.find(supported);
  let hdr: string[] = [];
  if (hevc) {
    const size = await maxSize(env, hevc);
    if (size) {
      video.push({ codec: 'hevc', profiles: ['main', 'main10'], maxBitDepth: 10, ...size });
      hdr = await probeHdr(env, hevc);
    }
  }

  const audio = AUDIO_PROBES.filter((a) => supported(a.probe)).map((a) => ({ ...a.cap }));
  const pgs = env.hasWorker && env.hasRequestVideoFrameCallback;

  return {
    device: {
      class: env.userAgentData?.mobile ? 'mobile' : 'desktop',
      model: await deviceModel(env),
      app: `pezzotflix-web ${env.appVersion}`,
    },
    containers: env.canPlayType('video/x-matroska') !== '' ? ['mp4', 'mkv'] : ['mp4'],
    audioTrackSelection: false,
    protocols: env.hlsSupported() ? ['progressive', 'hls-fmp4'] : ['progressive'],
    video,
    hdr,
    displayHdr: env.matchMedia?.('(dynamic-range: high)').matches ?? false,
    audio,
    subtitles: { text: ['webvtt'], image: pgs ? ['pgs'] : [], ass: false },
  };
}

/** Diagnostics only (doc 04 §5): the output channel count never enters the capabilities. */
export function outputChannels(): number | null {
  try {
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const n = ctx.destination.maxChannelCount;
    void ctx.close();
    return n;
  } catch {
    return null;
  }
}

/** The real browser environment. hlsSupported comes from hls.js, loaded by the caller (player chunk). */
export function browserCapabilityEnv(video: HTMLVideoElement, hlsSupported: () => boolean, appVersion: string): CapabilityEnv {
  const ms = (globalThis as { MediaSource?: typeof MediaSource }).MediaSource;
  const mc = (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities;
  const uad = (navigator as Navigator & { userAgentData?: UserAgentDataLike }).userAgentData;
  return {
    isTypeSupported: ms ? (t) => ms.isTypeSupported(t) : null,
    decodingInfo: mc ? (c) => mc.decodingInfo(c) : null,
    matchMedia: typeof matchMedia === 'function' ? (q) => matchMedia(q) : null,
    canPlayType: (t) => video.canPlayType(t),
    hlsSupported,
    hasWorker: typeof Worker !== 'undefined',
    hasRequestVideoFrameCallback: typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    userAgent: navigator.userAgent,
    userAgentData: uad ?? null,
    appVersion,
  };
}
