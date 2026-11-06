// New content at the same path, end to end without media: scan → probe (fake ffprobe) → identify
// through compose(). The auto links made for the old content are replaced when the new result is
// written; a manual link stays; a touch whose fingerprint could not be read changes nothing
// (doc 01 §5.1, §6.1).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compose } from '../src/app/compose.ts';
import { loadConfig } from '../src/app/config.ts';
import type { ModuleFactory } from '../src/app/module.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { analyzerModule } from '../src/modules/analyzer/index.ts';
import { FfprobeOutput, type ProbeRunner } from '../src/modules/analyzer/ffprobe.ts';
import { createCatalogModule } from '../src/modules/catalog/index.ts';
import { createEventsModule } from '../src/modules/events/index.ts';
import { createIdentifierModule } from '../src/modules/identifier/index.ts';
import { createJobRunner, createJobsModule } from '../src/modules/jobs/index.ts';
import type * as FingerprintModule from '../src/modules/library/fingerprint.ts';
import { libraryModule } from '../src/modules/library/index.ts';
import type { MetadataCandidate, MetadataSearchRequest, ProviderResult } from '../src/shared/metadata.ts';
import { byTitle, cand, fakeMetadata } from './helpers/fake-metadata.ts';

// The fingerprint read can be made to fail (a file busy or locked on a share).
const fingerprint = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/modules/library/fingerprint.ts', async (original) => {
  const real = await original<typeof FingerprintModule>();
  return {
    ...real,
    fingerprintFile: async (absPath: string, sizeBytes: number) => {
      if (fingerprint.fail) throw new Error('EBUSY: resource busy or locked');
      return real.fingerprintFile(absPath, sizeBytes);
    },
  };
});

const log = pino({ level: 'silent' });
const fixture = FfprobeOutput.parse(JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/analyzer-ffprobe-dark.json', import.meta.url)), 'utf8')));
const runner: ProbeRunner = { probe: async () => fixture, firstFrameSideData: async () => [] };

const DUNE = 'Dune (2021)/Dune (2021).mkv';
const HEAT = 'Heat (1995)/Heat (1995).mkv';
const TRAILER = 'Dune (2021)/Dune (2021)-trailer.mkv';
const KNOWN: Record<string, MetadataCandidate[]> = {
  dune: [cand({ id: 'Q63985561', title: 'Dune', years: [2021] })],
  heat: [cand({ id: 'Q491147', title: 'Heat - La sfida', original: ['Heat'], years: [1995] })],
};

const cleanup: (() => void)[] = [];
afterEach(() => {
  fingerprint.fail = false;
  while (cleanup.length) cleanup.pop()?.();
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pzf-content-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'pzf-content-data-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(dataDir, { recursive: true, force: true }));
  const abs = (rel: string) => join(root, ...rel.split('/'));
  const put = (rel: string, content: Buffer) => {
    mkdirSync(dirname(abs(rel)), { recursive: true });
    writeFileSync(abs(rel), content);
  };
  const touch = (rel: string) => {
    const t = new Date(Date.now() + 120_000);
    utimesSync(abs(rel), t, t);
  };
  const providers = { search: (req: MetadataSearchRequest): ProviderResult<MetadataCandidate[]> => byTitle(KNOWN)(req) };
  const metadata = fakeMetadata({ wikidata: { search: (req) => providers.search(req) } });
  const metadataModule: ModuleFactory = () => ({ name: 'metadata', provides: { metadataSearch: metadata } });

  const db: Db = await openDb({ path: ':memory:' });
  cleanup.push(() => closeDb(db));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir, LIBRARY_ROOTS: JSON.stringify([{ name: 'Film', path: root, hint: 'movies' }]) });
  const comp = compose({
    config,
    db,
    log,
    factories: [createEventsModule, createJobsModule, libraryModule({ stableAfterMs: 0 }), analyzerModule({ runner }), createIdentifierModule, createCatalogModule, metadataModule],
  });
  for (const m of comp.modules) await m.start?.();
  const jobs = createJobRunner({ db, log, jobTypes: comp.jobTypes, periodic: comp.periodic });
  cleanup.push(() => void jobs.stop());
  const scan = async () => {
    await comp.periodic.find((p) => p.name === 'library.scan')?.run();
    await jobs.drain();
  };
  const linksOf = (rel: string) =>
    db.$client
      .prepare('SELECT i.id, i.title, l.origin FROM media_link l JOIN media_file f ON f.id = l.file_id JOIN catalog_item i ON i.id = l.item_id WHERE f.rel_path = ?')
      .all(rel) as { id: string; title: string; origin: string }[];
  const stateOf = (rel: string) => db.$client.prepare('SELECT state FROM media_file WHERE rel_path = ?').pluck().get(rel);
  return { db, put, touch, scan, linksOf, stateOf, providers };
}

