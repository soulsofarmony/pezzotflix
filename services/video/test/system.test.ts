// System operations over HTTP (doc 03 §3.1, §7): health (200 and the 503 body), server info features,
// the health check's log level, and listEvents cursors. Bodies are checked against the contract.
/* eslint-disable @typescript-eslint/no-unsafe-call -- response bodies are untyped JSON, checked against the contract by the harness */
import pino from 'pino';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/app/config.ts';
import type { Ports } from '../src/app/module.ts';
import { buildServer, createLogger } from '../src/app/server.ts';
import { closeDb, openDb } from '../src/db/index.ts';
import { createSystemModule } from '../src/modules/system/index.ts';
import { harness, type Harness } from './helpers/app-harness.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const noPorts = new Proxy({} as Ports, {
  get: (_t, key: string) => {
    throw new Error(`port '${key}' is not provided by any module`);
  },
});

describe('health and server info', () => {
  it('health answers 200 when the database answers, and 503 with a Health body when it does not', async () => {
    h = await harness({ extra: [createSystemModule] });
    const ok = await h.call('getHealth', 'GET', '/video/healthz');
    expect(ok).toEqual({ status: 200, body: { status: 'ok', db: 'ok' } });
    vi.spyOn(h.db.$client, 'prepare').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    const down = await h.call('getHealth', 'GET', '/video/healthz');
    expect(down).toEqual({ status: 503, body: { status: 'degraded', db: 'error' } });
  });

  it.each([
    ['1', true],
    ['0', false],
  ])('features.transcode follows MAX_TRANSCODES (%s → %s)', async (max, transcode) => {
    const db = await openDb({ path: ':memory:' });
    try {
      const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: '/nonexistent', LIBRARY_ROOTS: '[]', MAX_TRANSCODES: max });
      const system = createSystemModule({ config, db, log: pino({ level: 'silent' }), ports: noPorts, now: () => 0 });
      const info = (await system.handlers!.getServerInfo!({} as never, {} as never)) as { features: { transcode: boolean; directStream: boolean } };
      expect(info.features).toEqual({ transcode, directStream: true });
    } finally {
      closeDb(db);
    }
  });

  it('health requests are logged from warn up only; other requests at info', async () => {
    const lines: { msg?: string; level: number; req?: { url: string }; reqId?: string }[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        for (const l of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l) as (typeof lines)[number]);
        cb();
      },
    });
    let healthy = true;
    const app = await buildServer({
      logger: createLogger('info', sink),
      profileTokens: { verify: () => null },
      handlers: {
        getHealth: async (req, reply) => {
          if (healthy) return { status: 'ok', db: 'ok' };
          req.log.warn('health check: the database does not answer');
          reply.status(503);
          return { status: 'degraded', db: 'error' };
        },
      },
    });
    await app.ready();
    lines.length = 0; // start-up notices of the contract plugin
    try {
      for (let i = 0; i < 3; i++) expect((await app.inject({ method: 'GET', url: '/video/healthz' })).statusCode).toBe(200);
      expect(lines.map((l) => l.msg)).toEqual([]);
      await app.inject({ method: 'GET', url: '/video/api/v1/server' }); // not implemented here: a 501, logged
      expect(lines.some((l) => l.req?.url === '/video/api/v1/server')).toBe(true);
      lines.length = 0;
      healthy = false;
      expect((await app.inject({ method: 'GET', url: '/video/healthz' })).statusCode).toBe(503);
      expect(lines.map((l) => [l.level, l.msg])).toEqual([[40, 'health check: the database does not answer']]);
    } finally {
      await app.close();
    }
  });
});

describe('listEvents', () => {
  const publish = (hh: Harness, n: number) => {
    for (let i = 0; i < n; i++) hh.comp.ports.events.publish('library.item_updated', { itemId: `i${i}` });
  };

  it('the first call answers the current position and no events; then the events after it', async () => {
    h = await harness();
    expect((await h.call('listEvents', 'GET', '/video/api/v1/events')).body).toEqual({ events: [], nextCursor: 'e0' });
    publish(h, 3);
    const first = await h.call('listEvents', 'GET', '/video/api/v1/events');
    expect(first.body).toEqual({ events: [], nextCursor: 'e3' });
    publish(h, 2);
    const page = await h.call('listEvents', 'GET', '/video/api/v1/events?cursor=e3&limit=1');
    expect(page.body.events.map((e: { seq: number }) => e.seq)).toEqual([4]);
    expect(page.body.nextCursor).toBe('e4');
    const rest = await h.call('listEvents', 'GET', '/video/api/v1/events?cursor=e4');
    expect(rest.body.events.map((e: { seq: number }) => e.seq)).toEqual([5]);
    expect((await h.call('listEvents', 'GET', '/video/api/v1/events?cursor=e5')).body).toEqual({ events: [], nextCursor: 'e5' });
  });

  it('410 once the events after the cursor were pruned; the cursor just before the oldest still works', async () => {
    h = await harness();
    publish(h, 10);
    h.db.$client.prepare('DELETE FROM domain_event WHERE seq <= 5').run(); // what events.prune does after 7 days
    const boundary = await h.call('listEvents', 'GET', '/video/api/v1/events?cursor=e5');
    expect(boundary.body.events.map((e: { seq: number }) => e.seq)).toEqual([6, 7, 8, 9, 10]);
    const expired = await h.call('listEvents', 'GET', '/video/api/v1/events?cursor=e4');
    expect([expired.status, expired.body.code]).toEqual([410, 'CURSOR_EXPIRED']);
    // Every event pruned: a cursor before the last one issued missed some.
    h.db.$client.prepare('DELETE FROM domain_event').run();
    expect((await h.call('listEvents', 'GET', '/video/api/v1/events?cursor=e10')).body).toEqual({ events: [], nextCursor: 'e10' });
    expect((await h.call('listEvents', 'GET', '/video/api/v1/events?cursor=e9')).status).toBe(410);
    expect((await h.call('listEvents', 'GET', '/video/api/v1/events')).body.nextCursor).toBe('e10');
  });

  it('410 for a cursor ahead of every seq issued (a database restored from a backup)', async () => {
    h = await harness();
    publish(h, 3);
    const ahead = await h.call('listEvents', 'GET', '/video/api/v1/events?cursor=e7');
    expect([ahead.status, ahead.body.code]).toEqual([410, 'CURSOR_EXPIRED']);
    const empty = await harness();
    try {
      expect((await empty.call('listEvents', 'GET', '/video/api/v1/events?cursor=e1')).status).toBe(410);
    } finally {
      await empty.close();
    }
  });

  it.each(['x1', 'e', 'e-1', 'E3'])('400 for an invalid cursor (%s)', async (cursor) => {
    h ??= await harness();
    const bad = await h.call('listEvents', 'GET', `/video/api/v1/events?cursor=${encodeURIComponent(cursor)}`);
    expect([bad.status, bad.body.code]).toEqual([400, 'VALIDATION_FAILED']);
  });
});
