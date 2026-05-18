import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PushResult, type StatusResult, loadConfig } from '@aiftp-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CliBackupStore,
  type CliKeychain,
  type CliPrompt,
  type CliRuntime,
  VERSION,
  createCli,
} from './index.js';

describe('cli', () => {
  let cwd: string;
  let stdout: string[];
  let stderr: string[];
  let stored: Array<{ service: string; account: string; password: string }>;
  let deleted: Array<{ service: string; account: string }>;

  beforeEach(async () => {
    cwd = join(tmpdir(), `aiftp-cli-test-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
    stdout = [];
    stderr = [];
    stored = [];
    deleted = [];
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function prompt(answers: Record<string, unknown>): CliPrompt {
    return async () => answers;
  }

  function keychain(existing = new Set<string>()): CliKeychain {
    return {
      setPassword: async (service, account, password) => {
        stored.push({ service, account, password });
        existing.add(`${service}:${account}`);
      },
      deletePassword: async (service, account) => {
        deleted.push({ service, account });
        existing.delete(`${service}:${account}`);
      },
      hasPassword: async (service, account) => existing.has(`${service}:${account}`),
      getPassword: async (service, account) => {
        if (service.endsWith(':backup-key')) {
          return Buffer.alloc(32, 1).toString('base64');
        }
        if (!existing.has(`${service}:${account}`)) {
          throw new Error('missing keychain entry');
        }
        return 'password';
      },
    };
  }

  async function parse(
    args: string[],
    options: { prompt?: CliPrompt; keychain?: CliKeychain; runtime?: CliRuntime } = {},
  ) {
    const command = createCli({
      cwd,
      prompt: options.prompt ?? prompt({}),
      keychain: options.keychain ?? keychain(),
      runtime: options.runtime,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    await command.parseAsync(['node', 'aiftp', ...args], { from: 'node' });
  }

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

  async function writeLocal(path: string, content: string): Promise<void> {
    const filePath = join(cwd, ...path.split('/'));
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }

  it('re-exports VERSION from core', () => {
    expect(VERSION).toBe('0.0.0');
  });

  it('init writes .aiftp.toml, stores secrets, and adds .aiftp/ to .gitignore', async () => {
    await writeFile(join(cwd, '.gitignore'), 'node_modules/\n', 'utf8');

    await parse(['init'], {
      prompt: prompt({
        profile: 'production',
        host: 'ftp.example.com',
        port: 21,
        protocol: 'ftps',
        user: 'deploy-user',
        remoteRoot: '/public_html',
        localRoot: '.',
        keychainService: 'aiftp:production',
        serverKind: 'starserver',
        password: 'secret-password',
        consent: true,
      }),
    });

    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.host).toBe('ftp.example.com');
    expect(config.profile.production?.remote_root).toBe('/public_html');
    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toContain('.aiftp/');
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual({
      service: 'aiftp:production',
      account: 'deploy-user',
      password: 'secret-password',
    });
    expect(stored[1]?.service).toBe('aiftp:production:backup-key');
    expect(stdout.join('\n')).toContain('Initialized aiftp profile production');
  });

  it('init refuses to overwrite existing config unless --force is passed', async () => {
    await writeConfig();

    await expect(parse(['init'], { prompt: prompt({ consent: true }) })).rejects.toThrow(
      '.aiftp.toml already exists',
    );
  });

  it('init --force preserves an existing backup key by default', async () => {
    await writeConfig();

    await parse(['init', '--force'], {
      keychain: keychain(new Set(['aiftp:production:backup-key:production'])),
      prompt: prompt({
        profile: 'production',
        host: 'ftp.example.com',
        port: 21,
        protocol: 'ftps',
        user: 'deploy-user',
        remoteRoot: '/public_html',
        localRoot: '.',
        keychainService: 'aiftp:production',
        serverKind: 'starserver',
        password: 'secret-password',
        consent: true,
      }),
    });

    expect(stored).toEqual([
      {
        service: 'aiftp:production',
        account: 'deploy-user',
        password: 'secret-password',
      },
    ]);
  });

  it('init --force overwrites an existing backup key only after explicit confirmation', async () => {
    await writeConfig();
    const answers = {
      profile: 'production',
      host: 'ftp.example.com',
      port: 21,
      protocol: 'ftps',
      user: 'deploy-user',
      remoteRoot: '/public_html',
      localRoot: '.',
      keychainService: 'aiftp:production',
      serverKind: 'starserver',
      password: 'secret-password',
      consent: true,
    };
    const confirmOverwrite: CliPrompt = async (questions) => {
      const first = Array.isArray(questions) ? questions[0] : questions;
      return first?.name === 'overwriteBackupKey' ? { overwriteBackupKey: true } : answers;
    };

    await parse(['init', '--force'], {
      keychain: keychain(new Set(['aiftp:production:backup-key:production'])),
      prompt: confirmOverwrite,
    });

    expect(stored).toHaveLength(2);
    expect(stored[1]?.service).toBe('aiftp:production:backup-key');
    expect(stored[1]?.account).toBe('production');
  });

  it('auth set stores a replacement password for a configured profile', async () => {
    await writeConfig();

    await parse(['auth', 'set', '--profile', 'production'], {
      prompt: prompt({ password: 'new-password' }),
    });

    expect(stored).toEqual([
      {
        service: 'aiftp:production',
        account: 'deploy-user',
        password: 'new-password',
      },
    ]);
    expect(stdout.join('\n')).toContain('Updated credentials for production');
  });

  it('auth list reports configured profiles and keychain presence', async () => {
    await writeConfig();

    await parse(['auth', 'list'], {
      keychain: keychain(new Set(['aiftp:production:deploy-user'])),
    });

    expect(stdout).toContain('production deploy-user stored');
  });

  it('auth delete removes credentials for a configured profile', async () => {
    await writeConfig();

    await parse(['auth', 'delete', '--profile', 'production']);

    expect(deleted).toEqual([{ service: 'aiftp:production', account: 'deploy-user' }]);
    expect(stdout.join('\n')).toContain('Deleted credentials for production');
  });

  it('status prints a JSON diff for the configured profile', async () => {
    await writeConfig();
    await writeLocal('index.html', '<h1>new</h1>\n');

    await parse(['status', '--profile', 'production', '--json']);

    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      counts: {
        added: 1,
        modified: 0,
        removed: 0,
        unchanged: 0,
      },
      diff: {
        added: ['index.html'],
      },
    });
  });

  it('push saves the returned state and appends a log entry', async () => {
    await writeConfig();
    await writeLocal('index.html', '<h1>new</h1>\n');
    const statusResult: StatusResult = {
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      counts: { added: 1, modified: 0, removed: 0, unchanged: 0 },
    };
    const pushResult: PushResult = {
      dryRun: false,
      diff: statusResult.diff,
      planned: ['index.html'],
      uploaded: [
        {
          path: 'index.html',
          localPath: join(cwd, 'index.html'),
          remotePath: '/public_html/index.html',
          size: 13,
          hash: 'new-hash',
        },
      ],
      backupSnapshot: null,
      nextState: {
        schema: 1,
        files: {
          'index.html': {
            hash: 'new-hash',
            size: 13,
            updatedAt: '2026-05-18T13:00:00.000Z',
          },
        },
      },
    };

    await parse(['push', '--profile', 'production'], {
      runtime: {
        runPush: async () => pushResult,
      },
    });

    expect(stdout.join('\n')).toContain('Uploaded 1 file(s)');
    const savedState = await readFile(
      join(cwd, '.aiftp', 'state', 'production', 'state.json'),
      'utf8',
    );
    expect(JSON.parse(savedState)).toEqual(pushResult.nextState);
    const log = await readFile(join(cwd, '.aiftp', 'log.jsonl'), 'utf8');
    expect(log).toContain('"event":"push"');
    expect(log).toContain('"uploaded":1');
  });

  it('push --dry-run reports planned files without saving state', async () => {
    await writeConfig();
    const pushResult: PushResult = {
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      uploaded: [],
      backupSnapshot: null,
      nextState: { schema: 1, files: {} },
    };

    await parse(['push', '--profile', 'production', '--dry-run', '--json'], {
      runtime: {
        runPush: async () => pushResult,
      },
    });

    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      dryRun: true,
      planned: ['index.html'],
    });
    await expect(
      readFile(join(cwd, '.aiftp', 'state', 'production', 'state.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('push --dry-run can use the built-in core flow without connecting to FTP', async () => {
    await writeConfig();
    await writeLocal('index.html', '<h1>new</h1>\n');

    await parse(['push', '--profile', 'production', '--dry-run', '--json']);

    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      dryRun: true,
      planned: ['index.html'],
    });
  });

  it('log prints recent log entries newest last from the log file tail', async () => {
    await mkdir(join(cwd, '.aiftp'), { recursive: true });
    await writeFile(
      join(cwd, '.aiftp', 'log.jsonl'),
      [
        JSON.stringify({
          at: '2026-05-18T12:00:00.000Z',
          event: 'status',
          profile: 'production',
        }),
        JSON.stringify({
          at: '2026-05-18T12:05:00.000Z',
          event: 'push',
          profile: 'production',
          uploaded: 1,
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    await parse(['log', '--limit', '1']);

    expect(stdout).toEqual(['2026-05-18T12:05:00.000Z push production uploaded=1']);
  });

  it('backup list, verify, prune, and restore delegate to the configured backup store', async () => {
    await writeConfig();
    const restored = Buffer.from('<h1>restored</h1>\n', 'utf8');
    const fakeStore: CliBackupStore = {
      listSnapshots: async () => [
        {
          id: 'snap-1',
          type: 'auto',
          createdAt: '2026-05-18T12:00:00.000Z',
          fileCount: 1,
          totalBytes: 18,
          files: [],
        },
      ],
      verify: async () => ({ ok: true, checkedFiles: 1, errors: [] }),
      prune: async () => ['snap-old'],
      restoreFile: async () => restored,
    };
    const runtime: CliRuntime = {
      createBackupStore: async () => fakeStore,
    };

    await parse(['backup', 'list', '--profile', 'production'], { runtime });
    await parse(['backup', 'verify', 'snap-1', '--profile', 'production'], { runtime });
    await parse(['backup', 'prune', '--keep', '1', '--profile', 'production'], { runtime });
    await parse(
      [
        'backup',
        'restore',
        'snap-1',
        'index.html',
        '--output',
        'restored/index.html',
        '--profile',
        'production',
      ],
      { runtime },
    );

    expect(stdout).toContain('snap-1 auto 2026-05-18T12:00:00.000Z files=1 bytes=18');
    expect(stdout).toContain('snap-1 ok checked=1');
    expect(stdout).toContain('Pruned 1 snapshot(s)');
    expect(await readFile(join(cwd, 'restored', 'index.html'), 'utf8')).toBe('<h1>restored</h1>\n');
  });

  it('backup prune rejects non-numeric --keep values with a clear error', async () => {
    await expect(parse(['backup', 'prune', '--keep', 'abc'])).rejects.toThrow(
      '--keep must be a non-negative integer',
    );
  });

  it('mcp starts the stdio MCP server through the configured runtime', async () => {
    const started: string[] = [];

    await parse(['mcp'], {
      runtime: {
        startMcp: async (context) => {
          started.push(context.cwd);
        },
      },
    });

    expect(started).toEqual([cwd]);
    expect(stdout).toEqual([]);
  });
});
