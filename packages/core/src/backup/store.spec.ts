import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptBuffer, encryptBuffer, generateKey } from '../encryption.js';
import { createExcluder } from '../exclude.js';
import {
  BackupLimitError,
  type BackupSource,
  BackupStore,
  type SnapshotMeta,
  isValidSnapshotId,
} from './store.js';

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

    const snapshot = await store.createAutoSnapshot({
      added: [],
      modified: ['index.html', '.env'],
      removed: [],
    });

    expect(snapshot.type).toBe('auto');
    expect(snapshot.fileCount).toBe(1);
    expect(snapshot.totalBytes).toBe(sourceFiles.get('index.html')?.length);
    expect(snapshot.counts).toEqual({ added: 0, modified: 1, removed: 0 });
    expect(snapshot.files[0]?.operation).toBe('modified');

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
      counts: { added: 0, modified: 2, removed: 0 },
    });
    expect(snapshot.files.map((file) => file.operation)).toEqual(['modified', 'modified']);
    await expect(store.restoreFile(snapshot.id, 'assets/app.css')).resolves.toEqual(
      sourceFiles.get('assets/app.css'),
    );
  });

  it('writes schema 2 auto snapshots with tombstones for added files', async () => {
    const readPaths: string[] = [];
    source.readFile = async (path: string) => {
      readPaths.push(path);
      const data = sourceFiles.get(path);
      if (!data) {
        throw new Error(`missing source file: ${path}`);
      }
      return data;
    };
    const store = createStore();

    const snapshot = await store.createAutoSnapshot({
      added: ['new-page.html'],
      modified: ['index.html'],
      removed: ['assets/app.css'],
    });

    expect(readPaths.sort()).toEqual(['assets/app.css', 'index.html']);
    expect(snapshot.counts).toEqual({ added: 1, modified: 1, removed: 1 });
    expect(snapshot.fileCount).toBe(3);
    expect(snapshot.files.map((file) => [file.path, file.operation])).toEqual([
      ['assets/app.css', 'removed'],
      ['index.html', 'modified'],
      ['new-page.html', 'added'],
    ]);
    expect(snapshot.files.find((file) => file.path === 'new-page.html')).toMatchObject({
      operation: 'added',
      storedName: null,
      sizeOriginal: null,
      sizeEncrypted: null,
      sha256Original: null,
      sha256Encrypted: null,
    });

    const manifest = JSON.parse(
      decryptBuffer(
        await readFile(join(tempDir, 'snapshots', snapshot.id, 'manifest.enc')),
        store.key,
      ).toString('utf8'),
    ) as { schema: number; counts: unknown };
    expect(manifest.schema).toBe(2);
    expect(manifest.counts).toEqual({ added: 1, modified: 1, removed: 1 });

    await expect(store.restoreFile(snapshot.id, 'new-page.html')).rejects.toThrow(
      /Cannot restore added file tombstone/,
    );
    await expect(store.restoreFile(snapshot.id, 'assets/app.css')).resolves.toEqual(
      sourceFiles.get('assets/app.css'),
    );
  });

  it('reads schema 1 manifests as schema 2 metadata without rewriting them', async () => {
    const store = createStore();
    const snapshot = await store.createAutoSnapshot({
      added: [],
      modified: ['index.html', 'assets/app.css'],
      removed: [],
    });
    const manifestPath = join(tempDir, 'snapshots', snapshot.id, 'manifest.enc');
    const schema2Manifest = JSON.parse(
      decryptBuffer(await readFile(manifestPath), store.key).toString('utf8'),
    ) as Record<string, unknown>;
    const schema1Manifest = {
      ...schema2Manifest,
      schema: 1,
      counts: undefined,
      files: (schema2Manifest.files as Array<Record<string, unknown>>).map(
        ({ operation: _operation, ...file }) => file,
      ),
    };
    await writeFile(
      manifestPath,
      encryptBuffer(Buffer.from(JSON.stringify(schema1Manifest, null, 2), 'utf8'), store.key),
      { mode: 0o600 },
    );
    const before = await readFile(manifestPath);

    const [readSnapshot] = await store.listSnapshots();

    expect(readSnapshot?.counts).toEqual({ added: 0, modified: 2, removed: 0 });
    expect(readSnapshot?.files.map((file) => file.operation)).toEqual(['modified', 'modified']);
    expect(await readFile(manifestPath)).toEqual(before);
  });

  it('counts added tombstone metadata as checked without content verification', async () => {
    const store = createStore();
    const snapshot = await store.createAutoSnapshot({
      added: ['new-page.html'],
      modified: ['index.html'],
      removed: [],
    });

    await expect(store.verify(snapshot.id)).resolves.toEqual({
      ok: true,
      checkedFiles: 2,
      errors: [],
    });
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
    const snapshot = await store.createAutoSnapshot({
      added: [],
      modified: ['index.html'],
      removed: [],
    });

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

    await expect(
      store.createAutoSnapshot({ added: [], modified: ['index.html'], removed: [] }),
    ).rejects.toThrow(BackupLimitError);
  });

  it('reports total disk usage for encrypted snapshots', async () => {
    const store = createStore();
    const snapshot = await store.createAutoSnapshot({
      added: [],
      modified: ['index.html'],
      removed: [],
    });

    const usage = await store.getTotalDiskUsage();

    expect(usage).toBeGreaterThan(0);
    expect(usage).toBeGreaterThan(sourceFiles.get('index.html')?.length ?? 0);
    expect(snapshot.files[0]?.sha256Original).toBe(
      sha256(sourceFiles.get('index.html') ?? Buffer.alloc(0)),
    );
  });

  it('round-trips multibyte (UTF-8) and Shift_JIS-style byte content for filenames', async () => {
    // Filename containing characters that span the same byte range as Shift_JIS
    // (e.g. half-width katakana and CJK ideographs in UTF-8). The path is a JS
    // string, but the manifest is encrypted as JSON bytes -- regressions here
    // would silently corrupt non-ASCII paths.
    const jpName = 'メモ／テスト_2026年5月.html';
    const cafeName = 'café-régression.html';
    const jpContent = Buffer.from('<h1>テスト</h1>\n', 'utf8');
    const cafeContent = Buffer.from('Bonjour à tous\n', 'utf8');
    sourceFiles.set(jpName, jpContent);
    sourceFiles.set(cafeName, cafeContent);

    const store = createStore();
    const snapshot = await store.createAutoSnapshot({
      added: [],
      modified: [jpName, cafeName],
      removed: [],
    });

    expect(snapshot.files.map((f) => f.path).sort()).toEqual([cafeName, jpName].sort());

    await expect(store.restoreFile(snapshot.id, jpName)).resolves.toEqual(jpContent);
    await expect(store.restoreFile(snapshot.id, cafeName)).resolves.toEqual(cafeContent);
  });

  it('rejects missing files in restoreFile with a clear BackupError', async () => {
    const store = createStore();
    const snapshot = await store.createAutoSnapshot({
      added: [],
      modified: ['index.html'],
      removed: [],
    });

    await expect(store.restoreFile(snapshot.id, 'does-not-exist.html')).rejects.toThrow(
      /Snapshot file not found/,
    );
  });
});

describe('isValidSnapshotId', () => {
  it('accepts an id produced by createSnapshotId (ISO-timestamp + type + uuid)', () => {
    expect(
      isValidSnapshotId('2026-05-18T12-30-00-000Z-auto-12345678-1234-1234-1234-123456789012'),
    ).toBe(true);
    expect(
      isValidSnapshotId('2026-05-18T12-30-00-000Z-full-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    ).toBe(true);
  });

  it('rejects empty and whitespace-only strings', () => {
    expect(isValidSnapshotId('')).toBe(false);
    expect(isValidSnapshotId('   ')).toBe(false);
    expect(isValidSnapshotId('\t\n')).toBe(false);
  });

  it('rejects path traversal and separator characters', () => {
    expect(isValidSnapshotId('../etc/passwd')).toBe(false);
    expect(isValidSnapshotId('foo/bar')).toBe(false);
    expect(isValidSnapshotId('foo\\bar')).toBe(false);
    expect(isValidSnapshotId('snap-1')).toBe(false); // wrong shape
  });

  it('rejects unknown snapshot types', () => {
    expect(
      isValidSnapshotId('2026-05-18T12-30-00-000Z-bogus-12345678-1234-1234-1234-123456789012'),
    ).toBe(false);
  });
});
