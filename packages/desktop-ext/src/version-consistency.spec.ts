import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildManifest } from './manifest.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function versionOf(relativePath: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(repoRoot, relativePath), 'utf8')) as {
    version?: unknown;
  };
  expect(typeof pkg.version).toBe('string');
  return pkg.version as string;
}

describe('version consistency', () => {
  it('keeps all five package.json versions identical', async () => {
    const root = await versionOf('package.json');
    expect(root).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u);
    for (const pkg of ['core', 'mcp', 'cli', 'desktop-ext']) {
      expect(await versionOf(`packages/${pkg}/package.json`)).toBe(root);
    }
  });

  it('stamps the manifest with the desktop-ext package version', async () => {
    const version = await versionOf('packages/desktop-ext/package.json');
    expect(buildManifest(version).version).toBe(version);
  });

  it('documents the same version in docs/desktop-extension.md', async () => {
    const version = await versionOf('package.json');
    const docs = await readFile(join(repoRoot, 'docs', 'desktop-extension.md'), 'utf8');
    const match = /^- \*\*対応バージョン\*\*: (.+)$/mu.exec(docs);
    expect(match?.[1]).toBe(version);
  });

  it('has a CHANGELOG section and release links for the current version', async () => {
    const version = await versionOf('package.json');
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
