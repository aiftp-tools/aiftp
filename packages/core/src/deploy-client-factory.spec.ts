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
