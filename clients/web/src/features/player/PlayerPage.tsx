// Player screen: full window <video>, controls, track and version menu, "Perché questa modalità?" and the
// status overlays. All playback logic is in src/player (PlayerController); this file only renders its snapshot.
import { useNavigate, useRouter } from '@tanstack/react-router';
import { type KeyboardEvent, type ReactElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useItem } from '../../api/queries.ts';
import { useServices } from '../../app/services.tsx';
import { formatClock } from '../../i18n/format.ts';
import { t } from '../../i18n/t.ts';
import { browserPlayerDeps } from '../../player/browser.ts';
import { PlayerController, type StartOptions } from '../../player/controller.ts';
import { isLocalTrack } from '../../player/subtitles.ts';
import { Icon } from '../../ui/Icon.tsx';
import { InfoPanel, modeLabel, WhyPanel } from './Panels.tsx';
import { StatusOverlay } from './StatusOverlay.tsx';
import { TrackMenu } from './TrackMenu.tsx';
import styles from './player.module.css';

export interface PlayerPageProps {
  itemId: string;
  fileId?: string | undefined;
  startPositionMs?: number | undefined;
  audioTrackId?: string | undefined;
  forceMode?: StartOptions['forceMode'];
  /** Tests inject a controller with fake engines. */
  controller?: PlayerController;
}

type Panel = 'tracks' | 'why' | 'info' | null;

const HIDE_CONTROLS_MS = 3_000;

