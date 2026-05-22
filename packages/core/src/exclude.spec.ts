import { describe, expect, it } from 'vitest';
import { Excluder, HARD_EXCLUDE_PATTERNS, createExcluder } from './exclude.js';

describe('HARD_EXCLUDE_PATTERNS', () => {
  it('includes credentials patterns', () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain('.env');
    expect(HARD_EXCLUDE_PATTERNS).toContain('.env.*');
    expect(HARD_EXCLUDE_PATTERNS).toContain('*.pem');
    expect(HARD_EXCLUDE_PATTERNS).toContain('*.key');
    expect(HARD_EXCLUDE_PATTERNS).toContain('id_rsa');
    expect(HARD_EXCLUDE_PATTERNS).toContain('id_rsa.*');
  });

  it('includes CMS config files', () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain('wp-config.php');
    expect(HARD_EXCLUDE_PATTERNS).toContain('database.yml');
    expect(HARD_EXCLUDE_PATTERNS).toContain('secrets.yml');
  });

  it('includes DB credential files', () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain('db.php');
    expect(HARD_EXCLUDE_PATTERNS).toContain('database.php');
    expect(HARD_EXCLUDE_PATTERNS).toContain('connection.php');
  });

  it('includes DB dumps', () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain('*.sql');
    expect(HARD_EXCLUDE_PATTERNS).toContain('*.sql.gz');
    expect(HARD_EXCLUDE_PATTERNS).toContain('*.dump');
    expect(HARD_EXCLUDE_PATTERNS).toContain('*.bak');
  });

  it('is frozen (cannot be mutated)', () => {
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: testing immutability
      (HARD_EXCLUDE_PATTERNS as any).push('foo');
    }).toThrow();
  });
});

describe('Excluder: hard exclude (cannot be disabled)', () => {
  const excluder = new Excluder();

  it('excludes .env at root', () => {
    const result = excluder.shouldExclude('.env');
    expect(result.excluded).toBe(true);
    expect(result.reason).toBe('hard');
  });

  it('excludes .env in nested directory', () => {
    const result = excluder.shouldExclude('apps/web/.env');
    expect(result.excluded).toBe(true);
    expect(result.reason).toBe('hard');
  });

  it('excludes .env.production', () => {
    expect(excluder.shouldExclude('.env.production').excluded).toBe(true);
  });

  it('excludes .env.local in nested directory', () => {
    expect(excluder.shouldExclude('src/.env.local').excluded).toBe(true);
  });

  it('excludes wp-config.php anywhere', () => {
    expect(excluder.shouldExclude('wp-config.php').excluded).toBe(true);
    expect(excluder.shouldExclude('wordpress/wp-config.php').excluded).toBe(true);
    expect(excluder.shouldExclude('a/b/c/wp-config.php').excluded).toBe(true);
  });

  it('excludes wp-config-sample.php', () => {
    expect(excluder.shouldExclude('wp-config-sample.php').excluded).toBe(true);
  });

  it('excludes *.pem files at any depth', () => {
    expect(excluder.shouldExclude('private.pem').excluded).toBe(true);
    expect(excluder.shouldExclude('certs/server.pem').excluded).toBe(true);
    expect(excluder.shouldExclude('a/b/c/x.pem').excluded).toBe(true);
  });

  it('excludes id_rsa and id_rsa.pub', () => {
    expect(excluder.shouldExclude('id_rsa').excluded).toBe(true);
    expect(excluder.shouldExclude('id_rsa.pub').excluded).toBe(true);
    expect(excluder.shouldExclude('.ssh/id_rsa').excluded).toBe(true);
  });

  it('excludes id_ed25519 family', () => {
    expect(excluder.shouldExclude('id_ed25519').excluded).toBe(true);
    expect(excluder.shouldExclude('id_ed25519.pub').excluded).toBe(true);
  });

  it('excludes *.sql and *.sql.gz', () => {
    expect(excluder.shouldExclude('backup.sql').excluded).toBe(true);
    expect(excluder.shouldExclude('dumps/2026-05-01.sql.gz').excluded).toBe(true);
  });

  it('excludes *.bak and *.dump', () => {
    expect(excluder.shouldExclude('site.bak').excluded).toBe(true);
    expect(excluder.shouldExclude('logs/db.dump').excluded).toBe(true);
  });

  it('excludes .htpasswd', () => {
    expect(excluder.shouldExclude('.htpasswd').excluded).toBe(true);
    expect(excluder.shouldExclude('admin/.htpasswd').excluded).toBe(true);
  });

  it('returns pattern that matched', () => {
    const result = excluder.shouldExclude('wp-config.php');
    expect(result.pattern).toBe('wp-config.php');
  });

  it('does NOT exclude unrelated files', () => {
    expect(excluder.shouldExclude('index.html').excluded).toBe(false);
    expect(excluder.shouldExclude('src/app.ts').excluded).toBe(false);
    expect(excluder.shouldExclude('assets/logo.png').excluded).toBe(false);
  });
});

