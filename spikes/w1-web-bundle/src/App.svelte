<script>
  // Variant b0 root: hash switch written by hand, no router. Throwaway (W1).
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import Home from './Home.svelte';
  const qc = new QueryClient();
  let route = $state(location.hash);
</script>

<svelte:window onhashchange={() => (route = location.hash)} />
<QueryClientProvider client={qc}>{#if route === '#x'}<p>x</p>{:else}<Home />{/if}</QueryClientProvider>
