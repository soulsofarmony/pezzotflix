// Boundaries of the web client (ADR 0005 points 1 and 4). Run: npm run lint.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'player-without-framework',
      comment:
        'The player engine is plain TypeScript (ADR 0005 point 4): no React, no router or query cache, no UI code. ' +
        'It survives a framework change and is tested without a browser.',
      severity: 'error',
      from: { path: '^src/player/' },
      to: {
        path: '^src/(features|app|ui|i18n)/|(^|/)node_modules/(react|react-dom|@tanstack)/|^(react|react-dom|@tanstack/)',
      },
    },
    {
      name: 'player-uses-api-types-only',
      comment: 'The player talks to the server through its PlaybackApi port; from src/api it may only take types.',
      severity: 'error',
      from: { path: '^src/player/' },
      to: { path: '^src/api/(?!types\\.ts$|schema\\.d\\.ts$)' },
    },
    {
      name: 'api-is-below-ui',
      comment: 'The API layer does not know the UI.',
      severity: 'error',
      from: { path: '^src/api/' },
      to: { path: '^src/(features|app|ui)/' },
    },
    {
      name: 'i18n-is-leaf',
      severity: 'error',
      from: { path: '^src/i18n/' },
      to: { path: '^src/(features|app|ui|api|player)/' },
    },
    {
      name: 'ui-is-generic',
      comment: 'Shared UI pieces do not depend on features or on the app shell.',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { path: '^src/(features|app)/' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: 'src/api/schema\\.d\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.d.ts', '.js'] },
  },
};
