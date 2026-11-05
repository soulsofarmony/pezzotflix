// Subtitle tracks served separately (ADR 0003 D12, doc 03 §5). F1b.3 serves sidecar files: .sup as is,
// text converted to WebVTT by ffmpeg at request time. Embedded tracks need the extraction of F1b.4
// (two passes, served while growing): until then they are 'growing' and answer 503 + Retry-After.
import { execa, ExecaError } from 'execa';
import type { ServedSubtitle, SubtitleAvailability } from '../../shared/playback-plan.ts';
import type { SubtitleLocator } from '../../shared/ports.ts';

export const subtitleExtension = (s: ServedSubtitle): 'vtt' | 'sup' => (s.format === 'webvtt' ? 'vtt' : 'sup');

/** F1b.4 replaces this with the extraction state of the file. */
export const initialAvailability = (s: ServedSubtitle): SubtitleAvailability => (s.source.kind === 'embedded' ? 'growing' : 'complete');

export function subtitleLocators(served: readonly ServedSubtitle[], base: string): SubtitleLocator[] {
  return served.map((s) => ({ trackId: s.trackId, url: `${base}/subtitles/${s.trackId}.${subtitleExtension(s)}`, availability: initialAvailability(s) }));
}

/** The served track a {track} path parameter names ("s5.vtt", "x:1a2b3c4d.sup"), never joined into a path. */
export function findServedTrack(served: readonly ServedSubtitle[], name: string): ServedSubtitle | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = name.slice(0, dot);
  const ext = name.slice(dot + 1);
  return served.find((s) => s.trackId === id && subtitleExtension(s) === ext) ?? null;
}

const MAX_SIDECAR_VTT_BYTES = 16 * 1024 * 1024;

/** ffmpeg demuxer of a text sidecar: forced, never probed from the content. */
const SIDECAR_DEMUXER = { srt: 'srt', ass: 'ass', ssa: 'ass', vtt: 'webvtt' } as const;

/** A text sidecar (SRT, ASS/SSA, VTT) as WebVTT, by ffmpeg in a child process. ASS styling is lost. */
export async function sidecarToWebVtt(ffmpegPath: string, absPath: string, format: 'srt' | 'ass' | 'ssa' | 'vtt', signal?: AbortSignal): Promise<Buffer> {
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file',
    '-f', SIDECAR_DEMUXER[format],
    '-i', `file:${absPath}`,
    '-map', '0:s:0', '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1',
  ];
  try {
    const r = await execa(ffmpegPath, args, {
      encoding: 'buffer',
      timeout: 30_000,
      maxBuffer: MAX_SIDECAR_VTT_BYTES,
      windowsHide: true,
      ...(signal ? { cancelSignal: signal } : {}),
    });
    return Buffer.from(r.stdout);
  } catch (err) {
    const why = err instanceof ExecaError ? (err.timedOut ? 'timed out' : `exit ${err.exitCode ?? err.signal ?? '?'}`) : String(err);
    throw new Error(`sidecar conversion failed: ${why}`);
  }
}
