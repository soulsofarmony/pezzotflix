// Path parser of the library standard (docs/library-standard.md), ported by hand from the S4 rule
// parser (spikes/s4-identification/rules.py) with the gaps listed in the standard §8 closed:
// {tmdb-}/{imdb-}/{tvdb-} tags, free-text {edition-}, multi_part, disc structures, season extras,
// season folders as strong structure in any root, "Puntata N", MakeMKV names like MOVIE_t02.
// Input: a root-relative video path and the root hint. Pure: no I/O.
// Sidecars, samples and system folders are the library's (modules/library/rules.ts): it never
// sends them here.
import type { ExtraType } from '../../shared/ports.ts';
import type { WorkKind } from '../../shared/metadata.ts';
import { ratio, tokenSortRatio } from './fuzz.ts';
import { normalizeTitle } from './normalize.ts';

export type RootHint = 'movies' | 'series' | 'mixed';
export type ParsedKind = 'movie' | 'episode' | 'extra' | 'disc';
/** Library standard §7.2 (sidecar_no_lang belongs to the library). */
export type ParseWarning = 'season_assumed_1' | 'season_dir_mismatch' | 'orphan_extra';
/** Queue reasons the parse alone decides (standard §7.1). */
export type ParseReason = 'no_title' | 'multi_part' | 'disc_structure';

export interface IdTags {
  tmdb: string | null;
  imdb: string | null;
  tvdb: string | null;
}

/** The work an extra belongs to, from its item folder (standard §5). */
export interface ExtraOwner {
  /** Root-relative folder of the owner item. */
  folder: string;
  kind: WorkKind;
  /** Set for an extra of one season (Season NN/Extras/…): it hangs below that season. */
  season: number | null;
}

export interface ParsedPath {
  kind: ParsedKind;
  /** Title of the work to identify: the movie, the series of an episode, the owner of an extra. */
  title: string | null;
  year: number | null;
  edition: string | null;
  part: number | null;
  ids: IdTags;
  season: number | null;
  episodes: number[] | null;
  /** Informative only (standard §4): the real one comes from the metadata. */
  episodeTitle: string | null;
  extraType: ExtraType | null;
  /** Display title of an extra: its file name, or the type label for a Plex suffix (L4). */
  extraTitle: string | null;
  /** extraTitle is a type label: numbered when a sibling extra already uses it. */
  extraTitleIsLabel: boolean;
  /**
   * Owner of an extra; null for an orphan extra and for every other kind. folder is '' when the
   * owner comes from the extra's own name (a Plex suffix outside its item folder).
   */
  extraOf: ExtraOwner | null;
  /**
   * Root-relative item folder of the work (movie folder, series folder), or null when the file is not
   * in one: a folder counts only if it names the same work as the file (standard §3.1, §4), so a
   * collection or genre folder ("Sci-fi/", "Miniserie/") is never one. Files sharing it share the work.
   */
  workFolder: string | null;
  /** Kind of work the file can be linked to: from the structure first, then the hint (§2). */
  workKind: WorkKind;
  /** The kind comes from the path structure (SxxEyy, a season folder), not from the hint alone. */
  structural: boolean;
  disc: 'bdmv' | 'video_ts' | 'iso' | null;
  reason: ParseReason | null;
  warnings: ParseWarning[];
}

// Python's \w, Unicode-aware.
const W = String.raw`[\p{L}\p{N}_]`;
const NOT_W = String.raw`[^\p{L}\p{N}_]`;

