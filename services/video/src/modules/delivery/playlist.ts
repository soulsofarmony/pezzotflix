// HLS playlists (ADR 0003 D2), pure: a multivariant playlist with one variant and a VOD media playlist of
// the whole film. Names are relative, so the token stays in the path (ADR 0004).
import type { HdrFormat } from '../../shared/media-facts.ts';
import type { SegmentGrid } from './grid.ts';

export const MAIN_PLAYLIST = 'main.m3u8';
export const RENDITION = 0;
export const MEDIA_PLAYLIST = `media-${RENDITION}.m3u8`;
export const INIT_SEGMENT = `init-${RENDITION}.mp4`;
export const segmentName = (j: number): string => `seg-${RENDITION}-${String(j).padStart(5, '0')}.m4s`;

const SEGMENT_RE = new RegExp(`^seg-${RENDITION}-(\\d{5})\\.m4s$`);

export type HlsResource =
  | { kind: 'main' }
  | { kind: 'media' }
  | { kind: 'init' }
  | { kind: 'segment'; index: number };

/** Resource named in the playlists, or null for any other name (404). */
export function parseHlsResource(name: string, segmentCount: number): HlsResource | null {
  if (name === MAIN_PLAYLIST) return { kind: 'main' };
  if (name === MEDIA_PLAYLIST) return { kind: 'media' };
  if (name === INIT_SEGMENT) return { kind: 'init' };
  const m = SEGMENT_RE.exec(name);
  if (!m) return null;
  const index = Number(m[1]);
  return index < segmentCount ? { kind: 'segment', index } : null;
}

/**
 * Range of what the client decodes. DV reaches the browser as its base layer (P8.1/P7 HDR10, P8.4 HLG,
 * P8.2 SDR: MediaFacts hdrFallback); P5 has none and needs a Transcode (ADR 0003 D13).
 */
export const videoRange = (hdr: HdrFormat, fallback: readonly HdrFormat[] = []): 'PQ' | 'HLG' | 'SDR' => {
  const served = hdr === 'DV' ? (fallback[0] ?? 'HDR10') : hdr;
  return served === 'HLG' ? 'HLG' : served === 'SDR' ? 'SDR' : 'PQ';
};

export interface VariantInfo {
  peakBps: number;
  averageBps: number;
  /** Codec strings, video first: the inner list of stream.mimeType's codecs parameter. */
  codecs: string[];
  width: number;
  height: number;
  frameRate: number | null;
  videoRange: 'PQ' | 'HLG' | 'SDR';
  /** Only when every boundary keyframe is an IDR (Transcode with forced IDRs). */
  independentSegments: boolean;
}

export function multivariantPlaylist(v: VariantInfo): string {
  const attrs = [
    `BANDWIDTH=${Math.round(v.peakBps)}`,
    `AVERAGE-BANDWIDTH=${Math.round(v.averageBps)}`,
    `CODECS="${v.codecs.join(',')}"`,
    `RESOLUTION=${v.width}x${v.height}`,
    ...(v.frameRate ? [`FRAME-RATE=${v.frameRate.toFixed(3)}`] : []),
    `VIDEO-RANGE=${v.videoRange}`,
  ];
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    ...(v.independentSegments ? ['#EXT-X-INDEPENDENT-SEGMENTS'] : []),
    `#EXT-X-STREAM-INF:${attrs.join(',')}`,
    MEDIA_PLAYLIST,
    '',
  ].join('\n');
}

export function mediaPlaylist(grid: SegmentGrid, opts: { independentSegments: boolean }): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${grid.targetDurationS}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    ...(opts.independentSegments ? ['#EXT-X-INDEPENDENT-SEGMENTS'] : []),
    `#EXT-X-MAP:URI="${INIT_SEGMENT}"`,
  ];
  grid.extinfMs.forEach((ms, j) => {
    lines.push(`#EXTINF:${(ms / 1000).toFixed(3)},`, segmentName(j));
  });
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}
