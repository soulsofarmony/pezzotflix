import { describe, expect, it, vi } from 'vitest';
import { createRemovalStore } from './removals.ts';

describe('removal store', () => {
  it.each([
    ['not removed', [], 'a', undefined],
    ['removed, nothing in its place', [['a', null]], 'a', null],
    ['replaced', [['a', 'b']], 'a', 'b'],
    ['replaced twice: the end of the chain', [['a', 'b'], ['b', 'c']], 'a', 'c'],
    ['replaced by an item removed since', [['a', 'b'], ['b', null]], 'a', null],
    ['a loop leads nowhere', [['a', 'b'], ['b', 'a']], 'a', null],
  ] as const)('%s', (_name, removals, itemId, expected) => {
    const store = createRemovalStore();
    for (const [id, by] of removals) store.record(id, by);
    expect(store.resolve(itemId)).toBe(expected);
  });

  it('keeps the latest removals only, and tells its subscribers', () => {
    const store = createRemovalStore(2);
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(onChange);
    store.record('a', null);
    store.record('b', null);
    store.record('c', 'd');
    expect(store.resolve('a')).toBeUndefined();
    expect(store.resolve('b')).toBeNull();
    expect(store.resolve('c')).toBe('d');
    expect(onChange).toHaveBeenCalledTimes(3);
    unsubscribe();
    store.record('e', null);
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