describe('Excluder: hard exclude cannot be negated by user patterns', () => {
  it('user negation cannot rescue .env', () => {
    const excluder = new Excluder({ userPatterns: ['!.env'] });
    const result = excluder.shouldExclude('.env');
    expect(result.excluded).toBe(true);
    expect(result.reason).toBe('hard');
  });

  it('user negation cannot rescue wp-config.php', () => {
    const excluder = new Excluder({ userPatterns: ['!wp-config.php', '!**/wp-config.php'] });
    expect(excluder.shouldExclude('wp-config.php').excluded).toBe(true);
    expect(excluder.shouldExclude('wordpress/wp-config.php').excluded).toBe(true);
  });

  it('user negation cannot rescue *.pem', () => {
    const excluder = new Excluder({ userPatterns: ['!*.pem', '!**/*.pem'] });
    expect(excluder.shouldExclude('server.pem').excluded).toBe(true);
  });
});

describe('Excluder: additional hard patterns (append-only)', () => {
  it('respects custom hard patterns', () => {
    const excluder = new Excluder({
      additionalHardPatterns: ['custom-secret.php', 'private/**'],
    });
    expect(excluder.shouldExclude('custom-secret.php').excluded).toBe(true);
    expect(excluder.shouldExclude('private/data.txt').excluded).toBe(true);
  });

  it('additional hard patterns are also un-negatable', () => {
    const excluder = new Excluder({
      additionalHardPatterns: ['custom.config'],
      userPatterns: ['!custom.config', '!**/custom.config'],
    });
    expect(excluder.shouldExclude('custom.config').excluded).toBe(true);
  });

  it('built-in hard patterns remain after adding additional', () => {
    const excluder = new Excluder({
      additionalHardPatterns: ['custom.config'],
    });
    expect(excluder.shouldExclude('.env').excluded).toBe(true);
    expect(excluder.shouldExclude('custom.config').excluded).toBe(true);
  });
});