const EXTRA_DIRS: ReadonlyMap<string, ExtraType | null> = new Map<string, ExtraType | null>([
  ['extras', null], ['extra', null], ['bonus', null], ['contenuti speciali', null], ['speciali extra', null],
  ['featurettes', 'featurette'], ['featurette', 'featurette'],
  ['behind the scenes', 'behind-the-scenes'], ['dietro le quinte', 'behind-the-scenes'], ['making of', 'behind-the-scenes'],
  ['deleted scenes', 'deleted-scene'], ['scene eliminate', 'deleted-scene'], ['scene tagliate', 'deleted-scene'],
  ['interviews', 'interview'], ['interviste', 'interview'],
  ['trailers', 'trailer'], ['trailer', 'trailer'],
  ['shorts', 'other'], ['other', 'other'], ['others', 'other'], ['scenes', 'other'], ['clips', 'other'],
]);
const EXTRA_SUFFIX = /-(trailer|featurette|behindthescenes|deleted|interview|scene|short|other)$/i;
const SUFFIX_TYPE: Readonly<Record<string, ExtraType>> = {
  trailer: 'trailer', featurette: 'featurette', behindthescenes: 'behind-the-scenes', deleted: 'deleted-scene',
  interview: 'interview', scene: 'other', short: 'other', other: 'other',
};
/** Type of an extra in a generic folder ("Extras"), from words of its own name. */
const EXTRA_KEYWORDS: readonly [RegExp, ExtraType][] = [
  [/\btrailer\b|\bteaser\b/i, 'trailer'],
  [/scene (?:eliminate|tagliate)|deleted/i, 'deleted-scene'],
  [/\bintervist|\binterview/i, 'interview'],
  [/behind the scenes|dietro le quinte|making of/i, 'behind-the-scenes'],
  [/featurette/i, 'featurette'],
];
/** Display labels of the extra types (Plex suffixes, standard §5). */
export const EXTRA_LABELS: Readonly<Record<ExtraType, string>> = {
  trailer: 'Trailer', featurette: 'Featurette', 'behind-the-scenes': 'Dietro le quinte', 'deleted-scene': 'Scena eliminata',
  interview: 'Intervista', other: 'Extra',
};

/** Standard season folders (Season NN, Stagione NN): strong structure in any root. */
const STANDARD_SEASON_DIR = /^(?:season|stagione) ?0*(\d{1,3})$/;
/** Tolerant forms read in series and mixed roots only. */
const LOOSE_SEASON_DIR = /^(?:season|stagione|serie|series|s|parte|part) ?0*(\d{1,3})$/;
const SPECIALS_DIR = /^(?:specials?|speciali)$/;
const GENERIC_DIR = /^(?:misc|varie|film|films|movies|film nuovi|nuovi|da vedere|downloads?|documentari|documentaries|serie tv|series|tv)$/;

const SXXEYY = new RegExp(String.raw`(?<!${W})S(\d{1,2})[ ._-]?E(\d{1,3})((?:[ ._-]*-?[ ._-]*E\d{1,3})*)(?!${W})`, 'iu');
const NXMM = new RegExp(String.raw`(?<!${W})(\d{1,2})x(\d{2,3})((?:\s*-\s*(?:\d{1,2}x)?\d{2,3})*)(?!${W})`, 'iu');
const IT_SE = new RegExp(String.raw`(?<!${W})stagione\s*(\d{1,2})(?!${W}).*?(?<!${W})episodio\s*(\d{1,3})(?!${W})`, 'iu');
const EP_ONLY = new RegExp(String.raw`(?<!${W})(?:episodio|episode|puntata|ep|e)\s*\.?\s*(\d{1,3})(?!${W})`, 'iu');
const BARE_NUM = /(?:^|\s-\s)(\d{1,3})$/u;
/** A range "E02-E05" lists every episode only when it is short: a longer one is a typo. */
const MAX_EPISODE_RANGE = 20;

/** Names without identity: MakeMKV and disc dumps, placeholders. */
const JUNK_STEM = /^(?:BDMV_DISC\d+_t\d+|(?:[\p{L}\p{N}]+_)+t\d{2,3}|title_t\d+|\d{4,6}|test|nuovo_file.*|new_file.*|video\d*|untitled.*)$/iu;

/**
 * Names of a cut, or of a different picture (black and white): an edition, a separate item (standard
 * §3.2), wherever the word sits. The first that matches wins.
 */
