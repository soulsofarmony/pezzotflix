// identifier.identify on an in-memory DB: outcomes, idempotency rules, retries and the catalog
// writes made in the same transaction (doc 02 §3.3, ADR 0007 point 4).
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobContext } from '../src/app/module.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { createCatalogWriter } from '../src/modules/catalog/write.ts';
import { NO_PROVIDER_RETRY_MS } from '../src/modules/identifier/resolvers.ts';
import { createIdentifier, IDENTIFY_MAX_ATTEMPTS, requeuePending, RetryLaterError, type StoredCandidate } from '../src/modules/identifier/service.ts';
import { createJobRunner, enqueueJob } from '../src/modules/jobs/index.ts';
import type { MetadataCandidate } from '../src/shared/metadata.ts';
import type { MetadataSearchPort } from '../src/shared/ports.ts';
import { byExternalId, byTitle, cand, fakeMetadata } from './helpers/fake-metadata.ts';

const log = pino({ level: 'silent' });
const ctx: JobContext = { jobId: 'j', attempt: 1, log, signal: new AbortController().signal };
const T0 = 1_700_000_000_000;

let db: Db;
let events: { type: string; payload: Record<string, unknown> }[];
let metadata: (MetadataSearchPort & { calls: unknown[] }) | null;

const br2049 = cand({ id: 'Q21451539', title: 'Blade Runner 2049', original: ['Blade Runner 2049'], years: [2017], ids: { tmdb: '335984', imdb: 'tt1856101' } });
const blade82 = cand({ id: 'Q184843', title: 'Blade Runner', years: [1982], ids: { tmdb: '78' } });
const dune = cand({ id: 'Q63985561', title: 'Dune', years: [2021], ids: { tmdb: '438631' } });
const dark = cand({ id: 'Q24300155', kind: 'series', title: 'Dark', years: [2017], ids: { tmdb: '70523' } });
const WD = { 'blade runner 2049': [br2049, blade82], 'blade runner': [blade82, br2049], dune: [dune], dark: [dark] };
const wikidata = (table: Record<string, MetadataCandidate[]> = WD) => fakeMetadata({ wikidata: { search: byTitle(table), lookup: byExternalId(Object.values(table).flat()) } });

beforeEach(async () => {
  db = await openDb({ path: ':memory:' });
  events = [];
  metadata = wikidata();
  const ins = db.$client.prepare("INSERT INTO library_root (id, name, mount_path, hint, created_at) VALUES (?, ?, ?, ?, 0)");
  ins.run('movies', 'Film', '/media/movies', 'movies');
  ins.run('series', 'Serie', '/media/series', 'series');
  ins.run('copy', 'Copia', '/media/copy', 'movies');
});
afterEach(() => closeDb(db));

const publish = { publish: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }) };
const catalog = () => createCatalogWriter({ db, now: () => T0, events: () => publish, tmdbMaxAgeMs: 180 * 86_400_000 });
const identifier = () => createIdentifier({ db, now: () => T0, log, events: () => publish, catalog, metadata: () => metadata, lang: 'it' });
const identify = (fileId: string, attempt = 1) => identifier().identify({ fileId }, { ...ctx, attempt });

