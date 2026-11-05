// Providers and router of the app, shared by main.tsx and the component tests.
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { type ReactElement, useEffect } from 'react';
import { VideoClientProvider } from '../api/queries.ts';
import type { createAppRouter } from './router.tsx';
import { type AppServices, ServicesProvider, useProfile, useServices } from './services.tsx';

/** Polls events while a profile is selected (listEvents needs the profile token). */
function EventPolling(): null {
  const profile = useProfile();
  const { poller } = useServices();
  useEffect(() => {
    if (!profile) return;
    poller.start();
    return () => poller.stop();
  }, [profile, poller]);
  return null;
}

export function App({ services, router }: { services: AppServices; router: ReturnType<typeof createAppRouter> }): ReactElement {
  return (
    <ServicesProvider services={services}>
      <QueryClientProvider client={services.queryClient}>
        <VideoClientProvider value={services.client}>
          <EventPolling />
          <RouterProvider router={router} />
        </VideoClientProvider>
      </QueryClientProvider>
    </ServicesProvider>
  );
}
