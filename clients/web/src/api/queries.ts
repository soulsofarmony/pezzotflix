// TanStack Query hooks written by hand over openapi-fetch (ADR 0005 point 2): explicit keys per operation,
// errors as ApiError. This replaces openapi-react-query with a few lines and one dependency less.
import { type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { call, type VideoClient } from './client.ts';
import { type ItemFilters, keys } from './keys.ts';
import { ApiError } from './problem.ts';
import type { ExplainRequest, ProfileInput, ResolveCaseRequest } from './types.ts';

const ClientContext = createContext<VideoClient | null>(null);
export const VideoClientProvider = ClientContext.Provider;

export function useVideoClient(): VideoClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error('VideoClientProvider missing');
  return c;
}

/** Query retries: never on 4xx (the answer will not change), twice on network errors and 5xx. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

const PAGE = 40;

// ---------------------------------------------------------------- system and profiles

export function useServerInfo() {
  const c = useVideoClient();
  return useQuery({ queryKey: keys.server, queryFn: ({ signal }) => call(c.GET('/video/api/v1/server', { signal })), staleTime: 30_000 });
}

export function useProfiles() {
  const c = useVideoClient();
  return useQuery({ queryKey: keys.profiles, queryFn: ({ signal }) => call(c.GET('/video/api/v1/profiles', { signal })) });
}

export function useCreateProfile() {
  const c = useVideoClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileInput) => call(c.POST('/video/api/v1/profiles', { body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.profiles }),
  });
}

export function useUpdateProfile() {
  const c = useVideoClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ProfileInput }) => call(c.PATCH('/video/api/v1/profiles/{profileId}', { params: { path: { profileId: id } }, body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.profiles }),
  });
}

export function useSelectProfile() {
  const c = useVideoClient();
  return useMutation({
    mutationFn: (id: string) => call(c.POST('/video/api/v1/profiles/{profileId}/select', { params: { path: { profileId: id } } })),
  });
}

// ---------------------------------------------------------------- catalog

export function useHome() {
  const c = useVideoClient();
  return useQuery({ queryKey: keys.home, queryFn: ({ signal }) => call(c.GET('/video/api/v1/home', { signal })) });
}

export function useItems(filters: ItemFilters) {
  const c = useVideoClient();
  return useInfiniteQuery({
    queryKey: keys.items(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      call(
        c.GET('/video/api/v1/items', {
          signal,
          params: {
            query: {
              kind: filters.kind as never,
              category: filters.category as never,
              sort: filters.sort as never,
              order: filters.order as never,
              watched: filters.watched,
              inWatchlist: filters.inWatchlist,
              continueWatching: filters.continueWatching,
              year: filters.year,
              cursor: pageParam,
              limit: PAGE,
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useSearch(q: string, kind: string | undefined) {
  const c = useVideoClient();
  return useQuery({
    queryKey: keys.search(q, kind),
    enabled: q.trim().length > 0,
    queryFn: ({ signal }) => call(c.GET('/video/api/v1/search', { signal, params: { query: { q: q.trim(), kind: kind as never, limit: 60 } } })),
    placeholderData: (prev) => prev,
  });
}

export function useItem(id: string) {
  const c = useVideoClient();
  return useQuery({ queryKey: keys.item(id), queryFn: ({ signal }) => call(c.GET('/video/api/v1/items/{itemId}', { signal, params: { path: { itemId: id } } })) });
}

export function useChildren(id: string, enabled = true) {
  const c = useVideoClient();
  return useInfiniteQuery({
    queryKey: keys.children(id),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      call(c.GET('/video/api/v1/items/{itemId}/children', { signal, params: { path: { itemId: id }, query: { cursor: pageParam, limit: 100 } } })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useNextUp(seriesId: string, enabled: boolean) {
  const c = useVideoClient();
  return useQuery({
    queryKey: keys.nextUp(seriesId),
    enabled,
    queryFn: ({ signal }) => call(c.GET('/video/api/v1/items/{itemId}/next-up', { signal, params: { path: { itemId: seriesId } } })),
  });
}

/** After a watch-state change: the item, its lists and the home rows may show it differently. */
function invalidateWatchState(qc: QueryClient, itemId: string): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.item(itemId) }),
    qc.invalidateQueries({ queryKey: keys.home }),
    qc.invalidateQueries({ queryKey: keys.itemsAll }),
    qc.invalidateQueries({ queryKey: keys.searchAll }),
  ]);
}

