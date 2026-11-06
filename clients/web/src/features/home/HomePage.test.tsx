import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../../api/keys.ts';
import { problem, renderApp } from '../../test/renderApp.tsx';

const profile = { id: 'p1', name: 'Simone', token: 't' };
const HOME = {
  rows: [{ id: 'recently_added', title: 'Aggiunti di recente', items: [{ id: 'i1', kind: 'movie', title: 'Arrival', year: 2016, badges: [], available: true }], nextCursor: null }],
};
// What the gateway answers while the Video Service is down (deploy/Caddyfile).
const gatewayDown = () => problem(503, 'MEDIA_UNAVAILABLE', { detail: 'The Video Service is not reachable' }, { 'Retry-After': '5' });

afterEach(() => {
  vi.useRealTimers();
});

describe('Home while the Video Service is down', () => {
  it('says the service does not answer (not a disk), retries after Retry-After by itself and loads once the service is back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    renderApp('/', { 'GET /video/api/v1/home': () => (++calls <= 3 ? gatewayDown() : HOME) }, { profile });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Il servizio non risponde in questo momento.');
    expect(alert.textContent).toContain('Riprovo da solo tra poco');
    expect(alert.textContent).not.toMatch(/disco|MEDIA_UNAVAILABLE/);

    // Retry-After is followed: nothing before 5 s.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => expect(calls).toBe(2));
    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => expect(calls).toBe(3));
    expect(screen.getByRole('alert').textContent).toContain('Il servizio non risponde');

    // The service is back: the page loads without "Riprova".
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await screen.findByRole('heading', { name: 'Aggiunti di recente' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed background refetch keeps the rows already shown', async () => {
    let fail = false;
    const app = renderApp('/', { 'GET /video/api/v1/home': () => (fail ? problem(404, 'NOT_FOUND') : HOME) }, { profile });
    await screen.findByRole('heading', { name: 'Aggiunti di recente' });

    fail = true;
    await app.services.queryClient.refetchQueries({ queryKey: keys.home });
    await waitFor(() => expect(app.services.queryClient.getQueryState(keys.home)?.status).toBe('error'));
    expect(screen.getByRole('heading', { name: 'Aggiunti di recente' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
