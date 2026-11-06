// An in-app confirmation, never window.confirm: a modal <dialog> with a title, a message, "Annulla" first (the
// safe choice gets the focus) and the action. Esc and "Annulla" close it; the focus goes back to the element that
// opened it, or to the one close() names (the opener may be about to leave the page, e.g. a row just removed).
// If that element has already left the page (a refetch removed its row meanwhile), it goes to fallbackFocus.
import { type ReactElement, type ReactNode, type RefObject, useEffect, useId, useRef } from 'react';
import { t } from '../i18n/t.ts';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  title: string;
  /** The question, in full: what happens and what does not. */
  children: ReactNode;
  confirmLabel: string;
  /** The action is running: its button is disabled. */
  busy?: boolean;
  /** Why the action failed, shown in the dialog. */
  error?: string | null;
  /** close() closes the dialog (e.g. once the action succeeded), moving the focus to `focus` if given. */
  onConfirm: (close: (focus?: HTMLElement | null) => void) => void;
  /** The dialog has closed (Esc, "Annulla", or close()). */
  onClosed: () => void;
  /** Where the focus goes when the element it would go back to is no longer on the page. Needs a tabIndex. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

export function ConfirmDialog({ title, children, confirmLabel, busy = false, error = null, onConfirm, onClosed, fallbackFocus }: ConfirmDialogProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const focusAfter = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    opener.current = document.activeElement;
    const d = ref.current;
    if (d && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
  }, []);

  const closed = () => {
    onClosed();
    const target = focusAfter.current ?? opener.current;
    if (target instanceof HTMLElement && target.isConnected) target.focus();
    else if (fallbackFocus?.current?.isConnected) fallbackFocus.current.focus();
  };
  // close() leaves the modal state the way the browser expects and fires the close event, which calls closed.
  const close = (focus?: HTMLElement | null) => {
    focusAfter.current = focus ?? null;
    const d = ref.current;
    if (d?.open && typeof d.close === 'function') d.close();
    else closed();
  };

  return (
    <dialog ref={ref} className={styles.dialog} onClose={closed} aria-labelledby={titleId} aria-describedby={bodyId}>
      <div className={styles.body}>
        <h2 id={titleId}>{title}</h2>
        <div id={bodyId} className={styles.body}>
          {children}
        </div>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={() => close()}>
            {t('app.cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onConfirm(close)} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
