// Wikidata adapter (ADR 0007 option A): identifies works and is the durable CC0 base (titles,
// original title, year, kind, documentary flag, genres, director and cast, external ids).
// Search is CirrusSearch full text restricted to works with a TMDB id, as measured in S4
// (`haswbstatement:P4947|P4983`); a query that failed twice switches to wbsearchentities on labels
// (ADR 0007 point 7). Entity data comes from wbgetentities (Action API), episodes from one WDQS
// query per series, images from Commons. One request per second per host, with a User-Agent that
// carries the contact (Wikimedia policy).
import { type ExternalIdLookup, type ExternalIds, type MetadataCandidate, type MetadataSearchRequest, type ProviderResult, WIKIDATA_NOTICE, type WorkKind } from '../../shared/metadata.ts';
import type { CreditInput } from '../../shared/ports.ts';
import type { ProviderCache } from './cache.ts';
import type { HostGate } from './http.ts';
import { cached, DAY_MS, type DownloadedFile, type ImageRef, langBase, NEGATIVE_TTL_MS, type ProviderAdapter, type SeasonDetails, toResult, type WorkDetails } from './types.ts';

export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
export const WDQS = 'https://query.wikidata.org/sparql';
export const COMMONS_FILE = 'https://commons.wikimedia.org/wiki/Special:FilePath/';

export const WIKIDATA_CACHE_TTL_MS = 30 * DAY_MS;
/** Cast members kept from P161 (unordered on Wikidata: claim order). */
export const WIKIDATA_CAST_LIMIT = 10;
/** Failures of one full-text query before the label search is used instead (S4: "2012" → 504). */
export const SEARCH_FAILURES_BEFORE_FALLBACK = 2;
/** Commons renders a thumbnail of this width (SVG logos become PNG). */
export const COMMONS_WIDTH = 1920;
const ENTITY_BATCH = 50;

const PROPS = ['P31', 'P136', 'P57', 'P161', 'P170', 'P577', 'P580', 'P1476', 'P2047', 'P18', 'P154', 'P3383', 'P4947', 'P4983', 'P345', 'P4835'] as const;

/** documentary film, documentary television series, historical documentary television series. */
export const DOCUMENTARY_CLASSES = new Set(['Q93204', 'Q133731271', 'Q116515088']);
/** television series, miniseries, animated series, web series, anime/animated television series, television program. */
export const SERIES_CLASSES = new Set(['Q5398426', 'Q1259759', 'Q581714', 'Q526877', 'Q63952888', 'Q117467246', 'Q15416']);
const FILM_CLASS = 'Q11424';
const UNIT_MS: Record<string, number> = { Q7727: 60_000, Q11574: 1000, Q25235: 3600_000 };

/** One claim value, trimmed: item id, time string, text, number or file name. */
export interface WdClaim {
  v: string | number;
  lang?: string;
  unit?: string;
  /** Qualifier values by property (P4633 character name). */
  q?: Record<string, string[]>;
}

