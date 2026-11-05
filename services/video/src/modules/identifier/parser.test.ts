// Parser table tests: the S4 corpus and holdout (file names and expected parses, frozen by
// spikes/s4-identification/dump_parity.py) and the examples of the library standard
// (ported from spikes/s4-identification/check_standard.py, with every GAP of §8 now closed).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanName, extractTags, parseName, parsePath, type ParsedPath, type RootHint } from './parser.ts';

interface CorpusEntry {
  set: 'corpus' | 'holdout';
  id: string;
  cat: string;
  root: RootHint;
  path: string;
  exp: Record<string, unknown>;
}
const corpus = (JSON.parse(readFileSync(new URL('../../../test/fixtures/identifier-corpus.json', import.meta.url), 'utf8')) as { entries: CorpusEntry[] }).entries;

/** parse_eval.field_ok: compact compare of titles (case, accents, punctuation and spaces ignored). */
const compact = (v: string | null | undefined, field: string): string | null => {
  if (v === null || v === undefined) return null;
  let s = v.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ');
  if (field === 'edition') s = s.replace(/(edition|the)/g, ' ');
  return s.replace(/\s+/g, '') || null;
};

/** The parse in the corpus vocabulary (rules.py field names). */
const asCorpus = (p: ParsedPath): Record<string, unknown> => ({
  kind: p.kind,
  title: p.kind === 'extra' ? p.extraTitle : p.title,
  year: p.year,
  season: p.season,
  episodes: p.episodes,
  edition: p.edition,
  part: p.part,
  extra_type: p.extraType,
  extra_of: p.kind === 'extra' ? (p.extraOf ? p.title : null) : null,
});

function mismatches(entry: CorpusEntry): string[] {
  const got = asCorpus(parsePath(entry.path, entry.root));
  const bad: string[] = [];
  for (const [field, exp] of Object.entries(entry.exp)) {
    const v = got[field];
    let ok: boolean;
    if (field === 'title' || field === 'edition' || field === 'extra_of') {
      ok = exp === null ? compact(v as string | null, field) === null : (exp as string[]).map((x) => compact(x, field)).includes(compact(v as string | null, field));
    } else if (field === 'episodes') ok = JSON.stringify(v ?? null) === JSON.stringify(exp);
    else ok = v === exp;
    if (!ok) bad.push(`${field}: got ${JSON.stringify(v)}, expected ${JSON.stringify(exp)}`);
  }
  return bad;
}

// Sidecars, samples and system folders are filtered by the library (modules/library), not parsed here.
const ownedByLibrary = (e: CorpusEntry) => e.exp.kind === 'sidecar' || e.exp.kind === 'ignore';

describe('parser on the S4 corpus and holdout', () => {
  const entries = corpus.filter((e) => !ownedByLibrary(e));

  it('covers the whole fixture', () => {
    expect(corpus).toHaveLength(159);
    expect(entries.length).toBeGreaterThan(130);
  });

  it.each(entries.map((e) => [`${e.id} ${e.path}`, e] as const))('%s', (_label, entry) => {
    expect(mismatches(entry)).toEqual([]);
  });
});

