import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BackupSource, BackupStore } from './backup/store.js';
import {
  DeployLimitError,
  type DeployLock,
  type DeployUploader,
  DeployVerificationError,
  runPush,
  runStatus,
} from './deploy.js';
import { generateKey } from './encryption.js';
import { createExcluder } from './exclude.js';
import { PreflightError, type PreflightReport } from './preflight.js';
import { type State, computeHash } from './state.js';

describe('deploy engine', () => {
  let localRoot: string;
  let backupRoot: string;
  let remoteFiles: Map<string, Buffer>;
  let uploaded: Array<{ localPath: string; remotePath: string }>;
  let deleted: string[];

  beforeEach(async () => {
    localRoot = join(tmpdir(), `aiftp-deploy-local-${randomUUID()}`);
    backupRoot = join(tmpdir(), `aiftp-deploy-backup-${randomUUID()}`);
    await mkdir(localRoot, { recursive: true });
    await mkdir(backupRoot, { recursive: true });
    remoteFiles = new Map<string, Buffer>([
      ['index.html', Buffer.from('<h1>remote old</h1>\n', 'utf8')],
    ]);
    uploaded = [];
    deleted = [];
  });

  afterEach(async () => {
    await rm(localRoot, { recursive: true, force: true });
    await rm(backupRoot, { recursive: true, force: true });
  });

  async function writeLocal(path: string, content: string): Promise<void> {
    const filePath = join(localRoot, ...path.split('/'));
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }

  function createBackupStore(): BackupStore {
    const source: BackupSource = {
      readFile: async (path: string) => {
        const data = remoteFiles.get(path);
        return data ?? null;
      },
    };
    return new BackupStore({
      rootDir: backupRoot,
      key: generateKey(),
      source,
      excluder: createExcluder(),
      now: () => new Date('2026-05-18T12:30:00.000Z'),
    });
  }

  function createUploader(options: { wrongSize?: boolean; fail?: boolean } = {}): DeployUploader {
    return {
      upload: async (localPath: string, remotePath: string) => {
        if (options.fail) {
          throw new Error('upload failed');
        }
        uploaded.push({ localPath, remotePath });
        const info = await stat(localPath);
        return { remotePath, bytesUploaded: options.wrongSize ? info.size + 1 : info.size };
      },
      delete: async (remotePath: string) => {
        deleted.push(remotePath);
        remoteFiles.delete(remotePath.replace(/^\/public_html\//u, ''));
      },
      size: async (remotePath: string) => {
        const record = uploaded.find((entry) => entry.remotePath === remotePath);
        if (!record) {
          throw new Error(`not uploaded: ${remotePath}`);
        }
        const info = await stat(record.localPath);
        return options.wrongSize ? info.size + 1 : info.size;
      },
    };
  }

  it('reports status from local files and state', async () => {
    await writeLocal('index.html', '<h1>same</h1>\n');
    await writeLocal('about.html', '<p>new</p>\n');
    const state: State = {
      schema: 1,
      files: {
        'index.html': {
          hash: await computeHash(join(localRoot, 'index.html')),
          size: 14,
          updatedAt: '2026-05-18T10:00:00.000Z',
        },
        'old.html': {
          hash: 'removed',
          size: 10,
          updatedAt: '2026-05-18T10:00:00.000Z',
        },
      },
    };

    await expect(runStatus({ localRoot, state, excluder: createExcluder() })).resolves.toEqual({
      diff: {
        added: ['about.html'],
        modified: [],
        removed: ['old.html'],
        unchanged: ['index.html'],
      },
      counts: {
        added: 1,
        modified: 0,
        removed: 1,
        unchanged: 1,
      },
    });
  });

  it('dry-runs push without uploading, backing up, or mutating state', async () => {
    await writeLocal('index.html', '<h1>changed</h1>\n');
    const state: State = {
      schema: 1,
      files: {
        'index.html': {
          hash: 'old-hash',
          size: 10,
          updatedAt: '2026-05-18T10:00:00.000Z',
        },
      },
    };
    const backupStore = createBackupStore();

    const result = await runPush({
      localRoot,
      remoteRoot: '/public_html',
      state,
      excluder: createExcluder(),
      backupStore,
      uploader: createUploader(),
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.uploaded).toEqual([]);
    expect(result.backupSnapshot).toBeNull();
    expect(result.nextState).toBe(state);
    expect(await backupStore.listSnapshots()).toEqual([]);
    expect(uploaded).toEqual([]);
  });

  it('backs up modified files, uploads changed files, and returns an updated state', async () => {
    await writeLocal('index.html', '<h1>local changed</h1>\n');
    await writeLocal('about.html', '<p>new</p>\n');
    const state: State = {
      schema: 1,
      files: {
        'index.html': {
          hash: 'old-hash',
          size: 10,
          updatedAt: '2026-05-18T10:00:00.000Z',
        },
      },
    };
    const backupStore = createBackupStore();

    const result = await runPush({
      localRoot,
      remoteRoot: '/public_html',
      state,
      excluder: createExcluder(),
      backupStore,
      uploader: createUploader(),
      now: () => new Date('2026-05-18T12:31:00.000Z'),
    });

    expect(result.uploaded.map((entry) => entry.path)).toEqual(['about.html', 'index.html']);
    expect(result.backupSnapshot?.files.map((file) => [file.path, file.operation])).toEqual([
      ['about.html', 'added'],
      ['index.html', 'modified'],
    ]);
    await expect(
      backupStore.restoreFile(result.backupSnapshot?.id ?? '', 'index.html'),
    ).resolves.toEqual(remoteFiles.get('index.html'));
    expect(uploaded.map((entry) => entry.remotePath)).toEqual([
      '/public_html/about.html',
      '/public_html/index.html',
    ]);
    expect(result.nextState).not.toBe(state);
    expect(result.nextState.files['about.html']?.updatedAt).toBe('2026-05-18T12:31:00.000Z');
    expect(result.nextState.files['index.html']?.hash).toBe(
      await computeHash(join(localRoot, 'index.html')),
    );
  });

  it('creates an added tombstone snapshot and uploads added-only pushes', async () => {
    await writeLocal('first.html', '<h1>first push</h1>\n');
    const backupReads: string[] = [];
    const backupStore = new BackupStore({
      rootDir: backupRoot,
      key: generateKey(),
      source: {
        readFile: async (path) => {
          backupReads.push(path);
          return remoteFiles.get(path) ?? null;
        },
      },
      excluder: createExcluder(),
      now: () => new Date('2026-05-18T12:30:00.000Z'),
    });

    const result = await runPush({
      localRoot,
      remoteRoot: '/public_html',
      state: { schema: 1, files: {} },
      excluder: createExcluder(),
      backupStore,
      uploader: createUploader(),
      now: () => new Date('2026-05-18T12:31:00.000Z'),
    });

    expect(result.planned).toEqual(['first.html']);
    expect(result.plannedDeletes).toEqual([]);
    expect(result.uploaded.map((entry) => entry.path)).toEqual(['first.html']);
    expect(result.backupSnapshot).not.toBeNull();
    expect(result.backupSnapshot?.type).toBe('auto');
    expect(result.backupSnapshot?.counts).toEqual({ added: 1, modified: 0, removed: 0 });
    expect(result.backupSnapshot?.files).toEqual([
      expect.objectContaining({ path: 'first.html', operation: 'added', storedName: null }),
    ]);
    expect(backupReads).toEqual([]);
    await expect(backupStore.listSnapshots()).resolves.toHaveLength(1);
  });

  it('prune-auto snapshots removed content, uploads first, deletes second, and removes state entries', async () => {
    await writeLocal('index.html', '<h1>changed</h1>\n');
    remoteFiles.set('old.html', Buffer.from('<p>remote removed</p>\n', 'utf8'));
    const events: string[] = [];
    const backupStore = createBackupStore();
    const uploader: DeployUploader = {
      upload: async (localPath, remotePath) => {
        events.push(`upload:${remotePath}`);
        uploaded.push({ localPath, remotePath });
        const info = await stat(localPath);
        return { remotePath, bytesUploaded: info.size };
      },
      delete: async (remotePath) => {
        events.push(`delete:${remotePath}`);
        deleted.push(remotePath);
        remoteFiles.delete(remotePath.replace(/^\/public_html\//u, ''));
      },
      size: async (remotePath) => {
        const record = uploaded.find((entry) => entry.remotePath === remotePath);
        if (!record) throw new Error(`not uploaded: ${remotePath}`);
        return (await stat(record.localPath)).size;
      },
    };

    const result = await runPush({
      localRoot,
      remoteRoot: '/public_html',
      state: {
        schema: 1,
        files: {
          'index.html': {
            hash: 'old-hash',
            size: 10,
            updatedAt: '2026-05-18T10:00:00.000Z',
          },
          'old.html': {
            hash: 'old-remote-hash',
            size: 22,
            updatedAt: '2026-05-18T10:00:00.000Z',
          },
        },
      },
      excluder: createExcluder(),
      backupStore,
      uploader,
      safety: { deletionPolicy: 'prune-auto' },
    });

    expect(result.planned).toEqual(['index.html']);
    expect(result.plannedDeletes).toEqual(['old.html']);
    expect(result.deleted).toEqual([{ path: 'old.html', remotePath: '/public_html/old.html' }]);
    expect(events).toEqual(['upload:/public_html/index.html', 'delete:/public_html/old.html']);
    expect(result.backupSnapshot?.counts).toEqual({ added: 0, modified: 1, removed: 1 });
    expect(result.backupSnapshot?.files.map((file) => [file.path, file.operation])).toEqual([
      ['index.html', 'modified'],
      ['old.html', 'removed'],
    ]);
    await expect(
      backupStore.restoreFile(result.backupSnapshot?.id ?? '', 'old.html'),
    ).resolves.toEqual(Buffer.from('<p>remote removed</p>\n', 'utf8'));
    expect(result.nextState.files['old.html']).toBeUndefined();
  });

  it('deletionPolicy never does not delete and does not record removed operations', async () => {
    remoteFiles.set('old.html', Buffer.from('<p>remote removed</p>\n', 'utf8'));
    const backupReads: string[] = [];
    const backupStore = new BackupStore({
      rootDir: backupRoot,
      key: generateKey(),
      source: {
        readFile: async (path) => {
          backupReads.push(path);
          return remoteFiles.get(path) ?? null;
        },
      },
      excluder: createExcluder(),
      now: () => new Date('2026-05-18T12:30:00.000Z'),
    });

    const result = await runPush({
      localRoot,
      remoteRoot: '/public_html',
      state: {
        schema: 1,
        files: {
          'old.html': {
            hash: 'old-remote-hash',
            size: 22,
            updatedAt: '2026-05-18T10:00:00.000Z',
          },
        },
      },
      excluder: createExcluder(),
      backupStore,
      uploader: createUploader(),
      safety: { deletionPolicy: 'never' },
    });

    expect(result.diff.removed).toEqual(['old.html']);
    expect(result.planned).toEqual([]);
    expect(result.plannedDeletes).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.backupSnapshot).toBeNull();
    expect(result.nextState.files['old.html']).toBeDefined();
    expect(backupReads).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('never deletes hard-excluded removed entries', async () => {
    remoteFiles.set('.env', Buffer.from('SECRET=value\n', 'utf8'));

    const result = await runPush({
      localRoot,
      remoteRoot: '/public_html',
      state: {
        schema: 1,
        files: {
          '.env': {
            hash: 'secret-hash',
            size: 13,
            updatedAt: '2026-05-18T10:00:00.000Z',
          },
        },
      },
      excluder: createExcluder(),
      backupStore: createBackupStore(),
      uploader: createUploader(),
      safety: { deletionPolicy: 'prune-auto' },
    });

    expect(result.diff.removed).toEqual([]);
    expect(result.plannedDeletes).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.backupSnapshot).toBeNull();
    expect(result.nextState.files['.env']).toBeDefined();
    expect(deleted).toEqual([]);
  });

  it('prune-with-confirm requires delete acknowledgment when deletes are planned', async () => {
    remoteFiles.set('old.html', Buffer.from('<p>remote removed</p>\n', 'utf8'));

    await expect(
      runPush({
        localRoot,
        remoteRoot: '/public_html',
        state: {
          schema: 1,
          files: {
            'old.html': {
              hash: 'old-remote-hash',
              size: 22,
              updatedAt: '2026-05-18T10:00:00.000Z',
            },
          },
        },
        excluder: createExcluder(),
        backupStore: createBackupStore(),
        uploader: createUploader(),
        safety: { deletionPolicy: 'prune-with-confirm' },
      }),
    ).rejects.toThrow(DeployLimitError);

    expect(deleted).toEqual([]);
  });

  it('counts planned deletes toward maxFilesPerPush', async () => {
    remoteFiles.set('old-a.html', Buffer.from('<p>a</p>\n', 'utf8'));
    remoteFiles.set('old-b.html', Buffer.from('<p>b</p>\n', 'utf8'));

    await expect(
      runPush({
        localRoot,
        remoteRoot: '/public_html',
        state: {
          schema: 1,
          files: {
            'old-a.html': {
              hash: 'old-a',
              size: 9,
              updatedAt: '2026-05-18T10:00:00.000Z',
            },
            'old-b.html': {
              hash: 'old-b',
              size: 9,
              updatedAt: '2026-05-18T10:00:00.000Z',
            },
          },
        },
        excluder: createExcluder(),
        backupStore: createBackupStore(),
        uploader: createUploader(),
        safety: { deletionPolicy: 'prune-auto', maxFilesPerPush: 1 },
      }),
    ).rejects.toThrow(DeployLimitError);

    expect(deleted).toEqual([]);
  });

  it('treats remote not-found during delete as already pruned and removes state', async () => {
    const notFound = new Error('not found');
    notFound.name = 'FtpNotFoundError';

    const result = await runPush({
      localRoot,
      remoteRoot: '/public_html',
      state: {
        schema: 1,
        files: {
          'already-gone.html': {
            hash: 'gone',
            size: 9,
            updatedAt: '2026-05-18T10:00:00.000Z',
          },
        },
      },
      excluder: createExcluder(),
      backupStore: createBackupStore(),
      uploader: {
        upload: async (localPath, remotePath) => {
          const info = await stat(localPath);
          return { remotePath, bytesUploaded: info.size };
        },
        delete: async () => {
          throw notFound;
        },
      },
      safety: { deletionPolicy: 'prune-auto' },
    });

    expect(result.deleted).toEqual([
      { path: 'already-gone.html', remotePath: '/public_html/already-gone.html' },
    ]);
    expect(result.nextState.files['already-gone.html']).toBeUndefined();
  });

  it('acquires the deployment lock before backup snapshot reads remote content', async () => {
    await writeLocal('index.html', '<h1>local changed</h1>\n');
    const events: string[] = [];
    const remoteContent = Buffer.from('<h1>remote before push</h1>\n', 'utf8');
    const backupStore = new BackupStore({
      rootDir: backupRoot,
      key: generateKey(),
      source: {
        readFile: async (path) => {
          events.push(`backup:${path}`);
          return remoteContent;
        },
      },
      excluder: createExcluder(),
      now: () => new Date('2026-05-18T12:30:00.000Z'),
    });
    const uploader: DeployUploader = {
      upload: async (localPath, remotePath) => {
        events.push(`upload:${remotePath}`);
        const info = await stat(localPath);
        return { remotePath, bytesUploaded: info.size };
      },
      delete: async (remotePath) => {
        deleted.push(remotePath);
      },
    };

    const result = await runPush({
      localRoot,
      remoteRoot: '/public_html',
      state: {
        schema: 1,
        files: {
          'index.html': {
            hash: 'old-hash',
            size: 10,
            updatedAt: '2026-05-18T10:00:00.000Z',
          },
        },
      },
      excluder: createExcluder(),
      backupStore,
      uploader,
      lock: {
        acquire: async () => {
          events.push('acquire');
        },
        release: async () => {
          events.push('release');
        },
      },
    });

    await expect(
      backupStore.restoreFile(result.backupSnapshot?.id ?? '', 'index.html'),
    ).resolves.toEqual(remoteContent);
    expect(events).toEqual([
      'acquire',
      'backup:index.html',
      'upload:/public_html/index.html',
      'release',
    ]);
  });

  it('halts before backup/upload when safety limits would be exceeded', async () => {
    await writeLocal('big.html', '0123456789\n');
    const backupStore = createBackupStore();

    await expect(
      runPush({
        localRoot,
        state: { schema: 1, files: {} },
        excluder: createExcluder(),
        backupStore,
        uploader: createUploader(),
        safety: { maxFilesPerPush: 1, maxTotalSizeBytes: 5 },
      }),
    ).rejects.toThrow(DeployLimitError);
    expect(uploaded).toEqual([]);
    await expect(backupStore.listSnapshots()).resolves.toEqual([]);
  });

  it('halts before backup, lock, and upload when preflight fails', async () => {
    await writeLocal('broken.json', '{"ok": }\n');
    const backupStore = createBackupStore();
    const events: string[] = [];
    const failedReport: PreflightReport = {
      ok: false,
      results: [
        {
          path: join(localRoot, 'broken.json'),
          status: 'fail',
          issues: [{ severity: 'error', kind: 'json', message: 'Unexpected token' }],
        },
      ],
      errors: [{ severity: 'error', kind: 'json', message: 'Unexpected token' }],
      warnings: [],
    };

    await expect(
      runPush({
        localRoot,
        state: { schema: 1, files: {} },
        excluder: createExcluder(),
        backupStore,
        uploader: createUploader(),
        preflight: async () => failedReport,
        lock: {
          acquire: async () => {
            events.push('acquire');
          },
          release: async () => {
            events.push('release');
          },
        },
      }),
    ).rejects.toThrow(PreflightError);
    expect(events).toEqual([]);
    expect(uploaded).toEqual([]);
    await expect(backupStore.listSnapshots()).resolves.toEqual([]);
  });

  it('fails when upload size verification does not match the local file', async () => {
    await writeLocal('index.html', '<h1>changed</h1>\n');

    await expect(
      runPush({
        localRoot,
        remoteRoot: '/public_html',
        state: {
          schema: 1,
          files: {
            'index.html': {
              hash: 'old-hash',
              size: 10,
              updatedAt: '2026-05-18T10:00:00.000Z',
            },
          },
        },
        excluder: createExcluder(),
        backupStore: createBackupStore(),
        uploader: createUploader({ wrongSize: true }),
      }),
    ).rejects.toThrow(DeployVerificationError);
  });

  it('calls uploader.mkdir for each unique parent directory before upload', async () => {
    await writeLocal('assets/css/main.css', 'body{}');
    await writeLocal('assets/js/app.js', 'console.log(1);');
    await writeLocal('index.html', '<h1>top</h1>');
    const events: string[] = [];
    const mkdirCalls: string[] = [];
    const backupStore = createBackupStore();
    const uploader: DeployUploader = {
      mkdir: async (remoteDir) => {
        mkdirCalls.push(remoteDir);
        events.push(`mkdir:${remoteDir}`);
      },
      upload: async (localPath, remotePath) => {
        events.push(`upload:${remotePath}`);
        const info = await stat(localPath);
        return { remotePath, bytesUploaded: info.size };
      },
      delete: async (remotePath) => {
        deleted.push(remotePath);
      },
    };

    await runPush({
      localRoot,
      remoteRoot: '/public_html',
      state: { schema: 1, files: {} },
      excluder: createExcluder(),
      backupStore,
      uploader,
    });

    // v0.2.5: the configured remoteRoot itself is no longer skipped --
    // mkdir is called for /public_html so first-time pushes to a fresh
    // remote_root succeed. basic-ftp's ensureDir treats already-existing
    // paths as a no-op (cd succeeds, no MKD sent) so this is cheap.
    expect(mkdirCalls).toEqual([
      '/public_html/assets/css',
      '/public_html/assets/js',
      '/public_html',
    ]);
    expect(events).toEqual([
      'mkdir:/public_html/assets/css',
      'upload:/public_html/assets/css/main.css',
      'mkdir:/public_html/assets/js',
      'upload:/public_html/assets/js/app.js',
      'mkdir:/public_html',
      'upload:/public_html/index.html',
    ]);
  });

  it('calls mkdir on the configured remoteRoot itself so first-time pushes auto-create it', async () => {
    await writeLocal('index.html', '<h1>fresh</h1>');
    const mkdirCalls: string[] = [];
    const backupStore = createBackupStore();
    const uploader: DeployUploader = {
      mkdir: async (remoteDir) => {
        mkdirCalls.push(remoteDir);
      },
      upload: async (localPath, remotePath) => {
        const info = await stat(localPath);
        return { remotePath, bytesUploaded: info.size };
      },
      delete: async (remotePath) => {
        deleted.push(remotePath);
      },
    };

    await runPush({
      localRoot,
      remoteRoot: '/aiftp-test',
      state: { schema: 1, files: {} },
      excluder: createExcluder(),
      backupStore,
      uploader,
      safety: { verifyAfterUpload: 'off' },
    });

    expect(mkdirCalls).toEqual(['/aiftp-test']);
  });

  it('skips mkdir when uploader does not implement it (backward compat)', async () => {
    await writeLocal('nested/a.html', '<p>a</p>');
    const backupStore = createBackupStore();
    const uploader: DeployUploader = {
      upload: async (localPath, remotePath) => {
        const info = await stat(localPath);
        return { remotePath, bytesUploaded: info.size };
      },
      delete: async (remotePath) => {
        deleted.push(remotePath);
      },
    };

    await expect(
      runPush({
        localRoot,
        remoteRoot: '/public_html',
        state: { schema: 1, files: {} },
        excluder: createExcluder(),
        backupStore,
        uploader,
      }),
    ).resolves.toMatchObject({ uploaded: [{ path: 'nested/a.html' }] });
  });

  it('skips mkdir for files at the remote root', async () => {
    await writeLocal('index.html', '<h1>root</h1>');
    const mkdirCalls: string[] = [];
    const backupStore = createBackupStore();
    const uploader: DeployUploader = {
      mkdir: async (remoteDir) => {
        mkdirCalls.push(remoteDir);
      },
      upload: async (localPath, remotePath) => {
        const info = await stat(localPath);
        return { remotePath, bytesUploaded: info.size };
      },
      delete: async (remotePath) => {
        deleted.push(remotePath);
      },
    };

    await runPush({
      localRoot,
      state: { schema: 1, files: {} },
      excluder: createExcluder(),
      backupStore,
      uploader,
    });

    expect(mkdirCalls).toEqual([]);
  });

  it('releases locks when upload fails', async () => {
    await writeLocal('index.html', '<h1>changed</h1>\n');
    const events: string[] = [];
    const lock: DeployLock = {
      acquire: async () => {
        events.push('acquire');
      },
      release: async () => {
        events.push('release');
      },
    };

    await expect(
      runPush({
        localRoot,
        state: {
          schema: 1,
          files: {
            'index.html': {
              hash: 'old-hash',
              size: 10,
              updatedAt: '2026-05-18T10:00:00.000Z',
            },
          },
        },
        excluder: createExcluder(),
        backupStore: createBackupStore(),
        uploader: createUploader({ fail: true }),
        lock,
      }),
    ).rejects.toThrow('upload failed');
    expect(events).toEqual(['acquire', 'release']);
  });
});