const EDITIONS: readonly [string, string][] = [
  [String.raw`extended director'?s cut`, "Extended Director's Cut"],
  [String.raw`director'?s definitive cut`, "Director's Definitive Cut"],
  [String.raw`director'?s cut|directors cut|dc`, "Director's Cut"],
  [String.raw`extended (?:edition|cut)|extended`, 'Extended'],
  [String.raw`theatrical(?: cut| edition)?`, 'Theatrical'],
  [String.raw`(?:the )?final cut`, 'Final Cut'],
  [String.raw`assembly cut`, 'Assembly Cut'],
  [String.raw`special edition`, 'Special Edition'],
  [String.raw`black (?:and|&) chrome(?: edition)?`, 'Black and Chrome'],
  [String.raw`black (?:and|&) white`, 'Black & White'],
  [String.raw`unrated|uncut`, 'Unrated'],
  [String.raw`versione integrale`, 'Versione Integrale'],
  [String.raw`versione estesa`, 'Versione estesa'],
  [String.raw`edizione speciale`, 'Edizione speciale'],
  [String.raw`versione cinematografica`, 'Theatrical'],
];
/**
 * Words that only describe the release, like the technical tokens: a file named with them is a version
 * of its item (standard §3.1), never an edition. They still end the title.
 */
const RELEASE_WORDS: readonly string[] = [String.raw`remastered`, String.raw`imax`, String.raw`criterion(?: collection)?`];
const editionWord = (p: string): RegExp => new RegExp(String.raw`(?<![\p{L}\p{N}_'])(?:${p})(?![\p{L}\p{N}_'])`, 'iu');
const EDITION_RE = EDITIONS.map(([p, label]) => [editionWord(p), label] as const);
const RELEASE_RE = editionWord(RELEASE_WORDS.join('|'));

// The title ends at the first technical token. A bare "ma" is not one (Italian for "but"): "DTS-HD MA"
// is caught by "dts-hd" already.
const TECH = new RegExp(
  String.raw`(?<!${W})(?:2160p|1080p|1080i|720p|576p|480p|4k|uhd|bluray|blu-ray|bdremux|remux|bdrip|web-?dl|webrip|hdtv|` +
    String.raw`hdr10\+?|hdr|dv|dovi|dolby ?vision|hevc|x26[45]|h\.?26[45]|avc|truehd|atmos|dts(?:-hd)?|dts-x|ac3|eac3|aac|flac|` +
    String.raw`ita|eng|multi|sub|subs|10bit|proper|repack)(?!${W})`,
  'giu',
);
const YEAR = new RegExp(String.raw`[(\[]((?:19|20)\d{2})[)\]]|(?<!${W})((?:19|20)\d{2})(?!${W})`, 'gu');
const PART = new RegExp(String.raw`(?<!${W})(disc|disco|cd|pt|part|parte)\s*\.?\s*(\d{1,2})(?!${W})`, 'giu');
/** "Parte 1" is often part of a title ("… - Parte 1 (2010)"): it marks a disc part only after the year. */
const PART_WORDS_AFTER_YEAR_ONLY: ReadonlySet<string> = new Set(['part', 'parte']);

const TAG = /\{(tmdb|imdb|tvdb|edition)-([^}]*)\}|\[(tmdbid|imdbid|tvdbid)-([^\]]*)\]/giu;

const nfc = (s: string): string => s.normalize('NFC');
const normDir = (seg: string): string => nfc(seg).replace(/[\s._-]+/gu, ' ').trim().toLowerCase();

const emptyIds = (): IdTags => ({ tmdb: null, imdb: null, tvdb: null });
const mergeIds = (first: IdTags, second: IdTags): IdTags => ({
  tmdb: first.tmdb ?? second.tmdb,
  imdb: first.imdb ?? second.imdb,
  tvdb: first.tvdb ?? second.tvdb,
});

/** Removes {tmdb-…}, {imdb-…}, {tvdb-…}, {edition-…} (and Jellyfin's [tmdbid-…]) from a name. */
export function extractTags(name: string): { rest: string; ids: IdTags; edition: string | null } {
  const ids = emptyIds();
  let edition: string | null = null;
  const rest = name.replace(TAG, (_m, key: string | undefined, value: string | undefined, jkey: string | undefined, jvalue: string | undefined) => {
    const k = (key ?? jkey ?? '').toLowerCase().replace(/id$/, '');
    const v = (value ?? jvalue ?? '').trim();
    if (k === 'edition') edition ??= v || null;
    else if (k === 'tmdb' && /^\d+$/.test(v)) ids.tmdb ??= v;
    else if (k === 'imdb' && /^tt\d+$/i.test(v)) ids.imdb ??= v.toLowerCase();
    else if (k === 'tvdb' && /^\d+$/.test(v)) ids.tvdb ??= v;
    return ' ';
  });
  return { rest: rest.replace(/\s+/gu, ' ').trim(), ids, edition };
}

