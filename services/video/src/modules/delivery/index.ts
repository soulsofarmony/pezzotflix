// Module 'delivery' (doc 02 §3.11, ADR 0003): Stream Delivery. Provides StreamDeliveryPort, owns the
// data-plane routes (/video/media/s/{token}/…), the token table, the ffmpeg runs, the scratch and the
// keyframe index cache. No DB access, so it can move into video-worker as is (C1).
import type { ModuleFactory } from '../../app/module.ts';
import { JOB_TYPES } from '../../shared/job-types.ts';
import { deliveryHandlers } from './handlers.ts';
import { createDeliveryProbe, type DeliveryProbe } from './probe.ts';
import { execaSpawn, type Spawn } from './process.ts';
import { createDelivery, type DeliveryDeps, KEYFRAME_JOB_MAX_ATTEMPTS } from './service.ts';

export interface DeliveryModuleOptions {
  /** Tests inject fakes; defaults run FFMPEG_PATH and FFPROBE_PATH. */
  spawn?: Spawn;
  /** ffmpeg of the subtitle extraction; default spawn. */
  extractSpawn?: Spawn;
  probe?: DeliveryProbe;
  timings?: DeliveryDeps['timings'];
  extractTimings?: DeliveryDeps['extractTimings'];
}

export function deliveryModule(options: DeliveryModuleOptions = {}): ModuleFactory {
  return function createDeliveryModule(ctx) {
    const delivery = createDelivery({
      config: ctx.config,
      log: ctx.log,
      now: ctx.now,
      jobs: () => ctx.ports.jobs,
      events: () => ctx.ports.events,
      spawn: options.spawn ?? execaSpawn(ctx.config.FFMPEG_PATH),
      ...(options.extractSpawn ? { extractSpawn: options.extractSpawn } : {}),
      probe: options.probe ?? createDeliveryProbe(ctx.config.FFPROBE_PATH),
      ...(options.timings ? { timings: options.timings } : {}),
      ...(options.extractTimings ? { extractTimings: options.extractTimings } : {}),
    });
    return {
      name: 'delivery',
      provides: { streamDelivery: delivery.port },
      handlers: deliveryHandlers(delivery, ctx.config, ctx.now),
      // One index at a time: the slow probe reads the media mount (ADR 0001 rule 6).
      jobs: { [JOB_TYPES.deliveryKeyframeIndex]: { concurrency: 1, maxAttempts: KEYFRAME_JOB_MAX_ATTEMPTS, handler: delivery.keyframeJob } },
      start: () => delivery.clearScratch(),
      stop: () => delivery.shutdown(),
    };
  };
}

export const createDeliveryModule: ModuleFactory = deliveryModule();
