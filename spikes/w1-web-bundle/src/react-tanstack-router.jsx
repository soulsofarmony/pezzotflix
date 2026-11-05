// Variant a1: a0 + TanStack Router (routes in code, no plugin). Throwaway (W1).
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createRouter, createRootRoute, createRoute, RouterProvider, Outlet, Link } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import createClient from 'openapi-fetch';

const api = createClient({ baseUrl: '/' });
const qc = new QueryClient();

function Home() {
  const q = useQuery({ queryKey: ['h'], queryFn: () => api.GET('/video/api/v1/home').then((r) => r.data), refetchInterval: 5000 });
  const [n, setN] = useState(0);
  return <div><button onClick={() => setN(n + 1)}>{n}</button><pre>{JSON.stringify(q.data)}</pre><Link to="/x">x</Link></div>;
}

const root = createRootRoute({ component: () => <Outlet /> });
const router = createRouter({
  routeTree: root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/', component: Home }),
    createRoute({ getParentRoute: () => root, path: '/x', component: () => <p>x</p> }),
  ]),
});

createRoot(document.getElementById('root')).render(<StrictMode><QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
// Lazy player chunks: each becomes its own asset in the build output.
if (location.hash === '#full') void import('./player-full.js');
if (location.hash === '#light') void import('./player-light.js');