export interface WdEntity {
  id: string;
  labels: Record<string, string>;
  aliases: Record<string, string[]>;
  claims: Partial<Record<string, WdClaim[]>>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const scalar = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

function snakValue(snak: Json): WdClaim | null {
  if (snak.snaktype !== 'value') return null;
  const dv = obj(snak.datavalue);
  const value = dv.value;
  switch (dv.type) {
    case 'wikibase-entityid':
      return str(obj(value).id) ? { v: String(obj(value).id) } : null;
    case 'time':
      return str(obj(value).time) ? { v: String(obj(value).time) } : null;
    case 'monolingualtext': {
      const text = str(obj(value).text);
      return text ? { v: text, lang: scalar(obj(value).language) } : null;
    }
    case 'quantity': {
      const amount = Number(obj(value).amount);
      const unit = scalar(obj(value).unit).split('/').pop() ?? '';
      return Number.isFinite(amount) ? { v: amount, unit } : null;
    }
    case 'string':
      return str(value) ? { v: String(value) } : null;
    default:
      return null;
  }
}

/** Keeps the labels, aliases and claims the adapter reads; deprecated claims dropped, preferred first. */
export function trimEntity(raw: unknown, langs: readonly string[], props: readonly string[] = PROPS): WdEntity | null {
  const e = obj(raw);
  const id = str(e.id);
  if (!id || 'missing' in e) return null;
  const labels: Record<string, string> = {};
  const aliases: Record<string, string[]> = {};
  for (const l of langs) {
    const label = str(obj(obj(e.labels)[l]).value);
    if (label) labels[l] = label;
    const al = arr(obj(e.aliases)[l]).map((a) => str(obj(a).value)).filter((a): a is string => a !== null);
    if (al.length) aliases[l] = al;
  }
  const claims: Partial<Record<string, WdClaim[]>> = {};
  for (const p of props) {
    const list = arr(obj(e.claims)[p]).map(obj).filter((c) => c.rank !== 'deprecated');
    const ordered = [...list.filter((c) => c.rank === 'preferred'), ...list.filter((c) => c.rank !== 'preferred')];
    const values: WdClaim[] = [];
    for (const c of ordered) {
      const v = snakValue(obj(c.mainsnak));
      if (!v) continue;
      if (p === 'P161') {
        const names = arr(obj(c.qualifiers).P4633).map((s) => snakValue(obj(s))?.v).filter((x): x is string => typeof x === 'string');
        if (names.length) v.q = { P4633: names };
      }
      values.push(v);
    }
    if (values.length) claims[p] = values;
  }
  return { id, labels, aliases, claims };
}

const ids = (e: WdEntity, p: string): string[] => (e.claims[p] ?? []).map((c) => String(c.v));
const texts = (e: WdEntity, p: string): string[] => (e.claims[p] ?? []).map((c) => String(c.v));

/** Years of time values like "+2017-10-06T00:00:00Z" (BCE dates ignored), ascending. */
export function yearsOf(e: WdEntity, p: string): number[] {
  const ys = (e.claims[p] ?? []).map((c) => /^\+(\d{4,})-/.exec(String(c.v))?.[1]).filter((y): y is string => !!y).map(Number);
  return [...new Set(ys)].sort((a, b) => a - b);
}

export function kindOf(e: WdEntity): WorkKind {
  const movie = (e.claims.P4947 ?? []).length > 0;
  const series = (e.claims.P4983 ?? []).length > 0;
  const seriesClass = ids(e, 'P31').some((c) => SERIES_CLASSES.has(c));
  if (movie && !series) return 'movie';
  if (series && !movie) return 'series';
  return seriesClass ? 'series' : 'movie';
}

/** Direct documentary signal: P31 or P136 is a documentary class. */
export function documentaryOf(e: WdEntity, subclassesOf?: (qid: string) => string[]): boolean | null {
  const classes = [...ids(e, 'P31'), ...ids(e, 'P136')];
  const isDoc = (q: string) => DOCUMENTARY_CLASSES.has(q) || (subclassesOf?.(q) ?? []).some((s) => DOCUMENTARY_CLASSES.has(s));
  if (classes.some(isDoc)) return true;
  if (ids(e, 'P31').some((c) => c === FILM_CLASS || SERIES_CLASSES.has(c))) return false;
  return null;
}

export function externalIdsOf(e: WdEntity, kind: WorkKind): ExternalIds {
  const tmdb = kind === 'movie' ? (ids(e, 'P4947')[0] ?? ids(e, 'P4983')[0]) : (ids(e, 'P4983')[0] ?? ids(e, 'P4947')[0]);
  const imdb = ids(e, 'P345').find((x) => /^tt\d+$/.test(x));
  const tvdb = ids(e, 'P4835')[0];
  return { wikidata: e.id, ...(tmdb ? { tmdb } : {}), ...(imdb ? { imdb } : {}), ...(tvdb ? { tvdb } : {}) };
}

export function candidateOf(e: WdEntity, lang: string): MetadataCandidate {
  const base = langBase(lang);
  const kind = kindOf(e);
  const starts = yearsOf(e, 'P580');
  const aliases = [...new Set([...(e.aliases[base] ?? []), ...(e.aliases.en ?? [])])].slice(0, 12);
  return {
    ref: { provider: 'wikidata', id: e.id, kind },
    titles: { localized: e.labels[base] ?? null, english: e.labels.en ?? null, original: [...new Set(texts(e, 'P1476'))], aliases },
    years: kind === 'series' && starts.length ? starts : yearsOf(e, 'P577'),
    documentary: documentaryOf(e),
    externalIds: externalIdsOf(e, kind),
    voteCount: null,
  };
}

/** Strips CirrusSearch syntax from a title (quotes, keyword prefixes): S4 replaced quotes only. */
export const sanitizeQuery = (q: string): string =>
  q
    .replace(/["\\]/g, ' ')
    .replace(/\b(?:haswbstatement|insource|intitle|incategory|prefix|deepcat|hastemplate):/gi, ' ')
    .replace(/(^|\s)[-!~](?=\S)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

const ID_PROP: Record<Exclude<ExternalIdLookup['ns'], 'wikidata'>, string> = { tmdb_movie: 'P4947', tmdb_tv: 'P4983', imdb: 'P345', tvdb: 'P4835' };
const ID_PATTERN: Record<ExternalIdLookup['ns'], RegExp> = { wikidata: /^Q\d+$/, tmdb_movie: /^\d+$/, tmdb_tv: /^\d+$/, imdb: /^tt\d+$/, tvdb: /^\d+$/ };

export interface WikidataDeps {
  api: HostGate;
  wdqs: HostGate;
  commons: HostGate;
  cache: ProviderCache;
  now: () => number;
  enabled: boolean;
}

interface EpisodeRow {
  s: number;
  e: number;
  t: string | null;
  y: number | null;
}

export function createWikidata(deps: WikidataDeps): ProviderAdapter {
  const { api, wdqs, commons, cache, now } = deps;
  const searchFailures = new Map<string, number>();
  const langsOf = (lang: string) => [...new Set([langBase(lang), 'en'])];

  async function apiJson(params: Record<string, string>): Promise<ProviderResult<Json>> {
    const url = `${WIKIDATA_API}?${new URLSearchParams({ ...params, format: 'json', formatversion: '2' }).toString()}`;
    const o = await api.getJson(url);
    if (o.kind !== 'ok') return toResult(o);
    const body = obj(o.value);
    // The Action API reports errors with HTTP 200.
    if ('error' in body) return { status: 'unavailable', detail: `wikidata: ${scalar(obj(body.error).code) || 'error'}` };
    return { status: 'ok', value: body };
  }

  const fullText = async (srsearch: string, limit: number): Promise<ProviderResult<string[]>> => {
    const r = await apiJson({ action: 'query', list: 'search', srsearch, srnamespace: '0', srlimit: String(limit), srprop: '', srinfo: '' });
    if (r.status !== 'ok') return r;
    return { status: 'ok', value: arr(obj(r.value.query).search).map((s) => str(obj(s).title)).filter((t): t is string => !!t && /^Q\d+$/.test(t)) };
  };

  const labelSearch = async (q: string, lang: string): Promise<ProviderResult<string[]>> => {
    const r = await apiJson({ action: 'wbsearchentities', search: q, language: langBase(lang), uselang: langBase(lang), type: 'item', limit: '10' });
    if (r.status !== 'ok') return r;
    return { status: 'ok', value: arr(r.value.search).map((s) => str(obj(s).id)).filter((t): t is string => !!t) };
  };

  /** Trimmed entities by id (cached per id); `kind` picks the props and labels kept. */
  async function entities(qids: readonly string[], langs: readonly string[], mode: 'work' | 'label' | 'class'): Promise<ProviderResult<Map<string, { e: WdEntity; fetchedAt: number }>>> {
    const out = new Map<string, { e: WdEntity; fetchedAt: number }>();
    const missing: string[] = [];
    const keyOf = (q: string) => `${mode}:${langs.join(',')}:${q}`;
    for (const q of new Set(qids)) {
      const hit = cache.get<WdEntity | { nf: true }>('wikidata', keyOf(q), WIKIDATA_CACHE_TTL_MS, now());
      if (hit && !('nf' in hit.value)) out.set(q, { e: hit.value, fetchedAt: hit.fetchedAt });
      // A missing entity is asked again after a day: someone may create or undelete it.
      else if (!hit || now() - hit.fetchedAt > NEGATIVE_TTL_MS) missing.push(q);
    }
    const props = mode === 'work' ? 'labels|aliases|claims' : mode === 'class' ? 'labels|claims' : 'labels';
    const keep = mode === 'work' ? PROPS : mode === 'class' ? ['P279'] : [];
    for (let i = 0; i < missing.length; i += ENTITY_BATCH) {
      const batch = missing.slice(i, i + ENTITY_BATCH);
      const r = await apiJson({ action: 'wbgetentities', ids: batch.join('|'), props, languages: langs.join('|') });
      if (r.status !== 'ok') return r;
      const t = now();
      const got = obj(r.value.entities);
      const all = Object.values(got).map(obj);
      for (const q of batch) {
        // A merged item answers under its new id, with redirects.from = the id asked.
        const raw = got[q] ?? all.find((x) => obj(x.redirects).from === q);
        const e = trimEntity(raw, langs, keep);
        cache.put('wikidata', keyOf(q), e ?? { nf: true }, t);
        if (e) out.set(q, { e, fetchedAt: t });
      }
    }
    return { status: 'ok', value: out };
  }

  async function candidatesOf(qids: string[], lang: string, needTmdbId: boolean): Promise<ProviderResult<MetadataCandidate[]>> {
    const r = await entities(qids, langsOf(lang), 'work');
    if (r.status !== 'ok') return r;
    const list = qids.map((q) => r.value.get(q)?.e).filter((e): e is WdEntity => !!e);
    const kept = needTmdbId ? list.filter((e) => (e.claims.P4947 ?? []).length || (e.claims.P4983 ?? []).length) : list;
    return { status: 'ok', value: kept.map((e) => candidateOf(e, lang)) };
  }

  const label = (e: WdEntity | undefined, langs: readonly string[]): string | null => (e ? (langs.map((l) => e.labels[l]).find(Boolean) ?? null) : null);

  return {
    name: 'wikidata',
    state: () => (!deps.enabled ? 'not_configured' : api.health() === 'ok' ? 'ok' : 'degraded'),
    terms: () => ({ retention: 'durable', attribution: WIKIDATA_NOTICE, purgeOnTermination: false, cacheTtlMs: WIKIDATA_CACHE_TTL_MS }),

    async search(req: MetadataSearchRequest) {
      const q = sanitizeQuery(req.query);
      if (!q) return { status: 'ok', value: [] };
      const key = q.toLowerCase();
      const fallback = (searchFailures.get(key) ?? 0) >= SEARCH_FAILURES_BEFORE_FALLBACK;
      const r = fallback
        ? await cached(cache, 'wikidata', `label:${langBase(req.lang)}:${key}`, WIKIDATA_CACHE_TTL_MS, now, () => labelSearch(q, req.lang))
        : await cached(cache, 'wikidata', `search:${key}`, WIKIDATA_CACHE_TTL_MS, now, () => fullText(`${q} haswbstatement:P4947|P4983`, 10));
      if (r.status === 'unavailable' && !fallback) searchFailures.set(key, (searchFailures.get(key) ?? 0) + 1);
      if (r.status === 'not_found') return { status: 'ok', value: [] };
      if (r.status !== 'ok') return r;
      if (!fallback) searchFailures.delete(key);
      // kind is a hint: works of both kinds are returned, the identifier filters (standard §2).
      return candidatesOf(r.value.value, req.lang, fallback);
    },

    async lookupByExternalId(l) {
      if (!ID_PATTERN[l.ns].test(l.id)) return { status: 'invalid_request', detail: `wikidata: bad ${l.ns} id` };
      let qids: string[];
      if (l.ns === 'wikidata') {
        qids = [l.id];
      } else {
        const prop = ID_PROP[l.ns];
        const r = await cached(cache, 'wikidata', `lookup:${prop}:${l.id}`, WIKIDATA_CACHE_TTL_MS, now, async () => {
          const s = await fullText(`haswbstatement:${prop}=${l.id}`, 5);
          return s.status === 'ok' && !s.value.length ? { status: 'not_found' } : s;
        });
        if (r.status !== 'ok') return r;
        qids = r.value.value;
      }
      const c = await candidatesOf(qids, l.lang, false);
      if (c.status !== 'ok') return c;
      const want: WorkKind | null = l.ns === 'tmdb_movie' ? 'movie' : l.ns === 'tmdb_tv' ? 'series' : null;
      const best = c.value.find((x) => !want || x.ref.kind === want) ?? c.value[0];
      return best ? { status: 'ok', value: best } : { status: 'not_found' };
    },

    async details(kind, id, lang): Promise<ProviderResult<WorkDetails>> {
      if (!/^Q\d+$/.test(id)) return { status: 'invalid_request', detail: 'wikidata: bad QID' };
      const langs = langsOf(lang);
      const r = await entities([id], langs, 'work');
      if (r.status !== 'ok') return r;
      const hit = r.value.get(id);
      if (!hit) return { status: 'not_found' };
      const e = hit.e;
      const classIds = [...ids(e, 'P31'), ...ids(e, 'P136')];
      const cast = ids(e, 'P161').slice(0, WIKIDATA_CAST_LIMIT);
      const personIds = [...ids(e, 'P57'), ...cast, ...(kind === 'series' ? ids(e, 'P170') : [])];
      const classes = await entities(classIds, langs, 'class');
      if (classes.status !== 'ok') return classes;
      const persons = await entities(personIds, langs, 'label');
      if (persons.status !== 'ok') return persons;
      const subclasses = (q: string) => (classes.value.get(q)?.e.claims.P279 ?? []).map((c) => String(c.v));
      const documentary = documentaryOf(e, subclasses);
      const cand = { ...candidateOf(e, lang), documentary };
      const genres = [...new Set(ids(e, 'P136').map((g) => label(classes.value.get(g)?.e, langs)).filter((g): g is string => !!g))];
      const credits: CreditInput[] = [];
      const add = (qid: string, role: CreditInput['role'], order: number, character: string | null) => {
        const name = label(persons.value.get(qid)?.e, langs);
        if (name) credits.push({ name, role, character, order, personRef: qid });
      };
      ids(e, 'P57').forEach((q, i) => add(q, 'director', i, null));
      if (kind === 'series') ids(e, 'P170').forEach((q, i) => add(q, 'creator', i, null));
      (e.claims.P161 ?? []).slice(0, WIKIDATA_CAST_LIMIT).forEach((c, i) => add(String(c.v), 'actor', i, c.q?.P4633?.[0] ?? null));
      const image = (p: string, type: ImageRef['type']): ImageRef[] => {
        const file = texts(e, p)[0];
        return file ? [{ type, ref: file, language: null, width: null, height: null }] : [];
      };
      return {
        status: 'ok',
        value: {
          provider: 'wikidata',
          id: e.id,
          kind,
          fetchedAt: hit.fetchedAt,
          candidate: cand,
          fields: {
            title: cand.titles.localized ?? cand.titles.english ?? cand.titles.original[0] ?? null,
            originalTitle: cand.titles.original[0] ?? null,
            year: cand.years[0] ?? null,
            category: documentary ? 'documentary' : kind === 'movie' ? 'film' : null,
            genres,
          },
          credits,
          // P18 is rarely a poster (S4): it stands in for a backdrop.
          images: [...image('P3383', 'poster'), ...image('P18', 'backdrop'), ...image('P154', 'logo')],
        },
      };
    },

    async seasons(seriesId, numbers, lang): Promise<ProviderResult<SeasonDetails[]>> {
      if (!/^Q\d+$/.test(seriesId)) return { status: 'invalid_request', detail: 'wikidata: bad QID' };
      const base = langBase(lang);
      const r = await cached(cache, 'wikidata', `episodes:${base}:${seriesId}`, WIKIDATA_CACHE_TTL_MS, now, async (): Promise<ProviderResult<EpisodeRow[]>> => {
        const query = `SELECT ?sn ?en ?ll ?enl ?date WHERE {
  ?season p:P179 ?ss . ?ss ps:P179 wd:${seriesId} ; pq:P1545 ?sn .
  ?ep p:P4908 ?es . ?es ps:P4908 ?season ; pq:P1545 ?en .
  OPTIONAL { ?ep rdfs:label ?ll FILTER(LANG(?ll) = "${base}") }
  OPTIONAL { ?ep rdfs:label ?enl FILTER(LANG(?enl) = "en") }
  OPTIONAL { ?ep wdt:P577 ?date }
}`;
        const o = await wdqs.getJson(`${WDQS}?${new URLSearchParams({ query, format: 'json' }).toString()}`, { Accept: 'application/sparql-results+json' });
        if (o.kind !== 'ok') return toResult(o);
        const rows = new Map<string, EpisodeRow>();
        for (const b of arr(obj(obj(o.value).results).bindings).map(obj)) {
          const v = (k: string) => str(obj(b[k]).value);
          const s = Number(v('sn'));
          const e = Number(v('en'));
          if (!Number.isInteger(s) || !Number.isInteger(e)) continue;
          const key = `${s}:${e}`;
          if (rows.has(key)) continue;
          const y = /^(\d{4})-/.exec(v('date') ?? '')?.[1];
          rows.set(key, { s, e, t: v('ll') ?? v('enl'), y: y ? Number(y) : null });
        }
        return { status: 'ok', value: [...rows.values()] };
      });
      if (r.status === 'not_found') return { status: 'ok', value: [] };
      if (r.status !== 'ok') return r;
      const out: SeasonDetails[] = [];
      for (const n of numbers) {
        const eps = r.value.value.filter((x) => x.s === n).sort((a, b) => a.e - b.e);
        if (!eps.length) continue;
        out.push({ season: n, fetchedAt: r.value.fetchedAt, fields: {}, poster: null, episodes: eps.map((x) => ({ episode: x.e, fields: { title: x.t, year: x.y }, still: null })) });
      }
      return { status: 'ok', value: out };
    },

    async fetchImage(image): Promise<ProviderResult<DownloadedFile[]>> {
      const url = `${COMMONS_FILE}${encodeURIComponent(image.ref.replace(/ /g, '_'))}?width=${COMMONS_WIDTH}`;
      const o = await commons.getBytes(url);
      if (o.kind !== 'ok') return toResult(o);
      if (!/^image\/(jpeg|png|webp|gif)$/.test(o.value.contentType)) return { status: 'invalid_request', detail: `commons: unsupported ${o.value.contentType || 'content type'}` };
      return { status: 'ok', value: [{ bytes: o.value.bytes, contentType: o.value.contentType, size: 'original', width: null, height: null }] };
    },
  };
}

/** Duration of P2047 in ms. Not written: the container duration is exact for playable items. */
export function durationMsOf(e: WdEntity): number | null {
  const c = (e.claims.P2047 ?? [])[0];
  if (!c || typeof c.v !== 'number') return null;
  const unit = UNIT_MS[c.unit ?? ''];
  return unit ? Math.round(c.v * unit) : null;
}
