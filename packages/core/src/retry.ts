export interface RetryOptions {
  /**
   * Maximum number of retries AFTER the first attempt.
   * Total attempts = retryCount + 1.
   */
  retryCount: number;

  /**
   * Backoff delays in ms. Length should equal `retryCount`.
   * If the array is shorter, the last value is reused for remaining retries.
   * Per spec §C.1, default is [1000, 3000, 9000, 27000, 60000].
   */
  retryBackoffMs: readonly number[];

  /**
   * Predicate that decides whether an error is retryable. Defaults to `true`.
   * Return false to fail fast (e.g., for auth errors that won't fix themselves).
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;

  /**
   * Invoked just before each retry sleep. Useful for logging.
   * `attempt` is 1-indexed (so on the first retry, attempt = 1).
   */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;

  /**
   * Optional AbortSignal. When aborted, any pending sleep is interrupted
   * and the original error is re-thrown immediately.
   */
  signal?: AbortSignal;
}

export class RetryExhaustedError extends Error {
  readonly attempts: number;

  constructor(message: string, options: { cause: unknown; attempts: number }) {
    super(message, { cause: options.cause });
    this.name = 'RetryExhaustedError';
    this.attempts = options.attempts;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Executes `fn` with retry-and-backoff semantics.
 *
 * @param fn          The operation to run. Will be awaited.
 * @param options     Retry configuration.
 * @returns           The successful result of `fn`.
 * @throws            RetryExhaustedError if all attempts fail. The original
 *                    final error is attached as `cause`.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { retryCount, retryBackoffMs, shouldRetry, onRetry, signal } = options;

  if (retryCount < 0) {
    throw new Error('retryCount must be >= 0');
  }
  if (retryBackoffMs.length === 0 && retryCount > 0) {
    throw new Error('retryBackoffMs must contain at least one entry when retryCount > 0');
  }

  let lastError: unknown;
  const totalAttempts = retryCount + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error('Aborted');
    }
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      const isLastAttempt = attempt === totalAttempts - 1;
      if (isLastAttempt) {
        break;
      }

      if (shouldRetry && !shouldRetry(error, attempt + 1)) {
        break;
      }

      // attempt is 0-indexed; backoff entries map 1:1 onto retries.
      // For attempt N, the next retry index is N, so use backoff[N] (or last).
      const delay = retryBackoffMs[Math.min(attempt, retryBackoffMs.length - 1)] ?? 0;
      onRetry?.(error, attempt + 1, delay);
      await sleep(delay, signal);
    }
  }

  throw new RetryExhaustedError(`Operation failed after ${totalAttempts} attempt(s)`, {
    cause: lastError,
    attempts: totalAttempts,
  });
}
