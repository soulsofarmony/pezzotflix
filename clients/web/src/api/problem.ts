// Problem Details errors of the control plane (RFC 9457, ADR 0004 point 8), handled generically by code and status.
import type { ActiveSession, Problem } from './types.ts';

/** Codes of the contract plus two client-side ones: the request never got an HTTP answer, or the answer was not a problem. */
export type ProblemCode = Problem['code'] | 'NETWORK' | 'UNEXPECTED' | (string & {});

export class ApiError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly title: string;
  readonly detail: string | null;
  /** From Retry-After (seconds or HTTP date), in ms; null when absent. */
  readonly retryAfterMs: number | null;
  readonly activeSessions: ActiveSession[];
  /** Problem extension sessionClosed (ChangeTracks/ChangeVersion 422); false when absent. */
  readonly sessionClosed: boolean;
  readonly problem: Partial<Problem> | null;

  constructor(init: { status: number; code: ProblemCode; title?: string; detail?: string | null; retryAfterMs?: number | null; problem?: Partial<Problem> | null }) {
    super(`${init.status} ${init.code}${init.detail ? `: ${init.detail}` : ''}`);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title ?? init.code;
    this.detail = init.detail ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.problem = init.problem ?? null;
    this.activeSessions = Array.isArray(init.problem?.activeSessions) ? init.problem.activeSessions : [];
    this.sessionClosed = init.problem?.sessionClosed === true;
  }

  /** True for errors where repeating the same request later may succeed. */
  get transient(): boolean {
    return this.code === 'NETWORK' || this.status === 503 || this.status === 502 || this.status === 504;
  }
}

export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const s = value.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const DEFAULT_CODE_BY_STATUS: Record<number, ProblemCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  500: 'INTERNAL',
};

/** Builds an ApiError from a failed response and its body, as openapi-fetch returns them. */
export function toApiError(response: Response, body: unknown): ApiError {
  const problem = body && typeof body === 'object' ? (body as Partial<Problem>) : null;
  const code: ProblemCode = typeof problem?.code === 'string' ? problem.code : (DEFAULT_CODE_BY_STATUS[response.status] ?? 'UNEXPECTED');
  return new ApiError({
    status: response.status,
    code,
    title: typeof problem?.title === 'string' ? problem.title : response.statusText || code,
    detail: typeof problem?.detail === 'string' ? problem.detail : null,
    retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')),
    problem,
  });
}

export function networkError(cause: unknown): ApiError {
  const e = new ApiError({ status: 0, code: 'NETWORK', detail: cause instanceof Error ? cause.message : null });
  return e;
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
