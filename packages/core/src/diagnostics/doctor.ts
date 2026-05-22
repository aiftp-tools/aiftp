import type { Config, ProfileConfig } from '../config.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
  recommendation?: string;
}

export interface DoctorReport {
  ok: boolean;
  results: CheckResult[];
  summary: { pass: number; warn: number; fail: number; skip: number };
}

export interface FtpsProbeResult {
  handshakeOk: boolean;
  /**
   * v0.9.3+: USER/PASS authentication outcome.
   * - `true`: client.access() (which includes login) succeeded.
   * - `false`: handshake succeeded but USER/PASS failed (typically 530).
   * - `undefined`: not evaluated (handshake failed first, or probe ran in
   *   a stub that doesn't separate the two phases — legacy default).
   *
   * `aiftp doctor` exposes this as the new `ftp-auth` check so the operator
   * can tell "TLS layer is fine, password is wrong" from "TLS layer broke".
   */
  authOk?: boolean;
  /**
   * v0.9.3+: which layer the probe error came from, if any.
   * Populated only when handshakeOk/authOk indicate failure.
   * - `'tls'`: TLS handshake / certificate verification failed.
   * - `'auth'`: USER/PASS rejected (530, 332 etc.).
   * - `'unknown'`: some other connection-level failure.
   */
  probeErrorKind?: 'tls' | 'auth' | 'unknown';
  certCommonName?: string;
  certAltNames?: string[];
  pasvAddressLeak: string | null;
  mlsdSupported: boolean;
  sizeSupported: boolean;
  remoteRootCwdOk: boolean;
  /**
   * Server / client error message captured when `cd(remote_root)` fails.
   * Populated only when `remoteRootCwdOk === false`. Used by `aiftp doctor`
   * to surface the actual FTP reply (typically a 550) plus the configured
   * remote_root in the `remote-root` result's `details`, so an operator
   * does not have to re-run with `--verbose` to diagnose.
   */
  remoteRootCwdError?: string;
}

export interface NetworkProbeResult {
  dnsOk: boolean;
  tcpOk: boolean;
  addresses: string[];
}

export interface DoctorDeps {
  readConfig(): Promise<Config | null>;
  readGitignore(): Promise<string | null>;
  hasKeychainEntry(service: string, account: string): Promise<boolean>;
  /**
   * Fetch the actual password for a profile from the keychain. Optional —
   * when undefined the FTPS probe receives an empty string and most real
   * servers will reject AUTH/USER, surfacing as `ftps-handshake: fail`.
   * Set only when the caller has accepted the keychain auth prompt cost
   * (Touch ID etc.).
   */
  getKeychainPassword?(service: string, account: string): Promise<string | null>;
  probeNetwork(host: string, port: number): Promise<NetworkProbeResult>;
  probeFtps?(profile: ProfileConfig, password: string): Promise<FtpsProbeResult>;
}

export interface RunDoctorOptions {
  profile: string;
}

type Summary = DoctorReport['summary'];

const SKIPPED_FTPS_RESULTS: CheckResult[] = [
  {
    id: 'ftps-handshake',
    title: 'FTPS handshake',
    status: 'skip',
    message: 'FTPS probe is not available.',
  },
  {
    id: 'ftp-auth',
    title: 'FTP authentication',
    status: 'skip',
    message: 'FTPS probe is not available.',
  },
  {
    id: 'ftps-cert',
    title: 'FTPS certificate',
    status: 'skip',
    message: 'FTPS probe is not available.',
  },
  {
    id: 'pasv',
    title: 'PASV address',
    status: 'skip',
    message: 'FTPS probe is not available.',
  },
  {
    id: 'mlsd',
    title: 'MLSD support',
    status: 'skip',
    message: 'FTPS probe is not available.',
  },
  {
    id: 'size',
    title: 'SIZE support',
    status: 'skip',
    message: 'FTPS probe is not available.',
  },
  {
    id: 'remote-root',
    title: 'Remote root',
    status: 'skip',
    message: 'FTPS probe is not available.',
  },
];

function summarize(results: CheckResult[]): Summary {
  const summary: Summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const result of results) {
    summary[result.status] += 1;
  }
  return summary;
}

function report(results: CheckResult[]): DoctorReport {
  const summary = summarize(results);
  return {
    ok: summary.fail === 0,
    results,
    summary,
  };
}

function skipped(id: string, title: string, message: string): CheckResult {
  return { id, title, status: 'skip', message };
}

