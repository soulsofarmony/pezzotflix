// Profiles and watch-state operations over HTTP: the real server and compose() with the profiles
// module and a fake catalogRead. Every response body is validated against the strict contract helper.
/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are untyped JSON, checked against the contract */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../src/app/compose.ts';
import { loadConfig } from '../src/app/config.ts';
import { buildServer } from '../src/app/server.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { profilesModule } from '../src/modules/profiles/index.ts';
import { contractErrors } from './helpers/contract.ts';
import { fakeCatalogRead, type Seed, seedCatalog } from './profiles-fixtures.ts';

// ---------------------------------------------------------------- app
let db: Db;
let app: FastifyInstance;
let comp: Composition;
let seed: Seed;
let dataDir: string;

async function start(tokenKey?: Buffer) {
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir, LIBRARY_ROOTS: '[]' });
  const catalogRead = fakeCatalogRead(db);
  comp = compose({
    config,
    db,
    log: pino({ level: 'silent' }),
    factories: [() => ({ name: 'catalog', provides: { catalogRead } }), profilesModule(tokenKey ? { tokenKey } : {})],
  });
  app = await buildServer({ logger: false, handlers: comp.handlers, profileTokens: { verify: (t) => comp.ports.profileTokens.verify(t) } });
  await app.ready();
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pzf-profiles-'));
  db = await openDb({ path: ':memory:' });
  seed = seedCatalog(db);
  await start(randomBytes(32));
});
afterEach(async () => {
  await app.close();
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function call(operationId: string, method: Method, url: string, opts: { payload?: unknown; token?: string } = {}) {
  const r = await app.inject({
    method,
    url: `/video/api/v1${url}`,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
  });
  const body: any = r.body ? r.json() : undefined;
  // A 204 has no body to validate (the helper only checks bodies).
  if (r.statusCode === 204) expect(r.body).toBe('');
  else expect(contractErrors(operationId, r.statusCode, body), `${operationId} ${r.statusCode} ${r.body.slice(0, 300)}`).toEqual([]);
  return { status: r.statusCode, body };
}
async function profileWithToken(name = 'Simone') {
  const created = await call('createProfile', 'POST', '/profiles', { payload: { name } });
  const sel = await call('selectProfile', 'POST', `/profiles/${created.body.id}/select`);
  return { id: created.body.id as string, token: sel.body.profileToken as string };
}

describe('profiles API', () => {
  it('create, list, update, delete', async () => {
    const c = await call('createProfile', 'POST', '/profiles', { payload: { name: 'Simone', avatar: 'fox' } });
    expect(c.status).toBe(201);
    expect(c.body).toEqual({ id: c.body.id, name: 'Simone', avatar: 'fox', prefs: { audioLanguages: ['ita', 'eng'], subtitleLanguages: ['ita'], subtitleMode: 'forced' } });

    const prefs = { audioLanguages: ['eng'], subtitleLanguages: [], subtitleMode: 'off' };
    const u = await call('updateProfile', 'PATCH', `/profiles/${c.body.id}`, { payload: { name: 'Simo', prefs } });
    expect(u.body).toMatchObject({ name: 'Simo', avatar: 'fox', prefs });
    expect(comp.ports.profilePlayback.getPrefs(c.body.id as string)).toEqual(prefs);

    expect((await call('listProfiles', 'GET', '/profiles')).body.profiles).toEqual([u.body]);
    expect((await call('deleteProfile', 'DELETE', `/profiles/${c.body.id}`)).status).toBe(204);
    expect((await call('listProfiles', 'GET', '/profiles')).body.profiles).toEqual([]);
    expect(comp.ports.profilePlayback.getPrefs(c.body.id as string)).toBeNull();
  });

  it('errors: duplicate 409, blank or bad language 400, unknown 404', async () => {
    await call('createProfile', 'POST', '/profiles', { payload: { name: 'Simone' } });
    expect((await call('createProfile', 'POST', '/profiles', { payload: { name: 'simone' } })).body.code).toBe('CONFLICT');
    expect((await call('createProfile', 'POST', '/profiles', { payload: { name: ' ' } })).body.code).toBe('VALIDATION_FAILED');
    const bad = await call('createProfile', 'POST', '/profiles', { payload: { name: 'X', prefs: { audioLanguages: ['zz9'], subtitleLanguages: [], subtitleMode: 'off' } } });
    expect(bad.status).toBe(400);
    expect((await call('createProfile', 'POST', '/profiles', { payload: { name: 'X', extra: 1 } })).status).toBe(400);
    expect((await call('updateProfile', 'PATCH', '/profiles/nope', { payload: { name: 'X' } })).status).toBe(404);
    expect((await call('deleteProfile', 'DELETE', '/profiles/nope')).status).toBe(404);
    expect((await call('selectProfile', 'POST', '/profiles/nope/select')).status).toBe(404);
  });
});

describe('profile token', () => {
  it('select returns a token that authorizes watch-state calls', async () => {
    const { id, token } = await profileWithToken();
    expect(token).not.toContain(' ');
    expect(comp.ports.profileTokens.verify(token)).toBe(id);
    const m = seed.item('m1');
    expect((await call('addToWatchlist', 'PUT', `/watchlist/${m}`, { token })).status).toBe(204);
    expect(comp.ports.profileState.getStates(id, [m]).get(m)?.inWatchlist).toBe(true);
  });

  it('rejects missing, forged and deleted-profile tokens', async () => {
    const { id, token } = await profileWithToken();
    const m = seed.item('m1');
    expect((await call('markWatched', 'PUT', `/items/${m}/watched`)).status).toBe(401);
    const [v, pid] = token.split('.');
    const forged = `${v}.${pid}.${randomBytes(32).toString('base64url')}`;
    expect((await call('markWatched', 'PUT', `/items/${m}/watched`, { token: forged })).body.code).toBe('UNAUTHORIZED');
    expect((await call('markWatched', 'PUT', `/items/${m}/watched`, { token: id })).status).toBe(401); // a bare id is not a token
    await call('deleteProfile', 'DELETE', `/profiles/${id}`);
    expect((await call('markWatched', 'PUT', `/items/${m}/watched`, { token })).status).toBe(401);
  });

  it('the signing key is persisted under DATA_DIR and survives a restart', async () => {
    await app.close();
    await start(); // default key loading
    const { token } = await profileWithToken();
    const keyPath = join(dataDir, 'secrets', 'profile-token.key');
    expect(existsSync(keyPath)).toBe(true);
    await app.close();
    await start();
    expect(comp.ports.profileTokens.verify(token)).not.toBeNull();
  });
});

describe('watch-state API', () => {
  it('markWatched / markUnwatched on a series propagate to the episodes', async () => {
    const { id, token } = await profileWithToken();
    const s = seed.series('dark', { 1: 2 });
    expect((await call('markWatched', 'PUT', `/items/${s.seriesId}/watched`, { token })).status).toBe(204);
    expect((await call('markWatched', 'PUT', `/items/${s.seriesId}/watched`, { token })).status).toBe(204); // idempotent
    const st = comp.ports.profileState.getStates(id, [s.seriesId, s.ep(1, 1), s.ep(1, 2)]);
    expect([...st.values()].map((x) => x.watched)).toEqual([true, true, true]);
    expect((await call('markUnwatched', 'DELETE', `/items/${s.seasonId(1)}/watched`, { token })).status).toBe(204);
    expect(comp.ports.profileState.getStates(id, [s.seriesId]).get(s.seriesId)?.watched).toBe(false);
  });

  it('unknown items are 404 where the contract has it', async () => {
    const { token } = await profileWithToken();
    for (const [op, method, url] of [
      ['markWatched', 'PUT', '/items/nope/watched'],
      ['markUnwatched', 'DELETE', '/items/nope/watched'],
      ['addToWatchlist', 'PUT', '/watchlist/nope'],
    ] as const) {
      const r = await call(op, method, url, { token });
      expect(r.status, op).toBe(404);
      expect(r.body.code).toBe('NOT_FOUND');
    }
    // Idempotent deletes without a 404 in the contract.
    expect((await call('clearProgress', 'DELETE', '/items/nope/progress', { token })).status).toBe(204);
    expect((await call('removeFromWatchlist', 'DELETE', '/watchlist/nope', { token })).status).toBe(204);
  });

  it('clearProgress removes an item from Continue watching; playback port drives progress', async () => {
    const { id, token } = await profileWithToken();
    const m = seed.item('m1');
    const pb = comp.ports.profilePlayback;
    pb.recordProgress({ profileId: id, itemId: m, fileId: 'f1', positionMs: 600_000, durationMs: 7_200_000, at: 10, ended: false });
    expect(pb.resumePositionMs(id, m)).toBe(600_000);
    expect(comp.ports.profileState.continueWatching(id, 10)).toEqual([m]);
    expect(comp.ports.profileState.lastPlayed?.(id, [m]).get(m)).toBe(10);
    expect((await call('clearProgress', 'DELETE', `/items/${m}/progress`, { token })).status).toBe(204);
    expect(comp.ports.profileState.continueWatching(id, 10)).toEqual([]);
    expect(pb.resumePositionMs(id, m)).toBeNull();
  });

  it('watchlist add and remove', async () => {
    const { id, token } = await profileWithToken();
    const m = seed.item('m1');
    await call('addToWatchlist', 'PUT', `/watchlist/${m}`, { token });
    expect((await call('removeFromWatchlist', 'DELETE', `/watchlist/${m}`, { token })).status).toBe(204);
    expect(comp.ports.profileState.getStates(id, [m]).get(m)?.inWatchlist).toBe(false);
  });
});
