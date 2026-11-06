// Identifier (doc 02 §3.3): the identifier.identify job. Parses the path (library standard), runs the
// resolver chain, then in one transaction writes the IdentificationCase, the MediaLinks (origin=auto)
// and the catalog items through CatalogWritePort. Owns media_link (auto) and identification_case.
// Idempotent: a linked file, an owner decision (ignored/resolved) and a manual link are never
// touched; a renamed file in review is identified again and its case updated, not duplicated.
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { JobContext } from '../../app/module.ts';
import type { Db } from '../../db/index.ts';
import { type CASE_STATES, type FILE_STATES, identificationCase, libraryRoot, mediaFile, mediaLink } from '../../db/schema/index.ts';
import { newId } from '../../shared/ids.ts';
import { type IdentifierIdentifyPayload, JOB_TYPES } from '../../shared/job-types.ts';
import type { MediaFacts } from '../../shared/media-facts.ts';
import type { CandidateRef, ExternalIds, MetadataCandidate, WorkKind } from '../../shared/metadata.ts';
import type {
  CatalogWritePort,
  EventPublisher,
  ExtraType,
  ItemFieldValues,
  JobQueuePort,
  MetadataSearchPort,
  SourcedFieldValues,
  WorkInput,
} from '../../shared/ports.ts';
import type { KindMode, ScoredCandidate } from './matcher.ts';
import { normalizeTitle } from './normalize.ts';
import { type ParsedPath, parsePath, type RootHint } from './parser.ts';
import { type CaseReason, DEFAULT_RESOLVERS, type Evidence, NO_PROVIDER_RETRY_MS, type Resolver, runChain, type WorkQuery } from './resolvers.ts';

export const IdentifyPayload: z.ZodType<IdentifierIdentifyPayload> = z.object({ fileId: z.string().min(1) });

type FileState = (typeof FILE_STATES)[number];
type CaseState = (typeof CASE_STATES)[number];
type StoredReason = CaseReason | 'no_title' | 'multi_part' | 'disc_structure';

/** Thrown to retry later: the job runner reschedules it through job.run_at (ADR 0002). */
export class RetryLaterError extends Error {
  /** Delay asked by the provider (Retry-After) or by the identifier; null = the runner's backoff. */
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'RetryLaterError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** A candidate as stored in identification_case.candidates (contract Candidate, plus provenance). */
export interface StoredCandidate {
  ref: CandidateRef;
  /** Provider the data comes from: expiry and purge drop the TMDB ones (ADR 0007 point 5). */
  provider: CandidateRef['provider'];
  kind: WorkKind;
  title: string;
  originalTitle: string | null;
  year: number | null;
  score: number;
  voteCount: number | null;
  externalIds: ExternalIds;
  evidence: { title: number; year: number; kind: number };
}

/** Candidates kept in a case: enough for the review queue. */
export const STORED_CANDIDATES = 10;

/**
 * Attempts for real failures. A RetryLaterError with retryAfterMs (provider Retry-After, no provider
 * registered yet, file changed meanwhile) is deferred by the job runner and does not count.
 */
export const IDENTIFY_MAX_ATTEMPTS = 30;

/** Delay of the re-run when the file was renamed or re-analysed while the providers answered. */
const CHANGED_RETRY_MS = 1;

export const displayTitle = (c: MetadataCandidate): string => c.titles.localized ?? c.titles.english ?? c.titles.original[0] ?? c.ref.id;

const toStored = (s: ScoredCandidate): StoredCandidate => ({
  ref: s.candidate.ref,
  provider: s.candidate.ref.provider,
  kind: s.candidate.ref.kind,
  title: displayTitle(s.candidate),
  originalTitle: s.candidate.titles.original[0] ?? null,
  year: s.candidate.years[0] ?? null,
  score: s.score,
  voteCount: s.candidate.voteCount,
  externalIds: s.candidate.externalIds,
  evidence: s.signals,
});

/** The values that are there (no null, no undefined). */
function present(values: { [K in keyof ItemFieldValues]?: ItemFieldValues[K] | undefined }): ItemFieldValues {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));
}

/** Where a work comes from: an item already in the catalog, or a match to find or create. */
type WorkTarget = { itemId: string } | { input: WorkInput };

