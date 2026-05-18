import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Excluder } from './exclude.js';
import { type State, computeHash } from './state.js';

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

async function walkFiles(root: string, excluder: Excluder, relativeDir = ''): Promise<string[]> {
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

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, excluder, relativePath)));
      continue;
    }

    if (entry.isFile()) {
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
): Promise<Diff> {
  const localFiles = sortPaths(await walkFiles(localRoot, excluder));
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
