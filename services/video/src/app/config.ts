// Runtime configuration, validated once at startup. Every key has a default except the library roots.
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const BYTE_UNITS: Record<string, number> = {
  '': 1, b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};
/** A byte count, plain or with a unit: "33554432", "32MiB", "20GB" (ADR 0003 D16 writes them so). */
const byteSize = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(String(v));
  const unit = m ? BYTE_UNITS[m[2]!.toLowerCase()] : undefined;
  if (!m || unit === undefined) {
    ctx.addIssue({ code: 'custom', message: `not a byte size: ${JSON.stringify(v)}` });
    return z.NEVER;
  }
  return Math.round(Number(m[1]) * unit);
});

const LibraryRootSpec = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  hint: z.enum(['movies', 'series', 'mixed']),
});
export type LibraryRootSpec = z.infer<typeof LibraryRootSpec>;

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8096),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATA_DIR: z.string().default('/data'),
  DB_PATH: z.string().optional(),
  // JSON array of {name, path, hint}; path is inside the container (read-only mount).
  LIBRARY_ROOTS: z
    .string()
    .default('[{"name":"Film","path":"/media/Film","hint":"movies"},{"name":"Serie","path":"/media/Serie","hint":"series"},{"name":"Documentari","path":"/media/Documentari","hint":"movies"}]')
    .transform((s, ctx) => {
      try {
        return z.array(LibraryRootSpec).parse(JSON.parse(s));
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: `LIBRARY_ROOTS is not valid JSON: ${String(e)}` });
        return z.NEVER;
      }
    }),
  LIBRARY_WATCH: z.enum(['off', 'auto']).default('off'),
  LIBRARY_SCAN_INTERVAL_MIN: z.coerce.number().int().min(1).default(15),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  SCRATCH_MAX_BYTES: byteSize.default(20 * 1024 ** 3),
  MAX_SESSIONS: z.coerce.number().int().min(1).default(1),
  MAX_TRANSCODES: z.coerce.number().int().min(0).default(1),
  SESSION_TIMEOUT_S: z.coerce.number().int().min(10).default(60),
  /** Longest a start or a session may wait without a stream (STREAM_PREPARING) before 500 STREAM_FAILED. */
  PLAYBACK_PREPARING_MAX_S: z.coerce.number().int().min(10).default(900),
  // Stream Delivery (ADR 0003 D16).
  HLS_SEGMENT_TARGET_S: z.coerce.number().min(1).max(10).default(4),
  HLS_SEGMENT_MAX_S: z.coerce.number().min(1).max(30).default(6),
  HLS_SEGMENT_MAX_BYTES: byteSize.default(32 * 1024 ** 2),
  DELIVERY_AHEAD_S: z.coerce.number().min(4).default(30),
  DELIVERY_BEHIND_S: z.coerce.number().min(0).default(30),
  DELIVERY_IDLE_KILL_S: z.coerce.number().min(5).default(120),
  /** A stopped or re-planned stream's token answers 410 for this long, then 404 (ADR 0003 D10). */
  DELIVERY_TOMBSTONE_TTL_S: z.coerce.number().int().min(1).default(3600),
  SUBTITLE_EXTRACT_MAX_MBPS: z.coerce.number().positive().default(15),
  SUBTITLE_PREROLL_S: z.coerce.number().min(0).default(60),
  /** A subtitle extraction pass whose clock and outputs stop moving this long (not held by the pacing) is killed. */
  SUBTITLE_EXTRACT_STALL_S: z.coerce.number().positive().default(60),
  SUBTITLE_PREEXTRACT: z.enum(['off', 'on']).default('off'),
  SUBTITLE_CACHE_MAX_BYTES: byteSize.default(20 * 1000 ** 3),
  TMDB_READ_TOKEN: z.string().optional(),
  TMDB_REFRESH_AFTER_DAYS: z.coerce.number().int().min(1).default(90),
  TMDB_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(180).default(180),
  // PurgeProviderData(tmdb) at startup, for the end of the TMDB licence (ADR 0007 point 5). While
  // set, TMDB is not used even with a token. Removing the token alone stops refreshes, not a purge.
  TMDB_PURGE: bool.default(false),
  WIKIDATA_ENABLED: bool.default(true),
  WIKIDATA_CONTACT: z.string().default('https://github.com/soulsofarmony/pezzotflix'),
  METADATA_LANGUAGE: z.string().default('it-IT'),
});

export type Config = z.infer<typeof Env> & {
  dbPath: string;
  cacheDir: string;
  artworkDir: string;
  thumbnailsDir: string;
  scratchDir: string;
  backupDir: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  return {
    ...c,
    dbPath: c.DB_PATH ?? `${c.DATA_DIR}/db/video.db`,
    cacheDir: `${c.DATA_DIR}/cache`,
    artworkDir: `${c.DATA_DIR}/artwork`,
    thumbnailsDir: `${c.DATA_DIR}/thumbnails`,
    scratchDir: `${c.DATA_DIR}/scratch`,
    backupDir: `${c.DATA_DIR}/backup`,
  };
}
