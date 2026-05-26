/**
 * deploy-client-factory tests — Task 24.
 *
 * The factory selects FtpClient or SftpClient based on the profile's
 * protocol field. deploy / rollback / backup all go through this so
 * the rest of the code can be protocol-agnostic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub ssh2-sftp-client (Task 21/22 test mock pattern) so importing
// SftpClient does not open a real SSH socket.
vi.mock('ssh2-sftp-client', () => ({
  default: class MockSftp {
    connect = vi.fn().mockResolvedValue(undefined);
    end = vi.fn().mockResolvedValue(true);
  },
}));

async function loadFactory(): Promise<typeof import('./deploy-client-factory.ts')> {
  return await import('./deploy-client-factory.ts');
}

describe('createDeployClient', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns an FtpClient for protocol=ftp (plain FTP must opt in via requireTls=false)', async () => {
    const { createDeployClient } = await loadFactory();
    const client = createDeployClient({
      protocol: 'ftp',
      host: 'ftp.example.com',
      port: 21,
      user: 'deploy',
      password: 'secret',
      requireTls: false,
    });
    expect(client.constructor.name).toBe('FtpClient');
  });

  it('returns an FtpClient for protocol=ftps', async () => {
    const { createDeployClient } = await loadFactory();
    const client = createDeployClient({
      protocol: 'ftps',
      host: 'ftp.example.com',
      port: 990,
      user: 'deploy',
      password: 'secret',
    });
    expect(client.constructor.name).toBe('FtpClient');
  });

  it('returns an SftpClient for protocol=sftp', async () => {
    const { createDeployClient } = await loadFactory();
    const client = createDeployClient({
      protocol: 'sftp',
      host: 'sftp.example.com',
      port: 22,
      user: 'deploy',
      password: 'secret',
    });
    expect(client.constructor.name).toBe('SftpClient');
  });

  it('accepts sshKeyPath for protocol=sftp (no constructor-time fs read)', async () => {
    // The SSH key permission check is deferred to connect(), so creating
    // an SftpClient with a non-existent key path must not throw at
    // construction. This keeps the factory cheap (used for `aiftp
    // doctor`'s connection check too).
    const { createDeployClient } = await loadFactory();
    const client = createDeployClient({
      protocol: 'sftp',
      host: 'sftp.example.com',
      port: 22,
      user: 'deploy',
      sshKeyPath: '/nonexistent/key',
    });
    expect(client.constructor.name).toBe('SftpClient');
  });

  it('throws for an unknown protocol', async () => {
    const { createDeployClient } = await loadFactory();
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberate invalid input
      createDeployClient({ protocol: 'gopher', host: 'h', user: 'u', password: 'p' } as any),
    ).toThrow(/unknown protocol|unsupported protocol/i);
  });

  it('exports a DeployClient union usable as a common interface', async () => {
    // Compile-time check: union narrows to the methods both clients share.
    // We exercise this by extracting a method reference and ensuring the
    // call type-checks. (TypeScript already enforces this at build time.)
    const { createDeployClient } = await loadFactory();
    const a = createDeployClient({
      protocol: 'ftps',
      host: 'h',
      port: 21,
      user: 'u',
      password: 'p',
    });
    const b = createDeployClient({
      protocol: 'sftp',
      host: 'h',
      port: 22,
      user: 'u',
      password: 'p',
    });
    expect(typeof a.upload).toBe('function');
    expect(typeof b.upload).toBe('function');
    expect(typeof a.disconnect).toBe('function');
    expect(typeof b.disconnect).toBe('function');
  });
});

describe('buildDeployClientOptions (v0.11 Pillar γ Codex Phase 1-1/2-1)', () => {
  // Helper to build a minimal Config that satisfies the schema for builder testing.
  // We cast through `as unknown as Config` because the builder only reads
  // a narrow set of fields.
  function makeConfig(overrides: Record<string, unknown> = {}): unknown {
    return {
      schema: 2,
      safety: {
        require_tls: true,
        verify_certificate: true,
      },
      connection: { timeout_ms: 60000 },
      quirks: { tls_check_hostname: true, noop_interval_sec: 0 },
      ...overrides,
    };
  }

  function makeProfile(overrides: Record<string, unknown> = {}) {
    return {
      host: 'srv.example.com',
      port: 22,
      protocol: 'sftp' as const,
      user: 'deploy',
      remote_root: '/var/www',
      local_root: '.',
      keychain_service: 'aiftp:test',
      server_kind: 'generic' as const,
      ...overrides,
    };
  }

  it('SFTP profile: sshKeyPath flows through, FTP-only props are dropped', async () => {
    const { buildDeployClientOptions } = await loadFactory();
    const opts = buildDeployClientOptions({
      // biome-ignore lint/suspicious/noExplicitAny: cast for narrow builder testing
      profile: makeProfile({ ssh_key_path: '~/.ssh/id_ed25519' }) as any,
      // biome-ignore lint/suspicious/noExplicitAny: cast for narrow builder testing
      config: makeConfig() as any,
      password: 'pw-from-keychain',
    });
    expect(opts.protocol).toBe('sftp');
    if (opts.protocol === 'sftp') {
      expect(opts.sshKeyPath).toBe('~/.ssh/id_ed25519');
      expect(opts.password).toBe('pw-from-keychain');
      // FTP-only fields MUST NOT leak into the SFTP options
      expect('requireTls' in opts).toBe(false);
      expect('verifyCertificate' in opts).toBe(false);
      expect('skipHostnameCheck' in opts).toBe(false);
      expect('noopIntervalSec' in opts).toBe(false);
    }
  });

  it('SFTP profile with empty password normalizes to undefined (key auth path)', async () => {
    const { buildDeployClientOptions } = await loadFactory();
    const opts = buildDeployClientOptions({
      // biome-ignore lint/suspicious/noExplicitAny: cast for narrow builder testing
      profile: makeProfile({ ssh_key_path: '/abs/path/id' }) as any,
      // biome-ignore lint/suspicious/noExplicitAny: cast for narrow builder testing
      config: makeConfig() as any,
      password: '',
    });
    if (opts.protocol === 'sftp') {
      expect(opts.password).toBeUndefined();
      expect(opts.sshKeyPath).toBe('/abs/path/id');
    }
  });

  it('FTPS profile: FTP knobs flow through, sshKeyPath is not surfaced', async () => {
    const { buildDeployClientOptions } = await loadFactory();
    const opts = buildDeployClientOptions({
      profile: makeProfile({
        protocol: 'ftps',
        port: 990,
        // biome-ignore lint/suspicious/noExplicitAny: cast for narrow builder testing
      }) as any,
      // biome-ignore lint/suspicious/noExplicitAny: cast for narrow builder testing
      config: makeConfig({ quirks: { tls_check_hostname: false, noop_interval_sec: 30 } }) as any,
      password: 'pw',
    });
    expect(opts.protocol).toBe('ftps');
    if (opts.protocol === 'ftps') {
      expect(opts.requireTls).toBe(true);
      expect(opts.verifyCertificate).toBe(true);
      expect(opts.skipHostnameCheck).toBe(true);
      expect(opts.noopIntervalSec).toBe(30);
      expect('sshKeyPath' in opts).toBe(false);
    }
  });
});
