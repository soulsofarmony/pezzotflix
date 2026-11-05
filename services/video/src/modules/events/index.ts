// Domain events for client polling (doc 03 §7, ADR 0004): append-only table, cursor = seq.
import { and, asc, gt, lt } from 'drizzle-orm';
import type { Ok } from '../../app/http.ts';
import { typed } from '../../app/http.ts';
import type { ModuleFactory } from '../../app/module.ts';
import { ProblemError } from '../../app/problem.ts';
import { domainEvent } from '../../db/schema/index.ts';

const RETENTION_MS = 7 * 24 * 3600 * 1000;

export const createEventsModule: ModuleFactory = ({ db, now }) => {
  const publish = (type: string, payload: Record<string, unknown>): void => {
    db.insert(domainEvent).values({ type, payload, createdAt: now() }).run();
  };

  const encode = (seq: number) => `e${seq}`;
  const decode = (cursor: string): number => {
    const m = /^e(\d+)$/.exec(cursor);
    if (!m) throw new ProblemError('VALIDATION_FAILED', 'invalid cursor');
    return Number(m[1]);
  };

  return {
    name: 'events',
    provides: { events: { publish } },
    handlers: {
      listEvents: async (req): Promise<Ok<'listEvents'>> => {
        const { query } = typed<'listEvents'>(req);
        const limit = query.limit ?? 50;
        if (!query.cursor) {
          const last = db.$client.prepare('SELECT max(seq) AS s FROM domain_event').get() as { s: number | null };
          return { events: [], nextCursor: encode(last.s ?? 0) };
        }
        const after = decode(query.cursor);
        const oldest = db.$client.prepare('SELECT min(seq) AS s FROM domain_event').get() as { s: number | null };
        if (after > 0 && oldest.s !== null && after < oldest.s - 1) throw new ProblemError('CURSOR_EXPIRED');
        const rows = db.select().from(domainEvent).where(gt(domainEvent.seq, after)).orderBy(asc(domainEvent.seq)).limit(limit).all();
        const next = rows.length ? rows[rows.length - 1]!.seq : after;
        return {
          events: rows.map((r) => ({ seq: r.seq, type: r.type, at: r.createdAt, payload: r.payload as Record<string, unknown> })),
          nextCursor: encode(next),
        };
      },
    },
    periodic: [
      {
        name: 'events.prune',
        everyMs: 6 * 3600 * 1000,
        run: () => {
          db.delete(domainEvent).where(and(lt(domainEvent.createdAt, now() - RETENTION_MS))).run();
        },
      },
    ],
  };
};
