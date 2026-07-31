import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SiteEntry } from '../sites/types.js';
import { runBootstrap } from './index.js';
import type { BootstrapDeps } from './types.js';

// Not a real credential — a fixture used to prove the value never reaches disk.
const fixtureValue = 'fixture-only-not-real';

const input = {
  siteName: 'gwco',
  host: 'ftp.example.test',
  protocol: 'ftps' as const,
  username: 'deployer',
  remoteRoot: '/public_html',
  profileName: 'production',
  credential: fixtureValue,
};

function fakeDeps(): BootstrapDeps & {
  readonly stored: Map<string, string>;
  readonly entries: SiteEntry[];
} {
  const stored = new Map<string, string>();
  const entries: SiteEntry[] = [];
  return {
    stored,
    entries,
    storeCredential: async (service, account, value) => {
      stored.set(`${service}\u0000${account}`, value);
    },
    credentialExists: async (service, account) => stored.has(`${service}\u0000${account}`),
    createRegistry: () => ({
      list: async () => entries,
      add: async (entry) => {
        entries.push(entry);
        return entries;
      },
    }),
  };
}

const STALE_CONFIG = [
  'schema = 2',
  '',
  '[profile.production]',
  'host = "wrong.example.test"',
  'port = 21',
  'protocol = "ftp"',
  'user = "someone-else"',
  'remote_root = "/old_html"',
  'local_root = "."',
  'keychain_service = "aiftp:old-production"',
  'server_kind = "generic"',
  '',
].join('\n');

