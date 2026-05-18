import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptBuffer, encryptBuffer } from '../encryption.js';
import type { Excluder } from '../exclude.js';

const SNAPSHOT_SCHEMA = 1;

export type SnapshotId = string;
export type SnapshotType = 'auto' | 'full';

export interface BackupSource {
  readFile(path: string): Promise<Buffer>;
  listFiles?(): Promise<string[]>;
}

export interface SnapshotFileMeta {
  path: string;
  storedName: string;
  sizeOriginal: number;
  sizeEncrypted: number;
  sha256Original: string;
  sha256Encrypted: string;
}

export interface SnapshotMeta {
  id: SnapshotId;
  type: SnapshotType;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
  files: SnapshotFileMeta[];
}

interface SnapshotManifest extends SnapshotMeta {
  schema: typeof SNAPSHOT_SCHEMA;
}

export interface BackupStoreOptions {
  rootDir: string;
  key: Buffer;
  source: BackupSource;
  excluder: Excluder;
  maxDiskBytes?: number;
  now?: () => Date;
}

export interface VerifyResult {
  ok: boolean;
  checkedFiles: number;
  errors: string[];
}

export class BackupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BackupError';
  }
}

export class BackupLimitError extends BackupError {
  constructor(message: string) {
    super(message);
    this.name = 'BackupLimitError';
  }
}

function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/^\/+/, '');
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function sortSnapshots(snapshots: SnapshotMeta[]): SnapshotMeta[] {
  return [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function snapshotToMeta(snapshot: SnapshotManifest): SnapshotMeta {
  const { id, type, createdAt, fileCount, totalBytes, files } = snapshot;
  return { id, type, createdAt, fileCount, totalBytes, files };
}

function parseManifest(data: Buffer): SnapshotManifest {
  const parsed = JSON.parse(data.toString('utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BackupError('Invalid snapshot manifest: expected object');
  }
  const manifest = parsed as Partial<SnapshotManifest>;
  if (manifest.schema !== SNAPSHOT_SCHEMA) {
    throw new BackupError(`Unsupported snapshot schema: ${String(manifest.schema)}`);
  }
  if (
    typeof manifest.id !== 'string' ||
    (manifest.type !== 'auto' && manifest.type !== 'full') ||
    typeof manifest.createdAt !== 'string' ||
    !Array.isArray(manifest.files)
  ) {
    throw new BackupError('Invalid snapshot manifest fields');
  }
  return manifest as SnapshotManifest;
}

async function readDirIfExists(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error: unknown) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readDirIfExists(path)) {
    const fullPath = join(path, entry);
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      total += await directorySize(fullPath);
    } else if (info.isFile()) {
      total += info.size;
    }
  }
  return total;
}

export class BackupStore {
  readonly key: Buffer;
  private readonly rootDir: string;
  private readonly source: BackupSource;
  private readonly excluder: Excluder;
  private readonly maxDiskBytes: number | undefined;
  private readonly now: () => Date;

  constructor(options: BackupStoreOptions) {
    this.rootDir = options.rootDir;
    this.key = options.key;
    this.source = options.source;
    this.excluder = options.excluder;
    this.maxDiskBytes = options.maxDiskBytes;
    this.now = options.now ?? (() => new Date());
  }

  async createAutoSnapshot(files: readonly string[]): Promise<SnapshotMeta> {
    return this.createSnapshot('auto', files);
  }

  async createFullBackup(): Promise<SnapshotMeta> {
    if (!this.source.listFiles) {
      throw new BackupError('Backup source does not support full backup listing');
    }
    return this.createSnapshot('full', await this.source.listFiles());
  }

  async listSnapshots(): Promise<SnapshotMeta[]> {
    const snapshots: SnapshotMeta[] = [];
    for (const id of await readDirIfExists(this.snapshotsDir())) {
      try {
        snapshots.push(snapshotToMeta(await this.readManifest(id)));
      } catch (error: unknown) {
        throw new BackupError(`Failed to read snapshot: ${id}`, { cause: error });
      }
    }
    return sortSnapshots(snapshots);
  }

  async restoreFile(id: SnapshotId, path: string): Promise<Buffer> {
    const normalizedPath = normalizePath(path);
    const manifest = await this.readManifest(id);
    const file = manifest.files.find((entry) => entry.path === normalizedPath);
    if (!file) {
      throw new BackupError(`Snapshot file not found: ${normalizedPath}`);
    }
    return decryptBuffer(await readFile(this.filePath(id, file.storedName)), this.key);
  }

