import { act, screen, waitFor } from '@testing-library/react';
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

describe('item page: provisional item', () => {
  it('an item waiting for its identification says where its title comes from', async () => {
    renderApp('/item/m1', { 'GET /video/api/v1/items/{itemId}': () => detail('m1', 'movie', 'Dune', { provisional: true }) }, { profile });
    await screen.findByRole('heading', { level: 1, name: 'Dune' });
    const notes = screen.getAllByRole('note').map((n) => n.textContent);
    expect(notes).toContain('In attesa di identificazione: il titolo viene dal nome del file.');
  });

  it('an identified item shows no such notice', async () => {
    renderApp('/item/m2', { 'GET /video/api/v1/items/{itemId}': () => detail('m2', 'movie', 'Arrival', { provisional: false }) }, { profile });
    await screen.findByRole('heading', { level: 1, name: 'Arrival' });
    expect(screen.queryByText(/In attesa di identificazione/)).toBeNull();
  });
});

describe('item page: the item removed from the library while it is on screen', () => {
  const items = { m1: detail('m1', 'movie', 'Dune', { provisional: true }), m2: detail('m2', 'movie', 'Dune: Part One', { year: 2021 }) };
  const routes = { 'GET /video/api/v1/items/{itemId}': ({ params }: { params: Record<string, string> }) => items[params.itemId as keyof typeof items] ?? problem(404, 'NOT_FOUND') };

  it('goes to the item that took its place, replacing the page in the history', async () => {
    const app = renderApp('/item/m1', routes, { profile });
    await screen.findByRole('heading', { level: 1, name: 'Dune' });
    act(() => app.services.removals.record('m1', 'm2'));
    await screen.findByRole('heading', { level: 1, name: 'Dune: Part One' });
    expect(app.router.state.location.pathname).toBe('/item/m2');
    expect(app.router.history.length).toBe(1);
  });

  it('with nothing in its place, shows the usual not-found instead of the cached item', async () => {
    const app = renderApp('/item/m1', routes, { profile });
    await screen.findByRole('heading', { level: 1, name: 'Dune' });
    act(() => app.services.removals.record('m1', null));
    expect((await screen.findByRole('alert')).textContent).toContain('Non trovato.');
    expect(screen.queryByRole('heading', { level: 1, name: 'Dune' })).toBeNull();
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
