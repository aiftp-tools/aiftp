import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from './index.js';

describe('core', () => {
  it('exports VERSION constant matching the package release line', () => {
    // VERSION is the runtime version surfaced by `aiftp --version`.
    // It is bumped in lockstep with the release tag in `CHANGELOG.md`.
    // Keep this assertion as a semver shape check so the test does not
    // need to be edited on every patch release — only when the shape
    // (semver vs date-based etc.) changes.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u);
  });

  it('generates VERSION before root-level test commands import core', async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.pretest).toBe('pnpm --filter @aiftp-tools/core prebuild');
    expect(pkg.scripts?.['pretest:coverage']).toBe('pnpm --filter @aiftp-tools/core prebuild');
  });
});
