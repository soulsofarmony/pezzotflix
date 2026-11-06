// The selected profile and its profileToken (ADR 0005 point 2): kept in localStorage, so the last profile stays
// chosen on this browser. In the MVP the token is not a secret (ADR 0004 point 8); real auth revisits this.

export interface StoredProfile {
  id: string;
  name: string;
  token: string;
}

export const PROFILE_STORAGE_KEY = 'pezzotflix.profile';

type Listener = () => void;

export interface ProfileStore {
  get: () => StoredProfile | null;
  set: (p: StoredProfile) => void;
  clear: () => void;
  subscribe: (listener: Listener) => () => void;
}

function parse(raw: string | null): StoredProfile | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredProfile>;
    return typeof v.id === 'string' && typeof v.token === 'string' ? { id: v.id, token: v.token, name: typeof v.name === 'string' ? v.name : '' } : null;
  } catch {
    return null;
  }
}

export interface ProfileStoreOptions {
  /**
   * Another tab changed the stored profile (picked one, renamed it, cleared it). Called with the store already
   * holding next, before the subscribers hear of it.
   */
  onExternalChange?: (prev: StoredProfile | null, next: StoredProfile | null) => void;
}

/**
 * A store over a Storage (localStorage in the app, a fake in tests). Changes from other tabs are picked up too,
 * while the store has subscribers (in the app it always has: the shell and the event polling read it).
 */
export function createProfileStore(
  storage: Storage | null,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = null,
  opts: ProfileStoreOptions = {},
): ProfileStore {
  let current = parse(storage?.getItem(PROFILE_STORAGE_KEY) ?? null);
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((l) => l());

  const onStorage = (e: StorageEvent) => {
    if (e.key !== PROFILE_STORAGE_KEY) return;
    const prev = current;
    current = parse(e.newValue);
    opts.onExternalChange?.(prev, current);
    emit();
  };

  return {
    get: () => current,
    set(p) {
      current = p;
      try {
        storage?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(p));
      } catch {
        // Storage full or disabled: the profile still works for this tab.
      }
      emit();
    },
    clear() {
      if (!current) return;
      current = null;
      try {
        storage?.removeItem(PROFILE_STORAGE_KEY);
      } catch {
        // ignore
      }
      emit();
    },
    subscribe(listener) {
      if (listeners.size === 0) win?.addEventListener('storage', onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) win?.removeEventListener('storage', onStorage);
      };
    },
  };
}
