// The owner's decision on an IdentificationCase (doc 02 §5.2): the identifier owns the case, the
// file state it implies and the auto links, so the admin API settles a case through this port.
// Synchronous: a call made inside the caller's transaction joins it.
import type { Db } from '../../db/index.ts';
import type { CaseSettlementPort, EventPublisher } from '../../shared/ports.ts';

export function createCaseSettlement(deps: {
  db: Db;
  now: () => number;
  events: () => EventPublisher;
  /** Files leaving items and merged copies: state follows, emptied provisional items retire (provisional.ts). */
  provisional: Pick<CaseSettlementPort, 'fileLeft' | 'undecided' | 'copyMerged'>;
}): CaseSettlementPort {
  const { db, now } = deps;
  const tx = <T>(fn: () => T): T => db.$client.transaction(fn)();
  const caseRow = db.$client.prepare(
    'SELECT c.file_id AS fileId, f.state AS fileState FROM identification_case c JOIN media_file f ON f.id = c.file_id WHERE c.id = ?',
  );
  const autoLinks = db.$client.prepare("SELECT item_id AS itemId FROM media_link WHERE file_id = ? AND origin = 'auto'");
  const deleteAuto = db.$client.prepare("DELETE FROM media_link WHERE file_id = ? AND origin = 'auto'");
  const setCase = db.$client.prepare('UPDATE identification_case SET state = ?, updated_at = ? WHERE id = ?');
  const setFile = db.$client.prepare('UPDATE media_file SET state = ?, updated_at = ? WHERE id = ? AND state <> ?');

  return {
    settleCase(caseId, decision) {
      return tx(() => {
        const c = caseRow.get(caseId) as { fileId: string; fileState: string } | undefined;
        if (!c) return null;
        const t = now();
        // The owner's decision replaces what the automatic match linked (doc 01 §5.1).
        const removed = (autoLinks.all(c.fileId) as { itemId: string }[]).map((r) => r.itemId);
        deleteAuto.run(c.fileId);
        setCase.run(decision, t, caseId);
        // A missing file keeps its state: the scan revives it from its links and its case.
        if (c.fileState !== 'missing' && c.fileState !== 'removed') {
          const state = decision === 'resolved' ? 'identified' : 'ignored';
          setFile.run(state, t, c.fileId, state);
        }
        for (const itemId of new Set(removed)) deps.events().publish('library.item_updated', { itemId, fileId: c.fileId, reason: 'media_unlinked' });
        return { fileId: c.fileId, removedAutoLinks: [...new Set(removed)] };
      });
    },
    fileLeft: (fileId, from, to) => deps.provisional.fileLeft(fileId, from, to),
    undecided: (fileId) => deps.provisional.undecided(fileId),
    copyMerged: (copyId, intoId) => deps.provisional.copyMerged(copyId, intoId),
  };
}
