import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { loadConfig } from '../config.js';
import {
  type DeployClient,
  buildDeployClientOptions,
  createDeployClient,
} from '../deploy-client-factory.js';
import { createExcluder } from '../exclude.js';
import { FtpConnectionError, FtpError, FtpNotFoundError } from '../ftp-client.js';
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

  // v0.9.4: catch the bare KeychainNotFoundError and re-throw with a
  // hint pointing at the new `aiftp backup init` command. Before this
  // patch, operators who hand-edited `.aiftp.toml` (skipping `aiftp init`)
  // got an opaque "Keychain entry not found" with no recovery hint.
  const backupKeyServiceName = backupKeyService(selectedProfile.keychain_service);
  let backupKeyBase64: string;
  try {
    backupKeyBase64 = await keychain.getPassword(backupKeyServiceName, profileName);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('Keychain entry not found')) {
      throw new BackupError(
        `Backup key not found for profile '${profileName}'. Run \`aiftp backup init --profile ${profileName}\` to create one. (Original error: ${msg})`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
    throw error;
  }
  const key = Buffer.from(backupKeyBase64, 'base64');
  let ownedFtpClient: DeployClient | undefined;
  async function getFtpClient(): Promise<BackupFtpClient> {
    if (options.ftpClient) {
      return options.ftpClient;
    }
    const password = await keychain.getPassword(
      selectedProfile.keychain_service,
      selectedProfile.user,
    );
    ownedFtpClient ??= createDeployClient(
      buildDeployClientOptions({ profile: selectedProfile, config, password }),
    );
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
          // v0.9.2: treat 551/553 (and any other "file unavailable" style
          // 5xx reply) the same as 550 for backup-source purposes. Real
          // servers occasionally use 551 for ENOENT (Sakura, some mock
          // ProFTPD configurations), and v0.9.2 push-on-added relies on
          // remote-not-found gracefully becoming a metadata-only snapshot
          // rather than blowing up the whole backup. v0.10.0 will move
          // this classification into FtpError mapping itself.
          if (error instanceof FtpError) {
            const ftpCode = (error.cause as { code?: number } | undefined)?.code;
            if (ftpCode === 551 || ftpCode === 553) {
              return null;
            }
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
      userPatterns: config.exclude.patterns,
      useDefaults: config.exclude.use_defaults,
      additionalHardPatterns: config.backup.hard_exclude.additional_patterns,
    }),
  } satisfies BackupStoreOptions);
}
