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

  beforeEach(async () => {
    localRoot = join(tmpdir(), `aiftp-deploy-local-${randomUUID()}`);
    backupRoot = join(tmpdir(), `aiftp-deploy-backup-${randomUUID()}`);
    await mkdir(localRoot, { recursive: true });
    await mkdir(backupRoot, { recursive: true });
    remoteFiles = new Map<string, Buffer>([
      ['index.html', Buffer.from('<h1>remote old</h1>\n', 'utf8')],
    ]);
    uploaded = [];
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
        if (!data) {
          throw new Error(`missing remote file: ${path}`);
        }
        return data;
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
    expect(result.backupSnapshot?.files.map((file) => file.path)).toEqual(['index.html']);
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
