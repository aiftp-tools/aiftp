/**
 * Path utilities — v0.11 Pillar γ Codex review Phase 1-3 + v0.11
 * security review.
 *
 * The config schema accepts tilde-prefixed paths like
 * `ssh_key_path = "~/.ssh/id_ed25519"` so the operator does not have
 * to spell out their home directory. The runtime boundary (here, and
 * everywhere we hand a path to fs.statSync / fs.readFileSync) must
 * resolve `~` before the call or the operating system returns
 * `ENOENT: no such file or directory, stat '~/.ssh/id_ed25519'`.
 *
 * Additionally provides traversal-safe guards (`assertSafeRemotePath`,
 * `assertSafeLocalKeyPath`) so caller code cannot be tricked into
 * accepting a `..` segment from config / FileZilla XML / CLI prompt
 * answers.
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

/**
 * v0.11 security review (CWE-22): reject a remote / virtual path
 * whose segments include `..`, embedded NUL, double slashes that
 * collapse a segment, or control characters. Throws on violation so
 * the caller does not have to thread error returns through deploy
 * paths.
 *
 * Accepted:
 *  - `/public_html`              (leading slash, single segment)
 *  - `/public_html/wp/index.php` (multiple segments)
 *  - `public_html/wp`            (relative is OK — server CWD anchors)
 *  - empty string  (interpreted as "current dir" by some callers)
 *
 * Rejected:
 *  - any segment === `..` or `.`
 *  - any segment containing `\` (Windows-style separator)
 *  - any character in U+0000..U+001F
 *  - any `//` that would collapse to an empty segment
 */
export function assertSafeRemotePath(path: string, fieldLabel: string): void {
  if (typeof path !== 'string') {
    throw new Error(`${fieldLabel} must be a string`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate denylist
  if (/[\u0000-\u001f]/u.test(path)) {
    throw new Error(`${fieldLabel} must not contain control characters`);
  }
  if (path.includes('\\')) {
    throw new Error(`${fieldLabel} must not contain backslash — remote paths are POSIX-style`);
  }
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error(`${fieldLabel} must not contain "${seg}" segment (path traversal denied)`);
    }
  }
  // Reject empty internal segments ("a//b") but allow trailing slash
  // ("/public_html/") and leading slash ("/public_html") since those
  // are normal shapes.
  const internal = segments.slice(1, -1);
  for (const seg of internal) {
    if (seg === '') {
      throw new Error(`${fieldLabel} must not contain empty path segment (//)`);
    }
  }
}

/**
 * v0.11 security review (CWE-22 / CWE-367): hardened version of
 * `expandTilde` for local key file lookup. Resolves `~/...`,
 * rejects `..` segments after expansion, and lets the caller decide
 * how to handle symlinks (callers typically use `lstat` then refuse
 * symlinks before `readFileSync`).
 *
 * Returns the resolved absolute-ish path (string). Does NOT touch the
 * filesystem — that's the caller's job.
 */
export function safeExpandLocalPath(path: string, fieldLabel: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`${fieldLabel} must be a non-empty string`);
  }
  // Reject `..` on the RAW input (pre-expansion). Post-expansion check
  // is insufficient because `path.join(homedir(), '../../etc')` resolves
  // the `..` away — `~/../../../etc/passwd` would silently become
  // `/etc/passwd` and pass the check.
  for (const seg of path.split('/')) {
    if (seg === '..') {
      throw new Error(`${fieldLabel} must not contain ".." segment`);
    }
  }
  return expandTilde(path);
}
