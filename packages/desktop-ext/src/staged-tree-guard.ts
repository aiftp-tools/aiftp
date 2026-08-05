/**
 * Build-time guard for the `.mcpb` staging tree — the exact bytes every
 * training attendee downloads.
 *
 * It fails the build when the tree contains:
 *   1. a path from the build machine baked into a file (an absolute-path /
 *      identity leak, and dead metadata on the attendee's machine),
 *   2. an absolute path in a `package.json` value, in POSIX, Windows drive
 *      or UNC form,
 *   3. a symlink whose target leaves the staged tree (the old guard skipped
 *      every symlink, because `isFile()` is false for one),
 *   4. a `*.node` native binary (platform-specific; the manifest declares
 *      both darwin and win32, so a binary built here is wrong for the other
 *      platform).
 *
 * Three deliberate non-problems:
 *   - A symlink whose target stays inside the staged tree is fine. `npm
 *     install` creates `node_modules/.bin/*` that way, and they are what
 *     make the installed CLI runnable; only targets that are absolute or
 *     resolve outside the tree are refused.
 *   - RELATIVE `file:` specifiers are allowed even when they resolve beside
 *     rather than inside the staged tree. build-mcpb.mjs writes the tarball
 *     dependencies that way on purpose: a relative specifier cannot disclose
 *     the build machine's layout, which is the very leak this guard exists
 *     to stop. Only absolute or authority-bearing (`file://host/…`) ones are
 *     refused.
 *   - `forbiddenPaths` is passed in rather than hard-coded to
 *     `os.homedir()`. The original guard searched only for the home
 *     directory, so a build run from a CI workspace, `/private/tmp`, or
 *     another volume passed with its absolute paths intact.
 */

import { readFile, readdir, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface StagedTreeGuardOptions {
  /**
   * Absolute directories belonging to the build machine that must not
   * appear anywhere in the staged tree — typically the home directory and
   * the repository root (which is also the CI workspace root).
   */
  readonly forbiddenPaths: readonly string[];
}

/** Windows path comparison is case-insensitive; POSIX is not. */
const caseInsensitive = process.platform === 'win32';

function normalizeForSearch(value: string): string {
  return caseInsensitive ? value.toLowerCase() : value;
}

/**
 * A build path can reach a file in more than one shape: as typed, with
 * backslashes doubled by JSON encoding, or with separators flipped to `/`
 * by a tool that normalized it. Search for all three.
 */
function pathVariants(path: string): readonly string[] {
  return [...new Set([path, path.split('\\').join('\\\\'), path.split('\\').join('/')])];
}

type AbsoluteKind = 'POSIX absolute path' | 'Windows drive path' | 'Windows UNC path';

function absoluteKindOf(value: string): AbsoluteKind | undefined {
  if (value.startsWith('\\\\')) return 'Windows UNC path';
  if (/^[A-Za-z]:[\\/]/u.test(value)) return 'Windows drive path';
  if (value.startsWith('//')) return 'Windows UNC path';
  if (value.startsWith('/')) return 'POSIX absolute path';
  return undefined;
}

/** Every string value in a parsed JSON document, with its key path. */
function* stringValues(node: unknown, path: readonly string[] = []): Generator<[string, string]> {
  if (typeof node === 'string') {
    yield [path.join('.'), node];
    return;
  }
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) yield* stringValues(item, [...path, String(index)]);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, item] of Object.entries(node)) yield* stringValues(item, [...path, key]);
  }
}

function packageJsonProblems(text: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return ['is not valid JSON'];
  }
  const found: string[] = [];
  for (const [key, value] of stringValues(parsed)) {
    const specifier = value.startsWith('file:') ? value.slice('file:'.length) : value;
    const kind = absoluteKindOf(specifier);
    if (kind === undefined) continue;
    found.push(
      value.startsWith('file:')
        ? `${key}: file: specifier with an absolute target (${kind})`
        : `${key}: ${kind}`,
    );
  }
  return found;
}

/**
 * Human-readable descriptions of everything wrong with the staged tree.
 * Empty means the tree is safe to pack.
 */
export async function findStagedTreeProblems(
  root: string,
  options: StagedTreeGuardOptions,
): Promise<readonly string[]> {
  const forbidden = options.forbiddenPaths.flatMap((path) => pathVariants(path));
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const symlinks: string[] = [];
  const nativeBinaries: string[] = [];
  const leaks: string[] = [];
  const absolutePaths: string[] = [];

  for (const entry of entries) {
    const filePath = join(entry.parentPath ?? entry.path, entry.name);
    if (entry.isSymbolicLink()) {
      // Inspect the target rather than rejecting every symlink: npm's
      // node_modules/.bin/* entries are relative links that stay inside
      // the tree and are what make the installed CLI runnable. A target
      // that is absolute, or that resolves outside the staged root, points
      // at the build machine and must never ship.
      const target = await readlink(filePath).catch(() => '');
      const kind = absoluteKindOf(target);
      if (kind !== undefined) {
        symlinks.push(`${relative(root, filePath)} — absolute target (${kind})`);
        continue;
      }
      const escaped = relative(root, resolve(dirname(filePath), target));
      if (escaped.startsWith('..') || isAbsolute(escaped)) {
        // The target itself is a build-machine path, so it is not echoed.
        symlinks.push(`${relative(root, filePath)} — target resolves outside the bundle`);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (filePath.endsWith('.node')) {
      nativeBinaries.push(relative(root, filePath));
      continue;
    }
    const contents = await readFile(filePath, 'utf8').catch(() => '');
    const haystack = normalizeForSearch(contents);
    if (forbidden.some((needle) => haystack.includes(normalizeForSearch(needle)))) {
      leaks.push(relative(root, filePath));
    }
    if (entry.name === 'package.json') {
      for (const problem of packageJsonProblems(contents)) {
        absolutePaths.push(`${relative(root, filePath)} — ${problem}`);
      }
    }
  }

  const problems: string[] = [];
  const list = (items: readonly string[]) => items.map((item) => `  - ${item}`).join('\n');
  if (leaks.length > 0) {
    problems.push(
      `${leaks.length} file(s) contain a path belonging to the build machine:\n${list(leaks)}`,
    );
  }
  if (absolutePaths.length > 0) {
    problems.push(
      `${absolutePaths.length} absolute path(s) found in package.json values:\n${list(absolutePaths)}`,
    );
  }
  if (symlinks.length > 0) {
    problems.push(
      `${symlinks.length} symlink(s) escape the bundle (they would point at the build machine):\n${list(symlinks)}`,
    );
  }
  if (nativeBinaries.length > 0) {
    problems.push(
      `${nativeBinaries.length} native .node binary/binaries found (platform-specific, breaks the other target platform):\n${list(nativeBinaries)}`,
    );
  }
  return problems;
}

/** Throws, naming every offending file, when the staged tree is not safe to pack. */
export async function guardStagedTree(
  root: string,
  options: StagedTreeGuardOptions,
): Promise<void> {
  const problems = await findStagedTreeProblems(root, options);
  if (problems.length === 0) return;
  throw new Error(
    `build-mcpb: refusing to pack a tainted staging tree.\n\n${problems.join('\n\n')}`,
  );
}
