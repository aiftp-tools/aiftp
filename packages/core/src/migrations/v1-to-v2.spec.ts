import { describe, expect, it } from 'vitest';
import { migrateV1ToV2Source } from './v1-to-v2.js';

describe('migrateV1ToV2Source: pure text transform', () => {
  it('rewrites `schema = 1` to `schema = 2` at the top of the file', () => {
    const v1 = ['schema = 1', '', '[profile.production]', 'host = "ftp.example.com"'].join('\n');
    const { source, changed } = migrateV1ToV2Source(v1);
    expect(changed).toBe(true);
    expect(source).toMatch(/^schema = 2\b/u);
    expect(source).not.toMatch(/schema = 1/u);
  });

  it('preserves comments, blank lines, and user-defined profile content verbatim', () => {
    const v1 = [
      '# top-level comment',
      'schema = 1',
      '',
      '# production profile',
      '[profile.production]',
      'host = "ftp.example.com" # inline note',
      'user = "deploy"',
      '',
    ].join('\n');
    const { source } = migrateV1ToV2Source(v1);
    expect(source).toContain('# top-level comment');
    expect(source).toContain('# production profile');
    expect(source).toContain('host = "ftp.example.com" # inline note');
  });

  it('appends [encoding] and [quirks] sections with sensible defaults when absent', () => {
    const v1 =
      'schema = 1\n\n[profile.production]\nhost = "h"\nuser = "u"\nremote_root = "/r"\nlocal_root = "."\nkeychain_service = "k"\n';
    const { source } = migrateV1ToV2Source(v1);
    expect(source).toMatch(/\[encoding\]\s*\nfile_name\s*=\s*"auto"/u);
    expect(source).toMatch(/\[quirks\]\s*\n[\s\S]*ignore_pasv_address\s*=\s*false/u);
    expect(source).toMatch(/tls_check_hostname\s*=\s*true/u);
    expect(source).toMatch(/use_mlsd\s*=\s*true/u);
    expect(source).toMatch(/noop_interval_sec\s*=\s*0/u);
  });

  it('does NOT duplicate [encoding] / [quirks] when they already exist in the file', () => {
    const v1 = [
      'schema = 1',
      '',
      '[profile.production]',
      'host = "h"',
      'user = "u"',
      'remote_root = "/r"',
      'local_root = "."',
      'keychain_service = "k"',
      '',
      '[encoding]',
      'file_name = "shift_jis"',
      '',
      '[quirks]',
      'use_mlsd = false',
      '',
    ].join('\n');
    const { source } = migrateV1ToV2Source(v1);
    const encodingCount = (source.match(/^\[encoding\]/gmu) ?? []).length;
    const quirksCount = (source.match(/^\[quirks\]/gmu) ?? []).length;
    expect(encodingCount).toBe(1);
    expect(quirksCount).toBe(1);
    // The user's custom values must survive verbatim.
    expect(source).toContain('file_name = "shift_jis"');
    expect(source).toContain('use_mlsd = false');
  });

  it('is idempotent: applying to a schema=2 source returns it unchanged with changed=false', () => {
    const v2 = ['schema = 2', '', '[profile.production]', 'host = "ftp.example.com"', ''].join(
      '\n',
    );
    const { source, changed } = migrateV1ToV2Source(v2);
    expect(changed).toBe(false);
    expect(source).toBe(v2);
  });

  it('rejects unsupported schema versions (e.g. 3, 0) with an explicit error', () => {
    expect(() => migrateV1ToV2Source('schema = 3\n')).toThrow(/unsupported schema/i);
    expect(() => migrateV1ToV2Source('schema = 0\n')).toThrow(/unsupported schema/i);
  });

  it('rejects sources that have no schema field at all', () => {
    expect(() => migrateV1ToV2Source('[profile.production]\nhost="h"\n')).toThrow(/schema field/i);
  });
});
