// Setup of every e2e project (doc 06 §4): the stack answers through the gateway, a scan runs to the end, the
// "Da verificare" cases listed in the samples file are resolved by hand, and nothing in the ingest failed.
import { type APIRequestContext, expect, test as setup } from '@playwright/test';
import type { components } from '../../src/api/schema.d.ts';
import { API, samples } from './support.ts';

type IngestStatus = components['schemas']['IngestStatus'];
type CasePage = components['schemas']['CasePage'];
type LibraryRoot = components['schemas']['LibraryRoot'];

const INGEST_TIMEOUT_MS = 10 * 60_000;

async function ingest(request: APIRequestContext): Promise<IngestStatus> {
  const res = await request.get(`${API}/admin/ingest`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as IngestStatus;
}

/** Waits until no job runs or waits, twice in a row (a finished job may queue the next one). */
async function waitForIngest(request: APIRequestContext): Promise<IngestStatus> {
  let idle = 0;
  let last: IngestStatus | null = null;
  await expect
    .poll(
      async () => {
        last = await ingest(request);
        idle = !last.running && last.queued === 0 ? idle + 1 : 0;
        return idle;
      },
      { timeout: INGEST_TIMEOUT_MS, intervals: [1_000] },
    )
    .toBeGreaterThanOrEqual(2);
  return last as unknown as IngestStatus;
}

setup('stack up, library scanned, cases resolved', async ({ request }) => {
  setup.setTimeout(INGEST_TIMEOUT_MS + 120_000);

  // The gateway answers 503 JSON until its health check sees the Video Service.
  await expect.poll(async () => (await request.get('/video/healthz')).status(), { timeout: 120_000, intervals: [1_000] }).toBe(200);

  const roots = ((await (await request.get(`${API}/admin/roots`)).json()) as { roots: LibraryRoot[] }).roots;
  expect(roots.length, 'no library root configured (LIBRARY_ROOTS)').toBeGreaterThan(0);
  for (const r of roots) expect(r.status, `root ${r.name} (${r.mountPath})`).toBe('online');

  const scan = await request.post(`${API}/admin/scan`, { data: {} });
  expect(scan.status(), await scan.text()).toBe(202);
  await waitForIngest(request);

  // Manual matches: only cases still waiting; a case resolved by an earlier run is not in the queue anymore.
  const matches = samples.manualMatches ?? [];
  if (matches.length > 0) {
    const page = (await (await request.get(`${API}/admin/cases`, { params: { state: 'needs_review', limit: 200 } })).json()) as CasePage;
    for (const m of matches) {
      const c = page.cases.find((x) => x.relPath === m.relPath);
      if (!c) continue;
      const res = await request.post(`${API}/admin/cases/${c.id}/resolve`, {
        data: { action: 'create_manual', manual: { kind: m.kind, title: m.title, year: m.year ?? null } },
      });
      expect(res.ok(), `resolve ${m.relPath}: ${await res.text()}`).toBe(true);
    }
    await waitForIngest(request);
  }

  const status = await ingest(request);
  expect(status.failed, 'failed ingest jobs').toEqual([]);
  expect(status.files.identified ?? 0, 'no file identified').toBeGreaterThan(0);
  setup.info().annotations.push({ type: 'files', description: JSON.stringify(status.files) });
});
