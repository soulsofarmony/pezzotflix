// Runtime configuration, validated once at startup. Every key has a default except the library roots.
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

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
  SCRATCH_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 ** 3),
  MAX_SESSIONS: z.coerce.number().int().min(1).default(1),
  MAX_TRANSCODES: z.coerce.number().int().min(0).default(1),
  SESSION_TIMEOUT_S: z.coerce.number().int().min(10).default(60),
  TMDB_READ_TOKEN: z.string().optional(),
  TMDB_REFRESH_AFTER_DAYS: z.coerce.number().int().min(1).default(90),
  TMDB_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(180).default(180),
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
