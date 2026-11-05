// Module 'catalog' (doc 02 §3.6). Write side (CatalogWritePort, F1a.2) used by the identifier, the
// admin resolutions and the Enricher; read side (F1a.3): Home, lists, search, item detail, children,
// CatalogReadPort for playback and CatalogViewPort for the admin API.
import type { ModuleFactory, Ports } from '../../app/module.ts';
import { catalogHandlers } from './handlers.ts';
import { createCatalogLinks } from './links.ts';
import { createCatalogReader } from './read.ts';
import { createCatalogWriter } from './write.ts';

const DAY_MS = 24 * 3600_000;

export const createCatalogModule: ModuleFactory = ({ db, now, ports, config, log }) => {
  const tmdbMaxAgeMs = config.TMDB_MAX_AGE_DAYS * DAY_MS;
  const writer = createCatalogWriter({ db, now, log, events: () => ports.events, jobs: () => ports.jobs, tmdbMaxAgeMs });
  const reader = createCatalogReader({ db, now, tmdbMaxAgeMs, profileState: () => optionalPort(ports, 'profileState') });
  return {
    name: 'catalog',
    provides: {
      catalogWrite: writer,
      catalogRead: reader.port,
      catalogLinks: createCatalogLinks({ db, now, events: () => ports.events }),
      catalogViews: { summaries: (ids) => reader.summaries(ids), mediaVersion: (fileId) => reader.mediaVersion(fileId) },
    },
    handlers: catalogHandlers(reader),
  };
};

/** A port no module provides throws on access (compose.ts); here that means "not there yet". */
function optionalPort<K extends keyof Ports>(ports: Ports, key: K): Ports[K] | null {
  try {
    return ports[key];
  } catch {
    return null;
  }
}
