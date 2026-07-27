import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KeychainError,
  KeychainNotFoundError,
  KeychainPlatformError,
  deletePassword,
  getPassword,
  hasPassword,
  setPassword,
} from './keychain.js';

const onMacOS = process.platform === 'darwin';
const onWindows = process.platform === 'win32';
const onUnsupported = !onMacOS && !onWindows;
const inCI = process.env.CI === 'true';

/**
 * Integration tests are skipped on CI to avoid hitting the macOS Keychain
 * (which may prompt for user approval and is not unlocked headlessly).
 * They run on local macOS only.
 */
const runIntegration = onMacOS && !inCI;

// Unique service prefix per test process to avoid collisions when developers
// run tests in parallel or interrupt cleanup.
const PREFIX = process.env.AIFTP_TEST_KEYCHAIN_PREFIX ?? `aiftp-test-${process.pid}-${Date.now()}`;

const testService = (suffix: string): string => `${PREFIX}:${suffix}`;
const created = new Set<{ service: string; account: string }>();

function isHeadlessKeychainUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Unable to obtain authorization for this operation') ||
    message.includes('SecKeychainSearchCreateFromAttributes')
  );
}

async function track(service: string, account: string, password: string): Promise<void> {
  await setPassword(service, account, password);
  created.add({ service, account });
}

afterEach(async () => {
  // Defensive cleanup: remove any entries created during the test run.
  const entries = [...created];
  created.clear();
  for (const { service, account } of entries) {
    try {
      await deletePassword(service, account);
    } catch {
      // Already deleted by the test itself — ignore.
    }
  }
});

describe('keychain: argument validation (cross-platform)', () => {
  it('rejects empty service in setPassword', async () => {
    await expect(setPassword('', 'account', 'pw')).rejects.toBeInstanceOf(KeychainError);
  });

  it('rejects empty account in setPassword', async () => {
    await expect(setPassword('svc', '', 'pw')).rejects.toBeInstanceOf(KeychainError);
  });

  it('rejects non-string password in setPassword', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: intentional invalid input
      setPassword('svc', 'account', undefined as any),
    ).rejects.toBeInstanceOf(KeychainError);
  });

  it('rejects empty service in getPassword', async () => {
    await expect(getPassword('', 'account')).rejects.toBeInstanceOf(KeychainError);
  });

  it('rejects empty service in deletePassword', async () => {
    await expect(deletePassword('', 'account')).rejects.toBeInstanceOf(KeychainError);
  });
});

describe.skipIf(onUnsupported)('keychain: test-mode guard against real OS keychain access', () => {
  // v0.12.4: two MCP unit tests reached the real OS keychain because they
  // forgot to inject a fake. On Windows that spawns `powershell` and
  // compiles C# at runtime (`Add-Type -TypeDefinition`), which exceeded
  // vitest's 5s default timeout under CI load and surfaced as a
  // Windows-only flake with no error other than "Test timed out in 5000ms".
  //
  // The guard turns that whole bug class into an immediate, explicit
  // failure on every platform. It lives inside `defaultExec()`, so it only
  // fires when a real child process is about to be spawned -- injected
  // fake exec functions are unaffected. Skipped on linux/*BSD because
  // `backend()` throws KeychainPlatformError before `defaultExec()` is
  // ever reached there.
  it('getPassword refuses to spawn the real backend while the guard is armed', async () => {
    await expect(getPassword('svc', 'account')).rejects.toBeInstanceOf(KeychainError);
    await expect(getPassword('svc', 'account')).rejects.toThrow(
      /Refusing a real OS keychain call/u,
    );
  });
});

describe.skipIf(!onUnsupported)('keychain: unsupported platform guard (linux / *bsd)', () => {
  // v0.3 added Windows support, so the guard only fires on platforms we
  // explicitly do not target. Linux desktops with libsecret etc. are a
  // post-1.0 candidate (Phase 2+).
  it('setPassword throws KeychainPlatformError', async () => {
    await expect(setPassword('svc', 'account', 'pw')).rejects.toBeInstanceOf(KeychainPlatformError);
  });

  it('getPassword throws KeychainPlatformError', async () => {
    await expect(getPassword('svc', 'account')).rejects.toBeInstanceOf(KeychainPlatformError);
  });

  it('deletePassword throws KeychainPlatformError', async () => {
    await expect(deletePassword('svc', 'account')).rejects.toBeInstanceOf(KeychainPlatformError);
  });
});

