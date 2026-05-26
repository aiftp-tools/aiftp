import { describe, expect, it } from 'vitest';
import type { Config, ProfileConfig } from '../config.js';
import type { DoctorDeps } from './doctor.js';
import { runDoctor } from './doctor.js';

// Helper: a minimal v2 config that satisfies validateConfig.
function makeConfig(overrides: Partial<ProfileConfig> = {}): Config {
  const profile: ProfileConfig = {
    host: 'ftp.example.com',
    port: 21,
    protocol: 'ftps',
    user: 'deploy',
    remote_root: '/public_html',
    local_root: '.',
    keychain_service: 'aiftp:test',
    server_kind: 'generic',
    ...overrides,
  };
  return {
    schema: 2,
    profile: { production: profile },
    exclude: { patterns: [] },
    safety: {
      require_tls: true,
      verify_certificate: true,
      confirm_on_delete: true,
      max_files_per_push: 500,
      max_total_size_mb: 100,
      require_full_backup_before_first_push: false,
      warn_on_prod_profile: true,
      prod_profile_patterns: ['prod*'],
      syntax_check: true,
      server_lock: true,
      lock_timeout_min: 10,
      verify_after_upload: 'size',
      deletion_policy: 'never',
    },
    backup: {
      auto_before_push: true,
      retention_count: 30,
      max_disk_mb: 500,
      on_limit_exceeded: 'halt',
      full_backup_on_first_push: 'recommend',
      full_backup_schedule: 'weekly',
      full_backup_retention: 4,
      encrypt: true,
      encryption_algorithm: 'aes-256-gcm',
      key_storage: 'os-keychain',
      cloud_backup: false,
      hard_exclude: { additional_patterns: [] },
    },
    connection: {
      max_concurrent: 2,
      throttle_per_minute: 30,
      retry_count: 5,
      retry_backoff_ms: [1000, 3000, 9000, 27000, 60000],
      timeout_ms: 60000,
      resume_partial_upload: true,
    },
    hooks: { pre_push: [], post_push: [] },
    encoding: { file_name: 'auto' },
    quirks: {
      ignore_pasv_address: false,
      use_mlsd: true,
      tls_check_hostname: true,
      noop_interval_sec: 0,
    },
  } as Config;
}

function happyDeps(): DoctorDeps {
  return {
    readConfig: async () => makeConfig(),
    readGitignore: async () => 'node_modules/\n.aiftp/\n',
    hasKeychainEntry: async () => true,
    probeNetwork: async () => ({ dnsOk: true, tcpOk: true, addresses: ['203.0.113.5'] }),
    probeFtps: async () => ({
      handshakeOk: true,
      certCommonName: 'ftp.example.com',
      certAltNames: ['ftp.example.com'],
      pasvAddressLeak: null,
      mlsdSupported: true,
      sizeSupported: true,
      remoteRootCwdOk: true,
    }),
  };
}

