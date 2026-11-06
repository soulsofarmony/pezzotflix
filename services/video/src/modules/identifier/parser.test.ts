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

/**
 * Where the product follows the library standard instead of the S4 labels: Remastered and IMAX only
 * describe the release, so the file is a version of the plain item (standard §3.1), not an edition.
 * Cut names stay editions (§3.2). Every other expected field of these entries is still checked.
 */
const RELEASE_WORD_NOT_EDITION = new Set(['T07', 'E09', 'H03']);
/**
 * A file whose title goes on from its folder's ("Band of Brothers - Fratelli al fronte"), or resembles
 * it ("Cosmos A Spacetime Odyssey" in "Cosmos - Odissea nello spazio (2014)/", fuzz above 0.6), may be
 * another work: it borrows no year from the folder, and goes to the matcher without one.
 */
const NO_BORROWED_YEAR = new Set(['I03', 'C05']);
const withStandard = (e: CorpusEntry): CorpusEntry => {
  if (RELEASE_WORD_NOT_EDITION.has(e.id)) return { ...e, exp: { ...e.exp, edition: null } };
  if (NO_BORROWED_YEAR.has(e.id)) return { ...e, exp: { ...e.exp, year: null } };
  return e;
};

describe('parser on the S4 corpus and holdout', () => {
  const entries = corpus.filter((e) => !ownedByLibrary(e)).map(withStandard);

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

describe('item folders and editions (standard §3.1, §3.2, §4, §5)', () => {
  type Case = [label: string, path: string, hint: RootHint, expected: Partial<ParsedPath>];
  const cases: Case[] = [
    ['a genre folder is not an item folder', 'Sci-fi/Aliens (1986) - 2160p.mkv', 'movies', { title: 'Aliens', year: 1986, workFolder: null }],
    ['a collection folder is not one', "Il Signore degli Anelli/Il Signore degli Anelli - Le due torri (2002).mkv", 'movies', { title: 'Il Signore degli Anelli - Le due torri', workFolder: null }],
    ['a folder named like another film is not one', 'Alien/Alien 3 (1992).mkv', 'movies', { title: 'Alien 3', year: 1992, workFolder: null }],
    ['a folder of the same title without a year is one', 'Alien/Alien (1979).mkv', 'movies', { title: 'Alien', year: 1979, workFolder: 'Alien' }],
    ['a folder of the same title gives the year', 'Alien (1979)/Alien.mkv', 'movies', { title: 'Alien', year: 1979, workFolder: 'Alien (1979)' }],
    ['the innermost folder is the item folder', 'Alien Saga/Alien (1979)/Alien (1979).mkv', 'movies', { title: 'Alien', workFolder: 'Alien Saga/Alien (1979)' }],
    ['a folder of another year is not one', 'Alien (2019)/Alien (1979).mkv', 'movies', { year: 1979, workFolder: null }],
    ['a release name in its folder', 'Matrix (1999)/The.Matrix.1999.2160p.UHD.mkv', 'movies', { title: 'The Matrix', year: 1999, workFolder: 'Matrix (1999)' }],
    ['a translated name has no item folder', 'Gli Intoccabili (1987)/The Untouchables (1987) 2160p UHD.mkv', 'movies', { title: 'The Untouchables', workFolder: null }],
    ['a translated name without a year borrows the folder year', 'Le Iene (1992)/Reservoir Dogs.mkv', 'movies', { title: 'Reservoir Dogs', year: 1992, workFolder: null }],
    ['a translated pair stays two names of their own', 'Le Iene (1992)/Reservoir Dogs (1992).mkv', 'movies', { title: 'Reservoir Dogs', year: 1992, workFolder: null }],
    ['a translation too close to its folder title borrows nothing (fuzz 0.61)', 'Gli Intoccabili (1987)/The Untouchables.mkv', 'movies', { title: 'The Untouchables', year: null, workFolder: null }],
    ['a similar title may be a sequel: no year', 'Alien (1979)/Aliens.mkv', 'movies', { title: 'Aliens', year: null, workFolder: null }],
    ['a similar title in a saga folder: no year', 'Alien Saga (1979)/Aliens.mkv', 'movies', { title: 'Aliens', year: null, workFolder: null }],
    ['a plural of the folder title: no year', 'Predator (1987)/Predators.mkv', 'movies', { title: 'Predators', year: null, workFolder: null }],
    ['a longer title without a year of its own: no year', 'Alien (1979)/Alien 3.mkv', 'movies', { title: 'Alien 3', year: null, workFolder: null }],
    ["a longer title that is not similar still borrows nothing", "Star Wars (1977)/Star Wars - L'Impero colpisce ancora.mkv", 'movies', { year: null, workFolder: null }],
    ['a longer title with the folder year is in its item folder', "Il Signore degli Anelli (2001)/Il Signore degli Anelli - La Compagnia dell'Anello (2001) - Extended.mkv", 'movies', { title: "Il Signore degli Anelli - La Compagnia dell'Anello", year: 2001, edition: 'Extended', workFolder: 'Il Signore degli Anelli (2001)' }],
    ['a longer title of another year is not in it', 'Alien (1979)/Alien 3 (1992).mkv', 'movies', { title: 'Alien 3', year: 1992, workFolder: null }],
    ['a MakeMKV name takes its folder', 'Film/Barry Lyndon (1975)/title_t00.mkv', 'movies', { title: 'Barry Lyndon', year: 1975, workFolder: 'Film/Barry Lyndon (1975)' }],
    ['version suffix: IMAX describes the release', 'Dune (2021)/Dune (2021) - 2160p IMAX.mkv', 'movies', { title: 'Dune', edition: null, workFolder: 'Dune (2021)' }],
    ['version suffix: Remastered describes the release', 'Alien (1979)/Alien (1979) - Remastered 2160p.mkv', 'movies', { edition: null, workFolder: 'Alien (1979)' }],
    ['a release word is no edition outside an item folder either', 'Sci-fi/Interstellar (2014) IMAX.mkv', 'movies', { title: 'Interstellar', year: 2014, edition: null }],
    ['a release word ends the title', 'Ritorno al futuro REMASTERED.mkv', 'movies', { title: 'Ritorno al futuro', edition: null }],
    ['a cut in the suffix is an edition: Unrated', 'Alien (1979)/Alien (1979) - 4K Unrated.mkv', 'movies', { edition: 'Unrated', workFolder: 'Alien (1979)' }],
    ["a cut in the suffix is an edition: Director's Cut", "Amadeus (1984)/Amadeus (1984) - Director's Cut.mkv", 'movies', { title: 'Amadeus', edition: "Director's Cut", workFolder: 'Amadeus (1984)' }],
    ['a cut wins over a release word', 'Nuovo Cinema Paradiso (1988)/Nuovo Cinema Paradiso (1988) - Remastered Versione Integrale.mkv', 'movies', { edition: 'Versione Integrale' }],
    ['a cut in the file wins over the folder edition', 'Blade Runner (1982) {edition-Final Cut}/Blade Runner (1982) - Theatrical.mkv', 'movies', { edition: 'Theatrical', workFolder: 'Blade Runner (1982) {edition-Final Cut}' }],
    ['edition from the folder tag', 'Blade Runner (1982) {edition-Final Cut}/Blade Runner (1982) - 2160p.mkv', 'movies', { title: 'Blade Runner', edition: 'Final Cut' }],
    ['edition from the folder name', 'Gladiator Extended/Gladiator.Remastered.1080p.mkv', 'movies', { title: 'Gladiator', edition: 'Extended' }],
    ['edition from the file tag', 'Dune (2021)/Dune (2021) {edition-IMAX} - 2160p.mkv', 'movies', { edition: 'IMAX' }],
    ['edition word outside an item folder', "Sci-fi/Alien (1979) Director's Cut.mkv", 'movies', { title: 'Alien', edition: "Director's Cut", workFolder: null }],
    ['edition word without any folder', "Amadeus (1984) - Director's Cut.mkv", 'movies', { edition: "Director's Cut" }],
    ['episodes of a shared folder: no series folder', 'Miniserie/Chernobyl (2019) - S01E01.mkv', 'series', { title: 'Chernobyl', year: 2019, workFolder: null }],
    ['episode in its series folder', 'Chernobyl (2019)/Chernobyl (2019) - S01E01.mkv', 'series', { title: 'Chernobyl', workFolder: 'Chernobyl (2019)' }],
    ['episode without a series name takes its folder', 'Dark (2017)/S01E01.mkv', 'series', { title: 'Dark', year: 2017, workFolder: 'Dark (2017)' }],
    ['innermost series folder without a season folder', 'Altro/Dark (2017)/Dark - S01E01.mkv', 'series', { title: 'Dark', year: 2017, workFolder: 'Altro/Dark (2017)' }],
    ['a longer series title keeps its own name, without a year', 'Band of Brothers (2001)/Band of Brothers - Fratelli al fronte - S01E01.mkv', 'series', { title: 'Band of Brothers - Fratelli al fronte', year: null, workFolder: null }],
    ['a longer series title after a word', 'The Office (2005)/The.Office.US.S01E01.mkv', 'series', { title: 'The Office US', year: null, workFolder: null }],
    ['a spin-off in its franchise folder is not that series', 'CSI (2000)/CSI - Miami - S01E01.mkv', 'series', { title: 'CSI - Miami', year: null, workFolder: null }],
    ['a spin-off with "&" in the title', 'Law & Order (1990)/Law & Order - Special Victims Unit - S01E01.mkv', 'series', { title: 'Law & Order - Special Victims Unit', year: null, workFolder: null }],
    ['a spin-off after a word', 'Doctor Who (2005)/Doctor Who Confidential - S01E01.mkv', 'series', { title: 'Doctor Who Confidential', year: null, workFolder: null }],
    ['a spin-off without a year of its own', 'Star Trek (1966)/Star Trek - The Next Generation - S01E01.mkv', 'series', { title: 'Star Trek - The Next Generation', year: null, workFolder: null }],
    ['a longer title of another year is another series', 'Star Trek (1966)/Star Trek - The Next Generation (1987) - S01E01.mkv', 'series', { title: 'Star Trek - The Next Generation', year: 1987, workFolder: null }],
    ['a yearless folder is not extended', 'Il Signore degli Anelli/Il Signore degli Anelli - Le due torri - S01E01.mkv', 'series', { workFolder: null }],
    ['another title of the series keeps only the folder year', 'Il Trono di Spade (2011)/Game of Thrones - S01E01.mkv', 'series', { title: 'Game of Thrones', year: 2011, workFolder: null }],
    ['extra of the innermost item folder', 'Alien Saga/Alien (1979)/Extras/Making of.mkv', 'movies', { kind: 'extra', title: 'Alien', year: 1979, extraOf: { folder: 'Alien Saga/Alien (1979)', kind: 'movie', season: null } }],
    ['Plex suffix outside its item folder: owner by name', 'Sci-fi/Alien (1979)-trailer.mkv', 'movies', { kind: 'extra', title: 'Alien', year: 1979, workFolder: null, extraOf: { folder: '', kind: 'movie', season: null } }],
    ['Plex suffix with a name of its own: the item folder owns it', 'Avatar (2009)/Arrival-deleted.mkv', 'movies', { kind: 'extra', extraType: 'deleted-scene', title: 'Avatar', year: 2009, extraOf: { folder: 'Avatar (2009)', kind: 'movie', season: null } }],
    ['Plex suffix "Teaser-trailer" in its item folder', 'Avatar (2009)/Teaser-trailer.mkv', 'movies', { kind: 'extra', extraType: 'trailer', title: 'Avatar', extraOf: { folder: 'Avatar (2009)', kind: 'movie', season: null } }],
    ['Plex suffix with a name of its own in a season folder', 'Dark (2017)/Season 01/Teaser-trailer.mkv', 'series', { kind: 'extra', title: 'Dark', extraOf: { folder: 'Dark (2017)', kind: 'series', season: 1 } }],
    ['Plex suffix naming another year: owner by name', 'Avatar (2009)/Alien (1979)-trailer.mkv', 'movies', { kind: 'extra', title: 'Alien', year: 1979, extraOf: { folder: '', kind: 'movie', season: null } }],
    ['Plex suffix in a yearless folder of another name: owner by name', 'Alien Saga/Aliens-trailer.mkv', 'movies', { kind: 'extra', title: 'Aliens', extraOf: { folder: '', kind: 'movie', season: null } }],
    ['season extra without a series folder is an orphan', 'Season 01/Extras/Recap.mkv', 'series', { kind: 'extra', extraOf: null, warnings: ['orphan_extra'] }],
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
