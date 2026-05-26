import { getTemplate } from '@aiftp-tools/core';
import { describe, expect, it } from 'vitest';
import { buildInitFields, buildInitFieldsWithTemplate, isStandardFtpPort } from './init-flow.ts';

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

describe('buildInitFieldsWithTemplate — localRoot initial', () => {
  // Regression: v0.11 Pillar β review Phase 2-1. The previous implementation
  // had `localRoot.initial = '.'` for all templates, and renderConfig silently
  // overwrote the user's answer with `template.defaults.localRoot`. The screen
  // value and the TOML on disk diverged. Fix: the field's initial picks up
  // the template default so the user sees and confirms the same value that
  // ends up in .aiftp.toml.

  function localRootField(fields: ReturnType<typeof buildInitFieldsWithTemplate>) {
    const field = fields.find((f) => f.name === 'localRoot');
    if (!field) throw new Error('localRoot field missing');
    return field;
  }

  function resolveInitial(initial: unknown, answers: Record<string, unknown>): unknown {
    return typeof initial === 'function' ? initial(answers) : initial;
  }

  it('uses template default "dist" when --template static is prefilled', () => {
    const fields = buildInitFieldsWithTemplate(true, getTemplate('static'));
    expect(resolveInitial(localRootField(fields).initial, {})).toBe('dist');
  });

  it('uses template default "public" when --template laravel is prefilled', () => {
    const fields = buildInitFieldsWithTemplate(true, getTemplate('laravel'));
    expect(resolveInitial(localRootField(fields).initial, {})).toBe('public');
  });

  it('reads template-select answer to derive localRoot initial (no flag)', () => {
    const fields = buildInitFieldsWithTemplate(false);
    expect(resolveInitial(localRootField(fields).initial, { 'template-select': 'static' })).toBe(
      'dist',
    );
    expect(resolveInitial(localRootField(fields).initial, { 'template-select': 'laravel' })).toBe(
      'public',
    );
  });

  it('falls back to "." when no template is selected', () => {
    const fields = buildInitFieldsWithTemplate(false);
    expect(resolveInitial(localRootField(fields).initial, { 'template-select': 'none' })).toBe('.');
    expect(resolveInitial(localRootField(fields).initial, {})).toBe('.');
  });

  it('buildInitFields() backward-compat returns "." for localRoot initial', () => {
    expect(resolveInitial(localRootField(buildInitFields()).initial, {})).toBe('.');
  });
});
