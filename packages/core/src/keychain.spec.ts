import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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

describe.skipIf(onMacOS)('keychain: non-macOS platform guard', () => {
  it('setPassword throws KeychainPlatformError off-macOS', async () => {
    await expect(setPassword('svc', 'account', 'pw')).rejects.toBeInstanceOf(KeychainPlatformError);
  });

  it('getPassword throws KeychainPlatformError off-macOS', async () => {
    await expect(getPassword('svc', 'account')).rejects.toBeInstanceOf(KeychainPlatformError);
  });

  it('deletePassword throws KeychainPlatformError off-macOS', async () => {
    await expect(deletePassword('svc', 'account')).rejects.toBeInstanceOf(KeychainPlatformError);
  });
});

describe.skipIf(!runIntegration)('keychain: integration (macOS, non-CI)', () => {
  beforeAll(() => {
    // Sanity check so a misconfigured env does not silently pollute.
    if (!PREFIX.includes('test')) {
      throw new Error(`Refusing to run integration tests with non-test prefix: ${PREFIX}`);
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
