// Web client build (ADR 0005 point 1): static files in dist/, hashed assets in /assets/ (Caddy marks them
// immutable). In development Vite runs on the host and proxies /video to the gateway (ADR 0006 point 5).
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: 'dist', assetsDir: 'assets', emptyOutDir: true, target: 'es2024', sourcemap: true },
  server: {
    port: 5173,
    strictPort: true,
    // PZF_GATEWAY_URL points the proxy elsewhere, e.g. at a Video Service started on the host.
    proxy: { '/video': { target: process.env.PZF_GATEWAY_URL ?? 'http://localhost:8080' } },
  },
});
