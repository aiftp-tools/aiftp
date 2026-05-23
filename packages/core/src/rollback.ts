import { randomUUID } from 'node:crypto';
import type { SnapshotFileMeta, SnapshotId, SnapshotMeta } from './backup/store.js';
import type { Excluder } from './exclude.js';
import { type State, removeFileEntry, updateFileEntry } from './state.js';

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
 * The uploader contract for rollback. **Buffer-shaped** (not path-shaped)
 * because rollback never materializes the decrypted file on disk — bytes
 * go from the snapshot Buffer straight to the FTP socket, so an attacker
 * with disk-read access can't recover the rolled-back content from a
 * leftover temp file.
 *
 * Codex v0.5.0 review (HIGH): this is a DIFFERENT contract from
 * `DeployUploader` (which is path-shaped for push). The MCP / CLI layers
 * must wire a real `RollbackUploader` — they cannot duck-type a
 * `DeployUploader` into one because the `upload` signatures differ.
 */
export interface RollbackUploader {
  /**
   * Upload `content` to `remotePath`. `localPath` is informational only
   * (used for logs / error messages) — the actual bytes come from
   * `content`, not from disk.
   */
  upload(localPath: string, remotePath: string, content: Buffer): Promise<void>;
  /**
   * Recursively create parent directories for an upload target. Optional
   * — but rollback against a remote that may have been pruned since
   * snapshot time needs this to avoid the first file failing the upload.
   */
  mkdir?(remoteDir: string): Promise<void>;
  /**
   * Atomic rename. When provided, `runRollback` writes each file to a
   * temp name first and renames into place, so a mid-upload failure
   * never leaves a half-written destination visible. When NOT provided
   * the uploader uploads directly to the final path (acceptable for
   * test mocks; FTP-backed uploaders should provide rename).
   */
  rename?(srcPath: string, destPath: string): Promise<void>;
  /**
   * Best-effort cleanup of a leftover temp file when upload-phase fails
   * after the bytes are partially written. Optional. Missing
   * implementations are tolerated — the operator may need to clean up
   * `*.aiftp-rb-<uuid>` files manually in that case.
   */
  unlink?(remotePath: string): Promise<void>;
  /**
   * Delete a remote path that was created by the push being rolled back.
   * Optional for compatibility with older CLI/MCP adapters; when missing,
   * delete-required entries are reported as `skipped-no-delete`.
   */
  delete?(remotePath: string): Promise<void>;
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
    throw new Error(`Could not resolve rollback target at steps=${options.steps}`);
  }
  return target;
}

export type RollbackFileStatus =
  | 'deleted'
  | 'rolled-back'
  | 'skipped-hard-exclude'
  | 'skipped-dry-run'
  | 'skipped-no-delete'
  | 'failed';

export interface RollbackFileResult {
  path: string;
  remotePath: string;
  size: number;
  status: RollbackFileStatus;
  /** Human-readable reason for skipped or failed entries. */
  reason?: string;
}

export interface RollbackOptions {
  snapshotId: SnapshotId;
  backupStore: RollbackBackupStore;
  uploader: RollbackUploader;
  /**
   * Current local deployment state. Real rollback mutates the remote, so
   * callers must persist `RollbackResult.nextState` after successful runs.
   */
  state?: State;
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
   *
   * NOTE: soft-exclude (user `[exclude].patterns`) files are NOT skipped
   * here. The backup store already filters by soft-exclude at snapshot
   * time, so any soft-excluded file in a snapshot was explicitly opted in
   * by the user via `additional_patterns` or similar — rollback honors
   * that opt-in.
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
  /**
   * Sorted list of file paths the rollback WOULD delete. These are
   * snapshot entries with `operation: "added"`: the original push created
   * the file, so rollback removes it instead of trying to restore content.
   */
  plannedDeletes: string[];
  /**
   * Files successfully rolled back. Sorted by path so a deterministic
   * order is always presented to the caller (matches `planned` order on
   * full success).
   */
  rolledBack: RollbackFileResult[];
  /**
   * Files successfully deleted during rollback. Sorted by path.
   */
  deleted: RollbackFileResult[];
  /**
   * State after a successful real rollback. Dry-run returns the input
   * state unchanged, matching push dry-run semantics.
   */
  nextState: State;
  /**
   * Files skipped (hard-exclude or dry-run) AND files that failed to
   * upload after starting. Failed entries carry `status: 'failed'` and a
   * `reason` describing the underlying error.
   */
  skipped: RollbackFileResult[];
}

