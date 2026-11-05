import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MediaVersion, PlaybackSession, SessionTrack } from '../../api/types.ts';
import type { PlayerController, PlayerSnapshot } from '../../player/controller.ts';
import { TrackMenu } from './TrackMenu.tsx';

const base: Omit<SessionTrack, 'id' | 'type'> = {
  index: 1,
  codec: null,
  language: null,
  title: null,
  default: false,
  forced: false,
  sdh: false,
  commentary: false,
  channels: null,
  channelLayout: null,
  objectAudio: null,
  subtitleKind: null,
  selected: false,
  switchWithoutRestart: false,
  delivery: null,
  url: null,
  availability: 'complete',
};

const session = {
  sessionId: 's1',
  fileId: 'f1',
  tracks: {
    audio: [
      { ...base, id: 'a1', type: 'audio', codec: 'truehd', language: 'ita', channels: 8, channelLayout: '7.1', objectAudio: 'atmos', selected: true },
      { ...base, id: 'a2', type: 'audio', codec: 'eac3', language: 'eng', channels: 6, channelLayout: '5.1(side)' },
    ],
    subtitles: [
      { ...base, id: 's1', type: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'ita', subtitleKind: 'image', delivery: 'client_render', url: '/a.sup', switchWithoutRestart: true, availability: 'growing' },
      { ...base, id: 's2', type: 'subtitle', codec: 'subrip', language: 'eng', subtitleKind: 'text', forced: true, delivery: 'sidecar', url: '/b.vtt', switchWithoutRestart: true },
    ],
  },
} as unknown as PlaybackSession;

const versions = [
  { fileId: 'f1', label: '4K HDR10', available: true },
  { fileId: 'f2', label: '1080p', available: true },
  { fileId: 'f3', label: 'Director’s Cut', available: false },
] as unknown as MediaVersion[];

function setup(snap: Partial<PlayerSnapshot> = {}) {
  const controller = { selectAudio: vi.fn(() => Promise.resolve()), selectSubtitle: vi.fn(() => Promise.resolve()), selectVersion: vi.fn(() => Promise.resolve()) };
  const onClose = vi.fn();
  render(<TrackMenu snap={{ phase: 'ready', session, subtitleTrackId: null, subtitlePreparing: null, busy: false, ...snap } as PlayerSnapshot} controller={controller as unknown as PlayerController} versions={versions} onClose={onClose} />);
  return { controller, onClose, user: userEvent.setup() };
}

describe('TrackMenu', () => {
  it('lists every audio track with language, codec and channels', () => {
    setup();
    const audio = screen.getByRole('group', { name: 'Audio' });
    const radios = audio.querySelectorAll('input[type=radio]');
    expect(radios).toHaveLength(2);
    expect(audio.textContent).toMatch(/Italiano.*TrueHD.*7\.1/);
    expect(audio.textContent).toMatch(/Inglese.*E-AC-3.*5\.1/);
  });

  it('marks a growing subtitle "in preparazione" and switches subtitles through the controller', async () => {
    const { controller, user } = setup();
    expect(screen.getByText('in preparazione')).toBeTruthy();
    const subs = within(screen.getByRole('group', { name: 'Sottotitoli' }));
    await user.click(subs.getByRole('radio', { name: /Inglese/ }));
    expect(controller.selectSubtitle).toHaveBeenCalledWith('s2');
    await user.click(subs.getByRole('radio', { name: /Italiano.*in preparazione/ }));
    expect(controller.selectSubtitle).toHaveBeenCalledWith('s1');
  });

  it('audio and version changes go through the controller; unavailable versions are disabled', async () => {
    const { controller, user } = setup({ subtitleTrackId: 's2' });
    await user.click(within(screen.getByRole('group', { name: 'Audio' })).getByRole('radio', { name: /Inglese/ }));
    expect(controller.selectAudio).toHaveBeenCalledWith('a2');
    await user.click(screen.getByRole('radio', { name: '1080p' }));
    expect(controller.selectVersion).toHaveBeenCalledWith('f2');
    expect(screen.getByRole('radio', { name: 'Director’s Cut' }).matches(':disabled')).toBe(true);
    await user.click(screen.getByRole('radio', { name: 'Nessuno' }));
    expect(controller.selectSubtitle).toHaveBeenCalledWith(null);
  });

  it('is disabled while a change is running', () => {
    setup({ busy: true });
    for (const r of screen.getAllByRole('radio')) expect(r.matches(':disabled')).toBe(true);
  });

  it.each(['starting', 'replanning', 'failed', 'no_plan', 'network', 'expired', 'terminated', 'stopped'] as const)('is disabled in phase %s', (phase) => {
    setup({ phase });
    for (const r of screen.getAllByRole('radio')) expect(r.matches(':disabled')).toBe(true);
  });

  it('stays usable while the session waits for its stream ("in preparazione")', () => {
    setup({ phase: 'preparing' });
    for (const name of ['Audio', 'Sottotitoli']) {
      for (const r of within(screen.getByRole('group', { name })).getAllByRole('radio')) expect(r.matches(':disabled')).toBe(false);
    }
    expect(screen.getByRole('radio', { name: '1080p' }).matches(':disabled')).toBe(false);
  });

  it('marks a complete subtitle "in preparazione" while its url answers 503', () => {
    setup({ subtitleTrackId: 's2', subtitlePreparing: 's2' });
    const subs = within(screen.getByRole('group', { name: 'Sottotitoli' }));
    expect(subs.getByRole('radio', { name: /Inglese.*in preparazione/ })).toBeTruthy();
  });
});