let seq = 0;
function file(rootId: string, relPath: string, opts: { state?: string; fingerprint?: string; durationMs?: number } = {}): string {
  const id = `f${++seq}`;
  const facts = opts.durationMs ? JSON.stringify({ durationMs: opts.durationMs }) : null;
  db.$client
    .prepare('INSERT INTO media_file (id, root_id, rel_path, size_bytes, mtime_ms, fingerprint, state, facts, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?, ?, 0, 0)')
    .run(id, rootId, relPath, opts.fingerprint ?? null, opts.state ?? 'analyzed', facts);
  return id;
}
const q = <T>(sql: string, ...args: unknown[]) => db.$client.prepare(sql).all(...args) as T[];
const one = <T>(sql: string, ...args: unknown[]) => db.$client.prepare(sql).get(...args) as T | undefined;
const caseOf = (fileId: string) => {
  const c = one<{ id: string; state: string; reason: string | null; candidates: string | null; parsed: string | null }>('SELECT * FROM identification_case WHERE file_id = ?', fileId);
  return c && { ...c, candidates: JSON.parse(c.candidates ?? '[]') as StoredCandidate[], parsed: JSON.parse(c.parsed ?? 'null') as Record<string, unknown> };
};
const stateOf = (fileId: string) => one<{ state: string }>('SELECT state FROM media_file WHERE id = ?', fileId)?.state;
const linksOf = (fileId: string) => q<{ item_id: string; origin: string; confidence: number }>('SELECT item_id, origin, confidence FROM media_link WHERE file_id = ? ORDER BY item_id', fileId);
const item = (id: string) => one<{ kind: string; parent_id: string | null; title: string; year: number | null; duration_ms: number | null; season_number: number | null; episode_number: number | null }>('SELECT * FROM catalog_item WHERE id = ?', id);
const countItems = (kind?: string) => one<{ n: number }>(`SELECT count(*) AS n FROM catalog_item${kind ? ' WHERE kind = ?' : ''}`, ...(kind ? [kind] : []))?.n;
const searches = () => (metadata?.calls ?? []).length;

