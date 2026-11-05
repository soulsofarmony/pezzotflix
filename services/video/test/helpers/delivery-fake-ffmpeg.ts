// A fake ffmpeg for the delivery unit tests: emits a synthetic fragmented MP4 (fakeFmp4) from the
// keyframe at or before the `-ss` value, one fragment per chunk, so backpressure and kills behave as
// with a pipe. Each spawn takes the next behavior (the last one repeats).
import { Readable } from 'node:stream';
import type { ChildLike, ExitInfo, Spawn } from '../../src/modules/delivery/process.ts';
import { fakeFmp4 } from './delivery-builders.ts';

export type Behavior =
  | { kind: 'ok' }
  /** Emits this many fragments, then exits with code 1 and the stderr text. */
  | { kind: 'exit'; after: number; stderr: string }
  /** Keyframe PTS shifted by ms (the stream disagrees with the index). */
  | { kind: 'shift'; ms: number }
  /** Keyframes at or after fromMs shifted by ms: the disagreement starts later in the run. */
  | { kind: 'shiftAfter'; fromMs: number; ms: number }
  /** Emits the init, then nothing until killed. */
  | { kind: 'hang' }
  /** Emits this init instead of the default one, then the fragments. */
  | { kind: 'init'; init: Buffer };

export interface FakeRun {
  args: readonly string[];
  seek: number | null;
  signals: string[];
  emitted: number;
  ended: boolean;
}

export function fakeFfmpeg(keyframes: readonly number[], durationMs: number, behaviors: Behavior[]): { spawn: Spawn; runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const spawn = (args: readonly string[]): ChildLike => {
    const ss = args.indexOf('-ss');
    const seek = ss >= 0 ? Number(args[ss + 1]) : null;
    const b = behaviors[runs.length] ?? behaviors.at(-1) ?? { kind: 'ok' };
    const run: FakeRun = { args, seek, signals: [], emitted: 0, ended: false };
    runs.push(run);
    let exit!: (e: ExitInfo) => void;
    const exited = new Promise<ExitInfo>((r) => (exit = r));
    let killed: () => void = () => {};
    const killedP = new Promise<void>((r) => (killed = r));
    const from = seek === null ? keyframes[0]! : (keyframes.filter((k) => k <= seek * 1000).at(-1) ?? keyframes[0]!);
    const shift = b.kind === 'shift' ? b.ms : 0;
    const kfs = keyframes.filter((k) => k >= from).map((k) => k + shift + (b.kind === 'shiftAfter' && k >= b.fromMs ? b.ms : 0));
    const { init, fragments } = fakeFmp4(kfs, durationMs + shift);
    const stderr = new Readable({ read() {} });
    const finish = (code: number) => {
      stderr.push(null);
      run.ended = true;
      exit({ exitCode: code, signal: null, error: null });
    };
    async function* body() {
      yield b.kind === 'init' ? b.init : init;
      if (b.kind === 'hang') await killedP;
      for (const [i, f] of fragments.entries()) {
        if (b.kind === 'exit' && i >= b.after) {
          stderr.push(b.stderr);
          finish(1);
          return;
        }
        run.emitted++;
        yield f;
      }
      finish(0);
    }
    const stdout = Readable.from(body(), { objectMode: false, highWaterMark: 1 });
    return {
      stdout,
      stderr,
      kill(signal) {
        run.signals.push(signal);
        killed();
        stdout.destroy();
        if (!run.ended) {
          run.ended = true;
          exit({ exitCode: null, signal, error: null });
        }
        return true;
      },
      exited,
    };
  };
  return { spawn, runs };
}