function joinRemote(remoteRoot: string, path: string): string {
  const root = remoteRoot.endsWith('/') ? remoteRoot.slice(0, -1) : remoteRoot;
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${root}/${clean}`;
}

function remoteDirname(remotePath: string): string {
  const idx = remotePath.lastIndexOf('/');
  return idx <= 0 ? '/' : remotePath.slice(0, idx);
}

function restoreStateEntry(state: State, snapshot: SnapshotMeta, file: SnapshotFileMeta): State {
  if (file.sha256Original === null || file.sizeOriginal === null) {
    throw new Error(`Cannot restore state metadata for tombstone entry: ${file.path}`);
  }
  return updateFileEntry(state, file.path, file.sha256Original, file.sizeOriginal, {
    updatedAt: snapshot.createdAt,
  });
}

/**
 * Roll back a snapshot to the FTP server.
 *
 * Pipeline per file:
 *   1. Test against `excluder` — hard-exclude patterns short-circuit to
 *      `skipped-hard-exclude` before operation classification. Auth-bearing
 *      files are never decrypted, uploaded, or deleted.
 *   2. Schema 2 operations are split: `added` becomes a remote delete;
 *      `modified` / `removed` restore snapshot content by upload. Schema 1
 *      snapshots are migrated in memory by BackupStore as `modified`.
 *   3. If `dryRun`, no decryption, upload, or delete occurs.
 *   4. Otherwise:
 *      a. Pre-create the parent directory via `uploader.mkdir?` (so the
 *         first file doesn't fail against a pruned remote dir tree).
 *      b. If `uploader.rename` is available, **two-phase atomic write**:
 *         upload to `<remote>.aiftp-rb-<uuid>` then rename to `<remote>`.
 *         This makes each file's update atomic — readers see either the
 *         old content or the new content, never a half-written file.
 *         Per-file atomicity only; the batch as a whole is best-effort
 *         (if file 5/10 fails, files 1-4 are already renamed). The caller
 *         can re-run rollback to retry — re-uploading already-rolled-back
 *         files is idempotent.
 *      c. Otherwise (test mocks without rename): direct upload to the
 *         final path.
 *      d. If the upload-phase fails AFTER any bytes were written to the
 *         temp path, try `uploader.unlink?` to remove the orphan. If
 *         unlink is unavailable or itself fails, mention the temp path
 *         in the error so the operator can clean up manually.
 *
 * Determinism (important for MCP):
 *   - `planned` is the sorted upload set; `plannedDeletes` is the sorted
 *     delete set. Same `snapshotId` + same `excluder` → identical sets
 *     between prepare and confirm.
 *   - `rolledBack` and `deleted` are also sorted by path so equality checks
 *     across runs are stable.
 */
export async function runRollback(options: RollbackOptions): Promise<RollbackResult> {
  const snapshots = await options.backupStore.listSnapshots();
  const target = snapshots.find((s) => s.id === options.snapshotId);
  if (!target) {
    throw new Error(`Rollback target snapshot not found: ${options.snapshotId}.`);
  }
  const initialState = options.state ?? { schema: 1, files: {} };

  type Classified = {
    file: SnapshotFileMeta;
    meta: { path: string; size: number };
    remotePath: string;
  };
  const uploadList: Classified[] = [];
  const deleteList: Classified[] = [];
  const skipped: RollbackFileResult[] = [];

  // Two-pass design: classify first (hard-exclude check is pure), then
  // upload the surviving set. This guarantees that even if upload fails
  // partway through, the operator's view of which files are protected
  // matches the prepare-time preview exactly.
  for (const file of target.files) {
    const verdict = options.excluder.shouldExclude(file.path);
    const remotePath = joinRemote(options.remoteRoot, file.path);
    const size = file.sizeOriginal ?? 0;
    if (verdict.excluded && verdict.reason === 'hard') {
      skipped.push({
        path: file.path,
        remotePath,
        size,
        status: 'skipped-hard-exclude',
        reason: `hard-exclude pattern: ${verdict.pattern}`,
      });
      continue;
    }
    const entry = {
      file,
      meta: { path: file.path, size },
      remotePath,
    };
    if (file.operation === 'added') {
      deleteList.push(entry);
    } else {
      uploadList.push(entry);
    }
  }

  uploadList.sort((a, b) => a.meta.path.localeCompare(b.meta.path));
  deleteList.sort((a, b) => a.meta.path.localeCompare(b.meta.path));

  const planned = uploadList.map((c) => c.meta.path);
  const plannedDeletes = deleteList.map((c) => c.meta.path);

  if (options.dryRun) {
    return {
      dryRun: true,
      snapshotId: options.snapshotId,
      planned,
      plannedDeletes,
      rolledBack: [],
      deleted: [],
      nextState: initialState,
      skipped,
    };
  }

  const rolledBack: RollbackFileResult[] = [];
  const deleted: RollbackFileResult[] = [];
  let nextState = initialState;
  // mkdir is per-directory cached so we don't redundantly call ensureDir
  // for every file under the same parent. basic-ftp's ensureDir is
  // tolerant of "already exists" but the round-trip cost adds up.
  const mkdirSeen = new Set<string>();

  for (const entry of uploadList) {
    const parentDir = remoteDirname(entry.remotePath);
    if (options.uploader.mkdir && !mkdirSeen.has(parentDir)) {
      try {
        await options.uploader.mkdir(parentDir);
        mkdirSeen.add(parentDir);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // Don't abort the whole rollback for mkdir; the upload may still
        // succeed if the directory already exists with different ACLs.
        // We record it as a non-fatal warning and continue.
        skipped.push({
          path: entry.meta.path,
          remotePath: entry.remotePath,
          size: entry.meta.size,
          status: 'failed',
          reason: `mkdir(${parentDir}) failed: ${message}`,
        });
        continue;
      }
    }

    const content = await options.backupStore.restoreFile(options.snapshotId, entry.meta.path);
    const localLabel = `<snapshot:${options.snapshotId}>:${entry.meta.path}`;

    if (typeof options.uploader.rename === 'function') {
      // Two-phase atomic upload.
      const tmpRemote = `${entry.remotePath}.aiftp-rb-${randomUUID()}`;
      try {
        await options.uploader.upload(localLabel, tmpRemote, content);
      } catch (uploadError: unknown) {
        // Try to remove the orphan tmp. Best-effort: if unlink fails or
        // is unavailable, surface the tmp path so the operator can clean
        // up manually.
        if (typeof options.uploader.unlink === 'function') {
          await options.uploader.unlink(tmpRemote).catch(() => undefined);
        }
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
        const cleanupHint =
          typeof options.uploader.unlink !== 'function'
            ? `An orphan temp file may remain at ${tmpRemote}; remove it manually before retrying.`
            : 'Orphan tmp was cleaned up. Re-run rollback to retry.';
        throw new Error(`rollback failed at ${entry.meta.path}: ${message}. ${cleanupHint}`);
      }
      try {
        await options.uploader.rename(tmpRemote, entry.remotePath);
      } catch (renameError: unknown) {
        // Rename failed AFTER successful upload — the tmp file is the
        // intended content, just not at the final path. We do NOT
        // automatically remove it (the operator may want to recover it
        // manually). Surface the tmp path in the error.
        const message = renameError instanceof Error ? renameError.message : String(renameError);
        throw new Error(
          `rollback rename failed at ${entry.meta.path}: ${message}. ` +
            `The new content is at ${tmpRemote} on the server; remove the original ` +
            `${entry.remotePath} and rename ${tmpRemote} → ${entry.remotePath} manually.`,
        );
      }
    } else {
      // Direct upload — no atomicity guarantee. Test mocks land here.
      await options.uploader.upload(localLabel, entry.remotePath, content);
    }

    rolledBack.push({
      path: entry.meta.path,
      remotePath: entry.remotePath,
      size: entry.meta.size,
      status: 'rolled-back',
    });
    nextState = restoreStateEntry(nextState, target, entry.file);
  }

  for (const entry of deleteList) {
    if (typeof options.uploader.delete !== 'function') {
      skipped.push({
        path: entry.meta.path,
        remotePath: entry.remotePath,
        size: entry.meta.size,
        status: 'skipped-no-delete',
        reason: 'rollback uploader does not implement delete(remotePath)',
      });
      continue;
    }
    // FTP 550 "not found" is intentionally NOT swallowed — 550 can also
    // mean permission denied on Sakura/Lolipop; surface to caller.
    await options.uploader.delete(entry.remotePath);
    deleted.push({
      path: entry.meta.path,
      remotePath: entry.remotePath,
      size: entry.meta.size,
      status: 'deleted',
    });
    nextState = removeFileEntry(nextState, entry.meta.path);
  }

  // Sort rolledBack by path for deterministic output (matches `planned`).
  rolledBack.sort((a, b) => a.path.localeCompare(b.path));
  deleted.sort((a, b) => a.path.localeCompare(b.path));

  return {
    dryRun: false,
    snapshotId: options.snapshotId,
    planned,
    plannedDeletes,
    rolledBack,
    deleted,
    nextState,
    skipped,
  };
}
