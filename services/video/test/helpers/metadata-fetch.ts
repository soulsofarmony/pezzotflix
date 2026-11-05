// Test doubles for the metadata adapters: a routed fake fetch and a fake clock. No real TMDB
// response is recorded anywhere (ADR 0007 point 10): TMDB bodies in tests are invented; Wikidata
// bodies may reuse CC0 data.
import sharp from 'sharp';
import type { FetchFn } from '../../src/modules/metadata/http.ts';
import type { Clock } from '../../src/modules/metadata/limiter.ts';

export interface FakeClock extends Clock {
  advance: (ms: number) => void;
  set: (t: number) => void;
  sleeps: number[];
}

export function fakeClock(start = 1_000_000): FakeClock {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    random: () => 0.5,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
    sleeps,
  };
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  bytes?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
  /** Throw instead of answering: 'timeout' or 'network'. */
  error?: 'timeout' | 'network';
}

export interface Route {
  /** Matched against the full URL. */
  match: (url: URL) => boolean;
  reply: (url: URL, headers: Record<string, string>) => FakeReply | Promise<FakeReply>;
}

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

export type FakeFetch = FetchFn & { calls: FetchCall[]; routes: Route[]; offline: boolean };

/** Routes are tried in order; an unmatched URL is a 404. offline = every call fails like a network error. */
export function fakeFetch(routes: Route[] = []): FakeFetch {
  const calls: FetchCall[] = [];
  const f = Object.assign(async (url: string, init: { headers: Record<string, string> }): Promise<Response> => {
    calls.push({ url, headers: init.headers });
    if (f.offline) throw new TypeError('fetch failed');
    const u = new URL(url);
    const route = f.routes.find((r) => r.match(u));
    const reply: FakeReply = route ? await route.reply(u, init.headers) : { status: 404, json: { status_message: 'not found' } };
    if (reply.error === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (reply.error === 'network') throw new TypeError('fetch failed');
    const headers = new Headers(reply.headers ?? {});
    if (reply.bytes) {
      headers.set('content-type', reply.contentType ?? 'image/jpeg');
      return new Response(new Uint8Array(reply.bytes), { status: reply.status ?? 200, headers });
    }
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200, headers });
  }, { calls, routes, offline: false });
  return f;
}

export const host = (h: string, path?: string | RegExp) => (u: URL) =>
  u.host === h && (path === undefined || (typeof path === 'string' ? u.pathname === path : path.test(u.pathname)));

/** A real small image (so sharp can read it), distinct per seed. */
export async function testImage(width: number, height: number, seed = 0, format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer> {
  const img = sharp({ create: { width, height, channels: 3, background: { r: (seed * 37) % 256, g: (seed * 91) % 256, b: (seed * 53) % 256 } } });
  return format === 'png' ? img.png().toBuffer() : img.jpeg().toBuffer();
}
