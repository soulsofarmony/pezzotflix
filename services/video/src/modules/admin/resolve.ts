// ResolveCase and IgnoreCase (doc 03 §6, doc 02 §5.2). A resolution links the file to a catalog item
// with a manual MediaLink. Admin only orchestrates, in one transaction: catalog items through
// CatalogWritePort, manual links through CatalogLinkPort, the case, the file state and the auto links
// through the identifier's CaseSettlementPort. Admin reads the case and file rows. Provider details are not
// fetched here: the catalog write side enqueues the Enricher. Files of the same item folder still
// waiting for a decision are identified again, so extras and sibling episodes follow the owner's choice.
import type { Db } from '../../db/index.ts';
import { ProblemError, notFound } from '../../app/problem.ts';
import { type IdentifierIdentifyPayload, JOB_TYPES } from '../../shared/job-types.ts';
import type { MediaFacts } from '../../shared/media-facts.ts';
import type { ExternalIds, MetadataCandidate, MetadataProviderName, WorkKind } from '../../shared/metadata.ts';
import type {
  ApiSchemas,
  CaseSettlementPort,
  CatalogItemKind,
  CatalogLinkPort,
  CatalogWritePort,
  ItemFieldValues,
  JobQueuePort,
  MetadataSearchPort,
  SourcedFieldValues,
  WorkInput,
} from '../../shared/ports.ts';
import { allowedResolutions, type CaseReason, type ParsedCase, parseCase, type StoredCandidate, storedCandidates } from './cases.ts';

type ResolveRequest = ApiSchemas['ResolveCaseRequest'];

export interface CaseRow {
  id: string;
  fileId: string;
  state: string;
  reason: CaseReason | null;
  parsed: string | null;
  candidates: string | null;
  updatedAt: number;
  rootId: string;
  relPath: string;
  fileState: string;
  facts: string | null;
}

/** A provider work to find or create: from a stored candidate, or looked up by id. */
interface WorkSource {
  provider: MetadataProviderName;
  id: string;
  kind: WorkKind;
  title: string;
  originalTitle: string | null;
  year: number | null;
  externalIds: ExternalIds;
  fetchedAt: number;
}

export interface ResolverDeps {
  db: Db;
  now: () => number;
  catalog: () => CatalogWritePort;
  links: () => CatalogLinkPort;
  cases: () => CaseSettlementPort;
  jobs: () => JobQueuePort;
  metadata: () => MetadataSearchPort | null;
  lang: string;
}

const present = (v: ItemFieldValues): ItemFieldValues =>
  Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined && x !== ''));

const providerFailure = (detail: string) => new ProblemError('PROVIDER_UNAVAILABLE', detail);

