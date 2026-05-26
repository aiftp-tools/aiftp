import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PushResult, type StatusResult, loadConfig } from '@aiftp-tools/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type CliBackupStore,
  type CliKeychain,
  type CliPrompt,
  type CliRuntime,
  VERSION,
  createCli,
  __test__parseSummaryChoice as parseSummaryChoice,
  __test__sanitizeFieldInput as sanitizeFieldInput,
} from './index.js';

// v0.10.4: ensure process.stdin.isTTY is true so init summary review does not abort
// during tests. Individual tests (e.g. #24 non-TTY) can override and restore via afterEach.
const __originalIsTTY = process.stdin.isTTY;
beforeAll(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});
afterAll(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: __originalIsTTY, configurable: true });
});

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
    // v0.10.4: default summary review choice to 'Y' so existing tests stay green.
    // Existing tests don't pass `choice`; the init field prompts ignore it.
    return async () =>
      'choice' in answers ? answers : { 'template-select': 'none', ...answers, choice: 'Y' };
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

  async function writeLocal(path: string, content: string): Promise<void> {
    const filePath = join(cwd, ...path.split('/'));
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }

  it('re-exports VERSION from core (semver shape)', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u);
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

  it('init with server_kind=starserver writes [quirks].tls_check_hostname = false and warns about it', async () => {
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');
    await parse(['init'], {
      prompt: prompt({
        profile: 'production',
        host: 'ftp.example.com',
        port: 21,
        protocol: 'ftps',
        user: 'deploy-user',
        remoteRoot: 'public_html',
        localRoot: '.',
        keychainService: 'aiftp:production',
        serverKind: 'starserver',
        password: 'secret-password',
        consent: true,
      }),
    });
    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).toMatch(/^schema = 2/u);
    expect(toml).toMatch(/\[quirks\]/);
    expect(toml).toMatch(/tls_check_hostname = false/);
    expect(stderr.join('\n')).toMatch(/star\.ne\.jp|tls_check_hostname|certificate/i);
  });

  it('init with server_kind=generic does NOT auto-disable tls_check_hostname', async () => {
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');
    await parse(['init'], {
      prompt: prompt({
        profile: 'production',
        host: 'ftp.example.com',
        port: 21,
        protocol: 'ftps',
        user: 'deploy-user',
        remoteRoot: 'public_html',
        localRoot: '.',
        keychainService: 'aiftp:production',
        serverKind: 'generic',
        password: 'secret-password',
        consent: true,
      }),
    });
    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).not.toMatch(/tls_check_hostname = false/);
  });

  it('init --template wordpress-swell writes SWELL hard-excludes to .aiftp.toml', async () => {
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');

    await parse(['init', '--template', 'wordpress-swell'], {
      prompt: prompt({
        profile: 'production',
        host: 'ftp.example.com',
        port: 21,
        protocol: 'ftps',
        user: 'deploy-user',
        remoteRoot: 'public_html',
        localRoot: '.',
        keychainService: 'aiftp:production',
        serverKind: 'generic',
        password: 'secret-password',
        consent: true,
      }),
    });

    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('[backup.hard_exclude]');
    expect(toml).toContain('wp-content/themes/swell-child/node_modules/**');
    expect(toml).toContain('wp-content/themes/swell-child/.cache/**');
    expect(toml).toContain('wp-content/ai1wm-backups/**');
    expect(toml).toContain('[safety]');
    expect(toml).toContain('prod_profile_patterns = ["main*", "*prod*", "*www*", "*-live"]');
    expect(toml).toContain('[preflight]');
    expect(toml).toContain('php_lint = true');
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.backup.hard_exclude.additional_patterns).toEqual(
      expect.arrayContaining(['wp-content/themes/swell-child/node_modules/**']),
    );
    expect(config.preflight.php_lint).toBe(true);
  });

  it('init --template static respects user-edited local_root (Phase 2-1 regression)', async () => {
    // The user's localRoot answer must win over the template default. The
    // previous implementation silently rewrote `local_root` to "dist" even
    // when the operator typed "build" in the summary review.
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');

    await parse(['init', '--template', 'static'], {
      prompt: prompt({
        profile: 'production',
        host: 'ftp.example.com',
        port: 21,
        protocol: 'ftps',
        user: 'deploy-user',
        remoteRoot: 'public_html',
        localRoot: 'build',
        keychainService: 'aiftp:production',
        serverKind: 'generic',
        password: 'secret-password',
        consent: true,
      }),
    });

    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('local_root = "build"');
    expect(toml).not.toMatch(/local_root = "dist"/);
  });

  it('init --template static writes local_root = "dist" when user accepts initial', async () => {
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');

    await parse(['init', '--template', 'static'], {
      prompt: prompt({
        profile: 'production',
        host: 'ftp.example.com',
        port: 21,
        protocol: 'ftps',
        user: 'deploy-user',
        remoteRoot: 'public_html',
        localRoot: 'dist',
        keychainService: 'aiftp:production',
        serverKind: 'generic',
        password: 'secret-password',
        consent: true,
      }),
    });

    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('local_root = "dist"');
  });

  it('init --template list outputs 7 id-description lines to stderr', async () => {
    await parse(['init', '--template', 'list']);

    const lines = stderr.filter((line) => line.length > 0);
    expect(lines).toHaveLength(7);
    expect(lines).toEqual([
      'wordpress-swell - WordPress with SWELL theme',
      'wordpress-lightning - WordPress with LIGHTNING (Vektor) theme',
      'wordpress-cocoon - WordPress with Cocoon theme',
      'wordpress-standard - WordPress (theme-agnostic baseline)',
      'static - Static site / Jamstack build output',
      'laravel - Laravel on shared hosting',
      'php-simple - Standalone PHP scripts (contact form, mini-API)',
    ]);
    expect(stdout).toEqual([]);
  });

  it('init --template invalid-name exits nonzero with unknown-template message', async () => {
    await expect(parse(['init', '--template', 'invalid-name'])).rejects.toMatchObject({
      exitCode: 1,
      code: 'aiftp.unknown-template',
    });
    expect(stderr.join('\n')).toMatch(/unknown-template.*invalid-name/i);
  });

  it('init without --template starts prompt flow with template-select as the first field', async () => {
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');
    const seenNames: string[] = [];
    const answers = {
      'template-select': 'none',
      profile: 'production',
      host: 'ftp.example.com',
      port: 21,
      protocol: 'ftps',
      user: 'deploy-user',
      remoteRoot: 'public_html',
      localRoot: '.',
      keychainService: 'aiftp:production',
      serverKind: 'generic',
      password: 'secret-password',
      consent: true,
      choice: 'Y',
    };
    const recordingPrompt: CliPrompt = async (questions) => {
      const first = Array.isArray(questions) ? questions[0] : questions;
      if (typeof first?.name === 'string') {
        seenNames.push(first.name);
      }
      return answers;
    };

    await parse(['init'], { prompt: recordingPrompt });

    expect(seenNames[0]).toBe('template-select');
  });

  it('init warns when remote_root starts with a leading "/" (shared-host gotcha)', async () => {
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');
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
    const warning = stderr.join('\n');
    expect(warning).toMatch(/remote_root.*\//i);
    expect(warning).toMatch(/shared host|leading.*\//i);
  });

  it('init does not warn when remote_root has no leading "/"', async () => {
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');
    await parse(['init'], {
      prompt: prompt({
        profile: 'production',
        host: 'ftp.example.com',
        port: 21,
        protocol: 'ftps',
        user: 'deploy-user',
        remoteRoot: 'public_html',
        localRoot: '.',
        keychainService: 'aiftp:production',
        serverKind: 'generic',
        password: 'secret-password',
        consent: true,
      }),
    });
    expect(stderr.join('\n')).not.toMatch(/remote_root/);
  });

  it('init refuses to overwrite existing config unless --force is passed', async () => {
    await writeConfig();

    await expect(parse(['init'], { prompt: prompt({ consent: true }) })).rejects.toThrow(
      '.aiftp.toml already exists',
    );
  });

  it('init rejects -Infinity port (F-X7 / v0.10.2 regression guard)', async () => {
    // v0.11 (Pillar α): PromptFlow.validate rejects -Infinity at the prompt
    // boundary and re-prompts. A stuck mock that returns the same invalid
    // value forever trips the 100-iteration safety cap and surfaces as
    // "init cancelled" — preserving the original guarantee that the bad
    // port never reaches parseInitAnswers or the keychain.
    await expect(
      parse(['init'], {
        prompt: prompt({
          profile: 'production',
          host: 'ftp.example.com',
          port: Number.NEGATIVE_INFINITY,
          protocol: 'ftps',
          user: 'deploy-user',
          remoteRoot: '/public_html',
          localRoot: '.',
          keychainService: 'aiftp:production',
          serverKind: 'lolipop',
          password: 'secret-password',
          consent: true,
        }),
      }),
    ).rejects.toThrow(/init cancelled/);
  });

  it('init prompts to confirm non-standard FTPS port and proceeds when confirmed (v0.10.3)', async () => {
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');
    await parse(['init'], {
      prompt: prompt({
        profile: 'production',
        host: 'ftp.example.com',
        port: 8021,
        protocol: 'ftps',
        user: 'deploy-user',
        remoteRoot: '/public_html',
        localRoot: '.',
        keychainService: 'aiftp:production',
        serverKind: 'generic',
        password: 'secret-password',
        consent: true,
        confirmNonStandard: true,
      }),
    });
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.port).toBe(8021);
  });

  it('init aborts when non-standard port confirmation is declined (v0.10.3)', async () => {
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');
    await expect(
      parse(['init'], {
        prompt: prompt({
          profile: 'production',
          host: 'ftp.example.com',
          port: 8021,
          protocol: 'ftps',
          user: 'deploy-user',
          remoteRoot: '/public_html',
          localRoot: '.',
          keychainService: 'aiftp:production',
          serverKind: 'generic',
          password: 'secret-password',
          consent: true,
          confirmNonStandard: false,
        }),
      }),
    ).rejects.toThrow(/non-standard.*port.*not confirmed/i);
  });

  it('init does not prompt for confirmation on standard FTPS port 990 (v0.10.3)', async () => {
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');
    await parse(['init'], {
      prompt: prompt({
        profile: 'production',
        host: 'ftp.example.com',
        port: 990,
        protocol: 'ftps',
        user: 'deploy-user',
        remoteRoot: '/public_html',
        localRoot: '.',
        keychainService: 'aiftp:production',
        serverKind: 'generic',
        password: 'secret-password',
        consent: true,
        // No confirmNonStandard — must not be needed
      }),
    });
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.port).toBe(990);
  });

  it('init prompts to confirm FTPS port 990 over plain FTP (only 21 is standard for FTP) (v0.10.3)', async () => {
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');
    await expect(
      parse(['init'], {
        prompt: prompt({
          profile: 'production',
          host: 'ftp.example.com',
          port: 990,
          protocol: 'ftp',
          user: 'deploy-user',
          remoteRoot: '/public_html',
          localRoot: '.',
          keychainService: 'aiftp:production',
          serverKind: 'generic',
          password: 'secret-password',
          consent: true,
          confirmNonStandard: false,
        }),
      }),
    ).rejects.toThrow(/non-standard FTP port 990/i);
  });

  it('init rejects port outside 1-65535 range (F-X7)', async () => {
    // v0.11 (Pillar α): out-of-range ports are rejected at the PromptFlow
    // validate boundary; a stuck mock returning 70000 forever trips the
    // 100-iteration cap and surfaces as "init cancelled". The guarantee
    // that the bad port never reaches parseInitAnswers or the keychain
    // is preserved.
    await expect(
      parse(['init'], {
        prompt: prompt({
          profile: 'production',
          host: 'ftp.example.com',
          port: 70000,
          protocol: 'ftps',
          user: 'deploy-user',
          remoteRoot: '/public_html',
          localRoot: '.',
          keychainService: 'aiftp:production',
          serverKind: 'lolipop',
          password: 'secret-password',
          consent: true,
        }),
      }),
    ).rejects.toThrow(/init cancelled/);
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
      if (first?.name === 'template-select') return { 'template-select': 'none' };
      if (first?.name === 'overwriteBackupKey') return { overwriteBackupKey: true };
      // v0.10.4: summary review prompt
      if (first?.name === 'choice') return { choice: 'Y' };
      return answers;
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

    await parse(['push', '--profile', 'production', '--yes'], {
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

  it('push --dry-run text output separates upload and delete counts', async () => {
    await writeConfig({ deletionPolicy: 'prune-auto' });
    const pushResult: PushResult = {
      dryRun: true,
      diff: { added: ['index.html'], modified: [], removed: ['old.html'], unchanged: [] },
      planned: ['index.html'],
      plannedDeletes: ['old.html'],
      uploaded: [],
      deleted: [],
      backupSnapshot: null,
      nextState: { schema: 1, files: {} },
    };

    await parse(['push', '--profile', 'production', '--dry-run'], {
      runtime: {
        runPush: async () => pushResult,
      },
    });

    expect(stdout.join('\n')).toContain('Planned 1 upload(s), 1 delete(s)');
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

  it('push --dry-run does not require an initialized backup key', async () => {
    await writeConfig();
    await writeLocal('index.html', '<h1>new</h1>\n');

    await parse(['push', '--profile', 'production', '--dry-run', '--json'], {
      keychain: {
        ...keychain(),
        getPassword: async (service, account) => {
          throw new Error(`unexpected keychain read: ${service}:${account}`);
        },
      },
    });

    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      dryRun: true,
      planned: ['index.html'],
    });
  });

  it('push prints the target banner to stderr before any FTP activity (v0.6.0 #7)', async () => {
    await writeConfig();
    await writeLocal('index.html', '<h1>new</h1>\n');
    // dry-run sidesteps the prod confirmation prompt — we just want to
    // observe the banner.
    await parse(['push', '--profile', 'production', '--dry-run']);
    const banner = stderr.join('\n');
    expect(banner).toMatch(/push target.*profile=production/);
    expect(banner).toMatch(/host=ftp\.example\.com/);
    expect(banner).toMatch(/remote_root=\/public_html/);
  });

  it('push refuses on a production-pattern profile when the typed confirmation is wrong', async () => {
    // Real push (no --dry-run) on `production` → confirmation prompt
    // fires. Prompt returns the WRONG string → abort.
    await writeConfig();
    await writeLocal('index.html', '<h1>new</h1>\n');
    const runtime: CliRuntime = {
      runPush: async () => {
        throw new Error('runPush should not be reached when confirmation fails');
      },
    };
    await expect(
      parse(['push', '--profile', 'production'], {
        runtime,
        prompt: prompt({ confirmation: 'productio' }), // typo
      }),
    ).rejects.toThrow(/Production push aborted|did not match/i);
  });

  it('push --yes bypasses the production confirmation prompt', async () => {
    await writeConfig();
    await writeLocal('index.html', '<h1>new</h1>\n');
    const realResult: PushResult = {
      dryRun: false,
      diff: { added: ['index.html'], modified: [], removed: [], unchanged: [] },
      planned: ['index.html'],
      uploaded: [
        {
          path: 'index.html',
          localPath: 'x',
          remotePath: '/public_html/index.html',
          size: 12,
          hash: 'h',
        },
      ],
      backupSnapshot: null,
      nextState: { schema: 1, files: {} },
    };
    await parse(['push', '--profile', 'production', '--yes'], {
      runtime: { runPush: async () => realResult },
    });
    expect(stdout.join('\n')).toContain('Uploaded 1 file(s)');
  });

  it('push prune-with-confirm requires typed delete confirmation before mutation', async () => {
    await writeConfig({ deletionPolicy: 'prune-with-confirm', warnOnProdProfile: false });
    const calls: Array<{ dryRun?: boolean; confirmDeletes?: boolean }> = [];
    const dryRunResult: PushResult = {
      dryRun: true,
      diff: { added: [], modified: [], removed: ['old.html'], unchanged: [] },
      planned: [],
      plannedDeletes: ['old.html'],
      uploaded: [],
      deleted: [],
      backupSnapshot: null,
      nextState: { schema: 1, files: {} },
    };
    const realResult: PushResult = {
      ...dryRunResult,
      dryRun: false,
      deleted: [{ path: 'old.html', remotePath: '/public_html/old.html' }],
    };

    await expect(
      parse(['push', '--profile', 'production'], {
        prompt: prompt({ deleteConfirmation: 'NOPE' }),
        runtime: {
          runPush: async (opts) => {
            calls.push({ dryRun: opts.dryRun, confirmDeletes: opts.confirmDeletes });
            return opts.dryRun ? dryRunResult : realResult;
          },
        },
      }),
    ).rejects.toThrow(/delete confirmation|aborted/i);
    expect(calls).toEqual([{ dryRun: true, confirmDeletes: undefined }]);

    calls.length = 0;
    await parse(['push', '--profile', 'production'], {
      prompt: prompt({ deleteConfirmation: 'DELETE' }),
      runtime: {
        runPush: async (opts) => {
          calls.push({ dryRun: opts.dryRun, confirmDeletes: opts.confirmDeletes });
          return opts.dryRun ? dryRunResult : realResult;
        },
      },
    });

    expect(calls).toEqual([
      { dryRun: true, confirmDeletes: undefined },
      { dryRun: false, confirmDeletes: true },
    ]);
    expect(stdout.join('\n')).toContain('Uploaded 0 file(s), deleted 1 file(s)');
  });

  it('push --dry-run never triggers the production confirmation gate', async () => {
    // Pre-deploy dry-runs are routine and should be friction-less. The
    // confirmation gate is only a guard for actual uploads.
    await writeConfig();
    await writeLocal('index.html', '<h1>new</h1>\n');
    const calledPrompt: string[] = [];
    await parse(['push', '--profile', 'production', '--dry-run'], {
      prompt: (q) => {
        calledPrompt.push(String(q.name));
        return Promise.resolve({});
      },
    });
    // No prompt should have been issued.
    expect(calledPrompt).toEqual([]);
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
          id: '2026-05-18T12-00-00-000Z-auto-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
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

    const validId = '2026-05-18T12-00-00-000Z-auto-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await parse(['backup', 'list', '--profile', 'production'], { runtime });
    await parse(['backup', 'verify', validId, '--profile', 'production'], { runtime });
    await parse(['backup', 'prune', '--keep', '1', '--profile', 'production'], { runtime });
    await parse(
      [
        'backup',
        'restore',
        validId,
        'index.html',
        '--output',
        'restored/index.html',
        '--profile',
        'production',
      ],
      { runtime },
    );

    expect(stdout).toContain(`${validId} auto 2026-05-18T12:00:00.000Z files=1 bytes=18`);
    expect(stdout).toContain(`${validId} ok checked=1`);
    expect(stdout).toContain('Pruned 1 snapshot(s)');
    expect(await readFile(join(cwd, 'restored', 'index.html'), 'utf8')).toBe('<h1>restored</h1>\n');
  });

  it('backup prune rejects non-numeric --keep values with a clear error', async () => {
    await expect(parse(['backup', 'prune', '--keep', 'abc'])).rejects.toThrow(
      '--keep must be a non-negative integer',
    );
  });

  it('backup restore rejects an empty snapshot id', async () => {
    await writeConfig();
    const fakeStore: CliBackupStore = {
      listSnapshots: async () => [],
      verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
      prune: async () => [],
      restoreFile: async () => {
        throw new Error('should not be called');
      },
    };
    await expect(
      parse(['backup', 'restore', '', 'index.html', '--output', 'restored.html'], {
        runtime: { createBackupStore: async () => fakeStore },
      }),
    ).rejects.toThrow(/snapshot id is required/i);
  });

  it('backup restore rejects a whitespace-only snapshot id', async () => {
    await writeConfig();
    const fakeStore: CliBackupStore = {
      listSnapshots: async () => [],
      verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
      prune: async () => [],
      restoreFile: async () => {
        throw new Error('should not be called');
      },
    };
    await expect(
      parse(['backup', 'restore', '   ', 'index.html', '--output', 'restored.html'], {
        runtime: { createBackupStore: async () => fakeStore },
      }),
    ).rejects.toThrow(/snapshot id is required/i);
  });

  it('backup restore rejects a malformed snapshot id', async () => {
    await writeConfig();
    const fakeStore: CliBackupStore = {
      listSnapshots: async () => [],
      verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
      prune: async () => [],
      restoreFile: async () => {
        throw new Error('should not be called');
      },
    };
    await expect(
      parse(['backup', 'restore', '../etc/passwd', 'index.html', '--output', 'restored.html'], {
        runtime: { createBackupStore: async () => fakeStore },
      }),
    ).rejects.toThrow(/invalid snapshot id/i);
  });

  it('backup restore rejects an --output path outside the project root', async () => {
    await writeConfig();
    const restored = Buffer.from('<h1>restored</h1>\n', 'utf8');
    const fakeStore: CliBackupStore = {
      listSnapshots: async () => [],
      verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
      prune: async () => [],
      restoreFile: async () => restored,
    };
    await expect(
      parse(
        [
          'backup',
          'restore',
          '2026-05-18T12-00-00-000Z-auto-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'index.html',
          '--output',
          '../escape.html',
        ],
        { runtime: { createBackupStore: async () => fakeStore } },
      ),
    ).rejects.toThrow(/--output.*(outside|project root)/i);
  });

  it('backup restore refuses to overwrite an existing output without --force', async () => {
    await writeConfig();
    const existing = join(cwd, 'already-there.html');
    await writeFile(existing, 'pre-existing content', 'utf8');
    const restored = Buffer.from('<h1>restored</h1>\n', 'utf8');
    const fakeStore: CliBackupStore = {
      listSnapshots: async () => [],
      verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
      prune: async () => [],
      restoreFile: async () => restored,
    };
    await expect(
      parse(
        [
          'backup',
          'restore',
          '2026-05-18T12-00-00-000Z-auto-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'index.html',
          '--output',
          'already-there.html',
        ],
        { runtime: { createBackupStore: async () => fakeStore } },
      ),
    ).rejects.toThrow(/already exists.*--force/i);
    expect(await readFile(existing, 'utf8')).toBe('pre-existing content');
  });

  it('backup restore overwrites an existing output when --force is set', async () => {
    await writeConfig();
    const existing = join(cwd, 'replaced.html');
    await writeFile(existing, 'pre-existing content', 'utf8');
    const restored = Buffer.from('<h1>restored</h1>\n', 'utf8');
    const fakeStore: CliBackupStore = {
      listSnapshots: async () => [],
      verify: async () => ({ ok: true, checkedFiles: 0, errors: [] }),
      prune: async () => [],
      restoreFile: async () => restored,
    };
    await parse(
      [
        'backup',
        'restore',
        '2026-05-18T12-00-00-000Z-auto-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'index.html',
        '--output',
        'replaced.html',
        '--force',
      ],
      { runtime: { createBackupStore: async () => fakeStore } },
    );
    expect(await readFile(existing, 'utf8')).toBe('<h1>restored</h1>\n');
  });

  it('config migrate --dry-run previews the v1->v2 diff without writing to disk', async () => {
    const v1Source = [
      'schema = 1',
      '',
      '[profile.production]',
      'host = "ftp.example.com"',
      'user = "deploy"',
      'remote_root = "/public_html"',
      'local_root = "."',
      'keychain_service = "aiftp:production"',
      '',
    ].join('\n');
    await writeFile(join(cwd, '.aiftp.toml'), v1Source, 'utf8');

    await parse(['config', 'migrate', '--dry-run']);

    const out = stdout.join('\n');
    expect(out).toMatch(/dry-run/i);
    expect(out).toMatch(/schema = 1.*->.*schema = 2|schema:\s*1\s*->\s*2/u);
    expect(out).toMatch(/\[encoding\]/u);
    expect(out).toMatch(/\[quirks\]/u);
    // Original file untouched. No .bak written.
    expect(await readFile(join(cwd, '.aiftp.toml'), 'utf8')).toBe(v1Source);
    await expect(readFile(join(cwd, '.aiftp.toml.v1.bak'), 'utf8')).rejects.toThrow();
  });

  it('config migrate (no --dry-run) migrates the file and creates the .v1.bak', async () => {
    const v1Source = [
      'schema = 1',
      '',
      '[profile.production]',
      'host = "ftp.example.com"',
      'user = "deploy"',
      'remote_root = "/public_html"',
      'local_root = "."',
      'keychain_service = "aiftp:production"',
      '',
    ].join('\n');
    await writeFile(join(cwd, '.aiftp.toml'), v1Source, 'utf8');

    await parse(['config', 'migrate']);

    const onDisk = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(onDisk).toMatch(/^schema = 2/u);
    expect(await readFile(join(cwd, '.aiftp.toml.v1.bak'), 'utf8')).toBe(v1Source);
    expect(stdout.join('\n')).toMatch(/migrated/i);
  });

  it('config migrate reports "already at latest" when the file is already v2', async () => {
    await writeFile(
      join(cwd, '.aiftp.toml'),
      [
        'schema = 2',
        '',
        '[profile.production]',
        'host = "ftp.example.com"',
        'user = "deploy"',
        'remote_root = "/public_html"',
        'local_root = "."',
        'keychain_service = "aiftp:production"',
        '',
      ].join('\n'),
      'utf8',
    );

    await parse(['config', 'migrate']);

    expect(stdout.join('\n')).toMatch(/already.*latest|schema = 2/i);
    await expect(readFile(join(cwd, '.aiftp.toml.v1.bak'), 'utf8')).rejects.toThrow();
  });

  it('doctor reports a summary line in human format when checks pass', async () => {
    await writeConfig();
    await writeFile(join(cwd, '.gitignore'), 'node_modules/\n.aiftp/\n', 'utf8');
    const runtime: CliRuntime = {
      runDoctor: async (context) => ({
        ok: true,
        results: [
          {
            id: 'config-file',
            title: '.aiftp.toml',
            status: 'pass',
            message: 'schema=2',
          },
        ],
        summary: { pass: 1, warn: 0, fail: 0, skip: 0 },
        context,
      }),
    };
    await parse(['doctor', '--profile', 'production'], { runtime });
    const out = stdout.join('\n');
    expect(out).toMatch(/pass=1/);
    expect(out).toMatch(/fail=0/);
    expect(out).toMatch(/config-file.*pass/);
  });

  it('doctor --json emits the raw DoctorReport on stdout', async () => {
    await writeConfig();
    const runtime: CliRuntime = {
      runDoctor: async () => ({
        ok: false,
        results: [
          {
            id: 'config-file',
            title: '.aiftp.toml',
            status: 'fail',
            message: 'missing',
            recommendation: 'Run aiftp init.',
          },
        ],
        summary: { pass: 0, warn: 0, fail: 1, skip: 0 },
      }),
    };
    await parse(['doctor', '--profile', 'production', '--json'], { runtime });
    const json = JSON.parse(stdout.join('\n'));
    expect(json.ok).toBe(false);
    expect(json.summary.fail).toBe(1);
    expect(json.results[0].id).toBe('config-file');
  });

  it('doctor exits with a non-zero code when any check fails', async () => {
    await writeConfig();
    const runtime: CliRuntime = {
      runDoctor: async () => ({
        ok: false,
        results: [
          {
            id: 'keychain',
            title: 'Keychain',
            status: 'fail',
            message: 'missing entry',
          },
        ],
        summary: { pass: 0, warn: 0, fail: 1, skip: 0 },
      }),
    };
    await expect(parse(['doctor', '--profile', 'production'], { runtime })).rejects.toThrow(
      /diagnostic.*failed|fail/i,
    );
  });

  it('import filezilla --dry-run lists profiles without writing anything', async () => {
    await writeConfig();
    const xml = [
      '<?xml version="1.0"?>',
      '<FileZilla3>',
      '<Servers>',
      '<Server>',
      '<Host>ftp.example.com</Host>',
      '<Port>21</Port>',
      '<Protocol>4</Protocol>',
      '<User>deploy</User>',
      '<Pass encoding="base64">cGFzcw==</Pass>',
      '<Logontype>1</Logontype>',
      '<Name>Imported Site</Name>',
      '<RemoteDir>1 0 11 public_html</RemoteDir>',
      '</Server>',
      '</Servers>',
      '</FileZilla3>',
    ].join('\n');
    const xmlPath = join(cwd, 'sitemanager.xml');
    await writeFile(xmlPath, xml, 'utf8');
    const beforeToml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');

    await parse(['import', 'filezilla', xmlPath, '--dry-run']);

    const out = stdout.join('\n');
    expect(out).toMatch(/dry-run/i);
    expect(out).toMatch(/imported-site/);
    expect(out).toMatch(/ftp\.example\.com/);
    // Password must be redacted in CLI output.
    expect(out).not.toMatch(/pass\b.*encoded\b.*[^*]/i);
    expect(out).not.toContain('cGFzcw==');
    // Nothing written.
    expect(await readFile(join(cwd, '.aiftp.toml'), 'utf8')).toBe(beforeToml);
    expect(stored).toEqual([]);
  });

  it('import filezilla adds a new profile to .aiftp.toml and stores the password in Keychain', async () => {
    await writeConfig();
    const xml = [
      '<?xml version="1.0"?>',
      '<FileZilla3>',
      '<Servers>',
      '<Server>',
      '<Host>ftp.example.com</Host>',
      '<Port>21</Port>',
      '<Protocol>4</Protocol>',
      '<User>deploy</User>',
      '<Pass encoding="base64">cGFzcw==</Pass>',
      '<Logontype>1</Logontype>',
      '<Name>Imported Site</Name>',
      '<RemoteDir>1 0 11 public_html</RemoteDir>',
      '</Server>',
      '</Servers>',
      '</FileZilla3>',
    ].join('\n');
    const xmlPath = join(cwd, 'sitemanager.xml');
    await writeFile(xmlPath, xml, 'utf8');

    await parse(['import', 'filezilla', xmlPath]);

    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('[profile.imported-site]');
    expect(toml).toContain('host = "ftp.example.com"');
    expect(toml).not.toContain('password'); // never written
    expect(toml).not.toContain('cGFzcw==');
    expect(stored).toContainEqual({
      service: expect.stringMatching(/aiftp:imported/),
      account: 'deploy',
      password: 'pass',
    });
  });

  it('import filezilla --skip (default) leaves existing profiles untouched on name conflict', async () => {
    await writeConfig(); // already has [profile.production]
    const xml = [
      '<?xml version="1.0"?>',
      '<FileZilla3><Servers><Server>',
      '<Host>conflict.example.com</Host>',
      '<Port>21</Port>',
      '<Protocol>0</Protocol>',
      '<User>other</User>',
      '<Pass encoding="base64">b3RoZXI=</Pass>',
      '<Logontype>1</Logontype>',
      '<Name>production</Name>',
      '<RemoteDir>1 0 4 root</RemoteDir>',
      '</Server></Servers></FileZilla3>',
    ].join('\n');
    const xmlPath = join(cwd, 'sm.xml');
    await writeFile(xmlPath, xml, 'utf8');

    await parse(['import', 'filezilla', xmlPath]);

    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    // production stayed untouched
    expect(config.profile.production?.host).toBe('ftp.example.com');
    expect(stdout.join('\n')).toMatch(/skipped.*production|conflict.*skip/i);
  });

  it('import filezilla --overwrite replaces an existing profile of the same name', async () => {
    await writeConfig();
    const xml = [
      '<?xml version="1.0"?>',
      '<FileZilla3><Servers><Server>',
      '<Host>new-host.example.com</Host>',
      '<Port>21</Port>',
      '<Protocol>0</Protocol>',
      '<User>overwriter</User>',
      '<Pass encoding="base64">b3Y=</Pass>',
      '<Logontype>1</Logontype>',
      '<Name>production</Name>',
      '<RemoteDir>1 0 4 root</RemoteDir>',
      '</Server></Servers></FileZilla3>',
    ].join('\n');
    const xmlPath = join(cwd, 'sm.xml');
    await writeFile(xmlPath, xml, 'utf8');

    await parse(['import', 'filezilla', xmlPath, '--overwrite']);

    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.host).toBe('new-host.example.com');
    expect(config.profile.production?.user).toBe('overwriter');
  });

  it('import filezilla imports SFTP entries (Protocol=1) as protocol="sftp" with port 22 (v0.11 Pillar γ)', async () => {
    await writeConfig();
    const xml = [
      '<?xml version="1.0"?>',
      '<FileZilla3><Servers><Server>',
      '<Host>sftp.example.com</Host>',
      '<Port>22</Port>',
      '<Protocol>1</Protocol>',
      '<User>sftp</User>',
      '<Pass encoding="base64">cw==</Pass>',
      '<Logontype>1</Logontype>',
      '<Name>SFTP Box</Name>',
      '<RemoteDir>1 0 4 root</RemoteDir>',
      '</Server></Servers></FileZilla3>',
    ].join('\n');
    const xmlPath = join(cwd, 'sm.xml');
    await writeFile(xmlPath, xml, 'utf8');

    await parse(['import', 'filezilla', xmlPath]);

    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('[profile.sftp-box]');
    expect(toml).toContain('protocol = "sftp"');
    expect(toml).toContain('port = 22');
    expect(toml).toContain('host = "sftp.example.com"');
    // ftps_mode is FTPS-only and must NOT appear on an SFTP profile.
    const sftpBlockMatch = toml.match(/\[profile\.sftp-box\][\s\S]*?(?=\[profile\.|$)/u);
    expect(sftpBlockMatch?.[0]).not.toMatch(/ftps_mode/);
  });

  it('import filezilla refuses to write master-password-encrypted entries and warns the operator', async () => {
    await writeConfig();
    const xml = [
      '<?xml version="1.0"?>',
      '<FileZilla3><Servers><Server>',
      '<Host>ftp.example.com</Host>',
      '<Port>21</Port>',
      '<Protocol>4</Protocol>',
      '<User>locked</User>',
      '<Pass encoding="crypt" pubkey="ABC">BLOB</Pass>',
      '<Logontype>1</Logontype>',
      '<Name>Locked Box</Name>',
      '<RemoteDir>1 0 4 root</RemoteDir>',
      '</Server></Servers></FileZilla3>',
    ].join('\n');
    const xmlPath = join(cwd, 'sm.xml');
    await writeFile(xmlPath, xml, 'utf8');

    await parse(['import', 'filezilla', xmlPath]);

    const out = stdout.join('\n');
    expect(out).toMatch(/master password|encrypted/i);
    // No Keychain write for unrecoverable passwords.
    expect(stored.find((s) => s.account === 'locked')).toBeUndefined();
  });

  it('profile export filezilla writes FileZilla XML covering all configured profiles by default', async () => {
    await writeConfig();
    const outPath = join(cwd, 'exported.xml');

    await parse(['profile', 'export', 'filezilla', '-o', outPath]);

    const xml = await readFile(outPath, 'utf8');
    expect(xml).toContain('<FileZilla3');
    expect(xml).toContain('<Host>ftp.example.com</Host>');
    expect(xml).toContain('<User>deploy-user</User>');
    expect(xml).toContain('<Name>production</Name>');
    // Default: no password leakage.
    expect(xml).not.toContain('Pass>password');
    expect(stdout.join('\n')).toMatch(/wrote.*exported\.xml|exported 1 profile/);
  });

  it('profile export filezilla --profile <name> restricts the export to one profile', async () => {
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
        '[profile.staging]',
        'host = "ftp.staging.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "stage-user"',
        'remote_root = "/staging"',
        'local_root = "."',
        'keychain_service = "aiftp:staging"',
        'server_kind = "generic"',
        '',
      ].join('\n'),
      'utf8',
    );
    const outPath = join(cwd, 'one.xml');

    await parse(['profile', 'export', 'filezilla', '--profile', 'staging', '-o', outPath]);

    const xml = await readFile(outPath, 'utf8');
    expect(xml).toContain('<Host>ftp.staging.example.com</Host>');
    expect(xml).not.toContain('ftp.example.com');
  });

  it('profile export filezilla --include-password fetches credentials from Keychain', async () => {
    await writeConfig();
    const outPath = join(cwd, 'with-pass.xml');
    const credentials = new Set(['aiftp:production:deploy-user']);

    await parse(['profile', 'export', 'filezilla', '-o', outPath, '--include-password'], {
      keychain: keychain(credentials),
    });

    const xml = await readFile(outPath, 'utf8');
    expect(xml).toMatch(/<Pass encoding="base64">[A-Za-z0-9+/=]+<\/Pass>/);
    expect(stdout.join('\n')).toMatch(/include-password|sensitive/i);
  });

  it('profile export filezilla refuses to write outside the project root', async () => {
    await writeConfig();
    await expect(parse(['profile', 'export', 'filezilla', '-o', '../escape.xml'])).rejects.toThrow(
      /outside.*project root|--output/i,
    );
  });

  // ---------------------------------------------------------------------
  // v0.4 PR #17: aiftp profile <subcommand>
  // ---------------------------------------------------------------------

  async function writeMultiProfileConfig(): Promise<void> {
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
        '[profile.staging]',
        'host = "stg.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "stage"',
        'remote_root = "/stage"',
        'local_root = "."',
        'keychain_service = "aiftp:staging"',
        'server_kind = "generic"',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  it('profile list prints every configured profile (default text format)', async () => {
    await writeMultiProfileConfig();
    await parse(['profile', 'list'], {
      keychain: keychain(new Set(['aiftp:production:deploy', 'aiftp:staging:stage'])),
    });
    const out = stdout.join('\n');
    expect(out).toContain('production');
    expect(out).toContain('staging');
    expect(out).toContain('ftp.example.com');
    expect(out).toContain('stg.example.com');
  });

  it('profile list --json emits a structured payload with credentialsPresent and isDefault', async () => {
    await writeMultiProfileConfig();
    await parse(['profile', 'list', '--json'], {
      keychain: keychain(new Set(['aiftp:production:deploy'])),
    });
    const payload = JSON.parse(stdout.join('\n'));
    expect(Array.isArray(payload.profiles)).toBe(true);
    expect(payload.profiles).toHaveLength(2);
    const prod = payload.profiles.find((p: { name: string }) => p.name === 'production');
    const stg = payload.profiles.find((p: { name: string }) => p.name === 'staging');
    expect(prod).toMatchObject({
      name: 'production',
      host: 'ftp.example.com',
      credentialsPresent: true,
    });
    expect(stg).toMatchObject({
      name: 'staging',
      credentialsPresent: false,
    });
  });

  it('profile current reports null when no default is pinned and multiple profiles exist', async () => {
    await writeMultiProfileConfig();
    await parse(['profile', 'current']);
    expect(stdout.join('\n')).toMatch(/no default profile pinned|ambiguous/i);
  });

  it('profile use <name> persists the default and profile current reflects it', async () => {
    await writeMultiProfileConfig();
    await parse(['profile', 'use', 'staging']);
    expect(stdout.join('\n')).toMatch(/staging/);

    stdout.length = 0;
    await parse(['profile', 'current']);
    expect(stdout.join('\n')).toContain('staging');
  });

  it('profile use rejects a name that is not in the config', async () => {
    await writeMultiProfileConfig();
    await expect(parse(['profile', 'use', 'does-not-exist'])).rejects.toThrow(
      /not found|not defined/i,
    );
  });

  it('profile add <name> appends a new [profile.NAME] block and stores the password in Keychain', async () => {
    await writeMultiProfileConfig();
    await parse(['profile', 'add', 'demo'], {
      prompt: prompt({
        host: 'demo.example.com',
        port: 21,
        protocol: 'ftps',
        user: 'demo',
        remoteRoot: '/demo',
        localRoot: '.',
        keychainService: 'aiftp:demo',
        serverKind: 'generic',
        password: 'demo-pw',
      }),
    });
    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('[profile.demo]');
    expect(toml).toContain('host = "demo.example.com"');
    expect(toml).not.toContain('demo-pw');
    expect(stored).toContainEqual({
      service: 'aiftp:demo',
      account: 'demo',
      password: 'demo-pw',
    });
  });

  it('profile add rejects invalid profile names', async () => {
    await writeMultiProfileConfig();
    await expect(parse(['profile', 'add', 'Bad Name!'])).rejects.toThrow(/invalid profile name/i);
  });

  it('profile add rejects duplicate names', async () => {
    await writeMultiProfileConfig();
    await expect(parse(['profile', 'add', 'production'])).rejects.toThrow(/already exists/i);
  });

  it('profile edit <name> replaces a single field via interactive prompt', async () => {
    await writeMultiProfileConfig();
    await parse(['profile', 'edit', 'production'], {
      prompt: prompt({ field: 'host', value: 'new.example.com' }),
    });
    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('host = "new.example.com"');
    expect(toml).not.toContain('host = "ftp.example.com"');
    // Other fields preserved
    expect(toml).toContain('user = "deploy"');
    expect(toml).toContain('keychain_service = "aiftp:production"');
  });

  it('profile rename <old> <new> moves Keychain entries and updates the TOML', async () => {
    await writeMultiProfileConfig();
    await parse(['profile', 'rename', 'staging', 'staging-v2'], {
      keychain: keychain(new Set(['aiftp:staging:stage', 'aiftp:staging:backup-key:staging'])),
    });
    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('[profile.staging-v2]');
    expect(toml).not.toContain('[profile.staging]');
    // Keychain follow: the new service was written, the old one was deleted.
    expect(stored.find((s) => s.service.includes('staging-v2'))).toBeDefined();
    expect(deleted.find((d) => d.service === 'aiftp:staging')).toBeDefined();
  });

  it('profile rename rejects an invalid destination name', async () => {
    await writeMultiProfileConfig();
    await expect(parse(['profile', 'rename', 'staging', 'BAD NAME'])).rejects.toThrow(
      /invalid profile name/i,
    );
  });

  it('profile rename rejects when destination already exists', async () => {
    await writeMultiProfileConfig();
    await expect(parse(['profile', 'rename', 'staging', 'production'])).rejects.toThrow(
      /already exists/i,
    );
  });

  it('profile duplicate <src> <new> clones the config block but DOES NOT copy credentials by default', async () => {
    await writeMultiProfileConfig();
    await parse(['profile', 'duplicate', 'production', 'production-clone'], {
      keychain: keychain(new Set(['aiftp:production:deploy'])),
    });
    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('[profile.production-clone]');
    expect(toml).toContain('host = "ftp.example.com"');
    // No Keychain write: stored should not contain a production-clone entry.
    expect(stored.find((s) => s.service.includes('production-clone'))).toBeUndefined();
    expect(stdout.join('\n')).toMatch(/auth set.*production-clone/);
  });

  it('profile duplicate --copy-credentials copies Keychain entries to the new profile', async () => {
    await writeMultiProfileConfig();
    await parse(['profile', 'duplicate', 'production', 'production-clone', '--copy-credentials'], {
      keychain: keychain(new Set(['aiftp:production:deploy'])),
    });
    expect(stored.find((s) => s.service.includes('production-clone'))).toBeDefined();
  });

  it('profile remove <name> with --yes deletes the block AND Keychain entries by default', async () => {
    await writeMultiProfileConfig();
    await parse(['profile', 'remove', 'staging', '--yes'], {
      keychain: keychain(new Set(['aiftp:staging:stage', 'aiftp:staging:backup-key:staging'])),
    });
    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).not.toContain('[profile.staging]');
    expect(deleted.find((d) => d.service === 'aiftp:staging')).toBeDefined();
  });

  it('profile remove --yes --keep-credentials removes the block but preserves Keychain entries', async () => {
    await writeMultiProfileConfig();
    await parse(['profile', 'remove', 'staging', '--yes', '--keep-credentials'], {
      keychain: keychain(new Set(['aiftp:staging:stage'])),
    });
    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).not.toContain('[profile.staging]');
    expect(deleted.find((d) => d.service === 'aiftp:staging')).toBeUndefined();
  });

  it('profile remove without --yes requires interactive confirmation that matches the profile name', async () => {
    await writeMultiProfileConfig();
    // Wrong confirm -> abort
    await expect(
      parse(['profile', 'remove', 'staging'], {
        prompt: prompt({ confirmName: 'wrong-name', action: 'delete' }),
      }),
    ).rejects.toThrow(/abort|confirmation|cancel/i);

    // Correct confirm -> proceed
    await parse(['profile', 'remove', 'staging'], {
      prompt: prompt({ confirmName: 'staging', action: 'delete' }),
      keychain: keychain(new Set(['aiftp:staging:stage'])),
    });
    const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
    expect(toml).not.toContain('[profile.staging]');
  });

  it('profile test runs the doctor connection-scope subset against a profile', async () => {
    await writeMultiProfileConfig();
    const runtime: CliRuntime = {
      runDoctor: async (context) => ({
        ok: true,
        results: [
          {
            id: 'keychain',
            title: 'Keychain',
            status: 'pass',
            message: 'Keychain entry exists.',
          },
          {
            id: 'dns',
            title: 'DNS',
            status: 'pass',
            message: 'DNS resolution succeeded.',
          },
        ],
        summary: { pass: 2, warn: 0, fail: 0, skip: 0 },
        context,
      }),
    };
    await parse(['profile', 'test', '--profile', 'production'], { runtime });
    expect(stdout.join('\n')).toMatch(/keychain.*pass/);
    expect(stdout.join('\n')).toMatch(/dns.*pass/);
  });

  it('rollback --steps 1 --dry-run shows planned files and skipped hard-excludes', async () => {
    // Test contract: runtime hook returns a rollback runner that the CLI
    // invokes (mirrors `runtime.runStatus` / `runtime.runPush` pattern).
    // The hook receives all relevant context and returns a RollbackResult.
    await writeConfig();
    const runtime: CliRuntime = {
      runRollback: async (options) => ({
        dryRun: options.dryRun,
        snapshotId: '2026-05-19T01:00:00.000Z-auto-bbb',
        planned: ['index.html'],
        plannedDeletes: ['old.html'],
        rolledBack: [],
        deleted: [],
        nextState: { schema: 1, files: {} },
        skipped: [
          {
            path: '.env',
            remotePath: '/public_html/.env',
            size: 20,
            status: 'skipped-hard-exclude',
            reason: 'hard-exclude pattern: .env',
          },
        ],
      }),
    };
    await parse(['rollback', '--steps', '1', '--dry-run'], { runtime });
    const out = stdout.join('\n');
    expect(out).toMatch(/dry-run/i);
    expect(out).toMatch(/index\.html/);
    expect(out).toMatch(/1 file\(s\) would be deleted/);
    expect(out).toMatch(/old\.html/);
    expect(out).toMatch(/\.env/);
    expect(out).toMatch(/skipped|hard-exclude/i);
  });

  it('rollback --steps 1 real-run shows uploaded and deleted files, then persists state', async () => {
    await writeConfig();
    const nextState = {
      schema: 1 as const,
      files: {
        'index.html': {
          hash: 'a'.repeat(64),
          size: 12,
          updatedAt: '2026-05-19T01:00:00.000Z',
        },
      },
    };
    const runtime: CliRuntime = {
      runRollback: async (options) => ({
        dryRun: options.dryRun,
        snapshotId: '2026-05-19T01:00:00.000Z-auto-bbb',
        planned: ['index.html'],
        plannedDeletes: ['old.html'],
        rolledBack: [
          {
            path: 'index.html',
            remotePath: '/public_html/index.html',
            size: 12,
            status: 'rolled-back',
          },
        ],
        deleted: [
          {
            path: 'old.html',
            remotePath: '/public_html/old.html',
            size: 0,
            status: 'deleted',
          },
        ],
        nextState,
        skipped: [],
      }),
    };

    await parse(['rollback', '--steps', '1'], { runtime });

    const out = stdout.join('\n');
    expect(out).toMatch(/1 file\(s\) uploaded, 1 file\(s\) deleted/);
    expect(out).toMatch(/\+ index\.html/);
    expect(out).toMatch(/- old\.html/);
    await expect(
      readFile(join(cwd, '.aiftp', 'state', 'production', 'state.json'), 'utf8'),
    ).resolves.toBe(`${JSON.stringify(nextState, null, 2)}\n`);
  });

  it('rollback refuses both --steps and --snapshot-id at the same time (mutual exclusion)', async () => {
    // Review fix: previously snapshotId silently won and steps was
    // ignored. Now both-specified is a hard refuse so the operator
    // picks intentionally.
    await writeConfig();
    const runtime: CliRuntime = {
      runRollback: async () => {
        throw new Error('runner must not be called when args are ambiguous');
      },
    };
    await expect(
      parse(
        [
          'rollback',
          '--steps',
          '1',
          '--snapshot-id',
          '2026-05-19T01:00:00.000Z-auto-aaa',
          '--dry-run',
        ],
        { runtime },
      ),
    ).rejects.toThrow(/mutually exclusive|both.*--steps|pick one/i);
  });

  it('rollback honors --snapshot-id <id> and refuses without --steps or --snapshot-id', async () => {
    await writeConfig();
    let observedOptions: { snapshotId?: string; steps?: number } | null = null;
    const runtime: CliRuntime = {
      runRollback: async (options) => {
        observedOptions = { snapshotId: options.snapshotId, steps: options.steps };
        return {
          dryRun: true,
          snapshotId: options.snapshotId ?? 'unknown',
          planned: [],
          rolledBack: [],
          skipped: [],
        };
      },
    };
    await parse(['rollback', '--snapshot-id', '2026-05-19T01:00:00.000Z-full-ccc', '--dry-run'], {
      runtime,
    });
    expect(observedOptions).toMatchObject({
      snapshotId: '2026-05-19T01:00:00.000Z-full-ccc',
    });

    // Neither --steps nor --snapshot-id: refuse with a clear message.
    await expect(parse(['rollback', '--dry-run'], { runtime })).rejects.toThrow(/steps|snapshot/i);
  });

  it('import ffftp parses a Shift_JIS ffftp.ini and queues profiles for import (v0.7.0 #3)', async () => {
    // ASCII-only ffftp.ini content (which is identical in SJIS/UTF-8
    // bytes) — keeps the test free of an iconv-lite dependency at the
    // CLI test layer. The Shift_JIS-decoding code path is exercised in
    // core/src/importers/ffftp.spec.ts with real SJIS fixtures.
    const iniBytes = Buffer.from(
      [
        '[Options]',
        'Version=5',
        '',
        '[host0]',
        'HostName=Star Server Production',
        'HostAddress=ftp.example.jp',
        'Port=21',
        'UserName=deploy',
        'RemoteDir=/public_html',
        'UseSecure=1',
        'PassV=1',
        'KanjiCode=1',
        '',
      ].join('\r\n'),
      'utf8',
    );
    await writeConfig();
    const iniPath = join(cwd, 'ffftp.ini');
    await writeFile(iniPath, iniBytes);

    await parse(['import', 'ffftp', iniPath, '--dry-run']);

    const out = stdout.join('\n');
    expect(out).toMatch(/dry-run/i);
    // Sanitized profile name from "Star Server Production"
    expect(out).toMatch(/star-server-production/);
    expect(out).toMatch(/ftp\.example\.jp/);
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

  describe('v0.11 end-to-end mock (4 pillars combined)', () => {
    // Cross-pillar integration paths: init UX (α) + templates (β) + SFTP (γ)
    // shipping together. Smoke CI (δ) lives in .github/workflows/smoke.yml
    // and is covered by actionlint/shellcheck rather than vitest.

    it('init --template wordpress-swell + protocol=sftp produces a config that loadConfig accepts', async () => {
      await writeFile(join(cwd, '.gitignore'), '', 'utf8');
      await parse(['init', '--template', 'wordpress-swell'], {
        prompt: prompt({
          profile: 'main',
          host: 'sftp.example.com',
          port: 22,
          protocol: 'sftp',
          user: 'deploy',
          remoteRoot: '/home/deploy/wp',
          localRoot: '.',
          keychainService: 'aiftp:main',
          serverKind: 'generic',
          password: 'secret-password',
          consent: true,
        }),
      });
      const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
      // Pillar β (template defaults)
      expect(toml).toContain('[backup.hard_exclude]');
      expect(toml).toContain('wp-content/themes/swell-child/node_modules/**');
      // HIGH 1 fix: main* is the first production pattern, so the `main`
      // profile keeps its type-to-confirm gate even after a template is
      // applied.
      expect(toml).toContain('prod_profile_patterns = ["main*", "*prod*", "*www*", "*-live"]');
      // Pillar γ (SFTP protocol)
      expect(toml).toContain('protocol = "sftp"');
      expect(toml).toContain('port = 22');
      // The generated TOML must round-trip through loadConfig so deploy /
      // rollback / backup paths can consume it without surprises.
      const config = await loadConfig(join(cwd, '.aiftp.toml'));
      expect(config.profile.main?.protocol).toBe('sftp');
      expect(config.preflight.php_lint).toBe(true);
      expect(config.backup.hard_exclude.additional_patterns).toEqual(
        expect.arrayContaining(['wp-content/themes/swell-child/node_modules/**']),
      );
      expect(config.safety.prod_profile_patterns).toEqual(expect.arrayContaining(['main*']));
    });

    it('init --template static + protocol=ftps preserves user-edited localRoot through the full flow', async () => {
      // Combines Pillar α (PromptFlow), Pillar β (static template defaults
      // localRoot to "dist"), and HIGH 2 fix (user edits "build", that
      // value reaches the TOML — not the template default).
      await writeFile(join(cwd, '.gitignore'), '', 'utf8');
      await parse(['init', '--template', 'static'], {
        prompt: prompt({
          profile: 'production',
          host: 'ftp.example.com',
          port: 21,
          protocol: 'ftps',
          user: 'deploy',
          remoteRoot: '/public_html',
          localRoot: 'build',
          keychainService: 'aiftp:production',
          serverKind: 'generic',
          password: 'p',
          consent: true,
        }),
      });
      const toml = await readFile(join(cwd, '.aiftp.toml'), 'utf8');
      expect(toml).toContain('local_root = "build"');
      expect(toml).not.toMatch(/local_root = "dist"/);
      // Static template's hard-excludes still apply even when the user
      // overrides localRoot.
      expect(toml).toContain('node_modules/**');
      expect(toml).toContain('.parcel-cache/**');
    });

    it('writes ssh_key_path into .gitignore guard but never into a Keychain command', async () => {
      // Sanity check that the SFTP init path does NOT push ssh_key_path
      // through the password Keychain — that would leak the key location
      // into the credential store. Keychain receives only the password.
      await writeFile(join(cwd, '.gitignore'), '', 'utf8');
      await parse(['init'], {
        prompt: prompt({
          profile: 'production',
          host: 'sftp.example.com',
          port: 22,
          protocol: 'sftp',
          user: 'deploy',
          remoteRoot: '/var/www/html',
          localRoot: '.',
          keychainService: 'aiftp:production',
          serverKind: 'generic',
          password: 'pw',
          consent: true,
        }),
      });
      const passwords = stored.map((s) => s.password);
      // No stored password should match a filesystem path
      for (const p of passwords) {
        expect(p).not.toMatch(/^\//u);
        expect(p).not.toMatch(/^~\//u);
      }
      // The .gitignore should have .aiftp/ guard from the init flow.
      const gi = await readFile(join(cwd, '.gitignore'), 'utf8');
      expect(gi).toContain('.aiftp/');
    });
  });
});

describe('sanitizeFieldInput (v0.10.4)', () => {
  it('trims leading and trailing whitespace', () => {
    expect(sanitizeFieldInput('  ftp.example.com  ', 'host')).toBe('ftp.example.com');
    expect(sanitizeFieldInput('\tdeploy-user\t', 'user')).toBe('deploy-user');
  });

  it('rejects whitespace-only input', () => {
    expect(() => sanitizeFieldInput('   ', 'host')).toThrow(/host is required/);
    expect(() => sanitizeFieldInput('\t\n', 'host')).toThrow(/control characters|required/);
  });

  it('rejects control characters (newline, NUL, tab inside)', () => {
    expect(() => sanitizeFieldInput('a\nb', 'host')).toThrow(/control characters/);
    expect(() => sanitizeFieldInput('a\x00b', 'host')).toThrow(/control characters/);
    expect(() => sanitizeFieldInput('a\rb', 'host')).toThrow(/control characters/);
    expect(() => sanitizeFieldInput('a\x1bm', 'host')).toThrow(/control characters/); // ANSI ESC
  });

  it('accepts non-Latin input (Japanese, emoji)', () => {
    expect(sanitizeFieldInput('本番', 'profile')).toBe('本番');
    expect(sanitizeFieldInput('パス🔐word', 'password')).toBe('パス🔐word');
  });

  it('accepts very long strings (no truncation)', () => {
    const longString = 'a'.repeat(50_000);
    expect(sanitizeFieldInput(longString, 'profile')).toBe(longString);
  });

  it('throws TypeError-like for non-string input', () => {
    expect(() => sanitizeFieldInput(42 as unknown as string, 'host')).toThrow(/must be a string/);
    expect(() => sanitizeFieldInput(null as unknown as string, 'host')).toThrow(/must be a string/);
    expect(() => sanitizeFieldInput(undefined as unknown as string, 'host')).toThrow(
      /must be a string/,
    );
  });
});

describe('parseSummaryChoice (v0.10.4)', () => {
  it('treats empty string and Enter as yes', () => {
    expect(parseSummaryChoice('')).toEqual({ kind: 'yes' });
    expect(parseSummaryChoice('  ')).toEqual({ kind: 'yes' });
  });

  it('accepts y / Y / yes / YES', () => {
    expect(parseSummaryChoice('y')).toEqual({ kind: 'yes' });
    expect(parseSummaryChoice('Y')).toEqual({ kind: 'yes' });
    expect(parseSummaryChoice('yes')).toEqual({ kind: 'yes' });
    expect(parseSummaryChoice('YES')).toEqual({ kind: 'yes' });
  });

  it('accepts n / N / no / NO as no', () => {
    expect(parseSummaryChoice('n')).toEqual({ kind: 'no' });
    expect(parseSummaryChoice('N')).toEqual({ kind: 'no' });
    expect(parseSummaryChoice('no')).toEqual({ kind: 'no' });
    expect(parseSummaryChoice('NO')).toEqual({ kind: 'no' });
  });

  it('accepts half-width digits 1-10 as edit', () => {
    expect(parseSummaryChoice('1')).toEqual({ kind: 'edit', fieldIndex: 1 });
    expect(parseSummaryChoice('5')).toEqual({ kind: 'edit', fieldIndex: 5 });
    expect(parseSummaryChoice('10')).toEqual({ kind: 'edit', fieldIndex: 10 });
  });

  it('rejects full-width digits (Codex Critical #16)', () => {
    expect(parseSummaryChoice('１')).toEqual({ kind: 'invalid' });
    expect(parseSummaryChoice('１０')).toEqual({ kind: 'invalid' });
  });

  it('rejects ambiguous numeric forms (Codex Critical #16)', () => {
    expect(parseSummaryChoice('1abc')).toEqual({ kind: 'invalid' });
    expect(parseSummaryChoice('1.5')).toEqual({ kind: 'invalid' });
    expect(parseSummaryChoice('01')).toEqual({ kind: 'invalid' });
    expect(parseSummaryChoice('010')).toEqual({ kind: 'invalid' });
    expect(parseSummaryChoice('0')).toEqual({ kind: 'invalid' });
    expect(parseSummaryChoice('11')).toEqual({ kind: 'invalid' });
    expect(parseSummaryChoice('-1')).toEqual({ kind: 'invalid' });
  });

  it('handles paste-with-trailing-newline by trimming then parsing', () => {
    expect(parseSummaryChoice('10\n')).toEqual({ kind: 'edit', fieldIndex: 10 });
    expect(parseSummaryChoice('1\n')).toEqual({ kind: 'edit', fieldIndex: 1 });
    expect(parseSummaryChoice('y\n')).toEqual({ kind: 'yes' });
    expect(parseSummaryChoice('  y  ')).toEqual({ kind: 'yes' });
  });

  it('rejects input with internal whitespace (typo guard)', () => {
    expect(parseSummaryChoice('1 5')).toEqual({ kind: 'invalid' });
    expect(parseSummaryChoice('1 0')).toEqual({ kind: 'invalid' });
    expect(parseSummaryChoice('y e s')).toEqual({ kind: 'invalid' });
  });

  it('returns cancel for null / undefined (prompts cancel signal)', () => {
    expect(parseSummaryChoice(null)).toEqual({ kind: 'cancel' });
    expect(parseSummaryChoice(undefined)).toEqual({ kind: 'cancel' });
  });
});

describe('init summary review (v0.10.4, 25 cases per spec §6.1)', () => {
  const cwd = join(tmpdir(), `aiftp-cli-summary-test-${randomUUID()}`);
  let stored: Array<{ service: string; account: string; password: string }>;
  let stderrLines: string[];
  let stdoutLines: string[];

  beforeEach(async () => {
    await mkdir(cwd, { recursive: true });
    stored = [];
    stderrLines = [];
    stdoutLines = [];
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const baseAnswers = {
    profile: 'production',
    host: 'ftp.example.com',
    port: 21,
    protocol: 'ftps',
    user: 'deploy-user',
    remoteRoot: '/public_html',
    localRoot: '.',
    keychainService: 'aiftp:production',
    serverKind: 'generic',
    password: 'secret-password',
    consent: true,
  } as const;

  function keychainMock(existing = new Set<string>()): CliKeychain {
    return {
      setPassword: async (service, account, password) => {
        stored.push({ service, account, password });
        existing.add(`${service}:${account}`);
      },
      deletePassword: async (service, account) => {
        existing.delete(`${service}:${account}`);
      },
      hasPassword: async (service, account) => existing.has(`${service}:${account}`),
      getPassword: async (service, account) => {
        if (service.endsWith(':backup-key')) {
          return Buffer.alloc(32, 1).toString('base64');
        }
        if (!existing.has(`${service}:${account}`)) throw new Error('not found');
        return 'mock-password';
      },
    };
  }

  // v0.11 (Pillar α): the init prompt path now runs through PromptFlow,
  // which asks one field at a time. Legacy fixtures still pass a single
  // baseAnswers object containing all 11 init fields, so we expand it on
  // the fly — serve the next requested field from the same fixture, and
  // advance to the next fixture only after all 11 init fields have been
  // consumed.
  const INIT_FIELDS_V011 = [
    'profile',
    'host',
    'port',
    'protocol',
    'user',
    'remoteRoot',
    'localRoot',
    'keychainService',
    'serverKind',
    'password',
    'consent',
  ] as const;

  function promptSeq(answers: Array<Record<string, unknown>>): CliPrompt {
    let i = 0;
    let initBatchConsumed = new Set<string>();
    return async (question: unknown) => {
      if (i >= answers.length) {
        throw new Error(`promptSeq exhausted at call ${i + 1} (only ${answers.length} provided)`);
      }
      const fixture = answers[i] ?? {};

      const askedName =
        !Array.isArray(question) && typeof question === 'object' && question !== null
          ? (question as { name?: string }).name
          : undefined;
      if (askedName === 'template-select') {
        return { 'template-select': 'none' };
      }
      const fixtureHasFullInitBatch = INIT_FIELDS_V011.every((f) => f in fixture);
      const isInitFieldRequest =
        askedName !== undefined && (INIT_FIELDS_V011 as readonly string[]).includes(askedName);

      if (fixtureHasFullInitBatch && isInitFieldRequest && !initBatchConsumed.has(askedName)) {
        initBatchConsumed.add(askedName);
        if (initBatchConsumed.size >= INIT_FIELDS_V011.length) {
          i += 1;
          initBatchConsumed = new Set<string>();
        }
        return { [askedName]: fixture[askedName] };
      }

      i += 1;
      return fixture;
    };
  }

  async function runInit(
    prompt: CliPrompt,
    existingKeychain = new Set<string>(),
    args: string[] = ['init'],
  ): Promise<{ error?: Error }> {
    const command = createCli({
      cwd,
      prompt,
      keychain: keychainMock(existingKeychain),
      stdout: (line: string) => stdoutLines.push(line),
      stderr: (line: string) => stderrLines.push(line),
    });
    try {
      await command.parseAsync(['node', 'aiftp', ...args], { from: 'node' });
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e : new Error(String(e)) };
    }
  }

  it('#1: continues on Y and writes .aiftp.toml', async () => {
    const { error } = await runInit(promptSeq([baseAnswers, { choice: 'Y' }]));
    expect(error).toBeUndefined();
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.host).toBe('ftp.example.com');
  });

  it('#2: continues on empty Enter (treated as Y)', async () => {
    const { error } = await runInit(promptSeq([baseAnswers, { choice: '' }]));
    expect(error).toBeUndefined();
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.host).toBe('ftp.example.com');
  });

  it('#3: aborts on n and does not write config/keychain', async () => {
    const { error } = await runInit(promptSeq([baseAnswers, { choice: 'n' }]));
    expect(error?.message).toMatch(/aborted by user at summary review/);
    await expect(readFile(join(cwd, '.aiftp.toml'), 'utf8')).rejects.toThrow();
    expect(stored).toHaveLength(0);
  });

  it('#4: edits single field then continues', async () => {
    const { error } = await runInit(
      promptSeq([baseAnswers, { choice: '6' }, { remoteRoot: '/var/www/html' }, { choice: 'Y' }]),
    );
    expect(error).toBeUndefined();
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.remote_root).toBe('/var/www/html');
  });

  it('#5: edits multiple fields then continues', async () => {
    const { error } = await runInit(
      promptSeq([
        baseAnswers,
        { choice: '6' },
        { remoteRoot: '/htdocs' },
        { choice: '5' },
        { user: 'new-user' },
        { choice: 'Y' },
      ]),
    );
    expect(error).toBeUndefined();
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.user).toBe('new-user');
    expect(config.profile.production?.remote_root).toBe('/htdocs');
  });

  it('#6: shows error on invalid string and continues loop', async () => {
    const { error } = await runInit(promptSeq([baseAnswers, { choice: 'xyz' }, { choice: 'Y' }]));
    expect(error).toBeUndefined();
    expect(stderrLines.some((l) => /Invalid input/.test(l))).toBe(true);
  });

  it('#7: shows error on out-of-range number and continues loop', async () => {
    const { error } = await runInit(promptSeq([baseAnswers, { choice: '99' }, { choice: 'Y' }]));
    expect(error).toBeUndefined();
    expect(stderrLines.some((l) => /Invalid input/.test(l))).toBe(true);
  });

  it('#8: aborts after MAX_INIT_EDIT_LOOPS (10) edit iterations', async () => {
    const seq: Array<Record<string, unknown>> = [baseAnswers];
    for (let i = 0; i < 10; i += 1) {
      seq.push({ choice: '6' });
      seq.push({ remoteRoot: `/path-${i}` });
    }
    seq.push({ choice: '6' });
    const { error } = await runInit(promptSeq(seq));
    expect(error?.message).toMatch(/edit loop limit exceeded/);
  });

  it('#9: edits password (#10) and saves new value to keychain', async () => {
    const { error } = await runInit(
      promptSeq([baseAnswers, { choice: '10' }, { password: 'new-secret' }, { choice: 'Y' }]),
    );
    expect(error).toBeUndefined();
    expect(stored[0]?.password).toBe('new-secret');
  });

  it('#10: discards edits when aborted at summary', async () => {
    const { error } = await runInit(
      promptSeq([baseAnswers, { choice: '6' }, { remoteRoot: '/edited' }, { choice: 'n' }]),
    );
    expect(error?.message).toMatch(/aborted by user at summary review/);
    await expect(readFile(join(cwd, '.aiftp.toml'), 'utf8')).rejects.toThrow();
    expect(stored).toHaveLength(0);
  });

  it('#11: rejects empty edit value via sanitizeFieldInput', async () => {
    const { error } = await runInit(
      promptSeq([baseAnswers, { choice: '6' }, { remoteRoot: '   ' }, { choice: 'Y' }]),
    );
    expect(error?.message).toMatch(/Remote root is required/);
  });

  it('#12: warns when profile name changes (does NOT auto-sync keychainService)', async () => {
    const { error } = await runInit(
      promptSeq([baseAnswers, { choice: '1' }, { profile: 'staging' }, { choice: 'Y' }]),
    );
    expect(error).toBeUndefined();
    expect(
      stderrLines.some((l) => /Profile name changed from "production" to "staging"/.test(l)),
    ).toBe(true);
  });

  it('#13: re-fires non-standard port confirmation when port is edited', async () => {
    const { error } = await runInit(
      promptSeq([
        baseAnswers,
        { choice: '3' },
        { port: 8021 },
        { confirmNonStandard: true },
        { choice: 'Y' },
      ]),
    );
    expect(error).toBeUndefined();
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.port).toBe(8021);
  });

  it('#14: cancels safely on null choice (prompts onCancel signal)', async () => {
    const { error } = await runInit(promptSeq([baseAnswers, { choice: null }]));
    expect(error?.message).toMatch(/cancelled at summary review/);
    await expect(readFile(join(cwd, '.aiftp.toml'), 'utf8')).rejects.toThrow();
    expect(stored).toHaveLength(0);
  });

  it('#15: cancels mid-edit propagates correctly with no partial writes', async () => {
    const { error } = await runInit(
      promptSeq([baseAnswers, { choice: '6' }, { remoteRoot: null }, { choice: 'Y' }]),
    );
    expect(error?.message).toMatch(/must be a string|cancelled/);
    expect(stored).toHaveLength(0);
  });

  it('#16: rejects 全角数字 (１０) and ambiguous numerics (01, 1abc)', async () => {
    const { error } = await runInit(
      promptSeq([
        baseAnswers,
        { choice: '１０' },
        { choice: '01' },
        { choice: '1abc' },
        { choice: 'Y' },
      ]),
    );
    expect(error).toBeUndefined();
    expect(stderrLines.filter((l) => /Invalid input/.test(l)).length).toBeGreaterThanOrEqual(3);
  });

  it('#17: --force + existing keychain + actually edit keychainService preserves backup key', async () => {
    await writeFile(
      join(cwd, '.aiftp.toml'),
      'log_level = "info"\n[profile.production]\nhost = "old.example.com"\nport = 21\nprotocol = "ftps"\nuser = "old"\nremote_root = "/old"\nlocal_root = "."\nkeychain_service = "aiftp:production"\nserver_kind = "generic"\n',
    );
    const existing = new Set(['aiftp:production:backup-key:production']);
    // v0.10.4 (Codex Phase 2 S4): walk through edit #8 then confirm with Y;
    // assert backup-key was NOT overwritten (only the FTP password is set).
    let choiceCallNum = 0;
    const customPrompt: CliPrompt = async (questions) => {
      const first = Array.isArray(questions) ? questions[0] : questions;
      if (first?.name === 'template-select') return { 'template-select': 'none' };
      if (first?.name === 'overwriteBackupKey') return { overwriteBackupKey: false };
      if (first?.name === 'choice') {
        choiceCallNum += 1;
        if (choiceCallNum === 1) return { choice: '8' };
        return { choice: 'Y' };
      }
      if (first?.name === 'keychainService') return { keychainService: 'aiftp:edited' };
      return baseAnswers;
    };
    const { error } = await runInit(customPrompt, existing, ['init', '--force']);
    expect(error).toBeUndefined();
    expect(choiceCallNum).toBe(2);
    // Old backup key entry (under previous keychain service) was NOT overwritten.
    expect(stored.find((s) => s.service === 'aiftp:production:backup-key')).toBeUndefined();
    // The renamed keychain service got its FTP password and a fresh backup key
    // (this is expected: a new keychain identity gets its own encryption material).
    expect(stored.find((s) => s.service === 'aiftp:edited')?.password).toBe('secret-password');
  });

  it('#18: profile rename produces desync warning, keychainService unchanged', async () => {
    const { error } = await runInit(
      promptSeq([baseAnswers, { choice: '1' }, { profile: 'staging' }, { choice: 'Y' }]),
    );
    expect(error).toBeUndefined();
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.staging).toBeDefined();
    expect(config.profile.staging?.keychain_service).toBe('aiftp:production');
    expect(stderrLines.some((l) => /NOT auto-updated/.test(l))).toBe(true);
  });

  it('#19: trims whitespace from edited field', async () => {
    const { error } = await runInit(
      promptSeq([baseAnswers, { choice: '2' }, { host: '  ftp.trimmed.com  ' }, { choice: 'Y' }]),
    );
    expect(error).toBeUndefined();
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.host).toBe('ftp.trimmed.com');
  });

  it('#20: rejects whitespace-only edit value', async () => {
    const { error } = await runInit(
      promptSeq([baseAnswers, { choice: '2' }, { host: '   \t\t  ' }, { choice: 'Y' }]),
    );
    expect(error?.message).toMatch(/FTP host is required/);
  });

  it('#21: rejects control characters in edit value', async () => {
    const { error } = await runInit(
      promptSeq([baseAnswers, { choice: '2' }, { host: 'ftp\nexample.com' }, { choice: 'Y' }]),
    );
    expect(error?.message).toMatch(/control characters/);
  });

  it('#22: handles very long strings without truncation in TOML', async () => {
    const longHost = `${'a'.repeat(40_000)}.example.com`;
    const { error } = await runInit(
      promptSeq([baseAnswers, { choice: '2' }, { host: longHost }, { choice: 'Y' }]),
    );
    expect(error).toBeUndefined();
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.host).toBe(longHost);
  });

  it('#23: round-trips non-Latin host + emoji password (profile is ASCII-only per TOML bare-key rule)', async () => {
    const { error } = await runInit(
      promptSeq([
        baseAnswers,
        { choice: '2' },
        { host: 'ftp.例え.test' },
        { choice: '10' },
        { password: 'パス🔐word' },
        { choice: 'Y' },
      ]),
    );
    expect(error).toBeUndefined();
    const config = await loadConfig(join(cwd, '.aiftp.toml'));
    expect(config.profile.production?.host).toBe('ftp.例え.test');
    expect(stored[0]?.password).toBe('パス🔐word');
  });

  it('#24: aborts in non-TTY environment with explicit error', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const { error } = await runInit(promptSeq([baseAnswers]));
      expect(error?.message).toMatch(/non-interactive stdin not supported/);
      expect(stored).toHaveLength(0);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  it('#25: aborting after multiple edits leaves zero side-effects', async () => {
    const { error } = await runInit(
      promptSeq([
        baseAnswers,
        { choice: '6' },
        { remoteRoot: '/edited-1' },
        { choice: '8' },
        { keychainService: 'aiftp:edited' },
        { choice: 'n' },
      ]),
    );
    expect(error?.message).toMatch(/aborted by user at summary review/);
    await expect(readFile(join(cwd, '.aiftp.toml'), 'utf8')).rejects.toThrow();
    expect(stored).toHaveLength(0);
  });
});
