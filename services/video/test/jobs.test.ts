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

  describe('jobs left running by a stop', () => {
    const rows = () => db.$client.prepare('SELECT type, state, attempts, last_error AS error FROM job ORDER BY type').all();
    // What a crash mid-job leaves: the claim counted the attempt, the row stays 'running'.
    const crashOn = (attempts: number, type?: string) =>
      db.$client.prepare(`UPDATE job SET state = 'running', attempts = ?${type ? ' WHERE type = ?' : ''}`).run(...(type ? [attempts, type] : [attempts]));

    it('a job that kills the process is re-queued at start, and fails once interrupted again on its last attempt', async () => {
      db = await openDb({ path: ':memory:' });
      enqueueJob(db, 0, { type: 'x', payload: null });
      enqueueJob(db, 0, { type: 'other', payload: null }); // a type without maxAttempts: the default, 5
      const jobTypes = new Map<string, JobTypeSpec>([
        ['x', { concurrency: 1, maxAttempts: 3, handler: async () => undefined }],
        ['other', { concurrency: 1, handler: async () => undefined }],
      ]);
      crashOn(2);
      createJobRunner({ db, log, jobTypes, periodic: [], now: () => 1 });
      expect(rows()).toEqual([
        { type: 'other', state: 'queued', attempts: 2, error: 'interrupted, queued again (attempt 2)' },
        { type: 'x', state: 'queued', attempts: 2, error: 'interrupted, queued again (attempt 2)' },
      ]);
      crashOn(3);
      createJobRunner({ db, log, jobTypes, periodic: [], now: () => 2 });
      expect(rows()).toEqual([
        { type: 'other', state: 'queued', attempts: 3, error: 'interrupted, queued again (attempt 3)' },
        { type: 'x', state: 'failed', attempts: 3, error: 'interrupted on its last attempt (3 of 3): the service stopped while it ran, twice in a row' },
      ]);
      crashOn(5, 'other');
      const runner = createJobRunner({ db, log, jobTypes, periodic: [], now: () => 3 });
      expect((rows() as { state: string }[]).map((r) => r.state)).toEqual(['failed', 'failed']);
      await runner.drain(); // nothing runs again
      expect((rows() as { state: string }[]).map((r) => r.state)).toEqual(['failed', 'failed']);
      await runner.stop();
    });

    it('one interruption on the last attempt (a stop that outlasted the grace period) runs the job once more', async () => {
      db = await openDb({ path: ':memory:' });
      enqueueJob(db, 0, { type: 'x', payload: null });
      let calls = 0;
      const jobTypes = new Map<string, JobTypeSpec>([['x', { concurrency: 1, maxAttempts: 3, handler: async () => void calls++ }]]);
      // Two attempts failed for real, the third was cut by SIGKILL.
      db.$client.prepare("UPDATE job SET state = 'running', attempts = 3, last_error = 'ffprobe exit 1'").run();
      const runner = createJobRunner({ db, log, jobTypes, periodic: [], now: () => 1 });
      expect(rows()).toEqual([{ type: 'x', state: 'queued', attempts: 3, error: 'interrupted, queued again (attempt 3)' }]);
      await runner.drain();
      expect([calls, (rows()[0] as { state: string }).state]).toEqual([1, 'done']);
      await runner.stop();
    });
  });
});
