// Module 'admin' (doc 03 §6): libraries, ingest status and jobs, the "Da verificare" queue and its
// resolutions, manual provider search, file diagnostics. Reads the media and case tables; writes
// cases and manual links in admin/resolve.ts; everything else goes through ports.
// explainPlaybackDecision belongs to playback (F1b).
import { typed, type Ok } from '../../app/http.ts';
import type { ModuleFactory, Ports } from '../../app/module.ts';
import { notFound, ProblemError } from '../../app/problem.ts';
import type { MetadataCandidate, MetadataProviderName } from '../../shared/metadata.ts';
import type { ApiSchemas } from '../../shared/ports.ts';
import { allowedResolutions, type Candidate, type CaseReason, parseCase, searchScore, storedCandidates, toContractCandidate } from './cases.ts';
import { createResolver } from './resolve.ts';

type CaseView = ApiSchemas['IdentificationCase'];
type CaseState = CaseView['state'];
/** Body of the 202 responses (Ok<> covers 200 and 201 only). */
type Accepted = ApiSchemas['Accepted'];

const FAILED_SHOWN = 20;
const SEARCH_LIMIT = 20;

interface CaseListRow {
  id: string;
  fileId: string;
  state: CaseState;
  reason: CaseReason | null;
  parsed: string | null;
  candidates: string | null;
  updatedAt: number;
  createdAt: number;
  relPath: string;
  rootName: string;
}

function optionalPort<K extends keyof Ports>(ports: Ports, key: K): Ports[K] | null {
  try {
    return ports[key];
  } catch {
    return null;
  }
}

// Cursor of the case queue: (createdAt, id) of the last case, newest first. Neither changes, so a
// case updated while the owner pages never moves.
const encodeCursor = (state: string, createdAt: number, id: string) => Buffer.from(JSON.stringify({ o: `cases:${state}`, k: createdAt, i: id })).toString('base64url');
function decodeCursor(cursor: string, state: string): { k: number; i: string } {
  try {
    const p = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown; k?: unknown; i?: unknown };
    if (p.o === `cases:${state}` && typeof p.k === 'number' && typeof p.i === 'string') return { k: p.k, i: p.i };
  } catch {
    // falls through
  }
  throw new ProblemError('VALIDATION_FAILED', 'invalid cursor');
}

