// Module 'playback' (doc 02 §3.9–§3.10): the pure Decision Engine (decision/) and the Session Manager,
// with the control-plane handlers of paths/playback.yaml and explainPlaybackDecision (admin).
import type { FastifyReply } from 'fastify';
import { type Ok, requireProfile, typed } from '../../app/http.ts';
import type { ModuleFactory } from '../../app/module.ts';
import { type CapabilityOverride, DEFAULT_OVERRIDES } from './overrides.ts';
import { createSessionManager, RetryLater } from './sessions.ts';

export interface PlaybackModuleOptions {
  overrides?: readonly CapabilityOverride[];
  newId?: () => string;
  /** Test hook: an operation joined a session's queue or a profile's start chain. */
  onQueued?: (key: string) => void;
}

/** Retry-After survives the error handler: it only drops content-type and content-length (tested). */
async function withRetryAfter<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RetryLater) void reply.header('Retry-After', String(err.retryAfterS));
    throw err;
  }
}

export const playbackModule =
  (opts: PlaybackModuleOptions = {}): ModuleFactory =>
  ({ config, ports, now, log }) => {
    const sessionTimeoutMs = config.SESSION_TIMEOUT_S * 1000;
    const mgr = createSessionManager(
      {
        maxSessions: config.MAX_SESSIONS,
        maxTranscodes: config.MAX_TRANSCODES,
        sessionTimeoutMs,
        preparingMaxMs: config.PLAYBACK_PREPARING_MAX_S * 1000,
        overrides: opts.overrides ?? DEFAULT_OVERRIDES,
      },
      { ports, now, log, ...(opts.newId ? { newId: opts.newId } : {}), ...(opts.onQueued ? { onQueued: opts.onQueued } : {}) },
    );
    return {
      name: 'playback',
      handlers: {
        listActiveSessions: async (): Promise<Ok<'listActiveSessions'>> => ({ sessions: mgr.list() }),
        startPlayback: async (req, reply): Promise<Ok<'startPlayback'>> => {
          const { body } = typed<'startPlayback'>(req);
          const session = await withRetryAfter(reply, () => mgr.startPlayback(requireProfile(req), body));
          void reply.code(201);
          return session;
        },
        terminateSession: async (req, reply) => {
          await mgr.terminateSession(typed<'terminateSession'>(req).params.sessionId);
          return reply.code(204).send();
        },
        reportProgress: async (req, reply) => {
          const { params, body } = typed<'reportProgress'>(req);
          mgr.reportProgress(requireProfile(req), params.sessionId, body);
          return reply.code(204).send();
        },
        stopPlayback: async (req, reply) => {
          const { params, body } = typed<'stopPlayback'>(req);
          await mgr.stopPlayback(requireProfile(req), params.sessionId, body);
          return reply.code(204).send();
        },
        changeTracks: async (req, reply): Promise<Ok<'changeTracks'>> => {
          const { params, body } = typed<'changeTracks'>(req);
          return withRetryAfter(reply, () => mgr.changeTracks(requireProfile(req), params.sessionId, body));
        },
        changeVersion: async (req, reply): Promise<Ok<'changeVersion'>> => {
          const { params, body } = typed<'changeVersion'>(req);
          return withRetryAfter(reply, () => mgr.changeVersion(requireProfile(req), params.sessionId, body));
        },
        reportPlaybackFailure: async (req, reply): Promise<Ok<'reportPlaybackFailure'>> => {
          const { params, body } = typed<'reportPlaybackFailure'>(req);
          return withRetryAfter(reply, () => mgr.reportPlaybackFailure(requireProfile(req), params.sessionId, body));
        },
        explainPlaybackDecision: async (req): Promise<Ok<'explainPlaybackDecision'>> => mgr.explain(typed<'explainPlaybackDecision'>(req).body),
      },
      periodic: [{ name: 'playback.expire', everyMs: Math.max(1_000, Math.min(5_000, Math.floor(sessionTimeoutMs / 4))), run: () => mgr.expire() }],
      stop: () => mgr.shutdown(),
    };
  };

export const createPlaybackModule: ModuleFactory = playbackModule();
