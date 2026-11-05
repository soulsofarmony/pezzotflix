// The ffprobe runner's child-process path, with fake ffprobe scripts run by node (no ffprobe needed):
// arguments, exit codes with the stderr tail, timeout, cancellation, invalid output, missing binary.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFfprobeRunner } from '../src/modules/analyzer/ffprobe.ts';

let dir: string;
const script = (name: string, body: string): string => {
  const p = join(dir, `${name}.mjs`);
  writeFileSync(p, body);
  return p;
};
const fake = (scriptPath: string, opts: { timeoutMs?: number; frameTimeoutMs?: number } = {}) =>
  createFfprobeRunner(process.execPath, { ...opts, argsPrefix: [scriptPath] });
const signal = () => new AbortController().signal;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pzf-ffprobe-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('ffprobe runner', () => {
  it('passes an argument array with a file: input and parses the output', async () => {
    const echo = script('echo', 'process.stdout.write(JSON.stringify({ streams: [], format: { format_name: "matroska,webm" }, argv: process.argv.slice(2) }));');
    const out = await fake(echo).probe('/media/Film/A (2001)/A (2001).mkv', signal());
    expect(out.format?.format_name).toBe('matroska,webm');
    expect(out.argv).toEqual(['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', '-i', 'file:/media/Film/A (2001)/A (2001).mkv']);
  });

  it('reports a non-zero exit with the tail of stderr', async () => {
    const failing = script('exit3', 'for (let i = 1; i <= 7; i++) process.stderr.write(`line ${i}\\n`); process.exitCode = 3;');
    await expect(fake(failing).probe('x.mkv', signal())).rejects.toThrow('ffprobe exit 3: line 3 | line 4 | line 5 | line 6 | line 7');
  });

  it('kills a probe that runs past its timeout', async () => {
    const hang = script('hang', 'setTimeout(() => {}, 30_000);');
    await expect(fake(hang, { timeoutMs: 300 }).probe('x.mkv', signal())).rejects.toThrow('ffprobe timed out');
  });

  it('kills a probe when the job is cancelled', async () => {
    const hang = script('hang2', 'setTimeout(() => {}, 30_000);');
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    await expect(fake(hang).probe('x.mkv', abort.signal)).rejects.toThrow('ffprobe canceled');
  });

  it('rejects output that is not JSON or not ffprobe JSON', async () => {
    const garbage = script('garbage', 'process.stdout.write("not json");');
    await expect(fake(garbage).probe('x.mkv', signal())).rejects.toThrow('ffprobe printed invalid JSON: "not json"');
    const wrong = script('wrong', 'process.stdout.write(JSON.stringify({ streams: "nope" }));');
    await expect(fake(wrong).probe('x.mkv', signal())).rejects.toThrow(/unexpected ffprobe output/);
  });

  it('says so when the configured ffprobe does not exist', async () => {
    const runner = createFfprobeRunner(join(dir, 'missing', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
    await expect(runner.probe('x.mkv', signal())).rejects.toThrow(/^ffprobe not found/);
  });

  it('reads the side data of the first frame, and fails on unexpected frame output', async () => {
    const frames = script(
      'frames',
      'process.stdout.write(JSON.stringify({ frames: [{ side_data_list: [{ side_data_type: "Mastering display metadata" }, { side_data_type: "HDR Dynamic Metadata SMPTE2094-40 (HDR10+)" }] }], argv: process.argv.slice(2) }));',
    );
    expect(await fake(frames).firstFrameSideData('x.mkv', 0, signal())).toEqual([
      'Mastering display metadata',
      'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)',
    ]);
    const bad = script('badframes', 'process.stdout.write(JSON.stringify({ frames: "nope" }));');
    await expect(fake(bad).firstFrameSideData('x.mkv', 0, signal())).rejects.toThrow(/unexpected ffprobe frame output/);
  });
});
