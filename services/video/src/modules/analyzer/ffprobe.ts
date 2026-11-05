// ffprobe in a child process (ADR 0001 rule 3: execa, argument array, explicit timeout,
// SIGTERM then kill after 5 s, stderr tail kept for diagnostics). Output validated with Zod.
import { existsSync } from 'node:fs';
import { execa, ExecaError } from 'execa';
import { z } from 'zod';

const numeric = z.union([z.number(), z.string()]);
const tags = z.record(z.string(), z.unknown());
const sideData = z.looseObject({ side_data_type: z.string().optional() });

export const FfprobeStream = z.looseObject({
  index: z.number().int(),
  codec_name: z.string().optional(),
  codec_type: z.string().optional(),
  codec_tag_string: z.string().optional(),
  profile: numeric.optional(),
  level: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  pix_fmt: z.string().optional(),
  color_transfer: z.string().optional(),
  color_primaries: z.string().optional(),
  r_frame_rate: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  bits_per_raw_sample: numeric.optional(),
  channels: z.number().optional(),
  channel_layout: z.string().optional(),
  sample_rate: numeric.optional(),
  bit_rate: numeric.optional(),
  disposition: z.record(z.string(), z.number()).optional(),
  tags: tags.optional(),
  side_data_list: z.array(sideData).optional(),
});
export type FfprobeStream = z.infer<typeof FfprobeStream>;

export const FfprobeChapter = z.looseObject({
  time_base: z.string().optional(),
  start: z.number().optional(),
  end: z.number().optional(),
  start_time: numeric.optional(),
  end_time: numeric.optional(),
  tags: tags.optional(),
});
export type FfprobeChapter = z.infer<typeof FfprobeChapter>;

export const FfprobeOutput = z.looseObject({
  streams: z.array(FfprobeStream).default([]),
  chapters: z.array(FfprobeChapter).default([]),
  format: z
    .looseObject({
      format_name: z.string().optional(),
      start_time: numeric.optional(),
      duration: numeric.optional(),
      bit_rate: numeric.optional(),
    })
    .optional(),
});
export type FfprobeOutput = z.infer<typeof FfprobeOutput>;

const FfprobeFrames = z.looseObject({
  frames: z.array(z.looseObject({ side_data_list: z.array(sideData).optional() })).default([]),
});

export interface ProbeRunner {
  /** Container, streams and chapters. */
  probe(absPath: string, signal: AbortSignal): Promise<FfprobeOutput>;
  /** side_data_type values of the first decoded frame of one stream (HDR10+ lives only there, S1). */
  firstFrameSideData(absPath: string, streamIndex: number, signal: AbortSignal): Promise<string[]>;
}

export interface FfprobeOptions {
  timeoutMs?: number;
  frameTimeoutMs?: number;
  /** Arguments put before ffprobe's own: tests run a fake ffprobe script through node. */
  argsPrefix?: readonly string[];
}

const STDERR_TAIL_LINES = 5;

// On Windows a missing executable surfaces as "exit 1", not ENOENT: check configured paths ourselves.
const isMissingPath = (p: string): boolean => /[\\/]/.test(p) && !existsSync(p);

function describeFailure(err: unknown, ffprobePath: string): Error {
  if (err instanceof ExecaError) {
    if (err.code === 'ENOENT' || isMissingPath(ffprobePath)) return new Error(`ffprobe not found (${ffprobePath})`);
    const why = err.timedOut ? 'timed out' : err.isCanceled ? 'canceled' : `exit ${err.exitCode ?? err.signal ?? '?'}`;
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-STDERR_TAIL_LINES).join(' | ').slice(0, 500);
    return new Error(`ffprobe ${why}${tail ? `: ${tail}` : ''}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function createFfprobeRunner(ffprobePath: string, opts: FfprobeOptions = {}): ProbeRunner {
  const run = async (args: string[], timeout: number, signal: AbortSignal): Promise<unknown> => {
    let stdout: string;
    try {
      const r = await execa(ffprobePath, [...(opts.argsPrefix ?? []), ...args], {
        timeout,
        cancelSignal: signal,
        forceKillAfterDelay: 5000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      stdout = r.stdout;
    } catch (err) {
      throw describeFailure(err, ffprobePath);
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`ffprobe printed invalid JSON: ${JSON.stringify(stdout.slice(0, 80))}`);
    }
  };
  // 'file:' keeps ffmpeg from reading a protocol (http:, concat:) out of a file name.
  const input = (absPath: string) => ['-i', `file:${absPath}`];

  return {
    async probe(absPath, signal) {
      const json = await run(
        ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', ...input(absPath)],
        opts.timeoutMs ?? 60_000,
        signal,
      );
      const parsed = FfprobeOutput.safeParse(json);
      if (!parsed.success) throw new Error(`unexpected ffprobe output: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      return parsed.data;
    },
    async firstFrameSideData(absPath, streamIndex, signal) {
      const json = await run(
        [
          '-v', 'error',
          '-select_streams', String(streamIndex),
          '-read_intervals', '%+#1',
          '-show_frames', '-show_entries', 'frame=side_data_list',
          '-of', 'json', ...input(absPath),
        ],
        opts.frameTimeoutMs ?? 30_000,
        signal,
      );
      const parsed = FfprobeFrames.safeParse(json);
      if (!parsed.success) throw new Error(`unexpected ffprobe frame output: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      return parsed.data.frames.flatMap((f) => (f.side_data_list ?? []).map((d) => d.side_data_type ?? ''));
    },
  };
}