export function useWatchState(itemId: string) {
  const c = useVideoClient();
  const qc = useQueryClient();
  const path = { params: { path: { itemId } } };
  const opts = { onSuccess: () => invalidateWatchState(qc, itemId) };
  return {
    markWatched: useMutation({ mutationFn: () => call(c.PUT('/video/api/v1/items/{itemId}/watched', path)), ...opts }),
    markUnwatched: useMutation({ mutationFn: () => call(c.DELETE('/video/api/v1/items/{itemId}/watched', path)), ...opts }),
    addToWatchlist: useMutation({ mutationFn: () => call(c.PUT('/video/api/v1/watchlist/{itemId}', path)), ...opts }),
    removeFromWatchlist: useMutation({ mutationFn: () => call(c.DELETE('/video/api/v1/watchlist/{itemId}', path)), ...opts }),
    clearProgress: useMutation({ mutationFn: () => call(c.DELETE('/video/api/v1/items/{itemId}/progress', path)), ...opts }),
  };
}

// ---------------------------------------------------------------- playback diagnostics

export function useExplain() {
  const c = useVideoClient();
  return useMutation({ mutationFn: (body: ExplainRequest) => call(c.POST('/video/api/v1/admin/explain', { body })) });
}

// ---------------------------------------------------------------- admin

export function useRoots() {
  const c = useVideoClient();
  return useQuery({ queryKey: keys.admin.roots, queryFn: ({ signal }) => call(c.GET('/video/api/v1/admin/roots', { signal })) });
}

export function useConfirmRoot() {
  const c = useVideoClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rootId: string) => call(c.POST('/video/api/v1/admin/roots/{rootId}/confirm-contents', { params: { path: { rootId } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.admin.roots }),
  });
}

export function useTriggerScan() {
  const c = useVideoClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rootId?: string) => call(c.POST('/video/api/v1/admin/scan', { body: rootId ? { rootId } : {} })),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.admin.ingest }), qc.invalidateQueries({ queryKey: keys.admin.roots })]),
  });
}

export function useIngest() {
  const c = useVideoClient();
  return useQuery({
    queryKey: keys.admin.ingest,
    queryFn: ({ signal }) => call(c.GET('/video/api/v1/admin/ingest', { signal })),
    // While something runs, a slow refresh shows the counters moving even between ingest events.
    refetchInterval: (q) => (q.state.data?.running || (q.state.data?.queued ?? 0) > 0 ? 5_000 : false),
  });
}

export function useRetryJob() {
  const c = useVideoClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => call(c.POST('/video/api/v1/admin/jobs/{jobId}/retry', { params: { path: { jobId } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.admin.ingest }),
  });
}

export type CaseState = 'pending' | 'auto_matched' | 'needs_review' | 'resolved' | 'ignored';

export function useCases(state: CaseState) {
  const c = useVideoClient();
  return useInfiniteQuery({
    queryKey: keys.admin.cases(state),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => call(c.GET('/video/api/v1/admin/cases', { signal, params: { query: { state, cursor: pageParam, limit: 50 } } })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useCase(caseId: string) {
  const c = useVideoClient();
  return useQuery({
    queryKey: keys.admin.case(caseId),
    queryFn: ({ signal }) => call(c.GET('/video/api/v1/admin/cases/{caseId}', { signal, params: { path: { caseId } } })),
  });
}

function invalidateCase(qc: QueryClient, caseId: string): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.admin.casesAll }),
    qc.invalidateQueries({ queryKey: keys.admin.case(caseId) }),
    qc.invalidateQueries({ queryKey: keys.server }),
    qc.invalidateQueries({ queryKey: keys.home }),
    qc.invalidateQueries({ queryKey: keys.itemsAll }),
  ]);
}

export function useResolveCase(caseId: string) {
  const c = useVideoClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ResolveCaseRequest) => call(c.POST('/video/api/v1/admin/cases/{caseId}/resolve', { params: { path: { caseId } }, body })),
    onSuccess: () => invalidateCase(qc, caseId),
  });
}

export function useIgnoreCase(caseId: string) {
  const c = useVideoClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call(c.POST('/video/api/v1/admin/cases/{caseId}/ignore', { params: { path: { caseId } } })),
    onSuccess: () => invalidateCase(qc, caseId),
  });
}

export function useProviderSearch(q: string, kind: 'movie' | 'series' | undefined, year: number | undefined) {
  const c = useVideoClient();
  return useQuery({
    queryKey: keys.admin.providerSearch(q, kind, year),
    enabled: q.trim().length > 0,
    queryFn: ({ signal }) => call(c.GET('/video/api/v1/admin/provider-search', { signal, params: { query: { q: q.trim(), kind, year } } })),
    retry: false,
  });
}

export function useMediaFile(fileId: string | null) {
  const c = useVideoClient();
  return useQuery({
    queryKey: keys.admin.file(fileId ?? ''),
    enabled: !!fileId,
    queryFn: ({ signal }) => call(c.GET('/video/api/v1/admin/files/{fileId}', { signal, params: { path: { fileId: fileId ?? '' } } })),
  });
}
