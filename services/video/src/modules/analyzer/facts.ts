// Pure mapping ffprobe JSON → MediaFacts (doc 01 §4.3, S1). Deterministic: same input, same facts.
import type {
  AudioStreamFacts,
  ChapterFacts,
  DolbyVisionInfo,
  HdrFormat,
  MediaFacts,
  MediaLocation,
  SidecarSubtitleFacts,
  StreamFacts,
  SubtitleStreamFacts,
  VideoStreamFacts,
} from '../../shared/media-facts.ts';
import { normalizeLanguageTag } from '../../shared/languages.ts';
import type { FfprobeChapter, FfprobeOutput, FfprobeStream } from './ffprobe.ts';

/** Bump when the mapping changes, so files can be re-analysed (MediaFacts.analyzerVersion). */
export const ANALYZER_VERSION = 1;

/** Streams that MediaFacts does not model but media_stream keeps (fonts for ASS, data tracks). */
export interface OtherStream {
  index: number;
  type: 'attachment' | 'data';
  codec: string | null;
  attrs: { filename: string | null; mimeType: string | null };
}

// ---------------------------------------------------------------- small parsers

const toNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const toPositiveInt = (v: unknown): number | null => {
  const n = toNum(v);
  return n !== null && n > 0 ? Math.round(n) : null;
};

/** Case-insensitive tag lookup; Matroska statistics tags may carry a language suffix ("BPS-eng"). */
function tag(tags: Record<string, unknown> | undefined, key: string): string | null {
  if (!tags) return null;
  const want = key.toLowerCase();
  for (const [k, v] of Object.entries(tags)) {
    const lk = k.toLowerCase();
    if ((lk === want || lk.startsWith(`${want}-`)) && (typeof v === 'string' || typeof v === 'number')) {
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return null;
}

const flag = (s: FfprobeStream, name: string): boolean => (s.disposition?.[name] ?? 0) === 1;

/** "24000/1001" → 23.976, "0/0" → null. */
export function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const m = /^(\d+)\/(\d+)$/.exec(rate);
  const v = m ? (Number(m[2]) ? Number(m[1]) / Number(m[2]) : 0) : Number(rate);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
}

/** Bit depth from bits_per_raw_sample, else from the pixel format (yuv420p10le → 10). */
export function bitDepthOf(s: FfprobeStream): number | null {
  const raw = toPositiveInt(s.bits_per_raw_sample);
  if (raw) return raw;
  const pf = (s.pix_fmt ?? '').toLowerCase();
  const deep = /p(\d{1,2})(?:le|be)$/.exec(pf) ?? /^p0(\d{2})(?:le|be)$/.exec(pf);
  if (deep) return Number(deep[1]);
  if (/^(yuvj?|yuva|gbr)\d*p$|^(nv12|nv21|gray)$/.test(pf)) return 8;
  return null;
}

const msFromSeconds = (v: unknown): number | null => {
  const n = toNum(v);
  return n !== null && n >= 0 ? Math.round(n * 1000) : null;
};

function chapterMs(ticks: number | undefined, timeBase: string | undefined, fallbackSeconds: unknown): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(timeBase ?? '');
  if (typeof ticks === 'number' && m && Number(m[2])) return Math.round(((ticks * Number(m[1])) / Number(m[2])) * 1000);
  return msFromSeconds(fallbackSeconds);
}

/** ffprobe format_name → MediaFacts.container. Matroska and WebM share a demuxer: the extension decides. */
export function normalizeContainer(formatName: string | undefined, relPath: string): string {
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase();
  const names = (formatName ?? '').toLowerCase().split(',').filter(Boolean);
  if (names.includes('matroska') || names.includes('webm')) return ext === 'webm' ? 'webm' : 'matroska';
  if (names.includes('mp4') || names.includes('mov')) return ext === 'mov' ? 'mov' : 'mp4';
  if (names.includes('mpegts')) return 'mpegts';
  return names[0] ?? 'unknown';
}

// ---------------------------------------------------------------- video

const HDR10_PLUS_SIDE_DATA = /2094-40|hdr10\+/i;

/** True if any side data type names HDR10+ dynamic metadata (SMPTE ST 2094-40). */
export const hasHdr10PlusSideData = (types: readonly string[]): boolean => types.some((t) => HDR10_PLUS_SIDE_DATA.test(t));

function dolbyVisionOf(s: FfprobeStream): DolbyVisionInfo | null {
  const rec = s.side_data_list?.find((d) => /dovi configuration record/i.test(d.side_data_type ?? ''));
  if (!rec) return null;
  const int = (k: string) => {
    const n = toNum(rec[k]);
    return n === null ? 0 : Math.round(n);
  };
  return {
    profile: int('dv_profile'),
    level: int('dv_level'),
    blCompatId: int('dv_bl_signal_compatibility_id'),
    hasEnhancementLayer: int('el_present_flag') === 1,
    rpuPresent: int('rpu_present_flag') === 1,
  };
}

