import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { problem, renderApp } from '../../test/renderApp.tsx';

const candidate = (id: string, title: string, score: number) => ({ ref: { provider: 'wikidata', id }, kind: 'movie', title, year: 2016, score });

const CASE = {
  id: 'c1',
  fileId: 'f1',
  rootName: 'Film',
  relPath: 'Film/Arrival (2016)/Arrival (2016).mkv',
  state: 'needs_review',
  reason: 'ambiguous',
  allowedResolutions: ['link_candidate', 'link_item', 'create_manual', 'ignore'],
  parsed: { title: 'Arrival', year: 2016 },
  candidates: [candidate('Q20selected', 'Arrival', 0.82), candidate('Q999', 'Arrival (short)', 0.61)],
  updatedAt: Date.now() - 3_600_000,
};

describe('"Da verificare" case', () => {
  it('lists the candidates with score and links the one picked', async () => {
    const app = renderApp('/admin/cases/c1', {
      'GET /video/api/v1/admin/cases/{caseId}': () => CASE,
      'POST /video/api/v1/admin/cases/{caseId}/resolve': () => ({ ...CASE, state: 'resolved', linkedItem: { id: 'i1', kind: 'movie', title: 'Arrival', badges: [], available: true } }),
    });
    expect(await screen.findByRole('heading', { name: CASE.relPath })).toBeTruthy();
    expect(screen.getByText('Più candidati possibili', { exact: false })).toBeTruthy();
    expect(screen.getByText(/Punteggio 0\.82/)).toBeTruthy();
    await app.user.click(screen.getByRole('button', { name: 'Scegli questo: Arrival' }));
    await waitFor(() => expect(app.requests.some((r) => r.path.endsWith('/resolve'))).toBe(true));
    expect(app.requests.find((r) => r.path.endsWith('/resolve'))?.body).toEqual({ action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q20selected' } });
    // Admin operations are public in the MVP: no profile needed.
    expect(app.requests.every((r) => r.auth === null)).toBe(true);
  });

  it('a multi-part file can only be ignored, after a confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const app = renderApp('/admin/cases/c2', {
      'GET /video/api/v1/admin/cases/{caseId}': () => ({ ...CASE, id: 'c2', reason: 'multi_part', allowedResolutions: ['ignore'] }),
      'POST /video/api/v1/admin/cases/{caseId}/ignore': () => ({ ...CASE, id: 'c2', state: 'ignored' }),
    });
    expect(await screen.findByText(/è possibile solo ignorare/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Scegli questo/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Crea e collega' })).toBeNull();
    await app.user.click(screen.getByRole('button', { name: 'Ignora questo file' }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(app.requests.some((r) => r.method === 'POST' && r.path.endsWith('/c2/ignore'))).toBe(true));
  });

  it('creates the item by hand', async () => {
    const app = renderApp('/admin/cases/c1', {
      'GET /video/api/v1/admin/cases/{caseId}': () => ({ ...CASE, candidates: [], reason: 'no_candidates' }),
      'POST /video/api/v1/admin/cases/{caseId}/resolve': () => ({ ...CASE, state: 'resolved' }),
    });
    await screen.findByRole('heading', { name: CASE.relPath });
    await app.user.type(screen.getByLabelText('Titolo'), 'Arrival');
    await app.user.type(screen.getByLabelText('Anno (facoltativo)'), '2016');
    await app.user.click(screen.getByRole('button', { name: 'Crea e collega' }));
    await waitFor(() => expect(app.requests.some((r) => r.path.endsWith('/resolve'))).toBe(true));
    expect(app.requests.find((r) => r.path.endsWith('/resolve'))?.body).toEqual({ action: 'create_manual', manual: { kind: 'movie', title: 'Arrival', year: 2016 } });
  });
});

const ARRIVAL_SHORT = { id: 'i9', kind: 'movie', title: 'Arrival (short)', year: 2016, badges: [], available: true };
const resolveBody = (app: ReturnType<typeof renderApp>) => app.requests.find((r) => r.path.endsWith('/resolve'))?.body;

describe('correcting a resolved or ignored case', () => {
  it('a resolved case says what it is linked to; "Correggi" opens the resolutions and a new pick replaces the link', async () => {
    const app = renderApp('/admin/cases/c1', {
      'GET /video/api/v1/admin/cases/{caseId}': () => ({ ...CASE, state: 'resolved', linkedItem: ARRIVAL_SHORT }),
      'POST /video/api/v1/admin/cases/{caseId}/resolve': () => ({ ...CASE, state: 'resolved', linkedItem: { ...ARRIVAL_SHORT, id: 'i1', title: 'Arrival' } }),
    });
    expect((await screen.findByText(/^Ora il file è collegato a/)).textContent).toBe('Ora il file è collegato a Arrival (short) · 2016');
    expect(screen.getByRole('link', { name: 'Arrival (short) · 2016' }).getAttribute('href')).toBe('/item/i9');
    // Nothing to click by mistake until "Correggi".
    expect(screen.queryByRole('button', { name: /Scegli questo/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ignora questo file' })).toBeNull();

    const correct = screen.getByRole('button', { name: 'Correggi' });
    expect(correct.getAttribute('aria-expanded')).toBe('false');
    await app.user.click(correct);
    expect(correct.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(correct.getAttribute('aria-controls') ?? '')?.hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Ignora questo file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Crea e collega' })).toBeTruthy();

    await app.user.click(screen.getByRole('button', { name: 'Scegli questo: Arrival' }));
    await waitFor(() => expect(resolveBody(app)).toEqual({ action: 'link_candidate', candidate: { provider: 'wikidata', id: 'Q20selected' } }));
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('an ignored case says so; "Correggi" links it again, without offering Ignore once more', async () => {
    const app = renderApp('/admin/cases/c1', {
      'GET /video/api/v1/admin/cases/{caseId}': () => ({ ...CASE, state: 'ignored', linkedItem: null }),
      'POST /video/api/v1/admin/cases/{caseId}/resolve': () => ({ ...CASE, state: 'resolved' }),
    });
    expect(await screen.findByText('Ora il file è ignorato: non compare nel catalogo.')).toBeTruthy();
    await app.user.click(screen.getByRole('button', { name: 'Correggi' }));
    expect(screen.queryByRole('button', { name: 'Ignora questo file' })).toBeNull();
    await app.user.type(screen.getByLabelText('Titolo'), 'Arrival');
    await app.user.click(screen.getByRole('button', { name: 'Crea e collega' }));
    await waitFor(() => expect(resolveBody(app)).toEqual({ action: 'create_manual', manual: { kind: 'movie', title: 'Arrival', year: null } }));
  });

  it('an ignored file that can only be ignored has nothing to correct', async () => {
    renderApp('/admin/cases/c2', { 'GET /video/api/v1/admin/cases/{caseId}': () => ({ ...CASE, id: 'c2', state: 'ignored', reason: 'multi_part', allowedResolutions: ['ignore'] }) });
    expect(await screen.findByText('Ora il file è ignorato: non compare nel catalogo.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Correggi' })).toBeNull();
  });
});

describe('manual creation', () => {
  it('offers a film or a series only (a manual episode is refused, a manual extra would belong to nothing)', async () => {
    renderApp('/admin/cases/c1', { 'GET /video/api/v1/admin/cases/{caseId}': () => CASE });
    const manual = (await screen.findByRole('button', { name: 'Crea e collega' })).closest('form');
    if (!manual) throw new Error('form');
    const select = within(manual).getByRole('combobox', { name: 'Tipo' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Film', 'Serie']);
  });

  it.each([
    ['a manual series', 'body/manual/kind'],
    ['a manual series, whatever the path', ''],
  ])('%s for a file with no episode number: the 400 is explained, with the server details', async (_name, path) => {
    const message = 'the file name has no episode number: link it to an episode (link_item) instead of a series';
    const app = renderApp('/admin/cases/c1', {
      'GET /video/api/v1/admin/cases/{caseId}': () => CASE,
      'POST /video/api/v1/admin/cases/{caseId}/resolve': () => problem(400, 'VALIDATION_FAILED', { detail: message, errors: [{ path, message }] }),
    });
    await screen.findByRole('heading', { name: CASE.relPath });
    await app.user.type(screen.getByLabelText('Titolo'), 'Dark');
    const form = screen.getByRole('button', { name: 'Crea e collega' }).closest('form');
    if (!form) throw new Error('form');
    await app.user.selectOptions(within(form).getByRole('combobox', { name: 'Tipo' }), 'series');
    await app.user.click(screen.getByRole('button', { name: 'Crea e collega' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Il nome del file non ha un numero di episodio');
    expect(alert.textContent).not.toContain('Alcuni dati non sono validi.');
    expect(within(alert).getByRole('list', { name: 'Dettagli' }).textContent).toContain(message);
  });

  it('picking a series candidate for a file with no episode number explains the 400 the same way', async () => {
    const series = { ref: { provider: 'wikidata', id: 'Q2' }, kind: 'series', title: 'Arrival', year: 2016, score: 0.7 };
    const app = renderApp('/admin/cases/c1', {
      'GET /video/api/v1/admin/cases/{caseId}': () => ({ ...CASE, candidates: [series] }),
      'POST /video/api/v1/admin/cases/{caseId}/resolve': () => problem(400, 'VALIDATION_FAILED', { errors: [{ path: 'body/candidate', message: 'no episode number' }] }),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Scegli questo: Arrival' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Il nome del file non ha un numero di episodio');
  });

  it('any other 400 keeps the generic message and lists the details', async () => {
    const app = renderApp('/admin/cases/c1', {
      'GET /video/api/v1/admin/cases/{caseId}': () => CASE,
      'POST /video/api/v1/admin/cases/{caseId}/resolve': () => problem(400, 'VALIDATION_FAILED', { errors: [{ path: 'body/manual/title', message: 'must NOT have more than 200 characters' }] }),
    });
    await screen.findByRole('heading', { name: CASE.relPath });
    await app.user.type(screen.getByLabelText('Titolo'), 'Arrival');
    await app.user.click(screen.getByRole('button', { name: 'Crea e collega' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Alcuni dati non sono validi.');
    expect(within(alert).getByRole('list', { name: 'Dettagli' }).textContent).toBe('body/manual/title: must NOT have more than 200 characters');
  });
});

describe('cases list', () => {
  it('shows the queue by state with links to the cases', async () => {
    const app = renderApp('/admin/cases', {
      'GET /video/api/v1/admin/cases': ({ url }) => ({ cases: url.searchParams.get('state') === 'needs_review' ? [CASE] : [], nextCursor: null }),
    });
    const link = await screen.findByRole('link', { name: /^Apri il caso di Film\/Arrival \(2016\)\/Arrival \(2016\)\.mkv · Film · / });
    expect(link.getAttribute('href')).toBe('/admin/cases/c1');
    // Label in name (WCAG 2.5.3): every visible line of the link is in its name, in order, and the lines are apart in
    // the visible text.
    const visible = [...link.children].map((c) => c.textContent ?? '');
    expect(link.getAttribute('aria-label')).toContain(visible.join(' · '));
    expect(link.textContent).toBe(visible.join(' '));
    expect(app.requests.find((r) => r.path === '/video/api/v1/admin/cases')?.search).toContain('state=needs_review');
  });
});
