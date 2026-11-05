// Catalog read side, pure parts: badges, version labels, search terms, cursors, image keys.
import { describe, expect, it } from 'vitest';
import { ProblemError } from '../src/app/problem.ts';
import { audioCodecLabel, type AudioSignal, badgesOf, channelsLabel, resolutionLabel, type Signals, type VideoSignal } from '../src/modules/catalog/badges.ts';
import { compareKeys, decodeCursor, encodeCursor } from '../src/modules/catalog/cursor.ts';
import { imageKeyOf, imageRef } from '../src/modules/catalog/read.ts';
import { foldForContains, ftsQuery, needsSubstringSearch, searchTerms } from '../src/modules/catalog/search.ts';
import { factsOf } from './helpers/catalog-seed.ts';
import { versionLabel } from '../src/modules/catalog/badges.ts';

const v = (width: number, height: number, hdr: VideoSignal['hdr'] = 'SDR', hdrFallback: VideoSignal['hdrFallback'] = []): VideoSignal => ({ width, height, hdr, hdrFallback });
const a = (codec: string, over: Partial<AudioSignal> = {}): AudioSignal => ({
  codec,
  profile: null,
  channels: 6,
  lossless: false,
  objectAudio: null,
  commentary: false,
  language: null,
  ...over,
});
const sig = (video: VideoSignal[], audio: AudioSignal[] = []): Signals => ({ video, audio });

describe('badges', () => {
  it.each([
    ['UHD', [sig([v(3840, 2160)])], ['4K']],
    ['scope UHD', [sig([v(3840, 1600)])], ['4K']],
    ['scope 1080p', [sig([v(1920, 800)])], ['1080p']],
    ['720p has no badge', [sig([v(1280, 720)])], []],
    ['best resolution only, across versions', [sig([v(1920, 1080)]), sig([v(3840, 2160)])], ['4K']],
    ['DV with HDR10 base', [sig([v(3840, 2160, 'DV', ['HDR10'])])], ['4K', 'DV', 'HDR10']],
    ['HDR10+', [sig([v(3840, 2160, 'HDR10+')])], ['4K', 'HDR10+']],
    ['HLG', [sig([v(3840, 2160, 'HLG')])], ['4K', 'HLG']],
    ['SDR shows nothing', [sig([v(1920, 1080, 'SDR')])], ['1080p']],
    ['TrueHD Atmos', [sig([], [a('truehd', { objectAudio: 'atmos', lossless: true, channels: 8 })])], ['Atmos', 'TrueHD']],
    ['E-AC-3 Atmos', [sig([], [a('eac3', { objectAudio: 'atmos' })])], ['Atmos']],
    ['DTS:X over DTS-HD MA', [sig([], [a('dts', { profile: 'DTS-HD MA + DTS:X', objectAudio: 'dtsx', lossless: true })])], ['DTS:X', 'DTS-HD MA']],
    ['DTS-HD MA', [sig([], [a('dts', { profile: 'DTS-HD MA', lossless: true })])], ['DTS-HD MA']],
    ['DTS core is no badge', [sig([], [a('dts', { profile: 'DTS' })])], []],
    ['commentary tracks do not count', [sig([], [a('truehd', { commentary: true })])], []],
    ['nothing', [], []],
  ] as const)('%s', (_name, signals, expected) => {
    expect(badgesOf(signals as unknown as Signals[])).toEqual(expected);
  });
});

describe('labels', () => {
  it.each([
    [3840, 2160, '4K'],
    [1920, 1080, '1080p'],
    [1280, 720, '720p'],
    [720, 576, '576p'],
  ])('%ix%i → %s', (w, h, label) => expect(resolutionLabel(w, h)).toBe(label));

  it.each([
    [a('truehd', { objectAudio: 'atmos' }), 'TrueHD Atmos'],
    [a('dts', { profile: 'DTS-HD MA' }), 'DTS-HD MA'],
    [a('dts', { profile: 'DTS-HD HRA' }), 'DTS-HD'],
    [a('dts', { profile: 'DTS-HD MA + DTS:X', objectAudio: 'dtsx' }), 'DTS:X'],
    [a('eac3'), 'E-AC-3'],
    [a('ac3'), 'AC-3'],
    [a('pcm_s24le'), 'PCM'],
    [a('flac'), 'FLAC'],
  ])('%j → %s', (signal, label) => expect(audioCodecLabel(signal)).toBe(label));

  it.each([
    [8, '7.1'],
    [6, '5.1'],
    [2, '2.0'],
    [1, '1.0'],
    [3, '3ch'],
  ])('%i channels → %s', (n, label) => expect(channelsLabel(n)).toBe(label));

  it('labels the S1 fixtures like doc 03 §3.4', () => {
    expect(versionLabel(factsOf('br2049'))).toBe('4K · HDR10 · TrueHD 5.1 · ITA/ENG');
    expect(versionLabel(factsOf('dune'))).toBe('4K · Dolby Vision · TrueHD 5.1 · ENG/ITA');
    expect(versionLabel(factsOf('ilbuono'))).toBe('1080p · DTS 5.1 · ENG/ITA');
  });
});

