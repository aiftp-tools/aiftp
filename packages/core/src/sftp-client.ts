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

import Sftp from 'ssh2-sftp-client';
import type { ListEntry, UploadResult } from './ftp-client.js';

export interface SftpClientOptions {
  host: string;
  port?: number;
  user: string;
  password: string;
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
    const sftp = new Sftp();
    await sftp.connect({
      host: this.options.host,
      port: this.options.port ?? DEFAULT_PORT,
      username: this.options.user,
      password: this.options.password,
      readyTimeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.client = sftp;
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
    const items = await client.list(remotePath);
    return items.map((i) => ({
      name: i.name,
      size: i.size,
      type: mapType(i.type),
      modifiedAt: new Date(i.modifyTime),
    }));
  }

  async upload(localPath: string, remotePath: string): Promise<UploadResult> {
    const client = this.requireConnection();
    await client.put(localPath, remotePath);
    const bytes = await this.safeSize(remotePath, 0);
    return { remotePath, bytesUploaded: bytes };
  }

  /**
   * Upload an in-memory Buffer. Used by rollback so decrypted snapshot
   * bytes never touch the local filesystem. ssh2-sftp-client accepts a
   * Buffer directly in `put(input, dest)`, so no Readable.from() wrap
   * is needed.
   */
  async uploadBuffer(content: Buffer, remotePath: string): Promise<UploadResult> {
    const client = this.requireConnection();
    await client.put(content, remotePath);
    const bytes = await this.safeSize(remotePath, content.length);
    return { remotePath, bytesUploaded: bytes };
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const client = this.requireConnection();
    await client.get(remotePath, localPath);
  }

  async delete(remotePath: string): Promise<void> {
    const client = this.requireConnection();
    await client.delete(remotePath);
  }

  async size(remotePath: string): Promise<number> {
    const client = this.requireConnection();
    const stats = await client.stat(remotePath);
    return stats.size;
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
    await client.rename(srcPath, destPath);
  }

  /**
   * mkdir -p semantics. ssh2-sftp-client's mkdir takes a recursive
   * flag so the caller does not need to walk parent directories
   * manually. Unlike basic-ftp's ensureDir there is no cwd side effect
   * to restore.
   */
  async mkdir(remotePath: string): Promise<void> {
    const client = this.requireConnection();
    await client.mkdir(remotePath, true);
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