describe('Excluder: user gitignore-style patterns', () => {
  it('excludes by simple glob', () => {
    const excluder = new Excluder({ userPatterns: ['*.log'] });
    expect(excluder.shouldExclude('app.log').excluded).toBe(true);
    expect(excluder.shouldExclude('logs/server.log').excluded).toBe(true);
    expect(excluder.shouldExclude('app.txt').excluded).toBe(false);
  });

  it('excludes directory with trailing slash', () => {
    const excluder = new Excluder({ userPatterns: ['node_modules/'] });
    expect(excluder.shouldExclude('node_modules').excluded).toBe(true);
    expect(excluder.shouldExclude('node_modules/foo.js').excluded).toBe(true);
    expect(excluder.shouldExclude('packages/core/node_modules/bar.js').excluded).toBe(true);
  });

  it('excludes anchored pattern (leading slash)', () => {
    const excluder = new Excluder({ userPatterns: ['/build/'] });
    expect(excluder.shouldExclude('build/output.js').excluded).toBe(true);
    expect(excluder.shouldExclude('build').excluded).toBe(true);
    // Anchored: nested "build" directory should NOT match
    expect(excluder.shouldExclude('packages/core/build/x.js').excluded).toBe(false);
  });

  it('supports ** recursive glob', () => {
    const excluder = new Excluder({ userPatterns: ['**/*.tmp'] });
    expect(excluder.shouldExclude('a.tmp').excluded).toBe(true);
    expect(excluder.shouldExclude('a/b/c.tmp').excluded).toBe(true);
  });

  it('returns reason="soft" for user pattern match', () => {
    const excluder = new Excluder({ userPatterns: ['*.log'] });
    const result = excluder.shouldExclude('app.log');
    expect(result.reason).toBe('soft');
    expect(result.pattern).toBe('*.log');
  });

  it('supports negation to un-exclude a previous match', () => {
    const excluder = new Excluder({
      userPatterns: ['*.log', '!important.log'],
    });
    expect(excluder.shouldExclude('app.log').excluded).toBe(true);
    expect(excluder.shouldExclude('important.log').excluded).toBe(false);
  });

  it('ignores empty patterns and comments', () => {
    const excluder = new Excluder({
      userPatterns: ['', '   ', '# this is a comment', '*.log'],
    });
    expect(excluder.shouldExclude('app.log').excluded).toBe(true);
    expect(excluder.shouldExclude('app.txt').excluded).toBe(false);
  });

  it('excludes hidden directory like .git/', () => {
    const excluder = new Excluder({ userPatterns: ['.git/'] });
    expect(excluder.shouldExclude('.git/HEAD').excluded).toBe(true);
    expect(excluder.shouldExclude('.git/objects/ab/cdef').excluded).toBe(true);
  });

  it('does NOT exclude non-matching paths', () => {
    const excluder = new Excluder({ userPatterns: ['*.log'] });
    expect(excluder.shouldExclude('app.ts').excluded).toBe(false);
    expect(excluder.shouldExclude('README.md').excluded).toBe(false);
  });
});

describe('Excluder: path normalization', () => {
  it('handles paths starting with "./"', () => {
    const excluder = new Excluder();
    expect(excluder.shouldExclude('./.env').excluded).toBe(true);
    expect(excluder.shouldExclude('./apps/web/.env').excluded).toBe(true);
  });

  it('handles paths starting with "/"', () => {
    const excluder = new Excluder();
    expect(excluder.shouldExclude('/.env').excluded).toBe(true);
  });

  it('handles Windows-style backslashes', () => {
    const excluder = new Excluder();
    expect(excluder.shouldExclude('apps\\web\\.env').excluded).toBe(true);
    expect(excluder.shouldExclude('wordpress\\wp-config.php').excluded).toBe(true);
  });
});

describe('Excluder: getEffectivePatterns', () => {
  it('returns built-in hard patterns plus DEFAULT_EXCLUDE_PATTERNS as user patterns when no options given (v0.9.4 default-on)', () => {
    const excluder = new Excluder();
    const { hard, user } = excluder.getEffectivePatterns();
    expect(hard).toContain('.env');
    expect(hard).toContain('wp-config.php');
    // v0.9.4: defaults are auto-prepended into the user-pattern list.
    // The opt-out is `useDefaults: false`; that case is exercised in
    // default-exclude.spec.ts.
    expect(user).toContain('.aiftp.toml');
    expect(user).toContain('.DS_Store');
    expect(user).toContain('doctor-*.txt');
  });

  it('returns hard patterns and an empty user list when useDefaults is false', () => {
    const excluder = new Excluder({ useDefaults: false });
    const { hard, user } = excluder.getEffectivePatterns();
    expect(hard).toContain('.env');
    expect(user).toEqual([]);
  });

  it('appends additionalHardPatterns to hard list', () => {
    const excluder = new Excluder({ additionalHardPatterns: ['custom.config'] });
    const { hard } = excluder.getEffectivePatterns();
    expect(hard).toContain('.env');
    expect(hard).toContain('custom.config');
  });

  it('preserves user patterns verbatim (defaults are prepended in front; v0.9.4)', () => {
    const excluder = new Excluder({
      userPatterns: ['*.log', '!important.log', '.git/'],
    });
    const { user } = excluder.getEffectivePatterns();
    // v0.9.4: defaults come first, then the user patterns verbatim
    // (gitignore-style "later rule wins" preserved).
    expect(user.slice(-3)).toEqual(['*.log', '!important.log', '.git/']);
  });

  it('preserves user patterns verbatim with no defaults when opted out', () => {
    const excluder = new Excluder({
      userPatterns: ['*.log', '!important.log', '.git/'],
      useDefaults: false,
    });
    const { user } = excluder.getEffectivePatterns();
    expect(user).toEqual(['*.log', '!important.log', '.git/']);
  });
});

