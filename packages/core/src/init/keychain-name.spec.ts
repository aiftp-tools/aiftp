import { describe, expect, it } from 'vitest';
import { buildKeychainService, sanitizeKeychainSiteName } from './keychain-name.js';

describe('sanitizeKeychainSiteName', () => {
  it('returns an empty string for undefined', () => {
    expect(sanitizeKeychainSiteName(undefined)).toBe('');
  });

  it('replaces path separators and colons with a single hyphen', () => {
    expect(sanitizeKeychainSiteName('a:/b\\c')).toBe('a-b-c');
  });

  it('collapses runs of hyphens and trims leading/trailing hyphens', () => {
    expect(sanitizeKeychainSiteName('  --my site--  ')).toBe('my-site');
  });

  it('keeps dots, underscores and hyphens', () => {
    expect(sanitizeKeychainSiteName('my_site.v2-a')).toBe('my_site.v2-a');
  });
});

describe('buildKeychainService', () => {
  it('builds a site-scoped service name', () => {
    expect(buildKeychainService('gwco', 'production')).toBe('aiftp:gwco-production');
  });

  it('falls back to a profile-only name when the site name sanitizes to empty', () => {
    expect(buildKeychainService('///', 'production')).toBe('aiftp:production');
  });

  it('falls back to a profile-only name when the site name is undefined', () => {
    expect(buildKeychainService(undefined, 'staging')).toBe('aiftp:staging');
  });
});
