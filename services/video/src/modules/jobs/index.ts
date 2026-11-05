// Job queue on SQLite (ADR 0002) and its runner (ADR 0001): a hand-written loop over job.run_at
// with per-type concurrency, exponential backoff and periodic tasks. job.run_at is the single
// source of truth for the next attempt.
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.ts';
import type { JobTypeSpec, ModuleFactory, PeriodicTask } from '../../app/module.ts';
import { newId } from '../../shared/ids.ts';

const DEFAULT_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 6 * 3600_000;

export interface EnqueueInput {
  type: string;
  payload: unknown;
  priority?: number;
  idempotencyKey?: string;
  runAt?: number;
}

/**
 * Enqueue a job. With an idempotency key, a queued/running job with the same key is left alone
 * (returns null); a finished or failed one is re-queued with the new payload.
 */
export function enqueueJob(db: Db, now: number, input: EnqueueInput): string | null {
  const id = newId();
  const row = db.$client
    .prepare(
      `INSERT INTO job (id, type, payload, priority, state, attempts, run_at, idempotency_key, created_at, updated_at)
       VALUES (@id, @type, @payload, @priority, 'queued', 0, @runAt, @key, @now, @now)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         type = excluded.type, payload = excluded.payload, priority = excluded.priority,
         state = 'queued', attempts = 0, run_at = excluded.run_at, last_error = NULL, updated_at = excluded.updated_at
       WHERE job.state IN ('done', 'failed')
       RETURNING id`,
    )
    .get({
      id,
      type: input.type,
      payload: JSON.stringify(input.payload ?? null),
      priority: input.priority ?? 100,
      runAt: input.runAt ?? now,
      key: input.idempotencyKey ?? null,
      now,
    }) as { id: string } | undefined;
  return row?.id ?? null;
}

export const backoffMs = (attempt: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));

interface ClaimedJob {
  id: string;
  type: string;
  payload: string;
  attempts: number;
}

export interface JobRunner {
  start(): void;
  stop(): Promise<void>;
  /** Run due jobs until none is runnable (tests). */
  drain(): Promise<void>;
}

export function createJobRunner(args: {
  db: Db;
  log: FastifyBaseLogger;
  jobTypes: Map<string, JobTypeSpec>;
  periodic: PeriodicTask[];
  now?: () => number;
  pollMs?: number;
}): JobRunner {
  const { db, log, jobTypes, periodic } = args;
  const now = args.now ?? Date.now;
  const pollMs = args.pollMs ?? 1000;
  const running = new Map<string, number>();
  const inflight = new Set<Promise<void>>();
  const abort = new AbortController();
  const timers: NodeJS.Timeout[] = [];
  let loop: NodeJS.Timeout | undefined;
  let stopped = false;
  let started = false;

  // Jobs left 'running' by a crash are re-queued at startup.
  db.$client.prepare("UPDATE job SET state = 'queued', updated_at = ? WHERE state = 'running'").run(now());

  const claim = db.$client.prepare(
    `UPDATE job SET state = 'running', attempts = attempts + 1, updated_at = @now
     WHERE id = (SELECT id FROM job WHERE state = 'queued' AND type = @type AND run_at <= @now
                 ORDER BY priority, run_at, id LIMIT 1)
     RETURNING id, type, payload, attempts`,
  );
  const done = db.$client.prepare("UPDATE job SET state = 'done', last_error = NULL, updated_at = ? WHERE id = ?");
  const retry = db.$client.prepare("UPDATE job SET state = 'queued', run_at = ?, last_error = ?, updated_at = ? WHERE id = ?");
  const fail = db.$client.prepare("UPDATE job SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?");

  const runOne = async (job: ClaimedJob, spec: JobTypeSpec): Promise<void> => {
    const jl = log.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    try {
      await spec.handler(JSON.parse(job.payload), { jobId: job.id, attempt: job.attempts, log: jl, signal: abort.signal });
      done.run(now(), job.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const max = spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      if (job.attempts >= max || abort.signal.aborted) {
        if (abort.signal.aborted) retry.run(now(), msg, now(), job.id);
        else fail.run(msg, now(), job.id);
        jl.warn({ err: msg }, 'job failed');
      } else {
        retry.run(now() + backoffMs(job.attempts), msg, now(), job.id);
        jl.info({ err: msg }, 'job will be retried');
      }
    }
  };

  const tick = (): number => {
    let count = 0;
    for (const [type, spec] of jobTypes) {
      while ((running.get(type) ?? 0) < spec.concurrency) {
        const job = claim.get({ type, now: now() }) as ClaimedJob | undefined;
        if (!job) break;
        running.set(type, (running.get(type) ?? 0) + 1);
        count++;
        const p = runOne(job, spec).finally(() => {
          running.set(type, (running.get(type) ?? 1) - 1);
          inflight.delete(p);
          if (started && !stopped) schedule(0);
        });
        inflight.add(p);
      }
    }
    return count;
  };

  const schedule = (ms: number) => {
    if (stopped) return;
    if (loop) clearTimeout(loop);
    loop = setTimeout(() => {
      tick();
      schedule(pollMs);
    }, ms);
  };

  const runPeriodic = async (t: PeriodicTask) => {
    try {
      await t.run();
    } catch (err) {
      log.warn({ task: t.name, err: err instanceof Error ? err.message : String(err) }, 'periodic task failed');
    }
  };

  return {
    start() {
      started = true;
      for (const t of periodic) {
        if (t.runAtStart) void runPeriodic(t);
        timers.push(setInterval(() => void runPeriodic(t), t.everyMs));
      }
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (loop) clearTimeout(loop);
      for (const t of timers) clearInterval(t);
      abort.abort();
      await Promise.allSettled([...inflight]);
    },
    async drain() {
      for (;;) {
        const started = tick();
        if (started === 0 && inflight.size === 0) return;
        await Promise.race([...inflight]);
      }
    },
  };
}

export const createJobsModule: ModuleFactory = ({ db, now }) => ({
  name: 'jobs',
  provides: { jobs: { enqueue: (input) => enqueueJob(db, now(), input) } },
});
