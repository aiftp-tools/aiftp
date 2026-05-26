/**
 * Path utilities — v0.11 Pillar γ Codex review Phase 1-3.
 *
 * The config schema accepts tilde-prefixed paths like
 * `ssh_key_path = "~/.ssh/id_ed25519"` so the operator does not have
 * to spell out their home directory. The runtime boundary (here, and
 * everywhere we hand a path to fs.statSync / fs.readFileSync) must
 * resolve `~` before the call or the operating system returns
 * `ENOENT: no such file or directory, stat '~/.ssh/id_ed25519'`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Expand a leading `~` or `~/` in a path to the current user's home
 * directory. Returns the input unchanged when no expansion applies.
 *
 * - `~`        → `<homedir>`
 * - `~/x/y`    → `<homedir>/x/y`
 * - `/abs/p`   → `/abs/p`        (no change)
 * - `~user/p`  → `~user/p`       (no change — POSIX user-name expansion is intentionally NOT supported)
 *
 * The narrow ruleset matches `ssh(1)`'s practical behaviour for
 * `IdentityFile` paths: only the current user's home is recognised.
 */
export function expandTilde(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}
