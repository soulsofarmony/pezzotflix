// Overlays for the player phases: starting, "in preparazione", re-plan, failures with reasons and "Riprova",
// session limit with "Interrompi l'altra", expired and terminated sessions.
import type { ReactElement, ReactNode } from 'react';
import { formatClock } from '../../i18n/format.ts';
import { t, tMaybe } from '../../i18n/t.ts';
import type { PlayerController, PlayerSnapshot } from '../../player/controller.ts';
import { MAX_AUTOMATIC_ATTEMPTS } from '../../player/failures.ts';
import { Icon } from '../../ui/Icon.tsx';
import styles from './player.module.css';

/** Italian text of a playback.session_terminated reason (contract Event); an unknown one is shown as it is. */
function terminatedReasonText(reason: string): string {
  return tMaybe(`player.terminatedReason.${reason}`, t('player.terminatedReason', { reason }));
}

function Busy({ text }: { text: string }): ReactElement {
  return (
    <div className={styles.overlay} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

function Dialog({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className={styles.overlay}>
      <div className={styles.overlayCard} role="alertdialog" aria-labelledby="player-status-title" aria-modal="false">
        <h2 id="player-status-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Reasons({ snap }: { snap: PlayerSnapshot }): ReactElement | null {
  const reasons = snap.session?.reasons ?? [];
  const last = snap.failures[snap.failures.length - 1];
  if (!reasons.length && !last) return null;
  return (
    <div className={styles.reasons}>
      {reasons.length > 0 && (
        <>
          <h3>{t('player.reasons')}</h3>
          <ul>
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {last && <p className="mono">{t('player.lastFailure', { error: last.error, suspect: last.suspect ?? '—' })}</p>}
    </div>
  );
}

export function StatusOverlay({ snap, controller, onExit }: { snap: PlayerSnapshot; controller: PlayerController; onExit: () => void }): ReactElement | null {
  const retry = (
    <button type="button" className="btn btn-primary" onClick={() => void controller.retry()}>
      {t('app.retry')}
    </button>
  );
  const exit = (
    <button type="button" className="btn" onClick={onExit}>
      {t('app.back')}
    </button>
  );

  switch (snap.phase) {
    case 'starting':
      return <Busy text={t('player.starting')} />;
    case 'preparing':
      return <Busy text={t('player.preparing')} />;
    case 'replanning':
      return <Busy text={t('player.replanning')} />;
    case 'ready':
      if (snap.autoplayBlocked) {
        return (
          <div className={styles.overlay}>
            <button type="button" className={styles.bigPlay} onClick={() => controller.play()}>
              <Icon name="play" size={56} />
              <span className="visually-hidden">{t('player.play')}</span>
            </button>
            <p>{t('player.autoplayBlocked')}</p>
          </div>
        );
      }
      if (snap.notice)
        return (
          <div className={styles.notice} role="status">
            <p>{t('player.notice422')}</p>
            {snap.notice.detail && <p className="muted">{snap.notice.detail}</p>}
            <button type="button" className="btn btn-ghost" onClick={() => controller.dismissNotice()}>
              {t('app.close')}
            </button>
          </div>
        );
      return snap.buffering ? <Busy text={t('player.buffering')} /> : null;
    case 'failed':
      return (
        <Dialog title={t('player.failedTitle')}>
          <p>{snap.error?.code === 'STREAM_FAILED' ? t('player.streamFailed') : t('player.failedAttempts', { count: Math.min(snap.attempts, MAX_AUTOMATIC_ATTEMPTS) })}</p>
          <Reasons snap={snap} />
          <div className={styles.overlayActions}>
            {retry}
            {exit}
          </div>
        </Dialog>
      );
    case 'no_plan': {
      const code = snap.error?.code;
      const text =
        code === 'CLIENT_NO_MSE' ? t('player.noPlanMse') : code === 'CLIENT_UNSUPPORTED_PROTOCOL' ? t('player.noPlanProtocol', { protocol: snap.error?.detail ?? '' }) : (snap.error?.detail ?? '');
      return (
        <Dialog title={t('player.noPlanTitle')}>
          {text && <p>{text}</p>}
          <Reasons snap={snap} />
          <div className={styles.overlayActions}>{exit}</div>
        </Dialog>
      );
    }
    case 'session_limit':
      return (
        <Dialog title={t('player.sessionLimitTitle')}>
          <p>{t('player.sessionLimitText')}</p>
          <div className={styles.overlayActions}>
            {snap.activeSessions.length > 0 ? (
              snap.activeSessions.map((s) => (
                <button key={s.sessionId} type="button" className="btn btn-primary" onClick={() => void controller.terminateOther(s.sessionId)}>
                  {t('player.stopOther', { title: s.itemTitle ?? '—', profile: s.profileName ?? '—' })}
                </button>
              ))
            ) : (
              <p className="muted">{snap.error?.detail}</p>
            )}
            {exit}
          </div>
        </Dialog>
      );
    case 'expired':
    case 'stopped':
      return (
        <Dialog title={t('player.expiredTitle')}>
          <p>{t('player.expiredText')}</p>
          <div className={styles.overlayActions}>
            <button type="button" className="btn btn-primary" onClick={() => void controller.retry()}>
              {t('player.resumeFrom', { time: formatClock(snap.positionMs) })}
            </button>
            {exit}
          </div>
        </Dialog>
      );
    case 'terminated':
      return (
        <Dialog title={t('player.terminatedTitle')}>
          <p>{t('player.terminatedText')}</p>
          {snap.terminatedReason && <p className="muted">{terminatedReasonText(snap.terminatedReason)}</p>}
          <div className={styles.overlayActions}>
            {/* A title that left the library cannot be resumed. */}
            {snap.terminatedReason !== 'item_removed' && (
              <button type="button" className="btn btn-primary" onClick={() => void controller.retry()}>
                {t('player.resumeFrom', { time: formatClock(snap.positionMs) })}
              </button>
            )}
            {exit}
          </div>
        </Dialog>
      );
    case 'network':
      return (
        <Dialog title={t('player.networkTitle')}>
          <p>{t('error.network')}</p>
          <div className={styles.overlayActions}>
            {retry}
            {exit}
          </div>
        </Dialog>
      );
    case 'error': {
      const code = snap.error?.code;
      // The message is chosen by code; the server's (English) detail stays as a technical line under the code.
      const text =
        code === 'STREAM_PREPARING'
          ? t('player.preparingTimeout')
          : code === 'MEDIA_UNAVAILABLE'
            ? t('error.mediaUnavailable')
            : code === 'NOT_FOUND'
              ? t('error.notFound')
              : t('error.generic');
      const detail = snap.error?.detail;
      return (
        <Dialog title={t('player.errorTitle')}>
          <p>{text}</p>
          {code && <p className="mono muted">{detail ? `${t('error.code', { code })} · ${detail}` : t('error.code', { code })}</p>}
          <div className={styles.overlayActions}>
            {retry}
            {exit}
          </div>
        </Dialog>
      );
    }
    default:
      return null;
  }
}
