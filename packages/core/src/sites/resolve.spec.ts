import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSite } from './resolve.js';
import type { SiteEntry } from './types.js';

const PROFILE = [
  'host = "ftp.example.com"',
  'port = 21',
  'protocol = "ftp"',
  'user = "deploy"',
  'remote_root = "/public_html"',
  'local_root = "./dist"',
  'keychain_service = "aiftp:production"',
];

function configSource(secondProfile = false, schema = 2): string {
  return [
    `schema = ${schema}`,
    '',
    '[profile.production]',
    ...PROFILE,
    ...(secondProfile
      ? [
          '',
          '[profile.staging]',
          ...PROFILE.map((line) => (line === 'protocol = "ftp"' ? 'protocol = "sftp"' : line)),
        ]
      : []),
    '',
  ].join('\n');
}

describe('resolveSite', () => {
  let projectPath: string;
  let entry: SiteEntry;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'aiftp-resolve-'));
    entry = { name: 'example', path: projectPath };
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  async function writeConfig(source = configSource()): Promise<void> {
    await writeFile(join(projectPath, '.aiftp.toml'), source, 'utf8');
  }

  async function writeLog(lines: readonly string[]): Promise<void> {
    const logDirectory = join(projectPath, '.aiftp');
    await mkdir(logDirectory, { recursive: true });
    await writeFile(join(logDirectory, 'log.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  }

  it('assembles profiles, default protocol, credentials, and latest push', async () => {
    await writeConfig(configSource(true));
    await writeLog([
      '{"at":"2026-07-01T10:00:00.000Z","event":"push","profile":"production"}',
      '{"at":"2026-07-03T10:00:00.000Z","event":"push","profile":"staging"}',
    ]);
    const hasPassword = vi.fn().mockResolvedValue(true);

    const result = await resolveSite(
      { ...entry, label: 'Example', default_profile: 'staging' },
      { hasPassword },
    );

    expect(result).toEqual({
      ...entry,
      label: 'Example',
      default_profile: 'staging',
      profiles: ['production', 'staging'],
      protocol: 'sftp',
      credentialsStatus: 'present',
      lastPushAt: '2026-07-03T10:00:00.000Z',
      health: 'ok',
    });
    expect(hasPassword).toHaveBeenCalledWith('aiftp:production', 'deploy');
  });

  it('reports a nonexistent project path as missing', async () => {
    const result = await resolveSite({ ...entry, path: join(projectPath, 'missing') });

    expect(result).toMatchObject({
      health: 'missing',
      profiles: [],
      credentialsStatus: 'unknown',
    });
  });

  it('reports a non-directory project path as missing', async () => {
    const filePath = join(projectPath, 'file');
    await writeFile(filePath, 'not a directory', 'utf8');

    const result = await resolveSite({ ...entry, path: filePath });

    expect(result.health).toBe('missing');
  });

  it('reports a missing config as invalid while still reading the log', async () => {
    await writeLog(['{"at":"2026-07-02T10:00:00.000Z","event":"push"}']);

    const result = await resolveSite(entry);

    expect(result).toMatchObject({
      health: 'invalid',
      profiles: [],
      credentialsStatus: 'unknown',
      lastPushAt: '2026-07-02T10:00:00.000Z',
    });
  });

  it('reports malformed TOML as invalid without throwing', async () => {
    await writeConfig('schema = 2\n[profile.production');

    const result = await resolveSite(entry);

    expect(result).toMatchObject({
      health: 'invalid',
      profiles: [],
      credentialsStatus: 'unknown',
    });
  });

  it('reports missing credentials when the keychain has no password', async () => {
    await writeConfig();

    const result = await resolveSite(entry, { hasPassword: async () => false });

    expect(result.credentialsStatus).toBe('missing');
    expect(result.health).toBe('ok');
  });

  it('keeps the site healthy and reports unknown credentials on keychain errors', async () => {
    await writeConfig();

    const result = await resolveSite(entry, {
      hasPassword: async () => Promise.reject(new Error('keychain unavailable')),
    });

    expect(result.credentialsStatus).toBe('unknown');
    expect(result.health).toBe('ok');
  });

  it('leaves lastPushAt undefined when the log file is absent', async () => {
    await writeConfig();

    const result = await resolveSite(entry, { hasPassword: async () => true });

    expect(result.lastPushAt).toBeUndefined();
  });

  it('skips malformed log lines and uses a valid push entry', async () => {
    await writeConfig();
    await writeLog([
      '{broken json',
      '{"at":"2026-07-04T10:00:00.000Z","event":"pull"}',
      '{"at":"2026-07-05T10:00:00.000Z","event":"push"}',
    ]);

    const result = await resolveSite(entry, { hasPassword: async () => true });

    expect(result.lastPushAt).toBe('2026-07-05T10:00:00.000Z');
  });

  it('falls back to the first profile when default_profile is not configured', async () => {
    await writeConfig(configSource(true));

    const result = await resolveSite(
      { ...entry, default_profile: 'preview' },
      { hasPassword: async () => true },
    );

    expect(result.protocol).toBe('ftp');
  });

  it('does not auto-migrate a schema 1 config while resolving it', async () => {
    const source = configSource(false, 1);
    await writeConfig(source);

    const result = await resolveSite(entry, { hasPassword: async () => true });

    expect(result.health).toBe('ok');
    expect(await readFile(join(projectPath, '.aiftp.toml'), 'utf8')).toBe(source);
  });
});
