// Library scan (doc 02 §3.1, doc 01 §6.1): walk → fingerprint new/changed files → plan → apply.
// - Change detection by size + mtime; the fingerprint tells a content change from a touch.
// - Moves, and copies whose original is then deleted, are recognised by fingerprint: the older row
//   keeps its id, links, cases and state.
// - A file that comes back from 'missing' gets its state back from durable evidence (links, cases).
// - An unreachable root, or one that looks unmounted, goes offline instead of marking files missing.
// - The library owns sidecars: external_subtitle and MediaFacts.sidecars are written with the file row.
// Writes run in short transactions with a yield to the event loop in between (ADR 0001 rule 5,
// ADR 0002 §12). Other jobs may write between batches, so every op re-reads what it decides on.
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.ts';
import {
  externalSubtitle,
  type FILE_STATES,
  identificationCase,
  libraryRoot,
  mediaFile,
  mediaLink,
} from '../../db/schema/index.ts';
import { newId } from '../../shared/ids.ts';
import { type AnalyzerProbePayload, type IdentifierIdentifyPayload, JOB_TYPES } from '../../shared/job-types.ts';
import type { SidecarSubtitleFacts } from '../../shared/media-facts.ts';
import type { CaseSettlementPort, EventPublisher, JobQueuePort } from '../../shared/ports.ts';
import { fingerprintFile } from './fingerprint.ts';
import type { RootRow } from './roots.ts';
import { type DiscKind, discKindOfPath } from './rules.ts';
import { parseSidecar } from './sidecars.ts';
import { absPathOf, type WalkEntry, type WalkResult, walkRoot } from './walk.ts';

export const BATCH_SIZE = 500;
/** Planning yields to the event loop every this many entries. */
const PLAN_YIELD_EVERY = 500;
/** Unmounted-root guard: a root with at least this many present files... */
export const SUSPECT_MIN_PRESENT = 20;
/** ...that would lose more than this share of them in one scan is held offline instead. */
export const SUSPECT_MISSING_SHARE = 0.5;

type FileState = (typeof FILE_STATES)[number];

export interface KnownFile {
  id: string;
  rootId: string;
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
  fingerprint: string | null;
  state: FileState;
  hasFacts: boolean;
  createdAt: number;
}

const isGone = (state: FileState): boolean => state === 'missing' || state === 'removed';
const isDiscFolder = (disc: DiscKind | null): boolean => disc === 'bdmv' || disc === 'video_ts';
/** States set by the pipeline before any decision: a row in one of them may be merged into its original. */
const UNDECIDED: FileState[] = ['discovered', 'analyzed', 'needs_review'];

export interface RootDiff {
  added: WalkEntry[];
  changed: { file: KnownFile; entry: WalkEntry }[];
  unchanged: { file: KnownFile; entry: WalkEntry }[];
  /** Known, present files not seen by this walk (and not below an unreadable folder). */
  gone: KnownFile[];
}

/** Pure diff of a walk against the files known for its root. */
export function diffRoot(known: readonly KnownFile[], walk: WalkResult): RootDiff {
  const byPath = new Map(known.map((f) => [f.relPath, f]));
  const diff: RootDiff = { added: [], changed: [], unchanged: [], gone: [] };
  const seen = new Set<string>();
  for (const entry of walk.entries) {
    seen.add(entry.relPath);
    const file = byPath.get(entry.relPath);
    if (!file) diff.added.push(entry);
    else if (file.sizeBytes !== entry.sizeBytes || file.mtimeMs !== entry.mtimeMs) diff.changed.push({ file, entry });
    else diff.unchanged.push({ file, entry });
  }
  const skipped = new Set(walk.skipped);
  const unreadable = walk.unreadableDirs.map((d) => `${d}/`);
  for (const file of known) {
    if (seen.has(file.relPath) || skipped.has(file.relPath) || isGone(file.state)) continue;
    if (unreadable.some((prefix) => file.relPath.startsWith(prefix))) continue;
    diff.gone.push(file);
  }
  return diff;
}

export type RootWarning = 'empty_walk' | 'mass_missing';

/**
 * Unmounted-root guard. `wouldMiss` counts the files this scan would mark missing, after moves and
 * copies are accounted for. An empty mount point (NAS share not mounted), or one that suddenly
 * lacks most of a large root, is held offline: its files are not marked missing.
 */
export function unmountedWarning(present: number, wouldMiss: number, emptyWalk: boolean): RootWarning | null {
  if (wouldMiss === 0) return null;
  if (emptyWalk) return 'empty_walk';
  if (present >= SUSPECT_MIN_PRESENT && wouldMiss > present * SUSPECT_MISSING_SHARE) return 'mass_missing';
  return null;
}

