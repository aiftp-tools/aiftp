/**
 * v0.13 Codex cross-review, H3 (second pass): the destination fingerprint was
 * verified against one `Config` and the connection was then built from a
 * *different* read of `.aiftp.toml`. A process that swapped the file inside
 * that window redirected the upload — and the deletes — to a server the
 * operator never approved, even though the fingerprint check had just passed.
 *
 * These tests inject at the two seams that matter:
 *
 *   - `computeDestinationFingerprint` is wrapped so the test can swap
 *     `.aiftp.toml` on disk at exactly the moment the check completes — the
 *     race window, expressed literally.
 *   - `createDeployClient` / `getPassword` are faked so the real
 *     `createDefaultFtpClient` path runs (no OS keychain, no network) and the
 *     test can read back which host / user / keychain service the connection
 *     was actually built from.
 *
 * `node:fs/promises#readFile` is wrapped to count reads of `.aiftp.toml`, so
 * "the confirm path does not re-read the config" is asserted directly rather
 * than inferred.
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spy = vi.hoisted(() => ({
  /** Option objects handed to core's `createDeployClient`, in order. */
  builtClients: [] as Array<Record<string, unknown>>,
  /** Keychain lookups the deploy path performed, in order. */
  credentialLookups: [] as Array<{ service: string; account: string }>,
  /** Absolute paths of every `.aiftp.toml` read, in order. */
  configReads: [] as string[],
  /** Invoked after each destination fingerprint is computed. */
  afterFingerprint: undefined as undefined | (() => void),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const realReadFile = actual.readFile as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readFile: (path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && path.endsWith('.aiftp.toml')) {
        spy.configReads.push(path);
      }
      return realReadFile(path, ...rest);
    },
  };
});

vi.mock('@aiftp-tools/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aiftp-tools/core')>();
  return {
    ...actual,
    getPassword: async (service: string, account: string) => {
      spy.credentialLookups.push({ service, account });
      return 'fake-secret-for-tests';
    },
    createDeployClient: (options: Record<string, unknown>) => {
      spy.builtClients.push(options);
      return {
        connect: async () => undefined,
        disconnect: async () => undefined,
        isConnected: () => true,
        list: async () => [],
        upload: async (_localPath: string, remotePath: string) => ({
          remotePath,
          bytesUploaded: 0,
        }),
        uploadBuffer: async (_content: Buffer, remotePath: string) => ({
          remotePath,
          bytesUploaded: 0,
        }),
        download: async () => undefined,
        delete: async () => undefined,
        rename: async () => undefined,
        mkdir: async () => undefined,
        exists: async () => true,
        size: async () => 0,
      };
    },
    computeDestinationFingerprint: (
      input: Parameters<typeof actual.computeDestinationFingerprint>[0],
    ) => {
      const result = actual.computeDestinationFingerprint(input);
      spy.afterFingerprint?.();
      return result;
    },
  };
});

import { callAiftpTool, createAiftpMcp } from './index.js';

