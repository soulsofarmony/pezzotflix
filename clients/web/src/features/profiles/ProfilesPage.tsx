// "Chi guarda?": create, rename and pick a profile (doc 03 §3.1). No auth in the MVP: SelectProfile returns the
// profileToken, kept in localStorage (ADR 0005 point 2).
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, type ReactElement, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../../api/problem.ts';
import { useCreateProfile, useProfiles, useSelectProfile, useUpdateProfile } from '../../api/queries.ts';
import type { Profile } from '../../api/types.ts';
import { useServices } from '../../app/services.tsx';
import { t } from '../../i18n/t.ts';
import { errorMessage } from '../../ui/errors.ts';
import { Icon } from '../../ui/Icon.tsx';
import { placeholderHue } from '../../ui/images.ts';
import { ErrorView, QueryFallback } from '../../ui/Status.tsx';
import styles from './profiles.module.css';

type Editing = { mode: 'create' } | { mode: 'rename'; profile: Profile } | null;

export function ProfilesPage(): ReactElement {
  const profiles = useProfiles();
  const select = useSelectProfile();
  const { store, queryClient } = useServices();
  const navigate = useNavigate();
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const opener = useRef<HTMLElement | null>(null);

  const openDialog = (next: NonNullable<Editing>, from: HTMLElement) => {
    opener.current = from;
    setEditing(next);
  };
  // Called once the dialog is closed: the focus goes back to the button that opened it, not to the page body.
  const dialogClosed = () => {
    setEditing(null);
    const from = opener.current;
    opener.current = null;
    if (from?.isConnected) from.focus();
  };

  const pick = (p: Profile) => {
    select.mutate(p.id, {
      onSuccess: (sel) => {
        store.set({ id: sel.profile.id, name: sel.profile.name, token: sel.profileToken });
        // Everything cached belongs to the previous profile's view.
        queryClient.clear();
        void navigate({ to: '/' });
      },
    });
  };

  const list = profiles.data?.profiles ?? [];

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('profiles.title')}</h1>
      {!profiles.data && <QueryFallback query={profiles} />}
      {profiles.data && list.length === 0 && <p className="muted">{t('profiles.empty')}</p>}
      {select.isError && <ErrorView error={select.error} />}
      <ul className={styles.list}>
        {list.map((p) => (
          <li key={p.id}>
            {managing ? (
              <button type="button" className={styles.profile} onClick={(e) => openDialog({ mode: 'rename', profile: p }, e.currentTarget)}>
                <Avatar name={p.name} />
                <span className={styles.name}>{p.name}</span>
                <span className={styles.editMark} aria-hidden="true">
                  <Icon name="edit" size={18} />
                </span>
                <span className="visually-hidden">{t('profiles.rename', { name: p.name })}</span>
              </button>
            ) : (
              <button type="button" className={styles.profile} onClick={() => pick(p)} disabled={select.isPending} aria-label={t('profiles.pick', { name: p.name })}>
                <Avatar name={p.name} />
                <span className={styles.name}>{p.name}</span>
              </button>
            )}
          </li>
        ))}
        <li>
          <button type="button" className={styles.profile} onClick={(e) => openDialog({ mode: 'create' }, e.currentTarget)}>
            <span className={`${styles.avatar} ${styles.add}`} aria-hidden="true">
              <Icon name="plus" size={40} />
            </span>
            <span className={styles.name}>{t('profiles.add')}</span>
          </button>
        </li>
      </ul>
      {list.length > 0 && (
        <button type="button" className="btn" onClick={() => setManaging((m) => !m)} aria-pressed={managing}>
          {managing ? t('profiles.done') : t('profiles.manage')}
        </button>
      )}
      {editing && <ProfileDialog editing={editing} onClosed={dialogClosed} />}
    </div>
  );
}

/**
 * The initial is drawn by CSS (attr): as text it would be part of the button's visible label ("S Simone"), which
 * then no longer matches the accessible name "Guarda come Simone" (WCAG 2.5.3, axe label-content-name-mismatch).
 */
function Avatar({ name }: { name: string }): ReactElement {
  return <span className={styles.avatar} style={{ ['--hue' as string]: placeholderHue(name) }} data-initial={name.trim().charAt(0).toLocaleUpperCase('it-IT')} aria-hidden="true" />;
}

/** onClosed: the dialog has closed (Esc, Annulla, or a save), through the dialog's own close event when it has one. */
function ProfileDialog({ editing, onClosed }: { editing: NonNullable<Editing>; onClosed: () => void }): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const inputId = useId();
  const hintId = useId();
  const { store } = useServices();
  const create = useCreateProfile();
  const update = useUpdateProfile(store);
  const [name, setName] = useState(editing.mode === 'rename' ? editing.profile.name : '');
  const mutation = editing.mode === 'create' ? create : update;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
  }, []);

  // close() leaves the modal state the way the browser expects and fires the close event, which calls onClosed.
  const close = () => {
    const d = ref.current;
    if (d?.open && typeof d.close === 'function') d.close();
    else onClosed();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 40) return;
    if (editing.mode === 'create') create.mutate({ name: trimmed }, { onSuccess: close });
    else update.mutate({ id: editing.profile.id, body: { name: trimmed, avatar: editing.profile.avatar ?? null, prefs: editing.profile.prefs } }, { onSuccess: close });
  };

  const err = mutation.error;
  const message = err instanceof ApiError && err.status === 409 ? t('profiles.nameTaken') : err ? errorMessage(err) : null;

  return (
    <dialog ref={ref} className={styles.dialog} onClose={onClosed} aria-labelledby={`${inputId}-title`}>
      <form onSubmit={submit} className={styles.form}>
        <h2 id={`${inputId}-title`}>{editing.mode === 'create' ? t('profiles.newTitle') : t('profiles.renameTitle')}</h2>
        <label className="field" htmlFor={inputId}>
          {t('profiles.name')}
          <input
            id={inputId}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            required
            aria-describedby={hintId}
            // The dialog has a single field: focusing it is what the user expects.
            // eslint-disable-next-line jsx-a11y-x/no-autofocus
            autoFocus
          />
        </label>
        <p id={hintId} className="muted">
          {t('profiles.nameHint')}
        </p>
        {message && (
          <p role="alert" className={styles.error}>
            {message}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={close}>
            {t('app.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending || name.trim().length === 0}>
            {t('app.save')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