describe('auto match', () => {
  it('writes case, auto link and catalog work in one go', async () => {
    const f = file('movies', 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv', { durationMs: 9_840_000 });
    await identify(f);
    const [link] = linksOf(f);
    expect(link).toMatchObject({ origin: 'auto', confidence: 1 });
    expect(item(link!.item_id)).toMatchObject({ kind: 'movie', parent_id: null, title: 'Blade Runner 2049', year: 2017, duration_ms: 9_840_000 });
    expect(caseOf(f)).toMatchObject({ state: 'auto_matched', reason: null });
    expect(stateOf(f)).toBe('identified');
    expect(q('SELECT provider, external_id FROM external_id ORDER BY provider')).toEqual([
      { provider: 'imdb', external_id: 'tt1856101' },
      { provider: 'tmdb', external_id: '335984' },
      { provider: 'wikidata', external_id: 'Q21451539' },
    ]);
    expect(events.map((e) => e.type)).toEqual(['library.item_added']);
  });

  it('stores the scored candidates with their provider', async () => {
    const f = file('movies', 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv');
    await identify(f);
    const cands = caseOf(f)?.candidates ?? [];
    expect(cands.map((c) => [c.provider, c.ref.id])).toEqual([
      ['wikidata', 'Q21451539'],
      ['wikidata', 'Q184843'],
    ]);
    expect(cands[0]).toMatchObject({ kind: 'movie', title: 'Blade Runner 2049', year: 2017, score: 1, evidence: { title: 1, year: 1, kind: 1 } });
  });

  it('D2: two files of the same work end on one item, an edition on its own', async () => {
    const a = file('movies', 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv');
    const b = file('copy', 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv');
    const c = file('movies', 'Blade Runner 2049 (2017) {edition-Final Cut}/Blade Runner 2049 (2017) {edition-Final Cut}.mkv');
    for (const f of [a, b, c]) await identify(f);
    expect(linksOf(a)[0]?.item_id).toBe(linksOf(b)[0]?.item_id);
    expect(linksOf(c)[0]?.item_id).not.toBe(linksOf(a)[0]?.item_id);
    expect(countItems('movie')).toBe(2);
    expect(events.filter((e) => e.type === 'library.item_updated')).toHaveLength(1);
  });

  it('episodes: series → season → episode, a multi-episode file linked to each, siblings reuse the series', async () => {
    const e1 = file('series', 'Dark (2017)/Season 01/Dark (2017) - S01E01 - Segreti.mkv');
    const e23 = file('series', 'Dark (2017)/Season 01/Dark (2017) - S01E02-E03.mkv');
    await identify(e1);
    const callsAfterFirst = searches();
    await identify(e23);
    expect(searches()).toBe(callsAfterFirst); // the sibling's series, no provider call
    const [ep1] = linksOf(e1);
    expect(item(ep1!.item_id)).toMatchObject({ kind: 'episode', title: 'Segreti', season_number: 1, episode_number: 1 });
    const eps = linksOf(e23).map((l) => item(l.item_id)?.episode_number).sort();
    expect(eps).toEqual([2, 3]);
    expect([countItems('series'), countItems('season'), countItems('episode')]).toEqual([1, 1, 3]);
    expect(caseOf(e23)?.parsed).toMatchObject({ evidence: { resolver: 'sibling' } });
  });

  it('extras attach to their work (after it, or resolving the owner first); orphans are valid', async () => {
    const trailerFirst = file('movies', 'Dune (2021)/Trailers/Trailer ufficiale.mkv');
    await identify(trailerFirst);
    const movie = file('movies', 'Dune (2021)/Dune (2021).mkv');
    await identify(movie);
    const featurette = file('movies', 'Dune (2021)/Featurettes/Making of.mkv');
    await identify(featurette);
    const duneId = linksOf(movie)[0]?.item_id;
    expect(item(linksOf(trailerFirst)[0]!.item_id)).toMatchObject({ kind: 'extra', parent_id: duneId, title: 'Trailer ufficiale' });
    expect(item(linksOf(featurette)[0]!.item_id)).toMatchObject({ kind: 'extra', parent_id: duneId, title: 'Making of' });
    expect(caseOf(featurette)?.parsed).toMatchObject({ evidence: { resolver: 'sibling' } });

    const orphan = file('movies', 'Extras/Intervista.mkv');
    await identify(orphan);
    expect(item(linksOf(orphan)[0]!.item_id)).toMatchObject({ kind: 'extra', parent_id: null, title: 'Intervista' });
    expect(countItems('movie')).toBe(1);
  });
});

describe('needs review', () => {
  it('a weak match goes to review with an event, once', async () => {
    const f = file('movies', 'Blade Runner (2049)/Blade Runner (2049).mkv');
    await identify(f);
    expect(caseOf(f)).toMatchObject({ state: 'needs_review', reason: 'low_score' });
    expect(stateOf(f)).toBe('needs_review');
    expect(linksOf(f)).toEqual([]);
    expect(events).toEqual([{ type: 'identification.needs_review', payload: { caseId: caseOf(f)?.id, fileId: f, reason: 'low_score' } }]);
    await identify(f);
    expect(events).toHaveLength(1);
  });

  it('parse reasons need no provider: multi_part, no_title', async () => {
    const part = file('movies', 'Kill Bill (2003)/Kill Bill (2003) - part1.mkv');
    const junk = file('movies', 'misc/BDMV_DISC1_t00.mkv');
    await identify(part);
    await identify(junk);
    expect(caseOf(part)).toMatchObject({ state: 'needs_review', reason: 'multi_part' });
    expect(caseOf(junk)).toMatchObject({ state: 'needs_review', reason: 'no_title' });
    expect(searches()).toBe(0);
  });

  it('a renamed file in review is identified again: same case, updated', async () => {
    const f = file('movies', 'Blade Runner (2049)/Blade Runner (2049).mkv');
    await identify(f);
    const before = caseOf(f);
    db.$client.prepare("UPDATE media_file SET rel_path = 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv' WHERE id = ?").run(f);
    await identify(f);
    expect(caseOf(f)).toMatchObject({ id: before?.id, state: 'auto_matched', reason: null });
    expect(q('SELECT id FROM identification_case')).toHaveLength(1);
    expect(linksOf(f)).toHaveLength(1);
  });
});

describe('idempotency', () => {
  it('an unknown, missing or not yet analysed file is a no-op', async () => {
    await identify('nope');
    const missing = file('movies', 'Dune (2021)/Dune (2021).mkv', { state: 'missing' });
    const fresh = file('copy', 'Dune (2021)/Dune (2021).mkv', { state: 'discovered' });
    await identify(missing);
    await identify(fresh);
    expect(q('SELECT * FROM identification_case')).toEqual([]);
    expect(searches()).toBe(0);
  });

  it('running twice changes nothing', async () => {
    const f = file('movies', 'Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const n = searches();
    await identify(f);
    expect(searches()).toBe(n);
    expect(linksOf(f)).toHaveLength(1);
    expect(countItems()).toBe(1);
  });

  it('a manual link is never touched; the file is just identified', async () => {
    const f = file('movies', 'Dune (2021)/Dune (2021).mkv', { state: 'needs_review' });
    const itemId = catalog().upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: 'Q470283' }, fields: [{ source: 'manual', fetchedAt: T0, values: { title: 'Dune (1984)' } }] }).itemId;
    db.$client.prepare("INSERT INTO media_link (id, file_id, item_id, origin, confidence, created_at) VALUES ('l1', ?, ?, 'manual', NULL, 0)").run(f, itemId);
    await identify(f);
    expect(linksOf(f)).toEqual([{ item_id: itemId, origin: 'manual', confidence: null }]);
    expect(stateOf(f)).toBe('identified');
    expect(searches()).toBe(0);
  });

  it('owner decisions stay: ignored and resolved cases, disc structures', async () => {
    const ignored = file('movies', 'Dune (2021)/Dune (2021).mkv');
    const resolved = file('copy', 'Dune (2021)/Dune (2021).mkv');
    const disc = file('movies', 'Dune (2021)/BDMV/STREAM/00001.m2ts', { state: 'needs_review' });
    const ins = db.$client.prepare('INSERT INTO identification_case (id, file_id, state, reason, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)');
    ins.run('c1', ignored, 'ignored', 'low_score');
    ins.run('c2', resolved, 'resolved', null);
    ins.run('c3', disc, 'needs_review', 'disc_structure');
    for (const f of [ignored, resolved, disc]) await identify(f);
    expect([caseOf(ignored)?.state, caseOf(resolved)?.state, caseOf(disc)?.state]).toEqual(['ignored', 'resolved', 'needs_review']);
    expect([stateOf(ignored), stateOf(disc)]).toEqual(['ignored', 'needs_review']);
    expect(q('SELECT * FROM media_link')).toEqual([]);
    expect(searches()).toBe(0);
  });

  it('a copy of a linked file (same fingerprint) shares its links without a provider call', async () => {
    const a = file('series', 'Dark (2017)/Season 01/Dark (2017) - S01E02-E03.mkv', { fingerprint: 'fp1' });
    await identify(a);
    const n = searches();
    const b = file('copy', 'Backup/dark-s01e02e03.mkv', { fingerprint: 'fp1' });
    await identify(b);
    expect(searches()).toBe(n);
    expect(linksOf(b).map((l) => l.item_id)).toEqual(linksOf(a).map((l) => l.item_id));
    expect(caseOf(b)).toMatchObject({ state: 'auto_matched', parsed: { copyOf: a } });
    expect(stateOf(b)).toBe('identified');
  });

  it('versions share the item folder: a manual correction on one carries over to the next', async () => {
    const a = file('movies', 'Dune (2021)/Dune (2021) - 1080p.mkv');
    const itemId = catalog().upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: 'Q470283' }, fields: [{ source: 'manual', fetchedAt: T0, values: { title: 'Dune (1984)' } }] }).itemId;
    db.$client.prepare("INSERT INTO media_link (id, file_id, item_id, origin, confidence, created_at) VALUES ('l1', ?, ?, 'manual', NULL, 0)").run(a, itemId);
    const b = file('movies', 'Dune (2021)/Dune (2021) - 2160p.mkv', { durationMs: 8_000_000 });
    await identify(b);
    expect(linksOf(b)).toEqual([{ item_id: itemId, origin: 'auto', confidence: 1 }]);
    expect(caseOf(b)?.parsed).toMatchObject({ evidence: { resolver: 'sibling' } });
    expect(item(itemId)).toMatchObject({ title: 'Dune (1984)', duration_ms: 8_000_000 });
    expect(searches()).toBe(0);
  });

  it('a version of a known work adds ids and file values, and leaves the provider rows alone', async () => {
    const a = file('movies', 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv');
    await identify(a);
    const providerRows = () => q('SELECT field, value, fetched_at FROM item_field WHERE source = ? ORDER BY field', 'wikidata');
    const before = providerRows();
    expect(before.map((r) => (r as { field: string }).field)).toEqual(['originalTitle', 'title', 'year']);
    // Same work through another root, now found without an original title: nothing is deleted or re-stamped.
    metadata = wikidata({ 'blade runner 2049': [cand({ id: 'Q21451539', title: 'Blade Runner 2049', years: [2017], ids: { tvdb: '999' } }), blade82] });
    const b = file('copy', 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv', { durationMs: 9_000_000 });
    await identify(b);
    expect(linksOf(b)[0]?.item_id).toBe(linksOf(a)[0]?.item_id);
    expect(providerRows()).toEqual(before);
    expect(q("SELECT external_id FROM external_id WHERE provider = 'tvdb'")).toEqual([{ external_id: '999' }]);
    expect(item(linksOf(b)[0]!.item_id)?.duration_ms).toBe(9_000_000);
  });

  it('twins: an owner decision wins over an auto link, then the most recent link', async () => {
    const cat = catalog();
    const mk = (title: string, qid: string) => cat.upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: qid }, fields: [{ source: 'manual', fetchedAt: T0, values: { title } }] }).itemId;
    const autoItem = mk('Auto', 'Q1');
    const manualItem = mk('Manual', 'Q2');
    const a = file('movies', 'A (2000)/A (2000).mkv', { fingerprint: 'fp' });
    const b = file('copy', 'B (2000)/B (2000).mkv', { fingerprint: 'fp' });
    const link = db.$client.prepare('INSERT INTO media_link (id, file_id, item_id, origin, confidence, created_at) VALUES (?, ?, ?, ?, NULL, ?)');
    link.run('la', a, autoItem, 'auto', 500);
    link.run('lb', b, manualItem, 'manual', 100);
    const c = file('series', 'C/c.mkv', { fingerprint: 'fp' });
    await identify(c);
    expect(linksOf(c).map((l) => l.item_id)).toEqual([manualItem]);
  });
});

