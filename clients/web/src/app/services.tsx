// Services shared by the whole app: profile store, API client, query cache, event poller and the bridge that
// forwards playback events to the active player. Built once in main.tsx; tests build their own.
import { QueryClient } from '@tanstack/react-query';
import { createContext, type ReactElement, type ReactNode, useContext, useSyncExternalStore } from 'react';
import { createVideoClient, call, type VideoClient } from '../api/client.ts';
import { documentVisibility, EventPoller } from '../api/events.ts';
import { invalidateForEvent } from '../api/keys.ts';
import { createPlaybackApi } from '../api/playback.ts';
import { createProfileStore, type ProfileStore, type StoredProfile } from '../api/profileStore.ts';
import { shouldRetryQuery } from '../api/queries.ts';
import type { AppEvent } from '../api/types.ts';
import type { PlaybackApi } from '../player/types.ts';

/** What the poller needs from the player that is on screen. */
export interface ActivePlayer {
  hasActiveSession(): boolean;
  onEvent(e: AppEvent): void;
}

export interface AppServices {
  store: ProfileStore;
  client: VideoClient;
  queryClient: QueryClient;
  playbackApi: PlaybackApi;
  poller: EventPoller;
  setActivePlayer(p: ActivePlayer | null): void;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetryQuery, staleTime: 15_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function createServices(opts: { baseUrl: string; storage: Storage | null; onUnauthorized: () => void; fetch?: typeof fetch; document?: Document }): AppServices {
  const store = createProfileStore(opts.storage, typeof window !== 'undefined' ? window : null);
  const client = createVideoClient({ baseUrl: opts.baseUrl, store, onUnauthorized: opts.onUnauthorized, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const queryClient = createQueryClient();
  let player: ActivePlayer | null = null;
  const doc = opts.document ?? document;
  const poller = new EventPoller({
    list: (cursor, limit) => call(client.GET('/video/api/v1/events', { params: { query: { cursor, limit } } })),
    onEvents: (events) => {
      for (const e of events) {
        invalidateForEvent(queryClient, e);
        if (e.type.startsWith('playback.')) player?.onEvent(e);
      }
    },
    onReset: () => void queryClient.invalidateQueries(),
    hasActiveSession: () => player?.hasActiveSession() ?? false,
    visibility: documentVisibility(doc),
    log: (msg, data) => console.debug(`[events] ${msg}`, data),
  });
  return {
    store,
    client,
    queryClient,
    playbackApi: createPlaybackApi(client),
    poller,
    setActivePlayer(p) {
      player = p;
      poller.refresh();
    },
  };
}

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({ services, children }: { services: AppServices; children: ReactNode }): ReactElement {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesProvider missing');
  return s;
}

/** The selected profile (null without one), re-rendering on change. */
export function useProfile(): StoredProfile | null {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
