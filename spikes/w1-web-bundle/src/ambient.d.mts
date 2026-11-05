// hls.js 1.7.4 exports "./light" without a types condition: re-export the main typings.
declare module 'hls.js/light' {
  export * from 'hls.js';
  export { default } from 'hls.js';
}
declare module '*?url' {
  const url: string;
  export default url;
}
// libpgs 0.9.0 declares side-effect imports of its bundled polyfills (TS2882 with skipLibCheck false).
declare module 'core-js/stable/promise';
declare module 'whatwg-fetch';
