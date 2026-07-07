import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type PushResult,
  type ResolvedSite,
  type RollbackResult,
  type SiteEntry,
  loadConfig,
} from '@aiftp-tools/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type CliKeychain,
  type CliOptions,
  type CliPrompt,
  type CliRuntime,
  createCli,
} from './index.js';

const originalIsTTY = process.stdin.isTTY;

beforeAll(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

afterAll(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
});

describe('multi-site CLI integration', () => {
  let root: string;
  let cwd: string;
  let stdout: string[];
  let stderr: string[];
  let stored: Array<{ service: string; account: string; password: string }>;

  beforeEach(async () => {
    root = join(tmpdir(), `aiftp-multi-site-test-${randomUUID()}`);
    cwd = root;
    stdout = [];
    stderr = [];
    stored = [];
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function keychain(): CliKeychain {
    return {
      setPassword: async (service, account, password) => {
        stored.push({ service, account, password });
      },
      deletePassword: async () => undefined,
      hasPassword: async () => false,
      getPassword: async (service) => {
        if (service.endsWith(':backup-key')) {
          return Buffer.alloc(32, 1).toString('base64');
        }
        throw new Error('unexpected keychain read in mocked multi-site integration');
      },
    };
  }

  async function parse(
    args: string[],
    options: {
      prompt?: CliPrompt;
      runtime?: CliRuntime;
      sites?: CliOptions['sites'];
    } = {},
  ): Promise<void> {
    const command = createCli({
      cwd,
      prompt: options.prompt ?? (async () => ({})),
      keychain: keychain(),
      runtime: options.runtime,
      sites: options.sites,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    await command.parseAsync(['node', 'aiftp', ...args], { from: 'node' });
  }

  function fakeRegistry(entries: readonly SiteEntry[]) {
    return {
      list: async () => entries,
      add: async () => entries,
      remove: async () => entries,
    };
  }

  async function writeSiteConfig(
    directory: string,
    fields: {
      host: string;
      user: string;
      keychainService: string;
      remoteRoot: string;
      localRoot: string;
      serverKind: string;
      port?: number;
      protocol?: string;
      ftpsMode?: string;
      passiveMode?: boolean;
      encoding?: string;
    },
  ): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, '.aiftp.toml'),
      [
        'schema = 2',
        '',
        '[profile.production]',
        `host = ${JSON.stringify(fields.host)}`,
        `port = ${fields.port ?? 21}`,
        `protocol = ${JSON.stringify(fields.protocol ?? 'ftps')}`,
        `user = ${JSON.stringify(fields.user)}`,
        `remote_root = ${JSON.stringify(fields.remoteRoot)}`,
        `local_root = ${JSON.stringify(fields.localRoot)}`,
        `keychain_service = ${JSON.stringify(fields.keychainService)}`,
        `server_kind = ${JSON.stringify(fields.serverKind)}`,
        ...(fields.ftpsMode === undefined
          ? []
          : [`ftps_mode = ${JSON.stringify(fields.ftpsMode)}`]),
        ...(fields.passiveMode === undefined ? [] : [`passive_mode = ${fields.passiveMode}`]),
        '',
        ...(fields.encoding === undefined
          ? []
          : ['[encoding]', `file_name = ${JSON.stringify(fields.encoding)}`, '']),
      ].join('\n'),
      'utf8',
    );
  }

  function resolvedSite(entry: SiteEntry): ResolvedSite {
    return {
      ...entry,
      profiles: ['production'],
      protocol: 'ftps',
      credentialsStatus: 'missing',
      health: 'ok',
    };
  }

  function destinationBannerLines(): string[] {
    const start = stderr.findIndex((line) => line.startsWith('⛳ 宛先:'));
    if (start < 0) return [];
    return stderr.slice(start, start + 1).flatMap((line) => line.split('\n').slice(0, 3));
  }

  function resetOutput(): void {
    stdout = [];
    stderr = [];
  }

  function expectNoSecrets(output: string, secrets: readonly string[]): void {
    for (const secret of secrets) {
      expect(output).not.toContain(secret);
    }
  }

  it('covers sites list -> init --from -> push destination banner -> rollback with mocked multi-site fleet', async () => {
    const gwcoPath = join(root, 'gwco');
    const clientBPath = join(root, 'client-b');
    const newSitePath = join(root, 'new-client');
    const unregisteredPath = join(root, 'unregistered');
    const secretNeedles = [
      'ftp.gwco-secret.example.com',
      'gwco-deploy-user',
      'aiftp:gwco-secret',
      'ftp.client-b-secret.example.com',
      'client-b-deploy-user',
      'aiftp:client-b-secret',
      'new-client-secret-password',
    ];

    await writeSiteConfig(gwcoPath, {
      host: 'ftp.gwco-secret.example.com',
      user: 'gwco-deploy-user',
      keychainService: 'aiftp:gwco-secret',
      remoteRoot: '/gwco/public_html',
      localRoot: 'dist',
      serverKind: 'lolipop',
      port: 990,
      protocol: 'ftps',
      ftpsMode: 'implicit',
      passiveMode: false,
      encoding: 'shift_jis',
    });
    await writeSiteConfig(clientBPath, {
      host: 'ftp.client-b-secret.example.com',
      user: 'client-b-deploy-user',
      keychainService: 'aiftp:client-b-secret',
      remoteRoot: '/client-b/public_html',
      localRoot: 'public',
      serverKind: 'starserver',
    });
    await writeSiteConfig(unregisteredPath, {
      host: 'ftp.unregistered-secret.example.com',
      user: 'unregistered-deploy-user',
      keychainService: 'aiftp:unregistered-secret',
      remoteRoot: '/unregistered/public_html',
      localRoot: '.',
      serverKind: 'generic',
    });

    const entries: SiteEntry[] = [
      {
        name: 'gwco',
        label: 'example-corp.co.jp',
        path: gwcoPath,
        default_profile: 'production',
      },
      {
        name: 'client-b',
        label: 'client-b.example',
        path: clientBPath,
        default_profile: 'production',
      },
    ];
    const sites: CliOptions['sites'] = {
      createRegistry: () => fakeRegistry(entries),
      resolveSite: async (entry) => resolvedSite(entry),
    };

    cwd = root;
    await parse(['sites', 'list', '--json'], { sites });
    const listed = JSON.parse(stdout[0] ?? '[]') as ResolvedSite[];
    expect(listed.map((site) => site.name).sort()).toEqual(['client-b', 'gwco']);
    expect(listed.find((site) => site.name === 'gwco')).toMatchObject({
      label: 'example-corp.co.jp',
      default_profile: 'production',
      protocol: 'ftps',
      credentialsStatus: 'missing',
    });
    expectNoSecrets(stdout.join('\n'), secretNeedles);

    resetOutput();
    await parse(['sites', 'list'], { sites });
    expect(stdout.join('\n')).toContain('gwco');
    expect(stdout.join('\n')).toContain('client-b');
    expect(stdout.join('\n')).toContain('example-corp.co.jp');
    expectNoSecrets(stdout.join('\n'), secretNeedles);

    resetOutput();
    cwd = newSitePath;
    await mkdir(newSitePath, { recursive: true });
    const recordedInitials: Record<string, unknown> = {};
    const initPrompt: CliPrompt = async (questions) => {
      const first = Array.isArray(questions) ? questions[0] : questions;
      if (typeof first?.name === 'string') {
        const initial =
          typeof first.initial === 'function'
            ? first.initial({ profile: 'production' })
            : first.initial;
        recordedInitials[first.name] = initial;
      }
      return {
        profile: 'production',
        host: 'ftp.new-client.example.com',
        port: 990,
        protocol: 'ftps',
        user: 'new-client-deploy-user',
        remoteRoot: '/new-client/public_html',
        localRoot: 'build',
        keychainService: 'aiftp:new-client-production',
        serverKind: 'lolipop',
        ftpsMode: 'implicit',
        passiveMode: false,
        password: 'new-client-secret-password',
        consent: true,
        choice: 'Y',
        registerSite: false,
      };
    };
    await parse(['init', '--from', 'gwco'], { sites, prompt: initPrompt });
    const inheritedConfig = await loadConfig(join(newSitePath, '.aiftp.toml'));
    expect(recordedInitials).toMatchObject({
      port: 990,
      protocol: 'ftps',
      ftpsMode: 'implicit',
      passiveMode: false,
      serverKind: 'lolipop',
    });
    expect(recordedInitials.host).toBeUndefined();
    expect(recordedInitials.user).toBeUndefined();
    expect(recordedInitials.keychainService).not.toBe('aiftp:gwco-secret');
    expect(inheritedConfig.profile.production).toMatchObject({
      host: 'ftp.new-client.example.com',
      user: 'new-client-deploy-user',
      remote_root: '/new-client/public_html',
      local_root: 'build',
      keychain_service: 'aiftp:new-client-production',
      server_kind: 'lolipop',
      ftps_mode: 'implicit',
      passive_mode: false,
    });
    expect(inheritedConfig.profile.production?.host).not.toBe('ftp.gwco-secret.example.com');
    expect(inheritedConfig.profile.production?.user).not.toBe('gwco-deploy-user');
    expect(inheritedConfig.profile.production?.keychain_service).not.toBe('aiftp:gwco-secret');
    expect(inheritedConfig.encoding.file_name).toBe('shift_jis');
    expect(stored).toContainEqual({
      service: 'aiftp:new-client-production',
      account: 'new-client-deploy-user',
      password: 'new-client-secret-password',
    });

    resetOutput();
    cwd = gwcoPath;
    const pushResult: PushResult = {
      dryRun: false,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      uploaded: [
        {
          path: 'index.html',
          localPath: join(gwcoPath, 'index.html'),
          remotePath: '/gwco/public_html/index.html',
          size: 13,
          hash: 'new-hash',
        },
      ],
      backupSnapshot: null,
      nextState: { schema: 1, files: {} },
    };
    let pushCalls = 0;
    await parse(['push', '--profile', 'production', '--yes'], {
      sites,
      runtime: {
        runPush: async () => {
          pushCalls += 1;
          return pushResult;
        },
      },
    });
    expect(pushCalls).toBe(1);
    expect(destinationBannerLines()).toEqual([
      '⛳ 宛先: gwco (example-corp.co.jp)',
      '   ftps://production → /gwco/public_html   [server: lolipop]',
      '   local: dist',
    ]);
    expect(stdout.join('\n')).toContain('Uploaded 1 file(s)');
    expectNoSecrets(destinationBannerLines().join('\n'), secretNeedles);
    expectNoSecrets(stdout.join('\n'), secretNeedles);

    resetOutput();
    cwd = unregisteredPath;
    await parse(['push', '--profile', 'production', '--dry-run'], {
      sites,
      runtime: {
        runPush: async () => ({
          dryRun: true,
          diff: { added: [], modified: [], removed: [], unchanged: [] },
          planned: [],
          uploaded: [],
          backupSnapshot: null,
          nextState: { schema: 1, files: {} },
        }),
      },
    });
    expect(destinationBannerLines()[0]).toBe('⛳ 宛先: production');
    expectNoSecrets(destinationBannerLines().join('\n'), [
      'ftp.unregistered-secret.example.com',
      'unregistered-deploy-user',
      'aiftp:unregistered-secret',
    ]);

    resetOutput();
    cwd = gwcoPath;
    const rollbackResult: RollbackResult = {
      dryRun: true,
      snapshotId: '2026-07-07T00:00:00.000Z-auto-gwco',
      planned: ['index.html'],
      plannedDeletes: [],
      rolledBack: [],
      deleted: [],
      nextState: { schema: 1, files: {} },
      skipped: [],
    };
    let rollbackCalls = 0;
    await parse(['rollback', '--steps', '1', '--dry-run'], {
      sites,
      runtime: {
        runRollback: async () => {
          rollbackCalls += 1;
          return rollbackResult;
        },
      },
    });
    expect(rollbackCalls).toBe(1);
    expect(destinationBannerLines()).toEqual([
      '⛳ 宛先: gwco (example-corp.co.jp)',
      '   ftps://production → /gwco/public_html   [server: lolipop]',
      '   local: dist',
    ]);
    expect(stdout.join('\n')).toContain('Dry-run rollback to snapshot');
    expectNoSecrets(destinationBannerLines().join('\n'), secretNeedles);
    expectNoSecrets(stdout.join('\n'), secretNeedles);
  });
});
