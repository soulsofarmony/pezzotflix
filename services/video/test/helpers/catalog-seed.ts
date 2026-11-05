// Test data for the catalog read side and the admin API: roots, analysed files (MediaFacts from the
// S1 ffprobe fixtures, metadata only), links and cases, written the way library/analyzer/identifier do.
import { readFileSync } from 'node:fs';
import type { Db } from '../../src/db/index.ts';
import { mapFacts } from '../../src/modules/analyzer/facts.ts';
import { FfprobeOutput } from '../../src/modules/analyzer/ffprobe.ts';
import { newId } from '../../src/shared/ids.ts';
import type { MediaFacts, SidecarSubtitleFacts } from '../../src/shared/media-facts.ts';

export type Fixture = 'br2049' | 'dune' | 'ilbuono' | 'oppenheimer' | 'dark';

export function factsOf(fixture: Fixture, relPath = 'x.mkv', rootName = 'Film', sidecars: SidecarSubtitleFacts[] = []): MediaFacts {
  const probe = FfprobeOutput.parse(JSON.parse(readFileSync(new URL(`../fixtures/analyzer-ffprobe-${fixture}.json`, import.meta.url), 'utf8')));
  return mapFacts({ probe, location: { rootName, relPath }, sizeBytes: 1_000_000, mtimeMs: 5, sidecars, hdr10PlusStreams: new Set() }).facts;
}

export function seedRoot(db: Db, name: string, opts: { status?: 'online' | 'offline'; hint?: 'movies' | 'series' | 'mixed'; path?: string } = {}): string {
  const id = newId();
  db.$client
    .prepare("INSERT INTO library_root (id, name, mount_path, hint, status, created_at) VALUES (?, ?, ?, ?, ?, 0)")
    .run(id, name, opts.path ?? `/media/${name}`, opts.hint ?? 'movies', opts.status ?? 'online');
  return id;
}

/** An analysed file: media_file with facts, media_stream and chapter rows as the analyzer writes them. */
export function seedFile(
  db: Db,
  rootId: string,
  relPath: string,
  fixture: Fixture | null,
  opts: { state?: string; sidecars?: SidecarSubtitleFacts[]; now?: number } = {},
): string {
  const id = newId();
  const t = opts.now ?? 0;
  const facts = fixture ? factsOf(fixture, relPath, 'Film', opts.sidecars ?? []) : null;
  db.$client
    .prepare(
      `INSERT INTO media_file (id, root_id, rel_path, size_bytes, mtime_ms, fingerprint, container, duration_ms, bit_rate, state, facts, analyzed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 5, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, rootId, relPath, 1_000_000, `fp-${id}`, facts?.container ?? null, facts?.durationMs ?? null, facts?.bitRate ?? null, opts.state ?? 'identified', facts ? JSON.stringify(facts) : null, facts ? t : null, t, t);
  for (const s of facts?.streams ?? []) {
    const { index, type, codec, profile, language, title, default: isDefault, forced, ...attrs } = s;
    db.$client
      .prepare(
        `INSERT INTO media_stream (id, file_id, stream_index, type, codec, profile, language, title, is_default, is_forced, is_sdh, is_commentary, attrs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), id, index, type, codec, profile, language, title, isDefault ? 1 : 0, forced ? 1 : 0, s.type === 'subtitle' && s.sdh ? 1 : 0, s.type === 'audio' && s.commentary ? 1 : 0, JSON.stringify(attrs));
  }
  for (const c of facts?.chapters ?? []) {
    db.$client.prepare('INSERT INTO chapter (file_id, chapter_index, title, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)').run(id, c.index, c.title, c.startMs, c.endMs);
  }
  return id;
}

export function seedLink(db: Db, fileId: string, itemId: string, origin: 'auto' | 'manual' = 'auto', at = 0): void {
  db.$client.prepare('INSERT INTO media_link (id, file_id, item_id, origin, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId(), fileId, itemId, origin, origin === 'auto' ? 0.9 : null, at);
}

export function seedCase(
  db: Db,
  fileId: string,
  c: { state?: string; reason?: string | null; parsed?: unknown; candidates?: unknown[]; updatedAt?: number; createdAt?: number },
): string {
  const id = newId();
  db.$client
    .prepare('INSERT INTO identification_case (id, file_id, state, reason, parsed, candidates, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, fileId, c.state ?? 'needs_review', c.reason ?? null, JSON.stringify(c.parsed ?? {}), JSON.stringify(c.candidates ?? []), c.createdAt ?? c.updatedAt ?? 0, c.updatedAt ?? 0);
  return id;
}

export function seedArtwork(db: Db, itemId: string, type: string, localPath: string, opts: { language?: string | null; selected?: boolean; source?: string } = {}): void {
  db.$client
    .prepare('INSERT INTO artwork (id, item_id, type, language, source, local_path, selected, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
    .run(newId(), itemId, type, opts.language ?? null, opts.source ?? 'wikidata', localPath, opts.selected ? 1 : 0);
}

/** A stored candidate as the identifier writes it (StoredCandidate). */
export function storedCandidate(c: { provider?: 'wikidata' | 'tmdb'; id: string; kind?: 'movie' | 'series'; title: string; year?: number | null; score?: number; ids?: Record<string, string> }) {
  const provider = c.provider ?? 'wikidata';
  const kind = c.kind ?? 'movie';
  return {
    ref: { provider, id: c.id, kind },
    provider,
    kind,
    title: c.title,
    originalTitle: c.title,
    year: c.year ?? null,
    score: c.score ?? 0.7,
    voteCount: provider === 'tmdb' ? 12 : null,
    externalIds: { [provider]: c.id, ...c.ids },
    evidence: { title: 0.7, year: 1, kind: 1 },
  };
}
