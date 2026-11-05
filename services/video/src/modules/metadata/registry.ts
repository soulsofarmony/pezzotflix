// Provider registry: the MetadataSearchPort of doc 03 §8 over the configured adapters. The caller
// picks the provider (the identifier owns the order); a provider that is not configured, or whose
// credentials were refused, answers 'unavailable' without any network call.
import { METADATA_PROVIDERS, type MetadataProviderName, type ProviderResult, TMDB_NOTICE, WIKIDATA_NOTICE } from '../../shared/metadata.ts';
import type { MetadataSearchPort } from '../../shared/ports.ts';
import type { ProviderAdapter } from './types.ts';

export type Registry = MetadataSearchPort & {
  /** The adapter if it is usable now (state ok or degraded), else null. */
  active(provider: MetadataProviderName): ProviderAdapter | null;
};

const NOTICES: Record<MetadataProviderName, string> = { tmdb: TMDB_NOTICE, wikidata: WIKIDATA_NOTICE };

export function createRegistry(adapters: Partial<Record<MetadataProviderName, ProviderAdapter>>): Registry {
  const active = (p: MetadataProviderName): ProviderAdapter | null => {
    const a = adapters[p];
    if (!a) return null;
    const s = a.state();
    return s === 'ok' || s === 'degraded' ? a : null;
  };
  const off = (p: MetadataProviderName): ProviderResult<never> => ({ status: 'unavailable', detail: `${p}: not active` });
  return {
    active,
    // The notice also for a provider not configured now: its data may still be in the catalog.
    status: () =>
      METADATA_PROVIDERS.map((provider) => ({
        provider,
        state: adapters[provider]?.state() ?? 'not_configured',
        attribution: adapters[provider]?.terms().attribution ?? NOTICES[provider],
      })),
    search: async (p, req) => (await active(p)?.search(req)) ?? off(p),
    lookupByExternalId: async (p, lookup) => (await active(p)?.lookupByExternalId(lookup)) ?? off(p),
  };
}
