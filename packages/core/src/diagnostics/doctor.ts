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
  certCommonName?: string;
  certAltNames?: string[];
  pasvAddressLeak: string | null;
  mlsdSupported: boolean;
  sizeSupported: boolean;
  remoteRootCwdOk: boolean;
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

function certificateMatchesHost(host: string, probe: FtpsProbeResult): boolean {
  const names = [probe.certCommonName, ...(probe.certAltNames ?? [])].filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
  return names.some((name) => name === host);
}

function ftpsResults(profile: ProfileConfig, probe: FtpsProbeResult): CheckResult[] {
  const certDetails = {
    requestedHost: profile.host,
    certCommonName: probe.certCommonName,
    certAltNames: probe.certAltNames,
  };

  return [
    {
      id: 'ftps-handshake',
      title: 'FTPS handshake',
      status: probe.handshakeOk ? 'pass' : 'fail',
      message: probe.handshakeOk ? 'FTPS handshake succeeded.' : 'FTPS handshake failed.',
    },
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
        : 'remote_root could not be selected.',
      recommendation: probe.remoteRootCwdOk ? undefined : 'Check remote_root in .aiftp.toml',
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

  results.push(...ftpsResults(profile, await deps.probeFtps(profile, '')));
  return report(results);
}