describe('library standard examples (check_standard.py)', () => {
  type Case = [label: string, path: string, hint: RootHint, expected: Partial<ParsedPath>];
  const cases: Case[] = [
    ['film 4K', 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p.mkv', 'movies', { kind: 'movie', title: 'Blade Runner 2049', year: 2017, reason: null, warnings: [] }],
    ['film 1080p (version)', 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 1080p.mkv', 'movies', { kind: 'movie', title: 'Blade Runner 2049', year: 2017, reason: null }],
    ['film with commas', 'Il Buono, il Brutto, il Cattivo (1966)/Il Buono, il Brutto, il Cattivo (1966).mkv', 'movies', { title: 'Il Buono, il Brutto, il Cattivo', year: 1966 }],
    ["title with ' - '", 'Mission - Impossible (1996)/Mission - Impossible (1996).mkv', 'movies', { title: 'Mission - Impossible', year: 1996 }],
    ['edition in the vocabulary', 'Blade Runner (1982) {edition-Final Cut}/Blade Runner (1982) {edition-Final Cut} - 2160p.mkv', 'movies', { title: 'Blade Runner', year: 1982, edition: 'Final Cut' }],
    ['edition free text (was GAP)', "Zack Snyder's Justice League (2021) {edition-Ultimate Cut}/Zack Snyder's Justice League (2021) {edition-Ultimate Cut}.mkv", 'movies', { title: "Zack Snyder's Justice League", year: 2021, edition: 'Ultimate Cut' }],
    ['ID with year', 'Il Professore (2019) {tmdb-12345}/Il Professore (2019) {tmdb-12345} - 1080p.mkv', 'movies', { title: 'Il Professore', year: 2019, ids: { tmdb: '12345', imdb: null, tvdb: null } }],
    ['ID without year (was GAP)', 'Il Professore {tmdb-12345}/Il Professore {tmdb-12345}.mkv', 'movies', { title: 'Il Professore', year: null, ids: { tmdb: '12345', imdb: null, tvdb: null } }],
    ['IMDb tag, any order', 'Heat (1995) {edition-Director} {imdb-tt0113277}/Heat (1995) {imdb-tt0113277} {edition-Director}.mkv', 'movies', { title: 'Heat', ids: { tmdb: null, imdb: 'tt0113277', tvdb: null }, edition: 'Director' }],
    ['placeholder tag ignored', 'Il Professore {tmdb-NNNNN}/Il Professore {tmdb-NNNNN}.mkv', 'movies', { title: 'Il Professore', ids: { tmdb: null, imdb: null, tvdb: null } }],
    ['extra Trailers/', 'Blade Runner 2049 (2017)/Trailers/Trailer ufficiale.mkv', 'movies', { kind: 'extra', extraType: 'trailer', title: 'Blade Runner 2049', extraTitle: 'Trailer ufficiale', extraOf: { folder: 'Blade Runner 2049 (2017)', kind: 'movie', season: null } }],
    ['extra Behind The Scenes/', 'Il Buono, il Brutto, il Cattivo (1966)/Behind The Scenes/Il making of.mkv', 'movies', { kind: 'extra', extraType: 'behind-the-scenes' }],
    ['extra IT dietro le quinte/', 'Blade Runner 2049 (2017)/dietro le quinte/Il making of.mkv', 'movies', { kind: 'extra', extraType: 'behind-the-scenes' }],
    ['extra Plex suffix', 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017)-trailer.mkv', 'movies', { kind: 'extra', extraType: 'trailer', title: 'Blade Runner 2049', extraTitle: 'Trailer', extraTitleIsLabel: true }],
    ['extra Other/', 'Blade Runner 2049 (2017)/Other/Galleria.mkv', 'movies', { kind: 'extra', extraType: 'other' }],
    ['season extra (was GAP)', 'Dark (2017)/Season 01/Extras/Recap.mkv', 'series', { kind: 'extra', title: 'Dark', extraOf: { folder: 'Dark (2017)', kind: 'series', season: 1 } }],
    ['series extra', 'Dark (2017)/Extras/Recap.mkv', 'series', { kind: 'extra', extraOf: { folder: 'Dark (2017)', kind: 'series', season: null } }],
    ['season extra, Plex suffix', 'Dark (2017)/Season 01/Dark-trailer.mkv', 'series', { kind: 'extra', extraType: 'trailer', extraTitleIsLabel: true, extraOf: { folder: 'Dark (2017)', kind: 'series', season: 1 } }],
    ['season extra, bare trailer', 'Dark (2017)/Season 02/trailer.mkv', 'series', { kind: 'extra', extraType: 'trailer', extraOf: { folder: 'Dark (2017)', kind: 'series', season: 2 } }],
    ['season extra in a movie root', 'Film/Dark (2017)/Season 01/Extras/x.mkv', 'movies', { kind: 'extra', extraOf: { folder: 'Film/Dark (2017)', kind: 'series', season: 1 } }],
    ['innermost typed extras folder wins', 'Dune (2021)/Extras/Featurettes/Making.mkv', 'movies', { kind: 'extra', extraType: 'featurette', extraTitle: 'Making', extraOf: { folder: 'Dune (2021)', kind: 'movie', season: null } }],
    ['untyped inner folder keeps the outer type', 'Dune (2021)/Trailers/Extras/Teaser 2.mkv', 'movies', { kind: 'extra', extraType: 'trailer' }],
    ['movie Plex suffix stays without season', 'Dune (2021)/Dune (2021)-featurette.mkv', 'movies', { kind: 'extra', extraType: 'featurette', extraOf: { folder: 'Dune (2021)', kind: 'movie', season: null } }],
    ['episode Season NN', 'The Office (2005) {tmdb-2316}/Season 01/The Office (2005) {tmdb-2316} - S01E01 - Pilot.mkv', 'series', { kind: 'episode', title: 'The Office', year: 2005, season: 1, episodes: [1], episodeTitle: 'Pilot', ids: { tmdb: '2316', imdb: null, tvdb: null }, warnings: [], workFolder: 'The Office (2005) {tmdb-2316}' }],
    ['multi-episode', 'The Office (2005) {tmdb-2316}/Season 01/The Office (2005) {tmdb-2316} - S01E02-E03.mkv', 'series', { kind: 'episode', season: 1, episodes: [2, 3], episodeTitle: null, warnings: [] }],
    ['episode range', 'Dark (2017)/Season 01/Dark - S01E02-E05.mkv', 'series', { episodes: [2, 3, 4, 5] }],
    ['special Season 00', 'The Office (2005) {tmdb-2316}/Season 00/The Office (2005) {tmdb-2316} - S00E01 - Webisode.mkv', 'series', { kind: 'episode', season: 0, episodes: [1], warnings: [] }],
    ['episode Stagione NN', 'Dark (2017)/Stagione 01/Dark (2017) - S01E01.mkv', 'series', { kind: 'episode', title: 'Dark', season: 1, episodes: [1], warnings: [] }],
    ['documentary', 'Free Solo (2018)/Free Solo (2018) - 2160p.mkv', 'movies', { kind: 'movie', title: 'Free Solo', year: 2018, reason: null }],
    ['NC multi-part (was GAP)', 'Film (2001)/Film (2001) - Disco 1.mkv', 'movies', { kind: 'movie', part: 1, reason: 'multi_part' }],
    ['NC MakeMKV disc part', 'Il Gattopardo (1963)/BDMV_DISC2_t01.mkv', 'movies', { title: 'Il Gattopardo', part: 2, reason: 'multi_part' }],
    ['"Parte 1" in a title is not a part', 'Harry Potter e i Doni della Morte - Parte 1 (2010)/Harry Potter e i Doni della Morte - Parte 1 (2010).mkv', 'movies', { title: 'Harry Potter e i Doni della Morte - Parte 1', year: 2010, part: null, reason: null }],
    ['"Parte 2" after the year is a part', 'Novecento (1976)/Novecento (1976) - Parte 2.mkv', 'movies', { title: 'Novecento', part: 2, reason: 'multi_part' }],
    ['NC no year', 'Inception/Inception.mkv', 'movies', { kind: 'movie', title: 'Inception', year: null, reason: null }],
    ['NC orphan extra', 'Extras/Trailer.mkv', 'movies', { kind: 'extra', extraType: 'trailer', extraOf: null, warnings: ['orphan_extra'] }],
    ['NC season mismatch', 'Serie X (2010)/Season 02/Serie X (2010) - S01E05.mkv', 'series', { kind: 'episode', season: 1, warnings: ['season_dir_mismatch'] }],
    ['NC raw name', 'title_t00.mkv', 'movies', { kind: 'movie', title: null, reason: 'no_title' }],
    ['NC BDMV (was GAP)', 'Film (2001)/BDMV/STREAM/00001.m2ts', 'movies', { kind: 'disc', disc: 'bdmv', reason: 'disc_structure', title: 'Film' }],
    ['NC BDMV folder entry', 'Film (2001)/BDMV', 'movies', { kind: 'disc', disc: 'bdmv', reason: 'disc_structure' }],
    ['NC iso (was GAP)', 'Film (2001)/Film (2001).iso', 'movies', { kind: 'disc', disc: 'iso', reason: 'disc_structure' }],
    ['NC VIDEO_TS (was GAP)', 'Film (2001)/VIDEO_TS/VTS_01_1.VOB', 'movies', { kind: 'disc', disc: 'video_ts', reason: 'disc_structure' }],
    ["'Sample' in the title (was GAP)", 'Dark (2017)/Season 01/Dark (2017) - S01E01 - Sample Rate.mkv', 'series', { kind: 'episode', season: 1, episodes: [1], episodeTitle: 'Sample Rate' }],
    ['season assumed 1', 'Cowboy Bebop (1998)/Cowboy Bebop - 05.mkv', 'series', { kind: 'episode', season: 1, episodes: [5], warnings: ['season_assumed_1'], structural: false }],
    ['Puntata (was a holdout miss)', 'Don Matteo/Stagione 12/Puntata 3.mkv', 'series', { kind: 'episode', season: 12, episodes: [3] }],
    ['season folder is structure in a movie root', 'Dark (2017)/Season 01/Episodio 3.mkv', 'movies', { kind: 'episode', workKind: 'series', structural: true, season: 1, episodes: [3] }],
    ['no series folder', 'Season 01/Dark - S01E01.mkv', 'series', { kind: 'episode', title: 'Dark', season: 1, workFolder: null }],
    ['series folder holds the season folder', 'Altro/Dark (2017)/Season 01/Dark S01E01.mkv', 'series', { kind: 'episode', title: 'Dark', year: 2017, workFolder: 'Altro/Dark (2017)' }],
    ['movie in a series root (hint vs structure)', 'Planet Earth (2006)/Planet Earth (2006).mkv', 'series', { kind: 'movie', workKind: 'movie', structural: false }],
    ['NFD name is NFC', 'Léon (1994)/Léon (1994).mkv', 'movies', { title: 'Léon' }],
    ['generic folder dropped', 'misc/Heat (1995)/Heat (1995).mkv', 'movies', { title: 'Heat', workFolder: 'misc/Heat (1995)' }],
  ];

  it.each(cases)('%s', (_label, path, hint, expected) => {
    expect(parsePath(path, hint)).toMatchObject(expected);
  });
});

describe('name helpers', () => {
  it('extracts and strips tags', () => {
    expect(extractTags('Dune (2021) {tmdb-438631} [imdbid-tt1160419] {edition-IMAX}')).toEqual({
      rest: 'Dune (2021)',
      ids: { tmdb: '438631', imdb: 'tt1160419', tvdb: null },
      edition: 'IMAX',
    });
  });

  it('cleans release names but keeps hyphenated titles', () => {
    expect(cleanName('Il.Buono.il.Brutto.il.Cattivo.1966.1080p')).toBe('Il Buono il Brutto il Cattivo 1966 1080p');
    expect(cleanName('Ben-Hur (1959)')).toBe('Ben-Hur (1959)');
    expect(cleanName('Ocean’s Eleven')).toBe("Ocean's Eleven");
  });

  it.each([
    ['1917 (2019)', { title: '1917', year: 2019 }],
    ['2012.2009.1080p.BluRay', { title: '2012', year: 2009 }],
    ['Blade.Runner.2049.2017.2160p.UHD', { title: 'Blade Runner 2049', year: 2017 }],
    ['Ma che colpa abbiamo noi (2003)', { title: 'Ma che colpa abbiamo noi', year: 2003 }],
    ['Lo.chiamavano.Jeeg.Robot.2015.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1.ITA', { title: 'Lo chiamavano Jeeg Robot', year: 2015 }],
    ['MOVIE_t02', { title: null, junk: true }],
    ['BDMV_DISC1_t00', { title: null, junk: true, part: 1 }],
  ] as const)('parseName(%j)', (name, expected) => {
    expect(parseName(name)).toMatchObject(expected);
  });
});
