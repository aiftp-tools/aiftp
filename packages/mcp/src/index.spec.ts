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

describe('mcp', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = join(tmpdir(), `aiftp-mcp-test-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function writeConfig(): Promise<void> {
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
      ].join('\n'),
      'utf8',
    );
  }

  function parseText(result: { content: Array<{ type: string; text?: string }> }): unknown {
    return JSON.parse(result.content[0]?.text ?? '{}');
  }

  it('re-exports VERSION from core', () => {
    expect(VERSION).toBe('0.0.0');
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
    const pushResult: PushResult = {
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      uploaded: [],
      backupSnapshot: null,
      nextState: { schema: 1, files: {} },
    };
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
    const pushResult: PushResult = {
      dryRun: true,
      diff: { added: ['index.html', 'about.html'], modified: [], removed: [], unchanged: [] },
      planned: ['about.html', 'index.html'],
      uploaded: [],
      backupSnapshot: null,
      nextState: { schema: 1, files: {} },
    };
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

  it('aiftp_push_confirm requires matching plan_id, diff_hash, and confirm_token', async () => {
    await writeConfig();
    const dryRunResult: PushResult = {
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      uploaded: [],
      backupSnapshot: null,
      nextState: { schema: 1, files: {} },
    };
    const realResult: PushResult = {
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
    };
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

    // Correct values: real push runs.
    const confirmRaw = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
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

  it('aiftp_push_confirm rejects a stale plan_id (already consumed)', async () => {
    await writeConfig();
    const pushResult: PushResult = {
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      uploaded: [],
      backupSnapshot: null,
      nextState: { schema: 1, files: {} },
    };
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
    });
    // Second confirm with the same plan_id must fail.
    const replay = await callAiftpTool(app, 'aiftp_push_confirm', {
      profile: 'production',
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay.content)).toMatch(/plan_id|expired|consumed|unknown/i);
  });

  // -----------------------------------------------------------------
  // v0.4.1: profile read-only MCP tools + default resolver unification
  // -----------------------------------------------------------------

  it('aiftp_profile_list returns the structured profile array with credentialsPresent + isDefault', async () => {
    await writeConfig();
    const app = createAiftpMcp({ cwd });
    const result = await callAiftpTool(app, 'aiftp_profile_list', {});
    const parsed = parseText(result) as {
      profiles: Array<{
        name: string;
        host: string;
        credentialsPresent: boolean;
        isDefault: boolean;
      }>;
    };
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]).toMatchObject({
      name: 'production',
      host: 'ftp.example.com',
    });
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
      plan_id: prepared.plan_id,
      diff_hash: prepared.diff_hash,
      confirm_token: prepared.confirm_token,
    });
    const replay = await callAiftpTool(app, 'aiftp_backup_restore_confirm', {
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
