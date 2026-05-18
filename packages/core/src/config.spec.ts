import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  ConfigParseError,
  ConfigValidationError,
  loadConfig,
  validateConfig,
} from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(here, '__fixtures__', 'config', name);

describe('config: loadConfig', () => {
  it('loads minimal config and applies defaults', async () => {
    const cfg = await loadConfig(fixture('minimal.toml'));
    expect(cfg.schema).toBe(1);
    expect(cfg.profile.production?.host).toBe('ftp.example.com');
    expect(cfg.profile.production?.port).toBe(21);
    expect(cfg.profile.production?.protocol).toBe('ftps');
    expect(cfg.profile.production?.server_kind).toBe('generic');
  });

  it('loads full config preserving all explicit values', async () => {
    const cfg = await loadConfig(fixture('full.toml'));
    expect(cfg.profile.production?.server_kind).toBe('starserver');
    expect(cfg.profile.staging?.user).toBe('deploy-stage');
    expect(cfg.exclude.patterns).toContain('node_modules/');
    expect(cfg.safety.require_tls).toBe(true);
    expect(cfg.safety.verify_after_upload).toBe('size');
    expect(cfg.safety.deletion_policy).toBe('never');
    expect(cfg.backup.encrypt).toBe(true);
    expect(cfg.backup.encryption_algorithm).toBe('aes-256-gcm');
    expect(cfg.backup.hard_exclude.additional_patterns).toEqual(['custom-secret.php']);
    expect(cfg.connection.retry_count).toBe(5);
    expect(cfg.connection.retry_backoff_ms).toEqual([1000, 3000, 9000, 27000, 60000]);
    expect(cfg.hooks.pre_push).toEqual(['npm run build']);
  });

  it('applies safety defaults when section is omitted', async () => {
    const cfg = await loadConfig(fixture('minimal.toml'));
    expect(cfg.safety.require_tls).toBe(true);
    expect(cfg.safety.verify_certificate).toBe(true);
    expect(cfg.safety.max_files_per_push).toBe(500);
    expect(cfg.safety.max_total_size_mb).toBe(100);
    expect(cfg.safety.deletion_policy).toBe('never');
    expect(cfg.safety.server_lock).toBe(true);
    expect(cfg.safety.verify_after_upload).toBe('size');
    expect(cfg.safety.syntax_check).toBe(true);
  });

  it('applies backup defaults when section is omitted', async () => {
    const cfg = await loadConfig(fixture('minimal.toml'));
    expect(cfg.backup.auto_before_push).toBe(true);
    expect(cfg.backup.retention_count).toBe(30);
    expect(cfg.backup.max_disk_mb).toBe(500);
    expect(cfg.backup.on_limit_exceeded).toBe('halt');
    expect(cfg.backup.encrypt).toBe(true);
    expect(cfg.backup.cloud_backup).toBe(false);
    expect(cfg.backup.hard_exclude.additional_patterns).toEqual([]);
  });

  it('applies connection defaults when section is omitted', async () => {
    const cfg = await loadConfig(fixture('minimal.toml'));
    expect(cfg.connection.max_concurrent).toBe(2);
    expect(cfg.connection.retry_count).toBe(5);
    expect(cfg.connection.timeout_ms).toBe(60000);
    expect(cfg.connection.resume_partial_upload).toBe(true);
    expect(cfg.connection.retry_backoff_ms.length).toBe(5);
  });

  it('applies hooks defaults when section is omitted', async () => {
    const cfg = await loadConfig(fixture('minimal.toml'));
    expect(cfg.hooks.pre_push).toEqual([]);
    expect(cfg.hooks.post_push).toEqual([]);
  });

  it('accepts known server_kind values', async () => {
    const cfg = await loadConfig(fixture('with-server-kind.toml'));
    expect(cfg.profile.production?.server_kind).toBe('lolipop');
  });

  it('throws ConfigError when file does not exist', async () => {
    await expect(loadConfig(fixture('does-not-exist.toml'))).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigParseError on TOML syntax error', async () => {
    await expect(loadConfig(fixture('invalid-syntax.toml'))).rejects.toBeInstanceOf(
      ConfigParseError,
    );
  });

  it('throws ConfigValidationError when schema field is missing', async () => {
    await expect(loadConfig(fixture('invalid-missing-schema.toml'))).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('throws ConfigValidationError when no profile is defined', async () => {
    await expect(loadConfig(fixture('invalid-no-profile.toml'))).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('throws ConfigValidationError when protocol is unknown', async () => {
    await expect(loadConfig(fixture('invalid-bad-protocol.toml'))).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('throws ConfigValidationError when port is out of range', async () => {
    await expect(loadConfig(fixture('invalid-bad-port.toml'))).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('throws ConfigValidationError when deletion_policy is invalid', async () => {
    await expect(loadConfig(fixture('invalid-bad-deletion-policy.toml'))).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('rejects config containing a password field', async () => {
    const promise = loadConfig(fixture('invalid-with-password.toml'));
    await expect(promise).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(promise).rejects.toThrow(/Forbidden field 'password'/);
  });
});

describe('config: validateConfig', () => {
  const baseProfile = {
    host: 'ftp.example.com',
    user: 'deploy',
    remote_root: '/public_html',
    local_root: './dist',
    keychain_service: 'aiftp:example',
  };

  it('accepts a valid minimal raw object', () => {
    const cfg = validateConfig({
      schema: 1,
      profile: { production: baseProfile },
    });
    expect(cfg.profile.production?.host).toBe('ftp.example.com');
  });

  it('rejects unsupported schema version', () => {
    expect(() => validateConfig({ schema: 2, profile: { production: baseProfile } })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects schema as string', () => {
    expect(() => validateConfig({ schema: '1', profile: { production: baseProfile } })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects empty profile object', () => {
    expect(() => validateConfig({ schema: 1, profile: {} })).toThrow(ConfigValidationError);
  });

  it('rejects unknown top-level field', () => {
    expect(() =>
      validateConfig({
        schema: 1,
        profile: { production: baseProfile },
        unknown_section: {},
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects unknown field within profile', () => {
    expect(() =>
      validateConfig({
        schema: 1,
        profile: { production: { ...baseProfile, surprise: true } },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects empty host', () => {
    expect(() =>
      validateConfig({
        schema: 1,
        profile: { production: { ...baseProfile, host: '' } },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects port 0', () => {
    expect(() =>
      validateConfig({
        schema: 1,
        profile: { production: { ...baseProfile, port: 0 } },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects negative max_files_per_push', () => {
    expect(() =>
      validateConfig({
        schema: 1,
        profile: { production: baseProfile },
        safety: { max_files_per_push: -1 },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects backup.encrypt = false (must stay true)', () => {
    expect(() =>
      validateConfig({
        schema: 1,
        profile: { production: baseProfile },
        backup: { encrypt: false },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects backup.auto_before_push = false (must stay true)', () => {
    expect(() =>
      validateConfig({
        schema: 1,
        profile: { production: baseProfile },
        backup: { auto_before_push: false },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects retry_backoff_ms with negative value', () => {
    expect(() =>
      validateConfig({
        schema: 1,
        profile: { production: baseProfile },
        connection: { retry_backoff_ms: [1000, -1] },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('accepts hard_exclude with additional_patterns', () => {
    const cfg = validateConfig({
      schema: 1,
      profile: { production: baseProfile },
      backup: { hard_exclude: { additional_patterns: ['custom.php'] } },
    });
    expect(cfg.backup.hard_exclude.additional_patterns).toEqual(['custom.php']);
  });

  it('rejects password field nested in safety section', () => {
    expect(() =>
      validateConfig({
        schema: 1,
        profile: { production: baseProfile },
        safety: { password: 'nope' },
      }),
    ).toThrow(/Forbidden field 'password'/);
  });

  it('rejects pwd field anywhere', () => {
    expect(() =>
      validateConfig({
        schema: 1,
        profile: { production: { ...baseProfile, pwd: 'nope' } },
      }),
    ).toThrow(/Forbidden field 'pwd'/);
  });

  it('rejects secret field anywhere', () => {
    expect(() =>
      validateConfig({
        schema: 1,
        profile: { production: baseProfile },
        secret: 'nope',
      }),
    ).toThrow(/Forbidden field 'secret'/);
  });

  it('accepts multiple profiles', () => {
    const cfg = validateConfig({
      schema: 1,
      profile: {
        production: baseProfile,
        staging: { ...baseProfile, user: 'stage-user' },
        dev: { ...baseProfile, user: 'dev-user' },
      },
    });
    expect(Object.keys(cfg.profile)).toHaveLength(3);
  });

  it('exposes ConfigValidationError name correctly', () => {
    try {
      validateConfig({ schema: 1, profile: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).name).toBe('ConfigValidationError');
    }
  });

  it('exposes ConfigParseError name correctly', () => {
    const err = new ConfigParseError('test');
    expect(err.name).toBe('ConfigParseError');
  });

  it('ConfigError carries cause', () => {
    const cause = new Error('underlying');
    const err = new ConfigError('outer', { cause });
    expect(err.cause).toBe(cause);
  });

  it('safely skips forbidden-field check for arrays', () => {
    const cfg = validateConfig({
      schema: 1,
      profile: { production: baseProfile },
      exclude: { patterns: ['password.txt', 'secret/'] },
    });
    expect(cfg.exclude.patterns).toContain('password.txt');
  });

  it('accepts all valid verify_after_upload values', () => {
    for (const value of ['off', 'size', 'sha256'] as const) {
      const cfg = validateConfig({
        schema: 1,
        profile: { production: baseProfile },
        safety: { verify_after_upload: value },
      });
      expect(cfg.safety.verify_after_upload).toBe(value);
    }
  });

  it('accepts all valid deletion_policy values', () => {
    for (const value of ['never', 'prune-with-confirm', 'prune-auto'] as const) {
      const cfg = validateConfig({
        schema: 1,
        profile: { production: baseProfile },
        safety: { deletion_policy: value },
      });
      expect(cfg.safety.deletion_policy).toBe(value);
    }
  });

  it('accepts all valid server_kind values', () => {
    for (const kind of ['starserver', 'lolipop', 'sakura', 'xserver', 'generic'] as const) {
      const cfg = validateConfig({
        schema: 1,
        profile: { production: { ...baseProfile, server_kind: kind } },
      });
      expect(cfg.profile.production?.server_kind).toBe(kind);
    }
  });
});
