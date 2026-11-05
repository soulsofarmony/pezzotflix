// Admin API through the real app (compose + Fastify, in-memory DB): roots and the hold of the
// unmounted-root guard, scans, ingest status, RetryJob, the "Da verificare" queue and its
// resolutions (one transaction, sibling re-identification), SearchProvider, file details.
/* eslint-disable @typescript-eslint/no-unsafe-call -- response bodies are untyped JSON, checked against the contract by the harness */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedResolutions, searchScore, storedCandidates, toContractCandidate } from '../src/modules/admin/cases.ts';
import { enqueueJob } from '../src/modules/jobs/index.ts';
import type { MetadataSearchPort } from '../src/shared/ports.ts';
import { harness, type Harness } from './helpers/app-harness.ts';
import { seedCase, seedFile, seedLink, seedRoot, storedCandidate } from './helpers/catalog-seed.ts';
import { byExternalId, cand, fakeMetadata } from './helpers/fake-metadata.ts';

let h: Harness;
const all = <T>(sql: string, ...a: unknown[]) => h.db.$client.prepare(sql).all(...a) as T[];
const one = <T>(sql: string, ...a: unknown[]) => h.db.$client.prepare(sql).get(...a) as T;
const count = (table: string) => one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).n;
const linksOf = (fileId: string) => all<{ item_id: string; origin: string }>('SELECT item_id, origin FROM media_link WHERE file_id = ? ORDER BY item_id', fileId);
const fileState = (fileId: string) => one<{ state: string }>('SELECT state FROM media_file WHERE id = ?', fileId).state;
const caseState = (caseId: string) => one<{ state: string }>('SELECT state FROM identification_case WHERE id = ?', caseId).state;
const item = (id: string) => one<{ kind: string; title: string; parent_id: string | null; season_number: number | null; episode_number: number | null; extra_type: string | null }>('SELECT kind, title, parent_id, season_number, episode_number, extra_type FROM catalog_item WHERE id = ?', id);
const queuedIdentify = () => all<{ idempotency_key: string }>("SELECT idempotency_key FROM job WHERE type = 'identifier.identify' AND state = 'queued' ORDER BY idempotency_key").map((j) => j.idempotency_key);

const BR = storedCandidate({ id: 'Q21451539', title: 'Blade Runner 2049', year: 2017, score: 0.78, ids: { imdb: 'tt1856101' } });
const BR_TMDB = storedCandidate({ provider: 'tmdb', id: '335984', title: 'Blade Runner 2049', year: 2017, score: 0.75 });
const DARK = storedCandidate({ id: 'Q24300155', kind: 'series', title: 'Dark', year: 2017, score: 0.7 });

const movieParsed = (folder: string, title: string, year: number | null = null) => ({ kind: 'movie', title, year, edition: null, workFolder: folder, workKind: 'movie', warnings: [] });

describe('pure rules', () => {
  it.each([
    ['disc_structure', ['ignore']],
    ['multi_part', ['ignore']],
    ['no_title', ['link_candidate', 'link_item', 'create_manual', 'ignore']],
    ['no_candidates', ['link_candidate', 'link_item', 'create_manual', 'ignore']],
    ['low_score', ['link_candidate', 'link_item', 'create_manual', 'ignore']],
    ['ambiguous', ['link_candidate', 'link_item', 'create_manual', 'ignore']],
    ['kind_mismatch', ['link_candidate', 'link_item', 'create_manual', 'ignore']],
    ['id_mismatch', ['link_candidate', 'link_item', 'create_manual', 'ignore']],
    [null, ['link_candidate', 'link_item', 'create_manual', 'ignore']],
  ] as const)('%s → %j', (reason, expected) => expect(allowedResolutions(reason)).toEqual(expected));

  it('maps stored candidates to the contract, provider data in evidence', () => {
    expect(toContractCandidate(storedCandidates([BR_TMDB])[0]!)).toEqual({
      ref: { provider: 'tmdb', id: '335984' },
      kind: 'movie',
      title: 'Blade Runner 2049',
      originalTitle: 'Blade Runner 2049',
      year: 2017,
      score: 0.75,
      evidence: { title: 0.7, year: 1, kind: 1, externalIds: { tmdb: '335984' }, voteCount: 12 },
    });
    expect(storedCandidates([{ nonsense: true }, BR, 'x'])).toHaveLength(1);
    expect(storedCandidates(null)).toEqual([]);
  });

  it.each([
    ['dune', ['Dune'], [2021], null, 1],
    ['dune', ['Dune'], [2021], 2021, 1],
    ['dune', ['Dune'], [2020], 2021, 0.9],
    ['dune', ['Dune'], [1984], 2021, 0.8],
    ['città incantata', ['La città incantata'], [], null, 0.8],
    ['blade runner', ['Matrix'], [], null, 0],
  ])('searchScore(%j, %j, %j, %j) = %j', (q, t, years, year, score) => expect(searchScore(q, t, years, year)).toBe(score));
});

