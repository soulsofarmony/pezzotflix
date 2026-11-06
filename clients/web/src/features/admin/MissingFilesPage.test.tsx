import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FileItem, MediaFileEntry } from '../../api/types.ts';
import { problem, renderApp, type Routes } from '../../test/renderApp.tsx';
import { fileItemLabel, ruleLine } from './MissingFilesPage.tsx';

const NOV5 = Date.parse('2026-11-05T12:00:00Z');

const ROOTS = {
  roots: [
    { id: 'r1', name: 'Film', mountPath: '/media/Film', hint: 'movies', status: 'online', lastScanAt: NOV5, fileCount: 40, held: null },
    { id: 'r2', name: 'Serie', mountPath: '/media/Serie', hint: 'series', status: 'online', lastScanAt: NOV5, fileCount: 12, held: null },
    { id: 'r3', name: 'Archivio', mountPath: '/media/Archivio', hint: 'movies', status: 'offline', lastScanAt: NOV5, fileCount: 3, held: null },
    { id: 'r4', name: 'Disco', mountPath: '/media/Disco', hint: 'movies', status: 'offline', lastScanAt: NOV5, fileCount: 30, held: { reason: 'mass_missing', missingFiles: 28, confirmed: false } },
  ],
};

const ARRIVAL: MediaFileEntry = {
  fileId: 'f1',
  rootId: 'r1',
  rootName: 'Film',
  relPath: 'Arrival (2016)/Arrival (2016).mkv',
  state: 'missing',
  sizeBytes: 48_300_000_000,
  missingSince: NOV5,
  items: [{ id: 'i1', kind: 'movie', title: 'Arrival', year: 2016, seriesTitle: null, seasonNumber: null, episodeNumber: null }],
};
const DARK: MediaFileEntry = {
  fileId: 'f2',
  rootId: 'r2',
  rootName: 'Serie',
  relPath: 'Dark (2017)/Season 01/Dark - S01E02.mkv',
  state: 'missing',
  sizeBytes: 2_000_000_000,
  missingSince: null,
  items: [{ id: 'e2', kind: 'episode', title: 'Bugie', year: null, seriesTitle: 'Dark', seasonNumber: 1, episodeNumber: 2 }],
};
const ORPHAN: MediaFileEntry = { ...ARRIVAL, fileId: 'f3', relPath: 'Sample.mkv', items: [] };

const page = (files: MediaFileEntry[], extra: { total?: number; autoRemoveAfterDays?: number } = {}) => ({
  files,
  nextCursor: null,
  total: extra.total ?? files.length,
  autoRemoveAfterDays: extra.autoRemoveAfterDays ?? 30,
});

/** The server side of the page: missing files per root, with the forget operations removing them. */
function routes(initial: MediaFileEntry[], overrides: Routes = {}): Routes {
  let files = [...initial];
  return {
    'GET /video/api/v1/admin/roots': () => ROOTS,
    'GET /video/api/v1/admin/files': ({ url }) => {
      const rootId = url.searchParams.get('rootId');
      return page(rootId ? files.filter((f) => f.rootId === rootId) : files);
    },
    'POST /video/api/v1/admin/files/{fileId}/forget': ({ params }) => {
      files = files.filter((f) => f.fileId !== params.fileId);
      return { forgotten: 1 };
    },
    'POST /video/api/v1/admin/roots/{rootId}/forget-missing': ({ params }) => {
      const n = files.filter((f) => f.rootId === params.rootId).length;
      files = files.filter((f) => f.rootId !== params.rootId);
      return { forgotten: n };
    },
    ...overrides,
  };
}

const rowOf = (path: string) => screen.getByText(path).closest('li')!;

