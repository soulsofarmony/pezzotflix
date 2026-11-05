// Playback through compose() and the real Fastify app, with fakes for catalogRead, profilePlayback,
// streamDelivery and events. Every declared response is checked against the contract.
/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are untyped JSON, checked against the contract */
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { expect } from 'vitest';
import { compose, type Composition } from '../src/app/compose.ts';
import { loadConfig } from '../src/app/config.ts';
import { buildServer } from '../src/app/server.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { playbackModule } from '../src/modules/playback/index.ts';
import type { CapabilityOverride } from '../src/modules/playback/overrides.ts';
import type { PlaybackPlan } from '../src/shared/playback-plan.ts';
import type {
  CatalogReadPort,
  PlayableItem,
  ProfilePlaybackPort,
  ProfilePlaybackPrefs,
  ProgressSample,
  StreamDeliveryPort,
  StreamFailure,
  StreamHandle,
  StreamStartResult,
  StreamStatus,
  StreamStopReason,
  TrackChoice,
} from '../src/shared/ports.ts';
import { contractErrors } from './helpers/contract.ts';

export const P1 = '01936f0e-0000-7000-8000-0000000000a1';
export const P2 = '01936f0e-0000-7000-8000-0000000000a2';
const TOKENS: Record<string, string> = { t1: P1, t2: P2 };

export function failure(o: Partial<StreamFailure> = {}): StreamFailure {
  return {
    at: 0,
    kind: 'process_exit',
    class: 'stream',
    suspect: 'unknown',
    exclusion: null,
    exitCode: 1,
    signal: null,
    stderrClass: 'unknown',
    stderrTail: '',
    positionMs: null,
    segment: null,
    terminal: true,
    ...o,
  };
}

/** A controllable deferred: the call waits at `pass()` until the test releases it. */
export class Gate {
  /** Resolves when the call reached the gate. */
  readonly reached: Promise<void>;
  release!: () => void;
  private readonly released: Promise<void>;
  private markReached!: () => void;
  constructor() {
    this.reached = new Promise((r) => (this.markReached = r));
    this.released = new Promise((r) => (this.release = r));
  }
  async pass(): Promise<void> {
    this.markReached();
    await this.released;
  }
}

/** Scripted delivery: start answers from `next` (then ok), records every call in order. */
export class FakeDelivery implements StreamDeliveryPort {
  calls: ({ op: 'start'; plan: PlaybackPlan; sessionId: string } | { op: 'stop'; streamId: string; reason: StreamStopReason })[] = [];
  next: Exclude<StreamStartResult, { ok: true }>[] = [];
  /** Status record per stream id. */
  statuses = new Map<string, Partial<StreamStatus>>();
  /** The next start / stop calls wait on these, in order. */
  startGates: Gate[] = [];
  stopGates: Gate[] = [];
  /** The next N stop calls throw. */
  stopFailures = 0;
  private n = 0;

  gateStart(): Gate {
    const g = new Gate();
    this.startGates.push(g);
    return g;
  }
  gateStop(): Gate {
    const g = new Gate();
    this.stopGates.push(g);
    return g;
  }

  async start(plan: PlaybackPlan, sessionId: string): Promise<StreamStartResult> {
    this.calls.push({ op: 'start', plan: structuredClone(plan), sessionId });
    const gate = this.startGates.shift();
    if (gate) await gate.pass();
    const scripted = this.next.shift();
    if (scripted) return scripted;
    const n = ++this.n;
    const token = `token${String(n).padStart(12, '0')}`;
    const handle: StreamHandle = {
      streamId: `st${n}`,
      sessionId,
      mode: plan.mode,
      protocol: plan.protocol,
      locators: {
        stream: `/video/media/s/${token}/${plan.protocol === 'progressive' ? 'file' : 'hls/main.m3u8'}`,
        subtitles: plan.subtitles.served.map((s) => ({
          trackId: s.trackId,
          url: `/video/media/s/${token}/subtitles/${s.trackId}.${s.format === 'sup' ? 'sup' : 'vtt'}`,
          availability: 'growing',
        })),
      },
      mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0, flac"',
      bitrate: { peakBps: 90_000_000, averageBps: 60_000_000, audioBps: 4_000_000 },
      mediaTimestampOffsetMs: plan.protocol === 'progressive' ? 0 : 10_000,
      startedAt: n,
    };
    return { ok: true, handle };
  }

  async stop(ref: { streamId: string }, reason: StreamStopReason): Promise<void> {
    this.calls.push({ op: 'stop', streamId: ref.streamId, reason });
    const gate = this.stopGates.shift();
    if (gate) await gate.pass();
    if (this.stopFailures > 0) {
      this.stopFailures -= 1;
      throw new Error('delivery stop failed');
    }
  }

  async status(ref: { streamId: string }): Promise<StreamStatus | null> {
    const s = this.statuses.get(ref.streamId);
    return s ? { streamId: ref.streamId, sessionId: '', state: 'active', failure: null, subtitles: [], lastRequestAt: null, ...s } : null;
  }

  ops(): string[] {
    return this.calls.map((c) => (c.op === 'start' ? `start ${c.plan.mode}` : `stop ${c.streamId} ${c.reason}`));
  }
  starts(): PlaybackPlan[] {
    return this.calls.flatMap((c) => (c.op === 'start' ? [c.plan] : []));
  }
}