describe('runBootstrap', () => {
  let localRoot: string;

  beforeEach(async () => {
    localRoot = join(tmpdir(), `aiftp-bootstrap-${randomUUID()}`);
    await mkdir(localRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(localRoot, { recursive: true, force: true });
  });

  it('creates .aiftp.toml, stores the credential, and registers the site', async () => {
    const deps = fakeDeps();
    const result = await runBootstrap({ ...input, localRoot }, deps);

    expect(result.ok).toBe(true);
    expect(result.config).toBe('created');
    expect(result.credential).toBe('stored');
    expect(result.registry).toBe('registered');
    expect(result.keychainService).toBe('aiftp:gwco-production');
    expect(result.missing).toEqual([]);

    const toml = await readFile(join(localRoot, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('schema = 2');
    expect(toml).toContain('[profile.production]');
    expect(toml).toContain('host = "ftp.example.test"');
    expect(toml).toContain('protocol = "ftps"');
    expect(toml).toContain('user = "deployer"');
    expect(toml).toContain('remote_root = "/public_html"');
    expect(toml).toContain('local_root = "."');
    expect(toml).toContain('keychain_service = "aiftp:gwco-production"');

    expect(deps.stored.get('aiftp:gwco-production\u0000deployer')).toBe(fixtureValue);
    expect(deps.entries).toEqual([
      { name: 'gwco', path: localRoot, default_profile: 'production' },
    ]);
  });

  it('never writes the credential into .aiftp.toml', async () => {
    await runBootstrap({ ...input, localRoot }, fakeDeps());
    const toml = await readFile(join(localRoot, '.aiftp.toml'), 'utf8');
    expect(toml).not.toContain(fixtureValue);
    expect(toml.toLowerCase()).not.toContain('pass');
  });

  it('is idempotent: a second run with unchanged settings reports existing config', async () => {
    const deps = fakeDeps();
    await runBootstrap({ ...input, localRoot }, deps);
    const firstToml = await readFile(join(localRoot, '.aiftp.toml'), 'utf8');

    const second = await runBootstrap({ ...input, localRoot }, deps);

    expect(second.ok).toBe(true);
    expect(second.config).toBe('existing');
    // A credential is supplied on every launch, so per the "settings form is
    // authoritative" ruling it is re-stored (not "already-stored") even
    // though the value happens to be unchanged.
    expect(second.credential).toBe('stored');
    expect(second.registry).toBe('already-registered');
    expect(await readFile(join(localRoot, '.aiftp.toml'), 'utf8')).toBe(firstToml);
    expect(deps.entries).toHaveLength(1);
  });

  it('updates the bootstrap-owned fields in an existing .aiftp.toml', async () => {
    await writeFile(join(localRoot, '.aiftp.toml'), STALE_CONFIG, 'utf8');

    const result = await runBootstrap({ ...input, localRoot }, fakeDeps());

    expect(result.config).toBe('updated');
    const toml = await readFile(join(localRoot, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('host = "ftp.example.test"');
    expect(toml).not.toContain('wrong.example.test');
    expect(toml).toContain('protocol = "ftps"');
    expect(toml).toContain('user = "deployer"');
    expect(toml).toContain('remote_root = "/public_html"');
    expect(toml).toContain('keychain_service = "aiftp:gwco-production"');
  });

  it('preserves a user-added section when reconciling an existing config', async () => {
    const withSafetySection = `${STALE_CONFIG}[safety]\nmax_files_per_push = 42\n`;
    await writeFile(join(localRoot, '.aiftp.toml'), withSafetySection, 'utf8');

    const result = await runBootstrap({ ...input, localRoot }, fakeDeps());

    expect(result.config).toBe('updated');
    const toml = await readFile(join(localRoot, '.aiftp.toml'), 'utf8');
    expect(toml).toContain('[safety]');
    expect(toml).toContain('max_files_per_push = 42');
  });

  it('leaves an existing config untouched when it has no matching profile', async () => {
    const custom = 'schema = 2\n\n[profile.staging]\nhost = "staging.example.test"\n';
    await writeFile(join(localRoot, '.aiftp.toml'), custom, 'utf8');

    const result = await runBootstrap({ ...input, localRoot }, fakeDeps());

    expect(result.config).toBe('existing');
    expect(await readFile(join(localRoot, '.aiftp.toml'), 'utf8')).toBe(custom);
  });

  it('reports a missing credential with a Japanese hint instead of throwing', async () => {
    const { credential, ...withoutCredential } = input;
    const result = await runBootstrap({ ...withoutCredential, localRoot }, fakeDeps());

    expect(result.ok).toBe(false);
    expect(result.credential).toBe('missing');
    expect(result.missing).toEqual(['credential']);
    expect(result.hint).toBe(
      'Claude Desktop の設定 → 拡張機能 → aiftp で「パスワード」欄を入力し、Claude Desktop を再起動してください。',
    );
  });

  it('overwrites a stored credential when a new value is supplied', async () => {
    const deps = fakeDeps();
    await runBootstrap({ ...input, localRoot }, deps);

    const rotated = 'fixture-rotated-not-real';
    const second = await runBootstrap({ ...input, localRoot, credential: rotated }, deps);

    expect(second.credential).toBe('stored');
    expect(deps.stored.get('aiftp:gwco-production\u0000deployer')).toBe(rotated);
  });

  it('keeps the existing credential when no value is supplied', async () => {
    const deps = fakeDeps();
    await runBootstrap({ ...input, localRoot }, deps);

    const { credential, ...withoutCredential } = input;
    const second = await runBootstrap({ ...withoutCredential, localRoot }, deps);

    expect(second.credential).toBe('already-stored');
    expect(deps.stored.get('aiftp:gwco-production\u0000deployer')).toBe(fixtureValue);
  });

  it('treats a whitespace-only credential as not supplied', async () => {
    const { credential, ...withoutCredential } = input;
    const deps = fakeDeps();

    const result = await runBootstrap({ ...withoutCredential, localRoot, credential: '   ' }, deps);

    expect(result.credential).toBe('missing');
    expect(deps.stored.size).toBe(0);
  });

  it('throws the conflict error before writing config or storing the credential', async () => {
    const deps = fakeDeps();
    deps.entries.push({ name: 'gwco', path: join(tmpdir(), 'somewhere-else') });

    await expect(runBootstrap({ ...input, localRoot }, deps)).rejects.toThrow(
      'bootstrap-conflict: site "gwco" is already registered for a different folder',
    );

    await expect(readFile(join(localRoot, '.aiftp.toml'), 'utf8')).rejects.toThrow();
    expect(deps.stored.size).toBe(0);
    expect(deps.entries).toHaveLength(1);
  });

  it('fails when local_root does not exist', async () => {
    await rm(localRoot, { recursive: true, force: true });
    await expect(runBootstrap({ ...input, localRoot }, fakeDeps())).rejects.toThrow(
      'bootstrap-invalid: local_root does not exist',
    );
  });

  it('normalizes local_root before registering the site', async () => {
    const unnormalized = `${localRoot}/./nested/..`;
    const deps = fakeDeps();

    const result = await runBootstrap({ ...input, localRoot: unnormalized }, deps);

    expect(result.ok).toBe(true);
    expect(deps.entries).toEqual([
      { name: 'gwco', path: localRoot, default_profile: 'production' },
    ]);
  });
});
