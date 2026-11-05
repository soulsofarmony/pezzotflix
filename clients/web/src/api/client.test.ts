import { describe, expect, it, vi } from 'vitest';
import spec from '../../../../services/video/contract/dist/openapi.json';
import { call, createVideoClient, PUBLIC_OPERATIONS } from './client.ts';
import { ApiError, parseRetryAfter, toApiError } from './problem.ts';
import { createProfileStore } from './profileStore.ts';

interface Operation {
  security?: unknown[];
}

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

function setup(status = 200, body: unknown = {}, headers: Record<string, string> = {}) {
  const seen: Request[] = [];
  const fetch = vi.fn((input: Request) => {
    seen.push(input);
    return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers } }));
  });
  const store = createProfileStore(memoryStorage());
  store.set({ id: 'p1', name: 'Simone', token: 'tok-1' });
  const onUnauthorized = vi.fn();
  const client = createVideoClient({ baseUrl: 'http://pzf.test', store, onUnauthorized, fetch: fetch as unknown as typeof globalThis.fetch });
  return { client, store, onUnauthorized, seen };
}

describe('PUBLIC_OPERATIONS', () => {
  it('lists exactly the control-plane operations with security: [] in the contract', () => {
    const fromSpec: string[] = [];
    for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, Operation>>)) {
      // Data-plane URLs are opaque locators used by <video>, hls.js and libpgs, never by this client.
      if (path.startsWith('/video/media/')) continue;
      for (const [method, op] of Object.entries(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        if (Array.isArray(op.security) && op.security.length === 0) fromSpec.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect([...PUBLIC_OPERATIONS].sort()).toEqual(fromSpec.sort());
  });
});

describe('profile middleware', () => {
  it('adds the profile token to profile-scoped operations only', async () => {
    const { client, seen } = setup(200, { rows: [] });
    await client.GET('/video/api/v1/home');
    await client.GET('/video/api/v1/profiles');
    expect(seen[0]?.headers.get('Authorization')).toBe('Bearer tok-1');
    expect(seen[1]?.headers.get('Authorization')).toBeNull();
  });

  it('a 401 on a profile operation clears the profile and goes back to the choice', async () => {
    const { client, store, onUnauthorized } = setup(401, { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'UNAUTHORIZED' });
    await expect(call(client.GET('/video/api/v1/home'))).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(store.get()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('a 401 on a public operation does not clear the profile', async () => {
    const { client, store, onUnauthorized } = setup(401, {});
    await expect(call(client.GET('/video/api/v1/profiles'))).rejects.toBeInstanceOf(ApiError);
    expect(store.get()).not.toBeNull();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('passes keepalive through to the Request (stopPlayback on pagehide)', async () => {
    const { client, seen } = setup(204);
    await call(client.POST('/video/api/v1/playback/sessions/{sessionId}/stop', { params: { path: { sessionId: 's1' } }, body: { positionMs: 1000 }, keepalive: true }));
    expect(seen[0]?.keepalive).toBe(true);
  });
});

describe('call and problem+json', () => {
  it('maps a problem by code and status, with Retry-After', async () => {
    const { client } = setup(503, { type: 'about:blank', title: 'Preparing', status: 503, code: 'STREAM_PREPARING', detail: 'remux in progress' }, { 'Retry-After': '3' });
    const err = await call(client.GET('/video/api/v1/home')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'STREAM_PREPARING', detail: 'remux in progress', retryAfterMs: 3000, transient: true });
  });

  it('keeps activeSessions of SESSION_LIMIT_REACHED', () => {
    const e = toApiError(new Response(null, { status: 409 }), { code: 'SESSION_LIMIT_REACHED', title: 'Limit', status: 409, activeSessions: [{ sessionId: 'x' }] });
    expect(e.activeSessions).toEqual([{ sessionId: 'x' }]);
    expect(e.sessionClosed).toBe(false);
  });

  it('reads the sessionClosed extension of a 422', () => {
    const e = toApiError(new Response(null, { status: 422 }), { code: 'NO_COMPATIBLE_PLAN', title: 'No plan', status: 422, sessionClosed: true });
    expect(e.sessionClosed).toBe(true);
  });

  it('falls back to a code by status when the body is not a problem', () => {
    expect(toApiError(new Response(null, { status: 404 }), 'Not Found').code).toBe('NOT_FOUND');
    expect(toApiError(new Response(null, { status: 418 }), null).code).toBe('UNEXPECTED');
  });

  it('turns a fetch failure into NETWORK', async () => {
    const store = createProfileStore(memoryStorage());
    const client = createVideoClient({ baseUrl: 'http://pzf.test', store, onUnauthorized: vi.fn(), fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(call(client.GET('/video/api/v1/server'))).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });

  it.each([
    ['5', 5000],
    [' 0 ', 0],
    [null, null],
    ['garbage', null],
  ])('parseRetryAfter(%s) → %s', (v, ms) => {
    expect(parseRetryAfter(v)).toBe(ms);
  });

  it('parses an HTTP-date Retry-After', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    expect(parseRetryAfter('Thu, 05 Nov 2026 10:00:07 GMT', now)).toBe(7000);
  });
});

describe('profile store', () => {
  it('persists, notifies and follows other tabs', () => {
    const storage = memoryStorage();
    const win = new EventTarget() as unknown as Window;
    const store = createProfileStore(storage, win);
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.set({ id: 'p1', name: 'A', token: 't' });
    expect(JSON.parse(storage.getItem('pezzotflix.profile') ?? 'null')).toEqual({ id: 'p1', name: 'A', token: 't' });
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'pezzotflix.profile', newValue: JSON.stringify({ id: 'p2', name: 'B', token: 'u' }) }));
    expect(store.get()?.id).toBe('p2');
    store.clear();
    expect(store.get()).toBeNull();
    expect(fn).toHaveBeenCalledTimes(3);
    off();
    expect(createProfileStore(storage).get()).toBeNull();
  });

  it('ignores a corrupt stored value', () => {
    const storage = memoryStorage();
    storage.setItem('pezzotflix.profile', '{bad');
    expect(createProfileStore(storage).get()).toBeNull();
  });
});
