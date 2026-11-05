// The kill order of an ffmpeg run (ADR 0003 D7) on a fake child: graceful destroys stdout first, then
// SIGTERM and SIGKILL after the grace period; a discarded run gets SIGKILL at once.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { binaryExists, type ChildLike, execaSpawn, type ExitInfo, terminate } from '../src/modules/delivery/process.ts';
import { tempDir } from './helpers/delivery-media.ts';

function fakeChild(opts: { exitOn: NodeJS.Signals[] }) {
  const calls: string[] = [];
  let exit!: (e: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((r) => (exit = r));
  const stdout = new PassThrough();
  const destroy = stdout.destroy.bind(stdout);
  stdout.destroy = (err?: Error) => {
    calls.push('stdout.destroy');
    return destroy(err);
  };
  const child: ChildLike = {
    stdout,
    stderr: new PassThrough(),
    kill(signal) {
      calls.push(signal);
      if (opts.exitOn.includes(signal)) exit({ exitCode: null, signal, error: null });
      return true;
    },
    exited,
  };
  return { child, calls };
}

/** Timers the test fires by hand. */
function manualTimers() {
  const pending: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const t = { fn, ms, cleared: false };
        pending.push(t);
        return t;
      },
      clearTimeout: (t: unknown) => {
        (t as { cleared: boolean }).cleared = true;
      },
    },
    fire: () => pending.filter((t) => !t.cleared).forEach((t) => t.fn()),
    pending,
  };
}

describe('terminate', () => {
  it('graceful: stdout first, then SIGTERM; no SIGKILL when the process exits', async () => {
    const { child, calls } = fakeChild({ exitOn: ['SIGTERM'] });
    const m = manualTimers();
    await terminate(child, 'graceful', 2000, m.timers);
    expect(calls).toEqual(['stdout.destroy', 'SIGTERM']);
    expect(m.pending).toMatchObject([{ ms: 2000, cleared: true }]);
  });

  it('graceful: SIGKILL after the grace period when SIGTERM is ignored (blocked on a full pipe)', async () => {
    const { child, calls } = fakeChild({ exitOn: ['SIGKILL'] });
    const m = manualTimers();
    const done = terminate(child, 'graceful', 2000, m.timers);
    await Promise.resolve();
    expect(calls).toEqual(['stdout.destroy', 'SIGTERM']);
    m.fire();
    await done;
    expect(calls).toEqual(['stdout.destroy', 'SIGTERM', 'SIGKILL']);
  });

  it('discard: SIGKILL at once, never SIGTERM', async () => {
    const { child, calls } = fakeChild({ exitOn: ['SIGKILL'] });
    const m = manualTimers();
    await terminate(child, 'discard', 2000, m.timers);
    expect(calls).toEqual(['SIGKILL', 'stdout.destroy']);
    expect(m.pending).toEqual([]);
  });
});

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  let s = '';
  for await (const c of stream) s += String(c);
  return s;
}

describe('execaSpawn on a binary that cannot run', () => {
  it('a missing binary: an exited child with "ffmpeg not found", never a throw', async () => {
    const dir = tempDir('pzf-spawn-');
    try {
      const missing = join(dir, 'no-ffmpeg');
      expect(binaryExists(missing)).toBe(false);
      const child = execaSpawn(missing)(['-version']);
      expect(await child.exited).toEqual({ exitCode: null, signal: null, error: `ffmpeg not found: ${missing}` });
      expect(child.kill('SIGKILL')).toBe(false);
      expect(await text(child.stdout)).toBe('');
      // On PATH by name (PATHEXT on Windows), and by absolute path.
      expect(binaryExists('node')).toBe(true);
      expect(binaryExists(process.execPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a file that is not a program: the real execa outcome is a failure, never a throw', async () => {
    const dir = tempDir('pzf-spawn-');
    try {
      const fake = join(dir, process.platform === 'win32' ? 'fake.exe' : 'fake');
      writeFileSync(fake, 'not a program');
      const child = execaSpawn(fake)(['-version']);
      await text(child.stdout);
      const exit = await child.exited;
      expect(exit.error !== null || (exit.exitCode ?? 0) !== 0 || exit.signal !== null).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