/** Release-name separators become spaces; "Ben-Hur" keeps its hyphen. */
export function cleanName(s: string): string {
  let out = nfc(s).replace(/’/g, "'");
  if (!out.includes(' ') || (out.match(/\./g)?.length ?? 0) >= 3) {
    out = out.replace(new RegExp(String.raw`(?<=${W})[._](?=${W})`, 'gu'), ' ');
    out = out.replace(new RegExp(String.raw`(?<=${W})\.(?=${NOT_W}|$)`, 'gu'), ' ');
  }
  return out.replace(/_/g, ' ').replace(/\s+/gu, ' ').trim();
}

const stripTitle = (t: string): string => t.replace(/[\s\-–:,[\](]+$/u, '').replace(/^[\s\-–:,[\]]+/u, '').trim();

export interface ParsedName {
  title: string | null;
  year: number | null;
  edition: string | null;
  part: number | null;
  ids: IdTags;
  /** No identity in the name (MakeMKV dump, placeholder). */
  junk: boolean;
}

const firstAfterStart = (re: RegExp, s: string): RegExpExecArray | null => {
  for (const m of s.matchAll(re)) if (m.index > 0) return m;
  return null;
};

/** One file or folder name (no extension): title, year, edition, disc part, id tags. */
export function parseName(name: string): ParsedName {
  const tags = extractTags(name);
  const raw = cleanName(tags.rest);
  const out: ParsedName = { title: null, year: null, edition: tags.edition, part: null, ids: tags.ids, junk: false };
  const underscored = raw.replace(/ /g, '_');
  if (JUNK_STEM.test(underscored) || JUNK_STEM.test(raw)) {
    const disc = /BDMV_DISC(\d+)/i.exec(underscored);
    if (disc) out.part = Number(disc[1]);
    out.junk = true;
    return out;
  }
  let cut = raw.length;
  const tech = firstAfterStart(TECH, raw);
  // A year at position 0 is the title ("1917 (2019)", "2012 2009"). Prefer a bracketed year, else the
  // last bare one before the technical tokens ("Blade Runner 2049 2017 2160p").
  let years = [...raw.matchAll(YEAR)].filter((m) => !(m.index === 0 && !raw.startsWith('(') && !raw.startsWith('[')));
  if (tech) years = years.filter((m) => m.index < tech.index).length ? years.filter((m) => m.index < tech.index) : years;
  const bracketed = years.filter((m) => m[1] !== undefined);
  const ym = bracketed[0] ?? years[years.length - 1];
  if (ym) {
    out.year = Number(ym[1] ?? ym[2]);
    cut = Math.min(cut, ym.index);
  }
  if (out.edition === null) {
    for (const [re, label] of EDITION_RE) {
      const m = re.exec(raw);
      if (m && m.index > 0) {
        out.edition = label;
        cut = Math.min(cut, m.index);
        break;
      }
    }
    const release = out.edition === null ? RELEASE_RE.exec(raw) : null;
    if (release && release.index > 0) cut = Math.min(cut, release.index);
  }
  for (const m of raw.matchAll(PART)) {
    if (m.index === 0) continue;
    const word = (m[1] ?? '').toLowerCase();
    if (PART_WORDS_AFTER_YEAR_ONLY.has(word) && (!ym || m.index < ym.index)) continue;
    out.part = Number(m[2]);
    cut = Math.min(cut, m.index);
    break;
  }
  if (tech) cut = Math.min(cut, tech.index);
  out.title = stripTitle(raw.slice(0, cut)) || null;
  return out;
}

const idsAgree = (a: IdTags, b: IdTags): boolean =>
  (['tmdb', 'imdb', 'tvdb'] as const).every((k) => a[k] === null || b[k] === null || a[k] === b[k]);

const hasId = (ids: IdTags): boolean => ids.tmdb !== null || ids.imdb !== null || ids.tvdb !== null;

/** Same year when both have one, no conflicting id tag. */
const noConflict = (a: ParsedName, b: ParsedName): boolean =>
  (a.year === null || b.year === null || a.year === b.year) && idsAgree(a.ids, b.ids);

/** Two names of the same work: same normalised title, same year when both have one, no conflicting id tag. */
function sameWorkName(a: ParsedName, b: ParsedName): boolean {
  if (!a.title || !b.title || normalizeTitle(a.title) !== normalizeTitle(b.title)) return false;
  return noConflict(a, b);
}

/** A folder named as an item: a title with a year or an id tag ("Dune (2021)"). "Alien/" and "Sci-fi/" are not. */
const itemLike = (d: ParsedName): boolean => d.title !== null && !d.junk && (d.year !== null || hasId(d.ids));

/** One normalised title goes on from the other after a word or " - " ("che l argentino" from "che"). */
const extendsTitle = (longer: string, shorter: string): boolean => shorter !== '' && longer.startsWith(`${shorter} `);

/**
 * The name's title goes on from the item folder's after a word or " - " ("Il Signore degli Anelli -
 * La Compagnia dell'Anello" in "Il Signore degli Anelli (2001)/"), with no conflicting year or id.
 */
function extendsItemFolder(name: ParsedName, folder: ParsedName): boolean {
  return itemLike(folder) && noConflict(name, folder) && extendsTitle(normalizeTitle(name.title), normalizeTitle(folder.title));
}

/**
 * Below this similarity (the matcher's normalisation and fuzz, without its number penalty) a title is
 * clearly not its folder's: a name in another language. A closer one may be another film of the saga
 * ("Aliens" in "Alien (1979)/"), and with the folder's year the folder's film would win the match
 * (0.55·s + 0.35 + 0.1 reaches the auto threshold 0.8 from s ≈ 0.64).
 */
export const BORROW_YEAR_MAX_SIMILARITY = 0.6;

/**
 * The year of a folder that is not the file's item folder, for a name without one: only when the
 * titles clearly differ ("Le Iene (1992)/Reservoir Dogs", "Il Trono di Spade (2011)/Game of Thrones -
 * S01E01"). A title that resembles the folder's, or goes on from it ("Aliens", "Alien 3", "CSI -
 * Miami"), may be another work: it keeps no year, and the matcher's rule for names without one applies.
 */
function borrowedYear(name: ParsedName, folder: ParsedName): number | null {
  if (name.year !== null || folder.year === null || folder.junk || !idsAgree(name.ids, folder.ids)) return null;
  const n = normalizeTitle(name.title);
  const f = normalizeTitle(folder.title);
  if (n === '' || f === '' || extendsTitle(n, f) || extendsTitle(f, n)) return null;
  return Math.max(ratio(n, f), tokenSortRatio(n, f)) / 100 < BORROW_YEAR_MAX_SIMILARITY ? folder.year : null;
}

/**
 * The name starts with a folder name closed by its year or a tag: "Dune (2021) - 2160p" in
 * "Dune (2021)/" (standard §3.1). Without the closing bracket the rest may still be title:
 * "Il Signore degli Anelli - Le due torri" in "Il Signore degli Anelli/" is another work.
 */
function startsWithFolder(name: string, folder: string): boolean {
  const f = nfc(folder).trim().toLowerCase();
  return /[)\]}]$/u.test(f) && nfc(name).trim().toLowerCase().startsWith(f);
}

