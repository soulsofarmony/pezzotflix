// Opaque keyset cursors (ADR 0002 point 9, ADR 0004): base64url JSON of the last row's sort key and
// id, tagged with the ordering it belongs to. A cursor of another ordering is a validation error.
import { ProblemError } from '../../app/problem.ts';

export type KeyValue = string | number;

interface Payload {
  o: string;
  k: KeyValue;
  i: string;
}

export function encodeCursor(ordering: string, key: KeyValue, id: string): string {
  const p: Payload = { o: ordering, k: key, i: id };
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, ordering: string): { key: KeyValue; id: string } {
  let p: unknown;
  try {
    p = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ProblemError('VALIDATION_FAILED', 'invalid cursor');
  }
  const ok =
    typeof p === 'object' &&
    p !== null &&
    (p as Payload).o === ordering &&
    (typeof (p as Payload).k === 'string' || typeof (p as Payload).k === 'number') &&
    typeof (p as Payload).i === 'string';
  if (!ok) throw new ProblemError('VALIDATION_FAILED', 'invalid cursor for this listing');
  return { key: (p as Payload).k, id: (p as Payload).i };
}

/** (a.key, a.id) compared to (b.key, b.id), the order SQLite row values use. */
export function compareKeys(a: { key: KeyValue; id: string }, b: { key: KeyValue; id: string }): number {
  if (a.key !== b.key) {
    if (typeof a.key === 'number' && typeof b.key === 'number') return a.key - b.key;
    return String(a.key) < String(b.key) ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
