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
    expect(
      parseText(
        await callAiftpTool(app, 'aiftp_backup_restore', {
          id: 'snap-1',
          path: 'index.html',
          output: 'restored/index.html',
        }),
      ),
    ).toMatchObject({ restored: 'restored/index.html' });
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

    expect(await readAiftpResource(app, 'aiftp://config')).toContain('[profile.production]');
    expect(JSON.parse(await readAiftpResource(app, 'aiftp://state/production'))).toEqual({
      schema: 1,
      files: {},
    });
  });
});