export const createAdminModule: ModuleFactory = ({ db, now, ports, config }) => {
  const resolver = createResolver({
    db,
    now,
    catalog: () => ports.catalogWrite,
    links: () => ports.catalogLinks,
    cases: () => ports.caseSettlement,
    jobs: () => ports.jobs,
    metadata: () => optionalPort(ports, 'metadataSearch'),
    profiles: () => optionalPort(ports, 'profileState'),
    lang: config.METADATA_LANGUAGE,
  });

  const CASE_COLS = `c.id, c.file_id AS fileId, c.state, c.reason, c.parsed, c.candidates, c.updated_at AS updatedAt, c.created_at AS createdAt, f.rel_path AS relPath, r.name AS rootName
    FROM identification_case c JOIN media_file f ON f.id = c.file_id JOIN library_root r ON r.id = f.root_id`;
  const caseById = db.$client.prepare(`SELECT ${CASE_COLS} WHERE c.id = ?`);
  const firstLinks = db.$client.prepare(
    `SELECT file_id AS fileId, item_id AS itemId FROM media_link WHERE file_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id`,
  );

  function caseViews(rows: readonly CaseListRow[]): CaseView[] {
    const linked = new Map<string, string>();
    for (const l of firstLinks.all(JSON.stringify(rows.map((r) => r.fileId))) as { fileId: string; itemId: string }[]) {
      if (!linked.has(l.fileId)) linked.set(l.fileId, l.itemId);
    }
    const summaries = new Map(ports.catalogViews.summaries([...new Set(linked.values())]).map((s) => [s.id, s]));
    return rows.map((r) => {
      const parsedRaw = r.parsed ? (JSON.parse(r.parsed) as Record<string, unknown>) : {};
      const parsed = parseCase(parsedRaw);
      const itemId = linked.get(r.fileId);
      return {
        id: r.id,
        fileId: r.fileId,
        rootName: r.rootName,
        relPath: r.relPath,
        state: r.state,
        reason: r.reason,
        allowedResolutions: allowedResolutions(r.reason),
        parsed: parsedRaw,
        warnings: parsed.warnings ?? [],
        candidates: storedCandidates(r.candidates ? JSON.parse(r.candidates) : null).map(toContractCandidate),
        linkedItem: (itemId && summaries.get(itemId)) || null,
        updatedAt: r.updatedAt,
      };
    });
  }

  const caseView = (caseId: string): CaseView => {
    const row = caseById.get(caseId) as CaseListRow | undefined;
    if (!row) throw notFound('Identification case');
    return caseViews([row])[0]!;
  };

  function toCandidate(c: MetadataCandidate, q: string, year: number | null): Candidate {
    const titles = [c.titles.localized, c.titles.english, ...c.titles.original, ...c.titles.aliases].filter((t): t is string => !!t);
    return {
      ref: { provider: c.ref.provider, id: c.ref.id },
      kind: c.ref.kind,
      title: c.titles.localized ?? c.titles.english ?? c.titles.original[0] ?? c.ref.id,
      originalTitle: c.titles.original[0] ?? null,
      year: c.years[0] ?? null,
      score: searchScore(q, titles, c.years, year),
      evidence: {
        provider: c.ref.provider,
        years: c.years,
        externalIds: c.externalIds,
        ...(c.voteCount !== null ? { voteCount: c.voteCount } : {}),
        ...(c.documentary !== null ? { documentary: c.documentary } : {}),
      },
    };
  }

  return {
    name: 'admin',
    handlers: {
      listLibraryRoots: async (): Promise<Ok<'listLibraryRoots'>> => {
        const rows = db.$client
          .prepare(
            `SELECT r.id, r.name, r.mount_path AS mountPath, r.hint, r.status, r.last_scan_at AS lastScanAt,
               r.hold_reason AS holdReason, r.held_missing AS heldMissing, r.confirmed_missing AS confirmedMissing,
               (SELECT count(*) FROM media_file f WHERE f.root_id = r.id AND f.state NOT IN ('missing', 'removed')) AS fileCount
             FROM library_root r ORDER BY r.name, r.id`,
          )
          .all() as (Omit<ApiSchemas['LibraryRoot'], 'held'> & { holdReason: 'empty_walk' | 'mass_missing' | null; heldMissing: number | null; confirmedMissing: number | null })[];
        return {
          roots: rows.map(({ holdReason, heldMissing, confirmedMissing, ...r }) => ({
            ...r,
            held: holdReason ? { reason: holdReason, missingFiles: heldMissing ?? 0, confirmed: confirmedMissing !== null } : null,
          })),
        };
      },

      triggerScan: async (req, reply): Promise<Accepted> => {
        const rootId = (typed<'triggerScan'>(req).body as { rootId?: string } | undefined)?.rootId;
        if (rootId && !db.$client.prepare('SELECT 1 FROM library_root WHERE id = ?').get(rootId)) throw notFound('Library root');
        const jobId = ports.library.requestScan(rootId);
        void reply.code(202);
        return { accepted: true, jobId };
      },

      confirmRootContents: async (req, reply): Promise<Accepted> => {
        const { rootId } = typed<'confirmRootContents'>(req).params;
        const r = ports.library.confirmRootContents(rootId);
        if (r.status === 'not_found') throw notFound('Library root');
        if (r.status === 'not_configured') throw new ProblemError('CONFLICT', 'the root is not configured (LIBRARY_ROOTS): nothing scans it');
        if (r.status === 'not_held') throw new ProblemError('CONFLICT', 'the root is not held by the unmounted-root guard');
        void reply.code(202);
        return { accepted: true, jobId: r.jobId };
      },

      getIngestStatus: async (): Promise<Ok<'getIngestStatus'>> => {
        const stats = ports.jobAdmin.stats(FAILED_SHOWN);
        const total = (state: string) => Object.values(stats.counts).reduce((n, byState) => n + (byState[state] ?? 0), 0);
        const files = Object.fromEntries(
          (db.$client.prepare('SELECT state, count(*) AS n FROM media_file GROUP BY state ORDER BY state').all() as { state: string; n: number }[]).map((r) => [r.state, r.n]),
        );
        return {
          running: total('running') > 0,
          queued: total('queued'),
          failed: stats.failed.map(({ jobId, type, error, attempts }) => ({ jobId, type, error, attempts })),
          files,
          jobs: stats.counts,
        };
      },

      retryJob: async (req, reply): Promise<Accepted> => {
        const { jobId } = typed<'retryJob'>(req).params;
        const r = ports.jobAdmin.retry(jobId);
        if (r === 'not_found') throw notFound('Job');
        void reply.code(202);
        // A job that has not failed is left alone: accepted is false.
        return { accepted: r === 'requeued', jobId };
      },

      listIdentificationCases: async (req): Promise<Ok<'listIdentificationCases'>> => {
        const { query } = typed<'listIdentificationCases'>(req);
        const state = query.state ?? 'needs_review';
        const limit = query.limit ?? 50;
        const after = query.cursor ? decodeCursor(query.cursor, state) : null;
        const rows = db.$client
          .prepare(
            `SELECT ${CASE_COLS} WHERE c.state = @state ${after ? 'AND (c.created_at, c.id) < (@k, @i)' : ''}
             ORDER BY c.created_at DESC, c.id DESC LIMIT @limit`,
          )
          .all({ state, limit: limit + 1, ...(after ? { k: after.k, i: after.i } : {}) }) as CaseListRow[];
        const shown = rows.slice(0, limit);
        const last = shown[shown.length - 1];
        return { cases: caseViews(shown), nextCursor: rows.length > limit && last ? encodeCursor(state, last.createdAt, last.id) : null };
      },

      getIdentificationCase: async (req): Promise<Ok<'getIdentificationCase'>> => caseView(typed<'getIdentificationCase'>(req).params.caseId),

      resolveCase: async (req): Promise<Ok<'resolveCase'>> => {
        const { params, body } = typed<'resolveCase'>(req);
        await resolver.resolve(params.caseId, body);
        return caseView(params.caseId);
      },

      ignoreCase: async (req): Promise<Ok<'ignoreCase'>> => {
        const { caseId } = typed<'ignoreCase'>(req).params;
        resolver.ignore(caseId);
        return caseView(caseId);
      },

      searchProvider: async (req): Promise<Ok<'searchProvider'>> => {
        const { q, kind, year } = typed<'searchProvider'>(req).query;
        const port = optionalPort(ports, 'metadataSearch');
        const usable = (port?.status() ?? []).filter((s) => s.state === 'ok' || s.state === 'degraded').map((s) => s.provider);
        if (!port || !usable.length) throw new ProblemError('PROVIDER_UNAVAILABLE', 'no metadata provider is configured');
        const results = await Promise.all(
          usable.map(async (provider: MetadataProviderName) => ({
            provider,
            r: await port.search(provider, { query: q, kind: kind ?? null, year: year ?? null, lang: config.METADATA_LANGUAGE }),
          })),
        );
        const answered = results.filter((x) => x.r.status === 'ok' || x.r.status === 'not_found');
        if (!answered.length) throw new ProblemError('PROVIDER_UNAVAILABLE', `metadata providers did not answer: ${results.map((x) => `${x.provider} ${x.r.status}`).join(', ')}`);
        const found = answered.flatMap((x) => (x.r.status === 'ok' ? x.r.value : []));
        // A TMDB hit Wikidata already returned (same TMDB id and kind) is shown once, as the durable Wikidata one.
        const viaWikidata = new Set(found.filter((c) => c.ref.provider === 'wikidata' && c.externalIds.tmdb).map((c) => `${c.ref.kind}:${c.externalIds.tmdb}`));
        const candidates = found
          .filter((c) => c.ref.provider !== 'tmdb' || !viaWikidata.has(`${c.ref.kind}:${c.ref.id}`))
          .map((c) => toCandidate(c, q, year ?? null))
          .sort((a, b) => b.score - a.score)
          .slice(0, SEARCH_LIMIT);
        return { candidates };
      },

      getMediaFileDetails: async (req): Promise<Ok<'getMediaFileDetails'>> => {
        const { fileId } = typed<'getMediaFileDetails'>(req).params;
        const f = db.$client
          .prepare(
            `SELECT f.id, r.name AS rootName, f.rel_path AS relPath, f.state, f.size_bytes AS sizeBytes, f.facts
             FROM media_file f JOIN library_root r ON r.id = f.root_id WHERE f.id = ?`,
          )
          .get(fileId) as { id: string; rootName: string; relPath: string; state: string; sizeBytes: number; facts: string | null } | undefined;
        const version = f ? ports.catalogViews.mediaVersion(fileId) : null;
        if (!f || !version) throw notFound('Media file');
        const itemIds = (db.$client.prepare('SELECT item_id AS itemId FROM media_link WHERE file_id = ? ORDER BY created_at, id').all(fileId) as { itemId: string }[]).map((l) => l.itemId);
        return {
          id: f.id,
          rootName: f.rootName,
          relPath: f.relPath,
          state: f.state,
          sizeBytes: f.sizeBytes,
          version,
          links: ports.catalogViews.summaries(itemIds),
          facts: f.facts ? (JSON.parse(f.facts) as Record<string, unknown>) : {},
        };
      },
    },
  };
};
