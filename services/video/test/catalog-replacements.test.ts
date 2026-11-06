import { describe, expect, it } from 'vitest';
import { createReplacements } from '../src/modules/catalog/replacements.ts';

describe('replacements of removed items', () => {
  it.each([
    ['nothing recorded', [], ['b'], null],
    ['replaced by an item that exists', [['a', 'b']], ['b'], 'b'],
    ['replaced twice: the first that exists', [['a', 'b'], ['b', 'c']], ['c'], 'c'],
    ['a chain that ends on a removed item', [['a', 'b']], [], null],
    ['a loop leads nowhere', [['a', 'b'], ['b', 'a']], [], null],
  ] as const)('%s', (_name, recorded, existing, expected) => {
    const r = createReplacements();
    for (const [from, to] of recorded) r.record(from, to);
    expect(r.follow('a', (id) => (existing as readonly string[]).includes(id))).toBe(expected);
  });

  it('keeps the latest ones only', () => {
    const r = createReplacements(2);
    r.record('a', 'x');
    r.record('b', 'x');
    r.record('c', 'x');
    expect(['a', 'b', 'c'].map((id) => r.follow(id, () => true))).toEqual([null, 'x', 'x']);
  });
});
