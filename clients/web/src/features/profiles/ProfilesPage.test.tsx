import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PREFS, problem, renderApp } from '../../test/renderApp.tsx';

const simone = { id: 'p1', name: 'Simone', prefs: PREFS };
const HOME = {
  rows: [
    {
      id: 'recently_added',
      title: 'Aggiunti di recente',
      items: [{ id: 'i1', kind: 'movie', title: 'Arrival', year: 2016, badges: ['4K', 'HDR10'], available: true }],
      nextCursor: null,
    },
  ],
};

describe('profile choice', () => {
  it('without a profile every catalog page goes to "Chi guarda?"', async () => {
    renderApp('/browse', { 'GET /video/api/v1/profiles': () => ({ profiles: [simone] }) });
    expect(await screen.findByRole('heading', { name: 'Chi guarda?' })).toBeTruthy();
  });

  it('picking a profile stores its token and opens the Home with it', async () => {
    const app = renderApp('/profiles', {
      'GET /video/api/v1/profiles': () => ({ profiles: [simone] }),
      'POST /video/api/v1/profiles/{profileId}/select': ({ params }) => ({ profileToken: `tok-${params.profileId}`, profile: simone }),
      'GET /video/api/v1/home': () => HOME,
    });
    await app.user.click(await screen.findByRole('button', { name: 'Guarda come Simone' }));
    expect(await screen.findByRole('heading', { name: 'Aggiunti di recente' })).toBeTruthy();
    expect(app.services.store.get()).toEqual({ id: 'p1', name: 'Simone', token: 'tok-p1' });
    expect(app.requests.find((r) => r.path === '/video/api/v1/home')?.auth).toBe('Bearer tok-p1');
    // Profile operations are public: no token on them.
    expect(app.requests.find((r) => r.path === '/video/api/v1/profiles')?.auth).toBeNull();
  });

  it('the visible label of a profile button is its name alone (label in name): the initial is drawn by CSS', async () => {
    renderApp('/profiles', { 'GET /video/api/v1/profiles': () => ({ profiles: [simone] }) });
    const button = await screen.findByRole('button', { name: 'Guarda come Simone' });
    expect(button.textContent).toBe('Simone');
    expect(button.querySelector('[data-initial]')?.getAttribute('data-initial')).toBe('S');
  });

  it('creates a profile; a taken name is explained', async () => {
    let calls = 0;
    const app = renderApp('/profiles', {
      'GET /video/api/v1/profiles': () => ({ profiles: [simone] }),
      'POST /video/api/v1/profiles': ({ body }) => {
        calls += 1;
        return calls === 1 ? problem(409, 'CONFLICT') : { ...simone, id: 'p2', name: (body as { name: string }).name };
      },
    });
    await app.user.click(await screen.findByRole('button', { name: 'Aggiungi profilo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuovo profilo' });
    await app.user.type(within(dialog).getByLabelText('Nome'), 'Simone');
    await app.user.click(within(dialog).getByRole('button', { name: 'Salva' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Esiste già un profilo con questo nome.');
    await app.user.clear(within(dialog).getByLabelText('Nome'));
    await app.user.type(within(dialog).getByLabelText('Nome'), 'Giulia');
    await app.user.click(within(dialog).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([{ name: 'Simone' }, { name: 'Giulia' }]);
  });

  it('renames a profile from "Gestisci profili"', async () => {
    const app = renderApp('/profiles', {
      'GET /video/api/v1/profiles': () => ({ profiles: [simone] }),
      'PATCH /video/api/v1/profiles/{profileId}': ({ body }) => ({ ...simone, ...(body as object) }),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Gestisci profili' }));
    await app.user.click(screen.getByRole('button', { name: /Rinomina Simone/ }));
    const input = within(await screen.findByRole('dialog')).getByLabelText('Nome');
    await app.user.clear(input);
    await app.user.type(input, 'Simo');
    await app.user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(app.requests.some((r) => r.method === 'PATCH')).toBe(true));
    expect(app.requests.find((r) => r.method === 'PATCH')?.body).toMatchObject({ name: 'Simo', prefs: PREFS });
  });

  it('a rename to a taken name (409) is explained', async () => {
    const app = renderApp('/profiles', {
      'GET /video/api/v1/profiles': () => ({ profiles: [simone, { ...simone, id: 'p2', name: 'Giulia' }] }),
      'PATCH /video/api/v1/profiles/{profileId}': () => problem(409, 'CONFLICT'),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Gestisci profili' }));
    await app.user.click(screen.getByRole('button', { name: /Rinomina Simone/ }));
    const dialog = await screen.findByRole('dialog');
    await app.user.clear(within(dialog).getByLabelText('Nome'));
    await app.user.type(within(dialog).getByLabelText('Nome'), 'Giulia');
    await app.user.click(within(dialog).getByRole('button', { name: 'Salva' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Esiste già un profilo con questo nome.');
  });

  it('a 401 on a profile operation clears the token and goes back to the choice', async () => {
    const app = renderApp(
      '/',
      {
        'GET /video/api/v1/profiles': () => ({ profiles: [simone] }),
        'GET /video/api/v1/home': () => problem(401, 'UNAUTHORIZED'),
      },
      { profile: { id: 'p1', name: 'Simone', token: 'stale' } },
    );
    expect(await screen.findByRole('heading', { name: 'Chi guarda?' })).toBeTruthy();
    expect(app.services.store.get()).toBeNull();
  });
});

describe('selected profile', () => {
  it('renaming the selected profile shows the new name in the header and keeps its token', async () => {
    let name = 'Simone';
    const app = renderApp(
      '/profiles',
      {
        'GET /video/api/v1/profiles': () => ({ profiles: [{ ...simone, name }, { ...simone, id: 'p2', name: 'Giulia' }] }),
        'PATCH /video/api/v1/profiles/{profileId}': ({ params, body }) => {
          if (params.profileId === 'p1') name = (body as { name: string }).name;
          return { ...simone, id: params.profileId, ...(body as object) };
        },
      },
      { profile: { id: 'p1', name: 'Simone', token: 'tok-p1' } },
    );
    expect(await screen.findByText('Simone', { selector: 'header a span' })).toBeTruthy();
    await app.user.click(await screen.findByRole('button', { name: 'Gestisci profili' }));
    await app.user.click(screen.getByRole('button', { name: /Rinomina Simone/ }));
    const input = within(await screen.findByRole('dialog')).getByLabelText('Nome');
    await app.user.clear(input);
    await app.user.type(input, 'Simo');
    await app.user.click(screen.getByRole('button', { name: 'Salva' }));
    expect(await screen.findByText('Simo', { selector: 'header a span' })).toBeTruthy();
    expect(app.services.store.get()).toEqual({ id: 'p1', name: 'Simo', token: 'tok-p1' });

    // Renaming another profile leaves the selected one alone.
    await app.user.click(screen.getByRole('button', { name: /Rinomina Giulia/ }));
    const other = within(await screen.findByRole('dialog')).getByLabelText('Nome');
    await app.user.clear(other);
    await app.user.type(other, 'Giu');
    await app.user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(app.requests.filter((r) => r.method === 'PATCH')).toHaveLength(2));
    expect(app.services.store.get()).toEqual({ id: 'p1', name: 'Simo', token: 'tok-p1' });
  });

  it('a profile picked in another tab drops the cached view of the previous one: the page refetches with the new token', async () => {
    const rowsOf = (who: string) => ({ rows: [{ id: 'recently_added', title: `Aggiunti per ${who}`, items: HOME.rows[0]!.items, nextCursor: null }] });
    const app = renderApp(
      '/',
      { 'GET /video/api/v1/home': ({ req }) => rowsOf(req.headers.get('Authorization') === 'Bearer tok-p2' ? 'Giulia' : 'Simone') },
      { profile: { id: 'p1', name: 'Simone', token: 'tok-p1' } },
    );
    await screen.findByRole('heading', { name: 'Aggiunti per Simone' });

    const giulia = { id: 'p2', name: 'Giulia', token: 'tok-p2' };
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'pezzotflix.profile', newValue: JSON.stringify(giulia) }));
    });
    expect(await screen.findByRole('heading', { name: 'Aggiunti per Giulia' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Aggiunti per Simone' })).toBeNull();
    expect(screen.getByText('Giulia', { selector: 'header a span' })).toBeTruthy();
    expect(app.services.store.get()).toEqual(giulia);
  });

  it('a rename in another tab (same profile, same token) only changes the name', async () => {
    const app = renderApp('/', { 'GET /video/api/v1/home': () => HOME }, { profile: { id: 'p1', name: 'Simone', token: 'tok-p1' } });
    await screen.findByRole('heading', { name: 'Aggiunti di recente' });
    const homeCalls = () => app.requests.filter((r) => r.path === '/video/api/v1/home').length;
    const before = homeCalls();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'pezzotflix.profile', newValue: JSON.stringify({ id: 'p1', name: 'Simo', token: 'tok-p1' }) }));
    });
    expect(await screen.findByText('Simo', { selector: 'header a span' })).toBeTruthy();
    expect(homeCalls()).toBe(before);
  });
});

describe('profile dialog focus', () => {
  it('Annulla gives the focus back to the button that opened the dialog', async () => {
    const app = renderApp('/profiles', { 'GET /video/api/v1/profiles': () => ({ profiles: [simone] }) });
    const add = await screen.findByRole('button', { name: 'Aggiungi profilo' });
    await app.user.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Nuovo profilo' });
    await app.user.click(within(dialog).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(add);
  });

  it('where the browser has dialog.close(), the dialog closes through it, and a save gives the focus back too', async () => {
    // jsdom has no modal dialog: a stand-in that behaves like the browser's (close fires "close" as a task).
    const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
    let closes = 0;
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto.close = function (this: HTMLDialogElement) {
      closes += 1;
      this.removeAttribute('open');
      setTimeout(() => this.dispatchEvent(new Event('close')), 0);
    };
    try {
      const app = renderApp('/profiles', {
        'GET /video/api/v1/profiles': () => ({ profiles: [simone] }),
        'PATCH /video/api/v1/profiles/{profileId}': ({ body }) => ({ ...simone, ...(body as object) }),
      });
      await app.user.click(await screen.findByRole('button', { name: 'Gestisci profili' }));
      const rename = screen.getByRole('button', { name: /Rinomina Simone/ });
      await app.user.click(rename);
      const input = within(await screen.findByRole('dialog')).getByLabelText('Nome');
      await app.user.clear(input);
      await app.user.type(input, 'Simo');
      await app.user.click(screen.getByRole('button', { name: 'Salva' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(closes).toBe(1);
      expect(document.activeElement).toBe(rename);
    } finally {
      delete proto.showModal;
      delete proto.close;
    }
  });
});