export function createResolver(deps: ResolverDeps) {
  const { db, now } = deps;
  const tx = <T>(fn: () => T): T => db.$client.transaction(fn)();

  const loadCase = db.$client.prepare(
    `SELECT c.id, c.file_id AS fileId, c.state, c.reason, c.parsed, c.candidates, c.updated_at AS updatedAt,
       f.root_id AS rootId, f.rel_path AS relPath, f.state AS fileState, f.facts
     FROM identification_case c JOIN media_file f ON f.id = c.file_id WHERE c.id = ?`,
  );
  const waitingSiblings = db.$client.prepare(
    `SELECT f.id FROM media_file f LEFT JOIN identification_case c ON c.file_id = f.id
     WHERE f.root_id = @root AND f.id <> @file AND substr(f.rel_path, 1, length(@prefix)) = @prefix
       AND ((f.state = 'needs_review' AND c.state = 'needs_review' AND c.reason IS NOT 'disc_structure')
         OR (f.state = 'analyzed' AND (c.state IS NULL OR c.state = 'pending')))
     ORDER BY f.rel_path`,
  );

  function requireCase(caseId: string): CaseRow {
    const c = loadCase.get(caseId) as CaseRow | undefined;
    if (!c) throw notFound('Identification case');
    return c;
  }

  // ---------------------------------------------------------------- work sources

  async function lookup(provider: MetadataProviderName, id: string, expected: WorkKind | null): Promise<WorkSource> {
    const port = deps.metadata();
    if (!port) throw providerFailure('no metadata provider is configured');
    const namespaces =
      provider === 'wikidata' ? (['wikidata'] as const) : expected === 'series' ? (['tmdb_tv', 'tmdb_movie'] as const) : (['tmdb_movie', 'tmdb_tv'] as const);
    for (const ns of namespaces) {
      const r = await port.lookupByExternalId(provider, { ns, id, lang: deps.lang });
      if (r.status === 'ok') return fromCandidate(r.value);
      if (r.status !== 'not_found') throw providerFailure(`${provider} lookup failed: ${r.status}`);
    }
    throw notFound('Candidate');
  }

  function fromCandidate(c: MetadataCandidate): WorkSource {
    return {
      provider: c.ref.provider,
      id: c.ref.id,
      kind: c.ref.kind,
      title: c.titles.localized ?? c.titles.english ?? c.titles.original[0] ?? c.ref.id,
      originalTitle: c.titles.original[0] ?? null,
      year: c.years[0] ?? null,
      externalIds: c.externalIds,
      fetchedAt: now(),
    };
  }

  function fromStored(c: StoredCandidate, fetchedAt: number): WorkSource {
    return {
      provider: c.ref.provider,
      id: c.ref.id,
      kind: c.kind,
      title: c.title,
      originalTitle: c.originalTitle ?? null,
      year: c.year ?? null,
      externalIds: (c.externalIds ?? {}),
      fetchedAt,
    };
  }

  // ---------------------------------------------------------------- catalog targets (inside the transaction)

  /** Values read from the file: the container duration of a playable item. */
  function containerFields(itemId: string, facts: MediaFacts | null, title: string | null): void {
    const t = now();
    const fields: SourcedFieldValues[] = [];
    if (title) fields.push({ source: 'filename', fetchedAt: t, values: { title } });
    if (facts?.durationMs) fields.push({ source: 'container', fetchedAt: t, values: { durationMs: facts.durationMs } });
    if (fields.length) deps.catalog().writeFields(itemId, fields);
  }

  /** The playable items a file under this work becomes, from the parsed path (episodes, extras). */
  function underWork(workId: string, kind: CatalogItemKind, parsed: ParsedCase, facts: MediaFacts | null): string[] {
    const cat = deps.catalog();
    if (parsed.kind === 'extra' && (kind === 'movie' || kind === 'series')) {
      const season = parsed.extraOf?.season ?? null;
      const parentId = kind === 'series' && season !== null ? cat.ensureSeason(workId, season).itemId : workId;
      const extra = cat.createExtra({
        parentId,
        extraType: parsed.extraType ?? 'other',
        title: parsed.extraTitle ?? 'Extra',
        numberIfTaken: parsed.extraTitleIsLabel ?? false,
        fetchedAt: now(),
      });
      containerFields(extra.itemId, facts, null);
      return [extra.itemId];
    }
    if (kind === 'movie' || kind === 'episode' || kind === 'extra') {
      containerFields(workId, facts, null);
      return [workId];
    }
    const episodes = parsed.episodes ?? [];
    if (!episodes.length) {
      // The request asks for something this file cannot take: a validation error on the action, not a state conflict.
      const message = `the file name has no episode number: link it to an episode (link_item) instead of a ${kind}`;
      throw new ProblemError('VALIDATION_FAILED', message, { errors: [{ path: 'body/action', message }] });
    }
    const seasonId = kind === 'series' ? cat.ensureSeason(workId, parsed.season ?? 1).itemId : workId;
    const ids = episodes.map((n) => cat.ensureEpisode(seasonId, n).itemId);
    if (ids.length === 1) containerFields(ids[0]!, facts, parsed.episodeTitle ?? null);
    return ids;
  }

  function workFromSource(w: WorkSource, parsed: ParsedCase, facts: MediaFacts | null): string {
    const cat = deps.catalog();
    const ownId: ExternalIds = w.provider === 'wikidata' ? { wikidata: w.id } : { tmdb: w.id };
    const externalIds: ExternalIds = { ...w.externalIds, ...ownId };
    const edition = w.kind === 'movie' ? (parsed.edition ?? null) : null;
    const existing = cat.findWork(w.kind, externalIds, edition);
    if (existing) {
      // Provider values of a known work are the Enricher's to refresh: only the ids are added.
      cat.addExternalIds(existing, externalIds);
      return existing;
    }
    const input: WorkInput = {
      kind: w.kind,
      editionLabel: edition,
      externalIds,
      fields: [
        { source: w.provider, fetchedAt: w.fetchedAt, values: present({ title: w.title, originalTitle: w.originalTitle, year: w.year }) },
        { source: 'filename', fetchedAt: now(), values: present({ title: parsed.title ?? null, year: parsed.year ?? null }) },
        ...(w.kind === 'movie' && facts?.durationMs ? [{ source: 'container' as const, fetchedAt: now(), values: { durationMs: facts.durationMs } }] : []),
      ],
    };
    return cat.upsertWork(input).itemId;
  }

  function manualItem(manual: NonNullable<ResolveRequest['manual']>, parsed: ParsedCase, facts: MediaFacts | null): string[] {
    const cat = deps.catalog();
    const t = now();
    const values = present({ title: manual.title.trim(), year: manual.year ?? null });
    if (manual.kind === 'movie' || manual.kind === 'series') {
      const { itemId } = cat.upsertWork({
        kind: manual.kind,
        editionLabel: manual.kind === 'movie' ? (parsed.edition ?? null) : null,
        externalIds: {},
        fields: [{ source: 'manual', fetchedAt: t, values }],
      });
      return underWork(itemId, manual.kind, parsed, facts);
    }
    if (manual.kind === 'extra') {
      const extra = cat.createExtra({ parentId: null, extraType: parsed.extraType ?? 'other', title: manual.title, numberIfTaken: false, fetchedAt: t });
      cat.writeFields(extra.itemId, [{ source: 'manual', fetchedAt: t, values }]);
      containerFields(extra.itemId, facts, null);
      return [extra.itemId];
    }
    throw new ProblemError('VALIDATION_FAILED', `a manual ${manual.kind} needs its series: link the file to an existing item (link_item)`);
  }

  // ---------------------------------------------------------------- writes

  /**
   * The owner's decision replaces every earlier link of the file, auto or manual (doc 01 §5.1). The
   * watch state recorded on the file follows it (CaseSettlementPort.fileLeft: to exactly one item, or
   * episode by episode), and a provisional item the file leaves is retired if nothing is left on it
   * (doc 02 §3.5).
   */
  function linkManually(c: CaseRow, itemIds: readonly string[]): void {
    const settled = deps.cases().settleCase(c.id, 'resolved');
    const { removed } = deps.links().replaceManualLinks(c.fileId, itemIds);
    deps.cases().fileLeft(c.fileId, [...(settled?.removedAutoLinks ?? []), ...removed], itemIds);
  }

  /** The case must still be what the owner looked at: a provider lookup may have let it change. */
  function requireUnchanged(caseId: string, seen: CaseRow): CaseRow {
    const cur = requireCase(caseId);
    if (cur.fileId !== seen.fileId || cur.state !== seen.state || cur.updatedAt !== seen.updatedAt) {
      throw new ProblemError('CONFLICT', 'the case changed meanwhile: reload it and resolve again');
    }
    return cur;
  }

  /** identifier.identify again for the files of the same item folder still waiting for a decision. */
  function requeueSiblings(c: CaseRow, parsed: ParsedCase): string[] {
    const folder = parsed.workFolder ?? parsed.extraOf?.folder ?? null;
    if (!folder) return [];
    const ids = (waitingSiblings.all({ root: c.rootId, file: c.fileId, prefix: `${folder}/` }) as { id: string }[]).map((r) => r.id);
    for (const fileId of ids) {
      const payload: IdentifierIdentifyPayload = { fileId };
      deps.jobs().enqueue({ type: JOB_TYPES.identifierIdentify, payload, idempotencyKey: `identify:${fileId}` });
    }
    return ids;
  }

  async function resolve(caseId: string, req: ResolveRequest): Promise<{ requeued: string[] }> {
    const c = requireCase(caseId);
    if (!allowedResolutions(c.reason).includes(req.action)) {
      throw new ProblemError('CONFLICT', `${req.action} is not allowed for a ${c.reason ?? 'case without reason'}`);
    }
    const parsed = parseCase(c.parsed ? JSON.parse(c.parsed) : null);
    const facts = c.facts ? (JSON.parse(c.facts) as MediaFacts) : null;

    let source: WorkSource | null = null;
    if (req.action === 'link_candidate') {
      if (!req.candidate) throw new ProblemError('VALIDATION_FAILED', 'link_candidate needs candidate');
      const { provider, id } = req.candidate;
      const stored = storedCandidates(c.candidates ? JSON.parse(c.candidates) : null).find((s) => s.ref.provider === provider && s.ref.id === id);
      // A candidate found with SearchProvider is not stored in the case: it is looked up by id.
      source = stored ? fromStored(stored, c.updatedAt) : await lookup(provider, id, parsed.workKind ?? null);
    } else if (req.action === 'link_item') {
      if (!req.itemId) throw new ProblemError('VALIDATION_FAILED', 'link_item needs itemId');
      if (!deps.catalog().getItem(req.itemId)) throw notFound('Item');
    } else if (!req.manual?.title.trim()) {
      throw new ProblemError('VALIDATION_FAILED', 'create_manual needs manual with a title');
    }

    return tx(() => {
      const cur = requireUnchanged(caseId, c);
      let itemIds: string[];
      if (source) {
        itemIds = underWork(workFromSource(source, parsed, facts), source.kind, parsed, facts);
      } else if (req.action === 'link_item') {
        const item = deps.catalog().getItem(req.itemId!);
        if (!item) throw notFound('Item');
        itemIds = underWork(item.id, item.kind, item.kind === 'movie' ? { ...parsed, kind: 'movie' } : parsed, facts);
      } else {
        itemIds = manualItem(req.manual!, parsed, facts);
      }
      linkManually(cur, itemIds);
      return { requeued: requeueSiblings(cur, parsed) };
    });
  }

  function ignore(caseId: string): void {
    tx(() => {
      const c = requireCase(caseId);
      // An ignored file is not catalogued (doc 01 §5.2): it leaves the items it was linked to, and what
      // profiles recorded on it stays on them. A provisional item it leaves empty is removed; when another
      // file of that item went to an item R meanwhile, what is left on it (this file's history included)
      // moves to R first (fileLeft, moveItemState), else it goes with the item.
      const settled = deps.cases().settleCase(c.id, 'ignored');
      const removed = deps.links().removeManualLinks(c.fileId);
      deps.cases().fileLeft(c.fileId, [...(settled?.removedAutoLinks ?? []), ...removed], []);
    });
  }

  return { resolve, ignore, requireCase };
}
