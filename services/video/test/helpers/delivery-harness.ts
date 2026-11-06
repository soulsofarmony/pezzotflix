// A delivery module over real ffmpeg (or a fake spawn and probe), behind the real HTTP server (contract routes), for the
// integration tests. Data, cache and scratch live in a temp dir.
import { rmSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { loadConfig, type Config } from '../../src/app/config.ts';
import { buildServer } from '../../src/app/server.ts';
import { deliveryHandlers } from '../../src/modules/delivery/handlers.ts';
import { createDeliveryProbe } from '../../src/modules/delivery/probe.ts';
import { execaSpawn } from '../../src/modules/delivery/process.ts';
import { createDelivery, type Delivery, type DeliveryDeps } from '../../src/modules/delivery/service.ts';
import { fakeExtractor } from './delivery-fake-extract.ts';
import { FFMPEG, FFPROBE, tempDir } from './delivery-media.ts';

export interface Harness {
  config: Config;
  delivery: Delivery;
  app: FastifyInstance;
  enqueued: { type: string; payload: unknown; priority?: number; idempotencyKey?: string }[];
  /** Domain events published by delivery (playback.subtitle_ready). */
  events: { type: string; payload: Record<string, unknown> }[];
  dataDir: string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  timings?: DeliveryDeps['timings'];
  spawn?: DeliveryDeps['spawn'];
  /** Subtitle extraction; with a fake spawn and no extractSpawn, an extraction that never ends (tracks stay growing). */
  extractSpawn?: DeliveryDeps['spawn'];
  extractTimings?: DeliveryDeps['extractTimings'];
  probe?: DeliveryDeps['probe'];
  convertSidecar?: DeliveryDeps['convertSidecar'];
}

export async function harness(roots: { name: string; path: string }[], opts: HarnessOptions = {}): Promise<Harness> {
  const dataDir = tempDir('pzf-delivery-');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    FFMPEG_PATH: FFMPEG,
    FFPROBE_PATH: FFPROBE,
    LIBRARY_ROOTS: JSON.stringify(roots.map((r) => ({ ...r, hint: 'movies' }))),
    ...opts.env,
  });
  const enqueued: Harness['enqueued'] = [];
  const events: Harness['events'] = [];
  const extractSpawn = opts.extractSpawn ?? (opts.spawn ? fakeExtractor().spawn : undefined);
  const delivery = createDelivery({
    config,
    log: pino({ level: process.env.PZF_TEST_LOG ?? 'silent' }),
    now: Date.now,
    jobs: () => ({
      enqueue: (j) => {
        enqueued.push(j);
        return 'job';
      },
    }),
    events: () => ({ publish: (type, payload) => void events.push({ type, payload }) }),
    spawn: opts.spawn ?? execaSpawn(FFMPEG),
    ...(extractSpawn ? { extractSpawn } : {}),
    probe: opts.probe ?? createDeliveryProbe(FFPROBE),
    ...(opts.timings ? { timings: opts.timings } : {}),
    ...(opts.extractTimings ? { extractTimings: opts.extractTimings } : {}),
    ...(opts.convertSidecar ? { convertSidecar: opts.convertSidecar } : {}),
  });
  await delivery.clearScratch();
  const app = await buildServer({ logger: false, profileTokens: { verify: () => null }, handlers: deliveryHandlers(delivery, config, Date.now) });
  await app.ready();
  return {
    config,
    delivery,
    app,
    enqueued,
    events,
    dataDir,
    async close() {
      await delivery.shutdown();
      await app.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
