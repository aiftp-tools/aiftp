import { describe, expect, it } from 'vitest';
import { type Config, validateConfig } from './config.js';
import {
  computeDestinationFingerprint,
  describeDestinationChange,
} from './destination-fingerprint.js';

function configWith(overrides?: {
  profile?: Record<string, unknown>;
  safety?: Record<string, unknown>;
  quirks?: Record<string, unknown>;
  connection?: Record<string, unknown>;
}): Config {
  return validateConfig({
    schema: 2,
    profile: {
      production: {
        host: 'ftp.example.com',
        port: 21,
        protocol: 'ftps',
        user: 'deploy-user',
        remote_root: '/public_html',
        local_root: '.',
        keychain_service: 'aiftp:gwco-production',
        server_kind: 'starserver',
        ...overrides?.profile,
      },
    },
    ...(overrides?.safety ? { safety: overrides.safety } : {}),
    ...(overrides?.quirks ? { quirks: overrides.quirks } : {}),
    ...(overrides?.connection ? { connection: overrides.connection } : {}),
  });
}

function fingerprintOf(
  overrides?: Parameters<typeof configWith>[0],
  productionConfirmationRequired = true,
) {
  const config = configWith(overrides);
  const profile = config.profile.production;
  if (!profile) throw new Error('fixture profile missing');
  return computeDestinationFingerprint({ profile, config, productionConfirmationRequired });
}

describe('computeDestinationFingerprint', () => {
  it('is stable for an identical destination', () => {
    expect(fingerprintOf().digest).toBe(fingerprintOf().digest);
  });

  it('changes when any connection-defining field changes', () => {
    const base = fingerprintOf().digest;
    expect(fingerprintOf({ profile: { host: 'ftp.attacker.example' } }).digest).not.toBe(base);
    expect(fingerprintOf({ profile: { port: 2121 } }).digest).not.toBe(base);
    expect(fingerprintOf({ profile: { protocol: 'ftp' } }).digest).not.toBe(base);
    expect(fingerprintOf({ profile: { user: 'someone-else' } }).digest).not.toBe(base);
    expect(fingerprintOf({ profile: { keychain_service: 'aiftp:other' } }).digest).not.toBe(base);
    expect(fingerprintOf({ profile: { remote_root: '/other_html' } }).digest).not.toBe(base);
    expect(fingerprintOf({ profile: { server_kind: 'lolipop' } }).digest).not.toBe(base);
    expect(fingerprintOf({ profile: { ftps_mode: 'implicit' } }).digest).not.toBe(base);
    expect(fingerprintOf({ profile: { passive_mode: false } }).digest).not.toBe(base);
    expect(fingerprintOf({ profile: { ssh_key_path: '~/.ssh/id_ed25519' } }).digest).not.toBe(base);
  });

  it('changes when a TLS-related setting changes', () => {
    const base = fingerprintOf().digest;
    expect(fingerprintOf({ safety: { require_tls: false } }).digest).not.toBe(base);
    expect(fingerprintOf({ safety: { verify_certificate: false } }).digest).not.toBe(base);
    expect(fingerprintOf({ quirks: { tls_check_hostname: false } }).digest).not.toBe(base);
  });

  it('changes when the production classification changes', () => {
    expect(fingerprintOf(undefined, true).digest).not.toBe(fingerprintOf(undefined, false).digest);
  });

  it('does not change for settings that cannot redirect the upload', () => {
    // Timeouts and retry policy are not part of "which server am I
    // talking to", so they must not invalidate an approved plan.
    expect(fingerprintOf({ connection: { timeout_ms: 12345 } }).digest).toBe(
      fingerprintOf().digest,
    );
  });

  it('emits only hashes, never the underlying host / user / service values', () => {
    const serialized = JSON.stringify(fingerprintOf());
    expect(serialized).not.toContain('ftp.example.com');
    expect(serialized).not.toContain('deploy-user');
    expect(serialized).not.toContain('aiftp:gwco-production');
    expect(serialized).not.toContain('/public_html');
    expect(fingerprintOf().digest).toMatch(/^[0-9a-f]{64}$/u);
    for (const value of Object.values(fingerprintOf().components)) {
      expect(value).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe('describeDestinationChange', () => {
  it('returns an empty list for an unchanged destination', () => {
    expect(describeDestinationChange(fingerprintOf(), fingerprintOf())).toEqual([]);
  });

  it('names the changed components, sorted, without their values', () => {
    const changed = describeDestinationChange(
      fingerprintOf(),
      fingerprintOf({ profile: { host: 'ftp.attacker.example', user: 'someone-else' } }),
    );
    expect(changed).toEqual(['host', 'user']);
  });

  it('names a component that exists on only one side', () => {
    expect(
      describeDestinationChange(fingerprintOf(), {
        digest: 'x',
        components: { host: 'y' },
      }),
    ).toContain('user');
  });
});
