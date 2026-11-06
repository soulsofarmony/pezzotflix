// Health and server info (doc 03 §3.1), and the database's daily upkeep (ADR 0002 points 1 and 10):
// the checked backup with its retention, and PRAGMA optimize.
import type { FastifyBaseLogger } from 'fastify';
import type { Ok } from '../../app/http.ts';
import type { ModuleFactory, PeriodicTask, Ports } from '../../app/module.ts';
import { BACKUP_EVERY_MS, backupDatabase, lastDailyBackupAt } from '../../db/backup.ts';
import type { Db } from '../../db/index.ts';
import { METADATA_PROVIDERS, type ProviderStatus, TMDB_NOTICE, WIKIDATA_NOTICE } from '../../shared/metadata.ts';

const VERSION = '0.1.0';
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

type ProviderInfo = Ok<'getServerInfo'>['providers'][number];

/** A port no module provides throws on access (compose.ts); here that means "not there". */
function optional<K extends keyof Ports>(ports: Ports, key: K): Ports[K] | null {
  try {
    return ports[key];
  } catch {
    return null;
  }
}

/**
 * Whether the daily backup is due, from the newest copy not dated in the future (lastDailyBackupAt:
 * a copy from a clock that jumped ahead would otherwise stop backups until that date). The check
 * runs hourly, so a copy up to an hour short of a day counts as a day old: otherwise the time of
 * the backup would slide an hour later each day.
 */
export function backupDue(last: number | null, now: number): boolean {
  return last === null || now - last >= BACKUP_EVERY_MS - HOUR_MS;
}

/**
 * The daily backup, checked every hour and at start: a service that never stays up for a day (a
 * host that sleeps, a restart loop) still gets one a day, and a restart does not add one. One run at a time.
 */
export function backupTask(deps: { db: Db; dir: string; now: () => number; log: FastifyBaseLogger }): PeriodicTask {
  let running = false;
  return {
    name: 'db.backup',
    everyMs: HOUR_MS,
    runAtStart: true,
    run: async () => {
      if (running) return;
      if (!backupDue(lastDailyBackupAt(deps.dir, deps.now()), deps.now())) return;
      running = true;
      try {
        const { file, pruned } = await backupDatabase(deps.db.$client, { dir: deps.dir, now: deps.now() });
        deps.log.info({ file, pruned }, 'database backed up');
      } catch (err) {
        deps.log.error({ dir: deps.dir, err: err instanceof Error ? err.message : String(err) }, 'database backup failed');
      } finally {
        running = false;
      }
    },
  };
}

export const createSystemModule: ModuleFactory = ({ db, config, ports, now, log }) => {
  /**
   * Providers for the "Informazioni / Crediti" page (ADR 0007 point 8), from the registry's live
   * state and the adapters' notices. TMDB is listed when it is configured, or when TMDB data is
   * still in the catalog (token removed: the data stays until it expires, and so does the notice).
   */
  function providers(): ProviderInfo[] {
    const live = optional(ports, 'metadataSearch')?.status() ?? [];
    const byName = new Map(live.map((p) => [p.provider, p]));
    const out: ProviderInfo[] = [];
    for (const name of METADATA_PROVIDERS) {
      const s: ProviderStatus = byName.get(name) ?? { provider: name, state: 'not_configured' };
      const attribution = s.attribution ?? (name === 'tmdb' ? TMDB_NOTICE : WIKIDATA_NOTICE);
      if (name === 'wikidata') {
        out.push({ name, status: config.WIKIDATA_ENABLED ? s.state : 'disabled', attribution });
        continue;
      }
      // TMDB_PURGE turns TMDB off on purpose: 'disabled', not 'not_configured'.
      const status: ProviderInfo['status'] = config.TMDB_PURGE ? 'disabled' : s.state;
      const shown = status !== 'not_configured' || (optional(ports, 'catalogWrite')?.hasSourceData('tmdb') ?? false);
      if (shown) out.push({ name, status, attribution });
    }
    return out;
  }

  return {
    name: 'system',
    periodic: [
      backupTask({ db, dir: config.backupDir, now, log }),
      { name: 'db.optimize', everyMs: DAY_MS, run: () => void db.$client.pragma('optimize') },
    ],
    handlers: {
      getHealth: async (req, reply): Promise<Ok<'getHealth'>> => {
        let dbOk = true;
        try {
          db.$client.prepare('SELECT 1').get();
        } catch (err) {
          dbOk = false;
          // Health requests are logged from warn up only (server.ts): this is what tells a failing check.
          req.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'health check: the database does not answer');
        }
        if (!dbOk) reply.status(503);
        return { status: dbOk ? 'ok' : 'degraded', db: dbOk ? 'ok' : 'error' };
      },
      getServerInfo: async (): Promise<Ok<'getServerInfo'>> => {
        const count = (sql: string) => (db.$client.prepare(sql).get() as { n: number }).n;
        return {
          name: 'Pezzotflix',
          version: VERSION,
          apiVersions: ['v1'],
          features: { transcode: config.MAX_TRANSCODES > 0, directStream: true },
          ingest: {
            running: count("SELECT count(*) AS n FROM job WHERE state = 'running'") > 0,
            queued: count("SELECT count(*) AS n FROM job WHERE state = 'queued'"),
            // The "Da verificare" queue (ListIdentificationCases): a forgotten file's case is not in it.
            needsReview: count(
              "SELECT count(*) AS n FROM identification_case c JOIN media_file f ON f.id = c.file_id WHERE c.state = 'needs_review' AND f.state <> 'removed'",
            ),
          },
          providers: providers(),
        };
      },
    },
  };
};
