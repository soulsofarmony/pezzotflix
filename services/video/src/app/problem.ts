// RFC 9457 Problem Details with a stable machine-readable code (ADR 0004).
import type { components } from '../contract/schema.d.ts';

export type Problem = components['schemas']['Problem'];
export type ProblemCode = Problem['code'];

const TITLES: Record<ProblemCode, string> = {
  VALIDATION_FAILED: 'Request validation failed',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  UNAUTHORIZED: 'Profile token missing or invalid',
  CURSOR_EXPIRED: 'Cursor expired, resync from the start',
  SESSION_LIMIT_REACHED: 'Playback session limit reached',
  MEDIA_UNAVAILABLE: 'Media unavailable',
  NO_COMPATIBLE_PLAN: 'No compatible playback plan',
  SESSION_EXPIRED: 'Playback session expired',
  PROVIDER_UNAVAILABLE: 'Metadata provider unavailable',
  INTERNAL: 'Internal error',
};

const STATUS: Record<ProblemCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  CURSOR_EXPIRED: 410,
  SESSION_LIMIT_REACHED: 409,
  MEDIA_UNAVAILABLE: 503,
  NO_COMPATIBLE_PLAN: 422,
  SESSION_EXPIRED: 410,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly extra: Partial<Problem>;

  constructor(code: ProblemCode, detail?: string, extra: Partial<Problem> = {}, status?: number) {
    super(detail ?? TITLES[code]);
    this.name = 'ProblemError';
    this.code = code;
    this.status = status ?? STATUS[code];
    this.extra = extra;
  }

  toProblem(instance?: string): Problem {
    return {
      type: `https://pezzotflix.local/problems/${this.code.toLowerCase().replaceAll('_', '-')}`,
      title: TITLES[this.code],
      status: this.status,
      code: this.code,
      ...(this.message !== TITLES[this.code] ? { detail: this.message } : {}),
      ...(instance ? { instance } : {}),
      ...this.extra,
    };
  }
}

export const notFound = (what: string): ProblemError => new ProblemError('NOT_FOUND', `${what} not found`);
export const conflict = (detail: string): ProblemError => new ProblemError('CONFLICT', detail);
export const notImplemented = (operationId: string): ProblemError =>
  new ProblemError('INTERNAL', `Operation ${operationId} is not implemented yet`, {}, 501);
