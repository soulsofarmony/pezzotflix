// Keyframe index sanity checks without tools: the duration rule, and hostile or implausible Cues
// (TimestampScale, CueTime, dense or gappy points) that fall back to the probe with advice. Synthetic
// MKVs in a temp dir, a fake probe.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BAD_CUES_ADVICE,
  BAD_DURATION_ADVICE,
  buildKeyframeIndex,
  IndexBuildError,
  MAX_MEDIA_MS,
  NO_CUES_ADVICE,
  plausibleDuration,
} from '../src/modules/delivery/keyframe-index.ts';
import type { DeliveryProbe } from '../src/modules/delivery/probe.ts';
import { fakeMkv, type FakeMkvOptions } from './helpers/delivery-builders.ts';
import { tempDir } from './helpers/delivery-media.ts';

const dir = tempDir('pzf-kfi-');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GOP2 = Array.from({ length: 30 }, (_, i) => i * 2000);

/** A probe over fixed keyframes; counts the seek targets it was given. */
function probeOver(keyframes: number[], rawDurationMs: number | null) {
  const calls = { targets: 0 };
  const probe: DeliveryProbe = {
    timeline: async () => ({ startTimeMs: 0, rawDurationMs, videoStreamIndex: 0 }),
    keyframesAt: async (_abs, _idx, targets) => {
      calls.targets += targets.length;
      const out: { ptsMs: number; pos: number | null }[] = [];
      for (const t of targets) {
        const k = keyframes.find((x) => x >= t);
        if (k !== undefined) out.push({ ptsMs: k, pos: null });
      }
      return out;
    },
  };
  return { probe, calls };
}

let n = 0;
async function build(mkv: FakeMkvOptions | null, probe: DeliveryProbe, allowProbe: boolean, videoStreamIndex: number | null = null) {
  const abs = join(dir, `f${n++}.mkv`);
  const bytes = mkv ? fakeMkv(mkv) : Buffer.from('not used');
  writeFileSync(abs, bytes);
  return buildKeyframeIndex(
    { fileId: 'f', sizeBytes: bytes.length, mtimeMs: 1, absPath: abs, container: mkv ? 'matroska' : 'mp4', videoStreamIndex, allowProbe, targetMs: 4000, maxGapMs: 6000, now: () => 0 },
    probe,
  );
}

describe('plausibleDuration', () => {
  it.each([
    ['matroska: Duration is the last timestamp, start_time comes off', 'matroska', 63_500, 3500, 60_000, true],
    ['a muxer that already subtracted the start', 'matroska', 60_000, 3500, 60_000, true],
    ['mp4: duration as is', 'mp4', 60_000, 3500, 60_000, true],
    ['shorter than the last keyframe: last + median GOP', 'matroska', 30_000, 0, 60_000, false],
    ['31 years: last + median GOP', 'matroska', 1e12, 0, 60_000, false],
    ['more than 60 s past the last keyframe', 'matroska', 200_000, 0, 60_000, false],
    ['unknown', 'matroska', null, 0, 60_000, false],
  ] as const)('%s', (_l, container, raw, start, want, ok) => {
    expect(plausibleDuration(container, raw, start, GOP2)).toEqual({ durationMs: want, declaredOk: ok });
  });

  it('never above 7 days', () => {
    const times = [0, MAX_MEDIA_MS - 1000];
    expect(plausibleDuration('mp4', MAX_MEDIA_MS + 10_000, 0, times).declaredOk).toBe(false);
  });
});

describe('buildKeyframeIndex on hostile Cues', () => {
  const none = probeOver([], null).probe;

  it('plausible Cues: complete index, the declared duration kept', async () => {
    const r = await build({ cues: GOP2, durationMs: 60_000 }, none, false);
    expect(r).toMatchObject({ ok: true, index: { source: 'cues', complete: true, durationMs: 60_000, advice: null, videoStreamIndex: 0 } });
  });

  it('a hostile Duration with good Cues: the keyframes stand, the duration is replaced, with advice', async () => {
    const r = await build({ cues: GOP2, durationMs: 1e300 }, none, false);
    expect(r).toMatchObject({ ok: true, index: { source: 'cues', durationMs: 60_000, advice: BAD_DURATION_ADVICE } });
  });

  it('a TimestampScale of 1 ns makes 2 s GOPs 2 µs apart: dense Cues, rebuilt by the probe', async () => {
    const r = await build({ cues: GOP2, timestampScaleNs: 1 }, none, false);
    expect(r).toEqual({ ok: false, reason: 'needs_probe', advice: BAD_CUES_ADVICE, videoStreamIndex: 0 });
  });

  it('a CueTime of 2⁴⁷ ticks (4.5 millennia): rejected, rebuilt by the probe', async () => {
    const r = await build({ cues: [0, 2000, 2 ** 47] }, none, false);
    expect(r).toMatchObject({ ok: false, reason: 'needs_probe' });
    expect(r.ok ? '' : r.advice).toContain(BAD_CUES_ADVICE);
  });

  it('sparse Cues (a point every 30 s): not every keyframe, rebuilt by the probe', async () => {
    const r = await build({ cues: [0, 30_000, 60_000], durationMs: 62_000 }, none, false);
    expect(r).toEqual({ ok: false, reason: 'needs_probe', advice: BAD_CUES_ADVICE, videoStreamIndex: 0 });
  });

  it('the stream asked for is not a video track: no Cues used, labelled with the stream asked for', async () => {
    const r = await build({ cues: GOP2 }, none, false, 1);
    expect(r).toEqual({ ok: false, reason: 'needs_probe', advice: NO_CUES_ADVICE, videoStreamIndex: 1 });
  });
});

describe('buildKeyframeIndex with the probe', () => {
  it('a hostile declared duration does not drive the probe: targets capped, the end of the content stops it', async () => {
    const { probe, calls } = probeOver(GOP2, 1e15);
    const t0 = performance.now();
    const r = await build(null, probe, true);
    expect(performance.now() - t0).toBeLessThan(2000);
    if (!r.ok) throw new Error('probe index expected');
    // 10¹⁵ ms would be 2.5·10¹¹ targets: capped (the real probe also stops once a batch finds nothing new).
    expect(calls.targets).toBeLessThanOrEqual(50_000);
    expect(r.index).toMatchObject({ source: 'probe', complete: false, durationMs: 60_000, advice: BAD_DURATION_ADVICE });
    expect(r.index.times).toEqual(GOP2.filter((t) => t % 4000 === 0));
  });

  it('no keyframes at all: IndexBuildError (deterministic, cached as a failure by the caller)', async () => {
    await expect(build(null, probeOver([], 60_000).probe, true)).rejects.toBeInstanceOf(IndexBuildError);
  });
});
