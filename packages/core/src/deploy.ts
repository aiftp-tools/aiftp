import { stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { BackupStore, SnapshotMeta } from './backup/store.js';
import { type Diff, computeDiff } from './diff.js';
import type { Excluder } from './exclude.js';
import { PreflightError, type PreflightReport } from './preflight.js';
import { type State, computeHash, updateFileEntry } from './state.js';

export interface StatusOptions {
  localRoot: string;
  state: State;
  excluder: Excluder;
  /**
   * v0.9.4+: forwarded to `computeDiff`/`walkFiles`. When omitted,
   * symlinks are not followed (the prior implicit default).
   */
  followSymlinks?: boolean;
}

export interface StatusResult {
  diff: Diff;
  counts: Record<keyof Diff, number>;
}

export interface DeployUploader {
  upload(
    localPath: string,
    remotePath: string,
  ): Promise<{ remotePath: string; bytesUploaded?: number }>;
  size?(remotePath: string): Promise<number>;
  mkdir?(remoteDir: string): Promise<void>;
}

export interface DeployLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export interface PushSafetyOptions {
  maxFilesPerPush?: number;
  maxTotalSizeBytes?: number;
  verifyAfterUpload?: 'off' | 'size';
}

export interface PushOptions extends StatusOptions {
  backupStore: BackupStore;
  uploader: DeployUploader;
  remoteRoot?: string;
  files?: readonly string[];
  dryRun?: boolean;
  safety?: PushSafetyOptions;
  lock?: DeployLock;
  preflight?: (localPaths: readonly string[]) => Promise<PreflightReport>;
  now?: () => Date;
}

export interface UploadedFileResult {
  path: string;
  localPath: string;
  remotePath: string;
  size: number;
  hash: string;
}

export interface PushResult {
  dryRun: boolean;
  diff: Diff;
  planned: string[];
  uploaded: UploadedFileResult[];
  backupSnapshot: SnapshotMeta | null;
  nextState: State;
}

export class DeployError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DeployError';
  }
}

export class DeployLimitError extends DeployError {
  constructor(message: string) {
    super(message);
    this.name = 'DeployLimitError';
  }
}

export class DeployVerificationError extends DeployError {
  constructor(message: string) {
    super(message);
    this.name = 'DeployVerificationError';
  }
}

function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/^\/+/, '');
}

function localPath(localRoot: string, path: string): string {
  return join(localRoot, ...normalizePath(path).split('/'));
}

function remotePath(remoteRoot: string | undefined, path: string): string {
  const normalizedPath = normalizePath(path);
  const root = remoteRoot ? remoteRoot.replace(/\/+$/u, '') : '';
  if (root === '') {
    return normalizedPath;
  }
  return posix.join(root, normalizedPath);
}

function countDiff(diff: Diff): Record<keyof Diff, number> {
  return {
    added: diff.added.length,
    modified: diff.modified.length,
    removed: diff.removed.length,
    unchanged: diff.unchanged.length,
  };
}

function sortPaths(paths: Iterable<string>): string[] {
  return [...paths].sort((a, b) => a.localeCompare(b));
}

function targetPaths(diff: Diff, requested?: readonly string[]): string[] {
  const deployable = new Set([...diff.added, ...diff.modified]);
  if (!requested) {
    return sortPaths(deployable);
  }
  return sortPaths(requested.map(normalizePath).filter((path) => deployable.has(path)));
}

async function totalSize(localRoot: string, paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const path of paths) {
    total += (await stat(localPath(localRoot, path))).size;
  }
  return total;
}

async function enforceSafety(
  localRoot: string,
  paths: readonly string[],
  safety: PushSafetyOptions | undefined,
): Promise<void> {
  if (safety?.maxFilesPerPush !== undefined && paths.length > safety.maxFilesPerPush) {
    throw new DeployLimitError(
      `Push file count exceeds safety limit: files=${paths.length} max=${safety.maxFilesPerPush}`,
    );
  }

  if (safety?.maxTotalSizeBytes !== undefined) {
    const bytes = await totalSize(localRoot, paths);
    if (bytes > safety.maxTotalSizeBytes) {
      throw new DeployLimitError(
        `Push total size exceeds safety limit: bytes=${bytes} max=${safety.maxTotalSizeBytes}`,
      );
    }
  }
}

