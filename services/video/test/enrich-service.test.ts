// Enricher end to end on the DB (ADR 0007): the catalog enqueues metadata.enrich, values are written
// per source and resolved by the catalog, locks hold, offline-first, series episodes, artwork,
// the refresh sweep, expiry and purge (values, credits, artwork files, cache rows, case candidates).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JOB_TYPES } from '../src/shared/job-types.ts';
import type { CatalogWritePort, WorkInput } from '../src/shared/ports.ts';
import { DAY, type Setup, setup } from './helpers/enrich-setup.ts';
import { MOVIE, MOVIE_NO_IT, SHOW } from './helpers/tmdb-synthetic.ts';

let s: Setup | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

const cat = (x: Setup): CatalogWritePort => x.comp.ports.catalogWrite;
const all = <T>(x: Setup, sql: string, ...a: unknown[]) => x.db.$client.prepare(sql).all(...a) as T[];
const one = <T>(x: Setup, sql: string, ...a: unknown[]) => x.db.$client.prepare(sql).get(...a) as T;
const item = (x: Setup, id: string) => one<{ title: string; original_title: string | null; year: number | null; category: string | null }>(x, 'SELECT title, original_title, year, category FROM catalog_item WHERE id = ?', id);
const fields = (x: Setup, id: string) =>
  Object.fromEntries(all<{ field: string; source: string; value: string }>(x, 'SELECT field, source, value FROM item_field WHERE item_id = ? ORDER BY field, source', id).map((r) => [`${r.field}:${r.source}`, JSON.parse(r.value) as unknown]));
const jobs = (x: Setup) => all<{ type: string; key: string; state: string }>(x, 'SELECT type, idempotency_key AS key, state FROM job ORDER BY type, key');

/** The work as the identifier writes it after a Wikidata match (filename values plus the candidate). */
const movieInput = (over: Partial<WorkInput> = {}, t = 0): WorkInput => ({
  kind: 'movie',
  editionLabel: null,
  externalIds: { wikidata: 'Q99000001', tmdb: String(MOVIE.id), imdb: 'tt9000001' },
  fields: [
    { source: 'wikidata', fetchedAt: t, values: { title: 'Il faro (Wikidata)', year: 2019 } },
    { source: 'filename', fetchedAt: t, values: { title: 'il faro di prova', year: 2019 } },
    { source: 'container', fetchedAt: t, values: { durationMs: 6_000_000 } },
  ],
  ...over,
});

async function enrichMovie(x: Setup, over: Partial<WorkInput> = {}): Promise<string> {
  const { itemId } = cat(x).upsertWork(movieInput(over, x.clock.now()));
  await x.runner.drain();
  return itemId;
}

describe('enqueueing from the catalog', () => {
  it('a new work and new ids enqueue metadata.enrich once per item; an unchanged upsert does not', async () => {
    s = await setup();
    const c = cat(s);
    const { itemId } = c.upsertWork(movieInput({ externalIds: { wikidata: 'Q99000001' } }));
    expect(jobs(s)).toEqual([{ type: JOB_TYPES.metadataEnrich, key: `enrich:${itemId}`, state: 'queued' }]);
    await s.runner.drain();
    expect(jobs(s).map((j) => [j.type, j.state])).toEqual([
      ['metadata.artwork', 'done'],
      ['metadata.enrich', 'done'],
    ]);
    c.upsertWork(movieInput({ externalIds: { wikidata: 'Q99000001' } }));
    expect(jobs(s).find((j) => j.type === 'metadata.enrich')?.state).toBe('done');
    // The enrichment itself added the TMDB and IMDb ids (from Wikidata): no new id, no new job.
    c.addExternalIds(itemId, { tmdb: String(MOVIE.id) });
    expect(jobs(s).find((j) => j.type === 'metadata.enrich')?.state).toBe('done');
  });

  it('a conflicting later id is kept out and reported, the first one stays', async () => {
    s = await setup({ tmdb: false });
    const { itemId } = cat(s).upsertWork(movieInput());
    cat(s).addExternalIds(itemId, { imdb: 'tt0000042' });
    expect(cat(s).getExternalIds(itemId).imdb).toBe('tt9000001');
  });
});