describe('admin API', () => {
  let metadata: ReturnType<typeof fakeMetadata>;
  let film: string;
  let serie: string;

  const setup = async (port: MetadataSearchPort | null = null) => {
    if (h) await h.close();
    const roots = [
      { name: 'Film', path: '/media/Film' },
      { name: 'Serie', path: '/media/Serie', hint: 'series' as const },
    ];
    h = await harness(port ? { metadata: port, roots } : { roots });
    film = seedRoot(h.db, 'Film');
    serie = seedRoot(h.db, 'Serie', { hint: 'series' });
  };

  beforeEach(async () => {
    metadata = fakeMetadata({
      wikidata: {
        search: (req) => ({
          status: 'ok',
          value: req.query.toLowerCase().includes('blade')
            ? [cand({ id: 'Q21451539', title: 'Blade Runner 2049', years: [2017], ids: { tmdb: '335984' } }), cand({ id: 'Q184843', title: 'Blade Runner', years: [1982] })]
            : [],
        }),
        lookup: byExternalId([cand({ id: 'Q1', title: 'Looked Up', original: ['Looked Up Orig'], years: [2001] }), cand({ id: 'Q2', kind: 'series', title: 'Serie Cercata', years: [2010] })]),
      },
      tmdb: {
        search: () => ({ status: 'ok', value: [cand({ provider: 'tmdb', id: '335984', title: 'Blade Runner 2049', years: [2017], votes: 9000 }), cand({ provider: 'tmdb', id: '78', title: 'Blade Runner', years: [1982] })] }),
        lookup: () => ({ status: 'unavailable', detail: 'down' }),
      },
    });
    await setup(metadata);
  });
  afterEach(async () => {
    await h.close();
    h = undefined as unknown as Harness;
  });

  describe('roots, scans, jobs', () => {
    it('lists roots with file counts and the hold of the guard', async () => {
      seedFile(h.db, film, 'a.mkv', null);
      seedFile(h.db, film, 'b.mkv', null, { state: 'missing' });
      h.db.$client.prepare("UPDATE library_root SET status = 'offline', hold_reason = 'mass_missing', held_missing = 30 WHERE id = ?").run(serie);
      const { status, body } = await h.call('listLibraryRoots', 'GET', '/video/api/v1/admin/roots');
      expect(status).toBe(200);
      expect(body.roots).toEqual([
        { id: film, name: 'Film', mountPath: '/media/Film', hint: 'movies', status: 'online', lastScanAt: null, fileCount: 1, held: null },
        { id: serie, name: 'Serie', mountPath: '/media/Serie', hint: 'series', status: 'offline', lastScanAt: null, fileCount: 0, held: { reason: 'mass_missing', missingFiles: 30, confirmed: false } },
      ]);
    });

    it('queues scans like the library does: one queued, one follow-up', async () => {
      const a = await h.call('triggerScan', 'POST', '/video/api/v1/admin/scan', { rootId: film });
      expect(a.status).toBe(202);
      expect(a.body.accepted).toBe(true);
      expect(a.body.jobId).toBeTruthy();
      h.db.$client.prepare("UPDATE job SET state = 'running' WHERE id = ?").run(a.body.jobId);
      const b = await h.call('triggerScan', 'POST', '/video/api/v1/admin/scan', { rootId: film });
      expect(b.body.jobId).not.toBe(a.body.jobId);
      const c = await h.call('triggerScan', 'POST', '/video/api/v1/admin/scan', { rootId: film });
      expect(c.body).toEqual({ accepted: true, jobId: null });
      expect(all('SELECT idempotency_key FROM job ORDER BY idempotency_key')).toEqual([{ idempotency_key: `library.scan:${film}` }, { idempotency_key: `library.scan:${film}:next` }]);
      expect((await h.call('triggerScan', 'POST', '/video/api/v1/admin/scan', {})).body.jobId).toBeTruthy();
      expect((await h.call('triggerScan', 'POST', '/video/api/v1/admin/scan')).status).toBe(202);
      const missing = await h.call('triggerScan', 'POST', '/video/api/v1/admin/scan', { rootId: 'nope' });
      expect(missing.status).toBe(404);
    });

    it('confirms the contents of a held root only', async () => {
      expect((await h.call('confirmRootContents', 'POST', `/video/api/v1/admin/roots/${film}/confirm-contents`)).status).toBe(409);
      expect((await h.call('confirmRootContents', 'POST', '/video/api/v1/admin/roots/nope/confirm-contents')).status).toBe(404);
      h.db.$client.prepare("UPDATE library_root SET status = 'offline', hold_reason = 'mass_missing', held_missing = 30 WHERE id = ?").run(film);
      const r = await h.call('confirmRootContents', 'POST', `/video/api/v1/admin/roots/${film}/confirm-contents`);
      expect(r.status).toBe(202);
      expect(r.body.jobId).toBeTruthy();
      expect(one('SELECT confirmed_missing AS c FROM library_root WHERE id = ?', film)).toEqual({ c: 30 });
      expect(one<{ payload: string }>('SELECT payload FROM job WHERE id = ?', r.body.jobId).payload).toBe(JSON.stringify({ rootId: film }));
      const roots = (await h.call('listLibraryRoots', 'GET', '/video/api/v1/admin/roots')).body.roots;
      expect(roots[0].held).toEqual({ reason: 'mass_missing', missingFiles: 30, confirmed: true });
    });

    it('refuses to confirm a root that is no longer configured: no scan would consume it', async () => {
      const old = seedRoot(h.db, 'Vecchio', { status: 'offline' });
      h.db.$client.prepare("UPDATE library_root SET hold_reason = 'empty_walk', held_missing = 4 WHERE id = ?").run(old);
      const r = await h.call('confirmRootContents', 'POST', `/video/api/v1/admin/roots/${old}/confirm-contents`);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('CONFLICT');
      expect(one('SELECT confirmed_missing AS c, confirmed_at AS t FROM library_root WHERE id = ?', old)).toEqual({ c: null, t: null });
      expect(count('job')).toBe(0);
    });

    it('reports ingest status: jobs per type and state, failures, files per state', async () => {
      const t = h.clock.now;
      const ids = ['a', 'b', 'c', 'd'].map((k) => enqueueJob(h.db, t, { type: 'analyzer.probe', payload: { k }, idempotencyKey: k })!);
      enqueueJob(h.db, t, { type: 'library.scan', payload: {} });
      h.db.$client.prepare("UPDATE job SET state = 'running' WHERE id = ?").run(ids[0]);
      h.db.$client.prepare("UPDATE job SET state = 'done' WHERE id = ?").run(ids[1]);
      h.db.$client.prepare("UPDATE job SET state = 'failed', attempts = 5, last_error = 'ffprobe exited 1', updated_at = ? WHERE id = ?").run(t + 5, ids[2]);
      seedFile(h.db, film, 'a.mkv', null, { state: 'analyzed' });
      seedFile(h.db, film, 'b.mkv', null, { state: 'needs_review' });
      seedFile(h.db, film, 'c.mkv', null, { state: 'needs_review' });
      const { body } = await h.call('getIngestStatus', 'GET', '/video/api/v1/admin/ingest');
      expect(body).toEqual({
        running: true,
        queued: 2,
        failed: [{ jobId: ids[2], type: 'analyzer.probe', error: 'ffprobe exited 1', attempts: 5 }],
        files: { analyzed: 1, needs_review: 2 },
        jobs: { 'analyzer.probe': { done: 1, failed: 1, queued: 1, running: 1 }, 'library.scan': { queued: 1 } },
      });
    });

    it('retries a failed job from attempt 0, leaves other jobs alone', async () => {
      const id = enqueueJob(h.db, 0, { type: 'analyzer.probe', payload: {} })!;
      h.db.$client.prepare("UPDATE job SET state = 'failed', attempts = 5, last_error = 'boom', run_at = 0 WHERE id = ?").run(id);
      const r = await h.call('retryJob', 'POST', `/video/api/v1/admin/jobs/${id}/retry`);
      expect(r).toEqual({ status: 202, body: { accepted: true, jobId: id } });
      expect(one('SELECT state, attempts, last_error, run_at FROM job WHERE id = ?', id)).toEqual({ state: 'queued', attempts: 0, last_error: null, run_at: h.clock.now });
      expect((await h.call('retryJob', 'POST', `/video/api/v1/admin/jobs/${id}/retry`)).body).toEqual({ accepted: false, jobId: id });
      expect((await h.call('retryJob', 'POST', '/video/api/v1/admin/jobs/nope/retry')).status).toBe(404);
    });
  });

  describe('the review queue', () => {
    it('lists cases by state, newest first, with a cursor and mapped candidates', async () => {
      const files = ['a', 'b', 'c'].map((n, i) => seedFile(h.db, film, `${n} (2017)/${n}.mkv`, 'br2049', { state: 'needs_review', now: i }));
      const cases = files.map((f, i) => seedCase(h.db, f, { reason: i === 0 ? 'ambiguous' : 'disc_structure', candidates: i === 0 ? [BR, BR_TMDB] : [], updatedAt: 100 + i }));
      seedCase(h.db, seedFile(h.db, film, 'd.mkv', 'br2049', { state: 'analyzed' }), { state: 'pending' });
      const p1 = (await h.call('listIdentificationCases', 'GET', '/video/api/v1/admin/cases?limit=2')).body;
      expect(p1.cases.map((c: { id: string }) => c.id)).toEqual([cases[2], cases[1]]);
      const p2 = (await h.call('listIdentificationCases', 'GET', `/video/api/v1/admin/cases?limit=2&cursor=${p1.nextCursor}`)).body;
      expect(p2.cases.map((c: { id: string }) => c.id)).toEqual([cases[0]]);
      expect(p2.nextCursor).toBeNull();
      expect(p2.cases[0]).toMatchObject({
        fileId: files[0],
        rootName: 'Film',
        relPath: 'a (2017)/a.mkv',
        state: 'needs_review',
        reason: 'ambiguous',
        allowedResolutions: ['link_candidate', 'link_item', 'create_manual', 'ignore'],
        linkedItem: null,
        updatedAt: 100,
      });
      expect(p2.cases[0].candidates.map((c: { ref: { provider: string } }) => c.ref.provider)).toEqual(['wikidata', 'tmdb']);
      expect(p1.cases[0].allowedResolutions).toEqual(['ignore']);
      expect((await h.call('listIdentificationCases', 'GET', '/video/api/v1/admin/cases?state=pending')).body.cases).toHaveLength(1);
      const other = await h.call('listIdentificationCases', 'GET', `/video/api/v1/admin/cases?state=pending&cursor=${p1.nextCursor}`);
      expect(other.status).toBe(400);
      const got = await h.call('getIdentificationCase', 'GET', `/video/api/v1/admin/cases/${cases[0]}`);
      expect(got.body.id).toBe(cases[0]);
      expect((await h.call('getIdentificationCase', 'GET', '/video/api/v1/admin/cases/nope')).status).toBe(404);
    });

    it('links a stored candidate: manual link, case resolved, file identified; siblings identified again', async () => {
      const folder = 'Blade Runner 2049 (2017)';
      const file = seedFile(h.db, film, `${folder}/Blade Runner 2049 (2017) - 2160p.mkv`, 'br2049', { state: 'needs_review' });
      const caseId = seedCase(h.db, file, { reason: 'ambiguous', parsed: movieParsed(folder, 'Blade Runner 2049', 2017), candidates: [BR, BR_TMDB], updatedAt: 50 });
      // Siblings: a version in review, an extra still pending, a disc rip, a linked file, and a file elsewhere.
      const version = seedFile(h.db, film, `${folder}/Blade Runner 2049 (2017) - 1080p.mkv`, 'ilbuono', { state: 'needs_review' });
      seedCase(h.db, version, { reason: 'ambiguous', parsed: movieParsed(folder, 'Blade Runner 2049', 2017) });
      const extra = seedFile(h.db, film, `${folder}/extras/Trailer.mkv`, 'ilbuono', { state: 'analyzed' });
      seedCase(h.db, extra, { state: 'pending' });
      const disc = seedFile(h.db, film, `${folder}/BDMV/index.bdmv`, null, { state: 'needs_review' });
      seedCase(h.db, disc, { reason: 'disc_structure' });
      seedFile(h.db, film, 'Elsewhere (2017)/x.mkv', 'ilbuono', { state: 'needs_review' });
      const events0 = count('domain_event');

      const { status, body } = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q21451539' } });
      expect(status).toBe(200);
      expect(body).toMatchObject({ id: caseId, state: 'resolved', linkedItem: { kind: 'movie', title: 'Blade Runner 2049', year: 2017, available: true } });
      const [link] = linksOf(file);
      expect(link?.origin).toBe('manual');
      expect(item(link!.item_id)).toMatchObject({ kind: 'movie', title: 'Blade Runner 2049', parent_id: null });
      expect(all('SELECT provider, external_id FROM external_id WHERE item_id = ? ORDER BY provider', link!.item_id)).toEqual([
        { provider: 'imdb', external_id: 'tt1856101' },
        { provider: 'wikidata', external_id: 'Q21451539' },
      ]);
      expect(one('SELECT duration_ms AS d FROM catalog_item WHERE id = ?', link!.item_id)).toEqual({ d: 30_005 });
      expect(caseState(caseId)).toBe('resolved');
      expect(fileState(file)).toBe('identified');
      expect(queuedIdentify()).toEqual([`identify:${extra}`, `identify:${version}`].sort());
      expect(count('domain_event')).toBeGreaterThan(events0);

      // A second version with the same candidate finds the work instead of creating another one.
      const again = seedFile(h.db, film, 'Other folder/BR.mkv', 'ilbuono', { state: 'needs_review' });
      const againCase = seedCase(h.db, again, { reason: 'low_score', parsed: movieParsed('Other folder', 'BR'), candidates: [BR] });
      await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${againCase}/resolve`, { action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q21451539' } });
      expect(linksOf(again).map((l) => l.item_id)).toEqual([link!.item_id]);
      expect(count("catalog_item WHERE kind = 'movie'")).toBe(1);
    });

    it('looks up a candidate that is not stored (found with SearchProvider)', async () => {
      const file = seedFile(h.db, film, 'X (2001)/x.mkv', 'ilbuono', { state: 'needs_review' });
      const caseId = seedCase(h.db, file, { reason: 'no_candidates', parsed: movieParsed('X (2001)', 'X', 2001) });
      const r = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q1' } });
      expect(r.status).toBe(200);
      expect(r.body.linkedItem).toMatchObject({ title: 'Looked Up', originalTitle: 'Looked Up Orig', year: 2001 });
      expect(metadata.calls.filter((c) => c.op === 'lookup').map((c) => c.arg)).toEqual([{ ns: 'wikidata', id: 'Q1', lang: 'it-IT' }]);

      const notFound = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q404' } });
      expect(notFound.status).toBe(404);
      const down = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_candidate', candidate: { provider: 'tmdb', id: '1' } });
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('PROVIDER_UNAVAILABLE');
    });

    it('answers 503, not a crash, when no metadata provider is registered', async () => {
      await setup(null);
      const file = seedFile(h.db, film, 'X/x.mkv', 'ilbuono', { state: 'needs_review' });
      const caseId = seedCase(h.db, file, { reason: 'no_candidates', parsed: movieParsed('X', 'X') });
      const r = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q1' } });
      expect(r.status).toBe(503);
      const s = await h.call('searchProvider', 'GET', '/video/api/v1/admin/provider-search?q=dune');
      expect(s.status).toBe(503);
      expect(s.body.code).toBe('PROVIDER_UNAVAILABLE');
      expect(caseState(caseId)).toBe('needs_review');
    });

    it('builds series, season and episodes for an episode file, also a double episode', async () => {
      const file = seedFile(h.db, serie, 'Dark (2017)/Season 01/Dark - S01E02-E03.mkv', 'dark', { state: 'needs_review' });
      const parsed = { kind: 'episode', title: 'Dark', year: 2017, season: 1, episodes: [2, 3], episodeTitle: null, workFolder: 'Dark (2017)', workKind: 'series' };
      const caseId = seedCase(h.db, file, { reason: 'low_score', parsed, candidates: [DARK] });
      const sibling = seedFile(h.db, serie, 'Dark (2017)/Season 01/Dark - S01E01.mkv', 'dark', { state: 'needs_review' });
      seedCase(h.db, sibling, { reason: 'low_score', parsed: { ...parsed, episodes: [1] } });
      await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q24300155' } });
      const eps = linksOf(file).map((l) => item(l.item_id));
      expect(eps.map((e) => [e.kind, e.season_number, e.episode_number]).sort()).toEqual([
        ['episode', 1, 2],
        ['episode', 1, 3],
      ]);
      const season = item(eps[0]!.parent_id!);
      expect(season).toMatchObject({ kind: 'season', season_number: 1 });
      expect(item(season.parent_id!)).toMatchObject({ kind: 'series', title: 'Dark' });
      expect(queuedIdentify()).toEqual([`identify:${sibling}`]);
    });

    it('creates an extra below the work of its folder', async () => {
      const file = seedFile(h.db, film, 'Blade Runner 2049 (2017)/extras/Trailer.mkv', 'ilbuono', { state: 'needs_review' });
      const parsed = { kind: 'extra', title: 'Blade Runner 2049', year: 2017, extraType: 'trailer', extraTitle: 'Trailer', extraTitleIsLabel: false, extraOf: { folder: 'Blade Runner 2049 (2017)', kind: 'movie', season: null } };
      const caseId = seedCase(h.db, file, { reason: 'ambiguous', parsed, candidates: [BR] });
      await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q21451539' } });
      const extra = item(linksOf(file)[0]!.item_id);
      expect(extra).toMatchObject({ kind: 'extra', extra_type: 'trailer', title: 'Trailer' });
      expect(item(extra.parent_id!)).toMatchObject({ kind: 'movie', title: 'Blade Runner 2049' });
    });

    it('links an existing item, deriving episodes below a series or a season', async () => {
      const w = h.comp.ports.catalogWrite;
      const series = w.upsertWork({ kind: 'series', editionLabel: null, externalIds: { wikidata: 'Q24300155' }, fields: [{ source: 'wikidata', fetchedAt: 0, values: { title: 'Dark' } }] }).itemId;
      const file = seedFile(h.db, serie, 'Dark/S02E05.mkv', 'dark', { state: 'needs_review' });
      const caseId = seedCase(h.db, file, { reason: 'no_title', parsed: { kind: 'episode', title: null, season: 2, episodes: [5], episodeTitle: 'Il viaggio' } });
      const r = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_item', itemId: series });
      expect(r.body.linkedItem).toMatchObject({ kind: 'episode', seasonNumber: 2, episodeNumber: 5, title: 'Il viaggio' });

      // An auto link is replaced by the owner's choice.
      const movie = w.upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: 'Q9' }, fields: [{ source: 'wikidata', fetchedAt: 0, values: { title: 'Wrong' } }] }).itemId;
      const right = w.upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: 'Q10' }, fields: [{ source: 'wikidata', fetchedAt: 0, values: { title: 'Right' } }] }).itemId;
      const auto = seedFile(h.db, film, 'm.mkv', 'ilbuono');
      seedLink(h.db, auto, movie, 'auto');
      const autoCase = seedCase(h.db, auto, { state: 'auto_matched', parsed: movieParsed('', 'Wrong') });
      await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${autoCase}/resolve`, { action: 'link_item', itemId: right });
      expect(linksOf(auto)).toEqual([{ item_id: right, origin: 'manual' }]);

      // A series without episode numbers in the name cannot take the file.
      const bare = seedFile(h.db, serie, 'Dark/bonus.mkv', 'dark', { state: 'needs_review' });
      const bareCase = seedCase(h.db, bare, { reason: 'no_title', parsed: { kind: 'movie', title: null } });
      const conflict = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${bareCase}/resolve`, { action: 'link_item', itemId: series });
      expect(conflict.status).toBe(409);
      expect((await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${bareCase}/resolve`, { action: 'link_item', itemId: 'nope' })).status).toBe(404);
      expect((await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${bareCase}/resolve`, { action: 'link_item' })).status).toBe(400);
    });

    it('creates manual items: movie, series with episodes, orphan extra; not a bare season', async () => {
      const m = seedFile(h.db, film, 'title_t00.mkv', 'ilbuono', { state: 'needs_review' });
      const mCase = seedCase(h.db, m, { reason: 'no_title', parsed: { kind: 'movie', title: null } });
      const r = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${mCase}/resolve`, { action: 'create_manual', manual: { kind: 'movie', title: 'Il mio film', year: 1999 } });
      expect(r.body.linkedItem).toMatchObject({ kind: 'movie', title: 'Il mio film', year: 1999, category: 'film' });
      expect(all('SELECT field, source FROM item_field WHERE item_id = ? ORDER BY field, source', r.body.linkedItem.id)).toEqual([
        { field: 'durationMs', source: 'container' },
        { field: 'title', source: 'manual' },
        { field: 'year', source: 'manual' },
      ]);

      const e = seedFile(h.db, serie, 'Show/S01E01.mkv', 'dark', { state: 'needs_review' });
      const eCase = seedCase(h.db, e, { reason: 'no_candidates', parsed: { kind: 'episode', title: 'Show', season: 1, episodes: [1] } });
      const s = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${eCase}/resolve`, { action: 'create_manual', manual: { kind: 'series', title: 'Il mio show' } });
      expect(s.body.linkedItem).toMatchObject({ kind: 'episode', episodeNumber: 1 });

      const x = seedFile(h.db, film, 'misc/clip.mkv', 'ilbuono', { state: 'needs_review' });
      const xCase = seedCase(h.db, x, { reason: 'no_title', parsed: { kind: 'extra', extraType: 'featurette' } });
      const ex = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${xCase}/resolve`, { action: 'create_manual', manual: { kind: 'extra', title: 'Dietro le quinte' } });
      expect(ex.body.linkedItem).toMatchObject({ kind: 'extra', title: 'Dietro le quinte', extraType: 'featurette' });

      const bad = seedFile(h.db, film, 'bad.mkv', 'ilbuono', { state: 'needs_review' });
      const badCase = seedCase(h.db, bad, { reason: 'no_title', parsed: { kind: 'movie' } });
      expect((await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${badCase}/resolve`, { action: 'create_manual', manual: { kind: 'season', title: 'S1' } })).status).toBe(400);
      expect((await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${badCase}/resolve`, { action: 'create_manual' })).status).toBe(400);
    });

    it('writes nothing when a resolution fails halfway (one transaction)', async () => {
      const file = seedFile(h.db, film, 'Movie (2000)/m.mkv', 'ilbuono', { state: 'needs_review' });
      const caseId = seedCase(h.db, file, { reason: 'low_score', parsed: movieParsed('Movie (2000)', 'Movie', 2000), candidates: [DARK] });
      const before = { items: count('catalog_item'), search: count('catalog_search'), ids: count('external_id'), jobs: count('job'), events: count('domain_event') };
      // The series is created, then the file (no episode number) cannot be placed below it: rollback.
      const r = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q24300155' } });
      expect(r.status).toBe(409);
      expect({ items: count('catalog_item'), search: count('catalog_search'), ids: count('external_id'), jobs: count('job'), events: count('domain_event') }).toEqual(before);
      expect(caseState(caseId)).toBe('needs_review');
      expect(fileState(file)).toBe('needs_review');
      expect(linksOf(file)).toEqual([]);
    });

    it('enforces allowedResolutions: disc_structure and multi_part are ignore only', async () => {
      const disc = seedFile(h.db, film, 'Disc/BDMV/index.bdmv', null, { state: 'needs_review' });
      const discCase = seedCase(h.db, disc, { reason: 'disc_structure', parsed: { kind: 'disc', disc: 'bdmv' } });
      for (const body of [{ action: 'create_manual', manual: { kind: 'movie', title: 'X' } }, { action: 'link_item', itemId: 'x' }, { action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q1' } }]) {
        const r = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${discCase}/resolve`, body);
        expect(r.status).toBe(409);
      }
      const part = seedFile(h.db, film, 'Film (1990)/Disco 1/film.mkv', 'ilbuono', { state: 'needs_review' });
      const partCase = seedCase(h.db, part, { reason: 'multi_part', parsed: { ...movieParsed('Film (1990)', 'Film', 1990), part: 1 }, candidates: [BR] });
      for (const body of [{ action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q21451539' } }, { action: 'create_manual', manual: { kind: 'movie', title: 'Film', year: 1990 } }]) {
        const r = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${partCase}/resolve`, body);
        expect(r.status).toBe(409);
      }
      expect([caseState(partCase), fileState(part), count('catalog_item')]).toEqual(['needs_review', 'needs_review', 0]);
      const ignored = await h.call('ignoreCase', 'POST', `/video/api/v1/admin/cases/${discCase}/ignore`);
      expect(ignored.body).toMatchObject({ state: 'ignored', allowedResolutions: ['ignore'] });
      expect(fileState(disc)).toBe('ignored');
    });

    it('ignores a case: the file leaves its items; a missing file stays missing', async () => {
      const w = h.comp.ports.catalogWrite;
      const movie = w.upsertWork({ kind: 'movie', editionLabel: null, externalIds: {}, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'Sample' } }] }).itemId;
      const file = seedFile(h.db, film, 'sample.mkv', 'ilbuono');
      seedLink(h.db, file, movie);
      const caseId = seedCase(h.db, file, { state: 'auto_matched' });
      const r = await h.call('ignoreCase', 'POST', `/video/api/v1/admin/cases/${caseId}/ignore`);
      expect(r.body).toMatchObject({ state: 'ignored', linkedItem: null });
      expect(fileState(file)).toBe('ignored');
      expect(linksOf(file)).toEqual([]);
      const gone = seedFile(h.db, film, 'gone.mkv', 'ilbuono', { state: 'missing' });
      const goneCase = seedCase(h.db, gone, { reason: 'low_score' });
      await h.call('ignoreCase', 'POST', `/video/api/v1/admin/cases/${goneCase}/ignore`);
      expect([caseState(goneCase), fileState(gone)]).toEqual(['ignored', 'missing']);
      expect((await h.call('ignoreCase', 'POST', '/video/api/v1/admin/cases/nope/ignore')).status).toBe(404);
    });

    it('ignores a resolved case: its manual link goes too', async () => {
      const w = h.comp.ports.catalogWrite;
      const movie = w.upsertWork({ kind: 'movie', editionLabel: null, externalIds: {}, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'Sample' } }] }).itemId;
      const file = seedFile(h.db, film, 'sample.mkv', 'ilbuono', { state: 'needs_review' });
      const caseId = seedCase(h.db, file, { reason: 'no_title', parsed: { kind: 'movie', title: null } });
      expect((await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_item', itemId: movie })).status).toBe(200);
      expect(linksOf(file)).toEqual([{ item_id: movie, origin: 'manual' }]);
      const events0 = count("domain_event WHERE payload LIKE '%media_unlinked%'");
      const r = await h.call('ignoreCase', 'POST', `/video/api/v1/admin/cases/${caseId}/ignore`);
      expect(r.body).toMatchObject({ state: 'ignored', linkedItem: null });
      expect(linksOf(file)).toEqual([]);
      expect(fileState(file)).toBe('ignored');
      expect(count("domain_event WHERE payload LIKE '%media_unlinked%'")).toBe(events0 + 1);
    });

    it('answers 409 when the case changed while the provider lookup ran (resolve racing ignore)', async () => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const inLookup = new Promise<void>((r) => (entered = r));
      const port = fakeMetadata({
        wikidata: {
          search: () => ({ status: 'ok', value: [] }),
          lookup: () => ({ status: 'ok', value: cand({ id: 'Q1', title: 'Looked Up', years: [2001] }) }),
        },
      });
      // The lookup waits until the case was ignored.
      const lookupByExternalId = port.lookupByExternalId.bind(port);
      port.lookupByExternalId = async (p, l) => {
        entered();
        await gate;
        return lookupByExternalId(p, l);
      };
      await setup(port);
      const file = seedFile(h.db, film, 'X (2001)/x.mkv', 'ilbuono', { state: 'needs_review' });
      const caseId = seedCase(h.db, file, { reason: 'no_candidates', parsed: movieParsed('X (2001)', 'X', 2001) });
      const resolving = h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q1' } });
      await inLookup;
      expect((await h.call('ignoreCase', 'POST', `/video/api/v1/admin/cases/${caseId}/ignore`)).status).toBe(200);
      release();
      const r = await resolving;
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('CONFLICT');
      expect([caseState(caseId), fileState(file), linksOf(file), count('catalog_item')]).toEqual(['ignored', 'ignored', [], 0]);
    });

    it('validates the request against the contract', async () => {
      const r = await h.call('resolveCase', 'POST', '/video/api/v1/admin/cases/x/resolve', { action: 'guess' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('provider search and file details', () => {
    it('searches every usable provider, best first, a TMDB hit Wikidata already has shown once', async () => {
      const { body } = await h.call('searchProvider', 'GET', '/video/api/v1/admin/provider-search?q=blade%20runner%202049&kind=movie&year=2017');
      expect(body.candidates.map((c: { ref: { provider: string; id: string } }) => `${c.ref.provider}:${c.ref.id}`)).toEqual(['wikidata:Q21451539', 'wikidata:Q184843', 'tmdb:78']);
      expect(body.candidates[0]).toMatchObject({ kind: 'movie', title: 'Blade Runner 2049', year: 2017, score: 1 });
      expect(metadata.calls.filter((c) => c.op === 'search').map((c) => [c.provider, c.arg])).toEqual([
        ['wikidata', { query: 'blade runner 2049', kind: 'movie', year: 2017, lang: 'it-IT' }],
        ['tmdb', { query: 'blade runner 2049', kind: 'movie', year: 2017, lang: 'it-IT' }],
      ]);
    });

    it('answers 503 when every provider fails, and uses only the ones that answer', async () => {
      await setup(
        fakeMetadata({
          wikidata: { search: () => ({ status: 'unavailable' }) },
          tmdb: { state: 'invalid_credentials', search: () => ({ status: 'ok', value: [cand({ provider: 'tmdb', id: '1', title: 'X' })] }) },
        }),
      );
      const r = await h.call('searchProvider', 'GET', '/video/api/v1/admin/provider-search?q=x');
      expect(r.status).toBe(503);
      await setup(fakeMetadata({ wikidata: { search: () => ({ status: 'unavailable' }) }, tmdb: { search: () => ({ status: 'ok', value: [cand({ provider: 'tmdb', id: '1', title: 'X' })] }) } }));
      expect((await h.call('searchProvider', 'GET', '/video/api/v1/admin/provider-search?q=x')).body.candidates).toHaveLength(1);
    });

    it('details a file: version with tracks, links, facts', async () => {
      const w = h.comp.ports.catalogWrite;
      const movie = w.upsertWork({ kind: 'movie', editionLabel: null, externalIds: {}, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'Blade Runner 2049' } }] }).itemId;
      const file = seedFile(h.db, film, 'BR/br.mkv', 'br2049');
      seedLink(h.db, file, movie);
      const { body } = await h.call('getMediaFileDetails', 'GET', `/video/api/v1/admin/files/${file}`);
      expect(body).toMatchObject({ id: file, rootName: 'Film', relPath: 'BR/br.mkv', state: 'identified', sizeBytes: 1_000_000 });
      expect(body.version.label).toBe('4K · HDR10 · TrueHD 5.1 · ITA/ENG');
      expect(body.version.tracks).toHaveLength(8);
      expect(body.links.map((l: { id: string }) => l.id)).toEqual([movie]);
      expect(body.facts.container).toBe('matroska');
      expect((await h.call('getMediaFileDetails', 'GET', '/video/api/v1/admin/files/nope')).status).toBe(404);
    });
  });
});
