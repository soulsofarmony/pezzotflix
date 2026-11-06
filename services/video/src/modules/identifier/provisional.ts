// Provisional items (doc 02 §3.5): while no provider answers, a file is shown under the title of its name.
// The identifier links it to a provisional stand-in made through CatalogWritePort, records in the file's
// case which provisional works it stood in for (parsed.provisionalWorks), and retires them once their
// files left. A file that leaves items takes the state recorded on it along (moveFileState); a retired
// item passes what was recorded on itself (moveItemState: a hand-set mark, the watchlist) to the item
// that took its place, which library.item_removed names as replacedBy; the catalog removes what is empty.
// Synchronous: every call joins the caller's open transaction.
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.ts';
import type { CatalogItemRef, CatalogWritePort, ProfileStatePort } from '../../shared/ports.ts';

/** Key of the case's parsed JSON listing the provisional works the file stood in for. */
export const PROVISIONAL_WORKS = 'provisionalWorks';

export interface ProvisionalDeps {
  db: Db;
  now: () => number;
  catalog: () => CatalogWritePort;
  /** Null while no module provides it: the state then goes with the retired item. */
  profiles: () => ProfileStatePort | null;
  log: FastifyBaseLogger;
}

/** The provisional works recorded in a case's parsed JSON, plus `add`. */
export function recordedWorks(parsed: unknown, add: string | null): string[] {
  const prev = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[PROVISIONAL_WORKS] : null;
  const list = Array.isArray(prev) ? prev.filter((x): x is string => typeof x === 'string') : [];
  return add && !list.includes(add) ? [...list, add] : list;
}

/**
 * How the state of a file that left `from` for `to` follows it: everything to the one item of `to`, or
 * episode by episode when both sides are episodes whose numbers pair one to one (a multi-episode file);
 * null when neither holds. Pure.
 */
export function pairItems(from: readonly CatalogItemRef[], to: readonly CatalogItemRef[]): Map<string, string> | null {
  const [only] = to;
  if (to.length === 1 && only) return new Map(from.map((f) => [f.id, only.id]));
  if (!from.length || from.length !== to.length) return null;
  const byNumber = (list: readonly CatalogItemRef[]) => {
    const m = new Map<number, string>();
    for (const i of list) {
      if (i.kind !== 'episode' || i.episodeNumber === null || m.has(i.episodeNumber)) return null;
      m.set(i.episodeNumber, i.id);
    }
    return m;
  };
  const a = byNumber(from);
  const b = byNumber(to);
  if (!a || !b) return null;
  const out = new Map<string, string>();
  for (const [n, id] of a) {
    const target = b.get(n);
    if (!target) return null;
    out.set(id, target);
  }
  return out;
}

/** Case states of a file still waiting for its identification. */
const OPEN_CASE: ReadonlySet<string> = new Set(['pending', 'needs_review']);

interface CaseRow {
  state: string;
  reason: string | null;
  parsed: string | null;
  candidates: string | null;
}

const parseJson = (v: string | null): unknown => {
  try {
    return v ? (JSON.parse(v) as unknown) : null;
  } catch {
    return null;
  }
};

