// Module 'identifier' (doc 02 §3.3): handles identifier.identify (enqueued by analyzer and library).
// Path parser of the library standard, matcher (S4 v2), resolver chain ID tags → Wikidata → TMDB.
import type { ModuleFactory, Ports } from '../../app/module.ts';
import { JOB_TYPES } from '../../shared/job-types.ts';
import { dropProviderCandidates, pullForwardPending } from './maintenance.ts';
import { createProvisional } from './provisional.ts';
import type { Resolver } from './resolvers.ts';
import { createCaseSettlement } from './settle.ts';
import { createIdentifier, IDENTIFY_MAX_ATTEMPTS, REQUEUE_PENDING_EVERY_MS, requeuePending } from './service.ts';

export { IDENTIFY_MAX_ATTEMPTS } from './service.ts';

export interface IdentifierModuleOptions {
  resolvers?: readonly Resolver[];
}

/** A port no module provides throws on access (compose.ts); here that means "not there". */
function optionalPort<K extends keyof Ports>(ports: Ports, key: K): Ports[K] | null {
  try {
    return ports[key];
  } catch {
    return null;
  }
}

export function identifierModule(options: IdentifierModuleOptions = {}): ModuleFactory {
  return function createIdentifierModule(ctx) {
    const ports = ctx.ports;
    const profiles = () => optionalPort(ports, 'profileState');
    const provisional = createProvisional({ db: ctx.db, now: ctx.now, catalog: () => ports.catalogWrite, profiles, log: ctx.log });
    const identifier = createIdentifier({
      db: ctx.db,
      now: ctx.now,
      log: ctx.log,
      events: () => ports.events,
      catalog: () => ports.catalogWrite,
      // The port is resolved lazily and is null while no module provides it.
      metadata: () => optionalPort(ports, 'metadataSearch'),
      profiles,
      lang: ctx.config.METADATA_LANGUAGE,
      maxAttempts: IDENTIFY_MAX_ATTEMPTS,
      ...(options.resolvers ? { resolvers: options.resolvers } : {}),
    });
    let firstRun = true;
    return {
      name: 'identifier',
      provides: {
        caseSettlement: createCaseSettlement({ db: ctx.db, now: ctx.now, events: () => ports.events, provisional }),
        identificationMaintenance: { dropProviderCandidates: (provider, updatedBefore) => dropProviderCandidates(ctx.db, provider, updatedBefore) },
      },
      // Concurrency 1 (ADR 0001): providers are rate limited per host anyway.
      jobs: { [JOB_TYPES.identifierIdentify]: { concurrency: 1, maxAttempts: IDENTIFY_MAX_ATTEMPTS, handler: identifier.identify } },
      periodic: [
        {
          name: 'identifier.requeue_pending',
          everyMs: REQUEUE_PENDING_EVERY_MS,
          // Also at start: pending cases retry as soon as a provider is configured, not a day later.
          runAtStart: true,
          run: () => {
            const n = requeuePending(ctx.db, ports.jobs);
            // The first run is the startup one: deferred jobs of pending cases become due now.
            const moved = firstRun ? pullForwardPending(ctx.db, ctx.now()) : 0;
            firstRun = false;
            if (n || moved) ctx.log.info({ requeued: n, dueNow: moved }, 'pending identifications queued again');
          },
        },
        {
          name: 'identifier.sweep_provisional',
          everyMs: REQUEUE_PENDING_EVERY_MS,
          runAtStart: true,
          // Provisional items no file is on any more (a deleted root, a merged copy).
          run: () => {
            const retired = provisional.sweep();
            if (retired.length) ctx.log.info({ retired }, 'provisional items left without files retired');
          },
        },
      ],
    };
  };
}

export const createIdentifierModule: ModuleFactory = identifierModule();