describe('new content at the same path', () => {
  it('re-identifies a file whose content changed: auto links go, manual links stay', async () => {
    const s = await setup();
    s.put(DUNE, Buffer.alloc(5000, 1));
    s.put(HEAT, Buffer.alloc(5000, 2));
    await s.scan();
    expect(s.linksOf(DUNE)).toMatchObject([{ title: 'Dune', origin: 'auto' }]);
    // The owner linked Heat by hand.
    s.db.$client.prepare("UPDATE media_link SET origin = 'manual', confidence = NULL WHERE file_id = (SELECT id FROM media_file WHERE rel_path = ?)").run(HEAT);

    // Both files get new content that no provider knows.
    s.providers.search = () => ({ status: 'ok', value: [] });
    s.put(DUNE, Buffer.alloc(6000, 3));
    s.put(HEAT, Buffer.alloc(6000, 4));
    await s.scan();
    expect(s.linksOf(DUNE)).toEqual([]);
    expect(s.stateOf(DUNE)).toBe('needs_review');
    expect(s.linksOf(HEAT)).toMatchObject([{ title: 'Heat - La sfida', origin: 'manual' }]);
    expect(s.stateOf(HEAT)).toBe('identified');
  });

  it('keeps the old links while the providers are down', async () => {
    const s = await setup();
    s.put(DUNE, Buffer.alloc(5000, 1));
    await s.scan();
    const before = s.linksOf(DUNE);
    s.providers.search = () => ({ status: 'unavailable' });
    s.put(DUNE, Buffer.alloc(6000, 3)); // a better rip of the same film
    await s.scan();
    expect(s.linksOf(DUNE)).toEqual(before);
    expect(s.stateOf(DUNE)).toBe('analyzed'); // identification pending, the film still in the catalog
  });

  it('a touched file whose fingerprint cannot be read keeps its state and links; the next scan settles it', async () => {
    const s = await setup();
    s.put(DUNE, Buffer.alloc(5000, 1));
    await s.scan();
    const before = s.linksOf(DUNE);
    // Same bytes, new mtime; the read fails once and the providers know nothing now.
    s.touch(DUNE);
    fingerprint.fail = true;
    s.providers.search = () => ({ status: 'ok', value: [] });
    await s.scan();
    expect([s.linksOf(DUNE), s.stateOf(DUNE)]).toEqual([before, 'identified']);
    fingerprint.fail = false;
    await s.scan(); // a touch after all
    expect([s.linksOf(DUNE), s.stateOf(DUNE)]).toEqual([before, 'identified']);
    const mtime = s.db.$client.prepare('SELECT mtime_ms FROM media_file WHERE rel_path = ?').pluck().get(DUNE) as number;
    expect(mtime).toBeGreaterThan(Date.now());
  });

  it('an extra whose content changed stays the same extra item', async () => {
    const s = await setup();
    s.put(DUNE, Buffer.alloc(5000, 1));
    s.put(TRAILER, Buffer.alloc(5000, 2));
    await s.scan();
    const [trailer] = s.linksOf(TRAILER);
    expect(trailer).toMatchObject({ title: 'Trailer', origin: 'auto' });
    s.put(TRAILER, Buffer.alloc(5000, 3)); // e.g. mkvpropedit on the header: same size, new bytes
    s.touch(TRAILER);
    await s.scan();
    expect(s.linksOf(TRAILER)).toEqual([trailer]);
    expect(s.db.$client.prepare("SELECT title FROM catalog_item WHERE kind = 'extra'").pluck().all()).toEqual(['Trailer']);
  });
});
