import { describe, expect, it } from 'vitest';
import { type WatchEvent, createWatchDebouncer } from './watch.js';

/**
 * Test-time clock + timer fake. Lets us advance virtual time and
 * trigger scheduled callbacks deterministically.
 */
function makeFakeTime(start = 0) {
  let nowMs = start;
  type Pending = { fn: () => void; fireAt: number; id: number };
  const queue: Pending[] = [];
  let nextId = 1;
  return {
    now: () => nowMs,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      queue.push({ fn, fireAt: nowMs + ms, id });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimeout: (handle: NodeJS.Timeout | number) => {
      const idx = queue.findIndex((p) => p.id === (handle as unknown as number));
      if (idx >= 0) queue.splice(idx, 1);
    },
    /** Advance virtual time by `ms` and fire any scheduled callbacks whose fireAt has passed. */
    advance: (ms: number) => {
      nowMs += ms;
      while (true) {
        const due = queue.findIndex((p) => p.fireAt <= nowMs);
        if (due < 0) break;
        const [pop] = queue.splice(due, 1);
        pop?.fn();
      }
    },
  };
}

function ev(path: string, at: number, kind: WatchEvent['kind'] = 'change'): WatchEvent {
  return { path, at, kind };
}

describe('createWatchDebouncer', () => {
  it('flushes a single event after debounceMs of quiet', () => {
    const clock = makeFakeTime();
    const flushed: WatchEvent[][] = [];
    const deb = createWatchDebouncer((events) => flushed.push([...events]), {
      debounceMs: 500,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    deb.push(ev('index.html', 0));
    // Not yet flushed — still inside debounce window.
    clock.advance(499);
    expect(flushed).toEqual([]);
    // Cross the threshold.
    clock.advance(1);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.[0]?.path).toBe('index.html');
  });

  it('coalesces a burst of changes to the same file into one notification', () => {
    const clock = makeFakeTime();
    const flushed: WatchEvent[][] = [];
    const deb = createWatchDebouncer((events) => flushed.push([...events]), {
      debounceMs: 500,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    // 5 rapid changes to the same file (an IDE auto-saves on each
    // keystroke etc.). They should collapse to ONE notification.
    for (let i = 0; i < 5; i++) {
      deb.push(ev('index.html', i * 50, 'change'));
      clock.advance(50);
    }
    clock.advance(500);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.length).toBe(1);
  });

  it('groups multiple distinct files changed in one burst into one notification', () => {
    const clock = makeFakeTime();
    const flushed: WatchEvent[][] = [];
    const deb = createWatchDebouncer((events) => flushed.push([...events]), {
      debounceMs: 500,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    deb.push(ev('z.html', 0));
    clock.advance(50);
    deb.push(ev('a.html', 50));
    clock.advance(50);
    deb.push(ev('m.html', 100));
    clock.advance(500);
    expect(flushed).toHaveLength(1);
    // Paths must come back sorted so output order is deterministic.
    expect(flushed[0]?.map((e) => e.path)).toEqual(['a.html', 'm.html', 'z.html']);
  });

  it('forces a flush after maxWaitMs even if events keep arriving', () => {
    // A long bulk operation (`git checkout` on a huge repo) emits
    // events faster than debounceMs. Without maxWaitMs the debouncer
    // would never fire. We expect at least one flush at the cap.
    const clock = makeFakeTime();
    const flushed: WatchEvent[][] = [];
    const deb = createWatchDebouncer((events) => flushed.push([...events]), {
      debounceMs: 500,
      maxWaitMs: 2000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    // Stream events every 100ms for 3 seconds.
    for (let t = 0; t < 3000; t += 100) {
      deb.push(ev(`file-${t}.html`, t));
      clock.advance(100);
    }
    // At least one flush by now (the maxWait should have fired around 2000ms).
    expect(flushed.length).toBeGreaterThanOrEqual(1);
  });

  it('flush() drains pending events synchronously and cancels the pending timer', () => {
    const clock = makeFakeTime();
    const flushed: WatchEvent[][] = [];
    const deb = createWatchDebouncer((events) => flushed.push([...events]), {
      debounceMs: 500,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    deb.push(ev('shutdown.html', 0));
    const drained = deb.flush();
    expect(drained.map((e) => e.path)).toEqual(['shutdown.html']);
    expect(flushed).toHaveLength(1);
    // Advancing the clock past the debounce window must NOT produce a
    // second callback — the timer was cancelled by flush().
    clock.advance(1000);
    expect(flushed).toHaveLength(1);
  });

  it('dispose() cancels any pending timer without firing the callback', () => {
    const clock = makeFakeTime();
    const flushed: WatchEvent[][] = [];
    const deb = createWatchDebouncer((events) => flushed.push([...events]), {
      debounceMs: 500,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    deb.push(ev('pending.html', 0));
    deb.dispose();
    clock.advance(1000);
    expect(flushed).toEqual([]);
  });

  it('the LAST kind wins when the same path receives mixed events', () => {
    // E.g. add+change → 'change'; add+remove → 'remove'. Last write
    // semantics are what the operator sees on disk anyway.
    const clock = makeFakeTime();
    const flushed: WatchEvent[][] = [];
    const deb = createWatchDebouncer((events) => flushed.push([...events]), {
      debounceMs: 500,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    deb.push(ev('temp.tmp', 0, 'add'));
    deb.push(ev('temp.tmp', 10, 'remove'));
    clock.advance(500);
    expect(flushed[0]?.[0]?.kind).toBe('remove');
  });
});
