import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { loadConfig } from '../config.js';
import { DEFAULT_EXCLUDE_PATTERNS, createExcluder } from '../exclude.js';
import { FtpClient, FtpConnectionError, FtpError, FtpNotFoundError } from '../ftp-client.js';
import { getPassword } from '../keychain.js';
import { BackupError, BackupStore, type BackupStoreOptions } from './store.js';

export interface BackupKeychain {
  getPassword(service: string, account: string): Promise<string>;
}

export interface BackupFtpClient {
  connect(): Promise<void>;
  isConnected(): boolean;
  download(remotePath: string, localPath: string): Promise<void>;
}

export interface CreateDefaultBackupStoreOptions {
  cwd: string;
  profileName: string;
  keychain?: BackupKeychain;
  ftpClient?: BackupFtpClient;
}

export function backupKeyService(keychainService: string): string {
  return `${keychainService}:backup-key`;
}

function backupRoot(cwd: string, profileName: string): string {
  return join(cwd, '.aiftp', 'backups', profileName);
}

function remoteFilePath(remoteRoot: string, path: string): string {
  const root = remoteRoot.replace(/\/+$/u, '');
  return root === '' ? path : posix.join(root, path);
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
  const selectedProfile = profile;

  const key = Buffer.from(
    // The backup key account is the profile name within a service namespace.
    // This keeps FTP credentials and profile-specific backup keys separated.
    await keychain.getPassword(backupKeyService(selectedProfile.keychain_service), profileName),
    'base64',
  );
  let ownedFtpClient: BackupFtpClient | undefined;
  async function getFtpClient(): Promise<BackupFtpClient> {
    if (options.ftpClient) {
      return options.ftpClient;
    }
    ownedFtpClient ??= new FtpClient({
      host: selectedProfile.host,
      port: selectedProfile.port,
      user: selectedProfile.user,
      password: await keychain.getPassword(selectedProfile.keychain_service, selectedProfile.user),
      protocol: selectedProfile.protocol,
      requireTls: config.safety.require_tls,
      verifyCertificate: config.safety.verify_certificate,
      timeoutMs: config.connection.timeout_ms,
    });
    return ownedFtpClient;
  }

  return new BackupStore({
    rootDir: backupRoot(cwd, profileName),
    key,
    source: {
      readFile: async (path) => {
        const remotePath = remoteFilePath(selectedProfile.remote_root, path);
        const tempPath = join(tmpdir(), `aiftp-backup-${randomUUID()}`);
        try {
          const ftpClient = await getFtpClient();
          if (!ftpClient.isConnected()) {
            await ftpClient.connect();
          }
          await ftpClient.download(remotePath, tempPath);
          return await readFile(tempPath);
        } catch (error: unknown) {
          if (error instanceof FtpNotFoundError) {
            return null;
          }
          if (error instanceof FtpConnectionError) {
            throw new BackupError(
              `Failed to connect while reading remote backup source: ${remotePath}`,
              {
                cause: error,
              },
            );
          }
          if (error instanceof FtpError) {
            throw new BackupError(`Failed to read remote backup source: ${remotePath}`, {
              cause: error,
            });
          }
          throw error;
        } finally {
          await rm(tempPath, { force: true }).catch(() => undefined);
        }
      },
    },
    sourceConcurrency: 1,
    excluder: createExcluder({
      userPatterns: [...DEFAULT_EXCLUDE_PATTERNS, ...config.exclude.patterns],
      additionalHardPatterns: config.backup.hard_exclude.additional_patterns,
    }),
  } satisfies BackupStoreOptions);
}