describe('a film', () => {
  it('Wikidata and TMDB values per source; the catalog shows TMDB Italian, Wikidata original title, container duration', async () => {
    s = await setup();
    const id = await enrichMovie(s);
    expect(item(s, id)).toEqual({ title: 'Il Faro di Prova', original_title: 'The Test Lighthouse', year: 2019, category: 'film' });
    expect(fields(s, id)).toMatchObject({
      'title:tmdb': 'Il Faro di Prova',
      'title:wikidata': 'Il faro (Wikidata)',
      'title:filename': 'il faro di prova',
      'originalTitle:wikidata': 'The Test Lighthouse',
      'overview:tmdb': MOVIE.overview,
      'tagline:tmdb': 'La luce mente.',
      'genres:tmdb': ['Dramma', 'Mistero'],
      'genres:wikidata': ['film drammatico'],
      'category:wikidata': 'film',
      'durationMs:container': 6_000_000,
    });
    expect(fields(s, id)['durationMs:tmdb']).toBeUndefined();
    const credits = all<{ name: string; role: string; character: string | null; source: string }>(
      s,
      'SELECT p.name, c.role, c.character, c.source FROM credit c JOIN person p ON p.id = c.person_id WHERE c.item_id = ? ORDER BY c.source, c.role, c.sort_order',
      id,
    );
    expect(credits).toEqual([
      { name: 'Aldo Primo', role: 'actor', character: 'Il guardiano', source: 'tmdb' },
      { name: 'Bruna Seconda', role: 'actor', character: 'Marta', source: 'tmdb' },
      { name: 'Regista Inventato', role: 'director', character: null, source: 'tmdb' },
      { name: 'Regista Inventato', role: 'director', character: null, source: 'wikidata' },
    ]);
  });

  it('artwork: poster and backdrop at once, the logo in the low-priority job; files under the content key', async () => {
    s = await setup();
    const id = await enrichMovie(s);
    const arts = cat(s).listArtwork(id).map((a) => [a.type, a.source, a.remoteRef, a.language]);
    expect(arts).toEqual([
      ['backdrop', 'tmdb', '/backdrop.jpg', null],
      ['backdrop', 'wikidata', 'Faro di prova.jpg', null],
      ['logo', 'tmdb', '/logoEN.png', 'en'],
      ['poster', 'tmdb', '/posterIT.jpg', 'it'],
    ]);
    const poster = cat(s).listArtwork(id).find((a) => a.type === 'poster');
    expect(poster?.localPath).toMatch(/^[A-Za-z0-9_-]{2}\/[A-Za-z0-9_-]{32}\/w780\.jpg$/);
    expect(existsSync(join(s.config.artworkDir, poster?.localPath ?? 'x'))).toBe(true);
    expect(existsSync(join(s.config.artworkDir, (poster?.localPath ?? 'x').replace('w780', 'w342')))).toBe(true);
    expect(poster).toMatchObject({ width: 780, height: 1170 });
    // A second run within the refresh window downloads nothing again.
    const n = s.fetch.calls.filter((c) => c.url.includes('image.tmdb.org')).length;
    s.db.$client.prepare("UPDATE job SET state = 'done'").run();
    cat(s).addExternalIds(id, { tvdb: '1' }); // new id → enrich again
    await s.runner.drain();
    expect(s.fetch.calls.filter((c) => c.url.includes('image.tmdb.org')).length).toBe(n);
  });

  it('without an Italian translation TMDB writes no title: the Wikidata label shows; the overview falls back to English', async () => {
    s = await setup();
    const id = await enrichMovie(s, { externalIds: { wikidata: 'Q99000002' }, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'untranslated' } }] });
    expect(item(s, id).title).toBe('Cosa non tradotta');
    expect(fields(s, id)).toMatchObject({ 'overview:tmdb': 'English only overview.' });
    expect(fields(s, id)['title:tmdb']).toBeUndefined();
    // The IMDb id only TMDB knows is not stored (ADR 0007 point 3); the TMDB id is.
    expect(cat(s).getExternalIds(id)).toEqual({ wikidata: 'Q99000002', tmdb: String(MOVIE_NO_IT.id) });
  });

  it('a manual value wins; a lock on TMDB keeps the old value when TMDB changes it', async () => {
    s = await setup();
    const id = await enrichMovie(s);
    cat(s).writeFields(id, [{ source: 'manual', fetchedAt: s.clock.now(), values: { title: 'Il mio faro' } }]);
    s.db.$client.prepare("INSERT INTO field_lock (item_id, field, source, locked_at) VALUES (?, 'overview', 'tmdb', 0)").run(id);
    MOVIE.overview = 'Trama cambiata su TMDB.';
    try {
      s.clock.advance(2 * DAY); // past the 24 h cache
      s.db.$client.prepare("UPDATE job SET state = 'done'").run();
      cat(s).addExternalIds(id, { tvdb: '2' });
      await s.runner.drain();
    } finally {
      MOVIE.overview = 'Un guardiano del faro scopre una luce che non dovrebbe esserci.';
    }
    expect(s.fetch.calls.filter((c) => c.url.includes(`/3/movie/${MOVIE.id}?`))).toHaveLength(2); // TMDB was asked again
    expect(item(s, id).title).toBe('Il mio faro');
    expect(fields(s, id)['overview:tmdb']).toBe('Un guardiano del faro scopre una luce che non dovrebbe esserci.');
    expect(fields(s, id)['tagline:tmdb']).toBe('La luce mente.'); // unlocked values were refreshed (same here)
  });

  it('TMDB not configured: Wikidata only, never a TMDB call', async () => {
    s = await setup({ tmdb: false });
    const id = await enrichMovie(s);
    expect(item(s, id).title).toBe('Il faro (Wikidata)');
    expect(s.fetch.calls.some((c) => c.url.includes('themoviedb') || c.url.includes('image.tmdb.org'))).toBe(false);
    expect(cat(s).listArtwork(id).map((a) => a.source)).toEqual(['wikidata']);
  });

  it('an extra keeps its file values and is never enriched', async () => {
    s = await setup();
    const film = await enrichMovie(s);
    const extra = cat(s).createExtra({ parentId: film, extraType: 'trailer', title: 'Trailer', numberIfTaken: true, fetchedAt: 0 });
    s.comp.ports.jobs.enqueue({ type: JOB_TYPES.metadataEnrich, payload: { itemId: extra.itemId }, idempotencyKey: `enrich:${extra.itemId}` });
    const before = s.fetch.calls.length;
    await s.runner.drain();
    expect(s.fetch.calls.length).toBe(before);
    expect(fields(s, extra.itemId)).toEqual({ 'title:filename': 'Trailer' });
  });
});

