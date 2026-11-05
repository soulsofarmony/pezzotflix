// Builders for playback tests: MediaFacts as the analyzer writes them (S1 fixtures) and the browser
// capabilities the web client declares (doc 05 §7.8.2 table, S2 measures on Windows).
import type { AudioStreamFacts, MediaFacts, SidecarSubtitleFacts, StreamFacts, SubtitleStreamFacts, VideoStreamFacts } from '../src/shared/media-facts.ts';
import type { ClientCapabilities, PlayableFile, ProfilePlaybackPrefs } from '../src/shared/ports.ts';

export const video = (o: Partial<VideoStreamFacts> = {}): VideoStreamFacts => ({
  type: 'video',
  index: 0,
  codec: 'hevc',
  profile: 'Main 10',
  language: null,
  title: null,
  default: true,
  forced: false,
  width: 3840,
  height: 2160,
  frameRate: 23.976,
  bitDepth: 10,
  pixFmt: 'yuv420p10le',
  colorTransfer: 'smpte2084',
  colorPrimaries: 'bt2020',
  hdr: 'HDR10',
  hdrFallback: [],
  dolbyVision: null,
  bitRate: null,
  attachedPic: false,
  ...o,
});

export const sdr1080 = (o: Partial<VideoStreamFacts> = {}): VideoStreamFacts =>
  video({ codec: 'h264', profile: 'High', width: 1920, height: 1080, bitDepth: 8, pixFmt: 'yuv420p', colorTransfer: 'bt709', colorPrimaries: 'bt709', hdr: 'SDR', ...o });

export const dv = (profile: number, blCompatId: number, o: Partial<VideoStreamFacts> = {}): VideoStreamFacts =>
  video({
    hdr: 'DV',
    hdrFallback: profile === 5 ? [] : blCompatId === 2 ? ['SDR'] : blCompatId === 4 ? ['HLG'] : ['HDR10'],
    dolbyVision: { profile, level: 6, blCompatId, hasEnhancementLayer: profile === 7, rpuPresent: true },
    ...o,
  });

export const audio = (index: number, o: Partial<AudioStreamFacts> = {}): AudioStreamFacts => ({
  type: 'audio',
  index,
  codec: 'truehd',
  profile: null,
  language: 'eng',
  title: null,
  default: index === 1,
  forced: false,
  channels: 8,
  channelLayout: '7.1',
  sampleRate: 48_000,
  bitRate: null,
  lossless: true,
  objectAudio: null,
  commentary: false,
  audioDescription: false,
  ...o,
});

export const ac3 = (index: number, language: string, o: Partial<AudioStreamFacts> = {}): AudioStreamFacts =>
  audio(index, { codec: 'ac3', language, channels: 6, channelLayout: '5.1(side)', lossless: false, bitRate: 640_000, ...o });

export const aac = (index: number, language: string, o: Partial<AudioStreamFacts> = {}): AudioStreamFacts =>
  audio(index, { codec: 'aac', profile: 'LC', language, channels: 2, channelLayout: 'stereo', lossless: false, bitRate: 192_000, ...o });

export const sub = (index: number, o: Partial<SubtitleStreamFacts> = {}): SubtitleStreamFacts => ({
  type: 'subtitle',
  index,
  codec: 'hdmv_pgs_subtitle',
  profile: null,
  language: 'ita',
  title: null,
  default: false,
  forced: false,
  kind: 'image',
  sdh: false,
  commentary: false,
  eventCount: null,
  ...o,
});

export const srt = (index: number, language: string, o: Partial<SubtitleStreamFacts> = {}): SubtitleStreamFacts =>
  sub(index, { codec: 'subrip', kind: 'text', language, ...o });

export const sidecar = (o: Partial<SidecarSubtitleFacts> & Pick<SidecarSubtitleFacts, 'id' | 'relPath'>): SidecarSubtitleFacts => ({
  format: 'srt',
  language: 'eng',
  forced: false,
  sdh: false,
  ...o,
});

export function facts(streams: StreamFacts[], o: Partial<MediaFacts> = {}): MediaFacts {
  return {
    location: { rootName: 'Film', relPath: 'Film (2017)/Film (2017).mkv' },
    sizeBytes: 50_000_000_000,
    mtimeMs: 1_762_300_000_000,
    container: 'matroska',
    durationMs: 7_200_000,
    bitRate: null,
    streams,
    chapters: [],
    sidecars: [],
    analyzerVersion: 2,
    ...o,
  };
}

export const file = (fileId: string, f: MediaFacts, available = true): PlayableFile => ({ fileId, available, facts: f });

type Caps = ClientCapabilities;

/** Common to the three browsers on Windows with the HEVC extension (S2, doc 05 §7.8.2). */
function browser(model: string, extraAudio: Caps['audio'] = []): Caps {
  return {
    device: { class: 'desktop', model },
    containers: ['mp4', 'mkv'],
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
      ...extraAudio,
    ],
    subtitles: { text: ['webvtt'], image: ['pgs'], ass: false },
  };
}

export const chrome = (): Caps => browser('Chrome 156.0.8078.80; Windows 11');
export const firefox = (): Caps => browser('Firefox 159.0; Windows');
/** Edge with the Dolby decoder of Windows: AC-3/E-AC-3 decode (S2 H6). */
export const edge = (): Caps =>
  browser('Edge 156.0.4314.58; Windows 11', [
    { codec: 'ac3', maxChannels: 6, mode: 'decode' },
    { codec: 'eac3', maxChannels: 6, mode: 'decode' },
  ]);

/** A Google TV app: native player, track selection, passthrough to an AVR (doc 04 §5). */
export const googleTv = (): Caps => ({
  device: { class: 'tv', model: 'Google TV Streamer' },
  containers: ['mkv', 'mp4'],
  audioTrackSelection: true,
  protocols: ['progressive', 'hls-fmp4'],
  video: [{ codec: 'hevc', profiles: ['main', 'main10'], maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 }, { codec: 'h264', profiles: ['high'] }],
  hdr: ['HDR10', 'HLG'],
  displayHdr: true,
  audio: [
    { codec: 'truehd', maxChannels: 8, mode: 'passthrough' },
    { codec: 'dtshd', maxChannels: 8, mode: 'passthrough' },
    { codec: 'eac3', maxChannels: 8, mode: 'passthrough' },
    { codec: 'ac3', maxChannels: 6, mode: 'passthrough' },
    { codec: 'aac', maxChannels: 6, mode: 'decode' },
  ],
  subtitles: { text: ['srt', 'webvtt'], image: ['pgs'], ass: true },
});

export const prefs = (o: Partial<ProfilePlaybackPrefs> = {}): ProfilePlaybackPrefs => ({
  audioLanguages: ['ita', 'eng'],
  subtitleLanguages: ['ita'],
  subtitleMode: 'off',
  ...o,
});
