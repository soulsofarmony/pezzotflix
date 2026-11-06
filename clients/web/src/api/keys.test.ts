import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { invalidateForEvents, keys } from './keys.ts';
import type { AppEvent } from './types.ts';

function seeded(): QueryClient {
  const qc = new QueryClient();
  for (const k of [keys.item('e9'), keys.item('season1'), keys.children('season1'), keys.nextUp('series1'), keys.home, keys.profiles, keys.admin.ingest]) qc.setQueryData(k, {});
  return qc;
}

const stale = (qc: QueryClient, k: readonly unknown[]) => qc.getQueryState(k)?.isInvalidated;

describe('invalidateForEvents', () => {
  it('a library event makes every item query stale: the season page lists the new episode, the series offers it next', () => {
    const qc = seeded();
    const e: AppEvent = { seq: 1, at: 0, type: 'library.item_added', itemId: 'e9' };
    invalidateForEvents(qc, [e]);
    expect(stale(qc, keys.children('season1'))).toBe(true);
    expect(stale(qc, keys.nextUp('series1'))).toBe(true);
    expect(stale(qc, keys.item('season1'))).toBe(true);
    expect(stale(qc, keys.home)).toBe(true);
    // Not the queries the event says nothing about.
    expect(stale(qc, keys.profiles)).toBe(false);
    expect(stale(qc, keys.admin.ingest)).toBe(false);
  });

  it('a page of events invalidates each family once (a scan sends many at a time)', () => {
    const qc = seeded();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const events: AppEvent[] = Array.from({ length: 50 }, (_, i) => ({ seq: i, at: 0, type: 'library.item_updated', itemId: `i${i}` }));
    events.push({ seq: 50, at: 0, type: 'ingest.progress' }, { seq: 51, at: 0, type: 'ingest.progress' });
    invalidateForEvents(qc, events);
    // home, items, search, item; then ingest, roots, server.
    expect(spy).toHaveBeenCalledTimes(7);
  });

  it('playback events are for the player, not for the cache', () => {
    const qc = seeded();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    invalidateForEvents(qc, [{ seq: 1, at: 0, type: 'playback.session_terminated', sessionId: 's1', reason: 'expired' }]);
    expect(spy).not.toHaveBeenCalled();
  });
});
