// Subtitle tracks served separately (ADR 0003 D12, doc 03 §5). Sidecar files: .sup as is, text converted to
// WebVTT by ffmpeg at request time (to ASS for a burn-in), the charset detected from the bytes. Embedded
// tracks: extracted per file (subtitle-extract.ts), served while they grow, then from the cache.
import { readFile, stat } from 'node:fs/promises';
import { execa, ExecaError } from 'execa';
import type { ServedSubtitle, SubtitleAvailability } from '../../shared/playback-plan.ts';
import type { SubtitleLocator } from '../../shared/ports.ts';
import type { ExtractTarget } from './subtitle-extract.ts';

export const subtitleExtension = (s: ServedSubtitle): 'vtt' | 'sup' => (s.format === 'webvtt' ? 'vtt' : 'sup');

/** What the extraction writes for an embedded served track (PGS copied as .sup, text as WebVTT); null for a sidecar. */
export const extractTarget = (s: ServedSubtitle): ExtractTarget | null =>
  s.source.kind === 'embedded' ? { streamIndex: s.source.streamIndex, format: s.format === 'sup' ? 'sup' : 'vtt' } : null;

export function subtitleLocators(served: readonly ServedSubtitle[], base: string, availability: (s: ServedSubtitle) => SubtitleAvailability): SubtitleLocator[] {
  return served.map((s) => ({ trackId: s.trackId, url: `${base}/subtitles/${s.trackId}.${subtitleExtension(s)}`, availability: availability(s) }));
}

/** The served track a {track} path parameter names ("s5.vtt", "x:1a2b3c4d.sup"), never joined into a path. */
export function findServedTrack(served: readonly ServedSubtitle[], name: string): ServedSubtitle | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = name.slice(0, dot);
  const ext = name.slice(dot + 1);
  return served.find((s) => s.trackId === id && subtitleExtension(s) === ext) ?? null;
}

const MAX_SIDECAR_BYTES = 16 * 1024 * 1024;

/** ffmpeg demuxer of a text sidecar: forced, never probed from the content. */
const SIDECAR_DEMUXER = { srt: 'srt', ass: 'ass', ssa: 'ass', vtt: 'webvtt' } as const;
export type TextSidecarFormat = keyof typeof SIDECAR_DEMUXER;

/** Charset of a text sidecar that is neither UTF-8 nor UTF-16 with a BOM: Western European, as old SRTs are. */
export const SIDECAR_FALLBACK_CHARSET = 'CP1252';

/** Share of valid UTF-8 sequences among the non-ASCII ones from which a sidecar is read as UTF-8 anyway. */
export const SIDECAR_UTF8_MIN_SHARE = 0.9;

/**
 * Non-ASCII content of the bytes: valid UTF-8 multibyte sequences (no overlong form, no surrogate, at most
 * U+10FFFF) and bytes that start none (each counted once).
 */
export function utf8Census(bytes: Uint8Array): { valid: number; invalid: number } {
  let valid = 0;
  let invalid = 0;
  const cont = (i: number, lo = 0x80, hi = 0xbf) => i < bytes.length && bytes[i]! >= lo && bytes[i]! <= hi;
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    if (b < 0x80) {
      i += 1;
      continue;
    }
    let n = 0;
    if (b >= 0xc2 && b <= 0xdf) n = cont(i + 1) ? 2 : 0;
    else if (b >= 0xe0 && b <= 0xef) {
      const [lo, hi] = b === 0xe0 ? [0xa0, 0xbf] : b === 0xed ? [0x80, 0x9f] : [0x80, 0xbf];
      n = cont(i + 1, lo, hi) && cont(i + 2) ? 3 : 0;
    } else if (b >= 0xf0 && b <= 0xf4) {
      const [lo, hi] = b === 0xf0 ? [0x90, 0xbf] : b === 0xf4 ? [0x80, 0x8f] : [0x80, 0xbf];
      n = cont(i + 1, lo, hi) && cont(i + 2) && cont(i + 3) ? 4 : 0;
    }
    if (n > 0) {
      valid += 1;
      i += n;
    } else {
      invalid += 1;
      i += 1;
    }
  }
  return { valid, invalid };
}

/**
 * -sub_charenc for a text sidecar's bytes: none for UTF-16 with a BOM (the demuxer converts it) and for
 * UTF-8, with or without a BOM, also when a few bytes are not (at least SIDECAR_UTF8_MIN_SHARE of the
 * non-ASCII sequences valid): ffmpeg then drops only the cues with a stray byte, where reading the file as
 * Windows-1252 would garble every accented letter. Else SIDECAR_FALLBACK_CHARSET: without it ffmpeg drops
 * every cue that is not valid UTF-8 (each accented line of a Windows-1252 SRT).
 */
export function sidecarCharenc(bytes: Uint8Array): string | null {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return null;
  const { valid, invalid } = utf8Census(bytes);
  if (invalid === 0) return null;
  return valid / (valid + invalid) >= SIDECAR_UTF8_MIN_SHARE ? null : SIDECAR_FALLBACK_CHARSET;
}

/** The input half of a sidecar conversion: no protocol but file, the demuxer forced, the charset from the bytes. */
async function sidecarInput(absPath: string, format: TextSidecarFormat): Promise<string[]> {
  const st = await stat(absPath);
  if (st.size > MAX_SIDECAR_BYTES) throw new Error(`sidecar conversion failed: the file is over ${MAX_SIDECAR_BYTES} bytes`);
  const charenc = sidecarCharenc(await readFile(absPath));
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file',
    ...(charenc ? ['-sub_charenc', charenc] : []),
    '-f', SIDECAR_DEMUXER[format],
    '-i', `file:${absPath}`,
    '-map', '0:s:0',
  ];
}

async function runConversion(ffmpegPath: string, args: string[], signal: AbortSignal | undefined): Promise<Buffer> {
  try {
    const r = await execa(ffmpegPath, args, {
      encoding: 'buffer',
      timeout: 30_000,
      maxBuffer: MAX_SIDECAR_BYTES,
      windowsHide: true,
      ...(signal ? { cancelSignal: signal } : {}),
    });
    return Buffer.from(r.stdout);
  } catch (err) {
    const why = err instanceof ExecaError ? (err.timedOut ? 'timed out' : `exit ${err.exitCode ?? err.signal ?? '?'}`) : String(err);
    throw new Error(`sidecar conversion failed: ${why}`);
  }
}

/** A text sidecar (SRT, ASS/SSA, VTT) as WebVTT, by ffmpeg in a child process. ASS styling is lost. */
export async function sidecarToWebVtt(ffmpegPath: string, absPath: string, format: TextSidecarFormat, signal?: AbortSignal): Promise<Buffer> {
  return runConversion(ffmpegPath, [...(await sidecarInput(absPath, format)), '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'], signal);
}

/**
 * A text sidecar as an ASS file for the burn-in (libass), through the same hardened input: the subtitles
 * filter would otherwise probe the sidecar itself, read it as UTF-8 and lose the cues of another charset.
 * ASS/SSA keep their styles (ffmpeg's ASS decoder and encoder carry the header).
 */
export async function sidecarToAss(ffmpegPath: string, absPath: string, format: TextSidecarFormat, outPath: string, signal?: AbortSignal): Promise<void> {
  await runConversion(ffmpegPath, [...(await sidecarInput(absPath, format)), '-c:s', 'ass', '-f', 'ass', '-y', `file:${outPath}`], signal);
}
