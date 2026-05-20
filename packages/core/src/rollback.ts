import type { SnapshotId, SnapshotMeta } from './backup/store.js';
import type { Excluder } from './exclude.js';

/**
 * The slice of `BackupStore` that `runRollback` needs. Defined as a
 * structural type so callers can inject a mock or an MCP-bridge wrapper
 * without depending on the full BackupStore constructor surface.
 */
export interface RollbackBackupStore {
  listSnapshots(): Promise<SnapshotMeta[]>;
  /** Returns the DECRYPTED file content as a Buffer. */
  restoreFile(id: SnapshotId, path: string): Promise<Buffer>;
}

/**
 * The uploader contract for rollback. Compatible with `DeployUploader`
 * but with an in-memory `content` Buffer instead of a `localPath` —
 * rollback never materializes the decrypted file on disk (the bytes go
 * straight from the snapshot to the FTP socket, which means an attacker
 * with disk-read access can't recover the rolled-back content from a
 * leftover temp file).
 */
export interface RollbackUploader {
  upload(localPath: string, remotePath: string, content: Buffer): Promise<void>;
  mkdir?(remoteDir: string): Promise<void>;
}

export interface ResolveRollbackTargetOptions {
  store: { listSnapshots(): Promise<SnapshotMeta[]> };
  /**
   * Pick the N-th most recent AUTO snapshot. Default 1 (most recent).
   * Counts only `type === 'auto'` snapshots — `full` snapshots come from
   * manual `aiftp backup create` invocations and are not part of the
   * "undo the last N pushes" semantic.
   */
  steps?: number;
  /**
   * Explicit snapshot ID override. When set, `steps` is ignored and any
   * snapshot (auto or full) can be the rollback target.
   */
  snapshotId?: SnapshotId;
}

export async function resolveRollbackTarget(
  options: ResolveRollbackTargetOptions,
): Promise<SnapshotMeta> {
  const all = await options.store.listSnapshots();
  if (options.snapshotId) {
    const found = all.find((s) => s.id === options.snapshotId);
    if (!found) {
      throw new Error(
        `Rollback target snapshot not found: ${options.snapshotId}. Run \`aiftp backup list\` to see available ids.`,
      );
    }
    return found;
  }
  if (options.steps === undefined) {
    throw new Error(
      'Rollback requires either `steps` (an integer ≥ 1) or `snapshotId`. Pass --steps to undo the last N pushes, or --snapshot-id to target a specific snapshot.',
    );
  }
  const autoOrdered = [...all]
    .filter((s) => s.type === 'auto')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (options.steps < 1 || !Number.isInteger(options.steps)) {
    throw new Error(`steps must be a positive integer, got ${options.steps}`);
  }
  if (options.steps > autoOrdered.length) {
    throw new Error(
      `Cannot rollback ${options.steps} step(s): only ${autoOrdered.length} auto snapshot(s) available (too many steps requested).`,
    );
  }
  const target = autoOrdered[options.steps - 1];
  if (!target) {
    // Defensive: autoOrdered.length check above should have caught this.
    throw new Error(`Could not resolve rollback target at steps=${options.steps}`);
  }
  return target;
}

export type RollbackFileStatus = 'rolled-back' | 'skipped-hard-exclude' | 'skipped-dry-run';

export interface RollbackFileResult {
  path: string;
  remotePath: string;
  size: number;
  status: RollbackFileStatus;
  /** Human-readable reason for skipped entries (hard-exclude pattern, etc.). */
  reason?: string;
}

export interface RollbackOptions {
  snapshotId: SnapshotId;
  backupStore: RollbackBackupStore;
  uploader: RollbackUploader;
  /**
   * Remote path prefix applied to every file's `path` field to compute
   * the destination on the FTP server.
   */
  remoteRoot: string;
  /**
   * Hard-exclude / soft-exclude matcher. Files matching HARD_EXCLUDE
   * patterns (`.env`, `wp-config.php`, etc.) are NEVER uploaded — they
   * are reported in `result.skipped` with `status: 'skipped-hard-exclude'`.
   * This matches spec §9: auth-bearing files are protected from rollback
   * because pushing an old credentials file would silently downgrade a
   * production password rotation.
   */
  excluder: Excluder;
  /**
   * When true, computes the plan and reports it but performs no uploads.
   * The MCP `aiftp_rollback_prepare` tool relies on this to surface a
   * preview to the operator without side effects.
   */
  dryRun: boolean;
}

