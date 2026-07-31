import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureGitignoreEntry } from './gitignore.js';

describe('ensureGitignoreEntry', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = join(tmpdir(), `aiftp-gitignore-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('creates .gitignore with .aiftp/ when the file is absent', async () => {
    const outcome = await ensureGitignoreEntry(cwd);
    expect(outcome).toBe('updated');
    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('.aiftp/\n');
  });

  it('appends a leading newline when the existing file lacks a trailing newline', async () => {
    await writeFile(join(cwd, '.gitignore'), 'node_modules', 'utf8');
    await ensureGitignoreEntry(cwd);
    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('node_modules\n.aiftp/\n');
  });

  it('is idempotent when the entry already exists', async () => {
    await writeFile(join(cwd, '.gitignore'), 'node_modules\n.aiftp/\n', 'utf8');
    const outcome = await ensureGitignoreEntry(cwd);
    expect(outcome).toBe('already-present');
    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('node_modules\n.aiftp/\n');
  });

  it('skips a non-git folder when requireGitRepo is true', async () => {
    const outcome = await ensureGitignoreEntry(cwd, { requireGitRepo: true });
    expect(outcome).toBe('skipped-not-a-repo');
    await expect(readFile(join(cwd, '.gitignore'), 'utf8')).rejects.toThrow();
  });

  it('writes into a git folder when requireGitRepo is true', async () => {
    await mkdir(join(cwd, '.git'), { recursive: true });
    const outcome = await ensureGitignoreEntry(cwd, { requireGitRepo: true });
    expect(outcome).toBe('updated');
    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('.aiftp/\n');
  });
});
