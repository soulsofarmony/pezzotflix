// Renders the whole app (services, router, providers) at a URL, over a fake fetch that answers by operation
// ("METHOD /path/{param}"). Component tests go through the real routes, client and middleware.
import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StoredProfile } from '../api/profileStore.ts';
import { App } from '../app/App.tsx';
import { createAppRouter } from '../app/router.tsx';
import { createServices } from '../app/services.tsx';

export type Handler = (ctx: { req: Request; url: URL; params: Record<string, string>; body: unknown }) => unknown;
export type Routes = Record<string, Handler>;

export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export const problem = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, ...extra }), { status, headers: { 'Content-Type': 'application/problem+json', ...headers } });

export const SERVER_INFO = {
  name: 'Pezzotflix',
  version: '0.1.0',
  apiVersions: ['v1'],
  features: { transcode: true, directStream: true },
  ingest: { running: false, queued: 0, needsReview: 2 },
  providers: [
    { name: 'wikidata', status: 'ok', attribution: 'Dati da Wikidata (CC0)' },
    { name: 'tmdb', status: 'not_configured' },
  ],
};

export const PREFS = { audioLanguages: ['ita', 'eng'], subtitleLanguages: ['ita'], subtitleMode: 'forced' };

const DEFAULT_ROUTES: Routes = {
  'GET /video/api/v1/server': () => SERVER_INFO,
  'GET /video/api/v1/events': () => ({ events: [], nextCursor: 'e0' }),
};

function compile(key: string): { method: string; re: RegExp; names: string[] } {
  const [method = 'GET', path = '/'] = key.split(' ');
  const names: string[] = [];
  const re = new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_m, n: string) => (names.push(n), '([^/]+)'))}$`);
  return { method, re, names };
}

export interface RenderAppOptions {
  profile?: StoredProfile;
}

export function renderApp(path: string, routes: Routes = {}, opts: RenderAppOptions = {}) {
  const all = Object.entries({ ...DEFAULT_ROUTES, ...routes }).map(([k, h]) => ({ ...compile(k), handler: h }));
  const requests: { method: string; path: string; search: string; body: unknown; auth: string | null }[] = [];
  const unmatched: string[] = [];

  const fakeFetch = async (input: Request): Promise<Response> => {
    const url = new URL(input.url);
    const text = input.method === 'GET' || input.method === 'HEAD' ? '' : await input.text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    requests.push({ method: input.method, path: url.pathname, search: url.search, body, auth: input.headers.get('Authorization') });
    for (const r of all) {
      if (r.method !== input.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? '')]));
      const out = await r.handler({ req: input, url, params, body });
      if (out instanceof Response) return out;
      if (out === undefined) return new Response(null, { status: 204 });
      return json(out);
    }
    unmatched.push(`${input.method} ${url.pathname}`);
    return problem(404, 'NOT_FOUND');
  };

  const storage = memoryStorage();
  if (opts.profile) storage.setItem('pezzotflix.profile', JSON.stringify(opts.profile));
  let router: ReturnType<typeof createAppRouter> | null = null;
  const services = createServices({
    baseUrl: 'http://pzf.test',
    storage,
    onUnauthorized: () => void router?.navigate({ to: '/profiles' }),
    fetch: fakeFetch as unknown as typeof fetch,
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  router = createAppRouter({ store: services.store }, history);
  const user = userEvent.setup();
  const view = render(<App services={services} router={router} />);
  return { ...view, user, services, router, requests, unmatched };
}
