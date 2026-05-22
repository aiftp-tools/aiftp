import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptBuffer, encryptBuffer } from '../encryption.js';
import type { Excluder } from '../exclude.js';

const SNAPSHOT_SCHEMA = 2;

export type SnapshotId = string;
export type SnapshotType = 'auto' | 'full';
export type FileOperation = 'added' | 'modified' | 'removed';

export interface AutoSnapshotInput {
  added: readonly string[];
  modified: readonly string[];
  removed: readonly string[];
}

interface SnapshotOperationEntry {
  path: string;
  operation: FileOperation;
}

export interface BackupSource {
  readFile(path: string): Promise<Buffer | null>;
  listFiles?(): Promise<string[]>;
}

export interface SnapshotFileMeta {
  path: string;
  operation: FileOperation;
  storedName: string | null;
  sizeOriginal: number;
  sizeEncrypted: number;
  sha256Original: string | null;
  sha256Encrypted: string | null;
}

export interface SnapshotCounts {
  added: number;
  modified: number;
  removed: number;
}

export interface SnapshotMeta {
  id: SnapshotId;
  type: SnapshotType;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
  counts: SnapshotCounts;
  files: SnapshotFileMeta[];
}

interface SnapshotManifest extends SnapshotMeta {
  schema: 1 | typeof SNAPSHOT_SCHEMA;
}

