import { describe, expect, it } from 'vitest';
import { sidecarTrackId } from '../../shared/media-facts.ts';
import { parseSidecar } from './sidecars.ts';

describe('parseSidecar (library standard §6)', () => {
  const video = 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p.mkv';
  const dir = 'Blade Runner 2049 (2017)/';
  it.each([
    ['Blade Runner 2049 (2017) - 2160p.it.srt', { format: 'srt', language: 'ita', forced: false, sdh: false }],
    ['Blade Runner 2049 (2017) - 2160p.it.forced.srt', { format: 'srt', language: 'ita', forced: true, sdh: false }],
    ['Blade Runner 2049 (2017) - 2160p.en.sdh.srt', { format: 'srt', language: 'eng', forced: false, sdh: true }],
    ['Blade Runner 2049 (2017) - 2160p.it.forced.sup', { format: 'sup', language: 'ita', forced: true, sdh: false }],
    ['Blade Runner 2049 (2017) - 2160p.en.cc.ass', { format: 'ass', language: 'eng', forced: false, sdh: true }],
    ['Blade Runner 2049 (2017) - 2160p.en.hi.srt', { format: 'srt', language: 'eng', forced: false, sdh: true }],
    // "hi" alone means Hindi, not SDH
    ['Blade Runner 2049 (2017) - 2160p.hi.srt', { format: 'srt', language: 'hin', forced: false, sdh: false }],
    ['Blade Runner 2049 (2017) - 2160p.ita.srt', { format: 'srt', language: 'ita', forced: false, sdh: false }],
    // case-insensitive flags and extension (§7.4)
    ['Blade Runner 2049 (2017) - 2160p.IT.FORCED.SRT', { format: 'srt', language: 'ita', forced: true, sdh: false }],
    // a negated flag is a full track
    ['Blade Runner 2049 (2017) - 2160p.it.non.forced.srt', { format: 'srt', language: 'ita', forced: false, sdh: false }],
    ['Blade Runner 2049 (2017) - 2160p.it.non-forced.srt', { format: 'srt', language: 'ita', forced: false, sdh: false }],
    // "no" is Norwegian, not a negation
    ['Blade Runner 2049 (2017) - 2160p.no.forced.srt', { format: 'srt', language: 'nor', forced: true, sdh: false }],
    // no language: still associated, language null (warning sidecar_no_lang downstream)
    ['Blade Runner 2049 (2017) - 2160p.srt', { format: 'srt', language: null, forced: false, sdh: false }],
    ['Blade Runner 2049 (2017) - 2160p.forced.vtt', { format: 'vtt', language: null, forced: true, sdh: false }],
  ])('%s', (name, expected) => {
    const parsed = parseSidecar(video, dir + name);
    expect(parsed).toMatchObject({ ...expected, relPath: dir + name });
    expect(parsed?.id).toMatch(/^x:[0-9a-f]{8}$/);
  });

  it('rejects unsupported formats', () => {
    expect(parseSidecar(video, `${dir}Blade Runner 2049 (2017) - 2160p.it.idx`)).toBeNull();
  });

  it('matches the stem after NFC normalisation', () => {
    const nfd = 'Città (2001).mkv'; // "Città" in NFD
    expect(parseSidecar(nfd, 'Città (2001).it.srt')?.language).toBe('ita');
  });

  it('derives stable track ids from the name only', () => {
    expect(sidecarTrackId('a/Film.it.srt')).toBe(sidecarTrackId('b/Film.it.srt'));
    expect(sidecarTrackId('a/Film.it.srt')).not.toBe(sidecarTrackId('a/Film.en.srt'));
    expect(parseSidecar('a/Film.mkv', 'a/Film.it.srt')?.id).toBe(sidecarTrackId('a/Film.it.srt'));
  });
});
