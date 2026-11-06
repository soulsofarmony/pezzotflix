// Setup of every e2e project (doc 06 §4): the stack answers through the gateway, a scan runs to the end, the
// "Da verificare" cases listed in the samples file are resolved by hand, nothing in the ingest failed, and the
// samples found in the catalog have a playable file on a root that is online.
import { type APIRequestContext, expect, test as setup } from '@playwright/test';
import type { components } from '../../src/api/schema.d.ts';
import { API, bearer, ensureProfile, findItemId, type ManualMatch, type SampleCase, samples } from './support.ts';

type IngestStatus = components['schemas']['IngestStatus'];
type CasePage = components['schemas']['CasePage'];
type IdentificationCase = components['schemas']['IdentificationCase'];
type LibraryRoot = components['schemas']['LibraryRoot'];
type ItemDetail = components['schemas']['ItemDetail'];
type MediaFileDetails = components['schemas']['MediaFileDetails'];

const INGEST_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 1_000;
/**
 * Polls with nothing running and the same number of queued jobs after which those jobs count as scheduled for later
 * (a provider retry hours away). The runner claims a due job within a second when nothing runs, so a due job cannot
 * stay queued this long. The API does not expose run_at, so this is how "beyond a short horizon" is told apart.
 */
const DELAYED_AFTER_POLLS = 8;