  async restoreAll(id: SnapshotId): Promise<Map<string, Buffer>> {
    const manifest = await this.readManifest(id);
    const restored = new Map<string, Buffer>();
    for (const file of manifest.files) {
      restored.set(file.path, await this.restoreFile(id, file.path));
    }
    return restored;
  }

  async verify(id: SnapshotId): Promise<VerifyResult> {
    const manifest = await this.readManifest(id);
    const errors: string[] = [];

    for (const file of manifest.files) {
      try {
        const encrypted = await readFile(this.filePath(id, file.storedName));
        const decrypted = decryptBuffer(encrypted, this.key);
        if (sha256(encrypted) !== file.sha256Encrypted) {
          errors.push(`${file.path}: encrypted hash mismatch`);
        }
        if (sha256(decrypted) !== file.sha256Original) {
          errors.push(`${file.path}: original hash mismatch`);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${file.path}: ${message}`);
      }
    }

    return {
      ok: errors.length === 0,
      checkedFiles: manifest.files.length,
      errors,
    };
  }

  async prune(keepCount: number): Promise<SnapshotId[]> {
    if (!Number.isSafeInteger(keepCount) || keepCount < 0) {
      throw new BackupError('keepCount must be a non-negative integer');
    }

    const snapshots = await this.listSnapshots();
    const deleted = snapshots.slice(keepCount);
    for (const snapshot of deleted) {
      await rm(this.snapshotDir(snapshot.id), { recursive: true, force: true });
    }
    return deleted.map((snapshot) => snapshot.id);
  }

  async getTotalDiskUsage(): Promise<number> {
    return directorySize(this.snapshotsDir());
  }

  private async createSnapshot(
    type: SnapshotType,
    inputPaths: readonly string[],
  ): Promise<SnapshotMeta> {
    const paths = [...new Set(inputPaths.map(normalizePath))]
      .filter((path) => !this.excluder.shouldExclude(path).excluded)
      .sort((a, b) => a.localeCompare(b));

    const sources = await Promise.all(
      paths.map(async (path) => ({
        path,
        data: await this.source.readFile(path),
      })),
    );

    await this.assertWithinDiskLimit(sources.reduce((sum, file) => sum + file.data.length, 0));

    const id = this.createSnapshotId(type);
    const snapshotDir = this.snapshotDir(id);
    const filesDir = join(snapshotDir, 'files');
    await mkdir(filesDir, { recursive: true });

    const files: SnapshotFileMeta[] = [];
    for (const source of sources) {
      const encrypted = encryptBuffer(source.data, this.key);
      const storedName = `${randomUUID()}.enc`;
      await writeFile(this.filePath(id, storedName), encrypted, { mode: 0o600 });
      files.push({
        path: source.path,
        storedName,
        sizeOriginal: source.data.length,
        sizeEncrypted: encrypted.length,
        sha256Original: sha256(source.data),
        sha256Encrypted: sha256(encrypted),
      });
    }

    const manifest: SnapshotManifest = {
      schema: SNAPSHOT_SCHEMA,
      id,
      type,
      createdAt: this.now().toISOString(),
      fileCount: files.length,
      totalBytes: sources.reduce((sum, file) => sum + file.data.length, 0),
      files,
    };

    await writeFile(
      this.manifestPath(id),
      encryptBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), this.key),
      { mode: 0o600 },
    );

    return snapshotToMeta(manifest);
  }

  private async assertWithinDiskLimit(nextPlainBytes: number): Promise<void> {
    if (this.maxDiskBytes === undefined) {
      return;
    }
    const projected = (await this.getTotalDiskUsage()) + nextPlainBytes;
    if (projected > this.maxDiskBytes) {
      throw new BackupLimitError(
        `Backup disk limit exceeded: projected=${projected} max=${this.maxDiskBytes}`,
      );
    }
  }

  private createSnapshotId(type: SnapshotType): SnapshotId {
    const timestamp = this.now().toISOString().replace(/[:.]/g, '-');
    return `${timestamp}-${type}-${randomUUID()}`;
  }

  private snapshotsDir(): string {
    return join(this.rootDir, 'snapshots');
  }

  private snapshotDir(id: SnapshotId): string {
    return join(this.snapshotsDir(), id);
  }

  private manifestPath(id: SnapshotId): string {
    return join(this.snapshotDir(id), 'manifest.enc');
  }

  private filePath(id: SnapshotId, storedName: string): string {
    return join(this.snapshotDir(id), 'files', storedName);
  }

  private async readManifest(id: SnapshotId): Promise<SnapshotManifest> {
    const encrypted = await readFile(this.manifestPath(id));
    return parseManifest(decryptBuffer(encrypted, this.key));
  }
}
