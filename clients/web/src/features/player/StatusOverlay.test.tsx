import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PlaybackSession } from '../../api/types.ts';
import type { PlayerController, PlayerSnapshot } from '../../player/controller.ts';
import { StatusOverlay } from './StatusOverlay.tsx';

function setup(snap: Partial<PlayerSnapshot>) {
  const controller = { retry: vi.fn(() => Promise.resolve()), terminateOther: vi.fn(() => Promise.resolve()), play: vi.fn(), dismissNotice: vi.fn() };
  const onExit = vi.fn();
  const full = { phase: 'idle', session: null, failures: [], attempts: 0, activeSessions: [], error: null, notice: null, positionMs: 0, autoplayBlocked: false, buffering: false, terminatedReason: null, ...snap } as PlayerSnapshot;
  render(<StatusOverlay snap={full} controller={controller as unknown as PlayerController} onExit={onExit} />);
  return { controller, onExit, user: userEvent.setup() };
}

describe('player status overlays', () => {
  it('503 STREAM_PREPARING shows "in preparazione"', () => {
    setup({ phase: 'preparing' });
    expect(screen.getByRole('status').textContent).toMatch(/In preparazione/);
  });

  it('after the automatic attempts: reasons, last failure and "Riprova"', async () => {
    const { controller, onExit, user } = setup({
      phase: 'failed',
      attempts: 3,
      session: { reasons: ['Audio TrueHD non supportato: conversione in FLAC'] } as PlaybackSession,
      failures: [{ suspect: 'audio', error: 'bufferAddCodecError', at: 0 }],
    });
    expect(screen.getByRole('alertdialog', { name: 'Non riesco a riprodurre questo titolo' })).toBeTruthy();
    expect(screen.getByText(/Ho provato 3 volte/)).toBeTruthy();
    expect(screen.getByText('Audio TrueHD non supportato: conversione in FLAC')).toBeTruthy();
    expect(screen.getByText(/bufferAddCodecError.*audio/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(controller.retry).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Indietro' }));
    expect(onExit).toHaveBeenCalled();
  });

  it('SESSION_LIMIT_REACHED offers to stop the other session', async () => {
    const { controller, user } = setup({
      phase: 'session_limit',
      activeSessions: [{ sessionId: 'other', profileId: 'p2', profileName: 'Giulia', itemId: 'i2', itemTitle: 'Dune', mode: 'direct_play', startedAt: 0 }],
    });
    await user.click(screen.getByRole('button', { name: 'Interrompi «Dune» (Giulia)' }));
    expect(controller.terminateOther).toHaveBeenCalledWith('other');
  });

  it('422 NO_COMPATIBLE_PLAN shows the server reason', () => {
    setup({ phase: 'no_plan', error: { code: 'NO_COMPATIBLE_PLAN', detail: '4K: serve un Transcode, non disponibile nell’MVP' } });
    expect(screen.getByText('4K: serve un Transcode, non disponibile nell’MVP')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Riprova' })).toBeNull();
  });

  it('an unexpected server error is explained in Italian; the code and the server detail stay as a technical line', () => {
    setup({ phase: 'error', error: { code: 'INTERNAL', detail: 'Unexpected server error' } });
    expect(screen.getByText('Qualcosa è andato storto.')).toBeTruthy();
    expect(screen.getByText('Codice: INTERNAL · Unexpected server error')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy();
  });

  it('an expired session offers to resume from the last position', async () => {
    const { controller, user } = setup({ phase: 'expired', positionMs: 3_723_000 });
    await user.click(screen.getByRole('button', { name: 'Riprendi da 1:02:03' }));
    expect(controller.retry).toHaveBeenCalled();
  });

  it("a refused change (422) is a dismissable notice with the server's reason, not a dialog", async () => {
    const { controller, user } = setup({ phase: 'ready', notice: { code: 'NO_COMPATIBLE_PLAN', detail: 'E-AC-3 7.1: no decoder on this client' } });
    const notice = screen.getByRole('status');
    expect(notice.textContent).toMatch(/non si può riprodurre su questo dispositivo/);
    expect(notice.textContent).toMatch(/E-AC-3 7\.1: no decoder on this client/);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Chiudi' }));
    expect(controller.dismissNotice).toHaveBeenCalled();
  });

  it.each([
    ['expired', /non riceveva più segnali/],
    ['terminated', /interrotta da un altro dispositivo o profilo/],
    ['failed', /non restano altre modalità/],
    ['item_removed', /tolto dalla libreria/],
    ['something_new', /^Motivo: something_new$/],
  ])('a terminated session explains the reason %s in Italian', (reason, text) => {
    setup({ phase: 'terminated', terminatedReason: reason, positionMs: 61_000 });
    expect(screen.getByText(text)).toBeTruthy();
    // A title that left the library cannot be resumed; the others can.
    expect(screen.queryByRole('button', { name: 'Riprendi da 1:01' }) === null).toBe(reason === 'item_removed');
  });

  it('a refused change without a reason shows the notice alone', () => {
    setup({ phase: 'ready', notice: { code: 'NO_COMPATIBLE_PLAN', detail: null } });
    expect(screen.getByRole('status').querySelectorAll('p')).toHaveLength(1);
  });
});
