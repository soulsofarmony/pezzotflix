// Control-plane client (ADR 0004 point 6, ADR 0005 point 2): openapi-fetch on the generated paths, with the page
// origin as baseUrl (the gateway serves the SPA, so the client never knows a host, doc 03 P1).
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import { ApiError, networkError, toApiError } from './problem.ts';
import type { ProfileStore } from './profileStore.ts';
import type { paths } from './schema.d.ts';

export type VideoClient = Client<paths>;

/**
 * Operations with `security: []` in the contract: they never carry the profile token. Checked against the bundled
 * contract in client.test.ts, so a new public operation fails the tests until it is listed here.
 */
export const PUBLIC_OPERATIONS: ReadonlySet<string> = new Set([
  'GET /video/healthz',
  'GET /video/api/v1/server',
  'GET /video/api/v1/profiles',
  'POST /video/api/v1/profiles',
  'PATCH /video/api/v1/profiles/{profileId}',
  'DELETE /video/api/v1/profiles/{profileId}',
  'POST /video/api/v1/profiles/{profileId}/select',
  'GET /video/api/v1/admin/roots',
  'POST /video/api/v1/admin/roots/{rootId}/confirm-contents',
  'POST /video/api/v1/admin/roots/{rootId}/forget-missing',
  'POST /video/api/v1/admin/scan',
  'GET /video/api/v1/admin/ingest',
  'POST /video/api/v1/admin/jobs/{jobId}/retry',
  'GET /video/api/v1/admin/cases',
  'GET /video/api/v1/admin/cases/{caseId}',
  'POST /video/api/v1/admin/cases/{caseId}/resolve',
  'POST /video/api/v1/admin/cases/{caseId}/ignore',
  'GET /video/api/v1/admin/provider-search',
  'GET /video/api/v1/admin/files',
  'GET /video/api/v1/admin/files/{fileId}',
  'POST /video/api/v1/admin/files/{fileId}/forget',
  'POST /video/api/v1/admin/explain',
]);

const isPublic = (method: string, schemaPath: string) => PUBLIC_OPERATIONS.has(`${method.toUpperCase()} ${schemaPath}`);

/**
 * Adds `Authorization: Bearer <profileToken>` to the profile-scoped operations. A 401 on one of them clears the
 * token and calls onUnauthorized, which brings the user back to the profile choice; not when the request carried
 * another token than the stored one (a session pinned to its profile, or a profile another tab picked while the
 * request ran): that 401 is about a profile this tab no longer uses.
 */
export function profileMiddleware(store: ProfileStore, onUnauthorized: () => void): Middleware {
  return {
    onRequest({ request, schemaPath }) {
      if (isPublic(request.method, schemaPath)) return undefined;
      const p = store.get();
      if (p) request.headers.set('Authorization', `Bearer ${p.token}`);
      return undefined;
    },
    onResponse({ request, response, schemaPath }) {
      if (response.status === 401 && !isPublic(request.method, schemaPath)) {
        const sent = request.headers.get('Authorization');
        const p = store.get();
        if (sent !== null && p !== null && sent !== `Bearer ${p.token}`) return undefined;
        store.clear();
        onUnauthorized();
      }
      return undefined;
    },
  };
}

export interface CreateVideoClientOptions {
  baseUrl: string;
  store: ProfileStore;
  onUnauthorized: () => void;
  fetch?: typeof globalThis.fetch;
}

export function createVideoClient(opts: CreateVideoClientOptions): VideoClient {
  const client = createClient<paths>({ baseUrl: opts.baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  client.use(profileMiddleware(opts.store, opts.onUnauthorized));
  return client;
}

/** The result shape of every openapi-fetch call. */
interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Awaits an openapi-fetch call and returns its data, or throws an ApiError (problem+json by code and status,
 * or NETWORK when no answer came). 204 answers resolve to undefined.
 */
export async function call<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await promise;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // An aborted request is not a network failure: let callers that aborted it ignore it.
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw networkError(e);
  }
  if (!result.response.ok) throw toApiError(result.response, result.error);
  return result.data as T;
}
