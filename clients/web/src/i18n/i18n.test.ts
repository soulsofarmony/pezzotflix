import { describe, expect, it } from 'vitest';
import { channelLabel, codecName, formatBytes, formatClock, formatDuration, formatRelative, languageName } from './format.ts';
import { it as messages } from './it.ts';
import { t, tMaybe } from './t.ts';

describe('t', () => {
  it('fills the parameters', () => {
    expect(t('player.resumeFrom', { time: '1:02:03' })).toBe('Riprendi da 1:02:03');
  });

  it('every message is non-empty Italian text', () => {
    for (const [key, value] of Object.entries(messages)) expect(value.trim(), key).not.toBe('');
  });

  it('tMaybe falls back for keys built at runtime', () => {
    expect(tMaybe('kind.nope', 'x')).toBe('x');
  });
});

describe('format (it-IT)', () => {
  it.each([
    [107 * 60_000, '1 h 47 min'],
    [47 * 60_000, '47 min'],
    [2 * 3_600_000, '2 h'],
    [25_000, '25 s'],
  ])('formatDuration(%d) → %s', (ms, s) => {
    expect(formatDuration(ms)).toBe(s);
  });

  it.each([
    [0, '0:00'],
    [61_000, '1:01'],
    [3_723_000, '1:02:03'],
  ])('formatClock(%d) → %s', (ms, s) => {
    expect(formatClock(ms)).toBe(s);
  });

  it('formatRelative', () => {
    const now = Date.parse('2026-11-05T12:00:00Z');
    expect(formatRelative(now - 3 * 86_400_000, now)).toBe('3 giorni fa');
    expect(formatRelative(now - 86_400_000, now)).toBe('ieri');
  });

  it('formatBytes', () => {
    expect(formatBytes(1500)).toMatch(/^2\skB$/);
    expect(formatBytes(48_300_000_000)).toMatch(/^48,3\sGB$/);
  });

  it('languageName from ISO 639-2 B and T codes', () => {
    expect(languageName('ita')).toBe('Italiano');
    expect(languageName('ger')).toBe('Tedesco');
    expect(languageName('eng')).toBe('Inglese');
    expect(languageName(null)).toBeNull();
  });

  it('codec and channel labels', () => {
    expect(codecName('truehd')).toBeTruthy();
    expect(codecName(null)).toBeNull();
    expect(channelLabel(6, '5.1(side)')).toBe('5.1');
    expect(channelLabel(8, null)).toBe('7.1');
    expect(channelLabel(2, 'stereo')).toBe('2.0');
  });
});
