import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { loadConfig } from '../config.js';
import { DEFAULT_EXCLUDE_PATTERNS, createExcluder } from '../exclude.js';
import { getPassword } from '../keychain.js';
import { BackupStore, type BackupStoreOptions } from './store.js';

export interface BackupKeychain {
  getPassword(service: string, account: string): Promise<string>;
}

export interface CreateDefaultBackupStoreOptions {
  cwd: string;
  profileName: string;
  keychain?: BackupKeychain;
}

export function backupKeyService(keychainService: string): string {
  return `${keychainService}:backup-key`;
}

function projectPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

function backupRoot(cwd: string, profileName: string): string {
  return join(cwd, '.aiftp', 'backups', profileName);
}

export async function createDefaultBackupStore(
  options: CreateDefaultBackupStoreOptions,
): Promise<BackupStore> {
  const { cwd, profileName, keychain = { getPassword } } = options;
  const config = await loadConfig(join(cwd, '.aiftp.toml'));
  const profile = config.profile[profileName];
  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }

  const localRoot = projectPath(cwd, profile.local_root);
  const key = Buffer.from(
    // The backup key account is the profile name within a service namespace.
    // This keeps FTP credentials and profile-specific backup keys separated.
    await keychain.getPassword(backupKeyService(profile.keychain_service), profileName),
    'base64',
  );

  return new BackupStore({
    rootDir: backupRoot(cwd, profileName),
    key,
    source: {
      readFile: (path) => readFile(join(localRoot, ...path.split('/'))),
    },
    excluder: createExcluder({
      userPatterns: [...DEFAULT_EXCLUDE_PATTERNS, ...config.exclude.patterns],
      additionalHardPatterns: config.backup.hard_exclude.additional_patterns,
    }),
  } satisfies BackupStoreOptions);
}
