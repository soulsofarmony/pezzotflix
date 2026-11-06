// Delivery's ffprobe errors (round 3, minor 4): an input ffprobe cannot open becomes an errno-coded error, so
// the start answers MEDIA_UNAVAILABLE as for its own fs calls. The ExecaError is real: a Node script stands in
// for ffprobe (argsPrefix), printing what libavformat prints. A real ffprobe on a missing file when installed.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDeliveryProbe, openErrorCode } from '../src/modules/delivery/probe.ts';
import { FFPROBE, HAVE_FFMPEG, tempDir } from './helpers/delivery-media.ts';

const dir = tempDir('pzf-probe-errors-');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A probe whose "ffprobe" prints `stderr` and exits with `code` (`--`: ffprobe's arguments go to the script). */
const fakeFfprobe = (stderr: string, code = 1) =>
  createDeliveryProbe(process.execPath, { argsPrefix: ['-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code})`, '--'] });

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as NodeJS.ErrnoException).code;
};

describe('openErrorCode', () => {
  it.each([
    ['file:C:\\nope\\missing.mkv: No such file or directory\n', 'ENOENT'],
    ['file:/media/Film/x.mkv: Permission denied\r\n', 'EACCES'],
    ['file:/media/x.mkv: Operation not permitted', 'EPERM'],
    ['file:/media/x.mkv/y: Not a directory', 'ENOTDIR'],
    ['[matroska @ 0x1] read error\nfile:/media/x.mkv: Input/output error\n', 'EIO'],
    ['file:/media/x.mkv: Device or resource busy', 'EBUSY'],
    ['file:/media/x.mkv: Too many open files', 'EMFILE'],
    ['file:/media/x.mkv: Invalid data found when processing input\n', null],
    ['[matroska @ 0x1] EBML header parsing failed\n', null],
    // The message inside a line, not its end: not an open error.
    ['Permission denied by the codec, continuing\n', null],
    ['', null],
  ])('%j → %s', (stderr, code) => {
    expect(openErrorCode(stderr)).toBe(code);
  });
});

describe('createDeliveryProbe errors', () => {
  it('ffprobe exiting with "No such file or directory": ENOENT', async () => {
    expect(await codeOf(fakeFfprobe('file:/media/Film/x.mkv: No such file or directory\n').timeline('/media/Film/x.mkv'))).toBe('ENOENT');
  });

  it('ffprobe exiting with "Permission denied": EACCES, on every call of the probe', async () => {
    const probe = fakeFfprobe('file:/media/Film/x.mkv: Permission denied\n');
    expect(await codeOf(probe.timeline('/media/Film/x.mkv'))).toBe('EACCES');
    expect(await codeOf(probe.streamEndMs('/media/Film/x.mkv', 0, null))).toBe('EACCES');
    expect(await codeOf(probe.keyframesAt('/media/Film/x.mkv', 0, [0], { container: 'matroska', bitrateBps: null, maxGopMs: 10_000 }))).toBe('EACCES');
  });

  it('any other failure keeps no code: the stream is broken, not the file', async () => {
    const err = await fakeFfprobe('file:/media/x.mkv: Invalid data found when processing input\n').timeline('/media/x.mkv').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBeUndefined();
    expect((err as Error).message).toMatch(/^timeline probe: ffprobe exit 1: .*Invalid data/);
  });

  it('a missing ffprobe binary is not a file error (spawn ENOENT dropped)', async () => {
    const probe = createDeliveryProbe(join(dir, 'no-ffprobe.exe'));
    expect(await codeOf(probe.timeline('/media/x.mkv'))).toBeUndefined();
  });

  it('a timed out ffprobe is not a file error, whatever it printed', async () => {
    const probe = createDeliveryProbe(process.execPath, {
      timeoutMs: 300,
      argsPrefix: ['-e', 'process.stderr.write("file:/x.mkv: Permission denied\\n"); setTimeout(() => {}, 60000)', '--'],
    });
    // keyframesAt takes the probe's timeout (timeline has its own 30 s).
    const err = await probe.keyframesAt('/x.mkv', 0, [0], { container: 'matroska', bitrateBps: null, maxGopMs: 10_000 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/timed out/);
    expect((err as NodeJS.ErrnoException).code).toBeUndefined();
  });

  it.skipIf(!HAVE_FFMPEG)('a real ffprobe on a missing file: ENOENT (needs ffprobe)', async () => {
    const missing = join(dir, 'missing.mkv');
    expect(await codeOf(createDeliveryProbe(FFPROBE).timeline(missing))).toBe('ENOENT');
  });
});
