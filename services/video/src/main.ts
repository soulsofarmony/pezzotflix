// Video Service entry point: config → DB → modules → HTTP server + job runner; graceful shutdown.
import { loadConfig } from './app/config.ts';
import { compose } from './app/compose.ts';
import { buildServer, createLogger } from './app/server.ts';
import { closeDb, openDb } from './db/index.ts';
import { createJobRunner } from './modules/jobs/index.ts';

const config = loadConfig();
const db = await openDb({ path: config.dbPath, backupDir: config.backupDir });

const log = createLogger(config.LOG_LEVEL);
const comp = compose({ config, db, log });
const app = await buildServer({
  logger: log,
  handlers: comp.handlers,
  profileTokens: { verify: (t) => comp.ports.profileTokens.verify(t) },
});

const runner = createJobRunner({ db, log: log.child({ module: 'jobs' }), jobTypes: comp.jobTypes, periodic: comp.periodic });

for (const m of comp.modules) await m.start?.();
runner.start();
await app.listen({ host: config.HOST, port: config.PORT });

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  // Delivery stops with the server: its ffmpeg runs and the media bodies it is sending end now, so
  // close() is not held by a paused client.
  const delivery = comp.modules.find((m) => m.name === 'delivery');
  await Promise.all([app.close(), delivery?.stop?.()]);
  await runner.stop();
  for (const m of [...comp.modules].reverse()) if (m !== delivery) await m.stop?.();
  closeDb(db);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
