import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/renderApp.tsx';
import { jobErrorLabel } from './IngestPage.tsx';

const ENOENT = "ENOENT: no such file or directory, stat '/media/Film/Arrival (2016)/Arrival (2016).mkv'";

const STATUS = {
  running: false,
  queued: 0,
  files: { analyzed: 3, needs_review: 1, identified: 40, some_new_state: 2 },
  jobs: { 'analyzer.probe': { done: 43, failed: 1 }, 'some.new_job': { done: 1 } },
  failed: [
    { jobId: 'j1', type: 'analyzer.probe', error: ENOENT, attempts: 3 },
    { jobId: 'j2', type: 'metadata.enrich', error: 'tmdb answered 500', attempts: 5 },
  ],
};

describe('Ingest page', () => {
  it('names file states, job types and known job errors in Italian, with the raw value when unknown', async () => {
    renderApp('/admin/ingest', { 'GET /video/api/v1/admin/ingest': () => STATUS });
    expect(await screen.findByText('Analizzati, da riconoscere', { selector: 'dt' })).toBeTruthy();
    expect(screen.getByText('Da verificare', { selector: 'dt' })).toBeTruthy();
    expect(screen.getByText('Riconosciuti', { selector: 'dt' })).toBeTruthy();
    expect(screen.getByText('some_new_state', { selector: 'dt' })).toBeTruthy();

    expect(screen.getByRole('rowheader', { name: 'Analisi dei file' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'some.new_job' })).toBeTruthy();

    const failed = screen.getAllByRole('listitem').filter((li) => within(li).queryByRole('button', { name: 'Riprova' }));
    expect(failed).toHaveLength(2);
    const [probe, enrich] = failed;
    expect(within(probe!).getByText('Analisi dei file')).toBeTruthy();
    expect(within(probe!).getByText('Il file o la cartella non esiste più.')).toBeTruthy();
    // The server's text stays, as a technical line.
    expect(within(probe!).getByText(`Dettaglio tecnico: ${ENOENT}`)).toBeTruthy();
    expect(within(enrich!).getByText('Metadati e immagini')).toBeTruthy();
    expect(within(enrich!).getByText('tmdb answered 500')).toBeTruthy();
    expect(within(enrich!).queryByText(/Dettaglio tecnico/)).toBeNull();
  });
});

describe('jobErrorLabel', () => {
  it.each([
    [ENOENT, 'Il file o la cartella non esiste più.'],
    ["EACCES: permission denied, open '/media/x.mkv'", 'Permesso negato: il servizio non può leggere il file.'],
    ['EIO: i/o error, read', 'Errore di lettura dal disco.'],
    ['Command timed out after 60000 milliseconds: ffprobe -v error', 'Tempo scaduto: l’operazione non ha risposto in tempo.'],
    ['ffprobe printed invalid JSON: "x"', null],
    ['', null],
  ])('%s → %s', (error, label) => {
    expect(jobErrorLabel(error)).toBe(label);
  });
});
