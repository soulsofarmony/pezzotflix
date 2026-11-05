// Module 'identifier' (doc 02 §3.3): handles identifier.identify (enqueued by analyzer and library).
// Path parser of the library standard, matcher (S4 v2), resolver chain ID tags → Wikidata → TMDB.
import type { ModuleFactory } from '../../app/module.ts';
import { JOB_TYPES } from '../../shared/job-types.ts';
import type { Resolver } from './resolvers.ts';
import { createIdentifier, IDENTIFY_MAX_ATTEMPTS, REQUEUE_PENDING_EVERY_MS, requeuePending } from './service.ts';

export { IDENTIFY_MAX_ATTEMPTS } from './service.ts';

export interface IdentifierModuleOptions {
  resolvers?: readonly Resolver[];
}

export function identifierModule(options: IdentifierModuleOptions = {}): ModuleFactory {
  return function createIdentifierModule(ctx) {
    const ports = ctx.ports;
    const identifier = createIdentifier({
      db: ctx.db,
      now: ctx.now,
      log: ctx.log,
      events: () => ports.events,
      catalog: () => ports.catalogWrite,
      metadata: () => {
        // The port is resolved lazily and throws while no module provides it (metadata comes in F1a.4).
        try {
          return ports.metadataSearch;
        } catch {
          return null;
        }
      },
      lang: ctx.config.METADATA_LANGUAGE,
      maxAttempts: IDENTIFY_MAX_ATTEMPTS,
      ...(options.resolvers ? { resolvers: options.resolvers } : {}),
    });
    return {
      name: 'identifier',
      // Concurrency 1 (ADR 0001): providers are rate limited per host anyway.
      jobs: { [JOB_TYPES.identifierIdentify]: { concurrency: 1, maxAttempts: IDENTIFY_MAX_ATTEMPTS, handler: identifier.identify } },
      periodic: [
        {
          name: 'identifier.requeue_pending',
          everyMs: REQUEUE_PENDING_EVERY_MS,
          run: () => {
            const n = requeuePending(ctx.db, ports.jobs);
            if (n) ctx.log.info({ requeued: n }, 'pending identifications queued again');
          },
        },
      ],
    };
  };
}

export const createIdentifierModule: ModuleFactory = identifierModule();