type Target =
  | { type: 'movie'; work: WorkTarget }
  | { type: 'episodes'; series: WorkTarget; season: number; episodes: number[]; episodeTitle: string | null }
  | { type: 'extra'; parent: { work: WorkTarget; season: number | null } | null; extraType: ExtraType; title: string; numberIfTaken: boolean };

type Plan =
  | { type: 'link'; target: Target; confidence: number; candidates: StoredCandidate[]; evidence: Evidence }
  | { type: 'review'; reason: StoredReason; candidates: StoredCandidate[]; evidence: Evidence }
  | { type: 'retry'; retryAfterMs: number | null; detail: string };

interface FileRow {
  id: string;
  rootId: string;
  relPath: string;
  state: FileState;
  fingerprint: string | null;
  facts: unknown;
  analyzedAt: number | null;
  hint: RootHint;
}

/** ok: write; changed: the file moved or was re-analysed (identify again); settled: nothing to write. */
type Eligibility = 'ok' | 'changed' | 'settled';

export interface IdentifierDeps {
  db: Db;
  now: () => number;
  log: FastifyBaseLogger;
  events: () => EventPublisher;
  catalog: () => CatalogWritePort;
  /** Null while no module provides the port (metadata arrives in F1a.4): identification waits. */
  metadata: () => MetadataSearchPort | null;
  lang: string;
  resolvers?: readonly Resolver[];
  /** The job's maxAttempts: the last attempt accepts a review decided while a provider was down. */
  maxAttempts?: number;
}

/** The kind filter of the standard §2: structure first, then the hint; mixed roots score kinds softly. */
export function kindModeOf(parsed: ParsedPath, hint: RootHint): KindMode {
  if (hint === 'mixed') return parsed.structural ? 'filter' : 'soft';
  if (parsed.structural || parsed.kind !== 'movie') return 'filter';
  return hint === 'series' ? 'blocked' : 'filter';
}

/** The item folder a parse names for its work: a movie's or episode's workFolder, an extra's owner folder. */
const itemFolderOf = (p: ParsedPath): string | null => (p.kind === 'extra' ? p.extraOf?.folder || null : p.workFolder);

/**
 * A sibling file counts for `self` only if it names the same item folder and the same normalised
 * title: two films of one year in "Che (2008)/" ("Che - L'argentino (2008)", "Che - Guerriglia
 * (2008)") are not versions of each other, and an extra there is the folder's, not one of theirs.
 * Two movies must not have different years either (a folder without a year can hold "Alien (1979)"
 * and "Alien (2019)").
 */
export function sameItemFolder(sibling: ParsedPath, self: ParsedPath, folder: string): boolean {
  if (itemFolderOf(sibling) !== folder || normalizeTitle(sibling.title) !== normalizeTitle(self.title)) return false;
  return !(sibling.kind === 'movie' && self.kind === 'movie' && sibling.year !== null && self.year !== null && sibling.year !== self.year);
}

