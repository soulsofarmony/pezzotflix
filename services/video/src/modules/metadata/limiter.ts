// Hand-written rate limiting (ADR 0001, ADR 0007 point 7): a token bucket and a semaphore per host.
// Time comes from a Clock so tests run on a fake one.

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** In [0, 1): jitter of backoffs. */
  random: () => number;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

export interface TokenBucket {
  /** Resolves when a request may start; callers are served in order. */
  take(): Promise<void>;
}

/** ratePerSec tokens per second, at most burst stored. A burst of 1 spaces requests evenly. */
export function tokenBucket(opts: { ratePerSec: number; burst: number; clock: Clock }): TokenBucket {
  const { ratePerSec, burst, clock } = opts;
  let tokens = burst;
  let last = clock.now();
  let queue: Promise<void> = Promise.resolve();
  const refill = () => {
    const t = clock.now();
    tokens = Math.min(burst, tokens + ((t - last) * ratePerSec) / 1000);
    last = t;
  };
  return {
    take() {
      const turn = queue.then(async () => {
        refill();
        if (tokens < 1) {
          await clock.sleep(Math.ceil(((1 - tokens) * 1000) / ratePerSec));
          refill();
        }
        tokens -= 1;
      });
      queue = turn.catch(() => undefined);
      return turn;
    },
  };
}

export interface Semaphore {
  acquire(): Promise<() => void>;
}

export function semaphore(limit: number): Semaphore {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) {
      active++;
      next();
    }
  };
  const once = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };
  return {
    acquire() {
      if (active < limit) {
        active++;
        return Promise.resolve(once());
      }
      return new Promise((resolve) => waiting.push(() => resolve(once())));
    },
  };
}
