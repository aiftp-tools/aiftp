import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, getTemplate } from '@aiftp-tools/core';
import { describe, expect, it } from 'vitest';
import {
  buildInitFields,
  buildInitFieldsFromInherited,
  buildInitFieldsWithTemplate,
  computeInheritedSections,
  extractInheritedProfileInitials,
  isStandardFtpPort,
  resolveInitFromRef,
} from './init-flow.ts';

function keychainField(fields: ReturnType<typeof buildInitFieldsWithTemplate>) {
  const field = fields.find((f) => f.name === 'keychainService');
  if (!field) throw new Error('keychainService field missing');
  return field;
}

function resolveInitial(initial: unknown, answers: Record<string, unknown>): unknown {
  return typeof initial === 'function' ? initial(answers) : initial;
}

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
    const ks = keychainField(fields);
    expect(typeof ks?.initial).toBe('function');
    if (typeof ks?.initial === 'function') {
      expect(ks.initial({ profile: 'staging' })).toBe('aiftp:staging');
      expect(ks.initial({})).toBe('aiftp:production');
      expect(ks.initial({ profile: '' })).toBe('aiftp:production');
    }
  });

  it('keychainService initial includes a supplied site name before the profile', () => {
    const ks = keychainField(buildInitFields('gwco'));
    expect(resolveInitial(ks.initial, { profile: 'production' })).toBe('aiftp:gwco-production');
  });

  it('keychainService initial falls back to the legacy profile-only format without a site name', () => {
    const emptySite = keychainField(buildInitFields(''));
    const undefinedSite = keychainField(buildInitFields(undefined));

    expect(resolveInitial(emptySite.initial, { profile: 'production' })).toBe('aiftp:production');
    expect(resolveInitial(undefinedSite.initial, { profile: 'staging' })).toBe('aiftp:staging');
  });

  it('keychainService initial sanitizes dirty site names before composing the service id', () => {
    const ks = keychainField(
      buildInitFieldsWithTemplate(true, undefined, undefined, 'gw:co\nsite'),
    );

    expect(resolveInitial(ks.initial, { profile: 'production' })).toBe(
      'aiftp:gw-co-site-production',
    );
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

describe('init --from inheritance', () => {
  const sourceConfig = (overrides: Record<string, unknown> = {}) =>
    configSchema.parse({
      schema: 2,
      profile: {
        production: {
          host: 'source.example.com',
          port: 990,
          protocol: 'ftps',
          user: 'source-user',
          remote_root: '/source',
          local_root: 'source-dist',
          keychain_service: 'aiftp:source',
          server_kind: 'lolipop',
          ftps_mode: 'implicit',
          passive_mode: false,
        },
      },
      ...overrides,
    });

  it('resolves a registered site name to its .aiftp.toml', async () => {
    const path = await resolveInitFromRef('source-site', {
      cwd: '/new-project',
      registry: {
        list: async () => [{ name: 'source-site', path: '/sites/source' }],
      },
    });

    expect(path).toBe('/sites/source/.aiftp.toml');
  });

  it('resolves a directory path to <dir>/.aiftp.toml', async () => {
    const directory = join(tmpdir(), `aiftp-init-from-dir-${crypto.randomUUID()}`);
    await mkdir(directory, { recursive: true });
    try {
      const path = await resolveInitFromRef(directory, {
        cwd: '/new-project',
        registry: { list: async () => [] },
      });

      expect(path).toBe(join(directory, '.aiftp.toml'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resolves a direct .aiftp.toml file path', async () => {
    const directory = join(tmpdir(), `aiftp-init-from-file-${crypto.randomUUID()}`);
    const file = join(directory, '.aiftp.toml');
    await mkdir(directory, { recursive: true });
    await writeFile(file, 'schema = 2\n', 'utf8');
    try {
      const path = await resolveInitFromRef(file, {
        cwd: '/new-project',
        registry: { list: async () => [] },
      });

      expect(path).toBe(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('throws an actionable error when neither a site nor path exists', async () => {
    await expect(
      resolveInitFromRef('missing-source', {
        cwd: tmpdir(),
        registry: { list: async () => [] },
      }),
    ).rejects.toThrow(/missing-source.*registered site.*path/i);
  });

  it('uses only connection defaults as inherited field initials', () => {
    const initials = extractInheritedProfileInitials(sourceConfig(), 'production');
    expect(initials).toEqual({
      serverKind: 'lolipop',
      protocol: 'ftps',
      port: 990,
      ftpsMode: 'implicit',
      passiveMode: false,
    });
    expect(initials).not.toHaveProperty('host');
    expect(initials).not.toHaveProperty('user');
    expect(initials).not.toHaveProperty('remoteRoot');
    expect(initials).not.toHaveProperty('localRoot');
    expect(initials).not.toHaveProperty('keychainService');

    const fields = buildInitFieldsFromInherited(initials);
    expect(fields.find((field) => field.name === 'port')?.initial).toBe(990);
    expect(fields.find((field) => field.name === 'ftpsMode')?.initial).toBe('implicit');
    expect(fields.find((field) => field.name === 'passiveMode')?.initial).toBe(false);
  });

  it('emits only a customized quirks field and omits all default sections', () => {
    const inherited = computeInheritedSections(
      sourceConfig({ quirks: { tls_check_hostname: false } }),
    );

    expect(inherited).toEqual({ quirks: { tls_check_hostname: false } });
  });

  it('returns no inherited sections for pure schema defaults', () => {
    expect(computeInheritedSections(sourceConfig())).toEqual({});
  });

  it('emits custom backup hard-exclude patterns but omits the default empty array', () => {
    expect(
      computeInheritedSections(
        sourceConfig({ backup: { hard_exclude: { additional_patterns: ['cache/**'] } } }),
      ),
    ).toEqual({ backup: { hard_exclude: { additional_patterns: ['cache/**'] } } });
    expect(computeInheritedSections(sourceConfig({ backup: { hard_exclude: {} } }))).toEqual({});
  });
});
