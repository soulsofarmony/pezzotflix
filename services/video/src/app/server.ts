// HTTP server: Fastify + contract (fastify-openapi-glue), Problem Details errors, token masking.
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import pino from 'pino';
import openapiGlue from 'fastify-openapi-glue';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProfileTokenVerifier } from '../shared/ports.ts';
import type { Handlers, OperationId } from './http.ts';
import { notImplemented, ProblemError } from './problem.ts';

export const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contract', 'dist', 'openapi.json');

/** Masks session tokens in data-plane URLs (P9) so they never reach the logs. */
export const maskUrl = (url: string): string => url.replace(/\/s\/[^/?#]+/, '/s/***');

/** Root logger (pino): token-masking request serializer. Shared by Fastify and the modules. */
export function createLogger(level = 'info'): FastifyBaseLogger {
  return pino({
    level,
    serializers: {
      req: (req: { method: string; url: string; id: string }) => ({ method: req.method, url: maskUrl(req.url), id: req.id }),
    },
  });
}

export interface ServerOptions {
  handlers: Handlers;
  profileTokens: ProfileTokenVerifier;
  /** Tests pass false. */
  logger: FastifyBaseLogger | false;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ...(opts.logger === false ? { logger: false } : { loggerInstance: opts.logger }),
    // Behind the Caddy gateway (ADR 0006).
    trustProxy: true,
    ajv: { customOptions: { strict: false, removeAdditional: false, coerceTypes: 'array', useDefaults: true } },
  });

  app.setErrorHandler((err: FastifyError | ProblemError, req, reply) => {
    let problem: ProblemError;
    if (err instanceof ProblemError) {
      problem = err;
    } else if (err.validation) {
      const fe = err;
      problem = new ProblemError('VALIDATION_FAILED', fe.message, {
        errors: (fe.validation ?? []).map((v) => ({
          path: `${fe.validationContext ?? ''}${v.instancePath}`,
          message: v.message ?? 'invalid',
        })),
      });
    } else if ((err as { name?: string }).name === 'Unauthorized') {
      problem = new ProblemError('UNAUTHORIZED');
    } else if (err.statusCode && err.statusCode < 500) {
      const status = err.statusCode;
      problem = new ProblemError(status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED', err.message, {}, status);
    } else {
      req.log.error({ err }, 'unhandled error');
      problem = new ProblemError('INTERNAL', 'Unexpected server error');
    }
    if (problem.status >= 500 && problem.status !== 501) req.log.warn({ code: problem.code }, problem.message);
    void reply
      .status(problem.status)
      .type('application/problem+json')
      .serializer(JSON.stringify)
      .send(problem.toProblem(maskUrl(req.url)));
  });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .status(404)
      .type('application/problem+json')
      .send(new ProblemError('NOT_FOUND', 'No such route').toProblem(maskUrl(req.url)));
  });

  const specification = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as object;
  await app.register(openapiGlue, {
    specification,
    operationResolver: (operationId: string) => {
      const h = opts.handlers[operationId as OperationId];
      if (h) return h;
      return async () => {
        throw notImplemented(operationId);
      };
    },
    securityHandlers: {
      profileToken: async (req: FastifyRequest) => {
        const header = req.headers.authorization ?? '';
        const m = /^Bearer\s+(\S+)$/i.exec(header);
        const profileId = m?.[1] ? opts.profileTokens.verify(m[1]) : null;
        if (!profileId) throw new ProblemError('UNAUTHORIZED');
        req.profileId = profileId;
      },
    },
  });

  return app;
}
