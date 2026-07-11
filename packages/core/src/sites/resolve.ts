import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig as loadConfigFromDisk } from '../config.js';
import type { Config } from '../config.js';
import { hasPassword as hasPasswordInKeychain } from '../keychain.js';
import type { CredentialsStatus, ResolvedSite, SiteEntry } from './types.js';

export interface ResolveSiteDeps {
  readonly hasPassword?: (service: string, account: string) => Promise<boolean>;
  readonly loadConfig?: (path: string) => Promise<Config>;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function pushTimestamp(line: string): string | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== 'object') {
      return undefined;
    }
    const entry = value as Record<string, unknown>;
    return entry.event === 'push' && typeof entry.at === 'string' ? entry.at : undefined;
  } catch {
    return undefined;
  }
}

async function readLastPushAt(projectPath: string): Promise<string | undefined> {
  try {
    const source = await readFile(join(projectPath, '.aiftp', 'log.jsonl'), 'utf8');
    return source.split(/\r?\n/u).reduce<string | undefined>((latest, line) => {
      const at = pushTimestamp(line);
      return at !== undefined && (latest === undefined || at > latest) ? at : latest;
    }, undefined);
  } catch {
    return undefined;
  }
}

async function loadConfigReadOnly(path: string): Promise<Config> {
  return loadConfigFromDisk(path, { autoMigrate: false });
}

async function credentialsStatus(
  config: Config,
  primaryProfileName: string,
  passwordLookup: (service: string, account: string) => Promise<boolean>,
): Promise<CredentialsStatus> {
  const profile = config.profile[primaryProfileName];
  if (profile === undefined) {
    return 'unknown';
  }
  try {
    return (await passwordLookup(profile.keychain_service, profile.user)) ? 'present' : 'missing';
  } catch {
    return 'unknown';
  }
}

export async function resolveSite(
  entry: SiteEntry,
  deps: ResolveSiteDeps = {},
): Promise<ResolvedSite> {
  if (!(await isDirectory(entry.path))) {
    return {
      ...entry,
      profiles: [],
      protocol: undefined,
      credentialsStatus: 'unknown',
      lastPushAt: undefined,
      health: 'missing',
    };
  }

  const lastPushAtPromise = readLastPushAt(entry.path);
  const configPath = join(entry.path, '.aiftp.toml');
  let config: Config;
  try {
    config = await (deps.loadConfig ?? loadConfigReadOnly)(configPath);
  } catch {
    return {
      ...entry,
      profiles: [],
      protocol: undefined,
      credentialsStatus: 'unknown',
      lastPushAt: await lastPushAtPromise,
      health: 'invalid',
    };
  }

  const profiles = Object.keys(config.profile);
  const primaryProfileName =
    entry.default_profile !== undefined && config.profile[entry.default_profile] !== undefined
      ? entry.default_profile
      : profiles[0];
  const primaryProfile =
    primaryProfileName === undefined ? undefined : config.profile[primaryProfileName];
  const status =
    primaryProfileName === undefined
      ? 'unknown'
      : await credentialsStatus(
          config,
          primaryProfileName,
          deps.hasPassword ?? hasPasswordInKeychain,
        );

  return {
    ...entry,
    profiles,
    protocol: primaryProfile?.protocol,
    credentialsStatus: status,
    lastPushAt: await lastPushAtPromise,
    health: 'ok',
  };
}
