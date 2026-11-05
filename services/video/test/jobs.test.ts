import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { openDb, closeDb, type Db } from '../src/db/index.ts';
import { createJobRunner, enqueueJob } from '../src/modules/jobs/index.ts';
import type { JobTypeSpec } from '../src/app/module.ts';

const log = pino({ level: 'silent' });
let db: Db;
afterEach(() => closeDb(db));

describe('job queue', () => {
  it('deduplicates by idempotency key while queued and re-queues when done', async () => {
    db = await openDb({ path: ':memory:' });
    expect(enqueueJob(db, 1, { type: 'probe', payload: { f: 1 }, idempotencyKey: 'probe:f1' })).toBeTypeOf('string');
    expect(enqueueJob(db, 2, { type: 'probe', payload: { f: 1 }, idempotencyKey: 'probe:f1' })).toBeNull();

    const seen: unknown[] = [];
    const jobTypes = new Map<string, JobTypeSpec>([['probe', { concurrency: 1, handler: async (p) => void seen.push(p) }]]);
    const runner = createJobRunner({ db, log, jobTypes, periodic: [], now: () => 10 });
    await runner.drain();
    expect(seen).toEqual([{ f: 1 }]);

    expect(enqueueJob(db, 5, { type: 'probe', payload: { f: 2 }, idempotencyKey: 'probe:f1' })).toBeTypeOf('string');
    await runner.drain();
    expect(seen).toEqual([{ f: 1 }, { f: 2 }]);
    await runner.stop();
  });

  it('retries with backoff, then fails after max attempts', async () => {
    db = await openDb({ path: ':memory:' });
    let t = 0;
    let calls = 0;
    enqueueJob(db, t, { type: 'x', payload: null });
    const jobTypes = new Map<string, JobTypeSpec>([
      ['x', { concurrency: 1, maxAttempts: 2, handler: async () => { calls++; throw new Error('boom'); } }],
    ]);
    const runner = createJobRunner({ db, log, jobTypes, periodic: [], now: () => t });
    await runner.drain();
    expect(calls).toBe(1);
    await runner.drain(); // not due yet
    expect(calls).toBe(1);
    t += 31_000;
    await runner.drain();
    expect(calls).toBe(2);
    const row = db.$client.prepare('SELECT state, last_error FROM job').get() as { state: string; last_error: string };
    expect(row).toEqual({ state: 'failed', last_error: 'boom' });
    await runner.stop();
  });

  it('defers a job that asks for a later run without counting the attempt', async () => {
    db = await openDb({ path: ':memory:' });
    let t = 0;
    let calls = 0;
    enqueueJob(db, t, { type: 'x', payload: null });
    const later = Object.assign(new Error('provider not ready'), { retryAfterMs: 60_000 });
    const jobTypes = new Map<string, JobTypeSpec>([
      ['x', { concurrency: 1, maxAttempts: 1, handler: async () => { calls++; if (calls <= 3) throw later; } }],
    ]);
    const runner = createJobRunner({ db, log, jobTypes, periodic: [], now: () => t });
    const state = () => db.$client.prepare('SELECT state, attempts, run_at FROM job').get() as { state: string; attempts: number; run_at: number };
    for (let i = 1; i <= 3; i++) {
      await runner.drain();
      expect(calls).toBe(i);
      // With maxAttempts 1 a counted attempt would have failed the job: a deferral never does.
      expect(state()).toEqual({ state: 'queued', attempts: 0, run_at: t + 60_000 });
      await runner.drain(); // not due yet
      expect(calls).toBe(i);
      t += 60_000;
    }
    await runner.drain();
    expect(calls).toBe(4);
    expect(state().state).toBe('done');
    await runner.stop();
  });
});