describe('changes while the providers answer', () => {
  let clock: number;
  const runJobs = async (fileId: string) => {
    enqueueJob(db, clock, { type: 'identifier.identify', payload: { fileId }, idempotencyKey: `identify:${fileId}` });
    const runner = createJobRunner({ db, log, now: () => clock, periodic: [], jobTypes: new Map([['identifier.identify', { handler: identifier().identify, concurrency: 1, maxAttempts: 30 }]]) });
    return runner;
  };
  const job = () => one<{ state: string; attempts: number }>('SELECT state, attempts FROM job');
  beforeEach(() => {
    clock = T0;
  });
  const during = (fn: () => void) => {
    let done = false;
    metadata = fakeMetadata({
      wikidata: {
        search: (req) => {
          if (!done) {
            done = true;
            fn();
          }
          return byTitle(WD)(req);
        },
      },
    });
  };

  it('a rename during the call: the library re-enqueue is a no-op, so the job runs again', async () => {
    const f = file('movies', 'Dune (2021)/Dune (2021).mkv');
    during(() => {
      db.$client.prepare("UPDATE media_file SET rel_path = 'Dune (2021)/Dune (2021) - 2160p.mkv' WHERE id = ?").run(f);
      expect(enqueueJob(db, clock, { type: 'identifier.identify', payload: { fileId: f }, idempotencyKey: `identify:${f}` })).toBeNull();
    });
    const runner = await runJobs(f);
    await runner.drain();
    expect(caseOf(f)).toBeUndefined();
    expect(job()).toEqual({ state: 'queued', attempts: 0 });
    clock += 1;
    await runner.drain();
    expect(linksOf(f)).toHaveLength(1);
    expect(caseOf(f)).toMatchObject({ state: 'auto_matched', parsed: { title: 'Dune' } });
    expect(job()?.state).toBe('done');
  });

  it('a new analysis or a disappearance during the call also runs the job again', async () => {
    const f = file('movies', 'Dune (2021)/Dune (2021).mkv');
    during(() => db.$client.prepare("UPDATE media_file SET state = 'missing' WHERE id = ?").run(f));
    await expect(identify(f)).rejects.toMatchObject({ name: 'RetryLaterError', retryAfterMs: 1 });
    await identify(f); // missing: nothing to do
    expect(caseOf(f)).toBeUndefined();
    const g = file('copy', 'Dune (2021)/Dune (2021).mkv');
    during(() => db.$client.prepare('UPDATE media_file SET analyzed_at = 42 WHERE id = ?').run(g));
    await expect(identify(g)).rejects.toMatchObject({ retryAfterMs: 1 });
    await identify(g);
    expect(caseOf(g)?.state).toBe('auto_matched');
  });

  it('a manual link or an Ignore during the call wins: the result is dropped, the job is done', async () => {
    const linked = file('movies', 'Dune (2021)/Dune (2021).mkv');
    const itemId = catalog().upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: 'Q470283' }, fields: [] }).itemId;
    during(() => db.$client.prepare("INSERT INTO media_link (id, file_id, item_id, origin, confidence, created_at) VALUES ('m1', ?, ?, 'manual', NULL, 0)").run(linked, itemId));
    const runner = await runJobs(linked);
    await runner.drain();
    expect(linksOf(linked)).toEqual([{ item_id: itemId, origin: 'manual', confidence: null }]);
    expect(caseOf(linked)).toBeUndefined();
    expect(job()?.state).toBe('done');

    const ignored = file('copy', 'Dune (2021)/Dune (2021).mkv');
    during(() => db.$client.prepare("INSERT INTO identification_case (id, file_id, state, created_at, updated_at) VALUES ('ci', ?, 'ignored', 0, 0)").run(ignored));
    await identify(ignored);
    expect(caseOf(ignored)?.state).toBe('ignored');
    expect(linksOf(ignored)).toEqual([]);
  });
});

