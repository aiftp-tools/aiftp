import { describe, expect, it } from 'vitest';
import { TemplateConfigSchema, getTemplate, listTemplates, templateIds } from './index.js';

describe('template registry', () => {
  it('registers exactly the 7 v0.11 templates', () => {
    expect(templateIds()).toEqual([
      'wordpress-swell',
      'wordpress-lightning',
      'wordpress-cocoon',
      'wordpress-standard',
      'static',
      'laravel',
      'php-simple',
    ]);
  });

  it('listTemplates returns all 7 entries', () => {
    expect(listTemplates()).toHaveLength(7);
  });

  it('getTemplate by id returns the matching config', () => {
    const swell = getTemplate('wordpress-swell');
    expect(swell?.description).toContain('SWELL');
    const laravel = getTemplate('laravel');
    expect(laravel?.defaults.localRoot).toBe('public');
  });

  it('getTemplate returns undefined for unknown id', () => {
    expect(getTemplate('drupal')).toBeUndefined();
    expect(getTemplate('')).toBeUndefined();
    expect(getTemplate('WORDPRESS-SWELL')).toBeUndefined(); // case-sensitive
  });

  it('every template passes TemplateConfigSchema', () => {
    for (const t of listTemplates()) {
      expect(() => TemplateConfigSchema.parse(t)).not.toThrow();
    }
  });

  it('every template id matches the lowercase-ASCII + hyphen pattern', () => {
    for (const id of templateIds()) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('every template has a description and longDescription', () => {
    for (const t of listTemplates()) {
      expect(t.description.length, `${t.id} description`).toBeGreaterThan(0);
      expect(t.longDescription.length, `${t.id} longDescription`).toBeGreaterThan(20);
    }
  });

  it('WordPress templates all include wp-content cache exclude', () => {
    const wpTemplates = listTemplates().filter((t) => t.id.startsWith('wordpress-'));
    expect(wpTemplates).toHaveLength(4);
    for (const t of wpTemplates) {
      expect(t.defaults.excludeAdd, `${t.id} excludes wp-content cache`).toContain(
        'wp-content/cache/**',
      );
      expect(t.defaults.preflightPhpLint, `${t.id} enables PHP lint`).toBe(true);
    }
  });

  it('laravel excludes secrets (.env*) and runtime caches', () => {
    const laravel = getTemplate('laravel');
    expect(laravel?.defaults.excludeAdd).toEqual(
      expect.arrayContaining(['.env*', 'vendor/**', 'storage/logs/**']),
    );
  });

  it('php-simple excludes .env* and common credential filenames', () => {
    const php = getTemplate('php-simple');
    expect(php?.defaults.excludeAdd).toEqual(
      expect.arrayContaining(['.env*', 'db.php', 'config.local.php']),
    );
  });

  it('static template defaults to "dist" local_root and no PHP lint', () => {
    const s = getTemplate('static');
    expect(s?.defaults.localRoot).toBe('dist');
    expect(s?.defaults.preflightPhpLint).toBeUndefined();
  });

  it('all templates mark *prod* / *www* / *-live as production', () => {
    for (const t of listTemplates()) {
      expect(t.defaults.safetyProductionPatterns).toEqual(
        expect.arrayContaining(['*prod*', '*www*', '*-live']),
      );
    }
  });

  it('TemplateConfigSchema rejects unknown defaults keys (strict mode)', () => {
    expect(() =>
      TemplateConfigSchema.parse({
        id: 'malicious',
        description: 'd',
        longDescription: 'd'.repeat(25),
        defaults: { localRoot: '.', someUnknownKey: true },
      }),
    ).toThrow();
  });

  it('TemplateConfigSchema rejects uppercase / underscore ids', () => {
    expect(() =>
      TemplateConfigSchema.parse({
        id: 'WordPress_Swell',
        description: 'd',
        longDescription: 'd'.repeat(25),
        defaults: {},
      }),
    ).toThrow();
  });
});