export interface RollbackResult {
  dryRun: boolean;
  snapshotId: SnapshotId;
  /**
   * Sorted list of file paths the rollback WOULD upload (i.e. files that
   * passed the hard-exclude filter). Used by the MCP layer to compute a
   * deterministic diff_hash.
   */
  planned: string[];
  rolledBack: RollbackFileResult[];
  skipped: RollbackFileResult[];
}

function joinRemote(remoteRoot: string, path: string): string {
  const root = remoteRoot.endsWith('/') ? remoteRoot.slice(0, -1) : remoteRoot;
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${root}/${clean}`;
}

/**
 * Restore the contents of a single snapshot to the FTP server.
 *
 * Pipeline per file:
 *   1. Test against `excluder` — hard-exclude patterns short-circuit to
 *      `skipped-hard-exclude` without ever calling `restoreFile`. This
 *      keeps the decrypted bytes out of memory entirely for auth-bearing
 *      files, even in dry-run.
 *   2. If `dryRun`, no decryption, no upload — entry is reported as
 *      `skipped-dry-run`.
 *   3. Otherwise `restoreFile` decrypts the snapshot entry; the Buffer
 *      is handed directly to the uploader (no temp file on disk).
 *
 * Determinism (important for MCP):
 *   - `planned` is the sorted list of paths that would upload. Same
 *     `snapshotId` + same `excluder` → identical `planned` between
 *     prepare and confirm.
 */
export async function runRollback(options: RollbackOptions): Promise<RollbackResult> {
  const snapshots = await options.backupStore.listSnapshots();
  const target = snapshots.find((s) => s.id === options.snapshotId);
  if (!target) {
    throw new Error(`Rollback target snapshot not found: ${options.snapshotId}.`);
  }

  const rolledBack: RollbackFileResult[] = [];
  const skipped: RollbackFileResult[] = [];

  // Two-pass design: classify first (hard-exclude check is pure), then
  // upload the surviving set. This guarantees that even if upload fails
  // partway through, the operator's view of which files are protected
  // matches the prepare-time preview exactly.
  type Classified = { meta: { path: string; size: number }; remotePath: string };
  const allowList: Classified[] = [];
  for (const file of target.files) {
    const verdict = options.excluder.shouldExclude(file.path);
    const remotePath = joinRemote(options.remoteRoot, file.path);
    if (verdict.excluded && verdict.reason === 'hard') {
      skipped.push({
        path: file.path,
        remotePath,
        size: file.sizeOriginal,
        status: 'skipped-hard-exclude',
        reason: `hard-exclude pattern: ${verdict.pattern}`,
      });
      continue;
    }
    allowList.push({
      meta: { path: file.path, size: file.sizeOriginal },
      remotePath,
    });
  }

  const planned = allowList.map((c) => c.meta.path).sort();

  if (options.dryRun) {
    return {
      dryRun: true,
      snapshotId: options.snapshotId,
      planned,
      rolledBack: [],
      skipped,
    };
  }

  for (const entry of allowList) {
    const content = await options.backupStore.restoreFile(options.snapshotId, entry.meta.path);
    await options.uploader.upload(
      // `localPath` is informational for the uploader implementation;
      // the actual bytes flow through `content`. We pass the snapshot-
      // relative path so logs and errors are readable.
      `<snapshot:${options.snapshotId}>:${entry.meta.path}`,
      entry.remotePath,
      content,
    );
    rolledBack.push({
      path: entry.meta.path,
      remotePath: entry.remotePath,
      size: entry.meta.size,
      status: 'rolled-back',
    });
  }

  return {
    dryRun: false,
    snapshotId: options.snapshotId,
    planned,
    rolledBack,
    skipped,
  };
}
