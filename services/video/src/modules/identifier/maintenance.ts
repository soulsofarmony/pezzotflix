// Maintenance of identification_case data (ADR 0007 point 5): candidates taken from TMDB (titles,
// years, vote counts) are TMDB Content, so expiry and purge remove them. The case stays, with its
// state, reason and the candidates of the other providers.
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import type { Db } from '../../db/index.ts';
import { identificationCase } from '../../db/schema/index.ts';
import type { MetadataProviderName } from '../../shared/metadata.ts';

/**
 * At startup: identify jobs of pending cases that wait for a later run_at (no provider, provider
 * down) are due now, so a provider configured by the restart is used at once (ADR 0007 point 9).
 * Same files as requeuePending: pending cases of analyzed files.
 * Returns how many jobs were moved.
 */
export function pullForwardPending(db: Db, now: number): number {
  return db.$client
    .prepare(
      `UPDATE job SET run_at = @now, updated_at = @now
       WHERE type = 'identifier.identify' AND state = 'queued' AND run_at > @now
         AND idempotency_key IN (SELECT 'identify:' || c.file_id FROM identification_case c JOIN media_file f ON f.id = c.file_id
                                 WHERE c.state = 'pending' AND f.state = 'analyzed')`,
    )
    .run({ now }).changes;
}

export function dropProviderCandidates(db: Db, provider: MetadataProviderName, updatedBefore: number | null): number {
  return db.$client.transaction(() => {
    const where = updatedBefore === null ? isNotNull(identificationCase.candidates) : and(isNotNull(identificationCase.candidates), lt(identificationCase.updatedAt, updatedBefore));
    const rows = db.select({ id: identificationCase.id, candidates: identificationCase.candidates }).from(identificationCase).where(where).all();
    let changed = 0;
    for (const r of rows) {
      if (!Array.isArray(r.candidates)) continue;
      const kept = r.candidates.filter((c) => (c as { provider?: unknown; ref?: { provider?: unknown } }).provider !== provider && (c as { ref?: { provider?: unknown } }).ref?.provider !== provider);
      if (kept.length === r.candidates.length) continue;
      // updated_at is left alone: dropping data is not a new identification.
      db.update(identificationCase).set({ candidates: kept }).where(eq(identificationCase.id, r.id)).run();
      changed++;
    }
    return changed;
  })();
}
