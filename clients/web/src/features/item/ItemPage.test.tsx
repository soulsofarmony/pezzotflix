import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { keys } from '../../api/keys.ts';
import { problem, renderApp } from '../../test/renderApp.tsx';

const profile = { id: 'p1', name: 'Simone', token: 't' };
const STATE = { watched: false, progressPercent: 0, resumePositionMs: null, inWatchlist: false };
const detail = (id: string, kind: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  title,
  badges: [],
  available: true,
  genres: [],
  credits: [],
  children: [],
  extras: [],
  versions: [],
  state: STATE,
  ...extra,
});

const EPISODE = detail('e1', 'episode', 'Segreti', { seasonNumber: 1, episodeNumber: 1, seriesTitle: 'Dark', parent: { id: 'season1', kind: 'season', title: 'Stagione 1', badges: [], available: true } });

describe('item page: watch state', () => {
  it.each([
    ['movie', true],
    ['series', true],
    ['extra', true],
    ['season', false],
    ['episode', false],
  ])('a %s offers "Aggiungi alla mia lista": %s (doc 01: the list holds films, series and extras)', async (kind, offered) => {
    renderApp('/item/x1', { 'GET /video/api/v1/items/{itemId}': () => detail('x1', kind, 'Titolo'), 'GET /video/api/v1/items/{itemId}/children': () => ({ items: [], nextCursor: null }) }, { profile });
    await screen.findByRole('heading', { level: 1, name: 'Titolo' });
    expect(screen.queryByRole('button', { name: /Aggiungi alla mia lista/ }) !== null).toBe(offered);
    expect(screen.getByRole('button', { name: /Segna come visto/ })).toBeTruthy();
  });

  it('a watch-state change that fails says why', async () => {
    const app = renderApp(
      '/item/e1',
      {
        'GET /video/api/v1/items/{itemId}': () => EPISODE,
        'PUT /video/api/v1/items/{itemId}/watched': () => problem(503, 'MEDIA_UNAVAILABLE', {}, { 'Retry-After': '5' }),
      },
      { profile },
    );
    await app.user.click(await screen.findByRole('button', { name: /Segna come visto/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Il servizio non risponde in questo momento.');
  });

  it('marking an episode watched refreshes its season\'s episode list and its series\' next up too', async () => {
    const app = renderApp('/item/e1', { 'GET /video/api/v1/items/{itemId}': () => EPISODE, 'PUT /video/api/v1/items/{itemId}/watched': () => undefined }, { profile });
    const qc = app.services.queryClient;
    qc.setQueryData(keys.children('season1'), { pages: [], pageParams: [] });
    qc.setQueryData(keys.nextUp('series1'), { item: null });
    await app.user.click(await screen.findByRole('button', { name: /Segna come visto/ }));
    await waitFor(() => expect(qc.getQueryState(keys.children('season1'))?.isInvalidated).toBe(true));
    expect(qc.getQueryState(keys.nextUp('series1'))?.isInvalidated).toBe(true);
  });
});

describe('item page: errors', () => {
  it('a failed background refetch keeps the item on screen', async () => {
    let fail = false;
    const app = renderApp('/item/m1', { 'GET /video/api/v1/items/{itemId}': () => (fail ? problem(404, 'NOT_FOUND') : detail('m1', 'movie', 'Arrival')) }, { profile });
    await screen.findByRole('heading', { level: 1, name: 'Arrival' });
    fail = true;
    await app.services.queryClient.refetchQueries({ queryKey: keys.item('m1') });
    await waitFor(() => expect(app.services.queryClient.getQueryState(keys.item('m1'))?.status).toBe('error'));
    expect(screen.getByRole('heading', { level: 1, name: 'Arrival' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an item that is not there says so, with "Riprova"', async () => {
    renderApp('/item/zz', { 'GET /video/api/v1/items/{itemId}': () => problem(404, 'NOT_FOUND') }, { profile });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Non trovato.');
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy();
  });
});