const transferHdr = (transfer: string | undefined): HdrFormat =>
  transfer === 'smpte2084' ? 'HDR10' : transfer === 'arib-std-b67' ? 'HLG' : 'SDR';

/** Wants the first-frame probe: only PQ streams can carry HDR10+ dynamic metadata. */
export const mayCarryHdr10Plus = (s: FfprobeStream): boolean =>
  s.codec_type === 'video' && !flag(s, 'attached_pic') && s.color_transfer === 'smpte2084';

/**
 * HDR classification (S1): transfer characteristics, not static metadata, decide HDR10/HLG.
 * DV comes from the configuration record; its fallback follows the base-layer compatibility id
 * (1 HDR10, 2 SDR, 4 HLG, 6 UHD Blu-ray/P7 → HDR10; profile 5 has none).
 */
export function classifyHdr(
  s: FfprobeStream,
  hdr10Plus: boolean,
): Pick<VideoStreamFacts, 'hdr' | 'hdrFallback' | 'dolbyVision'> {
  const dv = dolbyVisionOf(s);
  const base = transferHdr(s.color_transfer);
  const pqLayers: HdrFormat[] = hdr10Plus ? ['HDR10+', 'HDR10'] : ['HDR10'];
  if (dv) {
    let fallback: HdrFormat[];
    if (dv.profile === 5) fallback = [];
    else if (dv.blCompatId === 1 || dv.blCompatId === 6) fallback = pqLayers;
    else if (dv.blCompatId === 2) fallback = ['SDR'];
    else if (dv.blCompatId === 4) fallback = ['HLG'];
    else fallback = base === 'HDR10' ? pqLayers : base === 'HLG' ? ['HLG'] : [];
    return { hdr: 'DV', hdrFallback: fallback, dolbyVision: dv };
  }
  if (base === 'HDR10' && hdr10Plus) return { hdr: 'HDR10+', hdrFallback: ['HDR10'], dolbyVision: null };
  return { hdr: base, hdrFallback: [], dolbyVision: null };
}

// ---------------------------------------------------------------- audio

const LOSSLESS_CODECS = new Set(['truehd', 'mlp', 'flac', 'alac', 'wavpack', 'ape', 'tta', 's302m']);

/** Lossless depends on codec and, for DTS, on the profile: DTS core is lossy, DTS-HD MA is not (S1). */
export function isLossless(codec: string, profile: string | null): boolean {
  if (LOSSLESS_CODECS.has(codec) || codec.startsWith('pcm_')) return true;
  if (codec === 'dts') return /dts-hd ma/i.test(profile ?? '');
  return false;
}

/** Atmos (TrueHD / E-AC-3 JOC) and DTS:X from the ffprobe profile, else from the track title. */
export function objectAudioOf(codec: string, profile: string | null, title: string | null): 'atmos' | 'dtsx' | null {
  const p = profile ?? '';
  const t = title ?? '';
  if ((codec === 'truehd' || codec === 'eac3' || codec === 'ac4') && (/atmos/i.test(p) || /\batmos\b/i.test(t))) {
    return 'atmos';
  }
  if (codec === 'dts' && (/dts:x/i.test(p) || /\bdts[\s:._-]?x\b/i.test(t))) return 'dtsx';
  return null;
}

const COMMENTARY_TITLE = /\b(?:comm?ent|kommentar)/i;
const SDH_TITLE = /\b(?:sdh|cc)\b|hearing.impaired|non udenti|sordi/i;
const FORCED_TITLE = /\bforced\b|\bforzat[io]\b/i;
const NOT_FORCED_TITLE = /\b(?:non|not|no|senza)[\s_-]*(?:forced|forzat[io])\b/i;

/** "Forced", "Forzati" mark a forced track; "Non-Forced", "non forzati" mark a full one. */
export const titleSaysForced = (title: string | null): boolean =>
  title !== null && FORCED_TITLE.test(title) && !NOT_FORCED_TITLE.test(title);

// ---------------------------------------------------------------- streams

const IMAGE_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

