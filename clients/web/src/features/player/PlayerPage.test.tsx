import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { problem, renderApp } from '../../test/renderApp.tsx';

const profile = { id: 'p1', name: 'Simone', token: 't' };
const ITEM = { id: 'i1', kind: 'movie', title: 'Arrival', year: 2016, badges: [], available: true, genres: [], credits: [], children: [], extras: [], versions: [] };

describe('player page', () => {
  it('takes the focus when it opens, so the keyboard shortcuts reach it before any control has the focus', async () => {
    renderApp(
      '/watch/i1?t=0',
      {
        'GET /video/api/v1/items/{itemId}': () => ITEM,
        'POST /video/api/v1/playback/sessions': () => problem(422, 'NO_COMPATIBLE_PLAN'),
      },
      { profile },
    );
    await screen.findByRole('heading', { level: 1, name: /Arrival/ });
    await waitFor(() => expect(document.activeElement?.hasAttribute('data-phase')).toBe(true));
    // Script focus only: the surface is not a tab stop.
    expect((document.activeElement as HTMLElement).tabIndex).toBe(-1);
  });
});
