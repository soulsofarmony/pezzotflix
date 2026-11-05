// Builders of wbgetentities-shaped entities (formatversion=2) for tests. Wikidata data is CC0.
import { type Route, testImage } from './metadata-fetch.ts';

export interface EpisodeBinding {
  season: number;
  episode: number;
  it?: string;
  en?: string;
}

/**
 * Routes answering like the Wikidata Action API, WDQS and Commons. search maps a lower-case title
 * (the text before " haswbstatement:") to QIDs; haswbstatement:Pxxx=id lookups use the entities.
 */
export function wikidataRoutes(opts: { entities: ReturnType<typeof wdEntity>[]; search?: Record<string, string[]>; episodes?: Record<string, EpisodeBinding[]> }): Route[] {
  return [
    {
      match: (u) => u.host === 'www.wikidata.org' && u.searchParams.get('list') === 'search',
      reply: (u) => {
        const q = u.searchParams.get('srsearch') ?? '';
        const byId = /^haswbstatement:(P\d+)=(\S+)$/.exec(q);
        if (byId) {
          const [, prop, id] = byId;
          const hits = opts.entities.filter((e) => (e.claims[prop ?? ''] ?? []).some((c) => (c.mainsnak.datavalue as { value: unknown }).value === id));
          return { json: { query: { search: hits.map((e) => ({ title: e.id })) } } };
        }
        // Full text: punctuation does not matter, as on CirrusSearch.
        const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const title = words(q.replace(/\s*haswbstatement:\S+$/, ''));
        const hit = Object.entries(opts.search ?? {}).find(([k]) => words(k) === title)?.[1] ?? [];
        return { json: { query: { search: hit.map((t) => ({ title: t })) } } };
      },
    },
    { match: (u) => u.host === 'www.wikidata.org' && u.searchParams.get('action') === 'wbgetentities', reply: (u) => ({ json: entitiesReply(opts.entities, u) }) },
    {
      match: (u) => u.host === 'query.wikidata.org',
      reply: (u) => {
        const qid = /wd:(Q\d+)/.exec(u.searchParams.get('query') ?? '')?.[1] ?? '';
        const rows = (opts.episodes?.[qid] ?? []).map((b) => ({
          sn: { value: String(b.season) },
          en: { value: String(b.episode) },
          ...(b.it ? { ll: { value: b.it } } : {}),
          ...(b.en ? { enl: { value: b.en } } : {}),
        }));
        return { json: { results: { bindings: rows } } };
      },
    },
    { match: (u) => u.host === 'commons.wikimedia.org', reply: async (u) => ({ bytes: await testImage(800, 450, u.pathname.length), contentType: 'image/jpeg' }) },
  ];
}

type Snak = Record<string, unknown>;
export type RawClaim = { mainsnak: Snak; rank: string; qualifiers?: Record<string, Snak[]> };

const snak = (type: string, value: unknown): Snak => ({ snaktype: 'value', datavalue: { type, value } });

export const claim = {
  item: (id: string, qualifiers?: { P4633?: string[] }): RawClaim => ({
    mainsnak: snak('wikibase-entityid', { 'entity-type': 'item', id }),
    rank: 'normal',
    ...(qualifiers?.P4633 ? { qualifiers: { P4633: qualifiers.P4633.map((s) => snak('string', s)) } } : {}),
  }),
  time: (time: string): RawClaim => ({ mainsnak: snak('time', { time, precision: 11 }), rank: 'normal' }),
  text: (text: string, language: string): RawClaim => ({ mainsnak: snak('monolingualtext', { text, language }), rank: 'normal' }),
  str: (s: string): RawClaim => ({ mainsnak: snak('string', s), rank: 'normal' }),
  quantity: (amount: number, unit: string): RawClaim => ({ mainsnak: snak('quantity', { amount: `+${amount}`, unit: `http://www.wikidata.org/entity/${unit}` }), rank: 'normal' }),
};

export function wdEntity(id: string, labels: Record<string, string>, claims: Record<string, RawClaim[]> = {}, aliases: Record<string, string[]> = {}) {
  return {
    id,
    labels: Object.fromEntries(Object.entries(labels).map(([l, value]) => [l, { language: l, value }])),
    aliases: Object.fromEntries(Object.entries(aliases).map(([l, vs]) => [l, vs.map((value) => ({ language: l, value }))])),
    claims,
  };
}

/** The wbgetentities answer for the ids of a request URL; unknown ids are `missing`. */
export function entitiesReply(all: ReturnType<typeof wdEntity>[], u: URL) {
  const ids = (u.searchParams.get('ids') ?? '').split('|');
  return { entities: Object.fromEntries(ids.map((id) => [id, all.find((e) => e.id === id) ?? { id, missing: '' }])) };
}
