// The real Fastify app over compose() with an in-memory DB and chosen modules, for catalog and admin
// HTTP tests. Every response is validated against the contract of its operation.
/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are untyped JSON, checked against the contract */
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { expect } from 'vitest';
import { compose, type Composition } from '../../src/app/compose.ts';
import { loadConfig } from '../../src/app/config.ts';
import type { ModuleFactory } from '../../src/app/module.ts';
import { buildServer } from '../../src/app/server.ts';
import { closeDb, type Db, openDb } from '../../src/db/index.ts';
import { createAdminModule } from '../../src/modules/admin/index.ts';
import { createCatalogModule } from '../../src/modules/catalog/index.ts';
import { createEventsModule } from '../../src/modules/events/index.ts';
import { createIdentifierModule } from '../../src/modules/identifier/index.ts';
import { createJobsModule } from '../../src/modules/jobs/index.ts';
import { createLibraryModule } from '../../src/modules/library/index.ts';
import type { MetadataSearchPort, ProfileStatePort } from '../../src/shared/ports.ts';
import { contractErrors } from './contract.ts';

export const TOKEN = 'tok';
export const PROFILE = 'p1';

export interface Harness {
  db: Db;
  app: FastifyInstance;
  comp: Composition;
  clock: { now: number };
  /** Injects a request, checks the body against the contract of operationId, returns status and body. */
  call: (operationId: string, method: 'GET' | 'POST', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  profileState?: ProfileStatePort;
  metadata?: MetadataSearchPort;
  extra?: ModuleFactory[];
  /** LIBRARY_ROOTS of the config; the roots are not created (seed them, or let a scan sync them). */
  roots?: { name: string; path: string; hint?: 'movies' | 'series' | 'mixed' }[];
  /** More configuration keys (e.g. MISSING_REMOVE_AFTER_DAYS). */
  env?: Record<string, string>;
}

export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const db = await openDb({ path: ':memory:' });
  const clock = { now: 1_000_000 };
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: '/nonexistent',
    LIBRARY_ROOTS: JSON.stringify((opts.roots ?? []).map((r) => ({ hint: 'movies', ...r }))),
    ...opts.env,
  });
  const factories: ModuleFactory[] = [createEventsModule, createJobsModule, createLibraryModule, createCatalogModule, createIdentifierModule, createAdminModule, ...(opts.extra ?? [])];
  if (opts.profileState) {
    const profileState = opts.profileState;
    factories.push(() => ({ name: 'profiles', provides: { profileState } }));
  }
  if (opts.metadata) {
    const metadataSearch = opts.metadata;
    factories.push(() => ({ name: 'metadata', provides: { metadataSearch } }));
  }
  const comp = compose({ config, db, log: pino({ level: 'silent' }), now: () => clock.now, factories });
  const app = await buildServer({ logger: false, handlers: comp.handlers, profileTokens: { verify: (t) => (t === TOKEN ? PROFILE : null) } });
  await app.ready();
  const call: Harness['call'] = async (operationId, method, url, payload) => {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const body = r.body ? r.json() : undefined;
    expect(contractErrors(operationId, r.statusCode, body), `${operationId} ${r.statusCode} ${r.body.slice(0, 400)}`).toEqual([]);
    return { status: r.statusCode, body };
  };
  return {
    db,
    app,
    comp,
    clock,
    call,
    close: async () => {
      await app.close();
      closeDb(db);
    },
  };
}