export interface BackupStoreOptions {
  rootDir: string;
  key: Buffer;
  source: BackupSource;
  excluder: Excluder;
  sourceConcurrency?: number;
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

// Snapshot ids are produced by createSnapshotId() as:
//   `${isoTimestampWithColonsReplaced}-${type}-${uuidv4}`
// e.g. "2026-05-18T12-30-00-000Z-auto-12345678-1234-1234-1234-123456789012".
// The regex below is intentionally strict so user-supplied ids cannot escape
// the snapshots directory or trigger an ENOENT on `manifest.enc` by passing
// empty / path-traversal / unexpected-format strings.
const SNAPSHOT_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(auto|full)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isValidSnapshotId(id: string): boolean {
  return typeof id === 'string' && SNAPSHOT_ID_PATTERN.test(id);
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

function isPathArray(input: AutoSnapshotInput | readonly string[]): input is readonly string[] {
  return Array.isArray(input);
}

function sortSnapshots(snapshots: SnapshotMeta[]): SnapshotMeta[] {
  return [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function snapshotToMeta(snapshot: SnapshotManifest): SnapshotMeta {
  const { id, type, createdAt, fileCount, totalBytes, counts, files } = snapshot;
  return { id, type, createdAt, fileCount, totalBytes, counts, files };
}

function countOperations(files: readonly SnapshotFileMeta[]): SnapshotCounts {
  return {
    added: files.filter((file) => file.operation === 'added').length,
    modified: files.filter((file) => file.operation === 'modified').length,
    removed: files.filter((file) => file.operation === 'removed').length,
  };
}

function upgradeSchema1Manifest(manifest: Partial<SnapshotManifest>): SnapshotManifest {
  const files = (manifest.files ?? []).map((file) => ({
    ...(file as SnapshotFileMeta),
    operation: 'modified' as const,
  }));
  const fileCount = typeof manifest.fileCount === 'number' ? manifest.fileCount : files.length;
  return {
    ...(manifest as SnapshotManifest),
    schema: SNAPSHOT_SCHEMA,
    fileCount,
    counts: { added: 0, modified: fileCount, removed: 0 },
    files,
  };
}

function parseManifest(data: Buffer): SnapshotManifest {
  const parsed = JSON.parse(data.toString('utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BackupError('Invalid snapshot manifest: expected object');
  }
  const manifest = parsed as Partial<SnapshotManifest>;
  if (manifest.schema !== 1 && manifest.schema !== SNAPSHOT_SCHEMA) {
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
  if (manifest.schema === 1) {
    return upgradeSchema1Manifest(manifest);
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
  private readonly sourceConcurrency: number | undefined;
  private readonly maxDiskBytes: number | undefined;
  private readonly now: () => Date;

  constructor(options: BackupStoreOptions) {
    this.rootDir = options.rootDir;
    this.key = options.key;
    this.source = options.source;
    this.excluder = options.excluder;
    this.sourceConcurrency = options.sourceConcurrency;
    this.maxDiskBytes = options.maxDiskBytes;
    this.now = options.now ?? (() => new Date());
  }

  async createAutoSnapshot(input: AutoSnapshotInput): Promise<SnapshotMeta>;
  async createAutoSnapshot(files: readonly string[]): Promise<SnapshotMeta>;
  async createAutoSnapshot(input: AutoSnapshotInput | readonly string[]): Promise<SnapshotMeta> {
    const snapshotInput: AutoSnapshotInput = isPathArray(input)
      ? { added: [], modified: input, removed: [] }
      : input;
    return this.createSnapshot('auto', this.operationEntries(snapshotInput));
  }

  async createFullBackup(): Promise<SnapshotMeta> {
    if (!this.source.listFiles) {
      throw new BackupError('Backup source does not support full backup listing');
    }
    return this.createSnapshot(
      'full',
      (await this.source.listFiles()).map((path) => ({ path, operation: 'modified' as const })),
    );
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
    if (file.operation === 'added') {
      throw new BackupError(`Cannot restore added file tombstone: ${normalizedPath}`);
    }
    if (file.storedName === null) {
      throw new BackupError(`Snapshot file content missing: ${normalizedPath}`);
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
      if (file.operation === 'added') {
        continue;
      }
      try {
        if (file.storedName === null) {
          throw new BackupError('Snapshot file content missing');
        }
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
    inputEntries: readonly SnapshotOperationEntry[],
  ): Promise<SnapshotMeta> {
    const entries = this.normalizeEntries(inputEntries);
    const tombstones = entries
      .filter((entry) => entry.operation === 'added')
      .map((entry) => this.createTombstone(entry.path));
    const sources = await this.readSources(
      entries.filter(
        (entry): entry is SnapshotOperationEntry & { operation: Exclude<FileOperation, 'added'> } =>
          entry.operation !== 'added',
      ),
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
        operation: source.operation,
        storedName,
        sizeOriginal: source.data.length,
        sizeEncrypted: encrypted.length,
        sha256Original: sha256(source.data),
        sha256Encrypted: sha256(encrypted),
      });
    }
    files.push(...tombstones);
    files.sort((a, b) => a.path.localeCompare(b.path));

    const manifest: SnapshotManifest = {
      schema: SNAPSHOT_SCHEMA,
      id,
      type,
      createdAt: this.now().toISOString(),
      fileCount: files.length,
      totalBytes: sources.reduce((sum, file) => sum + file.data.length, 0),
      counts: countOperations(files),
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

  private operationEntries(input: AutoSnapshotInput): SnapshotOperationEntry[] {
    return [
      ...input.added.map((path) => ({ path, operation: 'added' as const })),
      ...input.modified.map((path) => ({ path, operation: 'modified' as const })),
      ...input.removed.map((path) => ({ path, operation: 'removed' as const })),
    ];
  }

  private normalizeEntries(entries: readonly SnapshotOperationEntry[]): SnapshotOperationEntry[] {
    const normalized = new Map<string, SnapshotOperationEntry>();
    for (const entry of entries) {
      const path = normalizePath(entry.path);
      if (this.excluder.shouldExclude(path).excluded) {
        continue;
      }
      normalized.set(path, { path, operation: entry.operation });
    }
    return [...normalized.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private createTombstone(path: string): SnapshotFileMeta {
    return {
      path,
      operation: 'added',
      storedName: null,
      sizeOriginal: null as unknown as number,
      sizeEncrypted: null as unknown as number,
      sha256Original: null,
      sha256Encrypted: null,
    };
  }

  private async readSources(
    entries: readonly (SnapshotOperationEntry & { operation: Exclude<FileOperation, 'added'> })[],
  ): Promise<Array<{ path: string; operation: Exclude<FileOperation, 'added'>; data: Buffer }>> {
    const concurrency =
      this.sourceConcurrency === undefined
        ? entries.length
        : Math.max(1, Math.min(this.sourceConcurrency, entries.length));
    const sources: Array<
      { path: string; operation: Exclude<FileOperation, 'added'>; data: Buffer } | undefined
    > = new Array(entries.length);
    let nextIndex = 0;

    async function worker(readFile: BackupSource['readFile']): Promise<void> {
      while (nextIndex < entries.length) {
        const index = nextIndex;
        nextIndex += 1;
        const entry = entries[index];
        if (entry === undefined) {
          continue;
        }
        const data = await readFile(entry.path);
        if (data === null) {
          continue;
        }
        sources[index] = {
          path: entry.path,
          operation: entry.operation,
          data,
        };
      }
    }

    await Promise.all(
      Array.from({ length: concurrency }, () => worker((path) => this.source.readFile(path))),
    );
    return sources.filter(
      (
        source,
      ): source is { path: string; operation: Exclude<FileOperation, 'added'>; data: Buffer } =>
        source !== undefined,
    );
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