export function PlayerPage(props: PlayerPageProps): ReactElement {
  const services = useServices();
  const navigate = useNavigate();
  const router = useRouter();
  const [controller] = useState(() => props.controller ?? new PlayerController(browserPlayerDeps(services.playbackApi)));
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const item = useItem(props.itemId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSubtitle = useRef<string | null>(null);

  const { itemId, fileId, startPositionMs, audioTrackId, forceMode } = props;
  // An audio track from the link without a fileId is valid only on a single-version item: wait for the item.
  const versionCount = item.data?.versions.length;
  const waitForItem = audioTrackId !== undefined && fileId === undefined && item.isPending;
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    controller.attach(video);
    services.setActivePlayer(controller);
    // A later versionCount is the same start for the controller (a no-op while it plays).
    if (!waitForItem) void controller.start({ itemId, fileId, startPositionMs, audioTrackId, forceMode, versionCount });
    return () => {
      services.setActivePlayer(null);
      controller.detach();
    };
  }, [controller, services, itemId, fileId, startPositionMs, audioTrackId, forceMode, versionCount, waitForItem]);

  // The poller polls a hidden page at 15 s only while a session is active.
  useEffect(() => services.poller.refresh(), [services, snap.phase]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const poke = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), HIDE_CONTROLS_MS);
  }, []);
  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);

  const showControls = controlsVisible || !snap.playing || panel !== null;

  const toggleFullscreen = () => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.requestFullscreen?.();
  };

  // "C" follows the user's own choice: after "Nessuno" a forced track may still be on screen, and C turns
  // subtitles on rather than off again.
  const toggleSubtitles = () => {
    const s = snap.session;
    if (!s) return;
    if (snap.subtitleOn) {
      if (snap.subtitleTrackId) lastSubtitle.current = snap.subtitleTrackId;
      void controller.selectSubtitle(null);
      return;
    }
    const subs = s.tracks.subtitles;
    const target = subs.find((tr) => tr.id === lastSubtitle.current) ?? subs.find((tr) => isLocalTrack(tr) && !tr.forced) ?? subs.find(isLocalTrack);
    if (target) void controller.selectSubtitle(target.id);
  };

  const exit = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: '/item/$itemId', params: { itemId: props.itemId } });
  };

  // Shortcuts (ADR 0005 point 5): space/K, ←/→ 10 s, F, M, C. Not while a form control has the focus.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') setPanel(null);
      return;
    }
    poke();
    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        if (tag === 'BUTTON') return;
        e.preventDefault();
        controller.togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        controller.seekBy(-10_000);
        break;
      case 'ArrowRight':
        e.preventDefault();
        controller.seekBy(10_000);
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'm':
      case 'M':
        controller.toggleMute();
        break;
      case 'c':
      case 'C':
        toggleSubtitles();
        break;
      case 'Escape':
        if (panel) setPanel(null);
        break;
      default:
    }
  };

  const title = item.data?.title ?? '';
  const duration = snap.durationMs || snap.session?.durationMs || 0;
  const position = scrub ?? snap.positionMs;

  return (
    // The player surface takes the keyboard shortcuts; every control in it is a native element.
    // eslint-disable-next-line jsx-a11y-x/no-static-element-interactions
    <div
      ref={rootRef}
      className={`${styles.player} ${showControls ? '' : styles.idle}`}
      onKeyDown={onKeyDown}
      onMouseMove={poke}
      onPointerDown={poke}
      // Read by the Playwright specs (test/e2e): state of the controller on the original timeline.
      data-phase={snap.phase}
      data-mode={snap.session?.mode}
      data-protocol={snap.session?.stream.protocol}
      data-position-ms={snap.positionMs}
      data-timeline-offset-ms={snap.timelineOffsetMs}
      data-attempts={snap.attempts}
      data-subtitle={snap.subtitleTrackId ?? ''}
    >
      <h1 className="visually-hidden">{t('player.title', { title })}</h1>
      <div className={styles.stage}>
        {/* Captions come from <track> (sidecar WebVTT) or the PGS canvas libpgs adds next to the video. */}
        {/* eslint-disable-next-line jsx-a11y-x/media-has-caption */}
        <video ref={videoRef} className={styles.video} playsInline onClick={() => controller.togglePlay()} onDoubleClick={toggleFullscreen} />
      </div>

      <StatusOverlay snap={snap} controller={controller} onExit={exit} />

      <div className={styles.top}>
        <button type="button" className={styles.iconButton} onClick={exit}>
          <Icon name="back" />
          <span className="visually-hidden">{t('player.back')}</span>
        </button>
        <span className={styles.titleText} aria-hidden="true">
          {title}
        </span>
      </div>

      <div className={styles.bottom}>
        <div className={styles.seekRow}>
          <span className={styles.time}>{formatClock(position)}</span>
          <div className={styles.seekWrap}>
            <div className={styles.buffered} style={{ width: duration ? `${Math.min(100, (snap.bufferedMs / duration) * 100)}%` : 0 }} />
            {snap.session?.chapters.map((c) =>
              duration && c.startMs > 0 ? <span key={c.startMs} className={styles.chapterMark} style={{ left: `${(c.startMs / duration) * 100}%` }} title={c.title ?? undefined} /> : null,
            )}
            <input
              type="range"
              className={styles.seek}
              min={0}
              max={Math.max(duration, 1)}
              step={1000}
              value={Math.min(position, duration || position)}
              aria-label={t('player.seek')}
              aria-valuetext={t('player.seekValue', { position: formatClock(position), duration: formatClock(duration) })}
              disabled={snap.phase !== 'ready'}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={() => {
                if (scrub !== null) controller.seekTo(scrub);
                setScrub(null);
              }}
              onKeyUp={() => {
                if (scrub !== null) controller.seekTo(scrub);
                setScrub(null);
              }}
            />
          </div>
          <span className={styles.time}>{formatClock(duration)}</span>
        </div>
        <div className={styles.controls}>
          <button type="button" className={styles.iconButton} onClick={() => controller.togglePlay()} disabled={snap.phase !== 'ready'}>
            <Icon name={snap.playing ? 'pause' : 'play'} size={32} />
            <span className="visually-hidden">{snap.playing ? t('player.pause') : t('player.play')}</span>
          </button>
          <button type="button" className={styles.iconButton} onClick={() => controller.seekBy(-10_000)} disabled={snap.phase !== 'ready'}>
            <Icon name="replay10" />
            <span className="visually-hidden">{t('player.back10')}</span>
          </button>
          <button type="button" className={styles.iconButton} onClick={() => controller.seekBy(10_000)} disabled={snap.phase !== 'ready'}>
            <Icon name="forward10" />
            <span className="visually-hidden">{t('player.forward10')}</span>
          </button>
          <button type="button" className={styles.iconButton} onClick={() => controller.toggleMute()}>
            <Icon name={snap.muted || snap.volume === 0 ? 'mute' : 'volume'} />
            <span className="visually-hidden">{snap.muted ? t('player.unmute') : t('player.mute')}</span>
          </button>
          <input
            type="range"
            className={styles.volume}
            min={0}
            max={1}
            step={0.05}
            value={snap.muted ? 0 : snap.volume}
            aria-label={t('player.volume')}
            aria-valuetext={`${Math.round((snap.muted ? 0 : snap.volume) * 100)}%`}
            onChange={(e) => controller.setVolume(Number(e.target.value))}
          />
          {snap.session && <span className={styles.mode}>{modeLabel(snap.session.mode)}</span>}
          <span className={styles.spacer} />
          <button type="button" className={styles.textButton} onClick={() => setPanel(panel === 'why' ? null : 'why')} aria-expanded={panel === 'why'} disabled={!snap.session}>
            {t('player.why')}
          </button>
          <button type="button" className={styles.iconButton} onClick={() => setPanel(panel === 'info' ? null : 'info')} aria-expanded={panel === 'info'}>
            <Icon name="info" />
            <span className="visually-hidden">{t('player.info')}</span>
          </button>
          <button type="button" className={styles.iconButton} onClick={() => setPanel(panel === 'tracks' ? null : 'tracks')} aria-expanded={panel === 'tracks'} disabled={!snap.session}>
            <Icon name="subtitles" />
            <span className="visually-hidden">{t('player.tracks')}</span>
          </button>
          <button type="button" className={styles.iconButton} onClick={toggleFullscreen}>
            <Icon name={fullscreen ? 'exitFullscreen' : 'fullscreen'} />
            <span className="visually-hidden">{fullscreen ? t('player.exitFullscreen') : t('player.fullscreen')}</span>
          </button>
        </div>
        <p className="visually-hidden">{t('player.shortcuts')}</p>
      </div>

      {panel === 'tracks' && snap.session && <TrackMenu snap={snap} controller={controller} versions={item.data?.versions ?? []} onClose={() => setPanel(null)} />}
      {panel === 'why' && snap.session && <WhyPanel snap={snap} itemId={props.itemId} versions={item.data?.versions ?? []} onClose={() => setPanel(null)} />}
      {panel === 'info' && <InfoPanel snap={snap} onClose={() => setPanel(null)} />}
    </div>
  );
}