describe.skipIf(!runIntegration)('keychain: integration (macOS, non-CI)', () => {
  let unavailableError: unknown;
  let guardValue: string | undefined;

  // This is the ONE block that is supposed to reach the real macOS
  // Keychain, so it opts out of the v0.12.4 fail-closed guard armed by
  // vitest.config.ts. `afterAll` runs even when a test in the block
  // fails, so the variable is always restored for the rest of the file.
  beforeAll(() => {
    guardValue = process.env.AIFTP_TEST_NO_REAL_KEYCHAIN;
    // biome-ignore lint/performance/noDelete: `= undefined` leaks an enumerable key into process.env and the guard would still see it.
    delete (process.env as Record<string, string | undefined>).AIFTP_TEST_NO_REAL_KEYCHAIN;
  });

  afterAll(() => {
    if (guardValue === undefined) {
      // biome-ignore lint/performance/noDelete: keep process.env free of an enumerable undefined key.
      delete (process.env as Record<string, string | undefined>).AIFTP_TEST_NO_REAL_KEYCHAIN;
    } else {
      process.env.AIFTP_TEST_NO_REAL_KEYCHAIN = guardValue;
    }
  });

  beforeAll(async () => {
    // Sanity check so a misconfigured env does not silently pollute.
    if (!PREFIX.includes('test')) {
      throw new Error(`Refusing to run integration tests with non-test prefix: ${PREFIX}`);
    }
    const service = testService('probe');
    const account = 'probe';
    try {
      await setPassword(service, account, 'probe');
      await deletePassword(service, account);
    } catch (error: unknown) {
      if (isHeadlessKeychainUnavailable(error)) {
        unavailableError = error;
        return;
      }
      throw error;
    }
  });

  beforeEach((context) => {
    if (unavailableError) {
      context.skip();
    }
  });

  it('round-trips a simple password (set → get → delete)', async () => {
    const service = testService('roundtrip-simple');
    const account = 'alice';
    const password = 'p@ssw0rd-Simple';

    await track(service, account, password);
    expect(await getPassword(service, account)).toBe(password);

    await deletePassword(service, account);
    created.clear();
    await expect(getPassword(service, account)).rejects.toBeInstanceOf(KeychainNotFoundError);
  });

  it('overwrites an existing entry (no duplicate error)', async () => {
    const service = testService('overwrite');
    const account = 'bob';

    await track(service, account, 'first');
    await setPassword(service, account, 'second');

    expect(await getPassword(service, account)).toBe('second');
  });

  it('preserves passwords with shell metacharacters', async () => {
    const service = testService('special-chars');
    const account = 'charlie';
    // Each character is a known shell hazard if used through a shell.
    const password = `' " $ \` \\ ; & | > < ( ) { } [ ] # ! ~ * ? %`;

    await track(service, account, password);
    expect(await getPassword(service, account)).toBe(password);
  });

  it('preserves unicode passwords', async () => {
    const service = testService('unicode');
    const account = 'daniela';
    const password = 'パスワード🔐αβγ';

    await track(service, account, password);
    expect(await getPassword(service, account)).toBe(password);
  });

  it('handles long passwords (1024 chars)', async () => {
    const service = testService('long');
    const account = 'eve';
    const password = 'x'.repeat(1024);

    await track(service, account, password);
    expect(await getPassword(service, account)).toBe(password);
  });

  it('handles empty password (zero-length)', async () => {
    const service = testService('empty-pw');
    const account = 'frank';

    await track(service, account, '');
    expect(await getPassword(service, account)).toBe('');
  });

  it('handles password with leading/trailing spaces but no newline strip beyond final LF', async () => {
    const service = testService('whitespace');
    const account = 'gina';
    const password = '  spaced  ';

    await track(service, account, password);
    expect(await getPassword(service, account)).toBe(password);
  });

  it('getPassword throws KeychainNotFoundError for missing entry', async () => {
    const service = testService('missing');
    await expect(getPassword(service, 'nobody')).rejects.toBeInstanceOf(KeychainNotFoundError);
  });

  it('deletePassword throws KeychainNotFoundError for missing entry', async () => {
    const service = testService('missing-delete');
    await expect(deletePassword(service, 'nobody')).rejects.toBeInstanceOf(KeychainNotFoundError);
  });

  it('hasPassword returns true when entry exists', async () => {
    const service = testService('has-true');
    const account = 'hank';

    await track(service, account, 'secret');
    expect(await hasPassword(service, account)).toBe(true);
  });

  it('hasPassword returns false when entry is missing', async () => {
    const service = testService('has-false');
    expect(await hasPassword(service, 'nobody')).toBe(false);
  });

  it('isolates entries by service+account tuple', async () => {
    const serviceA = testService('isolated-a');
    const serviceB = testService('isolated-b');
    const account = 'shared-user';

    await track(serviceA, account, 'value-A');
    await track(serviceB, account, 'value-B');

    expect(await getPassword(serviceA, account)).toBe('value-A');
    expect(await getPassword(serviceB, account)).toBe('value-B');
  });
});
