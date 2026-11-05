// hls.js buffer sizing from the bitrate (doc 05 §7.8.4, S2: bufferFullError comes from the forward buffer).
//   Qv = 150 MiB, Qa = 12 MiB   Chromium quotas per stream (demuxer_memory_limit)
//   m  = 0.70                    forward-buffer margin; 10 % goes to the back buffer
//   T  = min(m·Qv·8 / bv, m·Qa·8 / ba)
//   maxBufferLength = maxMaxBufferLength = clamp(floor(T − TD), TD, 30 s)
//   maxBufferSize   = floor(m · Qv)
//   backBufferLength = max(2 s, floor(0.10·Qv·8 / bv))
// Starting values, to be checked on a whole film in F2.
import { isVideoCodec, parseMimeType } from './preflight.ts';

const MIB = 1024 * 1024;
export const VIDEO_QUOTA_BYTES = 150 * MIB;
export const AUDIO_QUOTA_BYTES = 12 * MIB;
const MARGIN = 0.7;
const BACK_SHARE = 0.1;
const MAX_FORWARD_S = 30;
const MIN_BACK_S = 2;

export interface BufferInput {
  /** stream.bitrate.peakBps; null falls back to BANDWIDTH of the multivariant playlist. */
  peakBps: number | null;
  audioBps: number | null;
  /** BANDWIDTH of the variant (RFC 8216 §4.3.4.2: its peak), used only without peakBps. */
  bandwidthBps: number | null;
  /** Delivered audio codec (deliveredAudioCodec), for the estimate when audioBps is missing. */
  audioCodec: string | null;
  audioChannels: number | null;
  /** EXT-X-TARGETDURATION in seconds. */
  targetDurationS: number;
}

export interface BufferConfig {
  maxBufferLength: number;
  maxMaxBufferLength: number;
  maxBufferSize: number;
  backBufferLength: number;
  /** Seconds that fit in the margin. */
  fitSeconds: number;
  /** T < 2·TD: the one-segment floor wins and the buffer may exceed the margin. */
  warn: boolean;
  /** Bitrates came from BANDWIDTH and the per-codec table, not from the session. */
  estimated: boolean;
}

/**
 * Audio bitrate estimate when the session has none (judgment, doc 05 §7.8.4): FLAC 0.75 Mbit/s per channel,
 * AC-3/E-AC-3 640 kbit/s, AAC/Opus 384 kbit/s for 5.1 (64 kbit/s per channel).
 */
export function estimateAudioBps(codec: string | null, channels: number | null): number {
  const ch = channels && channels > 0 ? channels : 2;
  switch ((codec ?? '').toLowerCase()) {
    case 'flac':
      return 750_000 * ch;
    case 'ac3':
    case 'ac-3':
    case 'eac3':
    case 'e-ac-3':
    case 'ec-3':
      return 640_000;
    case 'aac':
    case 'opus':
      return 64_000 * ch;
    default:
      return 640_000;
  }
}

/**
 * The audio codec the stream delivers, from stream.mimeType (`codecs="hvc1…, mp4a.40.2"`): after a conversion it
 * is not the source track's codec. Null without a mimeType or without an audio codec in it.
 */
export function deliveredAudioCodec(mimeType: string | null): string | null {
  if (!mimeType) return null;
  const audio = parseMimeType(mimeType).codecs.find((c) => !isVideoCodec(c));
  if (!audio) return null;
  const c = audio.toLowerCase();
  return c.startsWith('mp4a') ? 'aac' : c;
}

export function hlsBufferConfig(input: BufferInput): BufferConfig {
  const td = input.targetDurationS > 0 ? input.targetDurationS : 6;
  const estimated = input.peakBps === null || input.audioBps === null;
  const ba = input.audioBps ?? estimateAudioBps(input.audioCodec, input.audioChannels);
  const peak = input.peakBps ?? input.bandwidthBps;
  // Without any total bitrate only the audio quota can be computed; the video term then does not bind.
  let bv = peak !== null ? peak - ba : null;
  if (bv !== null && bv <= 0) bv = peak;

  const videoFit = bv && bv > 0 ? (MARGIN * VIDEO_QUOTA_BYTES * 8) / bv : Infinity;
  const audioFit = ba > 0 ? (MARGIN * AUDIO_QUOTA_BYTES * 8) / ba : Infinity;
  const fit = Math.min(videoFit, audioFit);

  const forward = Number.isFinite(fit) ? Math.min(Math.max(Math.floor(fit - td), td), MAX_FORWARD_S) : MAX_FORWARD_S;
  const back = bv && bv > 0 ? Math.max(MIN_BACK_S, Math.floor((BACK_SHARE * VIDEO_QUOTA_BYTES * 8) / bv)) : MIN_BACK_S;

  return {
    maxBufferLength: forward,
    maxMaxBufferLength: forward,
    maxBufferSize: Math.floor(MARGIN * VIDEO_QUOTA_BYTES),
    backBufferLength: back,
    fitSeconds: fit,
    warn: fit < 2 * td,
    estimated,
  };
}
