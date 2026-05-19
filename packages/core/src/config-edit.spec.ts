import { describe, expect, it } from 'vitest';
import {
  appendProfileBlock,
  extractProfileBlock,
  findProfileBlockRange,
  isValidProfileName,
  removeProfileBlock,
  renameProfileBlock,
  setProfileField,
} from './config-edit.js';

const SAMPLE = [
  '# top-level comment',
  'schema = 2',
  '',
  '# production profile',
  '[profile.production]',
  'host = "ftp.example.com"',
  'port = 21',
  'user = "deploy"',
  'remote_root = "/public_html"',
  'local_root = "."',
  'keychain_service = "aiftp:production"',
  'server_kind = "starserver"',
  '',
  '[profile.staging]',
  'host = "stg.example.com"',
  'port = 21',
  'user = "stage"',
  'remote_root = "/stage"',
  'local_root = "."',
  'keychain_service = "aiftp:staging"',
  'server_kind = "generic"',
  '',
  '[encoding]',
  'file_name = "auto"',
  '',
  '[quirks]',
  'tls_check_hostname = true',
  '',
].join('\n');

describe('isValidProfileName', () => {
  it('accepts kebab-case identifiers starting with a letter or digit', () => {
    expect(isValidProfileName('production')).toBe(true);
    expect(isValidProfileName('staging')).toBe(true);
    expect(isValidProfileName('client-a-prod')).toBe(true);
    expect(isValidProfileName('site2024')).toBe(true);
    expect(isValidProfileName('a')).toBe(true);
  });

  it('rejects names with dots, slashes, spaces, quotes, or upper-case', () => {
    expect(isValidProfileName('Production')).toBe(false);
    expect(isValidProfileName('client.com')).toBe(false);
    expect(isValidProfileName('foo/bar')).toBe(false);
    expect(isValidProfileName('with space')).toBe(false);
    expect(isValidProfileName('with"quote')).toBe(false);
    expect(isValidProfileName('')).toBe(false);
    expect(isValidProfileName('-leading-dash')).toBe(false);
    expect(isValidProfileName('trailing-dash-')).toBe(false);
    expect(isValidProfileName('日本語')).toBe(false);
  });
});

describe('findProfileBlockRange', () => {
  it('returns the start/end line indices of an existing profile block', () => {
    const range = findProfileBlockRange(SAMPLE, 'production');
    expect(range).not.toBeNull();
    const lines = SAMPLE.split('\n');
    expect(lines[range?.start ?? -1]).toBe('[profile.production]');
    // end is exclusive -- points to the line *after* the block (next [table] or EOF)
    expect(lines[range?.end ?? -1]).toBe('[profile.staging]');
  });

  it('returns the second profile block correctly', () => {
    const range = findProfileBlockRange(SAMPLE, 'staging');
    expect(range).not.toBeNull();
    const lines = SAMPLE.split('\n');
    expect(lines[range?.start ?? -1]).toBe('[profile.staging]');
    expect(lines[range?.end ?? -1]).toBe('[encoding]');
  });

  it('returns null for non-existent profile', () => {
    expect(findProfileBlockRange(SAMPLE, 'does-not-exist')).toBeNull();
  });

  it('does not match top-level [encoding] / [quirks] / etc.', () => {
    expect(findProfileBlockRange(SAMPLE, 'encoding')).toBeNull();
  });
});

describe('extractProfileBlock', () => {
  it('returns the verbatim block text including the header but excluding the trailing blank line(s) before next table', () => {
    const block = extractProfileBlock(SAMPLE, 'production');
    expect(block).not.toBeNull();
    expect(block).toContain('[profile.production]');
    expect(block).toContain('host = "ftp.example.com"');
    expect(block).toContain('server_kind = "starserver"');
    expect(block).not.toContain('[profile.staging]');
  });

  it('returns null for non-existent profile', () => {
    expect(extractProfileBlock(SAMPLE, 'does-not-exist')).toBeNull();
  });
});

describe('removeProfileBlock', () => {
  it('removes the entire block including its header and field lines', () => {
    const after = removeProfileBlock(SAMPLE, 'staging');
    expect(after).not.toContain('[profile.staging]');
    expect(after).not.toContain('stg.example.com');
    // Other content preserved
    expect(after).toContain('[profile.production]');
    expect(after).toContain('[encoding]');
    expect(after).toContain('[quirks]');
    expect(after).toContain('# top-level comment');
    expect(after).toContain('# production profile');
  });

  it('returns the source unchanged when the profile does not exist', () => {
    expect(removeProfileBlock(SAMPLE, 'does-not-exist')).toBe(SAMPLE);
  });
});

describe('renameProfileBlock', () => {
  it('replaces only the [profile.OLD] header with [profile.NEW] and leaves field content unchanged', () => {
    const after = renameProfileBlock(SAMPLE, 'staging', 'staging-v2');
    expect(after).toContain('[profile.staging-v2]');
    expect(after).not.toContain('[profile.staging]');
    // Field lines verbatim, including the matching staging-prefixed *value* of keychain_service.
    // We intentionally do NOT rewrite field values; the caller must update keychain_service separately.
    expect(after).toContain('keychain_service = "aiftp:staging"');
    // Other profile untouched
    expect(after).toContain('[profile.production]');
  });

  it('returns the source unchanged when the source profile does not exist', () => {
    expect(renameProfileBlock(SAMPLE, 'does-not-exist', 'new')).toBe(SAMPLE);
  });

  it('throws when the destination profile already exists', () => {
    expect(() => renameProfileBlock(SAMPLE, 'production', 'staging')).toThrow(/already exists/i);
  });
});