describe('Excluder: filter()', () => {
  it('returns only non-excluded paths', () => {
    const excluder = new Excluder({ userPatterns: ['*.log'] });
    const input = ['app.ts', 'app.log', 'src/index.ts', 'logs/access.log', '.env'];
    const result = excluder.filter(input);
    expect(result).toEqual(['app.ts', 'src/index.ts']);
  });

  it('returns empty array when all excluded', () => {
    const excluder = new Excluder({ userPatterns: ['**'] });
    expect(excluder.filter(['a.ts', 'b.ts'])).toEqual([]);
  });

  it('returns input when no exclusions match', () => {
    const excluder = new Excluder();
    const input = ['a.ts', 'b.ts', 'README.md'];
    expect(excluder.filter(input)).toEqual(input);
  });
});

describe('createExcluder factory', () => {
  it('returns an Excluder instance', () => {
    const ex = createExcluder({ userPatterns: ['*.log'] });
    expect(ex).toBeInstanceOf(Excluder);
    expect(ex.shouldExclude('a.log').excluded).toBe(true);
  });

  it('works with no options', () => {
    const ex = createExcluder();
    expect(ex.shouldExclude('.env').excluded).toBe(true);
  });
});

describe('Excluder: real-world deployment scenarios', () => {
  it('protects a typical WordPress upload', () => {
    const excluder = new Excluder({
      userPatterns: ['*.log', 'node_modules/', '.git/'],
    });

    // Should be uploaded
    expect(excluder.shouldExclude('wp-content/themes/mytheme/style.css').excluded).toBe(false);
    expect(excluder.shouldExclude('index.php').excluded).toBe(false);

    // Should be excluded (hard)
    expect(excluder.shouldExclude('wp-config.php').excluded).toBe(true);
    expect(excluder.shouldExclude('.env.production').excluded).toBe(true);

    // Should be excluded (user)
    expect(excluder.shouldExclude('debug.log').excluded).toBe(true);
    expect(excluder.shouldExclude('wp-content/themes/mytheme/node_modules/foo.js').excluded).toBe(
      true,
    );
    expect(excluder.shouldExclude('.git/HEAD').excluded).toBe(true);
  });

  it('protects a typical static site upload', () => {
    const excluder = new Excluder({
      userPatterns: ['node_modules/', '.git/', '.DS_Store', '*.map'],
    });

    expect(excluder.shouldExclude('index.html').excluded).toBe(false);
    expect(excluder.shouldExclude('assets/main.css').excluded).toBe(false);

    expect(excluder.shouldExclude('.DS_Store').excluded).toBe(true);
    expect(excluder.shouldExclude('assets/.DS_Store').excluded).toBe(true);
    expect(excluder.shouldExclude('assets/main.js.map').excluded).toBe(true);
  });

  it('protects PHP form deployment with custom secrets', () => {
    const excluder = new Excluder({
      additionalHardPatterns: ['turnstile-keys.php', 'mailer-config.php'],
      userPatterns: ['vendor/', 'composer.lock'],
    });

    expect(excluder.shouldExclude('contact.php').excluded).toBe(false);
    expect(excluder.shouldExclude('turnstile-keys.php').excluded).toBe(true);
    expect(excluder.shouldExclude('mailer-config.php').excluded).toBe(true);
    expect(excluder.shouldExclude('vendor/autoload.php').excluded).toBe(true);
  });
});
