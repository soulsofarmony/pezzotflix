// Module 'analyzer' (doc 02 §3.2): job analyzer.probe → MediaFacts → media_file, media_stream,
// chapter; then enqueues identifier.identify.
import type { ModuleFactory } from '../../app/module.ts';
import { JOB_TYPES } from '../../shared/job-types.ts';
import { createFfprobeRunner, type ProbeRunner } from './ffprobe.ts';
import { createAnalyzer } from './service.ts';

export const PROBE_MAX_ATTEMPTS = 3;

export interface AnalyzerModuleOptions {
  /** Tests inject a fake; default is ffprobe at config.FFPROBE_PATH. */
  runner?: ProbeRunner;
}

export function analyzerModule(options: AnalyzerModuleOptions = {}): ModuleFactory {
  return function createAnalyzerModule(ctx) {
    const analyzer = createAnalyzer({
      db: ctx.db,
      now: ctx.now,
      jobs: () => ctx.ports.jobs,
      runner: options.runner ?? createFfprobeRunner(ctx.config.FFPROBE_PATH),
      maxAttempts: PROBE_MAX_ATTEMPTS,
    });
    return {
      name: 'analyzer',
      // Concurrency 1: the NTFS bind mount is slow (ADR 0001 rule 6).
      jobs: { [JOB_TYPES.analyzerProbe]: { concurrency: 1, maxAttempts: PROBE_MAX_ATTEMPTS, handler: analyzer.probe } },
    };
  };
}

export const createAnalyzerModule: ModuleFactory = analyzerModule();