/** The folder is the item folder of the work this name (file stem, or the part before a suffix) names. */
function namesSameWork(name: string, parsed: ParsedName, folder: string): boolean {
  const d = parseName(folder);
  if (!d.title || d.junk) return false;
  return startsWithFolder(name, folder) || sameWorkName(parsed, d);
}

interface SeasonDir {
  number: number;
  standard: boolean;
}

function seasonOfDir(seg: string): SeasonDir | null {
  const n = normDir(seg);
  if (SPECIALS_DIR.test(n)) return { number: 0, standard: true };
  const std = STANDARD_SEASON_DIR.exec(n);
  if (std) return { number: Number(std[1]), standard: true };
  const loose = LOOSE_SEASON_DIR.exec(n);
  return loose ? { number: Number(loose[1]), standard: false } : null;
}

/** Episode numbers from the rest of an SxxEyy / NxMM match: a list, or a short range. */
function episodeList(first: number, rest: string, item: RegExp): number[] {
  const more = [...rest.matchAll(item)].map((m) => Number(m[1]));
  const last = more[more.length - 1];
  if (more.length === 1 && last !== undefined && /-/.test(rest) && last > first && last - first <= MAX_EPISODE_RANGE) {
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  }
  return [first, ...more];
}

interface StemEpisode {
  season: number | null;
  episodes: number[] | null;
  before: string;
  after: string;
}

