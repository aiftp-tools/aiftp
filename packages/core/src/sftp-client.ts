/**
 * SFTP client adapter — Task 21 skeleton.
 *
 * Mirrors the FtpClient surface so deploy / rollback / backup can swap
 * the underlying protocol via deploy-client-factory (Task 24). This
 * file currently exposes only the connect / list / disconnect /
 * isConnected lifecycle; upload / download / mkdir / delete / rename /
 * stat / exists are added in Task 22, and SSH-key auth in Task 23.
 *
 * The reused {@link ListEntry} shape (see ftp-client.ts) maps SFTP
 * FileInfo.type 'd' → 'directory', '-' → 'file', anything else →
 * 'unknown'.
 */

import { readFileSync, statSync } from 'node:fs';
import Sftp from 'ssh2-sftp-client';
import {
  FtpAuthError,
  FtpConnectionError,
  FtpError,
  FtpNotFoundError,
  FtpTimeoutError,
  type ListEntry,
  type UploadResult,
} from './ftp-client.js';
import { expandTilde } from './path-utils.js';

export interface SftpClientOptions {
  host: string;
  port?: number;
  user: string;
  /**
   * Password authentication. Ignored when `sshKeyPath` is set.
   * Either `password` or `sshKeyPath` must be provided.
   */
  password?: string;
  /**
   * Path to an SSH private key file (OpenSSH or PEM). Required mode is
   * 0o600 or 0o400 — the connect call refuses to load a key that is
   * group- or world-readable, matching the well-known `ssh` client
   * policy. Takes precedence over `password`.
   */
  sshKeyPath?: string;
  /**
   * Passphrase for `sshKeyPath` if the key is encrypted at rest.
   */
  sshKeyPassphrase?: string;
  /**
   * Socket-level timeout in milliseconds for individual SFTP operations.
   * Defaults to 60_000 (60s) — mirrors FtpClient.
   */
  timeoutMs?: number;
  /**
   * Optional logger for verbose debugging.
   */
  onLog?: (line: string) => void;
}

const DEFAULT_PORT = 22;
const DEFAULT_TIMEOUT_MS = 60_000;

function mapType(t: string): ListEntry['type'] {
  if (t === 'd') return 'directory';
  if (t === '-') return 'file';
  return 'unknown';
}

/**
 * v0.11 Pillar γ Codex review Phase 2-2: map ssh2-sftp-client errors
 * to the shared FtpError hierarchy so backup / rollback / deploy can
 * branch on the same exception types regardless of protocol.
 *
 * ssh2-sftp-client surfaces three styles of error:
 * - `error.code === 2` (SFTP_STATUS_CODE NO_SUCH_FILE) → FtpNotFoundError
 * - `error.code === 'ENOENT'` (Node fs-style) → FtpNotFoundError
 * - message-based hints ('No such file', 'Permission denied', timeouts,
 *   'All configured authentication methods failed')
 *
 * The fallback `FtpError` preserves the original cause so callers can
 * dig deeper if needed.
 */
export function mapSftpError(error: unknown, context: string): FtpError {
  if (error instanceof FtpError) {
    return error;
  }
  const err = error as {
    code?: number | string;
    message?: string;
    name?: string;
  };
  const code = err?.code;
  const msg = (err?.message ?? String(error)).trim();
  const lower = msg.toLowerCase();

  // SFTP protocol code 2 = SSH_FX_NO_SUCH_FILE.
  if (code === 2 || code === 'ENOENT' || lower.includes('no such file')) {
    return new FtpNotFoundError(`${context}: not found`, { cause: error });
  }
  // SFTP protocol code 3 = SSH_FX_PERMISSION_DENIED.
  if (code === 3 || code === 'EACCES' || lower.includes('permission denied')) {
    return new FtpError(`${context}: permission denied`, { cause: error });
  }
  if (
    lower.includes('all configured authentication methods failed') ||
    lower.includes('keyboard-interactive') ||
    lower.includes('auth')
  ) {
    return new FtpAuthError(`${context}: authentication failed`, { cause: error });
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  ) {
    return new FtpTimeoutError(`${context}: timeout`, { cause: error });
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    lower.includes('connect') ||
    lower.includes('not connected')
  ) {
    return new FtpConnectionError(`${context}: connection failed`, { cause: error });
  }
  return new FtpError(`${context}: ${msg}`, { cause: error });
}

/**
 * Read an SSH private key from disk after verifying that its UNIX mode
 * is 0o600 or 0o400. This mirrors `ssh(1)`'s refusal to use a private
 * key that is group- or world-readable. Throws on bad permissions or
 * missing file (the underlying ENOENT propagates).
 */
function loadSshKey(path: string): Buffer {
  // v0.11 Pillar γ Codex review Phase 1-3: tilde expansion at the
  // runtime boundary so `ssh_key_path = "~/.ssh/id_ed25519"` works
  // without the operator having to know absolute paths.
  const resolved = expandTilde(path);
  const mode = statSync(resolved).mode & 0o777;
  if (mode !== 0o600 && mode !== 0o400) {
    throw new Error(
      `SftpClient: SSH key permissions must be 0o600 or 0o400, got 0o${mode.toString(8).padStart(3, '0')} (${path}). Run \`chmod 600 ${path}\` to fix.`,
    );
  }
  return readFileSync(resolved);
}

