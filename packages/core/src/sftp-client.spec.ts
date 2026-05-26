/**
 * SftpClient unit tests — Task 21 skeleton (connect / list / disconnect).
 *
 * The class is the SFTP counterpart of FtpClient and intentionally
 * mirrors the same shape (FtpClient methods: connect, disconnect,
 * isConnected, upload, uploadBuffer, download, list, delete, size,
 * exists, rename, mkdir). Task 21 covers only the lifecycle + list;
 * the remaining methods land in Task 22.
 */

import type * as Sftp from 'ssh2-sftp-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ssh2-sftp-client surfaces a default-export class. We capture the mock
// instances so each test can pre-program return values and assert calls.
const mockInstances: Array<{
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('ssh2-sftp-client', () => ({
  default: class MockSftp {
    connect = vi.fn().mockResolvedValue(undefined);
    end = vi.fn().mockResolvedValue(true);
    list = vi.fn().mockResolvedValue([]);
    constructor() {
      mockInstances.push(this);
    }
  },
}));

// Lazy import so the module under test picks up the mock.
async function loadSftpClient(): Promise<typeof import('./sftp-client.ts')> {
  return await import('./sftp-client.ts');
}

describe('SftpClient — Task 21 skeleton', () => {
  beforeEach(() => {
    mockInstances.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the shared client lifecycle (connect / isConnected / disconnect)', async () => {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      port: 22,
      user: 'deploy',
      password: 'secret',
    });
    expect(client.isConnected()).toBe(false);

    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0].connect).toHaveBeenCalledTimes(1);

    await client.disconnect();
    expect(client.isConnected()).toBe(false);
    expect(mockInstances[0].end).toHaveBeenCalledTimes(1);
  });

  it('connect passes host / port / username / password to ssh2-sftp-client', async () => {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      port: 2222,
      user: 'deploy-user',
      password: 'secret-password',
    });
    await client.connect();

    const connectOpts = mockInstances[0].connect.mock.calls[0][0] as Sftp.ConnectOptions;
    expect(connectOpts.host).toBe('sftp.example.com');
    expect(connectOpts.port).toBe(2222);
    expect(connectOpts.username).toBe('deploy-user');
    expect(connectOpts.password).toBe('secret-password');

    await client.disconnect();
  });

  it('defaults port to 22 when not provided', async () => {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      user: 'u',
      password: 'p',
    });
    await client.connect();
    const connectOpts = mockInstances[0].connect.mock.calls[0][0] as Sftp.ConnectOptions;
    expect(connectOpts.port).toBe(22);
    await client.disconnect();
  });

  it('list() maps ssh2-sftp-client FileInfo to ListEntry', async () => {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      user: 'u',
      password: 'p',
    });
    await client.connect();

    const fixedTime = 1_700_000_000_000;
    mockInstances[0].list.mockResolvedValueOnce([
      { type: '-', name: 'index.html', size: 1024, modifyTime: fixedTime },
      { type: 'd', name: 'images', size: 0, modifyTime: fixedTime },
      { type: 'l', name: 'symlink', size: 0, modifyTime: fixedTime },
    ]);

    const entries = await client.list('/var/www/html');
    expect(mockInstances[0].list).toHaveBeenCalledWith('/var/www/html');
    expect(entries).toEqual([
      {
        name: 'index.html',
        size: 1024,
        type: 'file',
        modifiedAt: new Date(fixedTime),
      },
      {
        name: 'images',
        size: 0,
        type: 'directory',
        modifiedAt: new Date(fixedTime),
      },
      {
        name: 'symlink',
        size: 0,
        type: 'unknown',
        modifiedAt: new Date(fixedTime),
      },
    ]);

    await client.disconnect();
  });

  it('throws when calling list before connect', async () => {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      user: 'u',
      password: 'p',
    });
    await expect(client.list('/')).rejects.toThrow(/not connected/i);
  });

  it('disconnect is a no-op when never connected', async () => {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      user: 'u',
      password: 'p',
    });
    await expect(client.disconnect()).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(false);
  });

  it('requires a host', async () => {
    const { SftpClient } = await loadSftpClient();
    expect(() => new SftpClient({ host: '', user: 'u', password: 'p' })).toThrow(
      /host is required/i,
    );
  });
});
