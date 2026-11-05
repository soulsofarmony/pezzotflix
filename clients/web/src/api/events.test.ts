import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventPoller, type EventPollerDeps, HIDDEN_ACTIVE_INTERVAL_MS, MAX_BACKOFF_MS, PAGE_LIMIT, VISIBLE_INTERVAL_MS } from './events.ts';
import { ApiError } from './problem.ts';
import type { EventPage, RawEvent } from './types.ts';

const raw = (seq: number, type = 'library.item_updated', payload: Record<string, unknown> = { itemId: `i${seq}` }): RawEvent => ({ seq, type, at: seq, payload });
const page = (events: RawEvent[], nextCursor = `e${events.at(-1)?.seq ?? 0}`): EventPage => ({ events, nextCursor });

function setup() {
  let hidden = false;
  let active = false;
  let onVisibility: () => void = () => undefined;
  const list = vi.fn<EventPollerDeps['list']>(() => Promise.resolve(page([], 'e0')));
  const deps: EventPollerDeps = {
    list,
    onEvents: vi.fn(),
    onReset: vi.fn(),
    hasActiveSession: () => active,
    visibility: {
      isHidden: () => hidden,
      subscribe(fn) {
        onVisibility = fn;
        return () => {
          onVisibility = () => undefined;
        };
      },
    },
  };
  const poller = new EventPoller(deps);
  return {
    poller,
    deps,
    list,
    setHidden(h: boolean) {
      hidden = h;
      onVisibility();
    },
    setActive(a: boolean) {
      active = a;
    },
  };
}

/** Lets a tick finish and fires the 0 ms timer it schedules (the fake clock turns 0 into 1 ms during a tick). */
async function settle() {
  for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('EventPoller (doc 05 §7.7)', () => {
  it('first call without a cursor dispatches nothing, then polls every 5 s with the cursor', async () => {
    const { poller, list, deps } = setup();
    list.mockResolvedValueOnce(page([raw(1)], 'e1')).mockResolvedValueOnce(page([raw(2)], 'e2'));
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenNthCalledWith(1, undefined, PAGE_LIMIT);
    expect(deps.onEvents).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(VISIBLE_INTERVAL_MS - 1);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenNthCalledWith(2, 'e1', PAGE_LIMIT);
    expect(deps.onEvents).toHaveBeenCalledWith([{ seq: 2, at: 2, type: 'library.item_updated', itemId: 'i2' }]);
    poller.stop();
  });

  it('hidden page: paused without a session, every 15 s with one; visible again polls at once', async () => {
    const t = setup();
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    t.setHidden(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.list).toHaveBeenCalledTimes(1);

    t.setActive(true);
    t.poller.refresh();
    await vi.advanceTimersByTimeAsync(HIDDEN_ACTIVE_INTERVAL_MS - 1);
    expect(t.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.list).toHaveBeenCalledTimes(2);

    t.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.list).toHaveBeenCalledTimes(3);
    t.poller.stop();
  });

  it('drains a full page at once', async () => {
    const { poller, list, deps } = setup();
    const full = Array.from({ length: PAGE_LIMIT }, (_, i) => raw(i + 1));
    list
      .mockResolvedValueOnce(page([], 'e0'))
      .mockResolvedValueOnce(page(full, 'e100'))
      .mockResolvedValueOnce(page([raw(101)], 'e101'));
    poller.start();
    await vi.advanceTimersByTimeAsync(VISIBLE_INTERVAL_MS);
    await settle();
    expect(list).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenNthCalledWith(3, 'e100', PAGE_LIMIT);
    expect(deps.onEvents).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('backs off after errors, doubling up to 60 s, and resets on success', async () => {
    const { poller, list } = setup();
    list.mockRejectedValue(new ApiError({ status: 0, code: 'NETWORK' }));
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.nextDelay()).toBe(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poller.nextDelay()).toBe(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(poller.nextDelay()).toBe(MAX_BACKOFF_MS);
    list.mockResolvedValue(page([], 'e5'));
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    expect(poller.nextDelay()).toBe(VISIBLE_INTERVAL_MS);
    poller.stop();
  });

  it('410 CURSOR_EXPIRED: reset and restart without a cursor', async () => {
    const { poller, list, deps } = setup();
    list
      .mockResolvedValueOnce(page([], 'e10'))
      .mockRejectedValueOnce(new ApiError({ status: 410, code: 'CURSOR_EXPIRED' }))
      .mockResolvedValueOnce(page([], 'e50'));
    poller.start();
    await vi.advanceTimersByTimeAsync(VISIBLE_INTERVAL_MS);
    await settle();
    expect(deps.onReset).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenNthCalledWith(3, undefined, PAGE_LIMIT);
    poller.stop();
  });

  it('stop cancels the timer', async () => {
    const { poller, list } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
