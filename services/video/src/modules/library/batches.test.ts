// Event-loop friendliness of the scan: batched writes yield between transactions, stats are bounded.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db, openDb } from '../../db/index.ts';
import { runInBatches } from './scan.ts';
import { mapLimit, STAT_CONCURRENCY } from './walk.ts';

let db: Db;
beforeEach(async () => {
  db = await openDb({ path: ':memory:' });
});
afterEach(() => closeDb(db));

describe('runInBatches', () => {
  it('lets the event loop run between two transactions', async () => {
    let ticked = false;
    const seenInSecondBatch: boolean[] = [];
    const ops = [
      () => void setImmediate(() => (ticked = true)),
      () => void seenInSecondBatch.push(ticked),
      () => void seenInSecondBatch.push(ticked),
    ];
    await runInBatches(db, ops, 1);
    expect(seenInSecondBatch).toEqual([true, true]);
  });

  it('runs each batch as one transaction', async () => {
    db.$client.exec('CREATE TABLE t (x INTEGER)');
    const insert = (x: number) => () => void db.$client.prepare('INSERT INTO t (x) VALUES (?)').run(x);
    const failing = () => {
      throw new Error('boom');
    };
    await expect(runInBatches(db, [insert(1), insert(2), insert(3), failing], 2)).rejects.toThrow('boom');
    expect(db.$client.prepare('SELECT x FROM t ORDER BY x').all()).toEqual([{ x: 1 }, { x: 2 }]); // 2nd batch rolled back
  });
});

describe('mapLimit', () => {
  it('never runs more than the limit at once and keeps the order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], STAT_CONCURRENCY, async (ms) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return ms * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(STAT_CONCURRENCY);
    expect(await mapLimit([], 2, async () => 1)).toEqual([]);
  });
});
