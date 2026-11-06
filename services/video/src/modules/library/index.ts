// Module 'library' (doc 02 §3.1, Library Monitor): configured roots, periodic full scan as the
// primary mechanism, file states, moves and sidecars; enqueues analyzer.probe for added, changed
// and revived files. Missing files are forgotten ('removed') after a grace period or on request.
import { z } from 'zod';
import type { ModuleFactory } from '../../app/module.ts';
import { JOB_TYPES, type LibraryScanPayload } from '../../shared/job-types.ts';
import type { JobQueuePort } from '../../shared/ports.ts';
import { createRemoval, DAY_MS } from './removal.ts';
import { confirmRootContents, syncRoots } from './roots.ts';
import { createScanner } from './scan.ts';

/** A file modified within the last minute is assumed to be still copying (doc 02 §3.1). */
const STABLE_AFTER_MS = 60_000;

/** Payload of library.scan: one root, or every configured root when rootId is absent. */
const ScanPayload: z.ZodType<LibraryScanPayload | null | undefined> = z.object({ rootId: z.string().min(1).optional() }).nullish();

/** Periodic task that forgets files missing for longer than MISSING_REMOVE_AFTER_DAYS. */
export const REMOVE_MISSING_TASK = 'library.remove_missing';

/** Idempotency key of a scan: at most one queued scan per target. */
export const scanJobKey = (rootId?: string): string => `library.scan:${rootId ?? 'all'}`;

/**
 * Requests a scan. While one is queued the request is already covered; while one is running, a
 * single follow-up is queued under a second key, so changes made during the run are picked up.
 * TriggerScan (admin) must enqueue the same way.
 */
export function requestScan(jobs: JobQueuePort, rootId?: string): string | null {
  const payload: LibraryScanPayload = rootId ? { rootId } : {};
  const key = scanJobKey(rootId);
  return (
    jobs.enqueue({ type: JOB_TYPES.libraryScan, payload, idempotencyKey: key }) ??
    jobs.enqueue({ type: JOB_TYPES.libraryScan, payload, idempotencyKey: `${key}:next` })
  );
}

export interface LibraryModuleOptions {
  stableAfterMs?: number;
}

export function libraryModule(options: LibraryModuleOptions = {}): ModuleFactory {
  return function createLibraryModule({ config, db, log, ports, now }) {
    const scanner = createScanner({
      db,
      now,
      log,
      jobs: () => ports.jobs,
      events: () => ports.events,
      // Throws while no module provides it; the scanner treats that as absent.
      settlement: () => ports.caseSettlement,
      stableAfterMs: options.stableAfterMs ?? STABLE_AFTER_MS,
    });
    const removal = createRemoval({ db, now, events: () => ports.events });
    let removing = false;
    return {
      name: 'library',
      provides: {
        library: {
          requestScan: (rootId) => requestScan(ports.jobs, rootId),
          confirmRootContents: (rootId) => {
            const found = confirmRootContents(db, config.LIBRARY_ROOTS, rootId, now());
            return found === 'queued' ? { status: 'queued', jobId: requestScan(ports.jobs, rootId) } : { status: found };
          },
          forgetFile: removal.forgetFile,
          forgetRootMissing: removal.forgetRootMissing,
        },
      },
      start: () => {
        // The config cannot change while running: skipped roots are reported once.
        for (const s of syncRoots(db, config.LIBRARY_ROOTS, now()).skipped) {
          log.warn({ root: s.spec.name, path: s.spec.path, reason: s.reason, clashesWith: s.clashesWith }, 'library root skipped');
        }
      },
      jobs: {
        [JOB_TYPES.libraryScan]: {
          concurrency: 1,
          maxAttempts: 3,
          handler: async (payload, job) => {
            const rootId = ScanPayload.parse(payload)?.rootId;
            const { roots } = syncRoots(db, config.LIBRARY_ROOTS, now());
            const target = rootId ? roots.filter((r) => r.id === rootId) : roots;
            if (rootId && target.length === 0) return void job.log.warn({ rootId }, 'scan skipped: root not configured');
            const summaries = await scanner.scan(target, job.signal);
            ports.events.publish('ingest.progress', { phase: 'scan', roots: summaries });
            job.log.info({ roots: summaries }, 'library scan done');
          },
        },
      },
      periodic: [
        {
          name: JOB_TYPES.libraryScan,
          everyMs: config.LIBRARY_SCAN_INTERVAL_MIN * 60_000,
          runAtStart: true,
          run: () => {
            requestScan(ports.jobs);
          },
        },
        {
          // Daily, and at start: a service that never stays up for a day still forgets. One run at a time.
          name: REMOVE_MISSING_TASK,
          everyMs: DAY_MS,
          runAtStart: true,
          run: async () => {
            if (removing) return;
            removing = true;
            try {
              const forgotten = await removal.removeAged(config.MISSING_REMOVE_AFTER_DAYS);
              if (forgotten) log.info({ forgotten, afterDays: config.MISSING_REMOVE_AFTER_DAYS }, 'missing files forgotten after the grace period');
            } finally {
              removing = false;
            }
          },
        },
      ],
    };
  };
}

export const createLibraryModule: ModuleFactory = libraryModule();
