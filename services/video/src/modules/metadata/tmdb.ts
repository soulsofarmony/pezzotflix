// TMDB adapter (ADR 0007): enrichment in the configured language (Italian title, overview, tagline,
// localized genres, ordered credits, seasons and episodes, images), plus the search used as the
// identifier's fallback and by the review queue. Active only with TMDB_READ_TOKEN. The token is a
// secret: it travels only in the Authorization header, never in a URL, a cache key, a log line or
// an error message. Everything read from TMDB is TMDB Content: cached 24 h, expired and purged.
import { type ExternalIdLookup, type MetadataCandidate, type MetadataSearchRequest, type ProviderResult, type ProviderState, TMDB_NOTICE, type WorkKind } from '../../shared/metadata.ts';
import type { ArtworkType, CreditInput } from '../../shared/ports.ts';
import type { ProviderCache } from './cache.ts';
import type { HostGate } from './http.ts';
import { cached, DAY_MS, type DownloadedFile, type ImageRef, langBase, type ProviderAdapter, type SeasonDetails, toResult, type WorkDetails } from './types.ts';

export const TMDB_API = 'https://api.themoviedb.org/3';
export const TMDB_CACHE_TTL_MS = DAY_MS;
export const TMDB_CAST_LIMIT = 20;
export const TMDB_DOCUMENTARY_GENRE = 99;
/** CDN widths kept per image type (ADR 0007 point 6), mapped to the nearest size /configuration lists. */
export const TMDB_WANTED_WIDTHS: Record<ArtworkType, readonly number[]> = { poster: [342, 780], backdrop: [1280], logo: [500], still: [300], thumbnail: [300] };
const SEARCH_RESULTS = 20;
/** "Episodio 3" / "Episode 3": TMDB's placeholder, not a title (S4). */
const PLACEHOLDER_EPISODE = /^(?:episodio|episode|puntata)\s+\d+$/i;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const scalar = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const yearOf = (date: string | null): number | null => {
  const y = /^(\d{4})-/.exec(date ?? '')?.[1];
  return y ? Number(y) : null;
};

// ---------------------------------------------------------------- trimmed shapes (what the cache keeps)

export interface TmdbImage {
  type: 'poster' | 'backdrop' | 'logo';
  path: string;
  lang: string | null;
  w: number | null;
  h: number | null;
  votes: number;
}

export interface TmdbWork {
  id: string;
  kind: WorkKind;
  title: string | null;
  originalTitle: string | null;
  date: string | null;
  overview: string | null;
  tagline: string | null;
  genres: { id: number; name: string }[];
  voteCount: number | null;
  translations: { lang: string; region: string | null; title: string | null; overview: string | null; tagline: string | null }[];
  aliases: string[];
  externalIds: { imdb?: string; wikidata?: string; tvdb?: string };
  images: TmdbImage[];
  directors: { id: string; name: string }[];
  creators: { id: string; name: string }[];
  cast: { id: string; name: string; character: string | null }[];
}

export interface TmdbSeason {
  n: number;
  name: string | null;
  overview: string | null;
  date: string | null;
  poster: string | null;
  episodes: { n: number; name: string | null; overview: string | null; date: string | null; still: string | null }[];
}

export interface TmdbConfiguration {
  base: string;
  sizes: Partial<Record<'poster' | 'backdrop' | 'logo' | 'still', string[]>>;
}

