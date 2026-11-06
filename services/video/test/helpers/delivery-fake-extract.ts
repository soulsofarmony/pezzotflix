// A fake ffmpeg for the subtitle extraction unit tests: reads the outputs of an extraction command (one
// `-map 0:<i> … file:<path>` per track), writes what the test gives for each track and pass, then waits for
// release() (or exits at once) with the exit code the test sets. Each spawn is recorded.
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildLike, ExitInfo, Spawn } from '../../src/modules/delivery/process.ts';

export interface FakeExtractOutput {
  streamIndex: number;
  format: string;
  path: string;
}

export interface FakeExtractRun {
  args: readonly string[];
  /** From the work file names the extractor gives each pass (p1-…, p2-…). */
  pass: 1 | 2;
  seekS: number | null;
  /** Input -t (pass 2 without a video clock). */
  untilS: number | null;
  /** Paced from Node (SHA-512 frame hashes on stdout); false: no read cap (framecrc). */
  paced: boolean;
  outputs: FakeExtractOutput[];
  signals: string[];
  ended: boolean;
  /** Ends the process with this exit code (default 0). */
  release(code?: number): void;
  /** Writes one packet line on stdout (the header first): the video clock at this many seconds. */
  clock(seconds: number): void;
  /** The extractor holds stdout (pacing). */
  readerPaused(): boolean;
}

export interface FakeExtractOptions {
  /** Bytes written to each output when the run starts; default nothing. */
  content?: (out: FakeExtractOutput, run: FakeExtractRun) => Buffer | string;
  /** Exit at once with this code instead of waiting for release(). */
  exitAt?: (run: FakeExtractRun) => number | null;
}

export function parseExtractionOutputs(args: readonly string[]): FakeExtractOutput[] {
  const outputs: FakeExtractOutput[] = [];
  let map: number | null = null;
  let format: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-i') {
      i++;
      continue;
    }
    if (a === '-map') map = Number(args[++i]!.split(':')[1]);
    else if (a === '-f') format = args[++i]!;
    else if (a.startsWith('file:') && map !== null && format !== null) {
      outputs.push({ streamIndex: map, format, path: a.slice('file:'.length) });
      map = null;
      format = null;
    } else if (a === '-' && format === 'null') {
      map = null;
      format = null;
    }
  }
  return outputs;
}

const numberAfter = (args: readonly string[], flag: string): number | null => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : null;
};

export function fakeExtractor(opts: FakeExtractOptions = {}): { spawn: Spawn; runs: FakeExtractRun[] } {
  const runs: FakeExtractRun[] = [];
  const spawn: Spawn = (args) => {
    let exit!: (e: ExitInfo) => void;
    const exited = new Promise<ExitInfo>((r) => (exit = r));
    let header = false;
    const outputs = parseExtractionOutputs(args);
    const run: FakeExtractRun = {
      args,
      pass: outputs.some((o) => basename(o.path).startsWith('p2-')) ? 2 : 1,
      seekS: numberAfter(args, '-ss'),
      untilS: numberAfter(args, '-t'),
      paced: args.includes('framehash'),
      outputs,
      signals: [],
      ended: false,
      release(code = 0) {
        if (run.ended) return;
        run.ended = true;
        stdout.end();
        stderr.end();
        exit({ exitCode: code, signal: null, error: null });
      },
      clock(seconds) {
        if (run.ended) return;
        if (!header) stdout.write(['#software: fake', '#tb 0: 1/1000', '#media_type 0: video', ''].join('\n'));
        header = true;
        const ms = String(Math.round(seconds * 1000)).padStart(10);
        stdout.write(`0, ${ms}, ${ms}, 41, 1000, ${run.paced ? '0'.repeat(128) : '0x00000000'}\n`);
      },
      readerPaused: () => stdout.isPaused(),
    };
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    runs.push(run);
    for (const o of run.outputs) writeFileSync(o.path, opts.content?.(o, run) ?? '');
    const code = opts.exitAt?.(run) ?? null;
    if (code !== null) setImmediate(() => run.release(code));
    const child: ChildLike = {
      stdout,
      stderr,
      kill(signal) {
        run.signals.push(signal);
        if (!run.ended) {
          run.ended = true;
          stdout.destroy();
          stderr.destroy();
          exit({ exitCode: null, signal, error: null });
        }
        return true;
      },
      exited,
    };
    return child;
  };
  return { spawn, runs };
}

/** PGS segments (.sup): "PG", PTS and DTS in 90 kHz ticks, type, size, payload. */
export function supSegments(ptsMs: readonly number[], payload = 4): Buffer {
  return Buffer.concat(
    ptsMs.map((ms, i) => {
      const b = Buffer.alloc(13 + payload, i & 0xff);
      b.write('PG', 0, 'latin1');
      b.writeUInt32BE(Math.round(ms * 90), 2);
      b.writeUInt32BE(0, 6);
      b.writeUInt8(0x16, 10);
      b.writeUInt16BE(payload, 11);
      return b;
    }),
  );
}

/** A WebVTT file as ffmpeg's muxer writes it, one cue per start time (1 s long). */
export function vttOf(startsMs: readonly number[], text = (i: number) => `cue ${i}`): string {
  const t = (ms: number) => {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor(ms / 60_000) % 60;
    const s = Math.floor(ms / 1000) % 60;
    const f = ms % 1000;
    return `${h > 0 ? `${String(h).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
  };
  return `WEBVTT\n${startsMs.map((ms, i) => `\n${t(ms)} --> ${t(ms + 1000)}\n${text(i)}\n`).join('')}`;
}
