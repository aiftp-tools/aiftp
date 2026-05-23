import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PushResult, VERSION } from '@aiftp-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AiftpBackupStore,
  type AiftpMcpRuntime,
  callAiftpTool,
  createAiftpMcp,
  readAiftpResource,
} from './index.js';

function createPushResult(overrides?: Partial<PushResult>): PushResult {
  return {
    planned: [],
    plannedDeletes: [],
    uploaded: [],
    deleted: [],
    backupSnapshot: null,
    ...overrides,
  };
}

type TestSnapshotFile = Awaited<
  ReturnType<AiftpBackupStore['listSnapshots']>
>[number]['files'][number];

describe('mcp', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = join(tmpdir(), `aiftp-mcp-test-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function writeConfig(
    options: { deletionPolicy?: string; warnOnProdProfile?: boolean } = {},
  ): Promise<void> {
    await writeFile(
      join(cwd, '.aiftp.toml'),
      [
        'schema = 1',
        '',
        '[profile.production]',
        'host = "ftp.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "deploy-user"',
        'remote_root = "/public_html"',
        'local_root = "."',
        'keychain_service = "aiftp:production"',
        'server_kind = "starserver"',
        '',
        ...(options.deletionPolicy || options.warnOnProdProfile === false
          ? [
              '[safety]',
              ...(options.warnOnProdProfile === false ? ['warn_on_prod_profile = false'] : []),
              ...(options.deletionPolicy ? [`deletion_policy = "${options.deletionPolicy}"`] : []),
              '',
            ]
          : []),
      ].join('\n'),
      'utf8',
    );
  }

  function parseText(result: { content: Array<{ type: string; text?: string }> }): unknown {
    return JSON.parse(result.content[0]?.text ?? '{}');
  }

  function addedSnapshotFile(path: string): TestSnapshotFile {
    return {
      path,
      operation: 'added',
      storedName: null,
      sizeOriginal: null,
      sizeEncrypted: null,
      sha256Original: null,
      sha256Encrypted: null,
    };
  }

  function modifiedSnapshotFile(path: string): TestSnapshotFile {
    return {
      path,
      operation: 'modified',
      storedName: `${path}.enc`,
      sizeOriginal: 12,
      sizeEncrypted: 32,
      sha256Original: `sha256:${path}`,
      sha256Encrypted: `sha256enc:${path}`,
    };
  }

  function rollbackRuntimeFor(files: TestSnapshotFile[]): {
    runtime: AiftpMcpRuntime;
    uploads: string[];
    deletes: string[];
  } {
    const uploads: string[] = [];
    const deletes: string[] = [];
    return {
      uploads,
      deletes,
      runtime: {
        createBackupStore: async () => ({
          listSnapshots: async () => [
            {
              id: '2026-05-19T01:00:00.000Z-auto-rollback',
              type: 'auto',
              createdAt: '2026-05-19T01:00:00.000Z',
              fileCount: files.length,
              totalBytes: files.reduce((sum, file) => sum + (file.sizeOriginal ?? 0), 0),
              files,
            },
          ],
          verify: async () => ({ ok: true, checkedFiles: files.length, errors: [] }),
          prune: async () => [],
          restoreFile: async (_id, path) => {
            const file = files.find((candidate) => candidate.path === path);
            if (!file || file.operation === 'added') {
              throw new Error(`no restorable content for ${path}`);
            }
            return Buffer.from(`restored:${path}`, 'utf8');
          },
        }),
        createRollbackUploader: async () => ({
          upload: async (_localPath, remotePath) => {
            uploads.push(remotePath);
          },
          delete: async (remotePath) => {
            deletes.push(remotePath);
          },
        }),
      },
    };
  }

  it('re-exports VERSION from core (semver shape)', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u);
  });

  it('creates an MCP server facade', () => {
    const app = createAiftpMcp({ cwd });

    expect(app.server.isConnected()).toBe(false);
    expect(app.tools).toContain('aiftp_status');
    expect(app.resources).toContain('aiftp://config');
  });

  it('aiftp_status returns a structured JSON status payload', async () => {
    await writeConfig();
    await writeFile(join(cwd, 'index.html'), '<h1>new</h1>\n', 'utf8');

    const result = await callAiftpTool(createAiftpMcp({ cwd }), 'aiftp_status', {
      profile: 'production',
    });

    expect(parseText(result)).toMatchObject({
      ok: true,
      profile: 'production',
      status: {
        counts: {
          added: 1,
        },
        diff: {
          added: ['index.html'],
        },
      },
    });
  });

  it('aiftp_push supports dry-run and persists state only for real pushes', async () => {
    await writeConfig();
    const pushResult = createPushResult({
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      nextState: { schema: 1, files: {} },
    });
    const runtime: AiftpMcpRuntime = {
      runPush: async () => pushResult,
    };

    const result = await callAiftpTool(createAiftpMcp({ cwd, runtime }), 'aiftp_push', {
      profile: 'production',
      files: ['index.html'],
      dry_run: true,
    });

    expect(parseText(result)).toMatchObject({
      ok: true,
      profile: 'production',
      result: {
        dryRun: true,
        planned: ['index.html'],
      },
    });
    await expect(
      readFile(join(cwd, '.aiftp', 'state', 'production', 'state.json')),
    ).rejects.toThrow();
  });

  it('aiftp_push dry-run includes plannedDeletes when deletion_policy is prune-auto', async () => {
    await writeConfig({ deletionPolicy: 'prune-auto' });
    const stateDir = join(cwd, '.aiftp', 'state', 'production');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'state.json'),
      JSON.stringify({
        schema: 1,
        files: {
          'old.html': {
            hash: 'old-hash',
            size: 24,
            updatedAt: '2026-05-22T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );

    const result = await callAiftpTool(createAiftpMcp({ cwd }), 'aiftp_push', {
      profile: 'production',
      dry_run: true,
    });

    expect(parseText(result)).toMatchObject({
      ok: true,
      result: {
        plannedDeletes: ['old.html'],
      },
    });
  });

  it('aiftp_push (no dry_run flag) refuses to perform a real upload — use prepare/confirm', async () => {
    await writeConfig();
    const runtime: AiftpMcpRuntime = {
      runPush: async () => {
        throw new Error('runPush should not be called for refused real-push request');
      },
    };

    const result = await callAiftpTool(createAiftpMcp({ cwd, runtime }), 'aiftp_push', {
      profile: 'production',
      dry_run: false,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/prepare\/confirm|two-step|aiftp_push_prepare/i);
  });

  it('aiftp_push_prepare returns plan_id, diff_hash, confirm_token, and expected counts', async () => {
    await writeConfig();
    const pushResult = createPushResult({
      dryRun: true,
      diff: { added: ['index.html', 'about.html'], modified: [], removed: [], unchanged: [] },
      planned: ['about.html', 'index.html'],
      nextState: { schema: 1, files: {} },
    });
    const runtime: AiftpMcpRuntime = {
      runPush: async () => pushResult,
    };

    const result = await callAiftpTool(createAiftpMcp({ cwd, runtime }), 'aiftp_push_prepare', {
      profile: 'production',
    });
    const parsed = parseText(result);
    expect(parsed.plan_id).toMatch(/^[0-9a-f-]{20,}$/u);
    expect(parsed.diff_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(parsed.confirm_token).toMatch(/.{16,}/u);
    expect(parsed.expected_file_count).toBe(2);
    expect(parsed.expected_remote_root).toBe('/public_html');
    expect(parsed.profile).toBe('production');
  });

  it('aiftp_push_prepare evicts the oldest outstanding plan when the store reaches its cap', async () => {
    await writeConfig({ warnOnProdProfile: false });
    const dryRunResult = createPushResult({
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      nextState: { schema: 1, files: {} },
    });
    const realResult = createPushResult({
      ...dryRunResult,
      dryRun: false,
      uploaded: [
        {
          path: 'index.html',
          localPath: 'idx',
          remotePath: '/public_html/index.html',
          size: 42,
          hash: 'h',
        },
      ],
    });
    const app = createAiftpMcp({
      cwd,
      runtime: {
        runPush: async (opts) => (opts.dryRun ? dryRunResult : realResult),
        createBackupStore: async () => ({
          listSnapshots: async () => [],
          verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
          prune: async () => [],
          restoreFile: async () => Buffer.alloc(0),
          createAutoSnapshot: async () => ({
            id: 'stub-snap',
            type: 'auto',
            createdAt: '2026-05-19T00:00:00.000Z',
            fileCount: 0,
            totalBytes: 0,
            files: [],
          }),
        }),
      },
    });
    const prepared: Array<{
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
    }> = [];

    for (let index = 0; index < 51; index += 1) {
      prepared.push(
        parseText(await callAiftpTool(app, 'aiftp_push_prepare', { profile: 'production' })) as {
          plan_id: string;
          diff_hash: string;
          confirm_token: string;
        },
      );
    }

    const evicted = prepared[0];
    const evictedConfirm = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: evicted.plan_id,
      diff_hash: evicted.diff_hash,
      confirm_token: evicted.confirm_token,
    });
    expect(evictedConfirm.isError).toBe(true);
    expect(JSON.stringify(evictedConfirm.content)).toMatch(/plan_id|expired|consumed|unknown/i);

    const retained = prepared.at(-1);
    expect(retained).toBeDefined();
    const retainedConfirm = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: retained?.plan_id,
      diff_hash: retained?.diff_hash,
      confirm_token: retained?.confirm_token,
    });
    if (retainedConfirm.isError) {
      throw new Error(
        `retained plan failed unexpectedly: ${JSON.stringify(retainedConfirm.content)}`,
      );
    }
    expect(parseText(retainedConfirm)).toMatchObject({
      ok: true,
      result: {
        dryRun: false,
      },
    });
  });

  it('aiftp_push_prepare includes upload and delete preview', async () => {
    await writeConfig({ deletionPolicy: 'prune-auto' });
    const pushResult = createPushResult({
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: ['old.html'], unchanged: [] },
      planned: ['index.html'],
      plannedDeletes: ['old.html'],
      nextState: { schema: 1, files: {} },
    });
    const runtime: AiftpMcpRuntime = {
      runPush: async (opts) => {
        expect(opts.safety?.deletionPolicy).toBe('prune-auto');
        return pushResult;
      },
    };

    const parsed = parseText(
      await callAiftpTool(createAiftpMcp({ cwd, runtime }), 'aiftp_push_prepare', {
        profile: 'production',
      }),
    ) as { planned: string[]; plannedDeletes: string[]; expected_file_count: number };

    expect(parsed.planned).toEqual(['index.html']);
    expect(parsed.plannedDeletes).toEqual(['old.html']);
    expect(parsed.expected_file_count).toBe(1);
  });

  it('aiftp_push_confirm requires matching plan_id, diff_hash, and confirm_token', async () => {
    await writeConfig();
    const dryRunResult = createPushResult({
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      nextState: { schema: 1, files: {} },
    });
    const realResult = createPushResult({
      ...dryRunResult,
      dryRun: false,
      uploaded: [
        {
          path: 'index.html',
          localPath: 'idx',
          remotePath: '/public_html/index.html',
          size: 42,
          hash: 'h',
        },
      ],
      nextState: { schema: 1, files: {} },
    });
    const runtime: AiftpMcpRuntime = {
      runPush: async (opts) => (opts.dryRun ? dryRunResult : realResult),
      createBackupStore: async () => ({
        listSnapshots: async () => [],
        verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
        prune: async () => [],
        restoreFile: async () => Buffer.alloc(0),
        createAutoSnapshot: async () => ({
          id: 'stub-snap',
          type: 'auto',
          createdAt: '2026-05-19T00:00:00.000Z',
          fileCount: 0,
          totalBytes: 0,
          files: [],
        }),
      }),
    };
    const app = createAiftpMcp({ cwd, runtime });

    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_push_prepare', { profile: 'production' }),
    ) as {
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
    };

    // Wrong token: rejected.
    const wrongToken = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: 'wrong-token',
    });
    expect(wrongToken.isError).toBe(true);
    expect(JSON.stringify(wrongToken.content)).toMatch(/confirm_token|token mismatch/i);

    // Wrong diff_hash: rejected (something changed between prepare/confirm).
    const wrongHash = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: 'a'.repeat(64),
      confirm_token: prepared.confirm_token,
    });
    expect(wrongHash.isError).toBe(true);
    expect(JSON.stringify(wrongHash.content)).toMatch(/diff_hash|drift/i);

    // Correct values: real push runs. `acknowledge_production: true`
    // because the test config uses `production` which matches the
    // default prod_profile_patterns (v0.6.0 #7).
    const confirmRaw = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
      acknowledge_production: true,
    });
    if (confirmRaw.isError) {
      throw new Error(`confirm failed unexpectedly: ${JSON.stringify(confirmRaw.content)}`);
    }
    const confirmed = parseText(confirmRaw) as {
      ok: boolean;
      result: { dryRun: boolean; uploaded: unknown[] };
    };
    expect(confirmed.result.dryRun).toBe(false);
    expect(confirmed.result.uploaded).toHaveLength(1);
  });

  it('aiftp_push_confirm rejects upload/delete drift before mutation', async () => {
    await writeConfig({ deletionPolicy: 'prune-auto', warnOnProdProfile: false });
    let dryRunCount = 0;
    const calls: Array<{ dryRun?: boolean }> = [];
    const runtime: AiftpMcpRuntime = {
      runPush: async (opts) => {
        calls.push({ dryRun: opts.dryRun });
        if (opts.dryRun) {
          dryRunCount += 1;
          return createPushResult({
            dryRun: true,
            diff:
              dryRunCount === 1
                ? { added: ['index.html'], modified: [], removed: ['old.html'], unchanged: [] }
                : {
                    added: ['changed.html'],
                    modified: [],
                    removed: ['old.html', 'extra.html'],
                    unchanged: [],
                  },
            planned: dryRunCount === 1 ? ['index.html'] : ['changed.html'],
            plannedDeletes: dryRunCount === 1 ? ['old.html'] : ['extra.html', 'old.html'],
            nextState: { schema: 1, files: {} },
          });
        }
        throw new Error('real mutation must not run after drift');
      },
    };
    const app = createAiftpMcp({ cwd, runtime });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_push_prepare', { profile: 'production' }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };

    const result = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
      acknowledge_deletions: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/drift|diff_hash/i);
    expect(calls).toEqual([{ dryRun: true }, { dryRun: true }]);
  });

  it('aiftp_push_confirm rejects delete-only drift before mutation', async () => {
    await writeConfig({ deletionPolicy: 'prune-auto', warnOnProdProfile: false });
    let dryRunCount = 0;
    const calls: Array<{ dryRun?: boolean }> = [];
    const runtime: AiftpMcpRuntime = {
      runPush: async (opts) => {
        calls.push({ dryRun: opts.dryRun });
        if (opts.dryRun) {
          dryRunCount += 1;
          return createPushResult({
            dryRun: true,
            diff: { added: ['index.html'], modified: [], removed: ['old.html'], unchanged: [] },
            planned: ['index.html'],
            plannedDeletes: dryRunCount === 1 ? ['old.html'] : ['extra.html', 'old.html'],
            nextState: { schema: 1, files: {} },
          });
        }
        throw new Error('real mutation must not run after delete-only drift');
      },
    };
    const app = createAiftpMcp({ cwd, runtime });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_push_prepare', { profile: 'production' }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };

    const result = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
      acknowledge_deletions: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/drift|diff_hash/i);
    expect(calls).toEqual([{ dryRun: true }, { dryRun: true }]);
  });

  it('aiftp_push_confirm requires acknowledge_deletions when deletes are planned', async () => {
    await writeConfig({ deletionPolicy: 'prune-auto', warnOnProdProfile: false });
    const dryRunResult = createPushResult({
      dryRun: true,
      diff: { added: [], modified: [], removed: ['old.html'], unchanged: [] },
      planned: [],
      plannedDeletes: ['old.html'],
      nextState: { schema: 1, files: {} },
    });
    const runtime: AiftpMcpRuntime = {
      runPush: async (opts) => {
        if (opts.dryRun) return dryRunResult;
        throw new Error('real mutation must not run without deletion acknowledgement');
      },
    };
    const app = createAiftpMcp({ cwd, runtime });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_push_prepare', { profile: 'production' }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };

    const result = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/acknowledge_deletions|delete/i);
  });

  it('aiftp_push_confirm schema rejects acknowledge_deletions: false outright', async () => {
    const result = await callAiftpTool(createAiftpMcp({ cwd }), 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: 'push-plan',
      diff_hash: 'diff-hash',
      confirm_token: 'confirm-token',
      acknowledge_deletions: false,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/acknowledge_deletions/);
    expect(JSON.stringify(result.content)).toMatch(/expected true/i);
  });

  it('aiftp_push_confirm rejects a stale plan_id (already consumed)', async () => {
    await writeConfig();
    const pushResult = createPushResult({
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      nextState: { schema: 1, files: {} },
    });
    const runtime: AiftpMcpRuntime = {
      runPush: async (opts) =>
        opts.dryRun
          ? pushResult
          : { ...pushResult, dryRun: false, nextState: { schema: 2, files: {} } },
    };
    const app = createAiftpMcp({ cwd, runtime });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_push_prepare', { profile: 'production' }),
    );
    // First confirm consumes the plan.
    await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
      acknowledge_production: true,
    });
    // Second confirm with the same plan_id must fail.
    const replay = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
      acknowledge_production: true,
    });
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay.content)).toMatch(/plan_id|expired|consumed|unknown/i);
  });

  // -----------------------------------------------------------------
  // v0.6.0: production-profile gate (#7)
  //   - prepare surfaces prod_profile_warning when the profile name
  //     matches safety.prod_profile_patterns
  //   - confirm requires acknowledge_production: true to apply
  // -----------------------------------------------------------------

  it('aiftp_push_prepare surfaces prod_profile_warning when the profile matches a prod pattern', async () => {
    await writeConfig();
    const pushResult = createPushResult({
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      nextState: { schema: 1, files: {} },
    });
    const app = createAiftpMcp({ cwd, runtime: { runPush: async () => pushResult } });
    const parsed = parseText(
      await callAiftpTool(app, 'aiftp_push_prepare', { profile: 'production' }),
    ) as { prod_profile_warning: boolean; prod_profile_message?: string };
    expect(parsed.prod_profile_warning).toBe(true);
    expect(parsed.prod_profile_message).toMatch(/acknowledge_production|prod_profile_patterns/);
  });

  it('aiftp_push_confirm schema rejects acknowledge_production: false outright (v0.9.1 fix)', async () => {
    // Claude HIGH: previously the schema was z.boolean().optional(),
    // meaning `false` parsed as a valid value and then tripped the
    // runtime guard. Now z.literal(true).optional() — `false` is a
    // schema-level type error, which is the correct shape for a
    // "must opt in explicitly" flag.
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: 'whatever',
      diff_hash: 'whatever',
      confirm_token: 'whatever',
      acknowledge_production: false,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(
      /invalid_(literal|value)|expected.*true|literal/i,
    );
  });

  it('aiftp_push_confirm refuses a prod-profile plan without acknowledge_production: true', async () => {
    await writeConfig();
    const dryRunResult = createPushResult({
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      nextState: { schema: 1, files: {} },
    });
    const app = createAiftpMcp({
      cwd,
      runtime: {
        runPush: async () => dryRunResult,
      },
    });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_push_prepare', { profile: 'production' }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };
    const refused = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
      // intentionally omitting acknowledge_production
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(
      /acknowledge_production|production push refused/i,
    );
  });

  // -----------------------------------------------------------------
  // v0.4.1: profile read-only MCP tools + default resolver unification
  // -----------------------------------------------------------------

  it('aiftp_profile_list returns a REDACTED profile array (no host/port/user/remote_root)', async () => {
    // Mirrors the aiftp://config resource redaction policy. The MCP server
    // must never surface FTP host / username / remote_root through tools an
    // AI agent can call — those values combined with the credential probe
    // would otherwise leak attack-surface metadata to any MCP client.
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_profile_list', {});
    const parsed = parseText(result) as {
      profiles: Array<Record<string, unknown>>;
    };
    expect(parsed.profiles).toHaveLength(1);
    const entry = parsed.profiles[0] as Record<string, unknown>;
    // Allowed (non-sensitive) fields:
    expect(entry).toMatchObject({
      name: 'production',
      protocol: 'ftps',
      server_kind: 'starserver',
      isDefault: true,
    });
    // Credentials probe is allowed but must be tri-state.
    expect(['present', 'missing', 'unknown']).toContain(entry.credentialsStatus);
    // Redacted (sensitive) fields:
    expect(entry.host).toBeUndefined();
    expect(entry.port).toBeUndefined();
    expect(entry.user).toBeUndefined();
    expect(entry.remote_root).toBeUndefined();
    expect(entry.keychain_service).toBeUndefined();
  });

  it('aiftp_profile_current resolves the default and reports its name (or null when ambiguous)', async () => {
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_profile_current', {});
    const parsed = parseText(result) as { profile: string | null };
    // Single profile in config -> auto-resolved fallback
    expect(parsed.profile).toBe('production');
  });

  it('aiftp_profile_test runs the connection-subset of doctor through the runtime hook', async () => {
    await writeConfig();
    const runtime: AiftpMcpRuntime = {
      runDoctor: async () => ({
        ok: true,
        results: [
          { id: 'keychain', title: 'Keychain', status: 'pass', message: 'ok' },
          { id: 'dns', title: 'DNS', status: 'pass', message: 'resolved' },
          { id: 'config-file', title: '.aiftp.toml', status: 'pass', message: 'ignored by filter' },
        ],
        summary: { pass: 3, warn: 0, fail: 0, skip: 0 },
      }),
    };
    const app = createAiftpMcp({ cwd, runtime });
    const parsed = parseText(
      await callAiftpTool(app, 'aiftp_profile_test', { profile: 'production' }),
    ) as { results: Array<{ id: string }> };
    // Only connection-relevant checks survive the filter.
    const ids = parsed.results.map((r) => r.id);
    expect(ids).toContain('keychain');
    expect(ids).toContain('dns');
    expect(ids).not.toContain('config-file');
  });

  it('aiftp_profile_test recomputes ok from the FILTERED results (Codex review)', async () => {
    // Codex review pointed out: forwarding report.ok would surface non-
    // connection failures (e.g. config-file or gitignore) as `ok: false`
    // even though the connection itself is healthy. ok must be derived
    // from the same filtered set we return to the caller.
    await writeConfig();
    const runtime: AiftpMcpRuntime = {
      runDoctor: async () => ({
        ok: false, // Original report failed because of a non-connection check.
        results: [
          { id: 'config-file', title: '.aiftp.toml', status: 'fail', message: 'parse error' },
          { id: 'keychain', title: 'Keychain', status: 'pass', message: 'ok' },
          { id: 'dns', title: 'DNS', status: 'pass', message: 'resolved' },
          { id: 'tcp', title: 'TCP', status: 'pass', message: 'ok' },
        ],
        summary: { pass: 3, warn: 0, fail: 1, skip: 0 },
      }),
    };
    const app = createAiftpMcp({ cwd, runtime });
    const parsed = parseText(
      await callAiftpTool(app, 'aiftp_profile_test', { profile: 'production' }),
    ) as { ok: boolean; results: Array<{ id: string }>; summary: { fail: number } };
    // The filtered subset has no failures, so ok must be true.
    expect(parsed.ok).toBe(true);
    expect(parsed.summary.fail).toBe(0);
    expect(parsed.results.map((r) => r.id)).not.toContain('config-file');
  });

  it('aiftp_profile_test resolves the default profile when arg is omitted', async () => {
    await writeConfig();
    const runtime: AiftpMcpRuntime = {
      runDoctor: async () => ({
        ok: true,
        results: [{ id: 'keychain', title: 'Keychain', status: 'pass', message: 'ok' }],
        summary: { pass: 1, warn: 0, fail: 0, skip: 0 },
      }),
    };
    const app = createAiftpMcp({ cwd, runtime });
    const parsed = parseText(await callAiftpTool(app, 'aiftp_profile_test', {})) as {
      ok: boolean;
      profile: string;
    };
    expect(parsed.profile).toBe('production');
    expect(parsed.ok).toBe(true);
  });

  it('MCP tools that take a profile arg fall back to resolveDefaultProfile (not hard-coded "production")', async () => {
    // Single-profile config but the profile is named "staging" (not "production").
    // Before v0.4.1 this would have failed with `Profile not found: production`
    // because the schema defaulted the arg to "production". v0.4.1 makes the
    // server resolve the default via resolveDefaultProfile().
    await writeFile(
      join(cwd, '.aiftp.toml'),
      [
        'schema = 2',
        '',
        '[profile.staging]',
        'host = "stg.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "stage-user"',
        'remote_root = "/stage"',
        'local_root = "."',
        'keychain_service = "aiftp:staging"',
        'server_kind = "generic"',
        '',
      ].join('\n'),
      'utf8',
    );
    const runtime: AiftpMcpRuntime = {
      runStatus: async (options) => ({
        diff: { added: [], modified: [], removed: [], unchanged: [] },
        counts: { added: 0, modified: 0, removed: 0, unchanged: 0 },
        context: options,
      }),
    };
    const app = createAiftpMcp({ cwd, runtime });
    // No `profile` argument -> server must resolve "staging" (the only profile).
    const result = await callAiftpTool(app, 'aiftp_status', {});
    expect(result.isError).not.toBe(true);
    const parsed = parseText(result) as { profile: string };
    expect(parsed.profile).toBe('staging');
  });

  it('aiftp_push_confirm requires `profile` (closes prepare→confirm race)', async () => {
    // Without this guard, AIFTP_PROFILE flipping between prepare and
    // confirm would resolve to a different default and trigger the wrong
    // error message (profile mismatch instead of intentional skip). The
    // confirm schema must surface profile as required so the prepare
    // response can be echoed back verbatim.
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_push_confirm', {
      plan_id: 'whatever',
      diff_hash: 'whatever',
      confirm_token: 'whatever',
      // intentionally omitting `profile`
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/profile/i);
  });

  it('aiftp_backup_restore_confirm requires `profile` (closes prepare→confirm race)', async () => {
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_backup_restore_confirm', {
      plan_id: 'whatever',
      diff_hash: 'whatever',
      confirm_token: 'whatever',
      // intentionally omitting `profile`
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/profile/i);
  });

  it('resolveProfileArg surfaces a helpful error when default cannot be resolved', async () => {
    // Two profiles, no AIFTP_PROFILE env, no state file pin -> ambiguous.
    await writeFile(
      join(cwd, '.aiftp.toml'),
      [
        'schema = 2',
        '',
        '[profile.staging]',
        'host = "stg.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "stg"',
        'remote_root = "/stg"',
        'local_root = "."',
        'keychain_service = "aiftp:staging"',
        'server_kind = "generic"',
        '',
        '[profile.production]',
        'host = "prod.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "prod"',
        'remote_root = "/prod"',
        'local_root = "."',
        'keychain_service = "aiftp:production"',
        'server_kind = "generic"',
        '',
      ].join('\n'),
      'utf8',
    );
    const savedEnv = process.env.AIFTP_PROFILE;
    // biome-ignore lint/performance/noDelete: `= undefined` leaks an enumerable key into process.env and breaks downstream consumers; delete is required.
    delete (process.env as Record<string, string | undefined>).AIFTP_PROFILE;
    try {
      const app = createAiftpMcp({ cwd });
      const result = await callAiftpTool(app, 'aiftp_status', {}); // no profile arg
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      // The error must hint the operator at the resolution mechanism, not
      // just say "Profile not found".
      expect(text).toMatch(/AIFTP_PROFILE|profile use|default profile/i);
    } finally {
      if (savedEnv !== undefined) process.env.AIFTP_PROFILE = savedEnv;
    }
  });

  it('aiftp_profile_current returns null when ambiguous (multi-profile, unpinned)', async () => {
    await writeFile(
      join(cwd, '.aiftp.toml'),
      [
        'schema = 2',
        '',
        '[profile.a]',
        'host = "a.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "a"',
        'remote_root = "/"',
        'local_root = "."',
        'keychain_service = "aiftp:a"',
        'server_kind = "generic"',
        '',
        '[profile.b]',
        'host = "b.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "b"',
        'remote_root = "/"',
        'local_root = "."',
        'keychain_service = "aiftp:b"',
        'server_kind = "generic"',
        '',
      ].join('\n'),
      'utf8',
    );
    const savedEnv = process.env.AIFTP_PROFILE;
    // biome-ignore lint/performance/noDelete: `= undefined` leaks an enumerable key into process.env and breaks downstream consumers; delete is required.
    delete (process.env as Record<string, string | undefined>).AIFTP_PROFILE;
    try {
      const app = createAiftpMcp({ cwd });
      const parsed = parseText(await callAiftpTool(app, 'aiftp_profile_current', {})) as {
        profile: string | null;
      };
      expect(parsed.profile).toBeNull();
    } finally {
      if (savedEnv !== undefined) process.env.AIFTP_PROFILE = savedEnv;
    }
  });

  it('aiftp_status wraps loadConfig failure with an MCP-contextual message when .aiftp.toml is missing', async () => {
    // No writeConfig() — the file does not exist at all.
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_status', {});
    expect(result.isError).toBe(true);
    // Must not leak the raw fs ENOENT message alone; must mention .aiftp.toml
    // or the resolution context for the operator.
    expect(JSON.stringify(result.content)).toMatch(/\.aiftp\.toml/);
  });

  it('aiftp://config resource returns a redacted JSON summary (no host / user / keychain_service)', async () => {
    await writeConfig();
    const resource = await readAiftpResource(createAiftpMcp({ cwd }), 'aiftp://config');
    const parsed = JSON.parse(resource);
    expect(parsed.schema).toBeTypeOf('number');
    expect(parsed.profiles).toBeTypeOf('object');
    expect(parsed.profiles.production).toBeTypeOf('object');
    expect(parsed.profiles.production.host).toBeUndefined();
    expect(parsed.profiles.production.user).toBeUndefined();
    expect(parsed.profiles.production.keychain_service).toBeUndefined();
    expect(parsed.profiles.production.remote_root).toBeUndefined();
    // Non-sensitive metadata is allowed.
    expect(parsed.profiles.production.protocol).toBe('ftps');
    expect(parsed.profiles.production.server_kind).toBe('starserver');
  });

  it('aiftp_backup_restore_prepare rejects malformed snapshot ids', async () => {
    await writeConfig();
    const runtime: AiftpMcpRuntime = {
      createBackupStore: async () => ({
        listSnapshots: async () => [],
        verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
        prune: async () => [],
        restoreFile: async () => Buffer.alloc(0),
      }),
    };
    const app = createAiftpMcp({ cwd, runtime });
    const r = await callAiftpTool(app, 'aiftp_backup_restore_prepare', {
      id: '../etc/passwd',
      path: 'index.html',
      output: 'restored.html',
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/invalid snapshot id/i);
  });

  it('aiftp_backup_restore_prepare rejects output paths that escape the project root', async () => {
    await writeConfig();
    const runtime: AiftpMcpRuntime = {
      createBackupStore: async () => ({
        listSnapshots: async () => [],
        verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
        prune: async () => [],
        restoreFile: async () => Buffer.alloc(0),
      }),
    };
    const app = createAiftpMcp({ cwd, runtime });
    const r = await callAiftpTool(app, 'aiftp_backup_restore_prepare', {
      id: '2026-05-18T14-00-00-000Z-auto-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      path: 'index.html',
      output: '../escape.html',
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/outside.*project root|--output/i);
  });

  it('aiftp_backup_restore_confirm rejects replay of a consumed plan_id', async () => {
    await writeConfig();
    const runtime: AiftpMcpRuntime = {
      createBackupStore: async () => ({
        listSnapshots: async () => [],
        verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
        prune: async () => [],
        restoreFile: async () => Buffer.from('payload', 'utf8'),
      }),
    };
    const app = createAiftpMcp({ cwd, runtime });
    const validId = '2026-05-18T14-00-00-000Z-auto-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_backup_restore_prepare', {
        id: validId,
        path: 'index.html',
        output: 'restored.html',
      }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };
    await callAiftpTool(app, 'aiftp_backup_restore_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });
    const replay = await callAiftpTool(app, 'aiftp_backup_restore_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay.content)).toMatch(/plan_id|expired|consumed|unknown/i);
  });

  it('aiftp_backup_list, restore, verify, prune, log, and list_remote delegate safely', async () => {
    await writeConfig();
    await mkdir(join(cwd, '.aiftp'), { recursive: true });
    await writeFile(
      join(cwd, '.aiftp', 'log.jsonl'),
      `${JSON.stringify({ at: '2026-05-18T14:00:00.000Z', event: 'push' })}\n`,
      'utf8',
    );
    const backupStore: AiftpBackupStore = {
      listSnapshots: async () => [
        {
          id: 'snap-1',
          type: 'auto',
          createdAt: '2026-05-18T14:00:00.000Z',
          fileCount: 1,
          totalBytes: 12,
          files: [],
        },
      ],
      verify: async () => ({ ok: true, checkedFiles: 1, errors: [] }),
      prune: async () => ['snap-old'],
      restoreFile: async () => Buffer.from('<h1>restored</h1>\n', 'utf8'),
    };
    const runtime: AiftpMcpRuntime = {
      createBackupStore: async () => backupStore,
      listRemote: async () => ['index.html', 'assets/app.css'],
    };
    const app = createAiftpMcp({ cwd, runtime });

    expect(parseText(await callAiftpTool(app, 'aiftp_backup_list', {}))).toMatchObject({
      snapshots: [{ id: 'snap-1' }],
    });
    expect(
      parseText(await callAiftpTool(app, 'aiftp_backup_verify', { id: 'snap-1' })),
    ).toMatchObject({
      report: { ok: true },
    });
    expect(
      parseText(await callAiftpTool(app, 'aiftp_backup_prune', { keep_count: 1 })),
    ).toMatchObject({
      deleted: ['snap-old'],
    });
    // v0.2.2: aiftp_backup_restore is now a two-step flow (prepare + confirm).
    // Direct invocation is refused.
    const directRestore = await callAiftpTool(app, 'aiftp_backup_restore', {
      id: '2026-05-18T14-00-00-000Z-auto-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      path: 'index.html',
      output: 'restored/index.html',
    });
    expect(directRestore.isError).toBe(true);
    expect(JSON.stringify(directRestore.content)).toMatch(/prepare\/confirm|two-step/i);

    const validId = '2026-05-18T14-00-00-000Z-auto-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_backup_restore_prepare', {
        id: validId,
        path: 'index.html',
        output: 'restored/index.html',
      }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };
    const confirmed = parseText(
      await callAiftpTool(app, 'aiftp_backup_restore_confirm', {
        profile: 'production',
        plan_id: prepared.plan_id,
        diff_hash: prepared.diff_hash,
        confirm_token: prepared.confirm_token,
      }),
    ) as { restored: string };
    expect(confirmed.restored).toBe('restored/index.html');
    expect(await readFile(join(cwd, 'restored', 'index.html'), 'utf8')).toBe('<h1>restored</h1>\n');
    expect(parseText(await callAiftpTool(app, 'aiftp_log', { limit: 1 }))).toMatchObject({
      entries: [{ event: 'push' }],
    });
    expect(parseText(await callAiftpTool(app, 'aiftp_list_remote', { path: '/' }))).toMatchObject({
      entries: ['index.html', 'assets/app.css'],
    });
  });

  it('returns structured tool errors for invalid arguments', async () => {
    const result = await callAiftpTool(createAiftpMcp({ cwd }), 'aiftp_status', {
      profile: 123,
    });

    expect(result.isError).toBe(true);
    expect(parseText(result)).toMatchObject({
      ok: false,
      error: {
        name: 'ZodError',
      },
    });
  });

  // -----------------------------------------------------------------
  // v0.4.2: prepare/confirm gates for aiftp_config_migrate and
  // aiftp_import_filezilla. Both share the same opaque-token + diff_hash
  // discipline as aiftp_push so AI agents cannot apply a side-effectful
  // operation without echoing the plan back verbatim.
  // -----------------------------------------------------------------

  it('aiftp_config_migrate refuses direct invocation and points to prepare/confirm', async () => {
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_config_migrate', {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(
      /prepare\/confirm|two-step|aiftp_config_migrate_prepare/i,
    );
  });

  it('aiftp_config_migrate_prepare returns a REDACTED summary, never the raw TOML', async () => {
    // Codex review (block): returning the full migrated source leaks
    // host / user / keychain_service to the MCP client and contradicts the
    // aiftp://config redaction policy. v0.4.2 final must return a
    // structured summary (sections_added / schema_before / schema_after)
    // without echoing the file contents.
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_config_migrate_prepare', {});
    const parsed = parseText(result) as {
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
      changed: boolean;
      schema_before: number;
      schema_after: number;
      sections_added: string[];
    };
    expect(parsed.changed).toBe(true);
    expect(parsed.schema_before).toBe(1);
    expect(parsed.schema_after).toBe(2);
    expect(parsed.sections_added).toEqual(expect.arrayContaining(['[encoding]', '[quirks]']));
    expect(parsed.plan_id).toMatch(/^[0-9a-f-]{20,}$/u);
    expect(parsed.diff_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(parsed.confirm_token).toMatch(/.{16,}/u);
    // Sensitive fields must NEVER appear in the prepare response.
    const raw = JSON.stringify(parsed);
    expect(raw).not.toContain('ftp.example.com');
    expect(raw).not.toContain('deploy-user');
    expect(raw).not.toContain('aiftp:production');
    expect(raw).not.toContain('/public_html');
    expect(raw).not.toContain('migrated_source');
  });

  it('aiftp_config_migrate_prepare reports changed=false when already at v2', async () => {
    await writeFile(
      join(cwd, '.aiftp.toml'),
      [
        'schema = 2',
        '',
        '[profile.production]',
        'host = "ftp.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "deploy"',
        'remote_root = "/public_html"',
        'local_root = "."',
        'keychain_service = "aiftp:production"',
        'server_kind = "starserver"',
        '',
      ].join('\n'),
      'utf8',
    );
    const app = createAiftpMcp({ cwd });
    const parsed = parseText(await callAiftpTool(app, 'aiftp_config_migrate_prepare', {})) as {
      changed: boolean;
      schema_before: number;
      schema_after: number;
    };
    expect(parsed.changed).toBe(false);
    expect(parsed.schema_before).toBe(2);
    expect(parsed.schema_after).toBe(2);
  });

  it('aiftp_config_migrate_confirm applies the migration and writes the backup file', async () => {
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const prepared = parseText(await callAiftpTool(app, 'aiftp_config_migrate_prepare', {})) as {
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
    };

    const confirmed = parseText(
      await callAiftpTool(app, 'aiftp_config_migrate_confirm', {
        plan_id: prepared.plan_id,
        diff_hash: prepared.diff_hash,
        confirm_token: prepared.confirm_token,
      }),
    ) as { ok: boolean; schema_before: number; schema_after: number; backup_path: string };
    expect(confirmed.ok).toBe(true);
    expect(confirmed.schema_after).toBe(2);
    // .aiftp.toml.v1.bak must exist (atomic migration guarantee).
    expect(await readFile(join(cwd, '.aiftp.toml.v1.bak'), 'utf8')).toMatch(/schema\s*=\s*1/);
    // The on-disk file must now be at schema 2.
    expect(await readFile(join(cwd, '.aiftp.toml'), 'utf8')).toMatch(/schema\s*=\s*2/);
  });

  it('aiftp_config_migrate_confirm rejects mismatched diff_hash / token', async () => {
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const prepared = parseText(await callAiftpTool(app, 'aiftp_config_migrate_prepare', {})) as {
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
    };

    const wrongToken = await callAiftpTool(app, 'aiftp_config_migrate_confirm', {
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: 'nope',
    });
    expect(wrongToken.isError).toBe(true);
    expect(JSON.stringify(wrongToken.content)).toMatch(/token|mismatch/i);
  });

  it('aiftp_import_filezilla refuses direct invocation', async () => {
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_import_filezilla', { path: 'sm.xml' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/prepare\/confirm|two-step/i);
  });

  it('aiftp_import_filezilla_prepare returns redacted IR and collision report', async () => {
    await writeConfig();
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<FileZilla3>',
      '  <Servers>',
      '    <Server>',
      '      <Host>imported.example.com</Host>',
      '      <Port>21</Port>',
      '      <Protocol>0</Protocol>',
      '      <Type>0</Type>',
      '      <User>imported-user</User>',
      '      <Pass encoding="base64">cGFzc3dvcmQ=</Pass>',
      '      <Logontype>1</Logontype>',
      '      <Name>my-imported-site</Name>',
      '    </Server>',
      '  </Servers>',
      '</FileZilla3>',
    ].join('\n');
    await writeFile(join(cwd, 'sm.xml'), xml, 'utf8');
    const app = createAiftpMcp({ cwd });
    const parsed = parseText(
      await callAiftpTool(app, 'aiftp_import_filezilla_prepare', { path: 'sm.xml' }),
    ) as {
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
      profiles: Array<Record<string, unknown>>;
      collisions: string[];
      skipped: Array<{ name: string; reason: string }>;
    };
    expect(parsed.plan_id).toMatch(/^[0-9a-f-]{20,}$/u);
    expect(parsed.profiles).toHaveLength(1);
    const entry = parsed.profiles[0] as Record<string, unknown>;
    // Sensitive password values must NEVER appear in the prepare output —
    // only the kind ("plaintext" / "encoded" / "master-encrypted" / "none").
    expect(entry.password_kind).toBeTypeOf('string');
    expect(JSON.stringify(parsed)).not.toContain('password"');
    expect(JSON.stringify(parsed)).not.toContain('cGFzc3dvcmQ=');
    expect(parsed.collisions).toEqual([]);
    expect(parsed.skipped).toEqual([]);
  });

  it('aiftp_import_filezilla_confirm rejects mismatched plan_id', async () => {
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_import_filezilla_confirm', {
      plan_id: 'bogus',
      diff_hash: 'bogus',
      confirm_token: 'bogus',
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/plan_id|expired|unknown/i);
  });

  it('aiftp_import_filezilla_confirm writes the profiles but NEVER touches the Keychain', async () => {
    await writeConfig();
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<FileZilla3>',
      '  <Servers>',
      '    <Server>',
      '      <Host>imported.example.com</Host>',
      '      <Port>21</Port>',
      '      <Protocol>0</Protocol>',
      '      <Type>0</Type>',
      '      <User>imported-user</User>',
      '      <Pass encoding="base64">cGFzc3dvcmQ=</Pass>',
      '      <Logontype>1</Logontype>',
      '      <Name>my-imported-site</Name>',
      '    </Server>',
      '  </Servers>',
      '</FileZilla3>',
    ].join('\n');
    await writeFile(join(cwd, 'sm.xml'), xml, 'utf8');
    const app = createAiftpMcp({ cwd });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_import_filezilla_prepare', { path: 'sm.xml' }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };

    const confirmed = parseText(
      await callAiftpTool(app, 'aiftp_import_filezilla_confirm', {
        plan_id: prepared.plan_id,
        diff_hash: prepared.diff_hash,
        confirm_token: prepared.confirm_token,
      }),
    ) as {
      ok: boolean;
      imported: string[];
      next_steps: string[];
    };
    expect(confirmed.ok).toBe(true);
    expect(confirmed.imported).toContain('my-imported-site');
    // The confirm output MUST tell the operator to run `aiftp auth`
    // separately for credentials — MCP never writes passwords to Keychain
    // (Codex: security boundary explicit refusal).
    expect(confirmed.next_steps.join(' ')).toMatch(/aiftp auth|keychain|password/i);
    // Imported profile must be visible in .aiftp.toml now.
    expect(await readFile(join(cwd, '.aiftp.toml'), 'utf8')).toMatch(
      /\[profile\.my-imported-site\]/,
    );
  });

  // -----------------------------------------------------------------
  // v0.4.2 review fixes (Claude + Codex):
  //   HIGH-1  migrate confirm re-checks the on-disk file against the plan
  //   HIGH-3  import_prepare deduplicates names within the same batch
  //   HIGH-4  import confirm writes atomically (tmp + rename)
  //   MEDIUM-6 import confirm rechecks collisions
  //   MEDIUM-9 import_prepare honors overwrite=true
  //   MEDIUM-10 CRLF normalization for Windows-edited .aiftp.toml
  // -----------------------------------------------------------------

  it('aiftp_config_migrate_confirm refuses when .v1.bak already exists (multi-run guard)', async () => {
    // Codex 2nd-round review (block): the TOCTOU between MCP's hash check
    // and loadConfig() lets a parallel CLI invocation slip a stale write
    // through. The fix inlines the migrate write at the MCP layer and
    // checks for an existing .v1.bak before the rename. This test asserts
    // that the multi-run guard fires from MCP, not just from core.
    await writeConfig();
    await writeFile(join(cwd, '.aiftp.toml.v1.bak'), 'pre-existing backup', 'utf8');
    const app = createAiftpMcp({ cwd });
    const prepared = parseText(await callAiftpTool(app, 'aiftp_config_migrate_prepare', {})) as {
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
    };
    const result = await callAiftpTool(app, 'aiftp_config_migrate_confirm', {
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/already.*migrated|\.v1\.bak/i);
    // The pre-existing backup must NOT have been overwritten.
    expect(await readFile(join(cwd, '.aiftp.toml.v1.bak'), 'utf8')).toBe('pre-existing backup');
  });

  it('aiftp_config_migrate_confirm refuses when .aiftp.toml drifted after prepare', async () => {
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const prepared = parseText(await callAiftpTool(app, 'aiftp_config_migrate_prepare', {})) as {
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
    };

    // Simulate another process (CLI or operator hand-edit) writing to
    // .aiftp.toml between prepare and confirm.
    await writeFile(
      join(cwd, '.aiftp.toml'),
      [
        'schema = 1',
        '',
        '[profile.production]',
        'host = "ftp.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "deploy-user"',
        'remote_root = "/public_html"',
        'local_root = "."',
        'keychain_service = "aiftp:production"',
        'server_kind = "starserver"',
        '',
        '# operator added a comment after prepare',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await callAiftpTool(app, 'aiftp_config_migrate_confirm', {
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/drift|changed|mismatch/i);
  });

  it('aiftp_import_filezilla_prepare detects duplicate profile names within the batch', async () => {
    await writeConfig();
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<FileZilla3>',
      '  <Servers>',
      '    <Server>',
      '      <Host>a.example.com</Host><Port>21</Port><Protocol>0</Protocol>',
      '      <Type>0</Type><User>u</User><Logontype>1</Logontype>',
      '      <Name>dup-name</Name>',
      '    </Server>',
      '    <Server>',
      '      <Host>b.example.com</Host><Port>21</Port><Protocol>0</Protocol>',
      '      <Type>0</Type><User>u</User><Logontype>1</Logontype>',
      '      <Name>dup-name</Name>',
      '    </Server>',
      '  </Servers>',
      '</FileZilla3>',
    ].join('\n');
    await writeFile(join(cwd, 'sm.xml'), xml, 'utf8');
    const app = createAiftpMcp({ cwd });
    const parsed = parseText(
      await callAiftpTool(app, 'aiftp_import_filezilla_prepare', { path: 'sm.xml' }),
    ) as { queued_names: string[]; skipped: Array<{ name: string; reason: string }> };
    expect(parsed.queued_names).toEqual(['dup-name']);
    expect(parsed.skipped.some((s) => /duplicate|batch/i.test(s.reason))).toBe(true);
  });

  it('aiftp_import_filezilla_confirm refuses when .aiftp.toml gained a colliding profile after prepare', async () => {
    await writeConfig();
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<FileZilla3>',
      '  <Servers>',
      '    <Server>',
      '      <Host>imp.example.com</Host><Port>21</Port><Protocol>0</Protocol>',
      '      <Type>0</Type><User>u</User><Logontype>1</Logontype>',
      '      <Name>late-collision</Name>',
      '    </Server>',
      '  </Servers>',
      '</FileZilla3>',
    ].join('\n');
    await writeFile(join(cwd, 'sm.xml'), xml, 'utf8');
    const app = createAiftpMcp({ cwd });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_import_filezilla_prepare', { path: 'sm.xml' }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };

    // Operator adds a profile with the same name between prepare and confirm.
    const tomlPath = join(cwd, '.aiftp.toml');
    const existing = await readFile(tomlPath, 'utf8');
    await writeFile(
      tomlPath,
      `${existing}\n[profile.late-collision]\nhost = "other.example.com"\nport = 21\nprotocol = "ftps"\nuser = "x"\nremote_root = "/"\nlocal_root = "."\nkeychain_service = "aiftp:x"\nserver_kind = "generic"\n`,
      'utf8',
    );

    const result = await callAiftpTool(app, 'aiftp_import_filezilla_confirm', {
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/collision|drift|already exists/i);
  });

  it('aiftp_import_filezilla_prepare honors overwrite=true', async () => {
    await writeConfig();
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<FileZilla3>',
      '  <Servers>',
      '    <Server>',
      '      <Host>new.example.com</Host><Port>21</Port><Protocol>0</Protocol>',
      '      <Type>0</Type><User>new-user</User><Logontype>1</Logontype>',
      '      <Name>production</Name>',
      '    </Server>',
      '  </Servers>',
      '</FileZilla3>',
    ].join('\n');
    await writeFile(join(cwd, 'sm.xml'), xml, 'utf8');
    const app = createAiftpMcp({ cwd });
    const parsed = parseText(
      await callAiftpTool(app, 'aiftp_import_filezilla_prepare', {
        path: 'sm.xml',
        overwrite: true,
      }),
    ) as {
      queued_names: string[];
      collisions: string[];
      skipped: Array<{ name: string; reason: string }>;
    };
    expect(parsed.queued_names).toContain('production');
    expect(parsed.skipped.find((s) => s.name === 'production')).toBeUndefined();
  });

  it('aiftp_config_migrate_confirm normalizes CRLF input before migrating', async () => {
    await writeFile(
      join(cwd, '.aiftp.toml'),
      [
        'schema = 1',
        '',
        '[profile.production]',
        'host = "ftp.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "deploy-user"',
        'remote_root = "/public_html"',
        'local_root = "."',
        'keychain_service = "aiftp:production"',
        'server_kind = "starserver"',
        '',
      ].join('\r\n'),
      'utf8',
    );
    const app = createAiftpMcp({ cwd });
    const prepared = parseText(await callAiftpTool(app, 'aiftp_config_migrate_prepare', {})) as {
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
    };
    const confirmed = parseText(
      await callAiftpTool(app, 'aiftp_config_migrate_confirm', {
        plan_id: prepared.plan_id,
        diff_hash: prepared.diff_hash,
        confirm_token: prepared.confirm_token,
      }),
    ) as { ok: boolean; schema_after: number };
    expect(confirmed.ok).toBe(true);
    expect(confirmed.schema_after).toBe(2);
    expect(await readFile(join(cwd, '.aiftp.toml'), 'utf8')).toMatch(/schema\s*=\s*2/);
  });

  // -----------------------------------------------------------------
  // v0.5.0: aiftp_rollback{,_prepare,_confirm}
  //   - rollback = upload a snapshot's files back to the FTP server
  //   - hard-exclude protected files are NEVER uploaded
  //   - prepare/confirm gate with plan_id/diff_hash/confirm_token
  // -----------------------------------------------------------------

  it('aiftp_rollback refuses direct invocation and points at prepare/confirm', async () => {
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_rollback', { steps: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(
      /prepare\/confirm|two-step|aiftp_rollback_prepare/i,
    );
  });

  it('aiftp_rollback_prepare returns plan + planned file list + skipped hard-excludes', async () => {
    await writeConfig();
    const runtime: AiftpMcpRuntime = {
      createBackupStore: async () => ({
        listSnapshots: async () => [
          {
            id: '2026-05-19T01:00:00.000Z-auto-bbb',
            type: 'auto',
            createdAt: '2026-05-19T01:00:00.000Z',
            fileCount: 3,
            totalBytes: 100,
            files: [
              {
                path: 'index.html',
                storedName: 'index.html.enc',
                sizeOriginal: 12,
                sizeEncrypted: 40,
                sha256Original: 'a'.repeat(64),
                sha256Encrypted: 'b'.repeat(64),
              },
              {
                path: 'wp-config.php',
                storedName: 'wp-config.php.enc',
                sizeOriginal: 50,
                sizeEncrypted: 78,
                sha256Original: 'a'.repeat(64),
                sha256Encrypted: 'b'.repeat(64),
              },
              {
                path: '.env',
                storedName: '.env.enc',
                sizeOriginal: 20,
                sizeEncrypted: 48,
                sha256Original: 'a'.repeat(64),
                sha256Encrypted: 'b'.repeat(64),
              },
            ],
          },
        ],
        verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
        prune: async () => [],
        restoreFile: async () => Buffer.from('<h1>old</h1>'),
      }),
    };
    const app = createAiftpMcp({ cwd, runtime });
    const parsed = parseText(await callAiftpTool(app, 'aiftp_rollback_prepare', { steps: 1 })) as {
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
      snapshot_id: string;
      planned: string[];
      skipped: Array<{ path: string; status: string }>;
    };
    expect(parsed.plan_id).toMatch(/^[0-9a-f-]{20,}$/u);
    expect(parsed.diff_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(parsed.snapshot_id).toBe('2026-05-19T01:00:00.000Z-auto-bbb');
    expect(parsed.planned).toEqual(['index.html']);
    expect(parsed.skipped.map((s) => s.path).sort()).toEqual(['.env', 'wp-config.php']);
    expect(parsed.skipped.every((s) => s.status === 'skipped-hard-exclude')).toBe(true);
  });

  it('aiftp_rollback_confirm uploads files matching the plan; bad token refused', async () => {
    await writeConfig();
    const uploads: string[] = [];
    const runtime: AiftpMcpRuntime = {
      createBackupStore: async () => ({
        listSnapshots: async () => [
          {
            id: '2026-05-19T01:00:00.000Z-auto-bbb',
            type: 'auto',
            createdAt: '2026-05-19T01:00:00.000Z',
            fileCount: 1,
            totalBytes: 12,
            files: [
              {
                path: 'index.html',
                storedName: 'index.html.enc',
                sizeOriginal: 12,
                sizeEncrypted: 40,
                sha256Original: 'a'.repeat(64),
                sha256Encrypted: 'b'.repeat(64),
              },
            ],
          },
        ],
        verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
        prune: async () => [],
        restoreFile: async () => Buffer.from('<h1>old</h1>'),
      }),
      // v0.5.0 fix: rollback now uses a dedicated Buffer-shaped hook
      // (createRollbackUploader) rather than duck-typing DeployUploader.
      createRollbackUploader: async () => ({
        upload: async (_local, remote, _content) => {
          uploads.push(remote);
        },
        // No rename → direct upload path (no .aiftp-rb tmp), keeping
        // the test assertion `uploads === ['/public_html/index.html']`.
      }),
    };
    const app = createAiftpMcp({ cwd, runtime });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_rollback_prepare', { steps: 1 }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };

    // Wrong token: refused.
    const wrongToken = await callAiftpTool(app, 'aiftp_rollback_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: 'nope',
    });
    expect(wrongToken.isError).toBe(true);
    expect(uploads).toHaveLength(0);

    // Correct values: rollback runs.
    const confirmed = parseText(
      await callAiftpTool(app, 'aiftp_rollback_confirm', {
        profile: 'production',
        plan_id: prepared.plan_id,
        diff_hash: prepared.diff_hash,
        confirm_token: prepared.confirm_token,
      }),
    ) as { ok: boolean; rolled_back: string[] };
    expect(confirmed.ok).toBe(true);
    expect(uploads).toEqual(['/public_html/index.html']);
    expect(confirmed.rolled_back).toEqual(['index.html']);
  });

  it('aiftp_rollback_prepare and confirm bind plannedDeletes', async () => {
    await writeConfig();
    const deletes: string[] = [];
    const runtime: AiftpMcpRuntime = {
      createBackupStore: async () => ({
        listSnapshots: async () => [
          {
            id: '2026-05-19T01:00:00.000Z-auto-delete',
            type: 'auto',
            createdAt: '2026-05-19T01:00:00.000Z',
            fileCount: 1,
            totalBytes: 0,
            files: [
              {
                path: 'new-page.html',
                operation: 'added',
                storedName: null,
                sizeOriginal: null,
                sizeEncrypted: null,
                sha256Original: null,
                sha256Encrypted: null,
              },
            ],
          },
        ],
        verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
        prune: async () => [],
        restoreFile: async () => {
          throw new Error('added rollback should delete, not restore');
        },
      }),
      createRollbackUploader: async () => ({
        upload: async () => {
          throw new Error('added rollback should not upload');
        },
        delete: async (remotePath) => {
          deletes.push(remotePath);
        },
      }),
    };
    const app = createAiftpMcp({ cwd, runtime });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_rollback_prepare', { steps: 1 }),
    ) as {
      plan_id: string;
      diff_hash: string;
      confirm_token: string;
      planned: string[];
      plannedDeletes: string[];
    };
    expect(prepared.planned).toEqual([]);
    expect(prepared.plannedDeletes).toEqual(['new-page.html']);

    const confirmed = parseText(
      await callAiftpTool(app, 'aiftp_rollback_confirm', {
        profile: 'production',
        plan_id: prepared.plan_id,
        diff_hash: prepared.diff_hash,
        confirm_token: prepared.confirm_token,
        acknowledge_deletions: true,
      }),
    ) as { ok: boolean; rolled_back: string[]; deleted: string[] };

    expect(confirmed.ok).toBe(true);
    expect(confirmed.rolled_back).toEqual([]);
    expect(confirmed.deleted).toEqual(['new-page.html']);
    expect(deletes).toEqual(['/public_html/new-page.html']);
  });

  it('aiftp_rollback_confirm requires acknowledge_deletions when deletes are planned', async () => {
    await writeConfig();
    const { runtime, deletes } = rollbackRuntimeFor([addedSnapshotFile('new-page.html')]);
    const app = createAiftpMcp({ cwd, runtime });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_rollback_prepare', { steps: 1 }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };

    const result = await callAiftpTool(app, 'aiftp_rollback_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Deletion rollback refused/);
    expect(JSON.stringify(result.content)).toMatch(/acknowledge_deletions/);
    expect(deletes).toEqual([]);
  });

  it('aiftp_rollback_confirm accepts acknowledge_deletions when deletes are planned', async () => {
    await writeConfig();
    const { runtime, deletes } = rollbackRuntimeFor([addedSnapshotFile('new-page.html')]);
    const app = createAiftpMcp({ cwd, runtime });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_rollback_prepare', { steps: 1 }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };

    const confirmed = parseText(
      await callAiftpTool(app, 'aiftp_rollback_confirm', {
        profile: 'production',
        plan_id: prepared.plan_id,
        diff_hash: prepared.diff_hash,
        confirm_token: prepared.confirm_token,
        acknowledge_deletions: true,
      }),
    ) as { ok: boolean; deleted: string[] };

    expect(confirmed.ok).toBe(true);
    expect(confirmed.deleted).toEqual(['new-page.html']);
    expect(deletes).toEqual(['/public_html/new-page.html']);
  });

  it('aiftp_rollback_confirm does not require acknowledge_deletions when no deletes are planned', async () => {
    await writeConfig();
    const { runtime, uploads, deletes } = rollbackRuntimeFor([modifiedSnapshotFile('index.html')]);
    const app = createAiftpMcp({ cwd, runtime });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_rollback_prepare', { steps: 1 }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };

    const confirmed = parseText(
      await callAiftpTool(app, 'aiftp_rollback_confirm', {
        profile: 'production',
        plan_id: prepared.plan_id,
        diff_hash: prepared.diff_hash,
        confirm_token: prepared.confirm_token,
      }),
    ) as { ok: boolean; rolled_back: string[]; deleted: string[] };

    expect(confirmed.ok).toBe(true);
    expect(confirmed.rolled_back).toEqual(['index.html']);
    expect(confirmed.deleted).toEqual([]);
    expect(uploads).toEqual(['/public_html/index.html']);
    expect(deletes).toEqual([]);
  });

  it('aiftp_rollback_confirm schema rejects acknowledge_deletions: false outright', async () => {
    await writeConfig();
    const result = await callAiftpTool(createAiftpMcp({ cwd }), 'aiftp_rollback_confirm', {
      profile: 'production',
      plan_id: 'rollback-plan',
      diff_hash: 'diff-hash',
      confirm_token: 'confirm-token',
      acknowledge_deletions: false,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/acknowledge_deletions/);
    expect(JSON.stringify(result.content)).toMatch(/expected true/i);
  });

  it('aiftp_rollback_confirm rejects replay of a consumed plan', async () => {
    await writeConfig();
    const runtime: AiftpMcpRuntime = {
      createBackupStore: async () => ({
        listSnapshots: async () => [
          {
            id: '2026-05-19T01:00:00.000Z-auto-bbb',
            type: 'auto',
            createdAt: '2026-05-19T01:00:00.000Z',
            fileCount: 1,
            totalBytes: 12,
            files: [
              {
                path: 'index.html',
                storedName: 'index.html.enc',
                sizeOriginal: 12,
                sizeEncrypted: 40,
                sha256Original: 'a'.repeat(64),
                sha256Encrypted: 'b'.repeat(64),
              },
            ],
          },
        ],
        verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
        prune: async () => [],
        restoreFile: async () => Buffer.from('<h1>old</h1>'),
      }),
      createRollbackUploader: async () => ({ upload: async () => undefined }),
    };
    const app = createAiftpMcp({ cwd, runtime });
    const prepared = parseText(
      await callAiftpTool(app, 'aiftp_rollback_prepare', { steps: 1 }),
    ) as { plan_id: string; diff_hash: string; confirm_token: string };
    await callAiftpTool(app, 'aiftp_rollback_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });
    const replay = await callAiftpTool(app, 'aiftp_rollback_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay.content)).toMatch(/plan_id|expired|consumed|unknown/i);
  });

  it('reads config and state resources', async () => {
    await writeConfig();
    await mkdir(join(cwd, '.aiftp', 'state', 'production'), { recursive: true });
    await writeFile(
      join(cwd, '.aiftp', 'state', 'production', 'state.json'),
      JSON.stringify({ schema: 1, files: {} }),
      'utf8',
    );

    const app = createAiftpMcp({ cwd });

    expect(
      JSON.parse(await readAiftpResource(app, 'aiftp://config')).profiles.production,
    ).toBeTypeOf('object');
    expect(JSON.parse(await readAiftpResource(app, 'aiftp://state/production'))).toEqual({
      schema: 1,
      files: {},
    });
  });
});
