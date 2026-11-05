// Path parser of the library standard (docs/library-standard.md), ported by hand from the S4 rule
// parser (spikes/s4-identification/rules.py) with the gaps listed in the standard §8 closed:
// {tmdb-}/{imdb-}/{tvdb-} tags, free-text {edition-}, multi_part, disc structures, season extras,
// season folders as strong structure in any root, "Puntata N", MakeMKV names like MOVIE_t02.
// Input: a root-relative video path and the root hint. Pure: no I/O.
// Sidecars, samples and system folders are the library's (modules/library/rules.ts): it never
// sends them here.
import type { ExtraType } from '../../shared/ports.ts';
import type { WorkKind } from '../../shared/metadata.ts';

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
  /** Owner of an extra; null for an orphan extra and for every other kind. */
  extraOf: ExtraOwner | null;
  /** Root-relative folder of the work (movie folder, series folder), if the path has one. */
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
  [String.raw`remastered`, 'Remastered'],
  [String.raw`imax`, 'IMAX'],
  [String.raw`criterion(?: collection)?`, 'Criterion'],
  [String.raw`versione integrale`, 'Versione Integrale'],
  [String.raw`versione estesa`, 'Versione estesa'],
  [String.raw`edizione speciale`, 'Edizione speciale'],
  [String.raw`versione cinematografica`, 'Theatrical'],
];
const EDITION_RE = EDITIONS.map(([p, label]) => [new RegExp(String.raw`(?<![\p{L}\p{N}_'])(?:${p})(?![\p{L}\p{N}_'])`, 'iu'), label] as const);

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

  // A season folder between the item folder and the extra makes it a season extra (standard §5).
  const seasonBetween = (from: number, to: number): SeasonDir | null =>
    dirs.slice(from, to).map(seasonOfDir).find((s) => s !== null && (s.standard || hint !== 'movies')) ?? null;
  const owned = (out: ParsedPath, end: number): ParsedPath => {
    const season = seasonBetween(1, end);
    return withOwner(out, dirs[0] ?? '', folderPath(0), season ? 'series' : hintKind(hint), season?.number ?? null);
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
    if (dirs.length) return owned(out, dirs.length);
    const owner = parseName(stem.slice(0, suffix.index));
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
    // The series folder holds the season folder ("Altro/Dark (2017)/Season 01"); without one it is
    // the first folder, unless that one is already a season folder.
    const isSeasonDir = (d: string): boolean => {
      const s = seasonOfDir(d);
      return s !== null && (s.standard || hint !== 'movies');
    };
    const seasonIdx = dirs.findLastIndex(isSeasonDir);
    const idx = seasonIdx > 0 ? seasonIdx - 1 : seasonIdx === -1 && dirs.length > 0 ? 0 : -1;
    const seriesIdx = idx >= 0 && seasonOfDir(dirs[idx] ?? '') === null ? idx : -1;
    const p = seriesIdx >= 0 ? parseName(dirs[seriesIdx] ?? '') : parseName(ep.before);
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

  // Movie: name from the file, completed from (or replaced by) the item folder.
  const f = parseName(stem);
  const d = dirs.length ? parseName(dirs[0] ?? '') : null;
  const useFolder = f.junk || !f.title;
  const title = useFolder ? (d?.title ?? null) : f.title;
  const year = useFolder ? (d?.year ?? null) : (f.year ?? d?.year ?? null);
  const part = f.part;
  return {
    ...res,
    kind: 'movie',
    title,
    year,
    edition: f.edition ?? d?.edition ?? null,
    part,
    ids: mergeIds(f.ids, d?.ids ?? emptyIds()),
    workFolder: dirs.length ? folderPath(0) : null,
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