/** Runs ops in transactions of `size`, yielding to the event loop between them. */
export async function runInBatches(db: Db, ops: readonly (() => void)[], size = BATCH_SIZE): Promise<void> {
  const tx = db.$client.transaction((batch: readonly (() => void)[]) => {
    for (const op of batch) op();
  });
  for (let i = 0; i < ops.length; i += size) {
    if (i > 0) await yieldToLoop();
    tx(ops.slice(i, i + size));
  }
}

export interface RootScanSummary {
  rootId: string;
  name: string;
  status: 'online' | 'offline';
  /** Why a reachable root was held offline. */
  warning: RootWarning | null;
  added: number;
  /** Content changed (new fingerprint or size): probed and identified again. */
  changed: number;
  /** Only the mtime changed: state kept, nothing re-run. */
  touched: number;
  moved: number;
  /** Copy then delete: the original row took the copy's place. */
  merged: number;
  missing: number;
  /** Not marked missing because the root was held offline. */
  heldMissing: number;
  revived: number;
  discCases: number;
  unchanged: number;
  unstable: number;
  /** Size unchanged but the fingerprint could not be read: left as it was, read again next scan. */
  unverified: number;
  unreadableDirs: number;
  symlinks: number;
  unsafe: number;
}

const emptySummary = (root: RootRow, status: 'online' | 'offline'): RootScanSummary => ({
  rootId: root.id,
  name: root.name,
  status,
  warning: null,
  added: 0,
  changed: 0,
  touched: 0,
  moved: 0,
  merged: 0,
  missing: 0,
  heldMissing: 0,
  revived: 0,
  discCases: 0,
  unchanged: 0,
  unstable: 0,
  unverified: 0,
  unreadableDirs: 0,
  symlinks: 0,
  unsafe: 0,
});

interface SidecarRow {
  relPath: string;
  language: string | null;
  forced: boolean;
  sdh: boolean;
  format: string;
}

const sidecarSignature = (rows: readonly SidecarRow[]): string =>
  JSON.stringify(
    [...rows]
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
      .map((r) => [r.relPath, r.language, r.forced, r.sdh, r.format]),
  );

const parseSidecars = (videoRelPath: string, sidecars: readonly string[]): SidecarSubtitleFacts[] =>
  sidecars.map((p) => parseSidecar(videoRelPath, p)).filter((x): x is SidecarSubtitleFacts => x !== null);

interface Plan {
  root: RootRow;
  walk: WalkResult;
  known: KnownFile[];
  diff: RootDiff;
  summary: RootScanSummary;
}

/** A newer row with the same content that a gone row takes over (copy, then delete of the original). */
interface Duplicate {
  id: string;
  rootId: string;
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
  /** Set when the duplicate was walked in this scan. */
  entry: WalkEntry | null;
}

/** A known file whose path now holds other content (fingerprint differs): a swap may move it. */
interface Vacated {
  root: RootRow;
  summary: RootScanSummary;
  file: KnownFile;
  entry: WalkEntry;
  /** Fingerprint of the content now at file.relPath. */
  fingerprint: string;
}

export interface ScannerDeps {
  db: Db;
  now: () => number;
  log: FastifyBaseLogger;
  jobs: () => JobQueuePort;
  events: () => EventPublisher;
  stableAfterMs: number;
  /**
   * The identifier's: whether a copy is undecided (shown only under provisional stand-ins counts too) and
   * what follows a merged copy (doc 02 §3.5); null when absent (an undecided copy is then one with no link).
   */
  settlement?: () => CaseSettlementPort | null;
}

