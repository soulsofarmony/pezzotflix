// Typed helpers for operation handlers generated from the contract (ADR 0004).
// Handlers are keyed by operationId; the contract validates input before the handler runs.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { operations } from '../contract/schema.d.ts';

export type OperationId = keyof operations;

type Op<K extends OperationId> = operations[K];

export type Params<K extends OperationId> = Op<K>['parameters'] extends { path?: infer P } ? NonNullable<P> : never;
export type Query<K extends OperationId> = Op<K>['parameters'] extends { query?: infer Q } ? NonNullable<Q> : never;
export type Body<K extends OperationId> = Op<K> extends { requestBody?: { content: { 'application/json': infer B } } }
  ? B
  : never;
type ResponsesOf<K extends OperationId> = Op<K>['responses'];
type JsonOf<R> = R extends { content: { 'application/json': infer B } } ? B : never;
/** JSON body of the success response (200 or 201). */
export type Ok<K extends OperationId> = JsonOf<ResponsesOf<K>[keyof ResponsesOf<K> & (200 | 201)]>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the profileToken security handler. */
    profileId?: string;
  }
}

export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
export type Handlers = Partial<Record<OperationId, Handler>>;

/** Typed request view for a handler: `const { body, params, query } = typed<'startPlayback'>(req)`. */
export function typed<K extends OperationId>(req: FastifyRequest): {
  params: Params<K>;
  query: Query<K>;
  body: Body<K>;
  profileId: string;
} {
  return {
    params: req.params as Params<K>,
    query: req.query as Query<K>,
    body: req.body as Body<K>,
    profileId: req.profileId ?? '',
  };
}

/** Profile id from the security handler; throws if the route had no profile context. */
export function requireProfile(req: FastifyRequest): string {
  if (!req.profileId) throw new Error('route without profile context');
  return req.profileId;
}