describe('File mancanti', () => {
  it('is in the admin navigation', async () => {
    renderApp('/admin/roots', { 'GET /video/api/v1/admin/roots': () => ROOTS });
    const nav = await screen.findByRole('navigation', { name: 'Sezioni della gestione' });
    expect(within(nav).getByRole('link', { name: 'File mancanti' }).getAttribute('href')).toBe('/admin/files');
  });

  it('lists the missing files with their library, date, size and titles, and explains the automatic rule', async () => {
    renderApp('/admin/files', routes([ARRIVAL, DARK, ORPHAN]));
    expect(await screen.findByText('I file mancanti da più di 30 giorni vengono dimenticati da soli, se la loro libreria è in linea.')).toBeTruthy();
    expect(screen.getByText('File mancanti: 3')).toBeTruthy();
    const arrival = rowOf(ARRIVAL.relPath);
    expect(within(arrival).getByText(/^Film · Mancante dal 5 novembre 2026 · 48,3\sGB$/)).toBeTruthy();
    expect(within(arrival).getByText('Titoli: Arrival (2016)')).toBeTruthy();
    const dark = rowOf(DARK.relPath);
    expect(within(dark).getByText(/^Serie · Mancante · /)).toBeTruthy();
    expect(within(dark).getByText('Titoli: Dark · S1E2 · Bugie')).toBeTruthy();
    expect(within(rowOf('Sample.mkv')).getByText('Nessun titolo collegato')).toBeTruthy();
    // The visible label "Dimentica" is in each button's name, with the path that tells the rows apart.
    expect(within(arrival).getByRole('button', { name: `Dimentica ${ARRIVAL.relPath}` }).textContent).toBe('Dimentica');
    // No library chosen: no bulk action.
    expect(screen.queryByRole('button', { name: 'Dimentica tutti i mancanti di questa libreria' })).toBeNull();
  });

  it('forgets one file after an in-app confirmation; "Annulla" sends nothing', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const app = renderApp('/admin/files', routes([ARRIVAL, DARK]));
    const forget = await screen.findByRole('button', { name: `Dimentica ${ARRIVAL.relPath}` });
    await app.user.click(forget);
    let dialog = await screen.findByRole('dialog', { name: 'Dimenticare questo file?' });
    expect(within(dialog).getByText(ARRIVAL.relPath)).toBeTruthy();
    expect(within(dialog).getByText(/I titoli che restano senza file spariscono dal catalogo/)).toBeTruthy();
    await app.user.click(within(dialog).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.requests.filter((r) => r.method === 'POST')).toEqual([]);

    await app.user.click(screen.getByRole('button', { name: `Dimentica ${ARRIVAL.relPath}` }));
    dialog = await screen.findByRole('dialog', { name: 'Dimenticare questo file?' });
    await app.user.click(within(dialog).getByRole('button', { name: 'Dimentica' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/video/api/v1/admin/files/f1/forget']);
    const status = await screen.findByText('File dimenticato.');
    expect(status.getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(status);
    await waitFor(() => expect(screen.queryByText(ARRIVAL.relPath)).toBeNull());
    expect(screen.getByText(DARK.relPath)).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a file that came back meanwhile (409) is explained in the dialog; closing it, the focus goes to the status line', async () => {
    let back = false;
    const app = renderApp(
      '/admin/files',
      routes([ARRIVAL, DARK], {
        'POST /video/api/v1/admin/files/{fileId}/forget': () => {
          back = true;
          return problem(409, 'CONFLICT');
        },
        'GET /video/api/v1/admin/files': () => page(back ? [DARK] : [ARRIVAL, DARK]),
      }),
    );
    await app.user.click(await screen.findByRole('button', { name: `Dimentica ${ARRIVAL.relPath}` }));
    const dialog = await screen.findByRole('dialog');
    await app.user.click(within(dialog).getByRole('button', { name: 'Dimentica' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Il file non risulta più mancante: è tornato, oppure è già stato dimenticato. L’elenco è aggiornato.');
    // The refetch took the row, and the button that opened the dialog, off the page.
    await waitFor(() => expect(screen.queryByRole('button', { name: `Dimentica ${ARRIVAL.relPath}` })).toBeNull());
    await app.user.click(within(dialog).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('status'));
  });

  it('a stale library in the URL falls back to every library', async () => {
    const app = renderApp('/admin/files?rootId=gone', {
      ...routes([ARRIVAL, DARK]),
      'GET /video/api/v1/admin/files': ({ url }) => (url.searchParams.get('rootId') === 'gone' ? problem(404, 'NOT_FOUND') : page([ARRIVAL, DARK])),
    });
    expect(await screen.findByText(ARRIVAL.relPath)).toBeTruthy();
    expect(screen.getByText(DARK.relPath)).toBeTruthy();
    await waitFor(() => expect(app.router.state.location.search).toEqual({}));
    expect(screen.getByLabelText<HTMLSelectElement>('Libreria').value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('forgets every missing file of the chosen library, the count in the confirmation', async () => {
    const other = { ...ARRIVAL, fileId: 'f9', relPath: 'Dune (2021)/Dune.mkv' };
    const app = renderApp('/admin/files', routes([ARRIVAL, other, DARK]));
    await screen.findByRole('option', { name: 'Film' });
    await app.user.selectOptions(screen.getByLabelText('Libreria'), 'Film');
    await waitFor(() => expect(screen.queryByText(DARK.relPath)).toBeNull());
    expect(app.requests.some((r) => r.path === '/video/api/v1/admin/files' && r.search.includes('rootId=r1'))).toBe(true);
    await app.user.click(await screen.findByRole('button', { name: 'Dimentica tutti i mancanti di questa libreria' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dimenticare i file mancanti di Film?' });
    expect(within(dialog).getByText('Vengono dimenticati tutti i file mancanti di Film: 2.')).toBeTruthy();
    await app.user.click(within(dialog).getByRole('button', { name: 'Dimentica 2 file' }));
    expect(await screen.findByText('File dimenticati: 2.')).toBeTruthy();
    expect(app.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/video/api/v1/admin/roots/r1/forget-missing']);
    expect(await screen.findByText('Nessun file mancante in questa libreria.')).toBeTruthy();
  });

  it('the count of the bulk confirmation is the total, also beyond the loaded page', async () => {
    const app = renderApp('/admin/files?rootId=r1', {
      ...routes([ARRIVAL]),
      'GET /video/api/v1/admin/files': () => ({ ...page([ARRIVAL], { total: 120 }), nextCursor: 'c2' }),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Dimentica tutti i mancanti di questa libreria' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Dimentica 120 file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mostra altri' })).toBeTruthy();
  });

  it.each([
    ['r3', 'Archivio'],
    ['r4', 'Disco'],
  ])('no bulk forget on an offline or held library (%s)', async (rootId, name) => {
    renderApp(`/admin/files?rootId=${rootId}`, routes([{ ...ARRIVAL, rootId, rootName: name }]));
    const button = await screen.findByRole('button', { name: 'Dimentica tutti i mancanti di questa libreria' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('note').textContent).toBe(
      `${name} non è raggiungibile o è sospesa: i suoi file mancanti non si dimenticano tutti insieme, perché potrebbe essere solo un disco scollegato.`,
    );
  });

  it('says so when nothing is missing, and when the automatic removal is off', async () => {
    renderApp('/admin/files', { ...routes([]), 'GET /video/api/v1/admin/files': () => page([], { autoRemoveAfterDays: 0 }) });
    expect(await screen.findByText('Nessun file mancante.')).toBeTruthy();
    expect(screen.getByText('La rimozione automatica è disattivata: i file mancanti restano finché non li dimentichi.')).toBeTruthy();
  });

  it('shows a failed load with "Riprova"', async () => {
    let calls = 0;
    const app = renderApp('/admin/files', {
      ...routes([ARRIVAL]),
      'GET /video/api/v1/admin/files': () => (++calls === 1 ? problem(400, 'VALIDATION_FAILED') : page([ARRIVAL])),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Alcuni dati non sono validi.');
    await app.user.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByText(ARRIVAL.relPath)).toBeTruthy();
  });
});

describe('ruleLine', () => {
  it.each([
    [30, 'I file mancanti da più di 30 giorni vengono dimenticati da soli, se la loro libreria è in linea.'],
    [1, 'I file mancanti da più di un giorno vengono dimenticati da soli, se la loro libreria è in linea.'],
    [0, 'La rimozione automatica è disattivata: i file mancanti restano finché non li dimentichi.'],
  ])('%d days', (days, line) => expect(ruleLine(days)).toBe(line));
});

describe('fileItemLabel', () => {
  const base: FileItem = { id: 'x', kind: 'movie', title: 'Arrival', year: 2016, seriesTitle: null, seasonNumber: null, episodeNumber: null };
  it.each<[FileItem, string]>([
    [base, 'Arrival (2016)'],
    [{ ...base, year: null }, 'Arrival'],
    [{ ...base, kind: 'extra', title: 'Trailer', year: null }, 'Extra · Trailer'],
    [{ ...base, kind: 'episode', title: 'Bugie', year: null, seriesTitle: 'Dark', seasonNumber: 1, episodeNumber: 2 }, 'Dark · S1E2 · Bugie'],
    [{ ...base, kind: 'episode', title: 'Bugie', year: null, seriesTitle: null, seasonNumber: null, episodeNumber: null }, 'Bugie'],
    [{ ...base, kind: 'season', title: 'Stagione 1', year: null, seriesTitle: 'Dark', seasonNumber: 1 }, 'Dark · Stagione 1'],
  ])('%j → %s', (item, label) => expect(fileItemLabel(item)).toBe(label));
});
