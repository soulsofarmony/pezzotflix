// The contract harness itself: it must fail bodies the contract does not describe, or the HTTP
// tests that rely on it prove nothing.
import { describe, expect, it } from 'vitest';
import { contractErrors } from './helpers/contract.ts';

const root = { id: 'r1', name: 'Film', mountPath: '/media/Film', hint: 'movies', status: 'online', lastScanAt: null, fileCount: 0, held: null };
const problem = (status: number, code: string) => ({ type: 'about:blank', title: 'x', status, code });

describe('contract harness', () => {
  it('accepts a body the contract describes', () => {
    expect(contractErrors('listLibraryRoots', 200, { roots: [root] })).toEqual([]);
  });

  it('rejects undeclared properties, also nested and in a shared Problem response', () => {
    expect(contractErrors('listLibraryRoots', 200, { roots: [], extra: 1 }).join()).toContain('unevaluated');
    expect(contractErrors('listLibraryRoots', 200, { roots: [{ ...root, secret: 'x' }] }).join()).toContain('unevaluated');
    expect(contractErrors('getIdentificationCase', 404, { ...problem(404, 'NOT_FOUND'), stack: 'at …' }).join()).toContain('unevaluated');
  });

  it('rejects a missing required property and a wrong enum value', () => {
    expect(contractErrors('listLibraryRoots', 200, { roots: [{ ...root, name: undefined }] })).not.toEqual([]);
    expect(contractErrors('listLibraryRoots', 200, { roots: [{ ...root, status: 'sleeping' }] })).not.toEqual([]);
  });

  it('allows an undeclared status only for request validation (400) and the security handler (401)', () => {
    expect(contractErrors('getIdentificationCase', 400, problem(400, 'VALIDATION_FAILED'))).toEqual([]);
    expect(contractErrors('getIdentificationCase', 401, problem(401, 'UNAUTHORIZED'))).toEqual([]);
    expect(contractErrors('getIdentificationCase', 400, problem(400, 'CONFLICT')).join()).toContain('VALIDATION_FAILED');
    expect(contractErrors('getIdentificationCase', 401, problem(401, 'NOT_FOUND')).join()).toContain('UNAUTHORIZED');
    expect(() => contractErrors('getIdentificationCase', 409, problem(409, 'CONFLICT'))).toThrow(/does not declare a 409/);
    expect(() => contractErrors('getIdentificationCase', 500, problem(500, 'INTERNAL'))).toThrow(/does not declare a 500/);
  });

  it('checks a declared 400 against Problem with any code', () => {
    expect(contractErrors('listIdentificationCases', 400, problem(400, 'VALIDATION_FAILED'))).toEqual([]);
    expect(contractErrors('getChildren', 400, problem(400, 'VALIDATION_FAILED'))).toEqual([]);
  });
});
