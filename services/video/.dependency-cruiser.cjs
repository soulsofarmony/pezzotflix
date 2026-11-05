// Module boundaries of the Video Service (doc 02, ADR 0001). Run: npm run lint.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-imports',
      comment: 'Modules talk through ports (src/shared/ports.ts) wired in src/app/compose.ts, never by importing each other.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/([^/]+)/', pathNot: '^src/modules/$1/' },
    },
    {
      name: 'compose-only-module-entrypoints',
      severity: 'error',
      from: { path: '^src/app/' },
      to: { path: '^src/modules/[^/]+/(?!index\.ts$)' },
    },
    {
      name: 'decision-engine-is-pure',
      comment: 'The Decision Engine is pure (doc 03 §8): no I/O, no DB, no HTTP, no processes.',
      severity: 'error',
      from: { path: '^src/modules/playback/decision/' },
      to: {
        path: '^(src/db/|src/app/(server|compose|config)\.ts)|^node:(fs|child_process|net|http|https)|^(fs|child_process|net|http|https)$|execa|fastify|better-sqlite3|drizzle-orm',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'delivery-is-extractable',
      comment: 'Stream Delivery must stay extractable into video-worker (C1): no DB access.',
      severity: 'error',
      from: { path: '^src/modules/delivery/' },
      to: { path: '^src/db/|better-sqlite3|drizzle-orm' },
    },
    {
      name: 'shared-is-leaf',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(modules|app|db)/' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.d.ts', '.js'] },
  },
};
