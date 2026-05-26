/**
 * Protocol-based deploy client factory — Task 24.
 *
 * deploy / rollback / backup all upload through a client that exposes
 * the FtpClient method surface (connect, list, upload, uploadBuffer,
 * download, delete, rename, mkdir, exists, size, disconnect). The
 * factory hides whether that surface is backed by basic-ftp
 * (FtpClient) or ssh2-sftp-client (SftpClient), so adding SFTP support
 * to a call site reduces to passing `protocol: 'sftp'` through config.
 *
 * The DeployClient union is intentionally narrow: it does NOT expose
 * FTP-only diagnostic helpers (getPeerCertificate, getFeatures,
 * sendRaw, cd). Those stay on FtpClient and the FTP-specific probe
 * in `diagnostics/ftp-probe.ts`.
 */

import type { Config, ProfileConfig } from './config.js';
import { FtpClient, type FtpClientOptions } from './ftp-client.js';
import { SftpClient, type SftpClientOptions } from './sftp-client.js';

export type DeployProtocol = 'ftp' | 'ftps' | 'sftp';

export type DeployClient = FtpClient | SftpClient;

/**
 * Discriminated union. The `protocol` field selects which client gets
 * built; the rest of the fields must match the chosen protocol's
 * options interface. TypeScript narrows when callers branch on
 * `protocol`.
 */
export type CreateDeployClientOptions =
  | (Omit<FtpClientOptions, 'protocol'> & { protocol: 'ftp' | 'ftps' })
  | (Omit<SftpClientOptions, never> & { protocol: 'sftp' });

export function createDeployClient(options: CreateDeployClientOptions): DeployClient {
  switch (options.protocol) {
    case 'ftp':
    case 'ftps': {
      const { protocol, ...rest } = options;
      return new FtpClient({ ...rest, protocol });
    }
    case 'sftp': {
      const { protocol: _ignored, ...rest } = options;
      return new SftpClient(rest);
    }
    default: {
      // biome-ignore lint/suspicious/noExplicitAny: defensive against runtime-only protocol values
      const unknown = (options as any).protocol;
      throw new Error(`createDeployClient: unsupported protocol "${unknown}"`);
    }
  }
}

/**
 * v0.11 Pillar γ — protocol-aware option builder for the deploy client.
 *
 * Centralises the cli / mcp / backup call sites so a Codex review
 * cannot find one that drops `ssh_key_path` (Phase 1-1/2-1 finding) or
 * leaks an FTP-only field (`requireTls` / `verifyCertificate` /
 * `noopIntervalSec`) into an SFTP option object.
 *
 * - For `ftp` / `ftps`: emits FtpClientOptions with the FTPS knobs from
 *   `safety` + `quirks` + `connection`. Password is required.
 * - For `sftp`: emits SftpClientOptions with `ssh_key_path` from the
 *   profile (when set) and `password` from the keychain. Either is
 *   accepted by SftpClient; sshKeyPath wins precedence inside the
 *   client.
 */
export function buildDeployClientOptions(args: {
  profile: ProfileConfig;
  config: Config;
  password: string;
}): CreateDeployClientOptions {
  const { profile, config, password } = args;
  if (profile.protocol === 'sftp') {
    return {
      protocol: 'sftp',
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password: password === '' ? undefined : password,
      sshKeyPath: profile.ssh_key_path,
      timeoutMs: config.connection.timeout_ms,
    };
  }
  return {
    protocol: profile.protocol,
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password,
    requireTls: config.safety.require_tls,
    verifyCertificate: config.safety.verify_certificate,
    skipHostnameCheck: config.quirks?.tls_check_hostname === false,
    timeoutMs: config.connection.timeout_ms,
    noopIntervalSec: config.quirks?.noop_interval_sec ?? 0,
  };
}
