// Composition root: creates modules, wires ports, collects handlers, jobs and periodic tasks.
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.ts';
import { createAdminModule } from '../modules/admin/index.ts';
import { createAnalyzerModule } from '../modules/analyzer/index.ts';
import { createCatalogModule } from '../modules/catalog/index.ts';
import { createDeliveryModule } from '../modules/delivery/index.ts';
import { createEventsModule } from '../modules/events/index.ts';
import { createIdentifierModule } from '../modules/identifier/index.ts';
import { createJobsModule } from '../modules/jobs/index.ts';
import { createLibraryModule } from '../modules/library/index.ts';
import { createMetadataModule } from '../modules/metadata/index.ts';
import { createPlaybackModule } from '../modules/playback/index.ts';
import { createProfilesModule } from '../modules/profiles/index.ts';
import { createSystemModule } from '../modules/system/index.ts';
import type { Config } from './config.ts';
import type { Handlers } from './http.ts';
import type { AppModule, JobTypeSpec, ModuleContext, ModuleFactory, PeriodicTask, Ports } from './module.ts';

export const MODULE_FACTORIES: readonly ModuleFactory[] = [
  createEventsModule,
  createJobsModule,
  createSystemModule,
  createLibraryModule,
  createAnalyzerModule,
  createIdentifierModule,
  createMetadataModule,
  createCatalogModule,
  createProfilesModule,
  createPlaybackModule,
  createDeliveryModule,
  createAdminModule,
];

export interface Composition {
  modules: AppModule[];
  handlers: Handlers;
  ports: Ports;
  jobTypes: Map<string, JobTypeSpec>;
  periodic: PeriodicTask[];
}

function lazyPorts(): { ports: Ports; provide: (p: Partial<Ports>, owner: string) => void } {
  const table = new Map<string, unknown>();
  const owners = new Map<string, string>();
  const ports = new Proxy({} as Ports, {
    get(_t, key: string) {
      if (!table.has(key)) throw new Error(`port '${key}' is not provided by any module`);
      return table.get(key);
    },
  });
  const provide = (p: Partial<Ports>, owner: string) => {
    for (const [k, v] of Object.entries(p)) {
      if (owners.has(k)) throw new Error(`port '${k}' provided twice (${owners.get(k)}, ${owner})`);
      owners.set(k, owner);
      table.set(k, v);
    }
  };
  return { ports, provide };
}

export function compose(args: {
  config: Config;
  db: Db;
  log: FastifyBaseLogger;
  now?: () => number;
  factories?: readonly ModuleFactory[];
}): Composition {
  const { ports, provide } = lazyPorts();
  const ctx: ModuleContext = { config: args.config, db: args.db, log: args.log, ports, now: args.now ?? Date.now };
  const modules: AppModule[] = [];
  const handlers: Handlers = {};
  const jobTypes = new Map<string, JobTypeSpec>();
  const periodic: PeriodicTask[] = [];

  for (const factory of args.factories ?? MODULE_FACTORIES) {
    const m = factory({ ...ctx, log: args.log.child({ module: factory.name }) });
    modules.push(m);
    if (m.provides) provide(m.provides, m.name);
    for (const [op, h] of Object.entries(m.handlers ?? {})) {
      if (op in handlers) throw new Error(`operation '${op}' handled twice (module ${m.name})`);
      (handlers as Record<string, unknown>)[op] = h;
    }
    for (const [type, spec] of Object.entries(m.jobs ?? {})) {
      if (jobTypes.has(type)) throw new Error(`job type '${type}' registered twice (module ${m.name})`);
      jobTypes.set(type, spec);
    }
    periodic.push(...(m.periodic ?? []));
  }
  return { modules, handlers, ports, jobTypes, periodic };
}
