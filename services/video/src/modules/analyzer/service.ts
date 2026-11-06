// Media Analyzer (doc 02 §3.2): probes one file and owns its technical facts (media_file facts
// columns, media_stream, chapter). Sidecars belong to the library: MediaFacts.sidecars is built from
// the external_subtitle rows it keeps up to date.
import { stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { JobContext } from '../../app/module.ts';
import type { Db } from '../../db/index.ts';
import { chapter, externalSubtitle, libraryRoot, mediaFile, mediaStream } from '../../db/schema/index.ts';
import { newId } from '../../shared/ids.ts';
import {
  type AnalyzerProbePayload,
  type DeliveryKeyframeIndexPayload,
  type IdentifierIdentifyPayload,
  JOB_INTERRUPTED_ERROR,
  JOB_TYPES,
} from '../../shared/job-types.ts';
import { type MediaFacts, type SidecarSubtitleFacts, sidecarTrackId, type StreamFacts } from '../../shared/media-facts.ts';
import { resolveRealInsideRoot } from '../../shared/media-path.ts';
import type { JobQueuePort } from '../../shared/ports.ts';
import { ANALYZER_VERSION, hasHdr10PlusSideData, mapFacts, mayCarryHdr10Plus, type MappedProbe, type OtherStream } from './facts.ts';
import type { FfprobeOutput, ProbeRunner } from './ffprobe.ts';

/** Re-analysis after an analyzer upgrade runs after new files, enrichment and artwork (lower runs first). */
export const REANALYZE_PRIORITY = 300;

export const ProbePayload: z.ZodType<AnalyzerProbePayload> = z.object({ fileId: z.string().min(1) });

type StreamRow = typeof mediaStream.$inferInsert;

function streamRow(fileId: string, s: StreamFacts, commentarySubtitles: ReadonlySet<number>): StreamRow {
  // attrs keeps the type-specific facts; the common ones have their own columns.
  const { index, type, codec, profile, language, title, default: isDefault, forced, ...attrs } = s;
  return {
    id: newId(),
    fileId,
    index,
    type,
    codec,
    profile,
    language,
    title,
    isDefault,
    isForced: forced,
    isSdh: s.type === 'subtitle' && s.sdh,
    isCommentary: s.type === 'audio' ? s.commentary : s.type === 'subtitle' && commentarySubtitles.has(index),
    attrs,
  };
}

const otherRow = (fileId: string, o: OtherStream): StreamRow => ({
  id: newId(),
  fileId,
  index: o.index,
  type: o.type,
  codec: o.codec,
  attrs: o.attrs,
});

const SIDECAR_FORMATS: ReadonlySet<string> = new Set(['srt', 'ass', 'ssa', 'vtt', 'sup']);
const isSidecarFormat = (f: string): f is SidecarSubtitleFacts['format'] => SIDECAR_FORMATS.has(f);

// Only what the HDR10+ fallback needs from the stored facts.
const StoredFacts = z.looseObject({
  sizeBytes: z.number(),
  mtimeMs: z.number(),
  streams: z.array(
    z.looseObject({ index: z.number(), type: z.string(), hdr: z.string().optional(), hdrFallback: z.array(z.string()).optional() }),
  ),
});

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface AnalyzerDeps {
  db: Db;
  now: () => number;
  jobs: () => JobQueuePort;
  runner: ProbeRunner;
  /** The probe job's maxAttempts: the last attempt degrades instead of failing on enrichments. */
  maxAttempts: number;
}

export function createAnalyzer({ db, now, jobs, runner, maxAttempts }: AnalyzerDeps) {
  /** Writes the facts in one transaction; a file still waiting for analysis moves on to identification. */
  function store(fileId: string, m: MappedProbe): void {
    const t = now();
    db.transaction((tx) => {
      const cur = tx
        .select({ state: mediaFile.state, relPath: mediaFile.relPath, rootName: libraryRoot.name })
        .from(mediaFile)
        .innerJoin(libraryRoot, eq(libraryRoot.id, mediaFile.rootId))
        .where(eq(mediaFile.id, fileId))
        .get();
      if (!cur) return;
      // A scan may have moved the file or changed its sidecars while ffprobe ran: both come from the current rows.
      const sidecars = tx
        .select()
        .from(externalSubtitle)
        .where(eq(externalSubtitle.fileId, fileId))
        .orderBy(externalSubtitle.relPath)
        .all()
        .flatMap((r): SidecarSubtitleFacts[] =>
          isSidecarFormat(r.format)
            ? [{ id: sidecarTrackId(r.relPath), relPath: r.relPath, format: r.format, language: r.language, forced: r.isForced, sdh: r.isSdh }]
            : [],
        );
      const facts: MediaFacts = { ...m.facts, location: { rootName: cur.rootName, relPath: cur.relPath }, sidecars };
      // Re-analysis (content change, analyzer upgrade) never resets identified/needs_review/ignored/missing.
      const pending = cur.state === 'discovered' || cur.state === 'analyzed';
      tx.update(mediaFile)
        .set({
          facts,
          container: facts.container,
          durationMs: facts.durationMs,
          bitRate: facts.bitRate,
          analyzedAt: t,
          updatedAt: t,
          ...(pending ? { state: 'analyzed' as const } : {}),
        })
        .where(eq(mediaFile.id, fileId))
        .run();

      tx.delete(mediaStream).where(eq(mediaStream.fileId, fileId)).run();
      const streams = [
        ...facts.streams.map((s) => streamRow(fileId, s, m.commentarySubtitles)),
        ...m.others.map((o) => otherRow(fileId, o)),
      ];
      if (streams.length) tx.insert(mediaStream).values(streams).run();

      tx.delete(chapter).where(eq(chapter.fileId, fileId)).run();
      if (facts.chapters.length) {
        tx.insert(chapter)
          .values(facts.chapters.map((c) => ({ fileId, index: c.index, title: c.title, startMs: c.startMs, endMs: c.endMs })))
          .run();
      }

      if (pending) {
        const payload: IdentifierIdentifyPayload = { fileId };
        jobs().enqueue({ type: JOB_TYPES.identifierIdentify, payload, idempotencyKey: `identify:${fileId}` });
      }
      // ADR 0003 D8: the keyframe index is mandatory after every successful probe (delivery caches it per
      // size + mtime, so a job for unchanged content returns at once).
      if (facts.streams.some((s) => s.type === 'video' && !s.attachedPic)) {
        const index: DeliveryKeyframeIndexPayload = {
          fileId,
          location: facts.location,
          sizeBytes: facts.sizeBytes,
          mtimeMs: facts.mtimeMs,
          container: facts.container,
          videoStreamIndex: null,
        };
        // The stamp is in the key: a job still queued for older content does not hide this one.
        const key = `keyframes:${fileId}:${facts.sizeBytes}:${facts.mtimeMs}`;
        jobs().enqueue({ type: JOB_TYPES.deliveryKeyframeIndex, payload: index, idempotencyKey: key });
      }
    });
  }

  /** True if the stored facts of this very content (same size and mtime) say the stream is HDR10+. */
  function wasHdr10Plus(fileId: string, streamIndex: number, sizeBytes: number, mtimeMs: number): boolean {
    const row = db.select({ facts: mediaFile.facts }).from(mediaFile).where(eq(mediaFile.id, fileId)).get();
    const prev = StoredFacts.safeParse(row?.facts);
    if (!prev.success || prev.data.sizeBytes !== sizeBytes || prev.data.mtimeMs !== mtimeMs) return false;
    const s = prev.data.streams.find((x) => x.index === streamIndex && x.type === 'video');
    return s?.hdr === 'HDR10+' || (s?.hdrFallback?.includes('HDR10+') ?? false);
  }

  /** HDR10+ lives only in the frames (S1). A failed frame probe retries the job; the last attempt degrades. */
  async function hdr10PlusStreams(
    fileId: string,
    abs: string,
    raw: FfprobeOutput,
    file: { sizeBytes: number; mtimeMs: number },
    ctx: JobContext,
  ): Promise<Set<number>> {
    const main = raw.streams.find(mayCarryHdr10Plus);
    if (!main) return new Set();
    try {
      return hasHdr10PlusSideData(await runner.firstFrameSideData(abs, main.index, ctx.signal)) ? new Set([main.index]) : new Set();
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      if (ctx.attempt < maxAttempts) throw new Error(`first-frame probe failed: ${errText(err)}`);
      const kept = wasHdr10Plus(fileId, main.index, file.sizeBytes, file.mtimeMs);
      ctx.log.warn(
        { fileId, err: errText(err), keptHdr10Plus: kept },
        kept ? 'first-frame probe failed: keeping the HDR10+ already recorded' : 'first-frame probe failed: stream recorded as HDR10',
      );
      return kept ? new Set([main.index]) : new Set();
    }
  }

  async function probeFile(fileId: string, ctx: JobContext): Promise<void> {
    const row = db
      .select({
        relPath: mediaFile.relPath,
        state: mediaFile.state,
        rootName: libraryRoot.name,
        mountPath: libraryRoot.mountPath,
        rootStatus: libraryRoot.status,
      })
      .from(mediaFile)
      .innerJoin(libraryRoot, eq(libraryRoot.id, mediaFile.rootId))
      .where(eq(mediaFile.id, fileId))
      .get();
    if (!row) return void ctx.log.info({ fileId }, 'probe skipped: file no longer known');
    if (row.state === 'missing' || row.state === 'removed') return void ctx.log.info({ fileId }, 'probe skipped: file missing');
    // The scan that sees the root online again re-enqueues the files still waiting for analysis.
    if (row.rootStatus === 'offline') return void ctx.log.info({ fileId }, 'probe skipped: root offline');

    // Links followed: a folder swapped for a link after the scan must not lead ffprobe out of the root.
    const abs = await resolveRealInsideRoot(row.mountPath, row.relPath);
    const st = await stat(abs);
    if (!st.isFile()) throw new Error(`not a regular file: ${row.relPath}`);
    const raw = await runner.probe(abs, ctx.signal);
    const file = { sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    const hdr10Plus = await hdr10PlusStreams(fileId, abs, raw, file, ctx);
    store(
      fileId,
      mapFacts({ probe: raw, location: { rootName: row.rootName, relPath: row.relPath }, ...file, hdr10PlusStreams: hdr10Plus }),
    );
  }

  async function probe(payload: unknown, ctx: JobContext): Promise<void> {
    const { fileId } = ProbePayload.parse(payload);
    try {
      await probeFile(fileId, ctx);
    } catch (err) {
      if (!ctx.signal.aborted && ctx.attempt >= maxAttempts) {
        // The file stays 'discovered': the daily sweep (requeueFailedProbes) tries again, as do a change
        // of the file and RetryJob.
        ctx.log.error({ fileId, attempts: ctx.attempt, err: errText(err) }, 'probe failed for good');
      }
      throw err;
    }
  }

  // Files whose facts come from an older analyzer. Missing or removed files and offline roots wait
  // for the scan that sees them again; the probe would skip them anyway.
  const outdated = db.$client
    .prepare(
      `SELECT f.id FROM media_file f JOIN library_root r ON r.id = f.root_id
       WHERE f.facts IS NOT NULL AND coalesce(json_extract(f.facts, '$.analyzerVersion'), 0) < ?
         AND f.state NOT IN ('missing', 'removed') AND r.status = 'online'
       ORDER BY f.id`,
    )
    .pluck();

  /**
   * Enqueues analyzer.probe at low priority for every file analysed by an older ANALYZER_VERSION. The
   * probe rewrites facts, streams and chapters only: an identified, needs_review or ignored file keeps
   * its state, case and links, and is not identified again (see store). Returns how many were queued.
   */
  function requeueOutdated(): number {
    let n = 0;
    for (const fileId of outdated.all(ANALYZER_VERSION) as string[]) {
      const payload: AnalyzerProbePayload = { fileId };
      const key = `reanalyze:${fileId}:v${ANALYZER_VERSION}`;
      if (jobs().enqueue({ type: JOB_TYPES.analyzerProbe, payload, priority: REANALYZE_PRIORITY, idempotencyKey: key })) n++;
    }
    return n;
  }

  // Files still waiting for their first analysis whose probe job failed for good, on online roots,
  // with no probe queued or running. The job table is read only (as metadata's sweep does). The
  // probe goes under the scan's key for the current mtime; when the job holding that key is one the
  // runner failed because the service stopped during it twice in a row, it is left alone: it may
  // bring the process down.
  const failedProbes = db.$client
    .prepare(
      `SELECT f.id, f.mtime_ms AS mtimeMs FROM media_file f JOIN library_root r ON r.id = f.root_id
       WHERE f.state = 'discovered' AND r.status = 'online'
         AND EXISTS (SELECT 1 FROM job j WHERE j.type = @type AND j.state = 'failed' AND json_extract(j.payload, '$.fileId') = f.id)
         AND NOT EXISTS (SELECT 1 FROM job j WHERE j.type = @type AND j.state IN ('queued', 'running') AND json_extract(j.payload, '$.fileId') = f.id)
         AND NOT EXISTS (SELECT 1 FROM job j WHERE j.idempotency_key = 'probe:' || f.id || ':' || f.mtime_ms
                           AND j.state = 'failed' AND j.last_error LIKE @interrupted)
       ORDER BY f.id`,
    );

  /**
   * Enqueues the probe again, with the key the scan uses, for files whose probe failed for good: a
   * share that was slow or a file still being copied gets a new try each day. Returns how many.
   */
  function requeueFailedProbes(): number {
    let n = 0;
    const rows = failedProbes.all({ type: JOB_TYPES.analyzerProbe, interrupted: `${JOB_INTERRUPTED_ERROR}%` }) as { id: string; mtimeMs: number }[];
    for (const { id, mtimeMs } of rows) {
      const payload: AnalyzerProbePayload = { fileId: id };
      if (jobs().enqueue({ type: JOB_TYPES.analyzerProbe, payload, priority: REANALYZE_PRIORITY, idempotencyKey: `probe:${id}:${mtimeMs}` })) n++;
    }
    return n;
  }

  return { probe, requeueOutdated, requeueFailedProbes };
}