export function createProvisional({ db, now, catalog, profiles, log }: ProvisionalDeps) {
  const tx = <T>(fn: () => T): T => db.$client.transaction(fn)();
  const prep = db.$client.prepare.bind(db.$client);
  const recordedFiles = prep(`SELECT DISTINCT c.file_id FROM identification_case c, json_each(c.parsed, '$.${PROVISIONAL_WORKS}') j WHERE j.value = ?`).pluck();
  const linkedItems = prep('SELECT DISTINCT item_id FROM media_link WHERE file_id = ?').pluck();
  const linksOf = prep('SELECT item_id AS itemId, origin FROM media_link WHERE file_id = ?');
  const caseOf = prep('SELECT state, reason, parsed, candidates FROM identification_case WHERE file_id = ?');
  const fileStateOf = prep('SELECT state FROM media_file WHERE id = ?').pluck();
  const moveLinks = prep('UPDATE media_link SET file_id = ? WHERE file_id = ?');
  const dropLinks = prep('DELETE FROM media_link WHERE file_id = ?');
  const rewriteCase = prep('UPDATE identification_case SET state = ?, reason = ?, parsed = ?, candidates = ?, updated_at = ? WHERE file_id = ?');
  const moveCase = prep('UPDATE identification_case SET file_id = ?, parsed = ?, updated_at = ? WHERE file_id = ?');

  const isProvisional = (itemId: string): boolean => catalog().getItem(itemId)?.provisional === true;

  /**
   * The one work the files recorded under this provisional work are linked to now, or null. Files with no
   * link (ignored, removed) do not count; files that went apart leave no successor. A series counts the
   * series above its files' items, and a file linked to something outside any series leaves none. A movie
   * counts only the movies its files went to themselves: an extra of another movie is not that movie.
   */
  function successor(work: CatalogItemRef, leaving: ReadonlySet<string>): string | null {
    const cat = catalog();
    const files = recordedFiles.all(work.id) as string[];
    const targets = new Set<string>();
    for (const fileId of files) {
      for (const itemId of linkedItems.all(fileId) as string[]) {
        if (work.kind === 'movie' && cat.getItem(itemId)?.kind !== 'movie') continue;
        const w = work.kind === 'movie' ? itemId : cat.findAncestor(itemId, work.kind);
        if (!w || leaving.has(w)) return null;
        targets.add(w);
      }
    }
    return targets.size === 1 ? ([...targets][0] ?? null) : null;
  }

  /**
   * The item that takes the place of each provisional item about to go:
   * - a series: its successor (every linked file it stood in for went to that one series);
   * - a movie: its successor, else the item its last file went to itself (`moves`: an extra stays the
   *   extra, never its movie);
   * - an episode: the episode its last file went to;
   * - a season: the season of its episodes' replacements, when they agree.
   */
  function replacements(leaving: readonly string[], moves: ReadonlyMap<string, string>): Map<string, string> {
    const cat = catalog();
    const set = new Set(leaving);
    const out = new Map<string, string>();
    // Per provisional season, the seasons its leaving episodes went to ('' for none).
    const seasons = new Map<string, Set<string>>();
    // Leaves first: episodes before their season, seasons before their series.
    for (const id of leaving) {
      const ref = cat.getItem(id);
      if (!ref) continue;
      const moved = moves.get(id);
      let rep: string | null = null;
      if (ref.parentId === null && ref.kind === 'series') rep = successor(ref, set);
      else if (ref.parentId === null && ref.kind === 'movie') rep = successor(ref, set) ?? moved ?? null;
      else if (ref.kind === 'season') rep = seasons.get(id)?.size === 1 ? [...seasons.get(id)!][0] || null : null;
      else if (moved) rep = cat.findAncestor(moved, ref.kind);
      if (rep && !set.has(rep)) out.set(id, rep);
      if (ref.kind === 'episode' && ref.parentId) {
        const s = seasons.get(ref.parentId) ?? new Set<string>();
        s.add((rep && cat.findAncestor(rep, 'season')) || '');
        seasons.set(ref.parentId, s);
      }
    }
    return out;
  }

  /**
   * The provisional items of itemIds left with no link and no child go, with their emptied provisional
   * parents. What was recorded on each of them moves to its replacement first. `moves`: where the file
   * that left them went, item by item.
   */
  function retire(itemIds: readonly string[], moves: ReadonlyMap<string, string> = new Map()): string[] {
    if (!itemIds.length) return [];
    return tx(() => {
      const cat = catalog();
      const leaving = cat.provisionalToRetire(itemIds);
      if (!leaving.length) return [];
      const reps = replacements(leaving, moves);
      for (const [id, to] of reps) profiles()?.moveItemState?.(id, to);
      return cat.retireProvisional(itemIds, reps);
    });
  }

  /**
   * CaseSettlementPort.fileLeft: the file left `from` for `to`. Its state follows (pairItems; a multi-episode
   * file whose episodes do not pair keeps it where it was), then the emptied provisional items retire.
   */
  function fileLeft(fileId: string, from: readonly string[], to: readonly string[]): string[] {
    const left = [...new Set(from)].filter((id) => !to.includes(id));
    if (!left.length) return [];
    return tx(() => {
      const cat = catalog();
      const refs = (ids: readonly string[]) => ids.map((id) => cat.getItem(id)).filter((r): r is CatalogItemRef => r !== null);
      const pairs = to.length ? pairItems(refs(left), refs([...new Set(to)])) : null;
      if (pairs) {
        // One call per target: moveFileState merges everything it is given into one item.
        const byTarget = new Map<string, string[]>();
        for (const [a, b] of pairs) byTarget.set(b, [...(byTarget.get(b) ?? []), a]);
        for (const [b, list] of byTarget) profiles()?.moveFileState?.(fileId, list, b);
      } else if (to.length) {
        log.info({ fileId, from: left, to }, 'watch state of the file not moved: its items do not pair with the new ones');
      }
      return retire(left, pairs ?? new Map());
    });
  }

  /**
   * CaseSettlementPort.undecided: no link, or only stand-ins (auto links to provisional items) with the case
   * still open.
   */
  function undecided(fileId: string): boolean {
    const links = linksOf.all(fileId) as { itemId: string; origin: string }[];
    if (!links.length) return true;
    const state = (caseOf.get(fileId) as CaseRow | undefined)?.state;
    return state !== undefined && OPEN_CASE.has(state) && links.every((l) => l.origin === 'auto' && isProvisional(l.itemId));
  }

  /**
   * The copy's case takes the place of intoId's (an open one, about the old name, or none): the copy's
   * state, reason, candidates and parse of the path intoId now has, and the provisional works both stood
   * in for.
   */
  function carryCase(copyId: string, intoId: string, intoCase: CaseRow | undefined): void {
    const copyCase = caseOf.get(copyId) as CaseRow | undefined;
    if (!copyCase) return;
    const works = [...new Set([...recordedWorks(parseJson(intoCase?.parsed ?? null), null), ...recordedWorks(parseJson(copyCase.parsed), null)])];
    const base = parseJson(copyCase.parsed);
    const parsed = JSON.stringify({ ...(base && typeof base === 'object' ? base : {}), [PROVISIONAL_WORKS]: works });
    if (intoCase) rewriteCase.run(copyCase.state, copyCase.reason, parsed, copyCase.candidates, now(), intoId);
    else moveCase.run(intoId, parsed, now(), copyId);
  }

  /** CaseSettlementPort.copyMerged: see the port. */
  function copyMerged(copyId: string, intoId: string): string[] {
    return tx(() => {
      const shown = [...new Set((linksOf.all(copyId) as { itemId: string }[]).map((l) => l.itemId))];
      let retired: string[] = [];
      if (shown.length) {
        const into = [...new Set((linksOf.all(intoId) as { itemId: string }[]).map((l) => l.itemId))];
        const intoCase = caseOf.get(intoId) as CaseRow | undefined;
        const open = intoCase ? OPEN_CASE.has(intoCase.state) : fileStateOf.get(intoId) !== 'ignored';
        if (!into.length && open) {
          // Nothing decided on intoId: it stays shown where the copy was, until the identifier settles it.
          moveLinks.run(intoId, copyId);
          carryCase(copyId, intoId, intoCase);
          log.info({ copyId, intoId, items: shown }, 'merged copy: its provisional items stay with the row that takes it over');
        } else {
          dropLinks.run(copyId);
          retired = fileLeft(copyId, shown, into);
        }
      }
      profiles()?.replaceFileId?.(copyId, intoId);
      return retired;
    });
  }

  /**
   * A safety net: provisional items that lost their last link and child without fileLeft (a link or a
   * media_file row deleted outside these paths, e.g. by hand) are retired, with no replacement.
   */
  function sweep(): string[] {
    return retire(catalog().provisionalOrphans());
  }

  return { isProvisional, fileLeft, retire, sweep, undecided, copyMerged };
}

export type Provisional = ReturnType<typeof createProvisional>;