function episodeOfStem(stem: string): StemEpisode {
  const s = cleanName(extractTags(stem).rest);
  let m = SXXEYY.exec(s);
  if (m) {
    return { season: Number(m[1]), episodes: episodeList(Number(m[2]), m[3] ?? '', /E(\d{1,3})/giu), before: s.slice(0, m.index), after: s.slice(m.index + m[0].length) };
  }
  m = NXMM.exec(s);
  if (m) {
    return { season: Number(m[1]), episodes: episodeList(Number(m[2]), m[3] ?? '', /(?:\d{1,2}x)?(\d{2,3})/giu), before: s.slice(0, m.index), after: s.slice(m.index + m[0].length) };
  }
  m = IT_SE.exec(s);
  if (m) return { season: Number(m[1]), episodes: [Number(m[2])], before: s.slice(0, m.index), after: s.slice(m.index + m[0].length) };
  m = EP_ONLY.exec(s);
  if (m) return { season: null, episodes: [Number(m[1])], before: s.slice(0, m.index), after: s.slice(m.index + m[0].length) };
  m = BARE_NUM.exec(s);
  if (m) return { season: null, episodes: [Number(m[1])], before: s.slice(0, m.index), after: '' };
  return { season: null, episodes: null, before: s, after: '' };
}

function episodeTitleOf(after: string): string | null {
  const tech = firstAfterStart(TECH, ` ${after}`);
  const text = tech ? ` ${after}`.slice(0, tech.index) : after;
  return stripTitle(text) || null;
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};
const stemOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

const base = (hint: RootHint): ParsedPath => ({
  kind: 'movie',
  title: null,
  year: null,
  edition: null,
  part: null,
  ids: emptyIds(),
  season: null,
  episodes: null,
  episodeTitle: null,
  extraType: null,
  extraTitle: null,
  extraTitleIsLabel: false,
  extraOf: null,
  workFolder: null,
  workKind: hint === 'series' ? 'series' : 'movie',
  structural: false,
  disc: null,
  reason: null,
  warnings: [],
});

const hintKind = (hint: RootHint): WorkKind => (hint === 'series' ? 'series' : 'movie');