const validPath = (p: string | null): p is string => !!p && /^\/[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/i.test(p);

/** Trims a /movie or /tv details response (with images, credits, translations, alternative titles, external ids). */
export function parseWork(raw: unknown, kind: WorkKind, langs: readonly string[]): TmdbWork {
  const r = obj(raw);
  const movie = kind === 'movie';
  const ext = obj(r.external_ids);
  const imdb = str(ext.imdb_id);
  const wikidata = str(ext.wikidata_id);
  const tvdb = num(ext.tvdb_id) ?? (str(ext.tvdb_id) ? Number(ext.tvdb_id) : null);
  const images: TmdbImage[] = [];
  for (const [key, type] of [['posters', 'poster'], ['backdrops', 'backdrop'], ['logos', 'logo']] as const) {
    for (const i of arr(obj(r.images)[key]).map(obj)) {
      const path = str(i.file_path);
      if (!validPath(path)) continue;
      const lang = str(i.iso_639_1);
      if (lang !== null && !langs.includes(lang)) continue;
      images.push({ type, path, lang, w: num(i.width), h: num(i.height), votes: num(i.vote_average) ?? 0 });
    }
  }
  const credits = obj(movie ? r.credits : r.aggregate_credits);
  const castRaw = arr(credits.cast).map(obj).sort((a, b) => (num(a.order) ?? 9999) - (num(b.order) ?? 9999));
  const alt = arr(obj(r.alternative_titles)[movie ? 'titles' : 'results']).map((t) => str(obj(t).title)).filter((t): t is string => !!t);
  return {
    id: scalar(r.id),
    kind,
    title: str(movie ? r.title : r.name),
    originalTitle: str(movie ? r.original_title : r.original_name),
    date: str(movie ? r.release_date : r.first_air_date),
    overview: str(r.overview),
    tagline: str(r.tagline),
    genres: arr(r.genres).map(obj).map((g) => ({ id: num(g.id) ?? 0, name: str(g.name) ?? '' })).filter((g) => g.name),
    voteCount: num(r.vote_count),
    translations: arr(obj(r.translations).translations)
      .map(obj)
      .filter((t) => langs.includes(scalar(t.iso_639_1)))
      .map((t) => {
        const d = obj(t.data);
        return { lang: String(t.iso_639_1), region: str(t.iso_3166_1), title: str(movie ? d.title : d.name), overview: str(d.overview), tagline: str(d.tagline) };
      }),
    aliases: [...new Set(alt)].slice(0, 30),
    externalIds: { ...(imdb && /^tt\d+$/.test(imdb) ? { imdb } : {}), ...(wikidata && /^Q\d+$/.test(wikidata) ? { wikidata } : {}), ...(tvdb ? { tvdb: String(tvdb) } : {}) },
    images,
    directors: movie
      ? arr(credits.crew)
          .map(obj)
          .filter((c) => c.job === 'Director')
          .map((c) => ({ id: scalar(c.id), name: str(c.name) ?? '' }))
          .filter((c) => c.name)
      : [],
    creators: movie ? [] : arr(r.created_by).map(obj).map((c) => ({ id: scalar(c.id), name: str(c.name) ?? '' })).filter((c) => c.name),
    cast: castRaw
      .slice(0, TMDB_CAST_LIMIT)
      .map((c) => ({ id: scalar(c.id), name: str(c.name) ?? '', character: movie ? str(c.character) : str(obj(arr(c.roles)[0]).character) }))
      .filter((c) => c.name),
  };
}

export function parseSeason(raw: unknown): TmdbSeason {
  const r = obj(raw);
  const poster = str(r.poster_path);
  return {
    n: num(r.season_number) ?? -1,
    name: str(r.name),
    overview: str(r.overview),
    date: str(r.air_date),
    poster: validPath(poster) ? poster : null,
    episodes: arr(r.episodes)
      .map(obj)
      .map((e) => {
        const still = str(e.still_path);
        return { n: num(e.episode_number) ?? -1, name: str(e.name), overview: str(e.overview), date: str(e.air_date), still: validPath(still) ? still : null };
      })
      .filter((e) => e.n >= 0),
  };
}

export function parseConfiguration(raw: unknown): TmdbConfiguration | null {
  const i = obj(obj(raw).images);
  const base = str(i.secure_base_url);
  // Pinned to TMDB's image host: a changed answer cannot send downloads elsewhere.
  if (!base || !/^https:\/\/image\.tmdb\.org\//.test(base)) return null;
  const sizes = (k: string) => arr(i[k]).filter((s): s is string => typeof s === 'string');
  return { base, sizes: { poster: sizes('poster_sizes'), backdrop: sizes('backdrop_sizes'), logo: sizes('logo_sizes'), still: sizes('still_sizes') } };
}

/** A search result as a candidate (search gives no aliases: lookupByExternalId adds them). */
export function searchCandidate(raw: unknown, kind: WorkKind): MetadataCandidate | null {
  const r = obj(raw);
  const id = num(r.id);
  if (id === null) return null;
  const movie = kind === 'movie';
  const year = yearOf(str(movie ? r.release_date : r.first_air_date));
  const original = str(movie ? r.original_title : r.original_name);
  return {
    ref: { provider: 'tmdb', id: String(id), kind },
    titles: { localized: str(movie ? r.title : r.name), english: null, original: original ? [original] : [], aliases: [] },
    years: year ? [year] : [],
    documentary: arr(r.genre_ids).includes(TMDB_DOCUMENTARY_GENRE),
    externalIds: { tmdb: String(id) },
    voteCount: num(r.vote_count),
  };
}

const pickTranslation = (w: TmdbWork, lang: string) => {
  const [base, region] = [langBase(lang), lang.split('-')[1]?.toUpperCase() ?? null];
  const of = w.translations.filter((t) => t.lang === base);
  return of.find((t) => t.region === region) ?? of[0] ?? null;
};

export function workCandidate(w: TmdbWork, lang: string): MetadataCandidate {
  const tr = pickTranslation(w, lang);
  const en = w.translations.find((t) => t.lang === 'en' && t.region === 'US') ?? w.translations.find((t) => t.lang === 'en');
  const year = yearOf(w.date);
  return {
    ref: { provider: 'tmdb', id: w.id, kind: w.kind },
    titles: { localized: tr?.title ?? w.title, english: en?.title ?? null, original: w.originalTitle ? [w.originalTitle] : [], aliases: w.aliases },
    years: year ? [year] : [],
    documentary: w.genres.some((g) => g.id === TMDB_DOCUMENTARY_GENRE),
    // Only the TMDB id leaves the adapter: IMDb, TVDB and Wikidata ids that TMDB alone supplies are
    // TMDB Content and are never stored (they are hints for lookups, WorkDetails.hints).
    externalIds: { tmdb: w.id },
    voteCount: w.voteCount,
  };
}

/** Best image of a type: language it → null → en (ADR 0007 point 3), then votes, then width. */
export function bestImage(images: readonly TmdbImage[], type: TmdbImage['type'], lang: string): TmdbImage | null {
  const order = [langBase(lang), null, 'en'];
  const rank = (i: TmdbImage) => {
    const k = order.indexOf(i.lang);
    return k < 0 ? order.length : k;
  };
  return [...images.filter((i) => i.type === type)].sort((a, b) => rank(a) - rank(b) || b.votes - a.votes || (b.w ?? 0) - (a.w ?? 0))[0] ?? null;
}

export function workDetails(w: TmdbWork, lang: string, fetchedAt: number): WorkDetails {
  const tr = pickTranslation(w, lang);
  const en = w.translations.find((t) => t.lang === 'en' && t.region === 'US') ?? w.translations.find((t) => t.lang === 'en');
  const credits: CreditInput[] = [
    ...w.directors.map((p, i) => ({ name: p.name, role: 'director' as const, character: null, order: i, personRef: p.id || null })),
    ...w.creators.map((p, i) => ({ name: p.name, role: 'creator' as const, character: null, order: i, personRef: p.id || null })),
    ...w.cast.map((p, i) => ({ name: p.name, role: 'actor' as const, character: p.character, order: i, personRef: p.id || null })),
  ];
  const images: ImageRef[] = [];
  for (const type of ['poster', 'backdrop', 'logo'] as const) {
    const b = bestImage(w.images, type, lang);
    if (b) images.push({ type, ref: b.path, language: b.lang, width: b.w, height: b.h });
  }
  return {
    provider: 'tmdb',
    id: w.id,
    kind: w.kind,
    fetchedAt,
    candidate: workCandidate(w, lang),
    fields: {
      // Only a translated title is TMDB's Italian title. Without one (no translation, or one with an
      // empty title, like Blade Runner 2049 in the live check of 2026-11-05) the Wikidata label shows (S4).
      title: tr?.title ?? null,
      originalTitle: w.originalTitle,
      year: yearOf(w.date),
      // The overview falls back to English (ADR 0007 point 3); the tagline does not.
      overview: w.overview ?? tr?.overview ?? en?.overview ?? null,
      tagline: w.tagline ?? tr?.tagline ?? null,
      genres: w.genres.map((g) => g.name),
      // Every key the identifier writes for tmdb is rewritten here, so a refresh renews them all.
      // Wikidata decides the category (ADR 0007 point 3); TMDB only says "documentary" (genre 99).
      category: w.genres.some((g) => g.id === TMDB_DOCUMENTARY_GENRE) ? 'documentary' : null,
    },
    hints: w.externalIds,
    credits,
    images,
  };
}

/** TMDB size names nearest to the wanted widths ('w342'…), from /configuration. */
export function sizesFor(available: readonly string[], wanted: readonly number[]): string[] {
  const widths = available.map((s) => ({ s, w: /^w(\d+)$/.exec(s)?.[1] })).filter((x): x is { s: string; w: string } => !!x.w);
  const out = new Set<string>();
  for (const n of wanted) {
    const best = [...widths].sort((a, b) => Math.abs(Number(a.w) - n) - Math.abs(Number(b.w) - n))[0];
    if (best) out.add(best.s);
  }
  if (!out.size && available.includes('original')) out.add('original');
  return [...out];
}

export interface TmdbDeps {
  api: HostGate;
  images: HostGate;
  cache: ProviderCache;
  now: () => number;
  /** Absent: the adapter is not created at all (not_configured). */
  token: string;
}

export type TmdbAdapter = ProviderAdapter & {
  /** Validates the token (GET /authentication); a 401 makes the provider invalid_credentials. */
  validate(): Promise<ProviderState>;
};

export function createTmdb(deps: TmdbDeps): TmdbAdapter {
  const { api, cache, now } = deps;
  const auth = { Authorization: `Bearer ${deps.token}` };
  let invalid = false;
  const langsOf = (lang: string) => [...new Set([langBase(lang), 'en'])];

  async function get(path: string, params: Record<string, string> = {}): Promise<ProviderResult<unknown>> {
    const qs = new URLSearchParams(params).toString();
    const o = await api.getJson(`${TMDB_API}${path}${qs ? `?${qs}` : ''}`, auth);
    if (o.kind === 'unauthorized') {
      invalid = true;
      return { status: 'unavailable', detail: 'tmdb: invalid credentials' };
    }
    return o.kind === 'ok' ? { status: 'ok', value: o.value } : toResult(o);
  }

  const work = (kind: WorkKind, id: string, lang: string) =>
    cached(cache, 'tmdb', `details:${kind}:${id}:${lang}`, TMDB_CACHE_TTL_MS, now, async (): Promise<ProviderResult<TmdbWork>> => {
      const langs = langsOf(lang);
      const r = await get(`/${kind === 'movie' ? 'movie' : 'tv'}/${id}`, {
        language: lang,
        append_to_response: `images,${kind === 'movie' ? 'credits' : 'aggregate_credits'},translations,alternative_titles,external_ids`,
        include_image_language: `${langBase(lang)},null,en`,
      });
      return r.status === 'ok' ? { status: 'ok', value: parseWork(r.value, kind, langs) } : r;
    });

  const configuration = () =>
    cached(cache, 'tmdb', 'configuration', TMDB_CACHE_TTL_MS, now, async (): Promise<ProviderResult<TmdbConfiguration>> => {
      const r = await get('/configuration');
      if (r.status !== 'ok') return r;
      const c = parseConfiguration(r.value);
      return c ? { status: 'ok', value: c } : { status: 'unavailable', detail: 'tmdb: bad configuration' };
    });

  async function season(tvId: string, n: number, lang: string) {
    return cached(cache, 'tmdb', `season:${tvId}:${n}:${lang}`, TMDB_CACHE_TTL_MS, now, async (): Promise<ProviderResult<TmdbSeason>> => {
      const r = await get(`/tv/${tvId}/season/${n}`, { language: lang });
      return r.status === 'ok' ? { status: 'ok', value: parseSeason(r.value) } : r;
    });
  }

  const adapter: TmdbAdapter = {
    name: 'tmdb',
    state: () => (invalid ? 'invalid_credentials' : api.health() === 'ok' ? 'ok' : 'degraded'),
    terms: () => ({
      retention: { maxAgeDays: 180 },
      attribution: TMDB_NOTICE,
      purgeOnTermination: true,
      cacheTtlMs: TMDB_CACHE_TTL_MS,
    }),

    async validate() {
      const r = await get('/authentication');
      if (r.status === 'ok') invalid = false;
      return adapter.state();
    },

    async search(req: MetadataSearchRequest) {
      const q = req.query.trim();
      if (!q) return { status: 'ok', value: [] };
      const kinds: WorkKind[] = req.kind ? [req.kind] : ['movie', 'series'];
      const out: MetadataCandidate[] = [];
      for (const kind of kinds) {
        const yearKey = kind === 'movie' ? 'year' : 'first_air_date_year';
        const r = await cached(cache, 'tmdb', `search:${kind}:${req.lang}:${req.year ?? ''}:${q.toLowerCase()}`, TMDB_CACHE_TTL_MS, now, async (): Promise<ProviderResult<unknown[]>> => {
          const s = await get(`/search/${kind === 'movie' ? 'movie' : 'tv'}`, {
            query: q,
            language: req.lang,
            include_adult: 'false',
            page: '1',
            ...(req.year ? { [yearKey]: String(req.year) } : {}),
          });
          return s.status === 'ok' ? { status: 'ok', value: arr(obj(s.value).results).slice(0, SEARCH_RESULTS) } : s;
        });
        if (r.status === 'not_found') continue;
        if (r.status !== 'ok') return r;
        out.push(...r.value.value.map((x) => searchCandidate(x, kind)).filter((c): c is MetadataCandidate => c !== null));
      }
      return { status: 'ok', value: out };
    },

    async lookupByExternalId(l: ExternalIdLookup) {
      if (l.ns === 'tmdb_movie' || l.ns === 'tmdb_tv') {
        if (!/^\d+$/.test(l.id)) return { status: 'invalid_request', detail: 'tmdb: bad id' };
        const r = await work(l.ns === 'tmdb_movie' ? 'movie' : 'series', l.id, l.lang);
        return r.status === 'ok' ? { status: 'ok', value: workCandidate(r.value.value, l.lang) } : r;
      }
      const source = { imdb: 'imdb_id', tvdb: 'tvdb_id', wikidata: 'wikidata_id' }[l.ns];
      const pattern = { imdb: /^tt\d+$/, tvdb: /^\d+$/, wikidata: /^Q\d+$/ }[l.ns];
      if (!pattern.test(l.id)) return { status: 'invalid_request', detail: `tmdb: bad ${l.ns} id` };
      const f = await cached(cache, 'tmdb', `find:${source}:${l.id}`, TMDB_CACHE_TTL_MS, now, async (): Promise<ProviderResult<{ kind: WorkKind; id: string }>> => {
        const r = await get(`/find/${l.id}`, { external_source: source });
        if (r.status !== 'ok') return r;
        const movie = num(obj(arr(obj(r.value).movie_results)[0]).id);
        const tv = num(obj(arr(obj(r.value).tv_results)[0]).id);
        if (movie !== null) return { status: 'ok', value: { kind: 'movie', id: String(movie) } };
        if (tv !== null) return { status: 'ok', value: { kind: 'series', id: String(tv) } };
        return { status: 'not_found' };
      });
      if (f.status !== 'ok') return f;
      const r = await work(f.value.value.kind, f.value.value.id, l.lang);
      return r.status === 'ok' ? { status: 'ok', value: workCandidate(r.value.value, l.lang) } : r;
    },

    async details(kind, id, lang) {
      if (!/^\d+$/.test(id)) return { status: 'invalid_request', detail: 'tmdb: bad id' };
      const r = await work(kind, id, lang);
      return r.status === 'ok' ? { status: 'ok', value: workDetails(r.value.value, lang, r.value.fetchedAt) } : r;
    },

    async seasons(seriesId, numbers, lang): Promise<ProviderResult<SeasonDetails[]>> {
      if (!/^\d+$/.test(seriesId)) return { status: 'invalid_request', detail: 'tmdb: bad id' };
      const out: SeasonDetails[] = [];
      for (const n of numbers) {
        const r = await season(seriesId, n, lang);
        if (r.status === 'not_found') continue;
        if (r.status !== 'ok') return r;
        let s = r.value.value;
        let fetchedAt = r.value.fetchedAt;
        if (langBase(lang) !== 'en' && s.episodes.some((e) => !e.overview)) {
          // Overviews fall back to en-US (S4: 8 of 1,529 episodes needed it).
          const en = await season(seriesId, n, 'en-US');
          if (en.status === 'ok') {
            const byN = new Map(en.value.value.episodes.map((e) => [e.n, e.overview]));
            s = { ...s, episodes: s.episodes.map((e) => ({ ...e, overview: e.overview ?? byN.get(e.n) ?? null })) };
            fetchedAt = Math.min(fetchedAt, en.value.fetchedAt);
          }
        }
        out.push({
          season: s.n,
          fetchedAt,
          fields: { title: s.name, overview: s.overview, year: yearOf(s.date) },
          poster: s.poster ? { type: 'poster', ref: s.poster, language: langBase(lang), width: null, height: null } : null,
          episodes: s.episodes.map((e) => ({
            episode: e.n,
            fields: { title: e.name && !PLACEHOLDER_EPISODE.test(e.name) ? e.name : null, overview: e.overview, year: yearOf(e.date) },
            still: e.still ? { type: 'still', ref: e.still, language: null, width: null, height: null } : null,
          })),
        });
      }
      return { status: 'ok', value: out };
    },

    async fetchImage(image: ImageRef): Promise<ProviderResult<DownloadedFile[]>> {
      if (!validPath(image.ref)) return { status: 'invalid_request', detail: 'tmdb: bad image path' };
      const c = await configuration();
      if (c.status !== 'ok') return c.status === 'not_found' ? { status: 'unavailable', detail: 'tmdb: no configuration' } : c;
      const kind = image.type === 'thumbnail' ? 'still' : image.type;
      const sizes = sizesFor(c.value.value.sizes[kind] ?? [], TMDB_WANTED_WIDTHS[image.type]);
      if (!sizes.length) return { status: 'unavailable', detail: `tmdb: no ${kind} sizes` };
      const files: DownloadedFile[] = [];
      for (const size of sizes) {
        // Ready-made CDN sizes only: TMDB images are never resized or re-encoded (ADR 0007 point 6).
        const o = await deps.images.getBytes(`${c.value.value.base}${size}${image.ref}`);
        if (o.kind !== 'ok') return toResult(o);
        if (!/^image\/(jpeg|png|webp)$/.test(o.value.contentType)) return { status: 'invalid_request', detail: `tmdb: unsupported ${o.value.contentType || 'content type'}` };
        const w = Number(/^w(\d+)$/.exec(size)?.[1] ?? image.width ?? 0) || null;
        const h = w && image.width && image.height ? Math.round((w * image.height) / image.width) : null;
        files.push({ bytes: o.value.bytes, contentType: o.value.contentType, size, width: w, height: h });
      }
      return { status: 'ok', value: files };
    },
  };
  return adapter;
}