describe('appendProfileBlock', () => {
  it('appends a new [profile.NAME] block at the end of the source, before EOF', () => {
    const after = appendProfileBlock(SAMPLE, 'demo', {
      host: 'demo.example.com',
      port: 21,
      protocol: 'ftps',
      user: 'demo-user',
      remote_root: '/demo',
      local_root: './demo',
      keychain_service: 'aiftp:demo',
      server_kind: 'generic',
    });
    expect(after).toContain('[profile.demo]');
    expect(after).toContain('host = "demo.example.com"');
    expect(after).toContain('user = "demo-user"');
    expect(after).toContain('server_kind = "generic"');
    // Existing blocks preserved
    expect(after).toContain('[profile.production]');
    expect(after).toContain('[profile.staging]');
    expect(after).toContain('[encoding]');
  });

  it('throws when a profile with that name already exists', () => {
    expect(() =>
      appendProfileBlock(SAMPLE, 'production', {
        host: 'h',
        port: 21,
        protocol: 'ftps',
        user: 'u',
        remote_root: '/',
        local_root: '.',
        keychain_service: 'k',
        server_kind: 'generic',
      }),
    ).toThrow(/already exists/i);
  });

  it('emits optional fields (account, ftps_mode, passive_mode) only when provided', () => {
    const minimal = appendProfileBlock('schema = 2\n', 'p1', {
      host: 'h',
      port: 21,
      protocol: 'ftps',
      user: 'u',
      remote_root: '/',
      local_root: '.',
      keychain_service: 'k',
      server_kind: 'generic',
    });
    expect(minimal).not.toContain('account');
    expect(minimal).not.toContain('ftps_mode');
    expect(minimal).not.toContain('passive_mode');

    const full = appendProfileBlock('schema = 2\n', 'p2', {
      host: 'h',
      port: 21,
      protocol: 'ftps',
      user: 'u',
      remote_root: '/',
      local_root: '.',
      keychain_service: 'k',
      server_kind: 'generic',
      account: 'billing',
      ftps_mode: 'explicit',
      passive_mode: true,
    });
    expect(full).toContain('account = "billing"');
    expect(full).toContain('ftps_mode = "explicit"');
    expect(full).toContain('passive_mode = true');
  });
});

describe('setProfileField', () => {
  it('replaces an existing field within a profile block, preserving comments and other fields', () => {
    const after = setProfileField(SAMPLE, 'production', 'host', '"new-host.example.com"');
    expect(after).toContain('host = "new-host.example.com"');
    expect(after).not.toContain('host = "ftp.example.com"');
    // Other fields untouched
    expect(after).toContain('user = "deploy"');
    expect(after).toContain('# production profile');
    // Staging untouched
    expect(after).toContain('host = "stg.example.com"');
  });

  it('appends the field within the block when it does not yet exist', () => {
    const after = setProfileField(SAMPLE, 'production', 'account', '"billing-account-7"');
    expect(after).toContain('account = "billing-account-7"');
    // Inserted within the production block, before [profile.staging]
    const prodIdx = after.indexOf('[profile.production]');
    const accountIdx = after.indexOf('account = "billing-account-7"');
    const stagingIdx = after.indexOf('[profile.staging]');
    expect(prodIdx).toBeLessThan(accountIdx);
    expect(accountIdx).toBeLessThan(stagingIdx);
  });

  it('throws when the profile does not exist', () => {
    expect(() => setProfileField(SAMPLE, 'does-not-exist', 'host', '"x"')).toThrow(/not found/i);
  });
});

describe('round-trip integrity', () => {
  it('extracting then appending under a new name preserves field shape', () => {
    const block = extractProfileBlock(SAMPLE, 'staging');
    expect(block).not.toBeNull();
    // The block text begins with the header and contains every field. We don't
    // test exact equality after a round trip through appendProfileBlock because
    // appendProfileBlock takes structured fields, not raw text. The block is
    // the input format for `duplicate`, which the CLI parses with @iarna/toml.
    expect(block).toMatch(/\[profile\.staging\]/u);
    expect(block).toMatch(/keychain_service\s*=\s*"aiftp:staging"/u);
  });

  it('comments survive a remove + append round trip', () => {
    const removed = removeProfileBlock(SAMPLE, 'staging');
    const re = appendProfileBlock(removed, 'staging', {
      host: 'stg.example.com',
      port: 21,
      protocol: 'ftps',
      user: 'stage',
      remote_root: '/stage',
      local_root: '.',
      keychain_service: 'aiftp:staging',
      server_kind: 'generic',
    });
    expect(re).toContain('# top-level comment');
    expect(re).toContain('# production profile');
  });
});
