// Module contract for the modular monolith (doc 02). The composition root (compose.ts) creates
// every module with a ModuleContext, collects handlers/jobs and wires ports lazily, so modules
// never import each other: they depend on ports from src/shared/ports.ts.
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.ts';
import type {
  CatalogReadPort,
  CatalogWritePort,
  EventPublisher,
  JobQueuePort,
  MetadataSearchPort,
  ProfileStatePort,
  ProfileTokenVerifier,
  StreamDeliveryPort,
} from '../shared/ports.ts';
import type { Config } from './config.ts';
import type { Handlers } from './http.ts';

export interface Ports {
  catalogRead: CatalogReadPort;
  catalogWrite: CatalogWritePort;
  metadataSearch: MetadataSearchPort;
  profileState: ProfileStatePort;
  profileTokens: ProfileTokenVerifier;
  jobs: JobQueuePort;
  events: EventPublisher;
  streamDelivery: StreamDeliveryPort;
}

export interface JobContext {
  jobId: string;
  attempt: number;
  log: FastifyBaseLogger;
  signal: AbortSignal;
}

/** A job handler; throw to fail (the runner retries with backoff), return to complete. */
export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<void>;

export interface JobTypeSpec {
  handler: JobHandler;
  /** Max jobs of this type running at once (ADR 0001: probe 1, identify 1, metadata 1, artwork 2). */
  concurrency: number;
  maxAttempts?: number;
}

export interface PeriodicTask {
  name: string;
  everyMs: number;
  /** Run once at startup too. */
  runAtStart?: boolean;
  run: () => Promise<void> | void;
}

export interface ModuleContext {
  config: Config;
  db: Db;
  log: FastifyBaseLogger;
  /** Resolved lazily: access ports inside functions, not at module creation time. */
  ports: Ports;
  now: () => number;
}

export interface AppModule {
  name: string;
  handlers?: Handlers;
  provides?: Partial<Ports>;
  jobs?: Record<string, JobTypeSpec>;
  periodic?: PeriodicTask[];
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

export type ModuleFactory = (ctx: ModuleContext) => AppModule;
