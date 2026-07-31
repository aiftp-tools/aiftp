import { appendFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const IGNORE_ENTRY = '.aiftp/';

export type EnsureGitignoreOutcome = 'updated' | 'already-present' | 'skipped-not-a-repo';

export interface EnsureGitignoreOptions {
  /**
   * When true, do nothing unless `<cwd>/.git` exists. The Desktop bootstrap
   * sets this because a trainee's site folder is usually not a repository and
   * creating a stray .gitignore there is noise, not safety.
   * The CLI `init` keeps the historical behaviour (false) so an operator who
   * runs `aiftp init` before `git init` still gets the guard.
   */
  readonly requireGitRepo?: boolean;
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await stat(join(cwd, '.git'))) !== undefined;
  } catch {
    return false;
  }
}

export async function ensureGitignoreEntry(
  cwd: string,
  options: EnsureGitignoreOptions = {},
): Promise<EnsureGitignoreOutcome> {
  if (options.requireGitRepo === true && !(await isGitRepo(cwd))) {
    return 'skipped-not-a-repo';
  }
  const path = join(cwd, '.gitignore');
  const source = await readFile(path, 'utf8').catch(() => '');
  if (source.split(/\r?\n/u).includes(IGNORE_ENTRY)) {
    return 'already-present';
  }
  const prefix = source.length > 0 && !source.endsWith('\n') ? '\n' : '';
  await appendFile(path, `${prefix}${IGNORE_ENTRY}\n`, 'utf8');
  return 'updated';
}