export function createIdentifier(deps: IdentifierDeps) {
  const { db, now, events, catalog, metadata, lang } = deps;
  const resolvers = deps.resolvers ?? DEFAULT_RESOLVERS;
  const maxAttempts = deps.maxAttempts ?? IDENTIFY_MAX_ATTEMPTS;
  const tx = <T>(fn: () => T): T => db.$client.transaction(fn)();

  const loadFile = (fileId: string): FileRow | undefined =>
    db
      .select({
        id: mediaFile.id,
        rootId: mediaFile.rootId,
        relPath: mediaFile.relPath,
        state: mediaFile.state,
        fingerprint: mediaFile.fingerprint,
        facts: mediaFile.facts,
        analyzedAt: mediaFile.analyzedAt,
        hint: libraryRoot.hint,
      })
      .from(mediaFile)
      .innerJoin(libraryRoot, eq(libraryRoot.id, mediaFile.rootId))
      .where(eq(mediaFile.id, fileId))
      .get();

  const hasLink = (fileId: string): boolean => db.select({ id: mediaLink.id }).from(mediaLink).where(eq(mediaLink.fileId, fileId)).limit(1).get() !== undefined;
  const caseOf = (fileId: string) =>
    db.select({ id: identificationCase.id, state: identificationCase.state, reason: identificationCase.reason }).from(identificationCase).where(eq(identificationCase.fileId, fileId)).get();
  const setState = (fileId: string, state: FileState) =>
    db.update(mediaFile).set({ state, updatedAt: now() }).where(and(eq(mediaFile.id, fileId), ne(mediaFile.state, state))).run();

  function upsertCase(fileId: string, state: CaseState, reason: StoredReason | null, parsed: unknown, candidates: unknown[]): { caseId: string; changed: boolean } {
    const prev = caseOf(fileId);
    const t = now();
    db.insert(identificationCase)
      .values({ id: newId(), fileId, state, reason, parsed, candidates, createdAt: t, updatedAt: t })
      .onConflictDoUpdate({ target: identificationCase.fileId, set: { state, reason, parsed, candidates, updatedAt: t } })
      .run();
    const caseId = caseOf(fileId)?.id ?? '';
    return { caseId, changed: prev?.state !== state || prev.reason !== reason };
  }

  /**
   * Still worth writing a result for: present, analysed, not linked, no owner decision, same name.
   * A rename, a move or a new analysis while the providers answered is 'changed': the library's or
   * analyzer's re-enqueue was a no-op because this job was running, so the job must run again.
   */
  function eligible(file: FileRow): Eligibility {
    const cur = db
      .select({ state: mediaFile.state, relPath: mediaFile.relPath, analyzedAt: mediaFile.analyzedAt })
      .from(mediaFile)
      .where(eq(mediaFile.id, file.id))
      .get();
    if (!cur || cur.state === 'removed' || cur.state === 'ignored') return 'settled';
    if (hasLink(file.id) && !relinkable(file.id)) return 'settled';
    const c = caseOf(file.id);
    if (c?.state === 'ignored' || c?.state === 'resolved') return 'settled';
    if (cur.relPath !== file.relPath || cur.analyzedAt !== file.analyzedAt) return 'changed';
    if (cur.state === 'missing' || cur.state === 'discovered') return 'changed';
    return 'ok';
  }

  function insertLinks(fileId: string, itemIds: readonly string[], confidence: number): void {
    const t = now();
    for (const itemId of new Set(itemIds)) {
      db.insert(mediaLink).values({ id: newId(), fileId, itemId, origin: 'auto', confidence, createdAt: t }).onConflictDoNothing().run();
    }
  }

  const linksOfFile = (fileId: string) => db.select({ itemId: mediaLink.itemId, origin: mediaLink.origin }).from(mediaLink).where(eq(mediaLink.fileId, fileId)).all();
  const stateNow = (fileId: string) => db.select({ state: mediaFile.state }).from(mediaFile).where(eq(mediaFile.id, fileId)).get()?.state;

  /**
   * New content at the same path. A linked file is 'identified', except when the library saw its
   * content change: it put the file back to 'discovered' and the analyzer moved it to 'analyzed'. Its
   * auto links describe the old content: without a manual link, the file is identified again. The
   * links are replaced when the new result is written (replaceAutoLinks), not before: while the
   * providers are down the file stays where it was.
   */
  function relinkable(fileId: string): boolean {
    const links = linksOfFile(fileId);
    return links.length > 0 && links.every((l) => l.origin === 'auto') && stateNow(fileId) === 'analyzed';
  }

  /** Links the file to itemIds; its other auto links go, in the caller's transaction (manual links stay, doc 01 §5.1). */
  function replaceAutoLinks(fileId: string, itemIds: readonly string[], confidence: number, log: FastifyBaseLogger): void {
    const keep = new Set(itemIds);
    const stale = [...new Set(linksOfFile(fileId).filter((l) => l.origin === 'auto' && !keep.has(l.itemId)).map((l) => l.itemId))];
    if (stale.length) {
      db.delete(mediaLink).where(and(eq(mediaLink.fileId, fileId), eq(mediaLink.origin, 'auto'), inArray(mediaLink.itemId, stale))).run();
      for (const itemId of stale) events().publish('library.item_updated', { itemId, fileId, reason: 'media_unlinked' });
      log.info({ fileId, items: stale }, 'content changed: the auto links of the old content replaced');
    }
    insertLinks(fileId, itemIds, confidence);
  }

  /** Decisions that need no parsing nor provider. Returns true when the job is done. */
  function precheck(file: FileRow, log: FastifyBaseLogger): boolean {
    return tx(() => {
      if (hasLink(file.id) && !relinkable(file.id)) {
        // New content under a manual link: the owner's link stays, the auto ones go.
        if (stateNow(file.id) === 'analyzed') replaceAutoLinks(file.id, [], 1, log);
        // Otherwise an existing link (auto or manual) is never replaced automatically (doc 01 §5.1).
        setState(file.id, 'identified');
        return true;
      }
      const c = caseOf(file.id);
      if (c?.state === 'ignored') {
        setState(file.id, 'ignored');
        return true;
      }
      if (c?.state === 'resolved') return true;
      if (c?.reason === 'disc_structure') {
        // The library owns disc cases; they are resolved by Ignore only (standard §7.1).
        setState(file.id, 'needs_review');
        return true;
      }
      if (!file.fingerprint) return false;
      // Copies of the same content share an identity: no provider call.
      // Owner decisions first, then the most recent link: deterministic when twins disagree.
      const twins = db
        .select({ itemId: mediaLink.itemId, fileId: mediaLink.fileId })
        .from(mediaLink)
        .innerJoin(mediaFile, eq(mediaFile.id, mediaLink.fileId))
        .where(and(eq(mediaFile.fingerprint, file.fingerprint), ne(mediaFile.id, file.id)))
        .orderBy(desc(sql`${mediaLink.origin} = 'manual'`), desc(mediaLink.createdAt), asc(mediaLink.fileId))
        .all();
      const first = twins[0];
      if (!first) return false;
      const itemIds = twins.filter((tw) => tw.fileId === first.fileId).map((tw) => tw.itemId);
      replaceAutoLinks(file.id, itemIds, 1, log);
      upsertCase(file.id, 'auto_matched', null, { ...parsePath(file.relPath, file.hint), copyOf: first.fileId }, []);
      setState(file.id, 'identified');
      for (const itemId of new Set(itemIds)) events().publish('library.item_updated', { itemId, fileId: file.id, reason: 'media_linked' });
      log.info({ fileId: file.id, copyOf: first.fileId }, 'identified as a copy of a linked file');
      return true;
    });
  }

  // ---------------------------------------------------------------- planning (async: providers)

  /**
   * One work of this item folder, from the links of the files already identified there. Only files
   * that name the same item folder count (parser workFolder / extraOf.folder): two movies in one
   * collection folder, or a movie with no year next to a remake, never become versions of each other.
   */
  function siblingWork(file: FileRow, parsed: ParsedPath, folder: string, kind: WorkKind, directOnly: boolean): string | null {
    if (!folder) return null;
    const rows = db.$client
      .prepare(
        `SELECT DISTINCT f.rel_path AS relPath, l.item_id AS itemId FROM media_link l JOIN media_file f ON f.id = l.file_id
         WHERE f.root_id = @root AND f.id <> @file AND substr(f.rel_path, 1, length(@prefix)) = @prefix
           AND (@direct = 0 OR instr(substr(f.rel_path, length(@prefix) + 1), '/') = 0)`,
      )
      .all({ root: file.rootId, file: file.id, prefix: `${folder}/`, direct: directOnly ? 1 : 0 }) as { relPath: string; itemId: string }[];
    const works = new Set(
      rows
        .filter((r) => sameItemFolder(parsePath(r.relPath, file.hint), parsed, folder))
        .map((r) => catalog().findAncestor(r.itemId, kind))
        .filter((x): x is string => x !== null),
    );
    return works.size === 1 ? ([...works][0] ?? null) : null;
  }

  function workInput(c: MetadataCandidate, parsed: ParsedPath, facts: MediaFacts | null, withDuration: boolean): WorkInput {
    const t = now();
    const tagIds: ExternalIds = {
      ...(parsed.ids.tmdb ? { tmdb: parsed.ids.tmdb } : {}),
      ...(parsed.ids.imdb ? { imdb: parsed.ids.imdb } : {}),
      ...(parsed.ids.tvdb ? { tvdb: parsed.ids.tvdb } : {}),
    };
    const ownId: ExternalIds = c.ref.provider === 'wikidata' ? { wikidata: c.ref.id } : { tmdb: c.ref.id };
    const category = c.documentary === true ? 'documentary' : c.documentary === false && c.ref.kind === 'movie' ? 'film' : null;
    // Missing values are omitted, never null: null means "delete this source's row" to the catalog.
    const fields: SourcedFieldValues[] = [
      { source: c.ref.provider, fetchedAt: t, values: present({ title: displayTitle(c), originalTitle: c.titles.original[0], year: c.years[0], category }) },
      { source: 'filename', fetchedAt: t, values: present({ title: parsed.title, year: parsed.year }) },
    ];
    if (withDuration && facts?.durationMs) fields.push({ source: 'container', fetchedAt: t, values: { durationMs: facts.durationMs } });
    return { kind: c.ref.kind, editionLabel: c.ref.kind === 'movie' ? parsed.edition : null, externalIds: { ...tagIds, ...c.externalIds, ...ownId }, fields };
  }

  async function resolveWork(
    parsed: ParsedPath,
    hint: RootHint,
    kind: WorkKind,
    facts: MediaFacts | null,
    withDuration: boolean,
    finalAttempt: boolean,
  ): Promise<{ type: 'work'; work: WorkTarget; confidence: number; candidates: StoredCandidate[]; evidence: Evidence } | Exclude<Plan, { type: 'link' }>> {
    const port = metadata();
    if (!port) return { type: 'retry', retryAfterMs: NO_PROVIDER_RETRY_MS, detail: 'no metadata provider registered' };
    const query: WorkQuery = { title: parsed.title, year: parsed.year, ids: parsed.ids, kind, mode: kindModeOf(parsed, hint) };
    const r = await runChain(resolvers, { query, parsed, facts }, { metadata: port, lang, finalAttempt });
    if (r.type === 'retry') return r;
    if (r.type === 'review') return { type: 'review', reason: r.reason, candidates: r.scored.slice(0, STORED_CANDIDATES).map(toStored), evidence: r.evidence };
    const m = r.outcome;
    return {
      type: 'work',
      work: { input: workInput(m.candidate, parsed, facts, withDuration) },
      confidence: m.confidence,
      candidates: m.scored.slice(0, STORED_CANDIDATES).map(toStored),
      evidence: m.evidence,
    };
  }

  /** The movie the other versions in this item folder are linked to, if they agree on one of the same edition. */
  function siblingMovie(file: FileRow, parsed: ParsedPath): string | null {
    if (!parsed.workFolder) return null;
    const itemId = siblingWork(file, parsed, parsed.workFolder, 'movie', true);
    if (!itemId) return null;
    const edition = (label: string | null | undefined) => (label ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
    return edition(catalog().getItem(itemId)?.editionLabel) === edition(parsed.edition) ? itemId : null;
  }

  async function plan(file: FileRow, parsed: ParsedPath, facts: MediaFacts | null, finalAttempt: boolean): Promise<Plan> {
    if (parsed.reason) return { type: 'review', reason: parsed.reason, candidates: [], evidence: { resolver: 'parser' } };
    if (parsed.kind === 'movie') {
      // Versions share the item folder (standard §3.1): a correction made on one carries over to the next.
      const sibling = siblingMovie(file, parsed);
      if (sibling) return { type: 'link', target: { type: 'movie', work: { itemId: sibling } }, confidence: 1, candidates: [], evidence: { resolver: 'sibling' } };
      const w = await resolveWork(parsed, file.hint, 'movie', facts, true, finalAttempt);
      return w.type === 'work' ? { type: 'link', target: { type: 'movie', work: w.work }, confidence: w.confidence, candidates: w.candidates, evidence: w.evidence } : w;
    }
    if (parsed.kind === 'episode') {
      const season = parsed.season ?? 1;
      const episodes = parsed.episodes ?? [];
      const target = (series: WorkTarget): Target => ({ type: 'episodes', series, season, episodes, episodeTitle: parsed.episodeTitle });
      const sibling = parsed.workFolder ? siblingWork(file, parsed, parsed.workFolder, 'series', false) : null;
      if (sibling) return { type: 'link', target: target({ itemId: sibling }), confidence: 1, candidates: [], evidence: { resolver: 'sibling' } };
      const w = await resolveWork(parsed, file.hint, 'series', facts, false, finalAttempt);
      return w.type === 'work' ? { type: 'link', target: target(w.work), confidence: w.confidence, candidates: w.candidates, evidence: w.evidence } : w;
    }
    // Extra (standard §5): attached to the work of its item folder; an orphan without one.
    const extra = { extraType: parsed.extraType ?? 'other', title: parsed.extraTitle ?? 'Extra', numberIfTaken: parsed.extraTitleIsLabel } as const;
    const owner = parsed.extraOf;
    if (!owner) return { type: 'link', target: { type: 'extra', parent: null, ...extra }, confidence: 1, candidates: [], evidence: { resolver: 'parser', rule: 'orphan_extra' } };
    const sibling = siblingWork(file, parsed, owner.folder, owner.kind, owner.kind === 'movie');
    if (sibling) {
      return { type: 'link', target: { type: 'extra', parent: { work: { itemId: sibling }, season: owner.season }, ...extra }, confidence: 1, candidates: [], evidence: { resolver: 'sibling' } };
    }
    const w = await resolveWork(parsed, file.hint, owner.kind, facts, false, finalAttempt);
    if (w.type !== 'work') return w;
    return { type: 'link', target: { type: 'extra', parent: { work: w.work, season: owner.season }, ...extra }, confidence: w.confidence, candidates: w.candidates, evidence: w.evidence };
  }

  // ---------------------------------------------------------------- writing (one transaction each)

  /**
   * Catalog writes of a target; returns the playable items to link. `announced` tells whether the
   * catalog already published an item event for it (added or updated) in this transaction.
   */
  function materialize(fileId: string, target: Target, facts: MediaFacts | null): { itemId: string; announced: boolean }[] {
    const cat = catalog();
    const t = now();
    const work = (w: WorkTarget): { itemId: string; announced: boolean } => {
      if ('itemId' in w) return { itemId: w.itemId, announced: false };
      const existing = cat.findWork(w.input.kind, w.input.externalIds, w.input.editionLabel);
      if (!existing) return { itemId: cat.upsertWork(w.input).itemId, announced: true };
      // Provider values of a known work are the Enricher's to refresh (fetchedAt, TMDB expiry): this
      // version only adds its ids and the values read from the file.
      cat.addExternalIds(existing, w.input.externalIds);
      const fileRows = w.input.fields.filter((f) => f.source === 'filename' || f.source === 'container');
      if (fileRows.length) cat.writeFields(existing, fileRows);
      return { itemId: existing, announced: fileRows.length > 0 };
    };
    /** File-derived fields of a playable item (filename title, container duration): one write, one event. */
    const fileFields = (itemId: string, title: string | null): boolean => {
      const fields: SourcedFieldValues[] = [];
      if (title) fields.push({ source: 'filename', fetchedAt: t, values: { title } });
      if (facts?.durationMs) fields.push({ source: 'container', fetchedAt: t, values: { durationMs: facts.durationMs } });
      if (fields.length) cat.writeFields(itemId, fields);
      return fields.length > 0;
    };
    if (target.type === 'movie') {
      const r = work(target.work);
      // A new or upserted work got its duration through WorkInput already.
      if (!r.announced) r.announced = fileFields(r.itemId, null);
      return [r];
    }
    if (target.type === 'episodes') {
      const series = work(target.series);
      const season = cat.ensureSeason(series.itemId, target.season);
      const eps = target.episodes.map((n) => {
        const e = cat.ensureEpisode(season.itemId, n);
        return { itemId: e.itemId, announced: e.created };
      });
      const only = eps.length === 1 ? eps[0] : undefined;
      if (only && fileFields(only.itemId, target.episodeTitle)) only.announced = true;
      return eps;
    }
    let parentId: string | null = null;
    if (target.parent) {
      const owner = work(target.parent.work);
      parentId = target.parent.season === null ? owner.itemId : cat.ensureSeason(owner.itemId, target.parent.season).itemId;
    }
    // New content of an extra already linked (a re-encode, a fixed header): the same item, not a second one.
    const previous = linksOfFile(fileId)
      .filter((l) => l.origin === 'auto')
      .map((l) => cat.getItem(l.itemId))
      .find((i) => i?.kind === 'extra' && i.parentId === parentId && i.extraType === target.extraType);
    if (previous) return [{ itemId: previous.id, announced: fileFields(previous.id, null) }];
    const extra = cat.createExtra({ parentId, extraType: target.extraType, title: target.title, numberIfTaken: target.numberIfTaken, fetchedAt: t });
    fileFields(extra.itemId, null);
    return [{ itemId: extra.itemId, announced: true }];
  }

  function writeLinked(file: FileRow, parsed: ParsedPath, p: Extract<Plan, { type: 'link' }>, facts: MediaFacts | null, log: FastifyBaseLogger): Eligibility {
    return tx(() => {
      const e = eligible(file);
      if (e !== 'ok') return e;
      const items = materialize(file.id, p.target, facts);
      replaceAutoLinks(file.id, items.map((i) => i.itemId), p.confidence, log);
      upsertCase(file.id, 'auto_matched', null, { ...parsed, evidence: p.evidence }, p.candidates);
      setState(file.id, 'identified');
      // A new file on an existing item (another copy, a sibling episode) is still news for clients.
      for (const i of items) if (!i.announced) events().publish('library.item_updated', { itemId: i.itemId, fileId: file.id, reason: 'media_linked' });
      return 'ok';
    });
  }

  function writeReview(file: FileRow, parsed: ParsedPath, p: Extract<Plan, { type: 'review' }>, log: FastifyBaseLogger): Eligibility {
    return tx(() => {
      const e = eligible(file);
      if (e !== 'ok') return e;
      // New content that matches nothing sure: the old content's auto links go with the review.
      replaceAutoLinks(file.id, [], 0, log);
      const { caseId, changed } = upsertCase(file.id, 'needs_review', p.reason, { ...parsed, evidence: p.evidence }, p.candidates);
      setState(file.id, 'needs_review');
      if (changed) events().publish('identification.needs_review', { caseId, fileId: file.id, reason: p.reason });
      return 'ok';
    });
  }

  /**
   * A provider failed: the case stays pending (never needs_review, ADR 0007 point 4). A file whose
   * content changed keeps its old links meanwhile.
   */
  function writePending(file: FileRow, parsed: ParsedPath, detail: string): Eligibility {
    return tx(() => {
      const e = eligible(file);
      if (e !== 'ok') return e;
      upsertCase(file.id, 'pending', null, { ...parsed, pendingReason: detail }, []);
      setState(file.id, 'analyzed');
      return 'ok';
    });
  }

  async function identify(payload: unknown, ctx: JobContext): Promise<void> {
    const { fileId } = IdentifyPayload.parse(payload);
    const log = ctx.log;
    const file = loadFile(fileId);
    if (!file) return void log.info({ fileId }, 'identify skipped: file no longer known');
    if (file.state === 'missing' || file.state === 'removed') return void log.info({ fileId }, 'identify skipped: file missing');
    // Content changed: the analyzer probes it again and enqueues a new identification.
    if (file.state === 'discovered') return void log.info({ fileId }, 'identify skipped: waiting for analysis');
    if (precheck(file, log)) return;

    const parsed = parsePath(file.relPath, file.hint);
    const facts = (file.facts ?? null) as MediaFacts | null;
    const p = await plan(file, parsed, facts, ctx.attempt >= maxAttempts);
    const changedMeanwhile = () => {
      log.info({ fileId }, 'identify result dropped: the file changed meanwhile, identifying again');
      return new RetryLaterError('file changed meanwhile', CHANGED_RETRY_MS);
    };
    if (p.type === 'retry') {
      if (writePending(file, parsed, p.detail) === 'changed') throw changedMeanwhile();
      throw new RetryLaterError(p.detail, p.retryAfterMs);
    }
    const written = p.type === 'link' ? writeLinked(file, parsed, p, facts, log) : writeReview(file, parsed, p, log);
    if (written === 'changed') throw changedMeanwhile();
    if (written === 'settled') return void log.info({ fileId }, 'identify result dropped: the file was linked, ignored or removed meanwhile');
    log.info({ fileId, outcome: p.type === 'link' ? 'auto_matched' : 'needs_review', reason: p.type === 'review' ? p.reason : undefined, resolver: p.evidence.resolver }, 'file identified');
  }

  return { identify };
}

/** Every day: cases left pending after the job gave up (IDENTIFY_MAX_ATTEMPTS) get a new job. */
export const REQUEUE_PENDING_EVERY_MS = 24 * 3600_000;

/**
 * Re-enqueues identifier.identify for the analysed files whose case is still pending. A queued or
 * running job with the same key is left alone by the queue; a failed one starts again from attempt 0.
 * Returns how many jobs were (re)queued.
 */
export function requeuePending(db: Db, jobs: JobQueuePort): number {
  const files = db
    .select({ fileId: identificationCase.fileId })
    .from(identificationCase)
    .innerJoin(mediaFile, eq(mediaFile.id, identificationCase.fileId))
    .where(and(eq(identificationCase.state, 'pending'), eq(mediaFile.state, 'analyzed')))
    .all();
  let n = 0;
  for (const { fileId } of files) {
    const payload: IdentifierIdentifyPayload = { fileId };
    if (jobs.enqueue({ type: JOB_TYPES.identifierIdentify, payload, idempotencyKey: `identify:${fileId}` })) n++;
  }
  return n;
}
