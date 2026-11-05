import { describe, expect, it } from 'vitest';
import { parseTimestamp, VttStreamParser } from './vtt.ts';

describe('parseTimestamp', () => {
  it.each([
    ['00:01.500', 1.5],
    ['01:02.250', 62.25],
    ['1:00:00.000', 3600],
    ['10:00:01.001', 36_001.001],
  ])('%s → %d s', (s, v) => {
    expect(parseTimestamp(s)).toBeCloseTo(v, 6);
  });
});

describe('VttStreamParser', () => {
  const FILE = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500 align:start\nCiao\n\n00:01:00.000 --> 00:01:03.000\n<i>Due</i>\nrighe\n\n';

  it('parses a whole file', () => {
    const p = new VttStreamParser();
    const cues = [...p.push(FILE), ...p.end()];
    expect(cues).toEqual([
      { startS: 1, endS: 2.5, text: 'Ciao' },
      { startS: 60, endS: 63, text: '<i>Due</i>\nrighe' },
    ]);
  });

  it('emits a cue only when its block is complete, across arbitrary chunks', () => {
    const p = new VttStreamParser();
    const out: ReturnType<VttStreamParser['push']> = [];
    for (let i = 0; i < FILE.length; i += 7) out.push(...p.push(FILE.slice(i, i + 7)));
    out.push(...p.end());
    expect(out.map((c) => c.text)).toEqual(['Ciao', '<i>Due</i>\nrighe']);
  });

  it('keeps a partial block until more data arrives (growing file)', () => {
    const p = new VttStreamParser();
    expect(p.push('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPri')).toEqual([]);
    expect(p.push('mo\n\n')).toEqual([{ startS: 1, endS: 2, text: 'Primo' }]);
  });

  it('does not split a cue when a CRLF falls across two chunks', () => {
    const p = new VttStreamParser();
    const out = [...p.push('WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r'), ...p.push('\nUno\r'), ...p.push('\ndue\r\n\r\n'), ...p.end()];
    expect(out).toEqual([{ startS: 1, endS: 2, text: 'Uno\ndue' }]);
  });

  it('handles CRLF and skips NOTE, STYLE and empty cues', () => {
    const p = new VttStreamParser();
    const cues = [...p.push('WEBVTT\r\n\r\nNOTE hello\r\n\r\nSTYLE\r\n::cue {}\r\n\r\n00:00:05.000 --> 00:00:06.000\r\n\r\n00:00:07.000 --> 00:00:08.000\r\nOk\r\n'), ...p.end()];
    expect(cues).toEqual([{ startS: 7, endS: 8, text: 'Ok' }]);
  });
});
