// Variant a2: a0 + React Router (data router). Throwaway (W1).
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Link } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import createClient from 'openapi-fetch';

const api = createClient({ baseUrl: '/' });
const qc = new QueryClient();

function Home() {
  const q = useQuery({ queryKey: ['h'], queryFn: () => api.GET('/video/api/v1/home').then((r) => r.data), refetchInterval: 5000 });
  const [n, setN] = useState(0);
  return <div><button onClick={() => setN(n + 1)}>{n}</button><pre>{JSON.stringify(q.data)}</pre><Link to="/x">x</Link></div>;
}

const router = createBrowserRouter([{ path: '/', element: <Home /> }, { path: '/x', element: <p>x</p> }]);
createRoot(document.getElementById('root')).render(<StrictMode><QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