/**
 * Does any of the certificate's DNS names (CN + SANs) match the
 * requested host, per RFC 6125 §6.4 wildcard rules?
 *
 * v0.9.3 (was: exact-match only — caused `ftps-cert: warn` to fire
 * spuriously on Sakura / Xserver / Lolipop whose shared certificates
 * use `*.<provider>.<tld>`). Now supports a single leading wildcard
 * label that matches exactly one host label:
 *
 *   - `*.sakura.ne.jp` matches `user.sakura.ne.jp`        (pass)
 *   - `*.sakura.ne.jp` does NOT match `sub.user.sakura.ne.jp` (fail)
 *   - `*.sakura.ne.jp` does NOT match `sakura.ne.jp`         (fail)
 *   - `foo.*.example.com`, `*.*.example.com`              (always fail — middle wildcard)
 *   - `*.com`, `*.co.jp`                                   (always fail — too-broad: only 2 labels left)
 *
 * Comparison is case-insensitive (DNS names are case-insensitive).
 * Exported so it can be unit-tested independently of the FTPS probe.
 */
export function certificateMatchesHost(host: string, probe: FtpsProbeResult): boolean {
  const requested = host.trim().toLowerCase();
  if (requested.length === 0) return false;

  const names = [probe.certCommonName, ...(probe.certAltNames ?? [])]
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim().toLowerCase());

  return names.some((name) => dnsNameMatches(name, requested));
}

function dnsNameMatches(pattern: string, requested: string): boolean {
  // Fast path: exact match.
  if (pattern === requested) return true;

  // Wildcard MUST be a single leading `*.` (RFC 6125 §6.4.3) — reject
  // any pattern with `*` elsewhere or with no following `.`.
  if (!pattern.startsWith('*.')) return false;
  if (pattern.indexOf('*', 1) !== -1) return false;

  const patternSuffix = pattern.slice(2);
  if (patternSuffix.length === 0) return false;
  // RFC 6125 §6.4.3 #3: refuse to match a wildcard that would cover
  // a public-suffix-style 2-label name (e.g. `*.com`, `*.co.jp`).
  // We approximate with a "suffix must contain a dot" check so that
  // `*.example.com` matches but `*.com` does not.
  if (!patternSuffix.includes('.')) return false;

  // Requested host must end with `.<suffix>` AND the prefix before
  // that must be exactly one DNS label (no embedded dots).
  if (!requested.endsWith(`.${patternSuffix}`)) return false;
  const prefix = requested.slice(0, requested.length - patternSuffix.length - 1);
  if (prefix.length === 0) return false;
  if (prefix.includes('.')) return false;

  return true;
}

function ftpsResults(profile: ProfileConfig, probe: FtpsProbeResult): CheckResult[] {
  const certDetails = {
    requestedHost: profile.host,
    certCommonName: probe.certCommonName,
    certAltNames: probe.certAltNames,
  };

  // v0.9.3+: split ftps-handshake (TLS layer) from ftp-auth (USER/PASS) so
  // a wrong password no longer pretends to be a TLS issue.
  // - handshakeOk=false ⇒ ftps-handshake: fail, ftp-auth: skip (TLS broke first)
  // - handshakeOk=true, authOk=true ⇒ both pass
  // - handshakeOk=true, authOk=false ⇒ handshake: pass, auth: fail (530 etc.)
  // - handshakeOk=true, authOk=undefined ⇒ handshake: pass, auth: skip (probe
  //   stub doesn't separate the phases — legacy default for unit tests).
  const handshakeResult: CheckResult = {
    id: 'ftps-handshake',
    title: 'FTPS handshake',
    status: probe.handshakeOk ? 'pass' : 'fail',
    message: probe.handshakeOk ? 'FTPS handshake succeeded.' : 'FTPS handshake failed.',
  };
  const authResult: CheckResult = (() => {
    if (!probe.handshakeOk) {
      return {
        id: 'ftp-auth',
        title: 'FTP authentication',
        status: 'skip',
        message: 'Skipped because the FTPS handshake did not complete.',
      };
    }
    if (probe.authOk === true) {
      return {
        id: 'ftp-auth',
        title: 'FTP authentication',
        status: 'pass',
        message: 'USER/PASS authentication succeeded.',
      };
    }
    if (probe.authOk === false) {
      return {
        id: 'ftp-auth',
        title: 'FTP authentication',
        status: 'fail',
        message:
          'USER/PASS authentication failed (server rejected the credentials, typically FTP 530). Re-run `aiftp auth set` to update the stored password.',
        recommendation: 'aiftp auth set --profile <name>',
      };
    }
    // authOk is undefined — probe stub or legacy caller didn't tell us.
    return {
      id: 'ftp-auth',
      title: 'FTP authentication',
      status: 'skip',
      message: 'Authentication outcome was not evaluated by the probe.',
    };
  })();

  return [
    handshakeResult,
    authResult,
    {
      id: 'ftps-cert',
      title: 'FTPS certificate',
      status: certificateMatchesHost(profile.host, probe) ? 'pass' : 'warn',
      message: certificateMatchesHost(profile.host, probe)
        ? 'Certificate matches the configured host.'
        : 'Certificate does not match the configured host.',
      details: certDetails,
    },
    {
      id: 'pasv',
      title: 'PASV address',
      status: probe.pasvAddressLeak === null ? 'pass' : 'warn',
      message:
        probe.pasvAddressLeak === null
          ? 'PASV address is usable.'
          : `PASV reply leaked private address ${probe.pasvAddressLeak}.`,
      recommendation:
        probe.pasvAddressLeak === null ? undefined : 'set quirks.ignore_pasv_address = true',
    },
    {
      id: 'mlsd',
      title: 'MLSD support',
      status: probe.mlsdSupported ? 'pass' : 'warn',
      message: probe.mlsdSupported ? 'MLSD is supported.' : 'MLSD is not supported.',
    },
    {
      id: 'size',
      title: 'SIZE support',
      status: probe.sizeSupported ? 'pass' : 'warn',
      message: probe.sizeSupported ? 'SIZE is supported.' : 'SIZE is not supported.',
    },
    {
      id: 'remote-root',
      title: 'Remote root',
      status: probe.remoteRootCwdOk ? 'pass' : 'fail',
      message: probe.remoteRootCwdOk
        ? 'remote_root is reachable.'
        : `CWD ${profile.remote_root} failed: ${probe.remoteRootCwdError ?? 'unknown error'}`,
      details: probe.remoteRootCwdOk
        ? undefined
        : { path: profile.remote_root, error: probe.remoteRootCwdError ?? null },
      recommendation: probe.remoteRootCwdOk
        ? undefined
        : 'Either run `aiftp push` first (v0.1.1+ auto-creates parent directories), or set remote_root in .aiftp.toml to a path that already exists on the server.',
    },
  ];
}

