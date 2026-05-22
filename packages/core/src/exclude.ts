import picomatch from 'picomatch';

/**
 * Hard-exclude patterns. These can NEVER be removed by user configuration.
 * Per spec §9, files matching these patterns:
 *   - May still be uploaded (user owns the deployment intent)
 *   - But are NEVER stored in local backups (credential exposure mitigation)
 *   - And are NEVER rollback targets (cannot be restored from backup)
 *
 * Users may APPEND to this list via `[backup.hard_exclude].additional_patterns`
 * but cannot remove any of the built-ins.
 */
export const HARD_EXCLUDE_PATTERNS: readonly string[] = Object.freeze([
  // --- Credentials and private keys ---
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_rsa.*',
  'id_ed25519',
  'id_ed25519.*',
  '*.p12',
  '*.pfx',
  '.htpasswd',

  // --- CMS / framework config files commonly holding secrets ---
  'wp-config.php',
  'wp-config-sample.php',
  'config.inc.php',
  'database.yml',
  'secrets.yml',
  'settings.local.py',

  // --- Files conventionally holding DB credentials ---
  'db.php',
  'database.php',
  'connection.php',
  'dbconfig.php',

  // --- DB dumps / SQL backups ---
  '*.sql',
  '*.sql.gz',
  '*.dump',
  '*.bak',
]);

/**
 * Soft-exclude defaults applied automatically by Excluder unless the
 * operator opts out with `useDefaults: false` (or `[exclude].use_defaults
 * = false` in `.aiftp.toml`).
 *
 * Unlike HARD_EXCLUDE_PATTERNS, these CAN be overridden by user negation
 * patterns (gitignore-style `!pattern`). Use this for "things you almost
 * certainly don't want uploaded but might in some legitimate cases."
 *
 * v0.9.4 additions (closes A-7 leak vector): doctor-*.txt / doctor-*.json
 * were uploaded to a Sakura test account during A-7 verification because
 * the previous version didn't auto-apply this list. Editor swap files
 * and OS metadata are also covered now.
 */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = Object.freeze([
  // --- aiftp's own files (must not deploy our state to the remote) ---
  '.aiftp/',
  '.aiftp.toml',
  '.aiftp.toml.bak',

  // --- VCS metadata ---
  '.git/',
  '.gitignore',
  '.gitattributes',

  // --- doctor / verification output (the actual A-7 leak vector) ---
  'doctor.txt',
  'doctor.json',
  'doctor-*.txt',
  'doctor-*.json',

  // --- Editor swap / backup files ---
  '*.swp',
  '*.swo',
  '*~',
  '#*#',
  '.#*',

  // --- OS metadata ---
  '.DS_Store',
  '._*',
  'Thumbs.db',
  'desktop.ini',
]);

export type ExcludeReason = 'hard' | 'soft' | null;

export interface ExcludeMatch {
  excluded: boolean;
  reason: ExcludeReason;
  pattern: string | null;
}

export interface ExcluderOptions {
  /**
   * gitignore-style patterns supplied by the user via `[exclude].patterns`.
   * Standard glob semantics: `*`, `**`, `?`, `[abc]`, trailing `/` for
   * directories, and leading `!` for negation (un-excludes a previous match).
   */
  userPatterns?: readonly string[];

  /**
   * Additional hard-exclude patterns supplied via
   * `[backup.hard_exclude].additional_patterns`. APPEND-ONLY: these add to
   * HARD_EXCLUDE_PATTERNS, they cannot remove built-ins.
   */
  additionalHardPatterns?: readonly string[];

  /**
   * v0.9.4+: automatically apply DEFAULT_EXCLUDE_PATTERNS (soft excludes
   * such as `.aiftp.toml`, `.DS_Store`, `doctor-*.txt`, etc.) on top of
   * `userPatterns`. The defaults are prepended so user `!`-negation can
   * still override them (gitignore semantics). Defaults to `true`; the
   * rare operator who wants to ship `.DS_Store` etc. can set this to
   * `false` via `[exclude].use_defaults = false`.
   *
   * Note: this flag does NOT control HARD_EXCLUDE_PATTERNS — credentials
   * are always excluded regardless of `useDefaults`.
   */
  useDefaults?: boolean;
}

interface CompiledPattern {
  pattern: string;
  negated: boolean;
  matcher: (path: string) => boolean;
}

const PICOMATCH_OPTIONS: picomatch.PicomatchOptions = {
  dot: true,
  basename: false,
  nocase: false,
  noglobstar: false,
};

function normalizePath(input: string): string {
  // Strip leading "./" and convert backslashes for cross-platform safety.
  let p = input.replace(/\\/g, '/');
  if (p.startsWith('./')) {
    p = p.slice(2);
  }
  // Trim leading slash so anchored patterns match relative paths.
  if (p.startsWith('/')) {
    p = p.slice(1);
  }
  return p;
}

