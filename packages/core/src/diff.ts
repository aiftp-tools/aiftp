import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Excluder } from './exclude.js';
import { type State, computeHash } from './state.js';

export interface WalkOptions {
  /**
   * v0.9.4+: when true, walkFiles follows symbolic links and treats
   * the target's file/directory type as if it were the entry's own.
   * Defaults to false (the prior implicit behaviour). Operators who
   * legitimately share fixtures via symlink can opt in via
   * `[walk] follow_symlinks = true` in `.aiftp.toml`.
   *
   * Note: no infinite-loop guard yet. If you enable this on a tree
   * with a self-referencing symlink chain the walk will eventually
   * run out of file descriptors. v0.10.0 may add a `visited` set.
   */
  followSymlinks?: boolean;
}

export interface Diff {
  added: string[];
  modified: string[];
  removed: string[];
  unchanged: string[];
}

function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/^\/+/, '');
}

function sortPaths(paths: Iterable<string>): string[] {
  return [...paths].sort((a, b) => a.localeCompare(b));
}

async function walkFiles(
  root: string,
  excluder: Excluder,
  relativeDir = '',
  options: WalkOptions = {},
): Promise<string[]> {
  const absoluteDir = relativeDir === '' ? root : join(root, ...relativeDir.split('/'));
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = normalizePath(
      relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`,
    );
    const match = excluder.shouldExclude(relativePath);
    if (match.excluded) {
      continue;
    }

    // v0.9.4+: resolve symlinks when followSymlinks is true.
    // Without this branch, entry.isSymbolicLink() falls through all
    // the entry.isFile() / entry.isDirectory() checks and gets
    // silently skipped — the surprising "added=0" we hit in A-7 when
    // ~/aiftp-verify/sakura/index.html was symlinked to a fixtures dir.
    let isFile = entry.isFile();
    let isDirectory = entry.isDirectory();
    if (options.followSymlinks && entry.isSymbolicLink()) {
      try {
        const resolved = await stat(join(absoluteDir, entry.name));
        isFile = resolved.isFile();
        isDirectory = resolved.isDirectory();
      } catch {
        // Broken symlink — treat as missing and skip silently.
        continue;
      }
    }

    if (isDirectory) {
      files.push(...(await walkFiles(root, excluder, relativePath, options)));
      continue;
    }

    if (isFile) {
      files.push(relativePath);
    }
  }

  return files;
}

function isTracked(path: string, excluder: Excluder): boolean {
  return !excluder.shouldExclude(path).excluded;
}

export async function computeDiff(
  localRoot: string,
  state: State,
  excluder: Excluder,
  options: WalkOptions = {},
): Promise<Diff> {
  const localFiles = sortPaths(await walkFiles(localRoot, excluder, '', options));
  const localSet = new Set(localFiles);
  const stateFiles = sortPaths(
    Object.keys(state.files)
      .map(normalizePath)
      .filter((p) => isTracked(p, excluder)),
  );

  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];

  for (const path of localFiles) {
    const stateEntry = state.files[path];
    if (!stateEntry) {
      added.push(path);
      continue;
    }

    const hash = await computeHash(join(localRoot, ...path.split('/')));
    if (hash === stateEntry.hash) {
      unchanged.push(path);
    } else {
      modified.push(path);
    }
  }

  const removed = stateFiles.filter((path) => !localSet.has(path));

  return {
    added: sortPaths(added),
    modified: sortPaths(modified),
    removed: sortPaths(removed),
    unchanged: sortPaths(unchanged),
  };
}