describe('runDoctor: config-only checks', () => {
  it('reports ok=true with no failures when the happy path is fully satisfied', async () => {
    const report = await runDoctor(happyDeps(), { profile: 'production' });
    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBeGreaterThan(0);
    expect(report.results.find((r) => r.id === 'config-file')?.status).toBe('pass');
  });

  it('fails when .aiftp.toml is missing entirely', async () => {
    const deps: DoctorDeps = { ...happyDeps(), readConfig: async () => null };
    const report = await runDoctor(deps, { profile: 'production' });
    expect(report.ok).toBe(false);
    const cfg = report.results.find((r) => r.id === 'config-file');
    expect(cfg?.status).toBe('fail');
    expect(cfg?.recommendation).toMatch(/aiftp init/);
  });

  it('fails when the requested profile is not defined in the config', async () => {
    const report = await runDoctor(happyDeps(), { profile: 'does-not-exist' });
    expect(report.ok).toBe(false);
    expect(report.results.find((r) => r.id === 'profile-exists')?.status).toBe('fail');
  });

  it('warns when .gitignore does not contain `.aiftp/`', async () => {
    const deps: DoctorDeps = {
      ...happyDeps(),
      readGitignore: async () => 'node_modules/\n',
    };
    const report = await runDoctor(deps, { profile: 'production' });
    const gi = report.results.find((r) => r.id === 'gitignore');
    expect(gi?.status).toBe('warn');
    expect(gi?.recommendation).toMatch(/\.aiftp\//);
  });

  it('warns when .gitignore file is absent (non-git project or new repo)', async () => {
    const deps: DoctorDeps = { ...happyDeps(), readGitignore: async () => null };
    const report = await runDoctor(deps, { profile: 'production' });
    expect(report.results.find((r) => r.id === 'gitignore')?.status).toBe('warn');
  });

  it('fails when the keychain entry for the profile cannot be found', async () => {
    const deps: DoctorDeps = { ...happyDeps(), hasKeychainEntry: async () => false };
    const report = await runDoctor(deps, { profile: 'production' });
    const k = report.results.find((r) => r.id === 'keychain');
    expect(k?.status).toBe('fail');
    expect(k?.recommendation).toMatch(/aiftp auth set/);
  });
});

describe('runDoctor: network checks', () => {
  it('fails when DNS resolution fails', async () => {
    const deps: DoctorDeps = {
      ...happyDeps(),
      probeNetwork: async () => ({ dnsOk: false, tcpOk: false, addresses: [] }),
    };
    const report = await runDoctor(deps, { profile: 'production' });
    expect(report.results.find((r) => r.id === 'dns')?.status).toBe('fail');
  });

  it('fails TCP reach when DNS succeeds but port is closed', async () => {
    const deps: DoctorDeps = {
      ...happyDeps(),
      probeNetwork: async () => ({ dnsOk: true, tcpOk: false, addresses: ['203.0.113.5'] }),
    };
    const report = await runDoctor(deps, { profile: 'production' });
    expect(report.results.find((r) => r.id === 'dns')?.status).toBe('pass');
    expect(report.results.find((r) => r.id === 'tcp')?.status).toBe('fail');
  });
});

describe('runDoctor: FTPS probe checks', () => {
  it('warns when the TLS cert CN does not contain the configured host', async () => {
    const deps: DoctorDeps = {
      ...happyDeps(),
      probeFtps: async () => ({
        handshakeOk: true,
        certCommonName: '*.star.ne.jp',
        certAltNames: ['*.star.ne.jp', 'star.ne.jp'],
        pasvAddressLeak: null,
        mlsdSupported: true,
        sizeSupported: true,
        remoteRootCwdOk: true,
      }),
    };
    const deps2: DoctorDeps = {
      ...deps,
      readConfig: async () => makeConfig({ host: 'ftp.stars.ne.jp' }),
    };
    const report = await runDoctor(deps2, { profile: 'production' });
    const tls = report.results.find((r) => r.id === 'ftps-cert');
    expect(tls?.status).toBe('warn');
    expect(tls?.details).toMatchObject({ requestedHost: 'ftp.stars.ne.jp' });
  });

  describe('ftp-auth check (v0.9.3 — split from ftps-handshake)', () => {
    it('reports ftp-auth: pass when probe.authOk === true', async () => {
      const deps: DoctorDeps = {
        ...happyDeps(),
        probeFtps: async () => ({
          handshakeOk: true,
          authOk: true,
          certCommonName: 'ftp.example.com',
          certAltNames: ['ftp.example.com'],
          pasvAddressLeak: null,
          mlsdSupported: true,
          sizeSupported: true,
          remoteRootCwdOk: true,
        }),
      };
      const report = await runDoctor(deps, { profile: 'production' });
      expect(report.results.find((r) => r.id === 'ftp-auth')?.status).toBe('pass');
    });

    it('reports ftp-auth: fail with recommendation when handshake succeeded but USER/PASS was rejected (530)', async () => {
      // This is the A-7 scenario: TLS handshake completes (cert is fetched
      // and recognized) but the wrong password is configured. Before v0.9.3
      // doctor lumped this under "ftps-handshake: fail" and the operator
      // spent an hour suspecting a TLS bug.
      const deps: DoctorDeps = {
        ...happyDeps(),
        probeFtps: async () => ({
          handshakeOk: true,
          authOk: false,
          probeErrorKind: 'auth',
          certCommonName: 'ftp.example.com',
          certAltNames: ['ftp.example.com'],
          pasvAddressLeak: null,
          mlsdSupported: false,
          sizeSupported: false,
          remoteRootCwdOk: false,
        }),
      };
      const report = await runDoctor(deps, { profile: 'production' });
      const handshake = report.results.find((r) => r.id === 'ftps-handshake');
      const auth = report.results.find((r) => r.id === 'ftp-auth');
      expect(handshake?.status).toBe('pass');
      expect(auth?.status).toBe('fail');
      expect(auth?.message).toMatch(/530|USER|PASS|credential/i);
      expect(auth?.recommendation).toMatch(/aiftp auth set/);
    });

    it('reports ftp-auth: skip when the FTPS handshake itself failed (auth could not be evaluated)', async () => {
      const deps: DoctorDeps = {
        ...happyDeps(),
        probeFtps: async () => ({
          handshakeOk: false,
          authOk: undefined,
          probeErrorKind: 'tls',
          pasvAddressLeak: null,
          mlsdSupported: false,
          sizeSupported: false,
          remoteRootCwdOk: false,
        }),
      };
      const report = await runDoctor(deps, { profile: 'production' });
      expect(report.results.find((r) => r.id === 'ftps-handshake')?.status).toBe('fail');
      expect(report.results.find((r) => r.id === 'ftp-auth')?.status).toBe('skip');
    });

    it('reports ftp-auth: skip when authOk is undefined (legacy probe stub did not separate phases)', async () => {
      // Backwards-compat: pre-v0.9.3 probes (and many unit-test stubs)
      // don't set authOk. Doctor must treat this as "we don't know" rather
      // than asserting pass/fail.
      const deps: DoctorDeps = {
        ...happyDeps(),
        probeFtps: async () => ({
          handshakeOk: true,
          // no authOk, no probeErrorKind
          certCommonName: 'ftp.example.com',
          pasvAddressLeak: null,
          mlsdSupported: true,
          sizeSupported: true,
          remoteRootCwdOk: true,
        }),
      };
      const report = await runDoctor(deps, { profile: 'production' });
      expect(report.results.find((r) => r.id === 'ftps-handshake')?.status).toBe('pass');
      expect(report.results.find((r) => r.id === 'ftp-auth')?.status).toBe('skip');
    });
  });

  it('warns when PASV reply leaks a private address (NAT-misconfigured server)', async () => {
    const deps: DoctorDeps = {
      ...happyDeps(),
      probeFtps: async () => ({
        handshakeOk: true,
        certCommonName: 'ftp.example.com',
        certAltNames: ['ftp.example.com'],
        pasvAddressLeak: '192.168.1.5',
        mlsdSupported: true,
        sizeSupported: true,
        remoteRootCwdOk: true,
      }),
    };
    const report = await runDoctor(deps, { profile: 'production' });
    const pasv = report.results.find((r) => r.id === 'pasv');
    expect(pasv?.status).toBe('warn');
    expect(pasv?.recommendation).toMatch(/ignore_pasv_address/);
  });

  it('fails when remote_root CWD fails on the server', async () => {
    const deps: DoctorDeps = {
      ...happyDeps(),
      probeFtps: async () => ({
        handshakeOk: true,
        certCommonName: 'ftp.example.com',
        certAltNames: ['ftp.example.com'],
        pasvAddressLeak: null,
        mlsdSupported: true,
        sizeSupported: true,
        remoteRootCwdOk: false,
      }),
    };
    const report = await runDoctor(deps, { profile: 'production' });
    const cwd = report.results.find((r) => r.id === 'remote-root');
    expect(cwd?.status).toBe('fail');
    expect(cwd?.recommendation).toMatch(/remote_root/);
  });

  it('exposes the cd() error message and configured path on remote-root: fail', async () => {
    const deps: DoctorDeps = {
      ...happyDeps(),
      readConfig: async () =>
        makeConfig({ remote_root: '/glocalworks.co.jp/public_html/aiftp-test' }),
      probeFtps: async () => ({
        handshakeOk: true,
        certCommonName: 'ftp.example.com',
        certAltNames: ['ftp.example.com'],
        pasvAddressLeak: null,
        mlsdSupported: true,
        sizeSupported: true,
        remoteRootCwdOk: false,
        remoteRootCwdError:
          'cd(/glocalworks.co.jp/public_html/aiftp-test): not found or permission denied (550)',
      }),
    };
    const report = await runDoctor(deps, { profile: 'production' });
    const cwd = report.results.find((r) => r.id === 'remote-root');
    expect(cwd?.status).toBe('fail');
    expect(cwd?.details).toMatchObject({
      path: '/glocalworks.co.jp/public_html/aiftp-test',
      error: expect.stringMatching(/550|not found/i),
    });
    expect(cwd?.recommendation).toMatch(/aiftp push|auto-create|remote_root/i);
  });

  it('skips ftps-* and pasv / mlsd / size / remote-root checks when probeFtps is not provided', async () => {
    const deps: DoctorDeps = { ...happyDeps(), probeFtps: undefined };
    const report = await runDoctor(deps, { profile: 'production' });
    expect(report.results.find((r) => r.id === 'ftps-handshake')?.status).toBe('skip');
    expect(report.results.find((r) => r.id === 'ftps-cert')?.status).toBe('skip');
    expect(report.results.find((r) => r.id === 'pasv')?.status).toBe('skip');
    expect(report.results.find((r) => r.id === 'mlsd')?.status).toBe('skip');
    expect(report.results.find((r) => r.id === 'size')?.status).toBe('skip');
    expect(report.results.find((r) => r.id === 'remote-root')?.status).toBe('skip');
  });
});

describe('runDoctor: SFTP probe checks (v0.11 Pillar γ Task 27)', () => {
  function sftpHappyDeps(): DoctorDeps {
    return {
      readConfig: async () =>
        makeConfig({
          protocol: 'sftp',
          port: 22,
          ssh_key_path: '~/.ssh/id_ed25519',
        }),
      readGitignore: async () => '.aiftp/\n',
      hasKeychainEntry: async () => true,
      probeNetwork: async () => ({ dnsOk: true, tcpOk: true, addresses: ['203.0.113.5'] }),
      probeSftp: async () => ({
        portReachable: true,
        keyPermissionsOk: true,
        keyMode: '0o600',
        handshakeOk: true,
        remoteRootOk: true,
      }),
    };
  }

  it('emits the 4 SFTP checks (all pass) when probeSftp reports happy path', async () => {
    const report = await runDoctor(sftpHappyDeps(), { profile: 'production' });
    const ids = report.results.map((r) => r.id);
    expect(ids).toContain('ssh-port-reachable');
    expect(ids).toContain('ssh-key-permissions');
    expect(ids).toContain('sftp-handshake');
    expect(ids).toContain('sftp-remote-root');
    for (const id of [
      'ssh-port-reachable',
      'ssh-key-permissions',
      'sftp-handshake',
      'sftp-remote-root',
    ]) {
      expect(report.results.find((r) => r.id === id)?.status, id).toBe('pass');
    }
  });

  it('marks ftp-* checks as skip on a sftp profile', async () => {
    const report = await runDoctor(sftpHappyDeps(), { profile: 'production' });
    for (const id of ['ftps-handshake', 'ftp-auth', 'ftps-cert', 'pasv', 'mlsd', 'size']) {
      const result = report.results.find((r) => r.id === id);
      expect(result?.status, id).toBe('skip');
    }
  });

  it('marks sftp-* checks as skip on a ftp/ftps profile', async () => {
    const deps: DoctorDeps = {
      ...happyDeps(),
    };
    const report = await runDoctor(deps, { profile: 'production' });
    for (const id of [
      'ssh-port-reachable',
      'ssh-key-permissions',
      'sftp-handshake',
      'sftp-remote-root',
    ]) {
      expect(report.results.find((r) => r.id === id)?.status, id).toBe('skip');
    }
  });

  it('reports ssh-key-permissions skip when ssh_key_path is unset (password auth)', async () => {
    const deps: DoctorDeps = {
      ...sftpHappyDeps(),
      readConfig: async () => makeConfig({ protocol: 'sftp', port: 22 }), // no ssh_key_path
      probeSftp: async () => ({
        portReachable: true,
        keyPermissionsOk: null,
        handshakeOk: true,
        remoteRootOk: true,
      }),
    };
    const report = await runDoctor(deps, { profile: 'production' });
    const keyCheck = report.results.find((r) => r.id === 'ssh-key-permissions');
    expect(keyCheck?.status).toBe('skip');
    expect(keyCheck?.message).toMatch(/password auth|ssh_key_path is not set/i);
  });

  it('reports ssh-key-permissions fail and skips handshake when key is world-readable', async () => {
    const deps: DoctorDeps = {
      ...sftpHappyDeps(),
      probeSftp: async () => ({
        portReachable: true,
        keyPermissionsOk: false,
        keyMode: '0o644',
        handshakeOk: false,
        remoteRootOk: false,
        errorMessage: 'Refusing to use over-permissive SSH key.',
      }),
    };
    const report = await runDoctor(deps, { profile: 'production' });
    expect(report.results.find((r) => r.id === 'ssh-key-permissions')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'sftp-handshake')?.status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('reports sftp-remote-root skip when the handshake itself failed', async () => {
    const deps: DoctorDeps = {
      ...sftpHappyDeps(),
      probeSftp: async () => ({
        portReachable: true,
        keyPermissionsOk: true,
        keyMode: '0o600',
        handshakeOk: false,
        remoteRootOk: false,
        errorMessage: 'auth rejected',
      }),
    };
    const report = await runDoctor(deps, { profile: 'production' });
    expect(report.results.find((r) => r.id === 'sftp-handshake')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'sftp-remote-root')?.status).toBe('skip');
  });

  it('emits unavailable sftp results when no probeSftp is wired', async () => {
    const deps: DoctorDeps = {
      ...sftpHappyDeps(),
      probeSftp: undefined,
    };
    const report = await runDoctor(deps, { profile: 'production' });
    for (const id of [
      'ssh-port-reachable',
      'ssh-key-permissions',
      'sftp-handshake',
      'sftp-remote-root',
    ]) {
      const result = report.results.find((r) => r.id === id);
      expect(result?.status, id).toBe('skip');
      expect(result?.message, id).toMatch(/probe is not available/i);
    }
  });
});

describe('runDoctor: report shape', () => {
  it('summary counts equal the number of results bucketed by status', async () => {
    const report = await runDoctor(happyDeps(), { profile: 'production' });
    const buckets = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const r of report.results) buckets[r.status]++;
    expect(report.summary).toEqual(buckets);
  });

  it('ok is true only when no checks are in fail status (warns are tolerated)', async () => {
    const deps: DoctorDeps = {
      ...happyDeps(),
      readGitignore: async () => 'node_modules/\n', // missing .aiftp/ -> warn
    };
    const report = await runDoctor(deps, { profile: 'production' });
    expect(report.summary.warn).toBeGreaterThan(0);
    expect(report.summary.fail).toBe(0);
    expect(report.ok).toBe(true);
  });
});