export function createScanner({ db, now, log, jobs, events, stableAfterMs, settlement }: ScannerDeps) {
  const fileColumns = {
    id: mediaFile.id,
    rootId: mediaFile.rootId,
    relPath: mediaFile.relPath,
    sizeBytes: mediaFile.sizeBytes,
    mtimeMs: mediaFile.mtimeMs,
    fingerprint: mediaFile.fingerprint,
    state: mediaFile.state,
    hasFacts: sql<number>`${mediaFile.facts} IS NOT NULL`.mapWith(Boolean),
    createdAt: mediaFile.createdAt,
  };

  const loadKnown = (rootId: string): KnownFile[] =>
    db.select(fileColumns).from(mediaFile).where(eq(mediaFile.rootId, rootId)).all();

  /** Files already missing, by fingerprint, most recently missing first. */
  const loadMissingByFingerprint = (): Map<string, KnownFile[]> => {
    const out = new Map<string, KnownFile[]>();
    const rows = db
      .select(fileColumns)
      .from(mediaFile)
      .where(and(inArray(mediaFile.state, ['missing', 'removed']), sql`${mediaFile.fingerprint} IS NOT NULL`))
      .orderBy(sql`${mediaFile.missingSince} DESC`)
      .all();
    for (const r of rows) if (r.fingerprint) out.set(r.fingerprint, [...(out.get(r.fingerprint) ?? []), r]);
    return out;
  };

  const storedSidecars = (where: ReturnType<typeof eq>): Map<string, SidecarRow[]> => {
    const out = new Map<string, SidecarRow[]>();
    const rows = db
      .select({
        fileId: externalSubtitle.fileId,
        relPath: externalSubtitle.relPath,
        language: externalSubtitle.language,
        forced: externalSubtitle.isForced,
        sdh: externalSubtitle.isSdh,
        format: externalSubtitle.format,
      })
      .from(externalSubtitle)
      .innerJoin(mediaFile, eq(mediaFile.id, externalSubtitle.fileId))
      .where(where)
      .all();
    for (const { fileId, ...r } of rows) out.set(fileId, [...(out.get(fileId) ?? []), r]);
    return out;
  };

  /** Present rows with the same content created after `gone`, with no owner decision on them. */
  const findDuplicates = (gone: KnownFile & { fingerprint: string }) =>
    db
      .select({ id: mediaFile.id, rootId: mediaFile.rootId, relPath: mediaFile.relPath, sizeBytes: mediaFile.sizeBytes, mtimeMs: mediaFile.mtimeMs })
      .from(mediaFile)
      .where(
        and(
          eq(mediaFile.fingerprint, gone.fingerprint),
          ne(mediaFile.id, gone.id),
          inArray(mediaFile.state, UNDECIDED),
          // Same scan counts as "after": either row can then keep the identity.
          gte(mediaFile.createdAt, gone.createdAt),
          sql`NOT EXISTS (SELECT 1 FROM ${identificationCase} WHERE ${identificationCase.fileId} = ${mediaFile.id} AND ${identificationCase.state} = 'ignored')`,
        ),
      )
      .orderBy(mediaFile.createdAt, mediaFile.id)
      .all()
      .filter((d) => undecidedLinks(d.id));

  // ---------------------------------------------------------------- writes (inside an op)

  const enqueueProbe = (fileId: string, mtimeMs: number) => {
    const payload: AnalyzerProbePayload = { fileId };
    jobs().enqueue({ type: JOB_TYPES.analyzerProbe, payload, idempotencyKey: `probe:${fileId}:${mtimeMs}` });
  };

  const enqueueIdentify = (fileId: string) => {
    const payload: IdentifierIdentifyPayload = { fileId };
    jobs().enqueue({ type: JOB_TYPES.identifierIdentify, payload, idempotencyKey: `identify:${fileId}` });
  };

  const currentOf = (fileId: string) =>
    db
      .select({ state: mediaFile.state, hasFacts: sql<number>`${mediaFile.facts} IS NOT NULL`.mapWith(Boolean) })
      .from(mediaFile)
      .where(eq(mediaFile.id, fileId))
      .get();

  const hasLink = (fileId: string): boolean =>
    db.select({ id: mediaLink.id }).from(mediaLink).where(eq(mediaLink.fileId, fileId)).limit(1).get() !== undefined;

  /** The identifier's settlement port, or null without one (tests of the library alone). */
  const settle = (): CaseSettlementPort | null => {
    try {
      return settlement?.() ?? null;
    } catch {
      return null;
    }
  };

  /** No owner decision in the links: none, or only the stand-ins of a file waiting for its identification. */
  const undecidedLinks = (fileId: string): boolean => settle()?.undecided(fileId) ?? !hasLink(fileId);

  const caseStateOf = (fileId: string) =>
    db.select({ state: identificationCase.state }).from(identificationCase).where(eq(identificationCase.fileId, fileId)).get()?.state;

  /** Opens the disc_structure case of a disc file (standard §7.1) and returns the file state it implies. */
  const ensureDiscCase = (fileId: string, disc: DiscKind, t: number, summary: RootScanSummary): FileState => {
    const caseId = newId();
    const inserted = db
      .insert(identificationCase)
      .values({
        id: caseId,
        fileId,
        state: 'needs_review',
        reason: 'disc_structure',
        parsed: { kind: 'disc', disc },
        candidates: [],
        createdAt: t,
        updatedAt: t,
      })
      .onConflictDoNothing({ target: identificationCase.fileId })
      .run();
    if (inserted.changes > 0) {
      summary.discCases++;
      events().publish('identification.needs_review', { caseId, fileId, reason: 'disc_structure' });
      return 'needs_review';
    }
    return caseStateOf(fileId) === 'ignored' ? 'ignored' : 'needs_review';
  };

  const onlyAutoLinks = (fileId: string): boolean => {
    const links = db.select({ origin: mediaLink.origin }).from(mediaLink).where(eq(mediaLink.fileId, fileId)).all();
    return links.length > 0 && links.every((l) => l.origin === 'auto');
  };

  /** State of a file back from 'missing' (doc 01 §6.1): 'missing' overwrote it, the evidence did not. */
  const reviveState = (fileId: string, disc: DiscKind | null, t: number, summary: RootScanSummary): FileState => {
    if (disc) return ensureDiscCase(fileId, disc, t, summary);
    const caseState = caseStateOf(fileId);
    if (hasLink(fileId)) {
      // New content still waiting for its identification (the old auto links are kept until then), or a
      // file shown under a provisional item meanwhile: back to 'analyzed', where the identifier's pending
      // sweep picks it up again.
      const autoOnly = onlyAutoLinks(fileId);
      if (caseState === 'pending' && autoOnly && currentOf(fileId)?.hasFacts === true) return 'analyzed';
      // A file in review keeps only its provisional link (doc 02 §3.5): still in review.
      if (caseState === 'needs_review' && autoOnly) return 'needs_review';
      return 'identified';
    }
    if (caseState === 'ignored') return 'ignored';
    if (caseState === 'needs_review') return 'needs_review';
    return currentOf(fileId)?.hasFacts ? 'analyzed' : 'discovered';
  };

  const writeSidecars = (fileId: string, parsed: readonly SidecarSubtitleFacts[], patchFacts: boolean) => {
    db.delete(externalSubtitle).where(eq(externalSubtitle.fileId, fileId)).run();
    if (parsed.length) {
      db.insert(externalSubtitle)
        .values(parsed.map((x) => ({ id: newId(), fileId, relPath: x.relPath, language: x.language, isForced: x.forced, isSdh: x.sdh, format: x.format })))
        .run();
    }
    if (patchFacts) {
      db.update(mediaFile)
        .set({
          facts: sql`CASE WHEN ${mediaFile.facts} IS NULL THEN NULL
                     ELSE json_set(${mediaFile.facts}, '$.sidecars', json(${JSON.stringify(parsed)})) END`,
        })
        .where(eq(mediaFile.id, fileId))
        .run();
    }
  };

  const locationFacts = (rootName: string, relPath: string) =>
    sql`CASE WHEN ${mediaFile.facts} IS NULL THEN NULL
        ELSE json_set(${mediaFile.facts}, '$.location', json_object('rootName', ${rootName}, 'relPath', ${relPath})) END`;

  /** After a move: missing facts are probed; a file not decided yet is identified again under its new name. */
  const afterRelocation = (fileId: string, mtimeMs: number) => {
    const cur = currentOf(fileId);
    if (!cur) return;
    if (!cur.hasFacts) enqueueProbe(fileId, mtimeMs);
    else if (cur.state === 'analyzed' || cur.state === 'needs_review') enqueueIdentify(fileId);
  };

  // ---------------------------------------------------------------- plan

  async function reconcile(
    walks: { root: RootRow; walk: WalkResult }[],
    unreachable: RootRow[],
    fingerprints: Map<string, string | null>,
  ): Promise<RootScanSummary[]> {
    const t = now();
    const ops: (() => void)[] = [];
    const summaries: RootScanSummary[] = [];
    const rootNames = new Map(db.select({ id: libraryRoot.id, name: libraryRoot.name }).from(libraryRoot).all().map((r) => [r.id, r.name]));
    const fpOf = (rootId: string, relPath: string) => fingerprints.get(`${rootId}\u0000${relPath}`) ?? null;
    // The hold of the guard is kept on the root (listLibraryRoots). The owner confirmation this scan saw
    // is consumed; one recorded while it ran (a newer confirmedAt) is left for the follow-up scan.
    const setStatus = (root: RootRow, status: 'online' | 'offline', hold: { reason: RootWarning; missing: number } | null) =>
      ops.push(() => {
        db.update(libraryRoot)
          .set({
            status,
            ...(status === 'online' ? { lastScanAt: t } : {}),
            holdReason: hold?.reason ?? null,
            heldMissing: hold?.missing ?? null,
          })
          .where(eq(libraryRoot.id, root.id))
          .run();
        if (root.confirmedAt !== null) {
          db.update(libraryRoot)
            .set({ confirmedMissing: null, confirmedAt: null })
            .where(and(eq(libraryRoot.id, root.id), eq(libraryRoot.confirmedAt, root.confirmedAt)))
            .run();
        }
      });

    // Nothing was seen of an unreachable root: its hold and any confirmation stay as they are.
    for (const root of unreachable) {
      ops.push(() => {
        db.update(libraryRoot).set({ status: 'offline' }).where(eq(libraryRoot.id, root.id)).run();
      });
      summaries.push(emptySummary(root, 'offline'));
    }

    const plans: Plan[] = [];
    for (const { root, walk } of walks) {
      const known = loadKnown(root.id);
      const summary = emptySummary(root, 'online');
      summary.unstable = walk.unstable;
      summary.unreadableDirs = walk.unreadableDirs.length;
      summary.symlinks = walk.symlinks.length;
      summary.unsafe = walk.unsafe.length;
      if (walk.symlinks.length) log.debug({ root: root.name, symlinks: walk.symlinks }, 'symbolic links skipped');
      if (walk.unsafe.length) log.warn({ root: root.name, paths: walk.unsafe }, 'names the media path guard rejects: skipped');
      plans.push({ root, walk, known, diff: diffRoot(known, walk), summary });
      summaries.push(summary);
      await yieldToLoop();
    }

    // Moves: a new path with the content of a file gone in this scan (same root first), or of a
    // file already missing (revived). A file back at its own path is revived in place, never claimed.
    const claimed = new Set<string>();
    for (const p of plans) {
      for (const { file } of [...p.diff.changed, ...p.diff.unchanged]) if (isGone(file.state)) claimed.add(file.id);
    }
    const goneByFp = new Map<string, KnownFile[]>();
    for (const p of plans) {
      for (const f of p.diff.gone) if (f.fingerprint) goneByFp.set(f.fingerprint, [...(goneByFp.get(f.fingerprint) ?? []), f]);
    }
    const missingByFp = loadMissingByFingerprint();
    const moves = new Map<WalkEntry, { from: KnownFile; revive: boolean }>();
    let n = 0;
    for (const p of plans) {
      for (const entry of p.diff.added) {
        if (++n % PLAN_YIELD_EVERY === 0) await yieldToLoop();
        const fp = isDiscFolder(entry.disc) ? null : fpOf(p.root.id, entry.relPath);
        if (!fp) continue;
        const candidates = (goneByFp.get(fp) ?? []).filter((f) => !claimed.has(f.id));
        const sameScan = candidates.find((f) => f.rootId === p.root.id) ?? candidates[0];
        const from = sameScan ?? (missingByFp.get(fp) ?? []).find((f) => !claimed.has(f.id));
        if (!from) continue;
        claimed.add(from.id);
        moves.set(entry, { from, revive: !sameScan });
      }
    }

    // Swaps and rotations: a changed path whose new content is the stored content of another changed
    // path of this scan (two mislabelled files renamed into each other's place). The rows move with
    // their content, so links, cases and decisions follow it (doc 01 §6.1). A row moves only into a
    // path whose own row moves too: what is kept are cycles, written in one op.
    const vacated = new Map<string, Vacated>();
    for (const p of plans) {
      for (const { file, entry } of p.diff.changed) {
        if (entry.disc || isGone(file.state) || !file.fingerprint) continue;
        const fp = fpOf(p.root.id, entry.relPath);
        if (fp && fp !== file.fingerprint) vacated.set(file.id, { root: p.root, summary: p.summary, file, entry, fingerprint: fp });
      }
    }
    const vacatedByStoredFp = new Map<string, Vacated[]>();
    for (const v of vacated.values()) vacatedByStoredFp.set(v.file.fingerprint!, [...(vacatedByStoredFp.get(v.file.fingerprint!) ?? []), v]);
    const swapInto = new Map<string, string>(); // file id of the row at a path -> file id of the row moving there
    const swapping = new Set<string>();
    for (const v of vacated.values()) {
      const sources = (vacatedByStoredFp.get(v.fingerprint) ?? []).filter((s) => s.file.id !== v.file.id && !swapping.has(s.file.id));
      const from = sources.find((s) => s.root.id === v.root.id) ?? sources[0];
      if (!from) continue;
      swapInto.set(v.file.id, from.file.id);
      swapping.add(from.file.id);
    }
    for (let pruned = true; pruned; ) {
      pruned = false;
      for (const [at, from] of swapInto) {
        if (swapping.has(at)) continue;
        swapInto.delete(at);
        swapping.delete(from);
        pruned = true;
      }
    }
    if (swapInto.size) {
      const swaps = [...swapInto].map(([at, from]) => ({ to: vacated.get(at)!, row: vacated.get(from)!.file }));
      for (const { to } of swaps) to.summary.moved++;
      ops.push(() => {
        // Every row leaves its path first ((root, path) is unique); a dot folder is never walked.
        for (const { row } of swaps) db.update(mediaFile).set({ relPath: `.pezzotflix-swap/${row.id}` }).where(eq(mediaFile.id, row.id)).run();
        for (const { to, row } of swaps) {
          db.update(mediaFile)
            .set({
              rootId: to.root.id,
              relPath: to.entry.relPath,
              sizeBytes: to.entry.sizeBytes,
              mtimeMs: to.entry.mtimeMs,
              fingerprint: to.fingerprint,
              facts: locationFacts(to.root.name, to.entry.relPath),
              missingSince: null,
              updatedAt: t,
            })
            .where(eq(mediaFile.id, row.id))
            .run();
          writeSidecars(row.id, parseSidecars(to.entry.relPath, to.entry.sidecars), true);
          afterRelocation(row.id, to.entry.mtimeMs);
        }
      });
    }

    // Copy, then delete: a gone row takes over a newer, undecided row with its content (any root).
    const leaving = new Set([...plans.flatMap((p) => p.diff.gone.map((f) => f.id)), ...swapping]);
    const walked = new Map<string, Map<string, WalkEntry>>(plans.map((p) => [p.root.id, new Map(p.walk.entries.map((e) => [e.relPath, e]))]));
    const absorbed = new Set<string>();
    const transfers = new Map<string, Duplicate>();
    for (const p of plans) {
      for (const f of p.diff.gone) {
        if (claimed.has(f.id) || !f.fingerprint) continue;
        if (++n % PLAN_YIELD_EVERY === 0) await yieldToLoop();
        const fingerprint = f.fingerprint;
        const dup = findDuplicates({ ...f, fingerprint })
          .map((d) => ({ ...d, entry: walked.get(d.rootId)?.get(d.relPath) ?? null }))
          // A walked duplicate whose content changed in this scan is not a copy any more.
          .find((d) => !leaving.has(d.id) && !absorbed.has(d.id) && (fpOf(d.rootId, d.relPath) ?? fingerprint) === fingerprint);
        if (!dup) continue;
        claimed.add(f.id);
        absorbed.add(dup.id);
        transfers.set(f.id, dup);
      }
    }

    // Unmounted-root guard, once moves and copies explain what they can.
    for (const p of plans) {
      const present = p.known.filter((f) => !isGone(f.state)).length;
      const wouldMiss = p.diff.gone.filter((f) => !claimed.has(f.id)).length;
      const emptyWalk = p.walk.entries.length === 0 && p.walk.skipped.length === 0;
      p.summary.warning = unmountedWarning(present, wouldMiss, emptyWalk);
      const confirmed = p.root.confirmedMissing;
      if (p.summary.warning && confirmed !== null && wouldMiss <= confirmed) {
        // ConfirmRootContents: the owner said these files are gone. More absent files than confirmed hold the root again.
        log.info({ root: p.root.name, warning: p.summary.warning, wouldMiss, confirmed }, 'owner confirmed the root contents: guard released');
        p.summary.warning = null;
      }
      if (p.summary.warning) {
        p.summary.status = 'offline';
        p.summary.heldMissing = wouldMiss;
        log.warn({ root: p.root.name, warning: p.summary.warning, present, wouldMiss }, 'root looks unmounted: held offline, files not marked missing');
      }
    }

    // ---------------------------------------------------------------- ops
    for (const { root, diff, summary } of plans) {
      const stored = storedSidecars(eq(mediaFile.rootId, root.id));
      /** Sidecars to write for a known file, or null if they did not change. */
      const sidecarChange = (fileId: string, entry: WalkEntry): SidecarSubtitleFacts[] | null => {
        const parsed = parseSidecars(entry.relPath, entry.sidecars);
        return sidecarSignature(parsed) === sidecarSignature(stored.get(fileId) ?? []) ? null : parsed;
      };

      for (const entry of diff.added) {
        const fingerprint = isDiscFolder(entry.disc) ? null : fpOf(root.id, entry.relPath);
        const move = moves.get(entry);
        if (move) {
          const { from, revive } = move;
          summary.moved++;
          ops.push(() => {
            // Links, cases and decisions survive a move (doc 01 §6.1).
            const state = revive ? reviveState(from.id, entry.disc, t, summary) : null;
            db.update(mediaFile)
              .set({
                rootId: root.id,
                relPath: entry.relPath,
                sizeBytes: entry.sizeBytes,
                mtimeMs: entry.mtimeMs,
                fingerprint,
                facts: locationFacts(root.name, entry.relPath),
                missingSince: null,
                updatedAt: t,
                ...(state ? { state } : {}),
              })
              .where(eq(mediaFile.id, from.id))
              .run();
            if (entry.disc) return;
            writeSidecars(from.id, parseSidecars(entry.relPath, entry.sidecars), true);
            afterRelocation(from.id, entry.mtimeMs);
          });
          continue;
        }
        summary.added++;
        ops.push(() => {
          const id = newId();
          db.insert(mediaFile)
            .values({
              id,
              rootId: root.id,
              relPath: entry.relPath,
              sizeBytes: entry.sizeBytes,
              mtimeMs: entry.mtimeMs,
              fingerprint,
              state: entry.disc ? 'needs_review' : 'discovered',
              createdAt: t,
              updatedAt: t,
            })
            .run();
          if (entry.disc) {
            ensureDiscCase(id, entry.disc, t, summary);
            return;
          }
          const parsed = parseSidecars(entry.relPath, entry.sidecars);
          if (parsed.length) writeSidecars(id, parsed, false);
          enqueueProbe(id, entry.mtimeMs);
        });
      }

      for (const { file, entry } of diff.changed) {
        if (absorbed.has(file.id) || swapping.has(file.id)) continue;
        const wasGone = isGone(file.state);
        const disc = entry.disc;
        if (!disc && entry.sizeBytes === file.sizeBytes && file.fingerprint !== null && fpOf(root.id, entry.relPath) === null) {
          // The fingerprint read failed (file busy or locked, a share that hiccuped): a touch or new
          // content, unknown. The row stays as it is; its stored mtime still differs, so the next
          // scan reads the fingerprint again. Resetting it would cost the file its auto links.
          summary.unverified++;
          continue;
        }
        if (wasGone) summary.revived++;
        if (disc) {
          summary.changed++;
          const fingerprint = isDiscFolder(disc) ? null : fpOf(root.id, entry.relPath);
          ops.push(() => {
            const state = wasGone ? ensureDiscCase(file.id, disc, t, summary) : null;
            db.update(mediaFile)
              .set({ sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs, fingerprint, missingSince: null, updatedAt: t, ...(state ? { state } : {}) })
              .where(eq(mediaFile.id, file.id))
              .run();
          });
          continue;
        }
        const fingerprint = fpOf(root.id, entry.relPath);
        const sidecars = sidecarChange(file.id, entry);
        if (entry.sizeBytes === file.sizeBytes && fingerprint !== null && fingerprint === file.fingerprint) {
          // Only the mtime changed (touch, copy without -p, exFAT rounding): same content, same state.
          summary.touched++;
          ops.push(() => {
            const state = wasGone ? reviveState(file.id, null, t, summary) : null;
            db.update(mediaFile)
              .set({
                mtimeMs: entry.mtimeMs,
                facts: sql`CASE WHEN ${mediaFile.facts} IS NULL THEN NULL ELSE json_set(${mediaFile.facts}, '$.mtimeMs', ${entry.mtimeMs}) END`,
                updatedAt: t,
                ...(state ? { state, missingSince: null } : {}),
              })
              .where(eq(mediaFile.id, file.id))
              .run();
            if (sidecars) writeSidecars(file.id, sidecars, true);
            if (!currentOf(file.id)?.hasFacts) enqueueProbe(file.id, entry.mtimeMs);
          });
          continue;
        }
        summary.changed++;
        ops.push(() => {
          // New content at the same path: probed and identified again. Back to 'discovered', then
          // 'analyzed', a linked file tells the identifier that its auto links were made for the old
          // content: it drops them and identifies the file again, keeping manual links (doc 01 §5.1).
          db.update(mediaFile)
            .set({ sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs, fingerprint, state: 'discovered', missingSince: null, updatedAt: t })
            .where(eq(mediaFile.id, file.id))
            .run();
          if (sidecars) writeSidecars(file.id, sidecars, true);
          enqueueProbe(file.id, entry.mtimeMs);
        });
      }

      const wasOffline = root.status === 'offline';
      for (const { file, entry } of diff.unchanged) {
        if (absorbed.has(file.id)) continue;
        const fingerprint = file.fingerprint ?? (isDiscFolder(entry.disc) ? null : fpOf(root.id, entry.relPath));
        const sidecars = entry.disc ? null : sidecarChange(file.id, entry);
        if (isGone(file.state)) {
          summary.revived++;
          ops.push(() => {
            const state = reviveState(file.id, entry.disc, t, summary);
            db.update(mediaFile).set({ state, fingerprint, missingSince: null, updatedAt: t }).where(eq(mediaFile.id, file.id)).run();
            if (entry.disc) return;
            if (sidecars) writeSidecars(file.id, sidecars, true);
            if (!currentOf(file.id)?.hasFacts) enqueueProbe(file.id, entry.mtimeMs);
          });
          continue;
        }
        summary.unchanged++;
        // Probes skipped while the root was offline are queued again; otherwise an unchanged file is
        // never re-probed, so a probe that failed for good stays failed until the file changes.
        const reprobe = wasOffline && file.state === 'discovered';
        if (fingerprint === file.fingerprint && !sidecars && !reprobe) continue;
        ops.push(() => {
          if (fingerprint !== file.fingerprint) db.update(mediaFile).set({ fingerprint }).where(eq(mediaFile.id, file.id)).run();
          if (sidecars) writeSidecars(file.id, sidecars, true);
          if (reprobe) enqueueProbe(file.id, entry.mtimeMs);
        });
      }

      for (const file of diff.gone) {
        const dup = transfers.get(file.id);
        if (dup) {
          summary.merged++;
          ops.push(() => {
            // Re-check: the copy may have been linked or decided since planning.
            const cur = currentOf(dup.id);
            const stillUndecided = cur !== undefined && UNDECIDED.includes(cur.state) && undecidedLinks(dup.id) && caseStateOf(dup.id) !== 'ignored';
            if (!stillUndecided) {
              db.update(mediaFile).set({ state: 'missing', missingSince: t, updatedAt: t }).where(eq(mediaFile.id, file.id)).run();
              return;
            }
            const sidecarPaths = dup.entry?.sidecars ?? (storedSidecars(eq(mediaFile.id, dup.id)).get(dup.id) ?? []).map((s) => s.relPath);
            // A copy shown under a provisional item meanwhile: its stand-ins and case go to the row that takes
            // it over, or its state follows that row's items; what was watched on it names that row (doc 02 §3.5).
            settle()?.copyMerged(dup.id, file.id);
            db.delete(mediaFile).where(eq(mediaFile.id, dup.id)).run(); // streams, sidecars, links, case: cascade
            const mtimeMs = dup.entry?.mtimeMs ?? dup.mtimeMs;
            db.update(mediaFile)
              .set({
                rootId: dup.rootId,
                relPath: dup.relPath,
                sizeBytes: dup.entry?.sizeBytes ?? dup.sizeBytes,
                mtimeMs,
                facts: locationFacts(rootNames.get(dup.rootId) ?? '', dup.relPath),
                updatedAt: t,
              })
              .where(eq(mediaFile.id, file.id))
              .run();
            if (discKindOfPath(dup.relPath)) return; // an .iso: never probed, no sidecars
            writeSidecars(file.id, parseSidecars(dup.relPath, sidecarPaths), true);
            afterRelocation(file.id, mtimeMs);
          });
          continue;
        }
        if (claimed.has(file.id)) continue;
        if (summary.warning) continue;
        summary.missing++;
        ops.push(() => {
          db.update(mediaFile).set({ state: 'missing', missingSince: t, updatedAt: t }).where(eq(mediaFile.id, file.id)).run();
        });
      }
      setStatus(root, summary.status, summary.warning ? { reason: summary.warning, missing: summary.heldMissing } : null);
    }

    await runInBatches(db, ops);
    return summaries;
  }

  /** Scans the given roots. Walks and fingerprints are async; writes happen at the end, in batches. */
  async function scan(roots: readonly RootRow[], signal: AbortSignal): Promise<RootScanSummary[]> {
    const walks: { root: RootRow; walk: WalkResult }[] = [];
    const unreachable: RootRow[] = [];
    for (const root of roots) {
      try {
        walks.push({ root, walk: await walkRoot(root.mountPath, { now: now(), stableAfterMs, signal }) });
      } catch (err) {
        signal.throwIfAborted();
        log.warn({ root: root.name, err: err instanceof Error ? err.message : String(err) }, 'root unreachable');
        unreachable.push(root);
      }
    }

    // Fingerprint only what is new, changed or never fingerprinted (at most 2 MiB read per file).
    const fingerprints = new Map<string, string | null>();
    for (const { root, walk } of walks) {
      const known = new Map(loadKnown(root.id).map((f) => [f.relPath, f]));
      for (const e of walk.entries) {
        if (isDiscFolder(e.disc)) continue;
        const f = known.get(e.relPath);
        if (f && f.fingerprint && f.sizeBytes === e.sizeBytes && f.mtimeMs === e.mtimeMs) continue;
        signal.throwIfAborted();
        let fp: string | null = null;
        try {
          fp = await fingerprintFile(absPathOf(root.mountPath, e.relPath), e.sizeBytes);
        } catch (err) {
          // Without a fingerprint a move of this file is seen as delete + add (ROB-3).
          log.warn({ root: root.name, relPath: e.relPath, err: err instanceof Error ? err.message : String(err) }, 'fingerprint failed');
        }
        fingerprints.set(`${root.id}\u0000${e.relPath}`, fp);
      }
    }
    signal.throwIfAborted();
    return reconcile(walks, unreachable, fingerprints);
  }

  return { scan };
}
