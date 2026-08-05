import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildManifest } from './manifest.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const packagesDir = join(repoRoot, 'packages');

async function versionOf(packageJsonPath: string): Promise<string> {
  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    version?: unknown;
  };
  expect(typeof pkg.version, `${packageJsonPath} has no string "version" field`).toBe('string');
  return pkg.version as string;
}

/**
 * Enumerates workspace packages from what is actually on disk under `packages/` — the
 * same membership pnpm's `packages/*` workspace glob resolves to (see
 * `pnpm-workspace.yaml`). Deliberately not a hardcoded list: a package added later
 * (published or `private: true`) is covered automatically, with no edit to this test.
 */
async function discoverWorkspacePackageNames(): Promise<string[]> {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('version consistency', () => {
  it('keeps every discovered workspace package.json version identical to root', async () => {
    const rootPackageJsonPath = join(repoRoot, 'package.json');
    const rootVersion = await versionOf(rootPackageJsonPath);
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u);

    const packageNames = await discoverWorkspacePackageNames();
    // If the workspace glob or this discovery step ever resolves to nothing, the loop
    // below would vacuously pass — guard against that silently defeating the whole test.
    expect(packageNames.length, 'discovered zero packages under packages/').toBeGreaterThan(0);

    for (const name of packageNames) {
      const packageJsonPath = join(packagesDir, name, 'package.json');
      const version = await versionOf(packageJsonPath);
      expect(
        version,
        `${packageJsonPath}: version "${version}" does not match root package.json ("${rootPackageJsonPath}") version "${rootVersion}"`,
      ).toBe(rootVersion);
    }
  });

  it('stamps the manifest with the desktop-ext package version', async () => {
    const version = await versionOf(join(packagesDir, 'desktop-ext', 'package.json'));
    expect(buildManifest(version).version).toBe(version);
  });

  it('documents the same version in docs/desktop-extension.md', async () => {
    const version = await versionOf(join(repoRoot, 'package.json'));
    const docs = await readFile(join(repoRoot, 'docs', 'desktop-extension.md'), 'utf8');
    const match = /^- \*\*対応バージョン\*\*: (.+)$/mu.exec(docs);
    expect(match?.[1]).toBe(version);
  });

  it('has a CHANGELOG section and release links for the current version', async () => {
    const version = await versionOf(join(repoRoot, 'package.json'));
    const changelog = await readFile(join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain(`## [${version}] — `);
    expect(changelog).toContain(
      `[${version}]: https://github.com/aiftp-tools/aiftp/releases/tag/v${version}`,
    );
    expect(changelog).toContain(
      `[Unreleased]: https://github.com/aiftp-tools/aiftp/compare/v${version}...HEAD`,
    );
  });
});
