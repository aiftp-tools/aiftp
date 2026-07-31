import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDesktopEnv, startDesktopServer } from './server-entry.js';

// Not a real credential — a fixture used to prove the value never leaks.
const fixtureValue = 'fixture-only-not-real';

describe('readDesktopEnv', () => {
  it('maps the manifest env vars onto bootstrap input fields', () => {
    expect(
      readDesktopEnv({
        AIFTP_PROJECT_DIR: '/abs/site',
        AIFTP_BOOTSTRAP_SITE: 'gwco',
        AIFTP_BOOTSTRAP_HOST: 'ftp.example.test',
        AIFTP_BOOTSTRAP_PROTOCOL: 'ftps',
        AIFTP_BOOTSTRAP_USER: 'deployer',
        AIFTP_BOOTSTRAP_REMOTE_ROOT: '/public_html',
        AIFTP_BOOTSTRAP_CREDENTIAL: fixtureValue,
      }),
    ).toEqual({
      localRoot: '/abs/site',
      siteName: 'gwco',
      host: 'ftp.example.test',
      protocol: 'ftps',
      username: 'deployer',
      remoteRoot: '/public_html',
      credential: fixtureValue,
      profileName: 'production',
    });
  });

  it('omits fields whose env var is an empty string', () => {
    const result = readDesktopEnv({ AIFTP_PROJECT_DIR: '/abs/site', AIFTP_BOOTSTRAP_SITE: '' });
    expect(result.siteName).toBeUndefined();
    expect(result.localRoot).toBe('/abs/site');
  });
});

describe('startDesktopServer', () => {
  let localRoot: string;

  beforeEach(async () => {
    localRoot = join(tmpdir(), `aiftp-desktop-${randomUUID()}`);
    await mkdir(localRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(localRoot, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'AIFTP_DESKTOP_STARTUP');
  });

  it('starts the MCP server even when every setting is missing', async () => {
    const started: Array<{ cwd: string }> = [];
    const report = await startDesktopServer(
      {},
      {
        startMcp: async (options) => {
          started.push(options);
        },
      },
    );

    expect(started).toHaveLength(1);
    expect(report.error?.message).toBe('bootstrap-invalid: site_name must not be empty');
    expect(report.error?.hint).toBe(
      'Claude Desktop の設定 → 拡張機能 → aiftp で「サイト名」欄を修正し、Claude Desktop を再起動してください。',
    );
  });

  it('starts the MCP server in the project directory when bootstrap succeeds', async () => {
    const started: Array<{ cwd: string }> = [];
    const report = await startDesktopServer(
      {
        AIFTP_PROJECT_DIR: localRoot,
        AIFTP_BOOTSTRAP_SITE: 'gwco',
        AIFTP_BOOTSTRAP_HOST: 'ftp.example.test',
        AIFTP_BOOTSTRAP_PROTOCOL: 'ftps',
        AIFTP_BOOTSTRAP_USER: 'deployer',
        AIFTP_BOOTSTRAP_REMOTE_ROOT: '/public_html',
        AIFTP_BOOTSTRAP_CREDENTIAL: fixtureValue,
      },
      {
        startMcp: async (options) => {
          started.push(options);
        },
        runBootstrap: async () => ({
          ok: true,
          siteName: 'gwco',
          profileName: 'production',
          keychainService: 'aiftp:gwco-production',
          configPath: join(localRoot, '.aiftp.toml'),
          config: 'created',
          credential: 'stored',
          registry: 'registered',
          gitignore: 'skipped-not-a-repo',
          missing: [],
        }),
      },
    );

    expect(started).toEqual([{ cwd: localRoot }]);
    expect(report.bootstrap?.ok).toBe(true);
    expect(report.error).toBeUndefined();
  });

  it('falls back to process.cwd() for the MCP cwd when the project dir is unset', async () => {
    const started: Array<{ cwd: string }> = [];
    await startDesktopServer(
      {},
      {
        startMcp: async (options) => {
          started.push(options);
        },
      },
    );
    expect(started[0]?.cwd).toBe(process.cwd());
  });

  it('never puts the credential into the startup report', async () => {
    const report = await startDesktopServer(
      { AIFTP_PROJECT_DIR: localRoot, AIFTP_BOOTSTRAP_CREDENTIAL: fixtureValue },
      { startMcp: async () => {} },
    );
    expect(JSON.stringify(report)).not.toContain(fixtureValue);
  });
});
