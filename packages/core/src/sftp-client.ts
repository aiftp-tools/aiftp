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
import type { ListEntry } from './ftp-client.js';

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
    if (this.client === null) {
      throw new Error('not connected');
    }
    const items = await this.client.list(remotePath);
    return items.map((i) => ({
      name: i.name,
      size: i.size,
      type: mapType(i.type),
      modifiedAt: new Date(i.modifyTime),
    }));
  }
}
