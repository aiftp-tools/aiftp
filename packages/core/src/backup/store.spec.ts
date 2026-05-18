import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKey } from '../encryption.js';
import { createExcluder } from '../exclude.js';
import { BackupLimitError, type BackupSource, BackupStore, type SnapshotMeta } from './store.js';

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('BackupStore', () => {
  let tempDir: string;
  let sourceFiles: Map<string, Buffer>;
  let source: BackupSource;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `aiftp-backup-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    sourceFiles = new Map<string, Buffer>([
      ['index.html', Buffer.from('<h1>current</h1>\n', 'utf8')],
      ['assets/app.css', Buffer.from('body { color: black; }\n', 'utf8')],
      ['.env', Buffer.from('SECRET=do-not-back-up\n', 'utf8')],
    ]);
    source = {
      readFile: async (path: string) => {
        const data = sourceFiles.get(path);
        if (!data) {
          throw new Error(`missing source file: ${path}`);
        }
        return data;
      },
      listFiles: async () => [...sourceFiles.keys()],
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createStore(options: { maxDiskBytes?: number } = {}): BackupStore {
    return new BackupStore({
      rootDir: tempDir,
      key: generateKey(),
      source,
      excluder: createExcluder(),
      now: () => new Date('2026-05-18T12:00:00.000Z'),
      ...options,
    });
  }

  it('creates an encrypted auto snapshot for requested files', async () => {
    const store = createStore();

    const snapshot = await store.createAutoSnapshot(['index.html', '.env']);

    expect(snapshot.type).toBe('auto');
    expect(snapshot.fileCount).toBe(1);
    expect(snapshot.totalBytes).toBe(sourceFiles.get('index.html')?.length);

    const restored = await store.restoreFile(snapshot.id, 'index.html');
    expect(restored).toEqual(sourceFiles.get('index.html'));
    await expect(store.restoreFile(snapshot.id, '.env')).rejects.toThrow();

    const snapshotDir = join(tempDir, 'snapshots', snapshot.id);
    const files = await readdir(join(snapshotDir, 'files'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.enc$/u);
    await expect(stat(join(snapshotDir, 'manifest.enc'))).resolves.toBeTruthy();
  });

  it('creates a full backup from source.listFiles()', async () => {
    const store = createStore();

    const snapshot = await store.createFullBackup();

    expect(snapshot).toMatchObject<SnapshotMeta>({
      id: snapshot.id,
      type: 'full',
      createdAt: '2026-05-18T12:00:00.000Z',
      fileCount: 2,
      totalBytes:
        (sourceFiles.get('index.html')?.length ?? 0) +
        (sourceFiles.get('assets/app.css')?.length ?? 0),
    });
    await expect(store.restoreFile(snapshot.id, 'assets/app.css')).resolves.toEqual(
      sourceFiles.get('assets/app.css'),
    );
  });

  it('lists snapshots newest first by createdAt', async () => {
    const store = new BackupStore({
      rootDir: tempDir,
      key: generateKey(),
      source,
      excluder: createExcluder(),
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    });
    await store.createAutoSnapshot(['index.html']);

    const later = new BackupStore({
      rootDir: tempDir,
      key: store.key,
      source,
      excluder: createExcluder(),
      now: () => new Date('2026-05-18T12:05:00.000Z'),
    });
    await later.createAutoSnapshot(['assets/app.css']);

    const snapshots = await later.listSnapshots();

    expect(snapshots.map((snapshot) => snapshot.createdAt)).toEqual([
      '2026-05-18T12:05:00.000Z',
      '2026-05-18T12:00:00.000Z',
    ]);
  });

  it('verifies encrypted snapshot integrity and original hashes', async () => {
    const store = createStore();
    const snapshot = await store.createAutoSnapshot(['index.html']);

    await expect(store.verify(snapshot.id)).resolves.toEqual({
      ok: true,
      checkedFiles: 1,
      errors: [],
    });
  });

  it('prunes old snapshots and keeps the newest N snapshots', async () => {
    const first = new BackupStore({
      rootDir: tempDir,
      key: generateKey(),
      source,
      excluder: createExcluder(),
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    });
    await first.createAutoSnapshot(['index.html']);

    const second = new BackupStore({
      rootDir: tempDir,
      key: first.key,
      source,
      excluder: createExcluder(),
      now: () => new Date('2026-05-18T12:10:00.000Z'),
    });
    await second.createAutoSnapshot(['assets/app.css']);

    const deleted = await second.prune(1);

    expect(deleted).toHaveLength(1);
    const remaining = await second.listSnapshots();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.createdAt).toBe('2026-05-18T12:10:00.000Z');
  });

  it('halts when max disk usage would be exceeded', async () => {
    const store = createStore({ maxDiskBytes: 10 });

    await expect(store.createAutoSnapshot(['index.html'])).rejects.toThrow(BackupLimitError);
  });

  it('reports total disk usage for encrypted snapshots', async () => {
    const store = createStore();
    const snapshot = await store.createAutoSnapshot(['index.html']);

    const usage = await store.getTotalDiskUsage();

    expect(usage).toBeGreaterThan(0);
    expect(usage).toBeGreaterThan(sourceFiles.get('index.html')?.length ?? 0);
    expect(snapshot.files[0]?.sha256Original).toBe(
      sha256(sourceFiles.get('index.html') ?? Buffer.alloc(0)),
    );
  });
});
