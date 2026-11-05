import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/renderApp.tsx';

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

describe('cases list', () => {
  it('shows the queue by state with links to the cases', async () => {
    const app = renderApp('/admin/cases', {
      'GET /video/api/v1/admin/cases': ({ url }) => ({ cases: url.searchParams.get('state') === 'needs_review' ? [CASE] : [], nextCursor: null }),
    });
    const link = await screen.findByRole('link', { name: `Apri il caso di ${CASE.relPath}` });
    expect(link.getAttribute('href')).toBe('/admin/cases/c1');
    expect(app.requests.find((r) => r.path === '/video/api/v1/admin/cases')?.search).toContain('state=needs_review');
  });
});
