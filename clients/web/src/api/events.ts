// Event polling with a cursor (doc 03 I3, ADR 0004 point 8, ADR 0005 point 2, doc 05 §7.7).
// - The first call has no cursor: it returns the current position and no events.
// - Every 5 s while the page is visible, also during playback. Hidden page: stopped, unless a playback session is
//   active, then every 15 s (the player waits for playback.subtitle_ready). Visible again: poll at once.
// - After an error the interval doubles up to 60 s. 410 CURSOR_EXPIRED: reset everything and restart without cursor.
// - A full page is followed at once by the next one.
import { ApiError } from './problem.ts';
import { type AppEvent, type EventPage, toAppEvent } from './types.ts';

export const VISIBLE_INTERVAL_MS = 5_000;
export const HIDDEN_ACTIVE_INTERVAL_MS = 15_000;
export const MAX_BACKOFF_MS = 60_000;
export const PAGE_LIMIT = 100;

export interface VisibilitySource {
  isHidden(): boolean;
  subscribe(onChange: () => void): () => void;
}

export interface EventPollerDeps {
  list(cursor: string | undefined, limit: number): Promise<EventPage>;
  onEvents(events: AppEvent[]): void;
  /** The cursor expired: everything may be stale. */
  onReset(): void;
  hasActiveSession(): boolean;
  visibility: VisibilitySource;
  log?: (msg: string, data?: unknown) => void;
}

export const documentVisibility = (doc: Document): VisibilitySource => ({
  isHidden: () => doc.visibilityState === 'hidden',
  subscribe(onChange) {
    doc.addEventListener('visibilitychange', onChange);
    return () => doc.removeEventListener('visibilitychange', onChange);
  },
});

export class EventPoller {
  private readonly deps: EventPollerDeps;
  private cursor: string | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private failures = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(deps: EventPollerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.deps.visibility.subscribe(() => this.onVisibility());
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Re-evaluates the interval now, e.g. when a playback session starts or ends. */
  refresh(): void {
    if (!this.running || this.inFlight) return;
    this.schedule(this.nextDelay());
  }

  /** Delay before the next call, or null when polling pauses (hidden page without a session). */
  nextDelay(): number | null {
    if (this.failures > 0) return Math.min(VISIBLE_INTERVAL_MS * 2 ** this.failures, MAX_BACKOFF_MS);
    if (!this.deps.visibility.isHidden()) return VISIBLE_INTERVAL_MS;
    return this.deps.hasActiveSession() ? HIDDEN_ACTIVE_INTERVAL_MS : null;
  }

  private onVisibility(): void {
    if (!this.running || this.inFlight) return;
    // Back to visible: poll at once; hidden: switch to the slower interval or pause.
    this.schedule(this.deps.visibility.isHidden() ? this.nextDelay() : this.failures > 0 ? this.nextDelay() : 0);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number | null): void {
    this.clearTimer();
    if (!this.running || delay === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    let again = false;
    try {
      const page = await this.deps.list(this.cursor, PAGE_LIMIT);
      this.failures = 0;
      const first = this.cursor === undefined;
      this.cursor = page.nextCursor;
      if (!first && page.events.length) this.deps.onEvents(page.events.map(toAppEvent));
      again = page.events.length >= PAGE_LIMIT;
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) {
        this.cursor = undefined;
        this.failures = 0;
        this.deps.onReset();
        again = true;
      } else {
        this.failures += 1;
        this.deps.log?.('event poll failed', e);
      }
    } finally {
      this.inFlight = false;
    }
    if (this.running) this.schedule(again ? 0 : this.nextDelay());
  }
}
