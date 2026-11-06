import { describe, expect, it } from 'vitest';
import { ApiError } from './problem.ts';
import { queryRetryDelay, shouldRetryQuery } from './queries.ts';

const err = (status: number, code: string, retryAfterMs: number | null = null) => new ApiError({ status, code, retryAfterMs });

describe('shouldRetryQuery', () => {
  it.each([
    // Transient: for as long as the page shows the query, so it recovers once the service is back.
    ['503 from the gateway, 1st failure', 0, err(503, 'MEDIA_UNAVAILABLE'), true],
    ['503 from the gateway, 10th failure', 10, err(503, 'MEDIA_UNAVAILABLE'), true],
    ['502, 10th failure', 10, err(502, 'UNEXPECTED'), true],
    ['no answer, 10th failure', 10, err(0, 'NETWORK'), true],
    // 4xx: the answer will not change.
    ['404', 0, err(404, 'NOT_FOUND'), false],
    ['400', 0, err(400, 'VALIDATION_FAILED'), false],
    // Other errors: twice.
    ['500, 1st failure', 0, err(500, 'INTERNAL'), true],
    ['500, 2nd failure', 1, err(500, 'INTERNAL'), true],
    ['500, 3rd failure', 2, err(500, 'INTERNAL'), false],
    ['not an ApiError, 3rd failure', 2, new Error('x'), false],
  ])('%s → %s', (_name, failureCount, error, retry) => {
    expect(shouldRetryQuery(failureCount, error)).toBe(retry);
  });
});

describe('queryRetryDelay', () => {
  it.each([
    ['Retry-After 5 s', 0, err(503, 'MEDIA_UNAVAILABLE', 5_000), 5_000],
    ['Retry-After 5 s, later failure: still the server value', 6, err(503, 'MEDIA_UNAVAILABLE', 5_000), 5_000],
    ['Retry-After 0: at least 1 s', 0, err(503, 'MEDIA_UNAVAILABLE', 0), 1_000],
    ['Retry-After 1 h: at most 30 s', 0, err(503, 'MEDIA_UNAVAILABLE', 3_600_000), 30_000],
    ['no Retry-After, 1st failure', 0, err(0, 'NETWORK'), 1_000],
    ['no Retry-After, 3rd failure', 2, err(0, 'NETWORK'), 4_000],
    ['no Retry-After, 10th failure: at most 30 s', 9, err(0, 'NETWORK'), 30_000],
    ['not an ApiError', 1, new Error('x'), 2_000],
  ])('%s → %d ms', (_name, failureCount, error, ms) => {
    expect(queryRetryDelay(failureCount, error)).toBe(ms);
  });
});