async function verifyUploadSize(
  uploader: DeployUploader,
  remotePath: string,
  expectedSize: number,
  uploadedBytes: number | undefined,
): Promise<void> {
  const remoteSize = uploader.size ? await uploader.size(remotePath) : uploadedBytes;
  if (remoteSize !== expectedSize) {
    throw new DeployVerificationError(
      `Upload size verification failed for ${remotePath}: expected=${expectedSize} actual=${String(
        remoteSize,
      )}`,
    );
  }
}

export async function runStatus(options: StatusOptions): Promise<StatusResult> {
  const diff = await computeDiff(options.localRoot, options.state, options.excluder, {
    followSymlinks: options.followSymlinks,
  });
  return {
    diff,
    counts: countDiff(diff),
  };
}

export async function runPush(options: PushOptions): Promise<PushResult> {
  const status = await runStatus(options);
  const planned = targetPaths(status.diff, options.files);
  await enforceSafety(options.localRoot, planned, options.safety);

  if (options.preflight) {
    const report = await options.preflight(
      planned.map((path) => localPath(options.localRoot, path)),
    );
    if (!report.ok) {
      throw new PreflightError(report);
    }
  }

  if (options.dryRun) {
    return {
      dryRun: true,
      diff: status.diff,
      planned,
      uploaded: [],
      backupSnapshot: null,
      nextState: options.state,
    };
  }

  await options.lock?.acquire();
  try {
    // v0.9.2: Always create a snapshot when `planned.length > 0` so
    // the operator's "every push is reversible" expectation holds even
    // for added-only pushes. All `planned` paths (added + modified)
    // are handed to `createAutoSnapshot`; the backup source is expected
    // to return `null` for any path it cannot read (e.g. added files
    // that don't yet exist on the remote). v0.10.0 will redesign the
    // snapshot to carry per-path added/modified/removed classification
    // so `rollback` can `delete` an added file as well — until then,
    // an added-only snapshot is metadata-only (fileCount = 0).
    const backupSnapshot =
      planned.length > 0 ? await options.backupStore.createAutoSnapshot(planned) : null;

    let nextState = options.state;
    const uploaded: UploadedFileResult[] = [];
    const verifyAfterUpload = options.safety?.verifyAfterUpload ?? 'size';
    const createdDirs = new Set<string>();
    for (const path of planned) {
      const absoluteLocalPath = localPath(options.localRoot, path);
      const absoluteRemotePath = remotePath(options.remoteRoot, path);

      if (options.uploader.mkdir) {
        // v0.2.5 (was: also skipped when parentDir === normalizedRemoteRoot,
        // which caused the very first push to a custom `remote_root` to fail
        // because nothing ever created `remote_root` itself on the server).
        // FtpClient.mkdir uses basic-ftp's ensureDir (mkdir -p semantics) so
        // calling it on an already-existing path is a cheap cd, not a real
        // MKD. The createdDirs Set still dedup's repeated calls within one
        // push, so removing the skip costs at most one cd per push.
        const parentDir = posix.dirname(absoluteRemotePath);
        if (
          parentDir !== '.' &&
          parentDir !== '/' &&
          parentDir !== '' &&
          !createdDirs.has(parentDir)
        ) {
          await options.uploader.mkdir(parentDir);
          createdDirs.add(parentDir);
        }
      }

      const info = await stat(absoluteLocalPath);
      const upload = await options.uploader.upload(absoluteLocalPath, absoluteRemotePath);

      if (verifyAfterUpload === 'size') {
        await verifyUploadSize(
          options.uploader,
          absoluteRemotePath,
          info.size,
          upload.bytesUploaded,
        );
      }

      const hash = await computeHash(absoluteLocalPath);
      nextState = updateFileEntry(nextState, path, hash, info.size, {
        updatedAt: (options.now ?? (() => new Date()))().toISOString(),
      });
      uploaded.push({
        path,
        localPath: absoluteLocalPath,
        remotePath: upload.remotePath,
        size: info.size,
        hash,
      });
    }

    return {
      dryRun: false,
      diff: status.diff,
      planned,
      uploaded,
      backupSnapshot,
      nextState,
    };
  } finally {
    await options.lock?.release();
  }
}
