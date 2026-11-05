// Local declarations (ADR 0005 point 1). Keep them aligned with hls.js and libpgs upgrades.

// hls.js 1.7.4 exports "./light" without a types condition: re-export the typings of the full build.
declare module 'hls.js/light' {
  export * from 'hls.js';
  export { default } from 'hls.js';
}

// libpgs 0.9.0 declares side-effect imports of its bundled polyfills.
declare module 'core-js/stable/promise';
declare module 'whatwg-fetch';

/** Web client version, from package.json (vite.config.ts define). */
declare const __APP_VERSION__: string;
