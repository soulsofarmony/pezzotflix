// Module 'catalog' (doc 02 §3.6). F1a.2: the write side (CatalogWritePort) used by the identifier and,
// later, the Enricher. Read handlers (Home, lists, search, item, children) come in F1a.3.
import type { ModuleFactory } from '../../app/module.ts';
import { createCatalogWriter } from './write.ts';

const DAY_MS = 24 * 3600_000;

export const createCatalogModule: ModuleFactory = ({ db, now, ports, config }) => {
  const writer = createCatalogWriter({ db, now, events: () => ports.events, tmdbMaxAgeMs: config.TMDB_MAX_AGE_DAYS * DAY_MS });
  return {
    name: 'catalog',
    provides: { catalogWrite: writer },
  };
};