describe('offline-first', () => {
  it('providers unreachable: the item keeps its filename values and the job is retried, then completes', async () => {
    s = await setup();
    s.fetch.offline = true;
    const { itemId } = cat(s).upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: 'Q99000001' }, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'il faro di prova', year: 2019 } }] });
    await s.runner.drain();
    expect(item(s, itemId).title).toBe('il faro di prova');
    const job = one<{ state: string; attempts: number; run_at: number; last_error: string }>(s, "SELECT state, attempts, run_at, last_error FROM job WHERE type = 'metadata.enrich'");
    expect(job).toMatchObject({ state: 'queued', attempts: 1 });
    expect(job.run_at).toBeGreaterThan(s.clock.now());
    expect(job.last_error).toContain('wikidata details');
    s.fetch.offline = false;
    s.clock.set(job.run_at);
    await s.runner.drain();
    expect(item(s, itemId).title).toBe('Il Faro di Prova');
    expect(one<{ state: string }>(s, "SELECT state FROM job WHERE type = 'metadata.enrich'").state).toBe('done');
  });

  it('a rate limit defers the job by its Retry-After without spending an attempt', async () => {
    s = await setup();
    s.fetch.routes.unshift({ match: (u) => u.host === 'api.themoviedb.org' && u.pathname.startsWith('/3/movie/'), reply: () => ({ status: 429, headers: { 'Retry-After': '120' } }) });
    const id = await enrichMovie(s);
    const job = one<{ state: string; attempts: number; run_at: number }>(s, "SELECT state, attempts, run_at FROM job WHERE type = 'metadata.enrich'");
    expect(job).toMatchObject({ state: 'queued', attempts: 0 });
    expect(job.run_at - s.clock.now()).toBe(120_000);
    // What did arrive is written: the Wikidata values.
    expect(item(s, id).title).toBe('Il faro (Wikidata)');
  });
});

