// ffmpeg child processes of Stream Delivery (ADR 0003 D7): execa with stdin ignored, stdout read by the
// segmenter (backpressure throttles ffmpeg through the pipe), stderr into a ring buffer.
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { execa } from 'execa';

export interface ExitInfo {
  exitCode: number | null;
  signal: string | null;
  /** Spawn failure (ffmpeg not found ...). */
  error: string | null;
}

/** The parts of a child process delivery uses; tests pass fakes. */
export interface ChildLike {
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
  readonly exited: Promise<ExitInfo>;
}

export type Spawn = (args: readonly string[]) => ChildLike;

/**
 * Whether a binary can be found: a path must exist, a bare name must be on PATH (with PATHEXT on Windows).
 * On Windows a missing binary otherwise surfaces as "exit 1" with a localized message, not as an error.
 */
export function binaryExists(bin: string): boolean {
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  if (isAbsolute(bin) || /[\\/]/.test(bin)) return isFile(bin) || (process.platform === 'win32' && isFile(`${bin}.exe`));
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE').split(';').filter(Boolean)] : [''];
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir !== '' && exts.some((e) => isFile(join(dir, bin + e))));
}

/** A child that never ran: empty output, exited with a spawn error. */
export function failedChild(error: string): ChildLike {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.end();
  stderr.end();
  return { stdout, stderr, kill: () => false, exited: Promise.resolve({ exitCode: null, signal: null, error }) };
}

export function execaSpawn(ffmpegPath: string, argsPrefix: readonly string[] = []): Spawn {
  let found = false;
  return (args) => {
    // Checked until found once: the binary may be installed while the service runs.
    if (!found) found = binaryExists(ffmpegPath);
    if (!found) return failedChild(`ffmpeg not found: ${ffmpegPath}`);
    const sp = execa(ffmpegPath, [...argsPrefix, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      buffer: false,
      reject: false,
      cleanup: true,
      windowsHide: true,
      // The kill order is ours (terminate below), not execa's.
      forceKillAfterDelay: false,
    });
    const exited: Promise<ExitInfo> = sp.then(
      (r) => ({
        exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
        signal: r.signal ?? null,
        error: r.failed && r.exitCode === undefined && !r.signal ? (r.shortMessage ?? 'spawn failed') : null,
      }),
      (e: unknown) => ({ exitCode: null, signal: null, error: e instanceof Error ? e.message : String(e) }),
    );
    if (!sp.stdout || !sp.stderr) throw new Error('ffmpeg spawned without pipes');
    return { stdout: sp.stdout, stderr: sp.stderr, kill: (s) => sp.kill(s), exited };
  };
}

export type KillMode = 'graceful' | 'discard';

export interface KillTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
}

const realTimers: KillTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
};

/**
 * Stops a run (ADR 0003 D7).
 * On Windows there are no signals: SIGTERM is TerminateProcess, a hard kill like SIGKILL. ffmpeg gets no
 * chance to finish its output, so F1b.4 runs that write files (subtitle extraction) must not rely on a
 * graceful exit to leave a complete file.
 * - graceful (stop, idle, shutdown): destroy stdout first, because an ffmpeg blocked writing to a full
 *   pipe does not handle SIGTERM until the write fails; then SIGTERM, and SIGKILL after graceMs.
 * - discard (seek restart, re-plan, expiry, failure): SIGKILL at once, then stdout is destroyed.
 */
export async function terminate(child: ChildLike, mode: KillMode, graceMs = 2000, timers: KillTimers = realTimers): Promise<ExitInfo> {
  if (mode === 'discard') {
    child.kill('SIGKILL');
    child.stdout.destroy();
    return child.exited;
  }
  child.stdout.destroy();
  child.kill('SIGTERM');
  const t = timers.setTimeout(() => child.kill('SIGKILL'), graceMs);
  try {
    return await child.exited;
  } finally {
    timers.clearTimeout(t);
  }
}