/**
 * High-level SFTP client. Wraps `ssh2-sftp-client` with the same
 * explicit lifecycle (connect / disconnect) and normalized list-entry
 * shape used by FtpClient. Retries belong to the caller — wrap
 * individual operations with `withRetry()` from `./retry.js`.
 */
export class SftpClient {
  private client: Sftp | null = null;

  constructor(private readonly options: SftpClientOptions) {
    if (!options.host) {
      throw new Error('host is required');
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async connect(): Promise<void> {
    const config = this.buildConnectConfig();
    const sftp = new Sftp();
    await sftp.connect(config);
    this.client = sftp;
  }

  /**
   * Assemble the ssh2-sftp-client connect options from SftpClientOptions.
   * Performs the SSH key permission check up front so an over-permissive
   * file aborts before any network I/O. Throws when neither password nor
   * sshKeyPath is provided.
   */
  private buildConnectConfig(): Sftp.ConnectOptions {
    const config: Sftp.ConnectOptions = {
      host: this.options.host,
      port: this.options.port ?? DEFAULT_PORT,
      username: this.options.user,
      readyTimeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    if (this.options.sshKeyPath) {
      config.privateKey = loadSshKey(this.options.sshKeyPath);
      if (this.options.sshKeyPassphrase) {
        config.passphrase = this.options.sshKeyPassphrase;
      }
      return config;
    }
    if (this.options.password) {
      config.password = this.options.password;
      return config;
    }
    throw new Error('SftpClient: either password or sshKeyPath must be provided');
  }

  async disconnect(): Promise<void> {
    if (this.client === null) {
      return;
    }
    await this.client.end();
    this.client = null;
  }

  async list(remotePath: string): Promise<ListEntry[]> {
    const client = this.requireConnection();
    try {
      const items = await client.list(remotePath);
      return items.map((i) => ({
        name: i.name,
        size: i.size,
        type: mapType(i.type),
        modifiedAt: new Date(i.modifyTime),
      }));
    } catch (error: unknown) {
      throw mapSftpError(error, `list(${remotePath})`);
    }
  }

  async upload(localPath: string, remotePath: string): Promise<UploadResult> {
    const client = this.requireConnection();
    try {
      await client.put(localPath, remotePath);
      const bytes = await this.safeSize(remotePath, 0);
      return { remotePath, bytesUploaded: bytes };
    } catch (error: unknown) {
      throw mapSftpError(error, `upload(${remotePath})`);
    }
  }

  /**
   * Upload an in-memory Buffer. Used by rollback so decrypted snapshot
   * bytes never touch the local filesystem. ssh2-sftp-client accepts a
   * Buffer directly in `put(input, dest)`, so no Readable.from() wrap
   * is needed.
   */
  async uploadBuffer(content: Buffer, remotePath: string): Promise<UploadResult> {
    const client = this.requireConnection();
    try {
      await client.put(content, remotePath);
      const bytes = await this.safeSize(remotePath, content.length);
      return { remotePath, bytesUploaded: bytes };
    } catch (error: unknown) {
      throw mapSftpError(error, `uploadBuffer(${remotePath})`);
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const client = this.requireConnection();
    try {
      await client.get(remotePath, localPath);
    } catch (error: unknown) {
      throw mapSftpError(error, `download(${remotePath})`);
    }
  }

  async delete(remotePath: string): Promise<void> {
    const client = this.requireConnection();
    try {
      await client.delete(remotePath);
    } catch (error: unknown) {
      throw mapSftpError(error, `delete(${remotePath})`);
    }
  }

  async size(remotePath: string): Promise<number> {
    const client = this.requireConnection();
    try {
      const stats = await client.stat(remotePath);
      return stats.size;
    } catch (error: unknown) {
      throw mapSftpError(error, `size(${remotePath})`);
    }
  }

  /**
   * Returns true when the remote path exists, regardless of whether it is
   * a file ('-'), directory ('d'), or symlink ('l').
   * ssh2-sftp-client.exists() returns `false | 'd' | '-' | 'l'`; we narrow
   * truthy-vs-false rather than overloading the predicate with a type
   * value to keep parity with FtpClient.exists(): Promise<boolean>.
   */
  async exists(remotePath: string): Promise<boolean> {
    const client = this.requireConnection();
    const result = await client.exists(remotePath);
    return result !== false;
  }

  async rename(srcPath: string, destPath: string): Promise<void> {
    const client = this.requireConnection();
    try {
      await client.rename(srcPath, destPath);
    } catch (error: unknown) {
      throw mapSftpError(error, `rename(${srcPath} → ${destPath})`);
    }
  }

  /**
   * mkdir -p semantics. ssh2-sftp-client's mkdir takes a recursive
   * flag so the caller does not need to walk parent directories
   * manually. Unlike basic-ftp's ensureDir there is no cwd side effect
   * to restore.
   */
  async mkdir(remotePath: string): Promise<void> {
    const client = this.requireConnection();
    try {
      await client.mkdir(remotePath, true);
    } catch (error: unknown) {
      throw mapSftpError(error, `mkdir(${remotePath})`);
    }
  }

  private requireConnection(): Sftp {
    if (this.client === null) {
      throw new Error('not connected');
    }
    return this.client;
  }

  private async safeSize(remotePath: string, fallback: number): Promise<number> {
    try {
      return await this.size(remotePath);
    } catch {
      return fallback;
    }
  }
}