describe('retries (provider down, rate limited, missing)', () => {
  it('unavailable providers: case pending, file still analyzed, RetryLaterError with the runner backoff', async () => {
    metadata = fakeMetadata({ wikidata: { search: () => ({ status: 'unavailable' }) }, tmdb: { search: () => ({ status: 'unavailable' }) } });
    const f = file('movies', 'Dune (2021)/Dune (2021).mkv');
    const err = await identify(f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryLaterError);
    expect((err as RetryLaterError).retryAfterMs).toBeNull();
    expect(caseOf(f)).toMatchObject({ state: 'pending', reason: null, candidates: [] });
    expect(stateOf(f)).toBe('analyzed');
    expect(events).toEqual([]);
  });

  it('Wikidata down and no TMDB match: retried, and accepted as a review only on the last attempt', async () => {
    const weak = cand({ provider: 'tmdb', id: '9', title: 'Dune: Part Two', years: [2024], votes: 5000 });
    metadata = fakeMetadata({ wikidata: { search: () => ({ status: 'unavailable' }) }, tmdb: { search: byTitle({ dune: [weak] }) } });
    const f = file('movies', 'Dune (2021)/Dune (2021).mkv');
    await expect(identify(f, IDENTIFY_MAX_ATTEMPTS - 1)).rejects.toMatchObject({ name: 'RetryLaterError', retryAfterMs: null });
    expect(caseOf(f)?.state).toBe('pending');
    await identify(f, IDENTIFY_MAX_ATTEMPTS);
    expect(caseOf(f)).toMatchObject({ state: 'needs_review', reason: 'low_score', candidates: [{ provider: 'tmdb', ref: { id: '9' } }] });
  });

  it('daily: pending cases whose job gave up are queued again; queued jobs and other cases are left alone', () => {
    const gaveUp = file('movies', 'Dune (2021)/Dune (2021).mkv');
    const waiting = file('copy', 'Dune (2021)/Dune (2021).mkv');
    const reviewed = file('movies', 'Up/Up.mkv');
    const ins = db.$client.prepare('INSERT INTO identification_case (id, file_id, state, reason, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)');
    ins.run('c1', gaveUp, 'pending', null);
    ins.run('c2', waiting, 'pending', null);
    ins.run('c3', reviewed, 'needs_review', 'ambiguous');
    for (const f of [gaveUp, waiting]) enqueueJob(db, T0, { type: 'identifier.identify', payload: { fileId: f }, idempotencyKey: `identify:${f}`, runAt: T0 + 3600_000 });
    db.$client.prepare("UPDATE job SET state = 'failed', attempts = 30 WHERE idempotency_key = ?").run(`identify:${gaveUp}`);
    const jobs = { enqueue: (j: Parameters<typeof enqueueJob>[2]) => enqueueJob(db, T0, j) };
    expect(requeuePending(db, jobs)).toBe(1);
    expect(q('SELECT idempotency_key AS key, state, attempts, run_at FROM job ORDER BY key')).toEqual([
      { key: `identify:${gaveUp}`, state: 'queued', attempts: 0, run_at: T0 },
      { key: `identify:${waiting}`, state: 'queued', attempts: 0, run_at: T0 + 3600_000 },
    ]);
    expect(requeuePending(db, jobs)).toBe(0);
  });

  it('rate limited: the provider delay travels with the error', async () => {
    metadata = fakeMetadata({ wikidata: { search: () => ({ status: 'rate_limited', retryAfterMs: 30_000 }) } });
    const f = file('movies', 'Dune (2021)/Dune (2021).mkv');
    await expect(identify(f)).rejects.toMatchObject({ name: 'RetryLaterError', retryAfterMs: 30_000 });
  });

  it('no metadata port (or no provider configured): long backoff, then identified once it exists', async () => {
    metadata = null;
    const f = file('movies', 'Dune (2021)/Dune (2021).mkv');
    await expect(identify(f)).rejects.toMatchObject({ retryAfterMs: NO_PROVIDER_RETRY_MS });
    metadata = fakeMetadata({});
    await expect(identify(f)).rejects.toMatchObject({ retryAfterMs: NO_PROVIDER_RETRY_MS });
    expect(caseOf(f)?.state).toBe('pending');
    metadata = wikidata();
    await identify(f);
    expect(caseOf(f)?.state).toBe('auto_matched');
  });

  it('the job runner reschedules a failed identification through job.run_at', async () => {
    metadata = fakeMetadata({ wikidata: { search: () => ({ status: 'unavailable' }) } });
    const f = file('movies', 'Dune (2021)/Dune (2021).mkv');
    enqueueJob(db, T0, { type: 'identifier.identify', payload: { fileId: f }, idempotencyKey: `identify:${f}` });
    const id = identifier();
    const runner = createJobRunner({ db, log, now: () => T0, periodic: [], jobTypes: new Map([['identifier.identify', { handler: id.identify, concurrency: 1, maxAttempts: 30 }]]) });
    await runner.drain();
    expect(one('SELECT state, attempts, run_at > ? AS later FROM job', T0)).toEqual({ state: 'queued', attempts: 1, later: 1 });
  });
});