function compileHardPattern(raw: string): CompiledPattern {
  // Hard patterns never accept negation.
  const pattern = raw.trim();
  if (pattern === '' || pattern.startsWith('#')) {
    throw new Error(`Invalid hard exclude pattern: '${raw}'`);
  }

  // A bare basename like "wp-config.php" or "*.pem" must match at any depth.
  // We compile both the literal pattern (for root-level paths) and a "**/"
  // prefixed variant (for nested paths).
  const isAnchored = pattern.includes('/') && !pattern.startsWith('**/');
  const patterns = isAnchored ? [pattern] : [pattern, `**/${pattern}`];
  const matchers = patterns.map((p) => picomatch(p, PICOMATCH_OPTIONS));

  return {
    pattern,
    negated: false,
    matcher: (path: string) => matchers.some((m) => m(path)),
  };
}

function compileUserPattern(raw: string): CompiledPattern | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.startsWith('#')) {
    return null;
  }

  let pattern = trimmed;
  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  }

  // Directory pattern (gitignore semantics): "build/" matches the directory
  // and everything inside. We expand to two matchers: the directory itself
  // and a `/**` recursive descent.
  const isDirectory = pattern.endsWith('/');
  if (isDirectory) {
    pattern = pattern.slice(0, -1);
  }

  const isAnchored = pattern.startsWith('/');
  if (isAnchored) {
    pattern = pattern.slice(1);
  }

  const matchPatterns: string[] = [];
  if (isAnchored) {
    matchPatterns.push(pattern);
    if (isDirectory) {
      matchPatterns.push(`${pattern}/**`);
    }
  } else {
    matchPatterns.push(pattern);
    matchPatterns.push(`**/${pattern}`);
    if (isDirectory) {
      matchPatterns.push(`${pattern}/**`);
      matchPatterns.push(`**/${pattern}/**`);
    }
  }

  const matchers = matchPatterns.map((p) => picomatch(p, PICOMATCH_OPTIONS));
  return {
    pattern: trimmed,
    negated,
    matcher: (path: string) => matchers.some((m) => m(path)),
  };
}

export class Excluder {
  private readonly hardPatterns: CompiledPattern[];
  private readonly userPatterns: CompiledPattern[];
  private readonly hardRaw: readonly string[];
  private readonly userRaw: readonly string[];

  constructor(options: ExcluderOptions = {}) {
    const additionalHard = options.additionalHardPatterns ?? [];
    this.hardRaw = Object.freeze([...HARD_EXCLUDE_PATTERNS, ...additionalHard]);
    // v0.9.4: prepend DEFAULT_EXCLUDE_PATTERNS unless explicitly opted
    // out. Prepending (not appending) lets user `!`-negations override
    // a default, matching gitignore's "later rule wins" semantics.
    const useDefaults = options.useDefaults !== false;
    const baseUserPatterns = useDefaults
      ? [...DEFAULT_EXCLUDE_PATTERNS, ...(options.userPatterns ?? [])]
      : [...(options.userPatterns ?? [])];
    this.userRaw = Object.freeze(baseUserPatterns);

    this.hardPatterns = this.hardRaw.map(compileHardPattern);
    this.userPatterns = this.userRaw
      .map(compileUserPattern)
      .filter((p): p is CompiledPattern => p !== null);
  }

  /**
   * Returns the effective set of patterns (hard + user). Hard patterns
   * are immutable across calls.
   */
  getEffectivePatterns(): { hard: readonly string[]; user: readonly string[] } {
    return { hard: this.hardRaw, user: this.userRaw };
  }

  /**
   * Tests whether the given path should be excluded.
   *
   * Resolution order:
   *   1. Hard exclude matches → always excluded, even if user negates.
   *   2. User patterns evaluated in order. Later patterns can negate
   *      earlier ones via leading "!" (gitignore semantics).
   *   3. No match → not excluded.
   */
  shouldExclude(rawPath: string): ExcludeMatch {
    const path = normalizePath(rawPath);

    for (const hp of this.hardPatterns) {
      if (hp.matcher(path)) {
        return { excluded: true, reason: 'hard', pattern: hp.pattern };
      }
    }

    let softMatch: ExcludeMatch = { excluded: false, reason: null, pattern: null };
    for (const up of this.userPatterns) {
      if (up.matcher(path)) {
        if (up.negated) {
          softMatch = { excluded: false, reason: null, pattern: up.pattern };
        } else {
          softMatch = { excluded: true, reason: 'soft', pattern: up.pattern };
        }
      }
    }

    return softMatch;
  }

  /**
   * Convenience: filter a list of paths, returning only those NOT excluded.
   */
  filter(paths: readonly string[]): string[] {
    return paths.filter((p) => !this.shouldExclude(p).excluded);
  }
}

/**
 * Convenience factory.
 */
export function createExcluder(options?: ExcluderOptions): Excluder {
  return new Excluder(options);
}
