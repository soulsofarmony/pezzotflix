// Entry point: services, router and providers. The gateway serves this SPA, so the API base is the page origin.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { createAppRouter } from './app/router.tsx';
import { createServices } from './app/services.tsx';
import './styles/global.css';

let router: ReturnType<typeof createAppRouter> | null = null;

const services = createServices({
  baseUrl: window.location.origin,
  storage: window.localStorage,
  // A 401 on a profile operation: the token is gone, back to "Chi guarda?".
  onUnauthorized: () => void router?.navigate({ to: '/profiles' }),
});
router = createAppRouter({ store: services.store });

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <App services={services} router={router} />
  </StrictMode>,
);