function mapStream(s: FfprobeStream, hdr10Plus: boolean): StreamFacts | OtherStream {
  const codec = (s.codec_name ?? 'unknown').toLowerCase();
  const profile = s.profile === undefined ? null : String(s.profile);
  const title = tag(s.tags, 'title');
  const base = {
    index: s.index,
    codec,
    profile,
    language: normalizeLanguageTag(tag(s.tags, 'language')),
    title,
    default: flag(s, 'default'),
  };
  const bitRate = toPositiveInt(s.bit_rate) ?? toPositiveInt(tag(s.tags, 'BPS'));

  switch (s.codec_type) {
    case 'video':
      return {
        ...base,
        type: 'video',
        forced: flag(s, 'forced'),
        width: s.width ?? 0,
        height: s.height ?? 0,
        frameRate: parseFrameRate(s.avg_frame_rate) ?? parseFrameRate(s.r_frame_rate),
        bitDepth: bitDepthOf(s),
        pixFmt: s.pix_fmt ?? null,
        colorTransfer: s.color_transfer ?? null,
        colorPrimaries: s.color_primaries ?? null,
        ...classifyHdr(s, hdr10Plus),
        bitRate,
        attachedPic: flag(s, 'attached_pic'),
      } satisfies VideoStreamFacts;
    case 'audio':
      return {
        ...base,
        type: 'audio',
        forced: flag(s, 'forced'),
        channels: s.channels ?? 0,
        channelLayout: s.channel_layout ?? null,
        sampleRate: toPositiveInt(s.sample_rate),
        bitRate,
        lossless: isLossless(codec, profile),
        objectAudio: objectAudioOf(codec, profile, title),
        commentary: flag(s, 'comment') || COMMENTARY_TITLE.test(title ?? ''),
        audioDescription: flag(s, 'visual_impaired'),
      } satisfies AudioStreamFacts;
    case 'subtitle':
      return {
        ...base,
        type: 'subtitle',
        forced: flag(s, 'forced') || titleSaysForced(title),
        kind: IMAGE_SUBTITLE_CODECS.has(codec) ? 'image' : 'text',
        sdh: flag(s, 'hearing_impaired') || flag(s, 'captions') || SDH_TITLE.test(title ?? ''),
        commentary: isCommentarySubtitle(s),
        eventCount: toPositiveInt(tag(s.tags, 'NUMBER_OF_FRAMES')),
      } satisfies SubtitleStreamFacts;
    default:
      return {
        index: s.index,
        type: s.codec_type === 'attachment' ? 'attachment' : 'data',
        codec: s.codec_name ?? null,
        attrs: { filename: tag(s.tags, 'filename'), mimeType: tag(s.tags, 'mimetype') },
      };
  }
}

const isStreamFacts = (s: StreamFacts | OtherStream): s is StreamFacts =>
  s.type === 'video' || s.type === 'audio' || s.type === 'subtitle';

function mapChapter(c: FfprobeChapter, index: number): ChapterFacts {
  const startMs = chapterMs(c.start, c.time_base, c.start_time) ?? 0;
  const endMs = chapterMs(c.end, c.time_base, c.end_time) ?? startMs;
  return { index, title: tag(c.tags, 'title'), startMs, endMs: Math.max(endMs, startMs) };
}

// Hoisted: also used by mapStream above.
function isCommentarySubtitle(s: FfprobeStream): boolean {
  return s.codec_type === 'subtitle' && (flag(s, 'comment') || COMMENTARY_TITLE.test(tag(s.tags, 'title') ?? ''));
}

export interface MappedProbe {
  facts: MediaFacts;
  /** Attachment and data streams, stored in media_stream only. */
  others: OtherStream[];
  /** Stream indexes of commentary subtitle tracks. */
  commentarySubtitles: Set<number>;
}

export interface MapInput {
  probe: FfprobeOutput;
  location: MediaLocation;
  sizeBytes: number;
  mtimeMs: number;
  /** The analyzer stores the library's current sidecars instead (service.ts). */
  sidecars?: SidecarSubtitleFacts[];
  /** HDR10+ dynamic metadata found in the first frame of the main video stream. */
  hdr10PlusStreams?: ReadonlySet<number>;
}

export function mapFacts(input: MapInput): MappedProbe {
  const { probe } = input;
  const mapped = probe.streams.map((s) => mapStream(s, input.hdr10PlusStreams?.has(s.index) ?? false));
  const duration = msFromSeconds(probe.format?.duration);
  const facts: MediaFacts = {
    location: input.location,
    sizeBytes: input.sizeBytes,
    mtimeMs: input.mtimeMs,
    container: normalizeContainer(probe.format?.format_name, input.location.relPath),
    durationMs: duration !== null && duration > 0 ? duration : null,
    bitRate: toPositiveInt(probe.format?.bit_rate),
    streams: mapped.filter(isStreamFacts),
    chapters: probe.chapters.map(mapChapter),
    sidecars: input.sidecars ?? [],
    analyzerVersion: ANALYZER_VERSION,
  };
  return {
    facts,
    others: mapped.filter((s): s is OtherStream => !isStreamFacts(s)),
    commentarySubtitles: new Set(probe.streams.filter(isCommentarySubtitle).map((s) => s.index)),
  };
}