/** Parses a root-relative path of a video file (or disc structure) under a root with this hint. */
export function parsePath(relPath: string, hint: RootHint): ParsedPath {
  const segs = relPath.split('/').filter(Boolean);
  const fname = segs[segs.length - 1] ?? '';
  const allDirs = segs.slice(0, -1);
  const stem = stemOf(fname);
  const res = base(hint);

  // Disc structures are never matched (standard §7.1, L3).
  const discOf = (seg: string): 'bdmv' | 'video_ts' | null => {
    const n = nfc(seg).toLowerCase();
    return n === 'bdmv' ? 'bdmv' : n === 'video_ts' ? 'video_ts' : null;
  };
  const disc = segs.map(discOf).find((d) => d !== null) ?? (extensionOf(fname) === 'iso' ? 'iso' : null);
  if (disc) {
    const owner = allDirs.find((d) => !GENERIC_DIR.test(normDir(d)) && discOf(d) === null);
    const p = owner ? parseName(owner) : disc === 'iso' ? parseName(stem) : null;
    return { ...res, kind: 'disc', title: p?.title ?? null, year: p?.year ?? null, disc, reason: 'disc_structure' };
  }

  // Generic container folders at the top ("misc/", "Film nuovi/") carry no identity.
  let skip = 0;
  while (skip < allDirs.length && GENERIC_DIR.test(normDir(allDirs[skip] ?? ''))) skip++;
  const dirs = allDirs.slice(skip);
  const folderPath = (i: number): string => allDirs.slice(0, skip + i + 1).join('/');

  const isSeasonDir = (d: string | undefined): SeasonDir | null => {
    const s = d === undefined ? null : seasonOfDir(d);
    return s !== null && (s.standard || hint !== 'movies') ? s : null;
  };
  /** Index of the item folder an extra in dirs[0..end) hangs from, past one season folder (standard §5), and that season. */
  const ownerOf = (end: number): { index: number; season: SeasonDir | null } => {
    const season = isSeasonDir(dirs[end - 1]);
    return { index: season ? end - 2 : end - 1, season };
  };
  // The innermost item folder owns the extra ("Alien Saga/Alien (1979)/Extras/…" is Alien's).
  const owned = (out: ParsedPath, end: number): ParsedPath => {
    const { index, season } = ownerOf(end);
    if (index < 0) return { ...out, warnings: ['orphan_extra'] };
    return withOwner(out, dirs[index] ?? '', folderPath(index), season ? 'series' : hintKind(hint), season?.number ?? null);
  };

  // Extras: a typed folder anywhere below the item folder, a Plex suffix, or a bare "trailer".
  const extraDirs = dirs.map((d, i) => [i, normDir(d)] as const).filter(([, nd]) => EXTRA_DIRS.has(nd));
  const outer = extraDirs[0];
  if (outer) {
    // The innermost typed folder wins ("Extras/Featurettes/…" is a featurette).
    const typed = extraDirs.map(([, nd]) => EXTRA_DIRS.get(nd) ?? null).filter((t) => t !== null).pop() ?? null;
    const extraType = typed ?? EXTRA_KEYWORDS.find(([re]) => re.test(stem))?.[1] ?? 'other';
    const out: ParsedPath = { ...res, kind: 'extra', extraType, extraTitle: cleanName(stem) };
    if (outer[0] === 0) return { ...out, warnings: ['orphan_extra'] };
    return owned(out, outer[0]);
  }
  const suffix = EXTRA_SUFFIX.exec(stem);
  if (suffix) {
    const extraType = SUFFIX_TYPE[(suffix[1] ?? '').toLowerCase()] ?? 'other';
    const out: ParsedPath = { ...res, kind: 'extra', extraType, extraTitle: EXTRA_LABELS[extraType], extraTitleIsLabel: true };
    const prefix = stem.slice(0, suffix.index);
    const owner = parseName(prefix);
    // An item folder owns its extras whatever their names ("Avatar (2009)/Teaser-trailer.mkv"), unless
    // the name has a year or an id of another work. "Sci-fi/" is no item folder: "Alien (1979)-trailer"
    // there is Alien's by its own name.
    const folder = dirs[ownerOf(dirs.length).index];
    const ownsIt = (dir: string): boolean => {
      const d = parseName(dir);
      return !owner.title || namesSameWork(prefix, owner, dir) || (itemLike(d) && noConflict(owner, d));
    };
    if (folder !== undefined && ownsIt(folder)) return owned(out, dirs.length);
    if (!owner.title) return { ...out, warnings: ['orphan_extra'] };
    return { ...out, title: owner.title, year: owner.year, edition: owner.edition, ids: owner.ids, workKind: hintKind(hint), extraOf: { folder: '', kind: hintKind(hint), season: null } };
  }
  if (dirs.length && /^(?:trailer|teaser)$/i.test(stem.trim())) {
    const out: ParsedPath = { ...res, kind: 'extra', extraType: 'trailer', extraTitle: EXTRA_LABELS.trailer, extraTitleIsLabel: true };
    return owned(out, dirs.length);
  }

  // Episodes: SxxEyy / NxMM / "Stagione N Episodio M" in the name, or a season folder.
  // The innermost season folder counts; the loose forms ("S01", "Parte 1") only outside movie roots.
  const seasonDir =
    dirs
      .map(seasonOfDir)
      .filter((s): s is SeasonDir => s !== null && (s.standard || hint !== 'movies'))
      .pop() ?? null;
  const ep = episodeOfStem(stem);
  const structural = ep.season !== null || seasonDir !== null;
  const isEpisode = ep.episodes !== null && (structural || hint === 'series');
  if (isEpisode && ep.episodes) {
    // The series folder holds the season folder ("Altro/Dark (2017)/Season 01"). Without one it is
    // the file's folder, only if that names the same series as the file ("Miniserie/Chernobyl (2019)
    // - S01E01.mkv" has none) or the file names no series ("Dark (2017)/S01E01.mkv"). A longer title
    // is another series as far as the path can tell ("CSI (2000)/CSI - Miami - S01E01.mkv").
    const seasonIdx = dirs.findLastIndex((d) => isSeasonDir(d) !== null);
    const name = parseName(ep.before);
    const parent = dirs.length - 1;
    const seriesIdx =
      seasonIdx > 0
        ? seasonOfDir(dirs[seasonIdx - 1] ?? '') === null
          ? seasonIdx - 1
          : -1
        : seasonIdx === -1 && parent >= 0 && seasonOfDir(dirs[parent] ?? '') === null && (!name.title || namesSameWork(ep.before, name, dirs[parent] ?? ''))
          ? parent
          : -1;
    // Any other name keeps its own title, and the folder's year only when the titles clearly differ.
    const yearOnly = seriesIdx < 0 && seasonIdx === -1 && parent >= 0 ? borrowedYear(name, parseName(dirs[parent] ?? '')) : null;
    const p = seriesIdx >= 0 ? parseName(dirs[seriesIdx] ?? '') : { ...name, year: name.year ?? yearOnly };
    const fromStem = extractTags(stem).ids;
    let season = ep.season;
    const warnings: ParseWarning[] = [];
    if (season === null) {
      season = seasonDir?.number ?? 1;
      if (!seasonDir) warnings.push('season_assumed_1');
    } else if (seasonDir && seasonDir.number !== season && seasonDir.number !== 0) {
      warnings.push('season_dir_mismatch');
    }
    return {
      ...res,
      kind: 'episode',
      title: p.title,
      year: p.year,
      ids: mergeIds(fromStem, p.ids),
      season,
      episodes: ep.episodes,
      episodeTitle: episodeTitleOf(ep.after),
      workFolder: seriesIdx >= 0 ? folderPath(seriesIdx) : null,
      workKind: 'series',
      structural,
      reason: p.title ? null : 'no_title',
      warnings,
    };
  }

  // Movie: name from the file, completed from (or replaced by) its item folder: the file's own
  // folder, when that names the same work (standard §3.1), or when the file's title goes on from it
  // with the same year of its own. A collection or genre folder does not. Any other name keeps its
  // own title, and the folder's year only when the titles clearly differ (borrowedYear): "Aliens" in
  // "Alien (1979)/" stays without a year.
  const f = parseName(stem);
  const parent = dirs.length - 1;
  const folderName = dirs[parent];
  const pd = folderName === undefined ? null : parseName(folderName);
  const useFolder = f.junk || !f.title;
  const ownFolder =
    folderName !== undefined && (useFolder || namesSameWork(stem, f, folderName) || (f.year !== null && f.year === pd?.year && extendsItemFolder(f, pd)));
  const d = ownFolder ? pd : null;
  const title = useFolder ? (d?.title ?? null) : f.title;
  const year = useFolder ? (d?.year ?? null) : (f.year ?? d?.year ?? (pd ? borrowedYear(f, pd) : null));
  const part = f.part;
  // A cut named by the file ("Amadeus (1984) - Director's Cut") is an edition even in the plain item
  // folder; release words ("Dune (2021) - 2160p IMAX") make a version (parseName).
  const edition = f.edition ?? d?.edition ?? null;
  return {
    ...res,
    kind: 'movie',
    title,
    year,
    edition,
    part,
    ids: mergeIds(f.ids, d?.ids ?? emptyIds()),
    workFolder: d?.title ? folderPath(parent) : null,
    // A single file without episode numbers can only be a movie; in a series root the hint and the
    // structure disagree, which the matcher turns into kind_mismatch (standard §2).
    workKind: 'movie',
    structural: false,
    reason: !title ? 'no_title' : part !== null ? 'multi_part' : null,
  };
}

function withOwner(out: ParsedPath, ownerDir: string, folder: string, kind: WorkKind, season: number | null): ParsedPath {
  const p = parseName(ownerDir);
  if (!p.title) return { ...out, warnings: ['orphan_extra'] };
  return {
    ...out,
    title: p.title,
    year: p.year,
    edition: p.edition,
    ids: p.ids,
    workFolder: folder,
    workKind: kind,
    structural: season !== null,
    extraOf: { folder, kind, season },
  };
}
