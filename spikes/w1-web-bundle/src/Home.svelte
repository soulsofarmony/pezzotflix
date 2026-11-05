<script>
  import { createQuery } from '@tanstack/svelte-query';
  import createClient from 'openapi-fetch';
  const api = createClient({ baseUrl: '/' });
  let n = $state(0);
  const q = createQuery(() => ({ queryKey: ['h'], queryFn: () => api.GET('/video/api/v1/home').then((r) => r.data), refetchInterval: 5000 }));
</script>

<button onclick={() => n++}>{n}</button><pre>{JSON.stringify(q.data)}</pre><a href="#x">x</a>