describe('a series', () => {
  it('seasons and episodes from both providers; stills and season posters in the artwork job', async () => {
    s = await setup();
    const c = cat(s);
    const { itemId: series } = c.upsertWork({ kind: 'series', editionLabel: null, externalIds: { wikidata: 'Q98000001' }, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'serie di prova' } }] });
    const season = c.ensureSeason(series, 1).itemId;
    const eps = [1, 2, 3].map((n) => c.ensureEpisode(season, n).itemId);
    s.clock.advance(2 * 60_000); // past the batching delay of new episodes
    await s.runner.drain();
    expect(item(s, series)).toMatchObject({ title: 'Serie di Prova', original_title: 'Testserie', year: 2017 });
    expect(item(s, season).title).toBe('Stagione 1');
    expect(eps.map((e) => item(s as Setup, e).title)).toEqual(['Segreti di prova', 'Lies', 'Terzo']);
    expect(fields(s, eps[1] ?? '')).toMatchObject({ 'overview:tmdb': 'EN overview 2', 'title:wikidata': 'Lies' });
    expect(fields(s, eps[1] ?? '')['title:tmdb']).toBeUndefined(); // "Episodio 2" is a placeholder
    expect(c.listArtwork(season).map((a) => [a.type, a.source])).toEqual([['poster', 'tmdb']]);
    expect(eps.map((e) => c.listArtwork(e).map((a) => a.type))).toEqual([['still'], ['still'], []]);
    expect(cat(s).getExternalIds(series)).toEqual({ wikidata: 'Q98000001', tmdb: String(SHOW.id) });
  });
});

