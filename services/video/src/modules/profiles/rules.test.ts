import { describe, expect, it } from 'vitest';
import {
  type EpisodeActivity,
  isCompleted,
  isInProgress,
  pickNextUp,
  progressPercent,
  RESUME_MIN_POSITION_MS,
  resumeFrom,
  viewingOrder,
} from './rules.ts';

const D = 100_000;

describe('thresholds', () => {
  it.each([
    [0, D, false, false],
    [89_999, D, false, false],
    [90_000, D, false, true],
    [10, D, true, true], // ended wins
    [50_000, null, false, false], // unknown duration: only `ended` completes
    [50_000, 0, false, false],
  ] as const)('isCompleted(%j, %j, ended=%j) = %j', (pos, dur, ended, out) => {
    expect(isCompleted(pos, dur, ended)).toBe(out);
  });

  it.each([
    [0, D, false],
    [1_999, D, false], // under 2 % (D3)
    [2_000, D, true],
    [89_999, D, true],
    [90_000, D, false],
    [5_000, 0, true], // unknown duration
  ] as const)('isInProgress(%j, %j) = %j', (pos, dur, out) => {
    expect(isInProgress(pos, dur)).toBe(out);
  });

  it.each([
    [0, 7_200_000, null],
    [RESUME_MIN_POSITION_MS - 1, 7_200_000, null],
    [RESUME_MIN_POSITION_MS, 7_200_000, RESUME_MIN_POSITION_MS],
    [3_600_000, 7_200_000, 3_600_000],
    [6_480_000, 7_200_000, null], // 90 %
    [60_000, 0, 60_000], // unknown duration still resumes
    [60_000, 10_000_000, 60_000], // under 2 %: not in Continue watching, but resumable
  ] as const)('resumeFrom(%j, %j) = %j', (pos, dur, out) => {
    expect(resumeFrom(pos, dur)).toBe(out);
  });

  it.each([
    [50, 200, 25],
    [300, 200, 100],
    [10, 0, 0],
  ] as const)('progressPercent(%j, %j) = %j', (pos, dur, out) => {
    expect(progressPercent(pos, dur)).toBe(out);
  });
});

describe('viewingOrder', () => {
  it.each([
    ['specials go last', [['sp1', 0], ['a1', 1], ['a2', 1], ['b1', 2]], ['a1', 'a2', 'b1', 'sp1']],
    ['only specials keep their order', [['sp1', 0], ['sp2', 0]], ['sp1', 'sp2']],
    ['episodes without season stay regular', [['x', null], ['sp', 0]], ['x', 'sp']],
    ['empty', [], []],
  ] as const)('%s', (_name, eps, out) => {
    expect(viewingOrder(eps.map(([id, seasonNumber]) => ({ id, seasonNumber })))).toEqual(out);
  });
});

describe('pickNextUp', () => {
  const order = ['e1', 'e2', 'e3', 'e4'];
  const act = (entries: [string, Partial<EpisodeActivity>][]) =>
    new Map(entries.map(([id, a]) => [id, { watched: false, inProgress: false, lastAt: 0, ...a }]));
  const all = () => true;

  it.each([
    ['nothing watched → first episode', [], all, 'e1'],
    ['after the last watched one', [['e1', { watched: true, lastAt: 1 }], ['e2', { watched: true, lastAt: 2 }]], all, 'e3'],
    ['the most recent activity wins over order', [['e3', { watched: true, lastAt: 1 }], ['e1', { watched: true, lastAt: 5 }]], all, 'e2'],
    ['skips watched episodes after the anchor', [['e1', { watched: true, lastAt: 5 }], ['e2', { watched: true, lastAt: 1 }]], all, 'e3'],
    ['an in-progress anchor is resumed', [['e1', { watched: true, lastAt: 1 }], ['e2', { inProgress: true, lastAt: 2 }]], all, 'e2'],
    ['same timestamp: the later episode is the anchor', [['e1', { watched: true, lastAt: 3 }], ['e2', { watched: true, lastAt: 3 }]], all, 'e3'],
    ['finale watched with earlier gaps → first gap', [['e4', { watched: true, lastAt: 9 }], ['e1', { watched: true, lastAt: 1 }]], all, 'e2'],
    ['everything watched → null', [['e1', { watched: true }], ['e2', { watched: true }], ['e3', { watched: true }], ['e4', { watched: true }]], all, null],
    ['skips episodes without media', [['e1', { watched: true, lastAt: 1 }]], (id: string) => id !== 'e2', 'e3'],
    ['in-progress anchor without media moves on', [['e2', { inProgress: true, lastAt: 1 }]], (id: string) => id !== 'e2', 'e3'],
  ] as const)('%s', (_name, entries, playable, out) => {
    expect(pickNextUp(order, act(entries as unknown as [string, Partial<EpisodeActivity>][]), playable)).toBe(out);
  });

  // Viewing order puts specials last: e1 e2 e3 sp1 sp2.
  const withSpecials = ['e1', 'e2', 'e3', 'sp1', 'sp2'];
  const special = (id: string) => id.startsWith('sp');
  it.each([
    ['a special watched last does not anchor', [['e1', { watched: true, lastAt: 1 }], ['sp1', { watched: true, lastAt: 5 }]], 'e2'],
    ['a special in progress does not anchor', [['e2', { watched: true, lastAt: 1 }], ['sp2', { inProgress: true, lastAt: 5 }]], 'e3'],
    ['only specials watched → first regular episode', [['sp1', { watched: true, lastAt: 5 }]], 'e1'],
    ['regular episodes done → the unwatched specials', [['e1', { watched: true }], ['e2', { watched: true }], ['e3', { watched: true, lastAt: 3 }], ['sp1', { watched: true, lastAt: 9 }]], 'sp2'],
  ] as const)('specials: %s', (_name, entries, out) => {
    expect(pickNextUp(withSpecials, act(entries as unknown as [string, Partial<EpisodeActivity>][]), all, special)).toBe(out);
  });

  it('a series of only specials anchors on them', () => {
    expect(pickNextUp(['sp1', 'sp2'], act([['sp1', { watched: true, lastAt: 1 }]]), all, special)).toBe('sp2');
  });
});
