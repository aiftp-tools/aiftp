import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryExhaustedError, withRetry } from './retry.js';

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { retryCount: 5, retryBackoffMs: [100] });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries until success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { retryCount: 5, retryBackoffMs: [10, 10, 10, 10, 10] });
    const settled = promise.then(
      (v) => ({ ok: true, value: v }) as const,
      (e: unknown) => ({ ok: false, error: e }) as const,
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('ok');
    }
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws RetryExhaustedError after exhausting retries', async () => {
    vi.useRealTimers();
    const finalError = new Error('boom-final');
    const fn = vi.fn(async () => {
      throw finalError;
    });

    let caught: unknown;
    try {
      await withRetry(fn, { retryCount: 2, retryBackoffMs: [1, 1] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RetryExhaustedError);
    expect((caught as RetryExhaustedError).attempts).toBe(3);
    expect((caught as RetryExhaustedError).cause).toBe(finalError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects shouldRetry returning false (fail fast)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('non-retryable'));

    const promise = withRetry(fn, {
      retryCount: 5,
      retryBackoffMs: [10],
      shouldRetry: () => false,
    });
    const settled = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    const result = await settled;

    expect(result).toBeInstanceOf(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('invokes onRetry callback with attempt number and delay', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, {
      retryCount: 5,
      retryBackoffMs: [100, 200],
      onRetry,
    });
    const settled = promise.then(
      (v) => v,
      () => null,
    );
    await vi.runAllTimersAsync();
    await settled;

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[1]).toBe(1);
    expect(onRetry.mock.calls[0]?.[2]).toBe(100);
    expect(onRetry.mock.calls[1]?.[1]).toBe(2);
    expect(onRetry.mock.calls[1]?.[2]).toBe(200);
  });

  it('uses last backoff value when attempts exceed array length', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error('persistent'));

    const promise = withRetry(fn, {
      retryCount: 4,
      retryBackoffMs: [10, 20],
      onRetry,
    });
    const settled = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    const result = await settled;

    expect(result).toBeInstanceOf(RetryExhaustedError);
    // 4 retries, delays should be: 10, 20, 20, 20
    expect(onRetry.mock.calls[0]?.[2]).toBe(10);
    expect(onRetry.mock.calls[1]?.[2]).toBe(20);
    expect(onRetry.mock.calls[2]?.[2]).toBe(20);
    expect(onRetry.mock.calls[3]?.[2]).toBe(20);
  });

  it('allows retryCount=0 (no retries)', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withRetry(fn, { retryCount: 0, retryBackoffMs: [] })).rejects.toBeInstanceOf(
      RetryExhaustedError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects when retryCount is negative', async () => {
    vi.useRealTimers();
    await expect(
      withRetry(async () => 'ok', { retryCount: -1, retryBackoffMs: [] }),
    ).rejects.toThrow(/retryCount must be >= 0/);
  });

  it('rejects when backoff array is empty but retries are requested', async () => {
    vi.useRealTimers();
    await expect(
      withRetry(async () => 'ok', { retryCount: 3, retryBackoffMs: [] }),
    ).rejects.toThrow(/retryBackoffMs must contain at least one entry/);
  });

  it('supports AbortSignal to interrupt waiting', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const controller = new AbortController();

    const promise = withRetry(fn, {
      retryCount: 5,
      retryBackoffMs: [10000, 10000],
      signal: controller.signal,
    });
    const settled = promise.catch((e) => e);

    // Let the first attempt fail synchronously, then abort during the sleep
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Aborted/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses default spec backoff [1000, 3000, 9000, 27000, 60000]', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error('persistent'));

    const promise = withRetry(fn, {
      retryCount: 5,
      retryBackoffMs: [1000, 3000, 9000, 27000, 60000],
      onRetry,
    });
    const settled = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    const result = await settled;

    expect(result).toBeInstanceOf(RetryExhaustedError);
    expect(onRetry.mock.calls.map((c) => c[2])).toEqual([1000, 3000, 9000, 27000, 60000]);
  });
});

describe('RetryExhaustedError', () => {
  it('exposes cause and attempts', () => {
    const cause = new Error('root');
    const err = new RetryExhaustedError('outer', { cause, attempts: 3 });
    expect(err.name).toBe('RetryExhaustedError');
    expect(err.cause).toBe(cause);
    expect(err.attempts).toBe(3);
  });
});
