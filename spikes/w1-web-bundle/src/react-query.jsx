// Variant a0: React + TanStack Query + openapi-fetch, no router. Throwaway (W1).
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import createClient from 'openapi-fetch';

const api = createClient({ baseUrl: '/' });
const qc = new QueryClient();

function Home() {
  const q = useQuery({ queryKey: ['h'], queryFn: () => api.GET('/video/api/v1/home').then((r) => r.data), refetchInterval: 5000 });
  const [n, setN] = useState(0);
  return <div><button onClick={() => setN(n + 1)}>{n}</button><pre>{JSON.stringify(q.data)}</pre></div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><QueryClientProvider client={qc}><Home /></QueryClientProvider></StrictMode>);
