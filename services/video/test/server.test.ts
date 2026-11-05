import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, maskUrl } from '../src/app/server.ts';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({
    logger: false,
    profileTokens: { verify: (t) => (t === 'good' ? 'p1' : null) },
    handlers: {
      getHealth: async () => ({ status: 'ok', db: 'ok', roots: {} }),
      getHome: async (req) => ({ rows: [], who: req.profileId }),
    },
  });
  await app.ready();
});
afterAll(async () => app.close());

describe('server skeleton', () => {
  it('serves health without auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/video/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok', db: 'ok', roots: {} });
  });

  it('requires a profile token on protected operations', async () => {
    const r = await app.inject({ method: 'GET', url: '/video/api/v1/home' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.json().code).toBe('UNAUTHORIZED');
  });

  it('strips fields not in the response schema', async () => {
    const r = await app.inject({ method: 'GET', url: '/video/api/v1/home', headers: { authorization: 'Bearer good' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ rows: [] });
  });

  it('returns 501 problem for operations not implemented yet', async () => {
    const r = await app.inject({ method: 'GET', url: '/video/api/v1/profiles' });
    expect(r.statusCode).toBe(501);
    expect(r.json().code).toBe('INTERNAL');
  });

  it('validates requests against the contract', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/video/api/v1/playback/sessions',
      headers: { authorization: 'Bearer good' },
      payload: { itemId: 'x' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('VALIDATION_FAILED');
  });

  it('answers unknown routes with a problem', async () => {
    const r = await app.inject({ method: 'GET', url: '/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('NOT_FOUND');
  });

  it('masks session tokens in urls', () => {
    expect(maskUrl('/video/media/s/abcDEF123/file?x=1')).toBe('/video/media/s/***/file?x=1');
  });
});