async function getJson<T>(request: APIRequestContext, url: string, params?: Record<string, string | number>): Promise<T> {
  const res = await request.get(url, params ? { params } : undefined);
  expect(res.ok(), `GET ${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const ingest = (request: APIRequestContext) => getJson<IngestStatus>(request, `${API}/admin/ingest`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until the ingest settles: no job runs and none waits, twice in a row (a finished job may queue the next one),
 * or no job runs and the queued ones have stayed put for DELAYED_AFTER_POLLS polls (scheduled for later). On timeout
 * the error carries the job counts per type and state.
 */
async function waitForIngest(request: APIRequestContext): Promise<IngestStatus> {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  let idle = 0;
  let still = 0;
  let lastQueued = -1;
  for (;;) {
    const s = await ingest(request);
    idle = !s.running && s.queued === 0 ? idle + 1 : 0;
    still = !s.running && s.queued > 0 && s.queued === lastQueued ? still + 1 : 0;
    lastQueued = s.queued;
    if (idle >= 2) return s;
    if (still >= DELAYED_AFTER_POLLS) {
      setup.info().annotations.push({ type: 'delayed jobs', description: `${s.queued} queued for later, not waited for: ${JSON.stringify(s.jobs)}` });
      return s;
    }
    if (Date.now() > deadline) {
      throw new Error(`ingest still busy after ${INGEST_TIMEOUT_MS / 60_000} min (running ${s.running}, queued ${s.queued}); jobs: ${JSON.stringify(s.jobs)}; files: ${JSON.stringify(s.files)}`);
    }
    await sleep(POLL_MS);
  }
}

const CASE_STATES: IdentificationCase['state'][] = ['needs_review', 'resolved', 'pending', 'auto_matched', 'ignored'];

/** Every identification case: the list answers one state at a time (needs_review by default), cursor by cursor. */
async function allCases(request: APIRequestContext): Promise<IdentificationCase[]> {
  const out: IdentificationCase[] = [];
  for (const state of CASE_STATES) {
    let cursor: string | null = null;
    do {
      const page: CasePage = await getJson<CasePage>(request, `${API}/admin/cases`, { state, limit: 200, ...(cursor ? { cursor } : {}) });
      out.push(...page.cases);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return out;
}

/**
 * Resolves the manual matches still waiting. One already resolved (an earlier run) is fine; any other outcome fails,
 * since the sample it stands for would not be what the specs expect: no case with that relPath (a typo, a renamed
 * file), or a case that matched on its own or was ignored.
 */
async function resolveManualMatches(request: APIRequestContext, matches: ManualMatch[]): Promise<boolean> {
  const cases = await allCases(request);
  const problems: string[] = [];
  let resolved = false;
  for (const m of matches) {
    const c = cases.find((x) => x.relPath === m.relPath);
    if (!c) {
      problems.push(`"${m.relPath}": no identification case with this relPath`);
    } else if (c.state === 'needs_review') {
      const res = await request.post(`${API}/admin/cases/${c.id}/resolve`, {
        data: { action: 'create_manual', manual: { kind: m.kind, title: m.title, year: m.year ?? null } },
      });
      expect(res.ok(), `resolve ${m.relPath}: ${await res.text()}`).toBe(true);
      resolved = true;
    } else if (c.state !== 'resolved') {
      problems.push(`"${m.relPath}": case ${c.id} is ${c.state}, neither queued nor resolved`);
    }
  }
  expect(problems, 'manualMatches in the samples file').toEqual([]);
  return resolved;
}

/**
 * The roots the samples need: each sample found in the catalog must have an available file, on a root that is
 * online. Other roots may be offline (a root dropped from LIBRARY_ROOTS stays offline forever, and the API does not
 * tell it apart from an unmounted one). A sample missing from the catalog fails in its own spec.
 */
async function checkSampleRoots(request: APIRequestContext, roots: LibraryRoot[]): Promise<void> {
  const { token } = await ensureProfile(request);
  const byName = new Map(roots.map((r) => [r.name, r]));
  const titles = new Set(
    Object.entries(samples)
      .filter(([key]) => key !== 'manualMatches')
      .map(([, s]) => (s as SampleCase).title),
  );
  const problems: string[] = [];
  const missing: string[] = [];
  for (const title of titles) {
    const itemId = await findItemId(request, token, title);
    if (!itemId) {
      missing.push(title);
      continue;
    }
    const res = await request.get(`${API}/items/${itemId}`, { headers: bearer(token) });
    expect(res.ok(), `item "${title}": ${await res.text()}`).toBe(true);
    const detail = (await res.json()) as ItemDetail;
    if (!detail.versions.some((v) => v.available)) problems.push(`"${title}": no available file`);
    for (const v of detail.versions) {
      const file = await getJson<MediaFileDetails>(request, `${API}/admin/files/${v.fileId}`);
      const root = byName.get(file.rootName);
      if (root?.status !== 'online') problems.push(`"${title}": ${file.relPath} is on root ${file.rootName}, ${root ? root.status : 'unknown'}`);
    }
  }
  if (missing.length) setup.info().annotations.push({ type: 'not in the catalog', description: missing.join(', ') });
  expect(problems, `roots: ${JSON.stringify(roots.map((r) => ({ name: r.name, mountPath: r.mountPath, status: r.status })))}`).toEqual([]);
}

setup('stack up, library scanned, cases resolved', async ({ request }) => {
  setup.setTimeout(2 * INGEST_TIMEOUT_MS + 180_000);

  // The gateway answers 503 JSON until its health check sees the Video Service.
  await expect.poll(async () => (await request.get('/video/healthz')).status(), { timeout: 120_000, intervals: [1_000] }).toBe(200);

  const roots = (await getJson<{ roots: LibraryRoot[] }>(request, `${API}/admin/roots`)).roots;
  expect(roots.length, 'no library root configured (LIBRARY_ROOTS)').toBeGreaterThan(0);
  expect(
    roots.some((r) => r.status === 'online'),
    `no library root online: ${JSON.stringify(roots.map((r) => ({ name: r.name, mountPath: r.mountPath, status: r.status })))}`,
  ).toBe(true);

  const scan = await request.post(`${API}/admin/scan`, { data: {} });
  expect(scan.status(), await scan.text()).toBe(202);
  await waitForIngest(request);

  if (samples.manualMatches?.length && (await resolveManualMatches(request, samples.manualMatches))) await waitForIngest(request);

  const status = await ingest(request);
  expect(status.failed, 'failed ingest jobs').toEqual([]);
  expect(status.files.identified ?? 0, 'no file identified').toBeGreaterThan(0);
  setup.info().annotations.push({ type: 'files', description: JSON.stringify(status.files) });

  await checkSampleRoots(request, (await getJson<{ roots: LibraryRoot[] }>(request, `${API}/admin/roots`)).roots);
});
