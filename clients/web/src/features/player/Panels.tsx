// "Perché questa modalità?" (ExplainPlaybackDecision with the capabilities this session declared) and the
// technical info panel (mode, reasons, mimeType, capabilities, failures: doc 05 §7.8.5).
import { type ReactElement, type ReactNode, useEffect, useId } from 'react';
import { useExplain } from '../../api/queries.ts';
import type { MediaVersion } from '../../api/types.ts';
import { t, tMaybe } from '../../i18n/t.ts';
import type { PlayerSnapshot } from '../../player/controller.ts';
import { Icon } from '../../ui/Icon.tsx';
import { ErrorView, Loading } from '../../ui/Status.tsx';
import styles from './player.module.css';

export function modeLabel(mode: string): string {
  return tMaybe(`player.mode.${mode}`, mode);
}

function PanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactElement {
  const id = useId();
  return (
    <section className={styles.panel} aria-labelledby={id}>
      <div className={styles.panelHeader}>
        <h2 id={id}>{title}</h2>
        <button type="button" className={styles.iconButton} onClick={onClose}>
          <Icon name="close" />
          <span className="visually-hidden">{t('app.close')}</span>
        </button>
      </div>
      {children}
    </section>
  );
}

export function WhyPanel({ snap, itemId, versions, onClose }: { snap: PlayerSnapshot; itemId: string; versions: MediaVersion[]; onClose: () => void }): ReactElement {
  const explain = useExplain();
  const s = snap.session;
  const caps = snap.capabilities;
  const fileId = s?.fileId ?? null;
  const audio = s?.tracks.audio.find((a) => a.selected)?.id;
  const subtitle = snap.subtitleTrackId;
  const { mutate } = explain;
  useEffect(() => {
    if (!caps) return;
    // Track ids are file-local: they travel only with the fileId of this session's version (else 400).
    mutate({
      itemId,
      capabilities: caps,
      ...(fileId ? { fileId, ...(audio ? { audioTrackId: audio } : {}), subtitleTrackId: subtitle } : {}),
    });
  }, [mutate, itemId, caps, fileId, audio, subtitle]);
  const label = (id: string) => versions.find((v) => v.fileId === id)?.label ?? id;

  const plan = explain.data;
  return (
    <PanelShell title={t('player.whyTitle')} onClose={onClose}>
      {s && (
        <>
          <p className={styles.modeLine}>{modeLabel(s.mode)}</p>
          <ul>
            {s.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {explain.isPending && <Loading label={t('player.whyLoading')} />}
      {explain.isError && <ErrorView error={explain.error} />}
      {plan && (
        <>
          {plan.mode === null && (
            <>
              <p className={styles.modeLine}>{t('player.whyNoPlan')}</p>
              <ul>
                {plan.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          )}
          {Object.keys(plan.actions).length > 0 && (
            <>
              <h3>{t('player.whyActions')}</h3>
              <dl className={styles.facts}>
                {Object.entries(plan.actions).map(([dim, action]) => (
                  <div key={dim}>
                    <dt>{tMaybe(`player.whyAction.${dim}`, dim)}</dt>
                    <dd className="mono">{action}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {plan.candidates.length > 0 && (
            <>
              <h3>{t('player.whyCandidates')}</h3>
              <ul className={styles.candidates}>
                {plan.candidates.map((c) => (
                  <li key={c.fileId}>
                    <strong>{label(c.fileId)}</strong>
                    {c.fileId === plan.fileId && <span className={styles.tag}>{t('player.whyChosen')}</span>}
                    {' · '}
                    {c.mode ? modeLabel(c.mode) : t('player.whyNoMode')}
                    {c.reasons.length > 0 && (
                      <ul>
                        {c.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </PanelShell>
  );
}

export function InfoPanel({ snap, onClose }: { snap: PlayerSnapshot; onClose: () => void }): ReactElement {
  const s = snap.session;
  return (
    <PanelShell title={t('player.info')} onClose={onClose}>
      <dl className={styles.facts}>
        <div>
          <dt>{t('player.info.mode')}</dt>
          <dd>{s ? modeLabel(s.mode) : '—'}</dd>
        </div>
        <div>
          <dt>{t('player.info.protocol')}</dt>
          <dd className="mono">{s?.stream.protocol ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('player.info.mime')}</dt>
          <dd className="mono">{s?.stream.mimeType ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('player.info.offset')}</dt>
          <dd className="mono">{Math.round(snap.timelineOffsetMs)} ms</dd>
        </div>
        <div>
          <dt>{t('player.info.failures')}</dt>
          <dd className="mono">{snap.failures.length ? snap.failures.map((f) => `${f.error} (${f.suspect ?? '—'})`).join(', ') : t('player.info.none')}</dd>
        </div>
      </dl>
      {s && s.reasons.length > 0 && (
        <ul>
          {s.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <h3>{t('player.info.capabilities')}</h3>
      <pre className={styles.pre}>{snap.capabilities ? JSON.stringify(snap.capabilities, null, 2) : '—'}</pre>
    </PanelShell>
  );
}
