// Audio, subtitles and version menu. Audio always goes through ChangeTracks; a subtitle served separately is
// switched locally (a growing one shows "in preparazione"); a version change goes through ChangeVersion.
import { type ReactElement, useId } from 'react';
import type { MediaVersion } from '../../api/types.ts';
import { t } from '../../i18n/t.ts';
import type { PlayerController, PlayerSnapshot } from '../../player/controller.ts';
import { Icon } from '../../ui/Icon.tsx';
import { trackLabel } from '../../ui/tracks.ts';
import styles from './player.module.css';

export function TrackMenu({ snap, controller, versions, onClose }: { snap: PlayerSnapshot; controller: PlayerController; versions: MediaVersion[]; onClose: () => void }): ReactElement | null {
  const id = useId();
  const s = snap.session;
  if (!s) return null;
  const audioSelected = s.tracks.audio.find((a) => a.selected)?.id ?? null;
  // Changes only while the session plays or waits for its stream (never behind a failure or an end dialog).
  const locked = snap.busy || (snap.phase !== 'ready' && snap.phase !== 'preparing');
  return (
    <section className={styles.panel} aria-labelledby={`${id}-title`}>
      <div className={styles.panelHeader}>
        <h2 id={`${id}-title`}>{t('player.tracks')}</h2>
        <button type="button" className={styles.iconButton} onClick={onClose}>
          <Icon name="close" />
          <span className="visually-hidden">{t('app.close')}</span>
        </button>
      </div>
      <div className={styles.panelColumns}>
        <fieldset className={styles.choices} disabled={locked}>
          <legend>{t('player.audio')}</legend>
          {s.tracks.audio.map((a) => (
            <label key={a.id} className={styles.choice}>
              <input type="radio" name={`${id}-audio`} checked={audioSelected === a.id} onChange={() => void controller.selectAudio(a.id)} />
              <span>{trackLabel(a)}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className={styles.choices} disabled={locked}>
          <legend>{t('player.subtitles')}</legend>
          <label className={styles.choice}>
            <input type="radio" name={`${id}-sub`} checked={snap.subtitleTrackId === null} onChange={() => void controller.selectSubtitle(null)} />
            <span>{t('track.none')}</span>
          </label>
          {s.tracks.subtitles.map((st) => (
            <label key={st.id} className={styles.choice}>
              <input type="radio" name={`${id}-sub`} checked={snap.subtitleTrackId === st.id} onChange={() => void controller.selectSubtitle(st.id)} />
              <span>
                {trackLabel(st)}
                {(st.availability === 'growing' || snap.subtitlePreparing === st.id) && <span className={styles.tag}>{t('track.preparing')}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        {versions.length > 1 && (
          <fieldset className={styles.choices} disabled={locked}>
            <legend>{t('player.version')}</legend>
            {versions.map((v) => (
              <label key={v.fileId} className={styles.choice}>
                <input type="radio" name={`${id}-version`} checked={s.fileId === v.fileId} disabled={!v.available} onChange={() => void controller.selectVersion(v.fileId)} />
                <span>{v.label}</span>
              </label>
            ))}
          </fieldset>
        )}
      </div>
    </section>
  );
}
