// URL search parameters of the views, validated with zod (ADR 0005 point 3): a link or "back" restores the view.
import { z } from 'zod';

const optionalBool = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true')
  .optional()
  .catch(undefined);

export const browseSearch = z.object({
  kind: z.enum(['movie', 'series', 'season', 'episode', 'extra']).optional().catch(undefined),
  category: z.enum(['film', 'documentary']).optional().catch(undefined),
  sort: z.enum(['title', 'year', 'added', 'duration', 'last_played']).optional().catch(undefined),
  order: z.enum(['asc', 'desc']).optional().catch(undefined),
  watched: optionalBool,
  inWatchlist: optionalBool,
  continueWatching: optionalBool,
});
export type BrowseSearch = z.infer<typeof browseSearch>;

export const searchSearch = z.object({
  q: z.string().max(200).optional().catch(undefined),
  kind: z.enum(['movie', 'series', 'episode', 'extra']).optional().catch(undefined),
});

export const playerSearch = z.object({
  fileId: z.string().optional().catch(undefined),
  /** Original position in ms; absent = the profile's resume position. */
  t: z.coerce.number().int().min(0).optional().catch(undefined),
  audio: z.string().optional().catch(undefined),
  /** Diagnostics only (contract forceMode). */
  force: z.enum(['direct_play', 'direct_stream', 'transcode']).optional().catch(undefined),
});

/** "File mancanti": the root filter. */
export const filesSearch = z.object({
  rootId: z.string().min(1).optional().catch(undefined),
});

export const casesSearch = z.object({
  state: z.enum(['pending', 'auto_matched', 'needs_review', 'resolved', 'ignored']).optional().catch(undefined),
});
