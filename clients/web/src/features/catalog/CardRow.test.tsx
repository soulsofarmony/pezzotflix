import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/renderApp.tsx';

const variants = (key: string) => Object.fromEntries([160, 320, 640].map((w) => [String(w), `/video/media/images/${key}?w=${w}`]));
const item = (id: string, title: string) => ({ id, kind: 'movie', title, year: 2020, badges: [], available: true, images: [{ type: 'poster', url: `/video/media/images/k-${id}`, variants: variants(`k-${id}`) }] });

const HOME = {
  rows: [
    { id: 'movies', title: 'Film', items: [item('a', 'Alien'), item('b', 'Blade Runner'), item('c', 'Contact')], nextCursor: 'x', query: { kind: 'movie', category: 'film' } },
    { id: 'series', title: 'Serie', items: [item('d', 'Dark')], nextCursor: null },
  ],
};

const profile = { id: 'p1', name: 'Simone', token: 't' };

describe('Home rows', () => {
  it('one tab stop per row; arrows, Home and End move inside it', async () => {
    const app = renderApp('/', { 'GET /video/api/v1/home': () => HOME }, { profile });
    const row = (await screen.findByRole('heading', { name: 'Film' })).closest('section');
    if (!row) throw new Error('row');
    const links = within(row).getAllByRole('link', { name: /Alien|Blade Runner|Contact/ });
    expect(links.map((l) => l.tabIndex)).toEqual([0, -1, -1]);

    links[0]?.focus();
    await app.user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(links[1]);
    expect(links.map((l) => l.tabIndex)).toEqual([-1, 0, -1]);
    await app.user.keyboard('{End}');
    expect(document.activeElement).toBe(links[2]);
    await app.user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(links[2]);
    await app.user.keyboard('{Home}');
    expect(document.activeElement).toBe(links[0]);
  });

  it('next up comes after Continue watching; an episode card names its series', async () => {
    const ep = (id: string, title: string, season: number, episode: number) => ({ ...item(id, title), kind: 'episode', year: null, seasonNumber: season, episodeNumber: episode, seriesTitle: 'Dark' });
    const home = {
      rows: [
        { id: 'continue_watching', title: 'Continua a guardare', items: [ep('e2', 'Bugie', 1, 2)], nextCursor: null, query: { continueWatching: 'true', sort: 'last_played', order: 'desc' } },
        { id: 'next_up', title: 'Prossimi episodi', items: [ep('e3', 'Passato e presente', 1, 3)], nextCursor: null },
      ],
    };
    renderApp('/', { 'GET /video/api/v1/home': () => home }, { profile });
    const row = (await screen.findByRole('heading', { name: 'Prossimi episodi' })).closest('section');
    if (!row) throw new Error('row');
    expect(screen.getAllByRole('heading', { level: 2 }).map((x) => x.textContent)).toEqual(['Continua a guardare', 'Prossimi episodi']);
    const link = within(row).getByRole('link', { name: 'Dark · S1E3 · Passato e presente' });
    expect(within(link).getByText('Dark')).toBeTruthy();
    expect(within(link).getByText('S1E3 · Passato e presente')).toBeTruthy();
    expect(within(row).queryByRole('link', { name: /Vedi tutti/ })).toBeNull();
  });

  it('a card link is named by its visible lines (label in name); a placeholder draws its title with CSS', async () => {
    const noImage = { ...item('n', 'Nosferatu'), images: [] };
    renderApp('/', { 'GET /video/api/v1/home': () => ({ rows: [{ id: 'movies', title: 'Film', items: [noImage], nextCursor: null }] }) }, { profile });
    const link = await screen.findByRole('link', { name: 'Nosferatu · 2020' });
    // The title is text once (the placeholder holds it in an attribute), and the lines are apart: the visible label
    // is "Nosferatu 2020", inside the name.
    expect(link.textContent).toBe('Nosferatu 2020');
    expect(link.querySelector('[data-text]')?.getAttribute('data-text')).toBe('Nosferatu');
  });

  it('"Vedi tutti" reproduces the row query in Browse; images use the w variants', async () => {
    renderApp('/', { 'GET /video/api/v1/home': () => HOME }, { profile });
    const seeAll = await screen.findByRole('link', { name: /Vedi tutti/ });
    expect(seeAll.getAttribute('href')).toBe('/browse?kind=movie&category=film');
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/video/media/images/k-a?w=320');
    expect(img?.getAttribute('srcset')).toMatch(/w=160 160w/);
  });
});