export async function runDoctor(
  deps: DoctorDeps,
  options: RunDoctorOptions,
): Promise<DoctorReport> {
  const config = await deps.readConfig();
  const results: CheckResult[] = [
    config === null
      ? {
          id: 'config-file',
          title: '.aiftp.toml',
          status: 'fail',
          message: '.aiftp.toml was not found or could not be loaded.',
          recommendation: 'Run aiftp init.',
        }
      : {
          id: 'config-file',
          title: '.aiftp.toml',
          status: 'pass',
          message: `schema=${config.schema}`,
        },
  ];

  const profile = config?.profile[options.profile];
  results.push(
    profile
      ? {
          id: 'profile-exists',
          title: 'Profile',
          status: 'pass',
          message: `Profile ${options.profile} exists.`,
        }
      : {
          id: 'profile-exists',
          title: 'Profile',
          status: 'fail',
          message: `Profile ${options.profile} is not defined.`,
        },
  );

  const gitignore = await deps.readGitignore();
  results.push(
    gitignore?.includes('.aiftp/')
      ? {
          id: 'gitignore',
          title: '.gitignore',
          status: 'pass',
          message: '.aiftp/ is ignored.',
        }
      : {
          id: 'gitignore',
          title: '.gitignore',
          status: 'warn',
          message: '.aiftp/ is not ignored.',
          recommendation: 'Add .aiftp/ to .gitignore.',
        },
  );

  if (!profile) {
    results.push(
      skipped('keychain', 'Keychain', 'Profile is unavailable.'),
      skipped('dns', 'DNS', 'Profile is unavailable.'),
      skipped('tcp', 'TCP', 'Profile is unavailable.'),
      ...SKIPPED_FTPS_RESULTS,
    );
    return report(results);
  }

  const keychainOk = await deps.hasKeychainEntry(profile.keychain_service, profile.user);
  results.push(
    keychainOk
      ? {
          id: 'keychain',
          title: 'Keychain',
          status: 'pass',
          message: 'Keychain entry exists.',
        }
      : {
          id: 'keychain',
          title: 'Keychain',
          status: 'fail',
          message: 'Keychain entry is missing.',
          recommendation: 'Run aiftp auth set',
        },
  );

  const network = await deps.probeNetwork(profile.host, profile.port);
  results.push(
    {
      id: 'dns',
      title: 'DNS',
      status: network.dnsOk ? 'pass' : 'fail',
      message: network.dnsOk ? 'DNS resolution succeeded.' : 'DNS resolution failed.',
      details: { addresses: network.addresses },
    },
    {
      id: 'tcp',
      title: 'TCP',
      status: network.tcpOk ? 'pass' : 'fail',
      message: network.tcpOk ? 'TCP connection succeeded.' : 'TCP connection failed.',
      details: { host: profile.host, port: profile.port },
    },
  );

  if (!deps.probeFtps) {
    results.push(...SKIPPED_FTPS_RESULTS);
    return report(results);
  }

  const password = deps.getKeychainPassword
    ? ((await deps.getKeychainPassword(profile.keychain_service, profile.user).catch(() => null)) ??
      '')
    : '';
  results.push(...ftpsResults(profile, await deps.probeFtps(profile, password)));
  return report(results);
}
