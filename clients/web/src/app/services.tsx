// Services shared by the whole app: profile store, API client, query cache, event poller and the bridge that
// forwards playback events to the active player. Built once in main.tsx; tests build their own.
import { QueryClient } from '@tanstack/react-query';
import { createContext, type ReactElement, type ReactNode, useContext, useSyncExternalStore } from 'react';
import { createVideoClient, call, type VideoClient } from '../api/client.ts';
import { documentVisibility, EventPoller } from '../api/events.ts';
import { invalidateAfterPlayback, invalidateForEvents } from '../api/keys.ts';
import { createPlaybackApi } from '../api/playback.ts';
import { createProfileStore, type ProfileStore, type StoredProfile } from '../api/profileStore.ts';
import { queryRetryDelay, shouldRetryQuery } from '../api/queries.ts';
import { createRemovalStore, type RemovalStore } from '../api/removals.ts';
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
  removals: RemovalStore;
  setActivePlayer(p: ActivePlayer | null): void;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetryQuery, retryDelay: queryRetryDelay, staleTime: 15_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function createServices(opts: { baseUrl: string; storage: Storage | null; onUnauthorized: () => void; fetch?: typeof fetch; document?: Document }): AppServices {
  const queryClient = createQueryClient();
  const store = createProfileStore(opts.storage, typeof window !== 'undefined' ? window : null, {
    onExternalChange: (prev, next) => {
      // Another tab switched profile: everything cached is the previous profile's view, as when picking one here.
      // reset, not clear: the queries on screen keep their observers, and only reset tells them to refetch.
      if (prev?.id !== next?.id || prev?.token !== next?.token) void queryClient.resetQueries();
    },
  });
  const client = createVideoClient({ baseUrl: opts.baseUrl, store, onUnauthorized: opts.onUnauthorized, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  let player: ActivePlayer | null = null;
  const removals = createRemovalStore();
  const doc = opts.document ?? document;
  const poller = new EventPoller({
    list: (cursor, limit) => call(client.GET('/video/api/v1/events', { params: { query: { cursor, limit } } })),
    onEvents: (events) => {
      for (const e of events) if (e.type === 'library.item_removed' && e.itemId) removals.record(e.itemId, e.replacedBy);
      invalidateForEvents(queryClient, events);
      // A removed item matters to the player too: a later start asks for the item that took its place.
      for (const e of events) if (e.type.startsWith('playback.') || e.type === 'library.item_removed') player?.onEvent(e);
    },
    onReset: () => void queryClient.invalidateQueries(),
    hasActiveSession: () => player?.hasActiveSession() ?? false,
    visibility: documentVisibility(doc),
    log: (msg, data) => console.debug(`[events] ${msg}`, data),
  });
  const api = createPlaybackApi(client);
  // The player stops its session as it unmounts, after the page it goes back to has mounted and fetched: refetch
  // once the stop is saved, or the item page offers no "Riprendi da" for the position just left.
  const playbackApi: PlaybackApi = {
    ...api,
    stop: async (sessionId, positionMs, stopOpts) => {
      await api.stop(sessionId, positionMs, stopOpts);
      void invalidateAfterPlayback(queryClient);
    },
  };
  return {
    store,
    client,
    queryClient,
    playbackApi,
    poller,
    removals,
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

/**
 * Whether the library removed this item while the app is open: undefined if not, null if nothing took its place,
 * else the item to show instead. Re-renders on change.
 */
export function useRemoval(itemId: string): string | null | undefined {
  const { removals } = useServices();
  const get = () => removals.resolve(itemId);
  return useSyncExternalStore(removals.subscribe, get, get);
}

/** The selected profile (null without one), re-rendering on change. */
export function useProfile(): StoredProfile | null {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
