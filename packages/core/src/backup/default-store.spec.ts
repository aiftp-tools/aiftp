import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import FtpSrv from 'ftp-srv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPush } from '../deploy.js';
import { createExcluder } from '../exclude.js';
import { FtpClient, FtpConnectionError, FtpNotFoundError } from '../ftp-client.js';
import {
  type BackupFtpClient,
  backupKeyService,
  createDefaultBackupStore,
} from './default-store.js';
import { BackupError } from './store.js';

interface TestServer {
  port: number;
  root: string;
  username: string;
  password: string;
  stop: () => Promise<void>;
}

async function pickFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        server.close(() => resolve(address.port));
      } else {
        server.close(() => reject(new Error('Failed to pick port')));
      }
    });
  });
}

async function startTestServer(): Promise<TestServer> {
  const port = await pickFreePort();
  const root = await mkdtemp(join(tmpdir(), 'aiftp-backup-ftp-'));
  const username = 'testuser';
  const password = 'testpass';
  // ftp-srv is CJS; the default export is the constructor.
  // biome-ignore lint/suspicious/noExplicitAny: third-party CJS interop
  const Ctor: any = (FtpSrv as any).default ?? FtpSrv;
  // biome-ignore lint/suspicious/noExplicitAny: FtpSrv has no published types
  const server: any = new Ctor({
    url: `ftp://127.0.0.1:${port}`,
    anonymous: false,
    pasv_url: '127.0.0.1',
    pasv_min: 50101,
    pasv_max: 50200,
    log: {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
      child() {
        return this;
      },
    },
  });

  server.on(
    'login',
    (
      data: { username: string; password: string },
      resolveLogin: (response: { root: string }) => void,
      rejectLogin: (error: Error) => void,
    ) => {
      if (data.username === username && data.password === password) {
        resolveLogin({ root });
      } else {
        rejectLogin(new Error('Bad credentials'));
      }
    },
  );

  await server.listen();

  return {
    port,
    root,
    username,
    password,
    stop: async () => {
      try {
        await server.close();
      } catch {
        // ignore
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

function isListenDenied(error: unknown): boolean {
  return error instanceof Error && error.message.includes('listen EPERM');
}

describe('createDefaultBackupStore', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = join(tmpdir(), `aiftp-default-backup-store-test-${randomUUID()}`);
    await mkdir(join(cwd, 'site'), { recursive: true });
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
        'local_root = "site"',
        'keychain_service = "aiftp:production"',
        'server_kind = "starserver"',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('snapshots the remote version instead of the modified local file', async () => {
    const key = Buffer.alloc(32, 7);
    await writeFile(
      join(cwd, 'site', 'index.html'),
      '<h1>local modified and longer</h1>\n',
      'utf8',
    );
    const remoteContent = Buffer.from('<h1>remote before push</h1>\n', 'utf8');
    const remoteCalls: string[] = [];
    const ftpClient: BackupFtpClient = {
      connect: async () => {
        remoteCalls.push('connect');
      },
      isConnected: () => remoteCalls.includes('connect'),
      download: async (remotePath, localPath) => {
        remoteCalls.push(remotePath);
        await writeFile(localPath, remoteContent);
      },
    };

    const store = await createDefaultBackupStore({
      cwd,
      profileName: 'production',
      ftpClient,
      keychain: {
        getPassword: async (service, account) => {
          expect(service).toBe(backupKeyService('aiftp:production'));
          expect(account).toBe('production');
          return key.toString('base64');
        },
      },
    });
    const snapshot = await store.createAutoSnapshot([
      'index.html',
      '.aiftp/state/production/state.json',
      '.aiftp.toml',
    ]);

    expect(snapshot.files.map((file) => file.path)).toEqual(['index.html']);
    expect(snapshot.files[0]?.sizeOriginal).toBe(remoteContent.length);
    expect(snapshot.totalBytes).toBe(remoteContent.length);
    await expect(store.restoreFile(snapshot.id, 'index.html')).resolves.toEqual(remoteContent);
    expect(remoteCalls).toEqual(['connect', '/public_html/index.html']);
  });

  it('wraps FTP connection failures while reading remote backup sources', async () => {
    const key = Buffer.alloc(32, 7);
    const ftpClient: BackupFtpClient = {
      connect: async () => {
        throw new FtpConnectionError('connect: connection failed (ECONNRESET)');
      },
      isConnected: () => false,
      download: async () => undefined,
    };

    const store = await createDefaultBackupStore({
      cwd,
      profileName: 'production',
      ftpClient,
      keychain: {
        getPassword: async () => key.toString('base64'),
      },
    });

    await expect(store.createAutoSnapshot(['index.html'])).rejects.toThrow(BackupError);
  });

  it('skips snapshot entries when the remote source file no longer exists', async () => {
    const key = Buffer.alloc(32, 7);
    const ftpClient: BackupFtpClient = {
      connect: async () => undefined,
      isConnected: () => true,
      download: async (remotePath) => {
        throw new FtpNotFoundError(`download(${remotePath}): not found or permission denied (550)`);
      },
    };

    const store = await createDefaultBackupStore({
      cwd,
      profileName: 'production',
      ftpClient,
      keychain: {
        getPassword: async () => key.toString('base64'),
      },
    });

    const snapshot = await store.createAutoSnapshot(['index.html']);

    expect(snapshot.fileCount).toBe(0);
    expect(snapshot.totalBytes).toBe(0);
    expect(snapshot.files).toEqual([]);
  });
});

describe.sequential('createDefaultBackupStore FTP integration', () => {
  it('restores the original remote file after a modified file is pushed twice', async (context) => {
    let server: TestServer;
    try {
      server = await startTestServer();
    } catch (error: unknown) {
      if (isListenDenied(error)) {
        context.skip();
      }
      throw error;
    }
    const cwd = await mkdtemp(join(tmpdir(), 'aiftp-backup-push-'));
    const localRoot = join(cwd, 'site');
    const key = Buffer.alloc(32, 7);
    const originalContent = Buffer.from('<h1>original remote</h1>\n', 'utf8');
    const modifiedContent = Buffer.from('<h1>modified local</h1>\n', 'utf8');
    const client = new FtpClient({
      host: '127.0.0.1',
      port: server.port,
      user: server.username,
      password: server.password,
      protocol: 'ftp',
      requireTls: false,
      timeoutMs: 5_000,
    });

    try {
      await mkdir(localRoot, { recursive: true });
      await writeFile(
        join(cwd, '.aiftp.toml'),
        [
          'schema = 1',
          '',
          '[profile.production]',
          'host = "127.0.0.1"',
          `port = ${server.port}`,
          'protocol = "ftp"',
          `user = "${server.username}"`,
          'remote_root = "/public_html"',
          'local_root = "site"',
          'keychain_service = "aiftp:test"',
          'server_kind = "generic"',
          '',
          '[safety]',
          'require_tls = false',
          '',
        ].join('\n'),
        'utf8',
      );
      await client.connect();
      await client.mkdir('public_html');
      await writeFile(join(localRoot, 'index.html'), originalContent);

      const keychain = {
        getPassword: async () => key.toString('base64'),
      };
      const uploader = {
        upload: (localPath: string, remotePath: string) => client.upload(localPath, remotePath),
        size: (remotePath: string) => client.size(remotePath),
      };
      const firstStore = await createDefaultBackupStore({
        cwd,
        profileName: 'production',
        keychain,
        ftpClient: client,
      });
      const first = await runPush({
        localRoot,
        remoteRoot: '/public_html',
        state: { schema: 1, files: {} },
        excluder: createExcluder(),
        backupStore: firstStore,
        uploader,
      });
      // v0.10.0: an added-only push records schema 2 tombstone
      // entries for new remote files so rollback can delete them,
      // while still keeping `aiftp backup list` available after
      // every push.
      expect(first.backupSnapshot).not.toBeNull();
      expect(first.backupSnapshot?.type).toBe('auto');
      expect(first.backupSnapshot?.fileCount).toBe(1);
      expect(first.backupSnapshot?.counts).toEqual({ added: 1, modified: 0, removed: 0 });

      await writeFile(join(localRoot, 'index.html'), modifiedContent);
      const secondStore = await createDefaultBackupStore({
        cwd,
        profileName: 'production',
        keychain,
        ftpClient: client,
      });
      const second = await runPush({
        localRoot,
        remoteRoot: '/public_html',
        state: first.nextState,
        excluder: createExcluder(),
        backupStore: secondStore,
        uploader,
      });

      await expect(
        secondStore.restoreFile(second.backupSnapshot?.id ?? '', 'index.html'),
      ).resolves.toEqual(originalContent);
      const downloaded = join(cwd, 'downloaded-index.html');
      await client.download('/public_html/index.html', downloaded);
      await expect(readFile(downloaded)).resolves.toEqual(modifiedContent);
    } finally {
      await client.disconnect();
      await server.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
