// Health and server info (doc 03 §3.1).
import type { Ok } from '../../app/http.ts';
import type { ModuleFactory } from '../../app/module.ts';

const VERSION = '0.1.0';

export const createSystemModule: ModuleFactory = ({ db, config }) => ({
  name: 'system',
  handlers: {
    getHealth: async (_req, reply): Promise<Ok<'getHealth'>> => {
      let dbOk = true;
      try {
        db.$client.prepare('SELECT 1').get();
      } catch {
        dbOk = false;
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
        features: { transcode: false, directStream: true },
        ingest: {
          running: count("SELECT count(*) AS n FROM job WHERE state = 'running'") > 0,
          queued: count("SELECT count(*) AS n FROM job WHERE state = 'queued'"),
          needsReview: count("SELECT count(*) AS n FROM identification_case WHERE state = 'needs_review'"),
        },
        providers: [
          { name: 'wikidata', status: config.WIKIDATA_ENABLED ? 'ok' : 'disabled', attribution: 'Wikidata (CC0)' },
          {
            name: 'tmdb',
            status: config.TMDB_READ_TOKEN ? 'ok' : 'not_configured',
            attribution: 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
          },
        ],
      };
    },
  },
});
