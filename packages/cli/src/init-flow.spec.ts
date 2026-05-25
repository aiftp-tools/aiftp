import { describe, expect, it } from 'vitest';
import { buildInitFields, isStandardFtpPort } from './init-flow.ts';

describe('buildInitFields', () => {
  const fields = buildInitFields();

  it('returns the 11 fields matching the existing InitAnswers interface', () => {
    expect(fields.map((f) => f.name)).toEqual([
      'profile',
      'host',
      'port',
      'protocol',
      'user',
      'remoteRoot',
      'localRoot',
      'keychainService',
      'serverKind',
      'password',
      'consent',
    ]);
  });

  it('every field carries a hint (v0.11 A leg requirement)', () => {
    for (const f of fields) {
      expect(f.hint, `${f.name} must have a hint`).toBeDefined();
      expect(f.hint?.length, `${f.name} hint must not be empty`).toBeGreaterThan(0);
    }
  });

  it('port field validates the 1-65535 range', () => {
    const port = fields.find((f) => f.name === 'port');
    expect(port?.validate?.(99999 as never, {})).toMatch(/65535/);
    expect(port?.validate?.(0 as never, {})).toMatch(/65535/);
    expect(port?.validate?.(21 as never, {})).toBe(true);
    expect(port?.validate?.(990 as never, {})).toBe(true);
  });

  it('port field rejects non-integer types', () => {
    const port = fields.find((f) => f.name === 'port');
    expect(port?.validate?.('21' as never, {})).toMatch(/integer/);
    expect(port?.validate?.(Number.NaN as never, {})).toMatch(/integer/);
    expect(port?.validate?.(Number.NEGATIVE_INFINITY as never, {})).toMatch(/integer/);
  });

  it('keychainService initial derives from profile in answers', () => {
    const ks = fields.find((f) => f.name === 'keychainService');
    expect(typeof ks?.initial).toBe('function');
    if (typeof ks?.initial === 'function') {
      expect(ks.initial({ profile: 'staging' })).toBe('aiftp:staging');
      expect(ks.initial({})).toBe('aiftp:production');
      expect(ks.initial({ profile: '' })).toBe('aiftp:production');
    }
  });

  it('protocol initial is ftps (TLS encouraged by default)', () => {
    const protocol = fields.find((f) => f.name === 'protocol');
    expect(protocol?.initial).toBe('ftps');
  });

  it('required string fields all reject empty input', () => {
    const required = [
      'profile',
      'host',
      'user',
      'remoteRoot',
      'localRoot',
      'keychainService',
      'password',
    ];
    for (const name of required) {
      const field = fields.find((f) => f.name === name);
      expect(field?.validate?.('' as never, {}), `${name} should reject empty string`).toMatch(
        /required/,
      );
      expect(
        field?.validate?.('   ' as never, {}),
        `${name} should reject whitespace-only`,
      ).toMatch(/required/);
    }
  });
});

describe('isStandardFtpPort', () => {
  it('ftp accepts only 21', () => {
    expect(isStandardFtpPort(21, 'ftp')).toBe(true);
    expect(isStandardFtpPort(990, 'ftp')).toBe(false);
    expect(isStandardFtpPort(22, 'ftp')).toBe(false);
  });

  it('ftps accepts 21 and 990', () => {
    expect(isStandardFtpPort(21, 'ftps')).toBe(true);
    expect(isStandardFtpPort(990, 'ftps')).toBe(true);
    expect(isStandardFtpPort(8021, 'ftps')).toBe(false);
  });

  it('sftp accepts only 22', () => {
    expect(isStandardFtpPort(22, 'sftp')).toBe(true);
    expect(isStandardFtpPort(21, 'sftp')).toBe(false);
    expect(isStandardFtpPort(990, 'sftp')).toBe(false);
  });

  it('unknown protocol falls back to ftp behavior (port 21)', () => {
    expect(isStandardFtpPort(21, 'gopher')).toBe(true);
    expect(isStandardFtpPort(8021, 'gopher')).toBe(false);
  });
});
