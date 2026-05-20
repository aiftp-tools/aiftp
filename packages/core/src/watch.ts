/**
 * v0.8.0 Phase 2 #4: file-change debouncer for `aiftp watch`.
 *
 * The watch command monitors `localRoot` for changes and emits
 * notifications. Spec §17.6 #4 mandates:
 *   - dry-run notifications by default (NEVER auto-push)
 *   - debouncing — bulk editors like `git checkout` fire dozens of
 *     events in a few milliseconds; we want one notification per
 *     "burst", not one per file
 *
 * This module ships only the pure pipeline (event → debounce → callback)
 * so tests can drive it deterministically without an actual filesystem
 * watcher. The CLI layer wires `fs.watch` to it.
 */

export type WatchEventKind = 'change' | 'add' | 'remove';

export interface WatchEvent {
  path: string;
  kind: WatchEventKind;
  /**
   * Millisecond timestamp from the watcher. Tests use a deterministic
   * clock; production uses `Date.now()`.
   */
  at: number;
}

export interface WatchDebouncerOptions {
  /**
   * Wait this many ms after the LAST event before firing the flush
   * callback. Default 500ms — short enough to feel responsive,
   * long enough to coalesce most editor save bursts.
   */
  debounceMs?: number;
  /**
   * Hard cap on time-to-flush from the FIRST event of a burst. A long
   * bulk operation (`git checkout master` on a thousand-file repo) can
   * keep emitting changes for 30+ seconds — without this cap the
   * debouncer would never fire. Default 5000ms.
   */
  maxWaitMs?: number;
  /**
   * Production callers pass `Date.now`. Tests pass a deterministic
   * stepping clock so they can assert exact flush behavior.
   */
  now?: () => number;
  /**
   * Production callers pass `setTimeout`/`clearTimeout`. Tests pass a
   * controllable fake to drive the debouncer without real wall-clock
   * waits.
   */
  setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimeout?: (handle: NodeJS.Timeout | number) => void;
}

export interface WatchDebouncer {
  /** Feed a single change event into the debouncer. */
  push(event: WatchEvent): void;
  /** Force-flush any pending events (e.g. on shutdown). Returns the events that were drained. */
  flush(): readonly WatchEvent[];
  /** Release any pending timer. Call on shutdown to avoid leaks. */
  dispose(): void;
}

/**
 * Build a debouncer with a single "on flush" callback. The callback
 * receives the sorted, deduplicated list of paths that changed during
 * the burst (keyed by path; the LAST kind wins so add+remove of the
 * same path collapses to remove).
 */
export function createWatchDebouncer(
  onFlush: (events: readonly WatchEvent[]) => void,
  options: WatchDebouncerOptions = {},
): WatchDebouncer {
  const debounceMs = options.debounceMs ?? 500;
  const maxWaitMs = options.maxWaitMs ?? 5000;
  const now = options.now ?? Date.now;
  const setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

  // Pending events keyed by path so duplicate edits to the same file
  // during a burst collapse into one notification.
  const pending = new Map<string, WatchEvent>();
  let burstStart: number | null = null;
  let timer: ReturnType<typeof setTimeoutFn> | null = null;

  function fire(): void {
    timer = null;
    const events = drain();
    if (events.length === 0) return;
    onFlush(events);
  }

  function drain(): WatchEvent[] {
    if (pending.size === 0) {
      burstStart = null;
      return [];
    }
    const sorted = Array.from(pending.values()).sort((a, b) => a.path.localeCompare(b.path));
    pending.clear();
    burstStart = null;
    return sorted;
  }

  function schedule(): void {
    if (timer !== null) {
      clearTimeoutFn(timer);
    }
    // Choose the shorter of (debounceMs from now) and (maxWait remaining).
    // This way a steady stream of events still flushes by maxWait.
    let wait = debounceMs;
    if (burstStart !== null) {
      const elapsed = now() - burstStart;
      const remaining = Math.max(0, maxWaitMs - elapsed);
      if (remaining < wait) wait = remaining;
    }
    timer = setTimeoutFn(fire, wait);
  }

  return {
    push(event: WatchEvent): void {
      if (burstStart === null) burstStart = event.at;
      pending.set(event.path, event);
      schedule();
    },
    flush(): readonly WatchEvent[] {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      const drained = drain();
      if (drained.length > 0) onFlush(drained);
      return drained;
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      pending.clear();
      burstStart = null;
    },
  };
}
