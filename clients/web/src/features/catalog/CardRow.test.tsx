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

  it('"Vedi tutti" reproduces the row query in Browse; images use the w variants', async () => {
    renderApp('/', { 'GET /video/api/v1/home': () => HOME }, { profile });
    const seeAll = await screen.findByRole('link', { name: /Vedi tutti/ });
    expect(seeAll.getAttribute('href')).toBe('/browse?kind=movie&category=film');
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/video/media/images/k-a?w=320');
    expect(img?.getAttribute('srcset')).toMatch(/w=160 160w/);
  });
});
