// Routes declared in code (ADR 0005 point 3), search parameters validated with zod. The player is a separate
// full-window route and a lazy chunk (with hls.js and libpgs loaded on demand inside it).
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  Outlet,
  redirect,
  type RouterHistory,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import type { ReactElement } from 'react';
import type { ProfileStore } from '../api/profileStore.ts';
import { AboutPage } from '../features/about/AboutPage.tsx';
import { BrowsePage } from '../features/catalog/BrowsePage.tsx';
import { HomePage } from '../features/home/HomePage.tsx';
import { ItemPage } from '../features/item/ItemPage.tsx';
import { ProfilesPage } from '../features/profiles/ProfilesPage.tsx';
import { SearchPage } from '../features/search/SearchPage.tsx';
import { t } from '../i18n/t.ts';
import { Layout } from './Layout.tsx';
import { browseSearch, casesSearch, filesSearch, playerSearch, searchSearch } from './search.ts';

export interface RouterContext {
  store: ProfileStore;
}

function NotFound(): ReactElement {
  return (
    <div className="page">
      <p>{t('app.notFound')}</p>
      <Link to="/">{t('app.goHome')}</Link>
    </div>
  );
}

const requireProfile = ({ context }: { context: RouterContext }) => {
  if (!context.store.get()) redirect({ to: '/profiles', throw: true });
};

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet, notFoundComponent: NotFound });

const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Layout });

const profilesRoute = createRoute({ getParentRoute: () => shellRoute, path: '/profiles', component: ProfilesPage });
const aboutRoute = createRoute({ getParentRoute: () => shellRoute, path: '/about', component: AboutPage });

// Admin and player are separate chunks: the catalog screens do not pay for them.
const AdminLayout = lazyRouteComponent(() => import('../features/admin/AdminLayout.tsx'), 'AdminLayout');
const CasesPage = lazyRouteComponent(() => import('../features/admin/CasesPage.tsx'), 'CasesPage');
const CaseDetailPage = lazyRouteComponent(() => import('../features/admin/CaseDetailPage.tsx'), 'CaseDetailPage');
const RootsPage = lazyRouteComponent(() => import('../features/admin/RootsPage.tsx'), 'RootsPage');
const IngestPage = lazyRouteComponent(() => import('../features/admin/IngestPage.tsx'), 'IngestPage');
const MissingFilesPage = lazyRouteComponent(() => import('../features/admin/MissingFilesPage.tsx'), 'MissingFilesPage');
const ProvidersPage = lazyRouteComponent(() => import('../features/admin/ProvidersPage.tsx'), 'ProvidersPage');

/**
 * A wrapper that keys a lazy page keeps the page's chunk preload: the router loads the chunk before it renders
 * the route, so the lazy component never suspends with use() mid-render (React warns about that in development).
 */
function withChunk<C extends () => ReactElement>(wrapper: C, lazy: { preload?: () => Promise<void> | undefined }): C & { preload: () => Promise<void> } {
  return Object.assign(wrapper, { preload: async () => lazy.preload?.() });
}

const adminRoute = createRoute({ getParentRoute: () => shellRoute, path: '/admin', component: AdminLayout });
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  beforeLoad: () => {
    redirect({ to: '/admin/cases', throw: true });
  },
});
const casesRoute = createRoute({ getParentRoute: () => adminRoute, path: '/cases', validateSearch: casesSearch, component: CasesPage });
const caseRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/cases/$caseId',
  component: withChunk(function CaseRoute() {
    const { caseId } = useParams({ from: '/_shell/admin/cases/$caseId' });
    return <CaseDetailPage key={caseId} caseId={caseId} />;
  }, CaseDetailPage),
});
const rootsRoute = createRoute({ getParentRoute: () => adminRoute, path: '/roots', component: RootsPage });
const ingestRoute = createRoute({ getParentRoute: () => adminRoute, path: '/ingest', component: IngestPage });
const filesRoute = createRoute({ getParentRoute: () => adminRoute, path: '/files', validateSearch: filesSearch, component: MissingFilesPage });
const providersRoute = createRoute({ getParentRoute: () => adminRoute, path: '/providers', component: ProvidersPage });

const profileRoute = createRoute({ getParentRoute: () => shellRoute, id: '_profile', beforeLoad: requireProfile });
const homeRoute = createRoute({ getParentRoute: () => profileRoute, path: '/', component: HomePage });
const browseRoute = createRoute({ getParentRoute: () => profileRoute, path: '/browse', validateSearch: browseSearch, component: BrowsePage });
const searchRoute = createRoute({ getParentRoute: () => profileRoute, path: '/search', validateSearch: searchSearch, component: SearchPage });
const itemRoute = createRoute({
  getParentRoute: () => profileRoute,
  path: '/item/$itemId',
  component: function ItemRoute() {
    const { itemId } = useParams({ from: '/_shell/_profile/item/$itemId' });
    return <ItemPage itemId={itemId} />;
  },
});

const PlayerPage = lazyRouteComponent(() => import('../features/player/PlayerPage.tsx'), 'PlayerPage');

const watchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/watch/$itemId',
  beforeLoad: requireProfile,
  validateSearch: playerSearch,
  component: withChunk(function WatchRoute() {
    const { itemId } = useParams({ from: '/watch/$itemId' });
    const s = useSearch({ from: '/watch/$itemId' });
    return <PlayerPage key={`${itemId}:${s.fileId ?? ''}`} itemId={itemId} fileId={s.fileId} startPositionMs={s.t} audioTrackId={s.audio} forceMode={s.force} />;
  }, PlayerPage),
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    profilesRoute,
    aboutRoute,
    adminRoute.addChildren([adminIndexRoute, casesRoute, caseRoute, rootsRoute, filesRoute, ingestRoute, providersRoute]),
    profileRoute.addChildren([homeRoute, browseRoute, searchRoute, itemRoute]),
  ]),
  watchRoute,
]);

/** history: browser history in the app, memory history in tests. */
export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({ routeTree, context, defaultPreload: 'intent', scrollRestoration: true, ...(history ? { history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
