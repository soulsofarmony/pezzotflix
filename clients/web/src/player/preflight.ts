// Check of stream.mimeType before starting the player (doc 03 I6, doc 05 §7.8.3).
import type { Stream, Suspect } from '../api/types.ts';

export interface PreflightEnv {
  /** MediaSource.isTypeSupported, null without MSE. */
  isTypeSupported: ((type: string) => boolean) | null;
  canPlayType: (type: string) => string;
}

export type PreflightResult = { ok: true; skipped?: 'no_mime_type' } | { ok: false; suspect: Suspect };

const VIDEO_PREFIXES = ['avc1', 'avc3', 'hvc1', 'hev1', 'dvh1', 'dvhe', 'av01', 'vp09'];

export const isVideoCodec = (codec: string) => VIDEO_PREFIXES.some((p) => codec.toLowerCase().startsWith(p));

/** Splits 'video/mp4; codecs="hvc1.2.4.L153.B0, flac"' into its container type and codec list. */
export function parseMimeType(mime: string): { container: string; codecs: string[] } {
  const [container = '', ...params] = mime.split(';').map((s) => s.trim());
  let codecs: string[] = [];
  for (const p of params) {
    const m = /^codecs\s*=\s*"?([^"]*)"?$/i.exec(p);
    if (m?.[1] !== undefined) codecs = m[1].split(',').map((c) => c.trim()).filter(Boolean);
  }
  return { container: container.toLowerCase(), codecs };
}

const isMatroska = (container: string) => container === 'video/x-matroska' || container === 'video/webm' || container === 'audio/x-matroska';

/**
 * Probes each codec alone to find the suspect dimension: only the video refused → video, only the audio → audio,
 * both or neither → unknown.
 */
export function suspectFromCodecs(mime: string, isTypeSupported: ((t: string) => boolean) | null): Suspect {
  const { container, codecs } = parseMimeType(mime);
  if (!isTypeSupported || codecs.length === 0) return 'unknown';
  const type = container || 'video/mp4';
  let videoRefused = false;
  let audioRefused = false;
  for (const c of codecs) {
    let ok = false;
    try {
      ok = isTypeSupported(`${type}; codecs="${c}"`);
    } catch {
      ok = false;
    }
    if (!ok) {
      if (isVideoCodec(c)) videoRefused = true;
      else audioRefused = true;
    }
  }
  if (videoRefused && !audioRefused) return 'video';
  if (audioRefused && !videoRefused) return 'audio';
  return 'unknown';
}

/**
 * hls-fmp4 and MP4 progressive: isTypeSupported on the exact string, then the codec decomposition.
 * MKV in Direct Play: an empty canPlayType means the container is suspect, no decomposition (isTypeSupported is false
 * for MKV everywhere, S2 H1). Without a mimeType the check is skipped and the caller logs it.
 */
export function preflight(stream: Pick<Stream, 'protocol' | 'mimeType'>, env: PreflightEnv): PreflightResult {
  const mime = stream.mimeType;
  if (!mime) return { ok: true, skipped: 'no_mime_type' };
  const { container } = parseMimeType(mime);

  if (stream.protocol === 'progressive' && isMatroska(container)) {
    return env.canPlayType(mime) === '' ? { ok: false, suspect: 'container' } : { ok: true };
  }

  if (stream.protocol === 'progressive' && !env.isTypeSupported) {
    // Progressive MP4 without MSE: the element decides alone.
    if (env.canPlayType(mime) !== '') return { ok: true };
    return { ok: false, suspect: 'unknown' };
  }

  let ok = false;
  try {
    ok = env.isTypeSupported?.(mime) ?? false;
  } catch {
    ok = false;
  }
  return ok ? { ok: true } : { ok: false, suspect: suspectFromCodecs(mime, env.isTypeSupported) };
}