export class FakeProfiles implements ProfilePlaybackPort {
  prefs = new Map<string, ProfilePlaybackPrefs>([
    [P1, { audioLanguages: ['ita', 'eng'], subtitleLanguages: ['ita'], subtitleMode: 'off' }],
    [P2, { audioLanguages: ['eng'], subtitleLanguages: [], subtitleMode: 'off' }],
  ]);
  /** Every sample received, in order. */
  samples: ProgressSample[] = [];
  /** Stored progress per profile/item: last write wins by `at`, as in profiles/watch.ts. */
  stored = new Map<string, ProgressSample>();
  resume = new Map<string, number>();
  last = new Map<string, TrackChoice>();
  getPrefs(profileId: string) {
    return this.prefs.get(profileId) ?? null;
  }
  recordProgress(sample: ProgressSample) {
    this.samples.push(sample);
    const key = `${sample.profileId}/${sample.itemId}`;
    const prev = this.stored.get(key);
    if (prev && sample.at < prev.at) return;
    this.stored.set(key, sample);
  }
  resumePositionMs(profileId: string, itemId: string) {
    return this.resume.get(`${profileId}/${itemId}`) ?? null;
  }
  lastTrackChoice(profileId: string, itemId: string) {
    return this.last.get(`${profileId}/${itemId}`) ?? null;
  }
}

export class FakeCatalog implements CatalogReadPort {
  items = new Map<string, PlayableItem>();
  getPlayableItem(itemId: string) {
    return this.items.get(itemId) ?? null;
  }
  listPlayableDescendants() {
    return [];
  }
  itemExists(itemId: string) {
    return this.items.has(itemId);
  }
  describeItems() {
    return new Map();
  }
}

export interface PlaybackHarness {
  app: FastifyInstance;
  comp: Composition;
  db: Db;
  clock: { now: number };
  delivery: FakeDelivery;
  profiles: FakeProfiles;
  catalog: FakeCatalog;
  events: { type: string; payload: Record<string, unknown> }[];
  /** While true, events.publish throws. */
  eventsFail: { on: boolean };
  /** Injects with profile token t1 (or `token`), checks a declared response against the contract. */
  call: (operationId: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, token?: string) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  /** For statuses the contract does not declare for that operation (listed in the report): body checked as a Problem. */
  callProblem: (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, token?: string) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  expire: () => Promise<void>;
  /** Runs the playback module's stop() (service shutdown) without closing the app. */
  shutdown: () => Promise<void>;
  /**
   * Resolves when the next operation joins a session's queue (or a profile's start chain): the
   * request reached its handler and is ordered behind the ones already queued.
   */
  nextQueued: () => Promise<string>;
  close: () => Promise<void>;
}

export async function playbackHarness(o: { env?: Record<string, string>; overrides?: CapabilityOverride[] } = {}): Promise<PlaybackHarness> {
  const db = await openDb({ path: ':memory:' });
  const clock = { now: 1_000_000 };
  const delivery = new FakeDelivery();
  const profiles = new FakeProfiles();
  const catalog = new FakeCatalog();
  const events: PlaybackHarness['events'] = [];
  const eventsFail = { on: false };
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: '/nonexistent', LIBRARY_ROOTS: '[]', ...o.env });
  let ids = 0;
  const waiters: ((key: string) => void)[] = [];
  const onQueued = (key: string) => waiters.splice(0).forEach((w) => w(key));
  const comp = compose({
    config,
    db,
    log: pino({ level: 'silent' }),
    now: () => clock.now,
    factories: [
      () => ({
        name: 'fakes',
        provides: {
          catalogRead: catalog,
          profilePlayback: profiles,
          streamDelivery: delivery,
          events: {
            publish: (type, payload) => {
              if (eventsFail.on) throw new Error('event bus down');
              events.push({ type, payload });
            },
          },
        },
      }),
      playbackModule({ ...(o.overrides ? { overrides: o.overrides } : {}), newId: () => `01936f0e-0000-7000-8000-${String(++ids).padStart(12, '0')}`, onQueued }),
    ],
  });
  const app = await buildServer({ logger: false, handlers: comp.handlers, profileTokens: { verify: (t) => TOKENS[t] ?? null } });
  await app.ready();
  const inject = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload: unknown, token: string) => {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body ? r.json() : undefined, headers: r.headers as Record<string, unknown>, raw: r.body };
  };
  return {
    app,
    comp,
    db,
    clock,
    delivery,
    profiles,
    catalog,
    events,
    eventsFail,
    call: async (operationId, method, url, payload, token = 't1') => {
      const r = await inject(method, url, payload, token);
      // The helper has no body schema for a 204 (NoContent): it must simply have no body.
      if (r.status === 204) expect(r.raw, `${operationId} 204 with a body`).toBe('');
      else expect(contractErrors(operationId, r.status, r.body), `${operationId} ${r.status} ${r.raw.slice(0, 600)}`).toEqual([]);
      return r;
    },
    callProblem: async (method, url, payload, token = 't1') => {
      const r = await inject(method, url, payload, token);
      // startPlayback declares a Problem body for 404: the same schema, used as a Problem validator.
      expect(contractErrors('startPlayback', 404, r.body), r.raw.slice(0, 600)).toEqual([]);
      return r;
    },
    expire: async () => {
      await comp.periodic.find((p) => p.name === 'playback.expire')!.run();
    },
    shutdown: async () => {
      for (const m of comp.modules) await m.stop?.();
    },
    nextQueued: () => new Promise<string>((resolve) => waiters.push(resolve)),
    close: async () => {
      for (const m of comp.modules) await m.stop?.();
      await app.close();
      closeDb(db);
    },
  };
}