describe('search terms', () => {
  it.each([
    ['dune', '"dune"*'],
    ['  Blade   Runner 2049 ', '"Blade"* "Runner"* "2049"*'],
    ["L'ultimo dei Mohicani", '"L"* "ultimo"* "dei"* "Mohicani"*'],
    ['città', '"città"*'],
    ['Неизвестный', '"Неизвестный"*'],
    ['千と千尋', '"千と千尋"*'],
    ['"; DROP TABLE x; --', '"DROP"* "TABLE"* "x"*'],
    ['NEAR(a b) OR c*', '"NEAR"* "a"* "b"* "OR"* "c"*'],
    // FTS5 metacharacters never reach MATCH: quotes, prefix star, column filter, initial token, NOT.
    ['"', null],
    ['*', null],
    ['^dune', '"dune"*'],
    ['dune -part', '"dune"* "part"*'],
    ['title:dune', '"title"* "dune"*'],
    ['NEAR(', '"NEAR"*'],
    ['blade"runner', '"blade"* "runner"*'],
    // NFKC: full-width Latin, ligatures and half-width katakana are folded to the plain letters.
    ['ＤＵＮＥ', '"DUNE"*'],
    ['ﬁlm', '"film"*'],
    ['ｶﾀｶﾅ', '"カタカナ"*'],
    ['!!!', null],
  ])('%j → %j', (q, expected) => expect(ftsQuery(q)).toBe(expected));

  it('normalises decomposed accents to NFC', () => {
    expect(searchTerms('cittè')).toEqual(['cittè']);
  });

  it.each([
    ['千と千尋', true],
    ['神隠し', true],
    ['千と 千尋', false],
    ['citta', false],
    ['Неизв', false],
    ['ｶﾀｶﾅ', true],
  ])('needsSubstringSearch(%j) = %j', (q, expected) => expect(needsSubstringSearch(q)).toBe(expected));

  it('folds for the substring fallback', () => {
    expect(foldForContains('Città')).toBe('citta');
  });
});

describe('cursor', () => {
  it('round-trips and is opaque base64url', () => {
    const c = encodeCursor('items:title:asc', 'dune', '0193');
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c, 'items:title:asc')).toEqual({ key: 'dune', id: '0193' });
  });

  it.each([['garbage!'], [encodeCursor('items:year:asc', 1, 'x')], [Buffer.from('{"o":"items:title:asc"}').toString('base64url')]])(
    'rejects %j for another ordering or shape',
    (c) => {
      expect(() => decodeCursor(c, 'items:title:asc')).toThrow(ProblemError);
    },
  );

  it('compares like SQLite row values', () => {
    expect(compareKeys({ key: 1, id: 'b' }, { key: 2, id: 'a' })).toBeLessThan(0);
    expect(compareKeys({ key: 'a', id: 'b' }, { key: 'a', id: 'a' })).toBeGreaterThan(0);
    expect(compareKeys({ key: 'a', id: 'a' }, { key: 'a', id: 'a' })).toBe(0);
  });
});

describe('images', () => {
  it.each([
    ['ab/abcdef0123456789.webp', 'abcdef0123456789'],
    ['abcdef0123456789', 'abcdef0123456789'],
    ['tmdb\\poster\\k_-9aZ12345.jpg', 'k_-9aZ12345'],
    ['short.jpg', null],
    ['bad key!.jpg', null],
  ])('%s → %s', (path, key) => expect(imageKeyOf(path)).toBe(key));

  it('offers getImage widths per type', () => {
    expect(imageRef('poster', 'abcdef0123456789')).toEqual({
      type: 'poster',
      url: '/video/media/images/abcdef0123456789',
      variants: {
        '160': '/video/media/images/abcdef0123456789?w=160',
        '320': '/video/media/images/abcdef0123456789?w=320',
        '640': '/video/media/images/abcdef0123456789?w=640',
      },
    });
  });
});