describe('confirm-path destination binding (H3 TOCTOU)', () => {
  let cwd: string;
  let home: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  const APPROVED_HOST = 'ftp.approved.example';
  const APPROVED_USER = 'approved-user';
  const APPROVED_KEYCHAIN = 'aiftp:approved-production';
  const SWAPPED_HOST = 'ftp.attacker.example';
  const SWAPPED_USER = 'attacker-user';
  const SWAPPED_KEYCHAIN = 'aiftp:attacker-production';

  function configPath(): string {
    return join(cwd, '.aiftp.toml');
  }

  function configSource(options: {
    host: string;
    user: string;
    keychainService: string;
  }): string {
    return [
      'schema = 2',
      '',
      '[profile.production]',
      `host = "${options.host}"`,
      'port = 21',
      'protocol = "ftps"',
      `user = "${options.user}"`,
      'remote_root = "/public_html"',
      'local_root = "."',
      `keychain_service = "${options.keychainService}"`,
      'server_kind = "starserver"',
      '',
      '[safety]',
      'warn_on_prod_profile = false',
      'verify_after_upload = "off"',
      '',
    ].join('\n');
  }

  const approvedConfig = () =>
    configSource({ host: APPROVED_HOST, user: APPROVED_USER, keychainService: APPROVED_KEYCHAIN });
  const swappedConfig = () =>
    configSource({ host: SWAPPED_HOST, user: SWAPPED_USER, keychainService: SWAPPED_KEYCHAIN });

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    cwd = join(tmpdir(), `aiftp-race-test-${randomUUID()}`);
    home = join(tmpdir(), `aiftp-race-home-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    spy.builtClients.length = 0;
    spy.credentialLookups.length = 0;
    spy.configReads.length = 0;
    spy.afterFingerprint = undefined;
    await writeFile(configPath(), approvedConfig(), 'utf8');
    await writeFile(join(cwd, 'index.html'), '<!doctype html><title>a</title>', 'utf8');
  });

  afterEach(async () => {
    spy.afterFingerprint = undefined;
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, 'HOME');
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      Reflect.deleteProperty(process.env, 'USERPROFILE');
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  function parseText(result: { content: Array<{ type: string; text?: string }> }): unknown {
    return JSON.parse(result.content[0]?.text ?? '{}');
  }

  /**
   * Backup store fake for the real (dry_run=false) push. Without it the
   * confirm path builds the default store, which reaches the OS keychain.
   */
  function fakePushBackupStore() {
    return async () => ({
      listSnapshots: async () => [],
      verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
      prune: async () => [],
      restoreFile: async () => Buffer.alloc(0),
      createAutoSnapshot: async () => ({
        id: 'stub-snap',
        type: 'auto' as const,
        createdAt: '2026-07-30T00:00:00.000Z',
        fileCount: 0,
        totalBytes: 0,
        files: [],
      }),
    });
  }

  /**
   * Snapshot store for rollback. `createRollbackUploader` is deliberately NOT
   * injected so `createDefaultFtpClient` runs and the test can observe which
   * destination the rollback connection was built from.
   */
  function fakeRollbackBackupStore() {
    const files = [
      {
        path: 'index.html',
        operation: 'modified' as const,
        storedName: 'index.html.enc',
        sizeOriginal: 12,
        sizeEncrypted: 32,
        sha256Original: 'sha256:index.html',
        sha256Encrypted: 'sha256enc:index.html',
      },
    ];
    return async () => ({
      listSnapshots: async () => [
        {
          id: '2026-07-30T01:00:00.000Z-auto-rollback',
          type: 'auto' as const,
          createdAt: '2026-07-30T01:00:00.000Z',
          fileCount: files.length,
          totalBytes: 12,
          files,
        },
      ],
      verify: async () => ({ ok: true, checkedFiles: files.length, errors: [] }),
      prune: async () => [],
      restoreFile: async (_id: string, path: string) => Buffer.from(`restored:${path}`, 'utf8'),
    });
  }

  /** Swap `.aiftp.toml` on the next fingerprint completion, once. */
  function swapConfigAfterNextFingerprint(): void {
    let swapped = false;
    spy.afterFingerprint = () => {
      if (swapped) return;
      swapped = true;
      writeFileSync(configPath(), swappedConfig(), 'utf8');
    };
  }

  async function preparePush(app: ReturnType<typeof createAiftpMcp>) {
    return parseText(await callAiftpTool(app, 'aiftp_push_prepare', { profile: 'production' })) as {
      ok: boolean;
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
    };
  }

  async function prepareRollback(app: ReturnType<typeof createAiftpMcp>) {
    return parseText(await callAiftpTool(app, 'aiftp_rollback_prepare', { steps: 1 })) as {
      ok: boolean;
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
    };
  }

  it('builds the push connection from the verified config when .aiftp.toml is swapped after the check', async () => {
    const app = createAiftpMcp({
      cwd,
      runtime: { createBackupStore: fakePushBackupStore() },
    });
    const prepared = await preparePush(app);
    expect(prepared.ok).toBe(true);

    swapConfigAfterNextFingerprint();

    const confirmed = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });

    expect(confirmed.content[0]?.text).toContain('"ok":true');
    expect(spy.builtClients).toHaveLength(1);
    expect(spy.builtClients[0]?.host).toBe(APPROVED_HOST);
    expect(spy.builtClients[0]?.user).toBe(APPROVED_USER);
    expect(spy.credentialLookups).toEqual([{ service: APPROVED_KEYCHAIN, account: APPROVED_USER }]);
  });

  it('builds the rollback connection from the verified config when .aiftp.toml is swapped after the check', async () => {
    const app = createAiftpMcp({
      cwd,
      runtime: { createBackupStore: fakeRollbackBackupStore() },
    });
    const prepared = await prepareRollback(app);
    expect(prepared.ok).toBe(true);

    swapConfigAfterNextFingerprint();

    const confirmed = await callAiftpTool(app, 'aiftp_rollback_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });

    expect(confirmed.content[0]?.text).toContain('"ok":true');
    expect(spy.builtClients).toHaveLength(1);
    expect(spy.builtClients[0]?.host).toBe(APPROVED_HOST);
    expect(spy.builtClients[0]?.user).toBe(APPROVED_USER);
    expect(spy.credentialLookups).toEqual([{ service: APPROVED_KEYCHAIN, account: APPROVED_USER }]);
  });

  it('reads .aiftp.toml exactly once on the push confirm path', async () => {
    const app = createAiftpMcp({
      cwd,
      runtime: { createBackupStore: fakePushBackupStore() },
    });
    const prepared = await preparePush(app);
    spy.configReads.length = 0;

    const confirmed = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });

    expect(confirmed.content[0]?.text).toContain('"ok":true');
    expect(spy.configReads).toEqual([configPath()]);
  });

  it('reads .aiftp.toml exactly once on the rollback confirm path', async () => {
    const app = createAiftpMcp({
      cwd,
      runtime: { createBackupStore: fakeRollbackBackupStore() },
    });
    const prepared = await prepareRollback(app);
    spy.configReads.length = 0;

    const confirmed = await callAiftpTool(app, 'aiftp_rollback_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });

    expect(confirmed.content[0]?.text).toContain('"ok":true');
    expect(spy.configReads).toEqual([configPath()]);
  });

  it('applies a push to the approved destination when nothing changes', async () => {
    const app = createAiftpMcp({
      cwd,
      runtime: { createBackupStore: fakePushBackupStore() },
    });
    const prepared = await preparePush(app);

    const confirmed = parseText(
      await callAiftpTool(app, 'aiftp_push_confirm', {
        profile: 'production',
        plan_id: prepared.plan_id,
        diff_hash: prepared.diff_hash,
        confirm_token: prepared.confirm_token,
      }),
    ) as { ok: boolean };

    expect(confirmed).toMatchObject({ ok: true });
    expect(spy.builtClients[0]?.host).toBe(APPROVED_HOST);
  });

  it('applies a rollback to the approved destination when nothing changes', async () => {
    const app = createAiftpMcp({
      cwd,
      runtime: { createBackupStore: fakeRollbackBackupStore() },
    });
    const prepared = await prepareRollback(app);

    const confirmed = parseText(
      await callAiftpTool(app, 'aiftp_rollback_confirm', {
        profile: 'production',
        plan_id: prepared.plan_id,
        diff_hash: prepared.diff_hash,
        confirm_token: prepared.confirm_token,
      }),
    ) as { ok: boolean };

    expect(confirmed).toMatchObject({ ok: true });
    expect(spy.builtClients[0]?.host).toBe(APPROVED_HOST);
  });

  it('still refuses a push whose destination changed before the check, with the v0.12-era message shape', async () => {
    const app = createAiftpMcp({
      cwd,
      runtime: { createBackupStore: fakePushBackupStore() },
    });
    const prepared = await preparePush(app);

    await writeFile(configPath(), swappedConfig(), 'utf8');

    const refused = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });

    expect(refused.isError).toBe(true);
    const parsed = refused.content[0]?.text ?? '';
    expect(JSON.parse(parsed).error.message).toBe(
      'destination-changed: the deployment destination for profile "production" changed between prepare and confirm (changed: host, keychain_service, user). Refusing to write to a destination the operator did not approve. Call aiftp_push_prepare again to inspect the current destination.',
    );
    expect(parsed).not.toContain(SWAPPED_HOST);
    expect(spy.builtClients).toEqual([]);
  });

  it('still refuses a rollback whose destination changed before the check, with the v0.12-era message shape', async () => {
    const app = createAiftpMcp({
      cwd,
      runtime: { createBackupStore: fakeRollbackBackupStore() },
    });
    const prepared = await prepareRollback(app);

    await writeFile(configPath(), swappedConfig(), 'utf8');

    const refused = await callAiftpTool(app, 'aiftp_rollback_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });

    expect(refused.isError).toBe(true);
    const parsed = refused.content[0]?.text ?? '';
    expect(JSON.parse(parsed).error.message).toBe(
      'destination-changed: the deployment destination for profile "production" changed between prepare and confirm (changed: host, keychain_service, user). Refusing to write to a destination the operator did not approve. Call aiftp_rollback_prepare again to inspect the current destination.',
    );
    expect(parsed).not.toContain(SWAPPED_HOST);
    expect(spy.builtClients).toEqual([]);
  });
});
