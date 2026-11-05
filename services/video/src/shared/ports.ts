// Ports between modules (doc 02, doc 03 §8). Plain serializable data only.
// Each port is implemented by exactly one module and consumed through the composition root
// (src/app/compose.ts); modules never import each other's internals.
import type { components } from '../contract/schema.d.ts';
import type { MediaFacts } from './media-facts.ts';

export type ApiSchemas = components['schemas'];
export type ItemSummary = ApiSchemas['ItemSummary'];
export type ProfileItemState = ApiSchemas['ProfileItemState'];
export type ProfilePrefs = ApiSchemas['ProfilePrefs'];
export type ClientCapabilities = ApiSchemas['ClientCapabilities'];

/** A playable file linked to an item, as the Playback module needs it. Implemented by catalog. */
export interface PlayableFile {
  fileId: string;
  available: boolean;
  facts: MediaFacts;
}

export interface PlayableItem {
  itemId: string;
  kind: ItemSummary['kind'];
  title: string;
  durationMs: number | null;
  files: PlayableFile[];
}

/** Implemented by modules/catalog. */
export interface CatalogReadPort {
  getPlayableItem(itemId: string): PlayableItem | null;
  /** Ids of episodes of a series/season (for watched propagation), in order. */
  listPlayableDescendants(itemId: string): string[];
  itemExists(itemId: string): boolean;
}

/** Implemented by modules/profiles. Used by catalog to compose Home and summaries. */
export interface ProfileStatePort {
  getStates(profileId: string, itemIds: readonly string[]): Map<string, ProfileItemState>;
  /** Items in progress (not watched, 0 < progress < 90%), most recent first. */
  continueWatching(profileId: string, limit: number): string[];
  /** Episode id to watch next in a series, or null. */
  nextUp(profileId: string, seriesId: string): string | null;
}

/** Implemented by modules/profiles. Used by the HTTP security handler. */
export interface ProfileTokenVerifier {
  /** Returns the profile id for a valid profile token, null otherwise. */
  verify(token: string): string | null;
}

/** Implemented by modules/jobs (doc 03 §8 JobRunner). */
export interface JobQueuePort {
  enqueue(job: {
    type: string;
    payload: unknown;
    priority?: number;
    idempotencyKey?: string;
    runAt?: number;
  }): string | null;
}

/** Implemented by modules/events (table domain_event); all modules may publish. */
export interface EventPublisher {
  publish(type: string, payload: Record<string, unknown>): void;
}
