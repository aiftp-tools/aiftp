import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDE_PATTERNS, Excluder, createExcluder } from './exclude.js';

/**
 * v0.9.4 — default exclude rule.
 *
 * v0.9.3 and earlier: `DEFAULT_EXCLUDE_PATTERNS` was a constant in
 * exclude.ts but **was not automatically applied** by Excluder. As a
 * result, A-7 verification accidentally uploaded the operator's
 * `doctor-*.txt` / `doctor-*.json` debug output files to the Sakura
 * test account (CHANGELOG v0.9.2 "Known limitations" #2).
 *
 * v0.9.4: Excluder now auto-applies the DEFAULT_EXCLUDE_PATTERNS list
 * (gitignore-style "soft" exclude — overridable via user patterns with
 * leading `!`). Opt-out is available via `useDefaults: false` for the
 * rare operator who wants to ship `.DS_Store` etc.
 */

describe('DEFAULT_EXCLUDE_PATTERNS (v0.9.4 expanded)', () => {
  it('includes editor swap and backup files (the A-7 escape hatch)', () => {
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('*.swp');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('*.swo');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('*~');
  });

  it('includes OS metadata files', () => {
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.DS_Store');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('Thumbs.db');
  });

  it('includes doctor output files (the actual A-7 leak vector)', () => {
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('doctor-*.txt');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('doctor-*.json');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('doctor.txt');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('doctor.json');
  });

  it('keeps aiftp config and state out (v0.9.3 behaviour, must not regress)', () => {
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.aiftp/');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.aiftp.toml');
  });

  it('keeps .git out (v0.9.3 behaviour, must not regress)', () => {
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.git/');
  });
});

describe('Excluder: applies defaults automatically (v0.9.4)', () => {
  it('excludes .aiftp.toml without explicit user pattern', () => {
    const ex = createExcluder();
    const match = ex.shouldExclude('.aiftp.toml');
    expect(match.excluded).toBe(true);
  });

  it('excludes doctor-correct-pw.txt (the actual A-7 leak file)', () => {
    const ex = createExcluder();
    expect(ex.shouldExclude('doctor-correct-pw.txt').excluded).toBe(true);
  });

  it('excludes doctor-filter-on.json', () => {
    const ex = createExcluder();
    expect(ex.shouldExclude('doctor-filter-on.json').excluded).toBe(true);
  });

  it('excludes editor swap files (.foo.swp)', () => {
    const ex = createExcluder();
    expect(ex.shouldExclude('.index.html.swp').excluded).toBe(true);
    expect(ex.shouldExclude('index.html~').excluded).toBe(true);
  });

  it('excludes .DS_Store anywhere in the tree', () => {
    const ex = createExcluder();
    expect(ex.shouldExclude('.DS_Store').excluded).toBe(true);
    expect(ex.shouldExclude('sub/.DS_Store').excluded).toBe(true);
  });

  it('does NOT exclude regular HTML files (no false positive)', () => {
    const ex = createExcluder();
    expect(ex.shouldExclude('index.html').excluded).toBe(false);
    expect(ex.shouldExclude('about.html').excluded).toBe(false);
    expect(ex.shouldExclude('css/style.css').excluded).toBe(false);
  });
});

describe('Excluder: opt-out of defaults via useDefaults: false (v0.9.4)', () => {
  it('does not exclude .aiftp.toml when useDefaults is false', () => {
    const ex = new Excluder({ useDefaults: false });
    expect(ex.shouldExclude('.aiftp.toml').excluded).toBe(false);
  });

  it('does not exclude .DS_Store when useDefaults is false', () => {
    const ex = new Excluder({ useDefaults: false });
    expect(ex.shouldExclude('.DS_Store').excluded).toBe(false);
  });

  it('still applies HARD_EXCLUDE_PATTERNS when useDefaults is false', () => {
    // useDefaults: false does NOT disable hard excludes. Credentials
    // must be protected even if the operator opts out of the soft
    // defaults.
    const ex = new Excluder({ useDefaults: false });
    expect(ex.shouldExclude('.env').excluded).toBe(true);
    expect(ex.shouldExclude('wp-config.php').excluded).toBe(true);
  });
});

describe('Excluder: defaults precedence with user patterns', () => {
  it('user gitignore-style negation overrides default exclude (gitignore semantics)', () => {
    // Operator who actually wants to upload their .aiftp.toml (rare
    // but legal — e.g. a template repo) can opt-in with a negation.
    const ex = new Excluder({ userPatterns: ['!.aiftp.toml'] });
    expect(ex.shouldExclude('.aiftp.toml').excluded).toBe(false);
  });

  it('user patterns can NOT override hard excludes (regression guard)', () => {
    // `.env` is hard-excluded; no user pattern can let it through.
    const ex = new Excluder({ userPatterns: ['!.env'] });
    expect(ex.shouldExclude('.env').excluded).toBe(true);
  });
});
