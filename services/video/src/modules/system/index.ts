// Health and server info (doc 03 §3.1).
import type { Ok } from '../../app/http.ts';
import type { ModuleFactory, Ports } from '../../app/module.ts';
import { METADATA_PROVIDERS, type ProviderStatus, TMDB_NOTICE, WIKIDATA_NOTICE } from '../../shared/metadata.ts';

const VERSION = '0.1.0';

type ProviderInfo = Ok<'getServerInfo'>['providers'][number];

/** A port no module provides throws on access (compose.ts); here that means "not there". */
function optional<K extends keyof Ports>(ports: Ports, key: K): Ports[K] | null {
  try {
    return ports[key];
  } catch {
    return null;
  }
}

export const createSystemModule: ModuleFactory = ({ db, config, ports }) => {
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
          providers: providers(),
        };
      },
    },
  };
};
