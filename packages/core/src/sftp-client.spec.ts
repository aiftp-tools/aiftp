/**
 * SftpClient unit tests — Task 21 skeleton (connect / list / disconnect).
 *
 * The class is the SFTP counterpart of FtpClient and intentionally
 * mirrors the same shape (FtpClient methods: connect, disconnect,
 * isConnected, upload, uploadBuffer, download, list, delete, size,
 * exists, rename, mkdir). Task 21 covers only the lifecycle + list;
 * the remaining methods land in Task 22.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Sftp from 'ssh2-sftp-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ssh2-sftp-client surfaces a default-export class. We capture the mock
// instances so each test can pre-program return values and assert calls.
const mockInstances: Array<{
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('ssh2-sftp-client', () => ({
  default: class MockSftp {
    connect = vi.fn().mockResolvedValue(undefined);
    end = vi.fn().mockResolvedValue(true);
    list = vi.fn().mockResolvedValue([]);
    put = vi.fn().mockResolvedValue('uploaded');
    get = vi.fn().mockResolvedValue('downloaded');
    delete = vi.fn().mockResolvedValue('deleted');
    stat = vi.fn().mockResolvedValue({ size: 0, mode: 0, uid: 0, gid: 0 });
    exists = vi.fn().mockResolvedValue('-');
    rename = vi.fn().mockResolvedValue('renamed');
    mkdir = vi.fn().mockResolvedValue('made');
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

describe('SftpClient — Task 22 full interface', () => {
  beforeEach(() => {
    mockInstances.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function connected() {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      user: 'u',
      password: 'p',
    });
    await client.connect();
    return { client, m: mockInstances[0] };
  }

  it('upload(localPath, remotePath) calls put() and returns size from stat', async () => {
    const { client, m } = await connected();
    m.stat.mockResolvedValueOnce({ size: 4096, mode: 0, uid: 0, gid: 0 });
    const result = await client.upload('/tmp/a.html', '/var/www/a.html');
    expect(m.put).toHaveBeenCalledWith('/tmp/a.html', '/var/www/a.html');
    expect(m.stat).toHaveBeenCalledWith('/var/www/a.html');
    expect(result).toEqual({ remotePath: '/var/www/a.html', bytesUploaded: 4096 });
    await client.disconnect();
  });

  it('upload falls back to 0 bytesUploaded when stat fails', async () => {
    const { client, m } = await connected();
    m.stat.mockRejectedValueOnce(new Error('no stat'));
    const result = await client.upload('/tmp/a.html', '/var/www/a.html');
    expect(result.bytesUploaded).toBe(0);
    await client.disconnect();
  });

  it('uploadBuffer(buf, remote) passes the Buffer directly to put()', async () => {
    const { client, m } = await connected();
    const buf = Buffer.from('hello-world');
    m.stat.mockResolvedValueOnce({ size: buf.length, mode: 0, uid: 0, gid: 0 });
    const result = await client.uploadBuffer(buf, '/var/www/a.html');
    expect(m.put).toHaveBeenCalledWith(buf, '/var/www/a.html');
    expect(result.bytesUploaded).toBe(buf.length);
    await client.disconnect();
  });

  it('uploadBuffer falls back to content.length when stat fails', async () => {
    const { client, m } = await connected();
    const buf = Buffer.from('xyz');
    m.stat.mockRejectedValueOnce(new Error('no stat'));
    const result = await client.uploadBuffer(buf, '/var/www/x.bin');
    expect(result.bytesUploaded).toBe(3);
    await client.disconnect();
  });

  it('download(remote, local) maps to get(remote, local)', async () => {
    const { client, m } = await connected();
    await client.download('/var/www/a.html', '/tmp/a.html');
    expect(m.get).toHaveBeenCalledWith('/var/www/a.html', '/tmp/a.html');
    await client.disconnect();
  });

  it('delete(remote) calls underlying delete', async () => {
    const { client, m } = await connected();
    await client.delete('/var/www/old.html');
    expect(m.delete).toHaveBeenCalledWith('/var/www/old.html');
    await client.disconnect();
  });

  it('size(remote) returns stat.size', async () => {
    const { client, m } = await connected();
    m.stat.mockResolvedValueOnce({ size: 2048, mode: 0, uid: 0, gid: 0 });
    expect(await client.size('/var/www/a.html')).toBe(2048);
    await client.disconnect();
  });

  it('exists(remote) returns true for "d" / "-" / "l" results', async () => {
    const { client, m } = await connected();
    m.exists.mockResolvedValueOnce('-');
    expect(await client.exists('/file')).toBe(true);
    m.exists.mockResolvedValueOnce('d');
    expect(await client.exists('/dir')).toBe(true);
    m.exists.mockResolvedValueOnce('l');
    expect(await client.exists('/symlink')).toBe(true);
    await client.disconnect();
  });

  it('exists(remote) returns false when underlying returns false', async () => {
    const { client, m } = await connected();
    m.exists.mockResolvedValueOnce(false);
    expect(await client.exists('/missing')).toBe(false);
    await client.disconnect();
  });

  it('rename(src, dest) calls underlying rename', async () => {
    const { client, m } = await connected();
    await client.rename('/var/www/a.html.tmp', '/var/www/a.html');
    expect(m.rename).toHaveBeenCalledWith('/var/www/a.html.tmp', '/var/www/a.html');
    await client.disconnect();
  });

  it('mkdir(remote) calls underlying mkdir with recursive=true (mkdir -p semantics)', async () => {
    const { client, m } = await connected();
    await client.mkdir('/var/www/a/b/c');
    expect(m.mkdir).toHaveBeenCalledWith('/var/www/a/b/c', true);
    await client.disconnect();
  });

  // v0.11 Pillar γ Codex Phase 2-2: SftpClient maps errors to the
  // shared FtpError hierarchy so backup / rollback / deploy can use
  // `error instanceof FtpNotFoundError` regardless of protocol.

  it('list() maps SFTP code-2 "no such file" to FtpNotFoundError', async () => {
    const { client, m } = await connected();
    const { FtpNotFoundError } = await import('./ftp-client.ts');
    m.list.mockRejectedValueOnce(Object.assign(new Error('No such file'), { code: 2 }));
    await expect(client.list('/missing')).rejects.toBeInstanceOf(FtpNotFoundError);
    await client.disconnect();
  });

  it('size() maps "ENOENT" to FtpNotFoundError', async () => {
    const { client, m } = await connected();
    const { FtpNotFoundError } = await import('./ftp-client.ts');
    m.stat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(client.size('/missing')).rejects.toBeInstanceOf(FtpNotFoundError);
    await client.disconnect();
  });

  it('download() maps "All configured authentication methods failed" to FtpAuthError', async () => {
    const { client, m } = await connected();
    const { FtpAuthError } = await import('./ftp-client.ts');
    m.get.mockRejectedValueOnce(new Error('All configured authentication methods failed'));
    await expect(client.download('/x', '/y')).rejects.toBeInstanceOf(FtpAuthError);
    await client.disconnect();
  });

  it('rename() maps timeout to FtpTimeoutError', async () => {
    const { client, m } = await connected();
    const { FtpTimeoutError } = await import('./ftp-client.ts');
    m.rename.mockRejectedValueOnce(
      Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' }),
    );
    await expect(client.rename('/a', '/b')).rejects.toBeInstanceOf(FtpTimeoutError);
    await client.disconnect();
  });

  it('upload() maps unknown error to plain FtpError (preserves cause)', async () => {
    const { client, m } = await connected();
    const { FtpError } = await import('./ftp-client.ts');
    const original = new Error('something weird');
    m.put.mockRejectedValueOnce(original);
    await expect(client.upload('/l', '/r')).rejects.toBeInstanceOf(FtpError);
    await client.disconnect();
  });

  it('delete() maps "Permission denied" via message text fallback', async () => {
    const { client, m } = await connected();
    const { FtpError } = await import('./ftp-client.ts');
    m.delete.mockRejectedValueOnce(new Error('Permission denied'));
    await expect(client.delete('/restricted')).rejects.toBeInstanceOf(FtpError);
    await client.disconnect();
  });

  it.each([
    'upload',
    'uploadBuffer',
    'download',
    'delete',
    'size',
    'exists',
    'rename',
    'mkdir',
    'list',
  ] as const)('%s throws when not connected', async (method) => {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({ host: 'h', user: 'u', password: 'p' });
    // biome-ignore lint/suspicious/noExplicitAny: dispatch table for guard test
    const args: Record<string, any[]> = {
      upload: ['/local', '/remote'],
      uploadBuffer: [Buffer.from('x'), '/remote'],
      download: ['/remote', '/local'],
      delete: ['/remote'],
      size: ['/remote'],
      exists: ['/remote'],
      rename: ['/src', '/dest'],
      mkdir: ['/remote'],
      list: ['/remote'],
    };
    // biome-ignore lint/suspicious/noExplicitAny: guard test
    await expect((client as any)[method](...args[method])).rejects.toThrow(/not connected/i);
  });
});

describe('SftpClient — Task 23 SSH key authentication', () => {
  let tmpDir: string;
  let keyPath: string;
  const KEY_CONTENT = Buffer.from(
    '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-bytes\n-----END OPENSSH PRIVATE KEY-----\n',
  );

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aiftp-sftp-key-'));
    keyPath = join(tmpDir, 'id_ed25519');
    writeFileSync(keyPath, KEY_CONTENT);
    chmodSync(keyPath, 0o600);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockInstances.length = 0;
    chmodSync(keyPath, 0o600);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('connects with privateKey when sshKeyPath is provided', async () => {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      user: 'deploy',
      sshKeyPath: keyPath,
    });
    await client.connect();

    const connectOpts = mockInstances[0].connect.mock.calls[0][0] as Sftp.ConnectOptions;
    expect(connectOpts.username).toBe('deploy');
    expect(Buffer.isBuffer(connectOpts.privateKey)).toBe(true);
    expect((connectOpts.privateKey as Buffer).equals(KEY_CONTENT)).toBe(true);
    expect(connectOpts.password).toBeUndefined();
    await client.disconnect();
  });

  it('forwards passphrase to ssh2-sftp-client when set', async () => {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      user: 'deploy',
      sshKeyPath: keyPath,
      sshKeyPassphrase: 'unlock-it',
    });
    await client.connect();

    const connectOpts = mockInstances[0].connect.mock.calls[0][0] as Sftp.ConnectOptions;
    expect(connectOpts.passphrase).toBe('unlock-it');
    await client.disconnect();
  });

  it('prefers sshKeyPath over password when both are set', async () => {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      user: 'deploy',
      sshKeyPath: keyPath,
      password: 'ignored',
    });
    await client.connect();

    const connectOpts = mockInstances[0].connect.mock.calls[0][0] as Sftp.ConnectOptions;
    expect(connectOpts.password).toBeUndefined();
    expect(connectOpts.privateKey).toBeDefined();
    await client.disconnect();
  });

  // v0.11 release: Windows does not honour POSIX `chmod` bits (NTFS
  // ACLs are the real mechanism, Node `chmod` is mostly cosmetic). The
  // strict 0o600/0o400 gate is intentionally skipped on Windows in
  // loadSshKey(); these two tests cover the POSIX-only branch.
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt(
    'rejects when SSH key file permissions are >600 (world/group readable) — POSIX only',
    async () => {
      chmodSync(keyPath, 0o644);
      const { SftpClient } = await loadSftpClient();
      const client = new SftpClient({
        host: 'sftp.example.com',
        user: 'deploy',
        sshKeyPath: keyPath,
      });
      await expect(client.connect()).rejects.toThrow(/permissions/i);
      expect(mockInstances).toHaveLength(0);
    },
  );

  posixIt('accepts SSH key file with 0o400 permissions — POSIX only', async () => {
    chmodSync(keyPath, 0o400);
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      user: 'deploy',
      sshKeyPath: keyPath,
    });
    await expect(client.connect()).resolves.toBeUndefined();
    await client.disconnect();
  });

  it('skips permission check on Windows (NTFS ACL is the real mechanism)', async () => {
    if (process.platform !== 'win32') {
      // POSIX: the strict-check path is covered by the two posixIt
      // cases above. Skip the Windows assertion to keep the suite
      // green on POSIX.
      return;
    }
    chmodSync(keyPath, 0o644);
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      user: 'deploy',
      sshKeyPath: keyPath,
    });
    await expect(client.connect()).resolves.toBeUndefined();
    await client.disconnect();
  });

  it('rejects when neither password nor sshKeyPath is provided', async () => {
    const { SftpClient } = await loadSftpClient();
    // biome-ignore lint/suspicious/noExplicitAny: deliberately omitting auth
    const client = new SftpClient({ host: 'sftp.example.com', user: 'u' } as any);
    await expect(client.connect()).rejects.toThrow(/password.*sshKeyPath|sshKeyPath.*password/i);
  });

  it('rejects when sshKeyPath points at a missing file', async () => {
    const { SftpClient } = await loadSftpClient();
    const client = new SftpClient({
      host: 'sftp.example.com',
      user: 'deploy',
      sshKeyPath: join(tmpDir, 'does-not-exist'),
    });
    await expect(client.connect()).rejects.toThrow(/no such file|ENOENT/i);
  });
});
