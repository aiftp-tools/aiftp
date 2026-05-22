import { randomUUID } from 'node:crypto';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeDiff } from './diff.js';
import { createExcluder } from './exclude.js';
import { type State, computeHash } from './state.js';

describe('computeDiff', () => {
  let tempDir: string;
  const symlinkIt = process.platform === 'win32' ? it.skip : it;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `aiftp-diff-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeLocal(path: string, content: string): Promise<void> {
    const filePath = join(tempDir, ...path.split('/'));
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }

  it('classifies added, modified, removed, and unchanged files', async () => {
    await writeLocal('index.html', '<h1>same</h1>\n');
    await writeLocal('assets/app.css', 'body { color: black; }\n');
    await writeLocal('about.html', '<p>new</p>\n');

    const unchangedHash = await computeHash(join(tempDir, 'index.html'));
    const state: State = {
      schema: 1,
      files: {
        'index.html': {
          hash: unchangedHash,
          size: 14,
          updatedAt: '2026-05-18T09:00:00.000Z',
        },
        'assets/app.css': {
          hash: 'old-hash',
          size: 10,
          updatedAt: '2026-05-18T09:00:00.000Z',
        },
        'old.html': {
          hash: 'removed-hash',
          size: 20,
          updatedAt: '2026-05-18T09:00:00.000Z',
        },
      },
    };

    await expect(computeDiff(tempDir, state, createExcluder())).resolves.toEqual({
      added: ['about.html'],
      modified: ['assets/app.css'],
      removed: ['old.html'],
      unchanged: ['index.html'],
    });
  });

  it('applies user exclude patterns while allowing later negation', async () => {
    await writeLocal('dist/app.js', 'ignored build\n');
    await writeLocal('debug.log', 'ignored log\n');
    await writeLocal('keep.log', 'important log\n');

    const state: State = {
      schema: 1,
      files: {
        'dist/old.js': {
          hash: 'old-build',
          size: 10,
          updatedAt: '2026-05-18T09:00:00.000Z',
        },
        'debug.log': {
          hash: 'old-log',
          size: 10,
          updatedAt: '2026-05-18T09:00:00.000Z',
        },
      },
    };

    await expect(
      computeDiff(
        tempDir,
        state,
        createExcluder({ userPatterns: ['dist/', '*.log', '!keep.log'] }),
      ),
    ).resolves.toEqual({
      added: ['keep.log'],
      modified: [],
      removed: [],
      unchanged: [],
    });
  });

  it('always applies hard exclude patterns to local and state files', async () => {
    await writeLocal('.env', 'SECRET=local\n');
    await writeLocal('wp-config.php', '<?php // secret\n');
    await writeLocal('public.html', '<p>public</p>\n');

    const state: State = {
      schema: 1,
      files: {
        '.env': {
          hash: 'old-secret',
          size: 10,
          updatedAt: '2026-05-18T09:00:00.000Z',
        },
        'wp-config.php': {
          hash: 'old-wp',
          size: 10,
          updatedAt: '2026-05-18T09:00:00.000Z',
        },
      },
    };

    await expect(computeDiff(tempDir, state, createExcluder())).resolves.toEqual({
      added: ['public.html'],
      modified: [],
      removed: [],
      unchanged: [],
    });
  });

  it('returns removed state entries when the local root is empty', async () => {
    const state: State = {
      schema: 1,
      files: {
        'index.html': {
          hash: 'old-index',
          size: 10,
          updatedAt: '2026-05-18T09:00:00.000Z',
        },
      },
    };

    await expect(computeDiff(tempDir, state, createExcluder())).resolves.toEqual({
      added: [],
      modified: [],
      removed: ['index.html'],
      unchanged: [],
    });
  });

  symlinkIt('follows symlinked files only when followSymlinks is true', async () => {
    await writeLocal('fixtures/index.html', '<h1>fixture</h1>\n');
    await symlink(join(tempDir, 'fixtures', 'index.html'), join(tempDir, 'index.html'));

    const state: State = { schema: 1, files: {} };

    await expect(computeDiff(tempDir, state, createExcluder())).resolves.toEqual({
      added: ['fixtures/index.html'],
      modified: [],
      removed: [],
      unchanged: [],
    });
    await expect(
      computeDiff(tempDir, state, createExcluder(), { followSymlinks: true }),
    ).resolves.toEqual({
      added: ['fixtures/index.html', 'index.html'],
      modified: [],
      removed: [],
      unchanged: [],
    });
  });
});
