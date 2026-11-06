import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/renderApp.tsx';

const profile = { id: 'p1', name: 'Simone', token: 't' };
const result = { id: 'i1', kind: 'movie', title: 'Arrival', year: 2016, badges: [], available: true };

describe('search', () => {
  it.each([
    ['no query', '/search'],
    ['a query of spaces only', '/search?q=%20%20%20'],
  ])('%s: the hint, no spinner and no request', async (_name, path) => {
    const app = renderApp(path, { 'GET /video/api/v1/search': () => ({ items: [result] }) }, { profile });
    expect(await screen.findByText('Scrivi un titolo, anche quello originale.')).toBeTruthy();
    expect(screen.queryByText('Caricamento…')).toBeNull();
    expect(app.requests.some((r) => r.path === '/video/api/v1/search')).toBe(false);
  });

  it('searches the trimmed text', async () => {
    const app = renderApp('/search?q=%20Arrival%20', { 'GET /video/api/v1/search': () => ({ items: [result] }) }, { profile });
    expect(await screen.findByRole('link', { name: 'Arrival · 2016' })).toBeTruthy();
    expect(app.requests.find((r) => r.path === '/video/api/v1/search')?.search).toContain('q=Arrival&');
  });
});