describe('refresh sweep, expiry and purge', () => {
  const sweep = (x: Setup) => x.comp.periodic.find((p) => p.name === 'metadata.refresh_sweep')?.run();

  it('sweep: never-enriched works are queued; fresh ones are not; TMDB values past the refresh window are', async () => {
    s = await setup();
    const id = await enrichMovie(s);
    s.db.$client.prepare("DELETE FROM job WHERE type = 'metadata.enrich'").run();
    await sweep(s);
    expect(jobs(s).find((j) => j.type === 'metadata.enrich')?.state).toBe('queued');
    await s.runner.drain();
    await sweep(s);
    expect(jobs(s).find((j) => j.type === 'metadata.enrich')?.state).toBe('done');
    s.clock.advance(101 * DAY); // TMDB_REFRESH_AFTER_DAYS 90 + at most 10 of jitter
    await sweep(s);
    expect(jobs(s).find((j) => j.type === 'metadata.enrich')).toMatchObject({ key: `enrich:${id}`, state: 'queued' });
    await s.runner.drain();
    const tmdbAt = one<{ t: number }>(s, "SELECT min(fetched_at) AS t FROM item_field WHERE item_id = ? AND source = 'tmdb'", id).t;
    expect(s.clock.now() - tmdbAt).toBeLessThan(DAY);
  });

  it('expiry: past TMDB_MAX_AGE_DAYS without a refresh every TMDB trace goes, Wikidata stays', async () => {
    s = await setup();
    const id = await enrichMovie(s);
    const caseFile = insertCase(s, s.clock.now());
    const tmdbFiles = cat(s).listArtwork(id).filter((a) => a.source === 'tmdb').map((a) => join(s?.config.artworkDir ?? '', a.localPath));
    expect(tmdbFiles.every((f) => existsSync(f))).toBe(true);
    s.fetch.offline = true; // TMDB unreachable for six months
    s.clock.advance(181 * DAY);
    s.comp.ports.jobs.enqueue({ type: 'metadata.expire', payload: {}, idempotencyKey: 'expire:tmdb' });
    await s.runner.drain();
    expect(item(s, id).title).toBe('Il faro (Wikidata)');
    expect(Object.keys(fields(s, id)).filter((k) => k.endsWith(':tmdb'))).toEqual([]);
    expect(all(s, "SELECT * FROM credit WHERE source = 'tmdb'")).toEqual([]);
    expect(all(s, "SELECT * FROM person WHERE source = 'tmdb'")).toEqual([]);
    expect(cat(s).listArtwork(id).map((a) => a.source)).toEqual(['wikidata']);
    expect(tmdbFiles.some((f) => existsSync(f))).toBe(false);
    expect(all(s, "SELECT * FROM provider_cache WHERE provider = 'tmdb'")).toEqual([]);
    expect(caseCandidates(s, caseFile)).toEqual(['wikidata']);
    expect(cat(s).getExternalIds(id).tmdb).toBe(String(MOVIE.id)); // ids are kept (point 3)
  });

  it('purge: every TMDB value, credit, file, cache row and case candidate goes at once, even if locked; idempotent', async () => {
    s = await setup();
    const x = s;
    const id = await enrichMovie(x);
    const caseFile = insertCase(x, x.clock.now());
    x.db.$client.prepare("INSERT INTO field_lock (item_id, field, source, locked_at) VALUES (?, 'title', 'tmdb', 0)").run(id);
    const files = cat(x).listArtwork(id).filter((a) => a.source === 'tmdb').map((a) => join(x.config.artworkDir, a.localPath));
    const purge = async () => {
      x.comp.ports.jobs.enqueue({ type: 'metadata.purge', payload: {}, idempotencyKey: 'purge:tmdb' });
      await x.runner.drain();
    };
    await purge();
    expect(Object.keys(fields(x, id)).filter((k) => k.endsWith(':tmdb'))).toEqual([]);
    expect(item(x, id).title).toBe('Il faro (Wikidata)'); // the lock has no TMDB value left: it falls back
    expect(files.some((f) => existsSync(f))).toBe(false);
    expect(all(x, "SELECT * FROM provider_cache WHERE provider = 'tmdb'")).toEqual([]);
    expect(all(x, "SELECT * FROM artwork WHERE source = 'tmdb'")).toEqual([]);
    expect(all(x, "SELECT * FROM credit WHERE source = 'tmdb'")).toEqual([]);
    expect(caseCandidates(x, caseFile)).toEqual(['wikidata']);
    expect(cat(x).listArtwork(id).map((a) => a.source)).toEqual(['wikidata']);
    await purge();
    expect(one<{ state: string }>(x, "SELECT state FROM job WHERE type = 'metadata.purge'").state).toBe('done');
  });

  it('with TMDB_PURGE the provider is not configured and the purge job is queued at start', async () => {
    s = await setup({ purge: true });
    expect(s.comp.ports.metadataSearch.status().map((p) => [p.provider, p.state])).toEqual([
      ['wikidata', 'ok'],
      ['tmdb', 'not_configured'],
    ]);
    expect(jobs(s)).toEqual([{ type: 'metadata.purge', key: 'purge:tmdb', state: 'queued' }]);
    await s.runner.drain();
    expect(s.fetch.calls.some((c) => c.url.includes('themoviedb'))).toBe(false);
  });
});

/** A media file with a review case holding one TMDB and one Wikidata candidate; returns the file id. */
function insertCase(x: Setup, t: number): string {
  x.db.$client.prepare("INSERT INTO library_root (id, name, mount_path, hint, created_at) VALUES ('r1', 'Film', '/media/Film', 'movies', 0)").run();
  x.db.$client.prepare("INSERT INTO media_file (id, root_id, rel_path, size_bytes, mtime_ms, state, created_at, updated_at) VALUES ('f1', 'r1', 'X (2019)/X.mkv', 1, 0, 'needs_review', 0, 0)").run();
  const candidates = [
    { ref: { provider: 'tmdb', id: '900001', kind: 'movie' }, provider: 'tmdb', title: 'Il Faro di Prova', voteCount: 4321 },
    { ref: { provider: 'wikidata', id: 'Q99000001', kind: 'movie' }, provider: 'wikidata', title: 'Il faro (Wikidata)', voteCount: null },
  ];
  x.db.$client
    .prepare("INSERT INTO identification_case (id, file_id, state, reason, candidates, created_at, updated_at) VALUES ('c1', 'f1', 'needs_review', 'ambiguous', ?, ?, ?)")
    .run(JSON.stringify(candidates), t, t);
  return 'f1';
}

const caseCandidates = (x: Setup, fileId: string) =>
  (JSON.parse(one<{ candidates: string }>(x, 'SELECT candidates FROM identification_case WHERE file_id = ?', fileId).candidates) as { provider: string }[]).map((c) => c.provider);
