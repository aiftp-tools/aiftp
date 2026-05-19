import { type AccessOptions, Client as BasicFtpClient, type FileInfo } from 'basic-ftp';

export class FtpError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FtpError';
  }
}

export class FtpConnectionError extends FtpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FtpConnectionError';
  }
}

export class FtpAuthError extends FtpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FtpAuthError';
  }
}

export interface FtpTlsErrorDiagnostics {
  /** CN from the server certificate's subject, when available. */
  certCommonName?: string;
  /** Parsed list of DNS / IP altnames from the server certificate. */
  certAltNames?: string[];
  /** The host the client was trying to connect to (from Node's TLS error). */
  actualHost?: string;
  /** Human-readable next step the operator can take to unblock themselves. */
  recommendedAction?: string;
}

export class FtpTlsError extends FtpError {
  readonly certCommonName?: string;
  readonly certAltNames?: string[];
  readonly actualHost?: string;
  readonly recommendedAction?: string;

  constructor(message: string, options?: { cause?: unknown } & FtpTlsErrorDiagnostics) {
    super(message, options);
    this.name = 'FtpTlsError';
    this.certCommonName = options?.certCommonName;
    this.certAltNames = options?.certAltNames;
    this.actualHost = options?.actualHost;
    this.recommendedAction = options?.recommendedAction;
  }
}

export class FtpNotFoundError extends FtpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FtpNotFoundError';
  }
}

export class FtpTimeoutError extends FtpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FtpTimeoutError';
  }
}

export type FtpProtocol = 'ftp' | 'ftps';

export interface FtpClientOptions {
  host: string;
  port?: number;
  user: string;
  password: string;
  protocol?: FtpProtocol;
  /**
   * When true (default), refuse to connect over plain FTP — only FTPS is
   * accepted. Setting this to false explicitly opts in to plain FTP and
   * logs a warning via `onWarning`.
   */
  requireTls?: boolean;
  /**
   * When true (default), reject self-signed and otherwise invalid TLS
   * certificates. Must be left enabled for production deployments.
   */
  verifyCertificate?: boolean;
  /**
   * When true, skip the hostname-matches-cert check but keep the full
   * chain validation. Maps to `[quirks].tls_check_hostname = false`.
   * The typical use case is Star Server: cert CN is `*.star.ne.jp` but
   * the customer's actual hostname is `*.stars.ne.jp`. Defaults to
   * false (perform the hostname check). Has no effect when
   * `verifyCertificate` is false.
   */
  skipHostnameCheck?: boolean;
  /**
   * Socket-level timeout in milliseconds for individual FTP operations.
   * Defaults to 60_000 (60s) per spec §C.1.
   */
  timeoutMs?: number;
  /**
   * Optional logger for verbose debugging. Receives FTP protocol traffic
   * with credentials redacted.
   */
  onLog?: (line: string) => void;
  /**
   * Optional sink for non-fatal warnings (e.g., plain FTP fallback).
   */
  onWarning?: (line: string) => void;
  /**
   * When > 0, send a NOOP command every `noopIntervalSec` seconds while
   * the connection is idle, to keep PASV NAT mappings and shared-host
   * idle-disconnect timers from severing the control channel. Maps to
   * `[quirks].noop_interval_sec` in the config schema. 0 disables.
   */
  noopIntervalSec?: number;
}

export interface ListEntry {
  name: string;
  size: number;
  type: 'file' | 'directory' | 'unknown';
  modifiedAt?: Date;
}

export interface UploadResult {
  remotePath: string;
  bytesUploaded: number;
}

const DEFAULT_PORT = 21;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Maps a basic-ftp / Node error into our error hierarchy.
 * Best-effort: the FTP reply code is the strongest signal; if it is
 * missing, the message text is sniffed for known phrases.
 */
/**
 * Parse a Node TLS cert's `subjectaltname` field (e.g.
 * "DNS:*.star.ne.jp, DNS:star.ne.jp, IP Address:10.0.0.1") into a plain
 * list of altname values without the `DNS:` / `IP Address:` prefix.
 */
function parseSubjectAltName(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => entry.replace(/^(?:DNS|IP Address|URI|email):\s*/iu, ''))
    .filter((entry) => entry.length > 0);
}

function diagnoseAltnameError(err: {
  host?: unknown;
  cert?: { subject?: { CN?: unknown }; subjectaltname?: unknown };
}): FtpTlsErrorDiagnostics {
  const host = typeof err?.host === 'string' ? err.host : undefined;
  const cn = typeof err?.cert?.subject?.CN === 'string' ? err.cert.subject.CN : undefined;
  const altNames = parseSubjectAltName(err?.cert?.subjectaltname);
  const recommendedAction =
    'After confirming the server identity through another channel (control panel, support, DNS), set safety.verify_certificate=false in .aiftp.toml and retry. aiftp does not silently bypass TLS hostname checks.';
  return {
    certCommonName: cn,
    certAltNames: altNames,
    actualHost: host,
    recommendedAction,
  };
}

export function mapFtpError(error: unknown, context: string): FtpError {
  if (error instanceof FtpError) {
    return error;
  }
  const err = error as {
    code?: number | string;
    message?: string;
    host?: unknown;
    cert?: { subject?: { CN?: unknown }; subjectaltname?: unknown };
  };
  const code = typeof err?.code === 'number' ? err.code : undefined;
  const msg = err?.message ?? String(error);

  // Node TLS errors (string codes)
  if (typeof err?.code === 'string') {
    const tlsCodes = new Set([
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]);
    if (tlsCodes.has(err.code)) {
      // Only ALTNAME errors carry the cert / host details we want to surface.
      // For other TLS failures (expired, self-signed, etc.) we still wrap as
      // FtpTlsError but without specific diagnostic fields.
      if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        const diagnostics = diagnoseAltnameError(err);
        const altList = diagnostics.certAltNames?.join(', ') ?? '(none)';
        const enhanced = `${context}: TLS hostname mismatch. Server certificate CN="${diagnostics.certCommonName ?? '?'}" altNames=[${altList}] does not cover requested host "${diagnostics.actualHost ?? '?'}". ${diagnostics.recommendedAction ?? ''}`;
        return new FtpTlsError(enhanced.trim(), {
          cause: error,
          ...diagnostics,
        });
      }
      return new FtpTlsError(`${context}: TLS verification failed (${err.code}): ${msg}`, {
        cause: error,
      });
    }
    if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
      return new FtpTimeoutError(`${context}: socket timeout`, { cause: error });
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
      return new FtpConnectionError(`${context}: connection failed (${err.code})`, {
        cause: error,
      });
    }
  }

  // FTP reply codes (numeric)
  if (code === 530) {
    return new FtpAuthError(`${context}: authentication failed (530)`, { cause: error });
  }
  if (code === 550) {
    return new FtpNotFoundError(`${context}: not found or permission denied (550)`, {
      cause: error,
    });
  }
  if (code === 421) {
    return new FtpConnectionError(`${context}: service unavailable (421)`, { cause: error });
  }
  if (code === 425 || code === 426) {
    return new FtpConnectionError(`${context}: data connection failed (${code})`, {
      cause: error,
    });
  }

  // Fallback: inspect message text
  const lower = msg.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return new FtpTimeoutError(`${context}: ${msg}`, { cause: error });
  }

  return new FtpError(`${context}: ${msg}`, { cause: error });
}

function mapFileType(t: FileInfo['type']): ListEntry['type'] {
  // basic-ftp's FileType: 0=Unknown, 1=File, 2=Directory, 3=SymbolicLink
  if (t === 1) return 'file';
  if (t === 2) return 'directory';
  return 'unknown';
}

/**
 * High-level FTP/FTPS client. Wraps `basic-ftp` with:
 *   - TLS enforcement (requireTls)
 *   - certificate verification toggle
 *   - normalized error hierarchy
 *   - explicit connect/disconnect lifecycle
 *
 * Retries belong to the caller — wrap individual operations with
 * `withRetry()` from `./retry.js`.
 */
export class FtpClient {
  private client: BasicFtpClient | null = null;
  private noopTimer: ReturnType<typeof setInterval> | null = null;
  private readonly options: Required<
    Omit<
      FtpClientOptions,
      | 'onLog'
      | 'onWarning'
      | 'port'
      | 'protocol'
      | 'requireTls'
      | 'verifyCertificate'
      | 'timeoutMs'
      | 'skipHostnameCheck'
      | 'noopIntervalSec'
    >
  > & {
    port: number;
    protocol: FtpProtocol;
    requireTls: boolean;
    verifyCertificate: boolean;
    timeoutMs: number;
    skipHostnameCheck: boolean;
    noopIntervalSec: number;
    onLog?: (line: string) => void;
    onWarning?: (line: string) => void;
  };

  constructor(options: FtpClientOptions) {
    if (!options.host) throw new FtpError('host is required');
    if (!options.user) throw new FtpError('user is required');
    if (options.password === undefined || options.password === null) {
      throw new FtpError('password is required');
    }

    const protocol: FtpProtocol = options.protocol ?? 'ftps';
    const requireTls = options.requireTls ?? true;

    if (requireTls && protocol === 'ftp') {
      throw new FtpTlsError(
        'requireTls=true but protocol="ftp": plain FTP is not allowed. ' +
          'Either set protocol="ftps" or pass requireTls=false explicitly.',
      );
    }

    this.options = {
      host: options.host,
      user: options.user,
      password: options.password,
      port: options.port ?? DEFAULT_PORT,
      protocol,
      requireTls,
      verifyCertificate: options.verifyCertificate ?? true,
      skipHostnameCheck: options.skipHostnameCheck ?? false,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      noopIntervalSec: options.noopIntervalSec ?? 0,
      onLog: options.onLog,
      onWarning: options.onWarning,
    };

    if (this.options.protocol === 'ftp') {
      this.options.onWarning?.(
        'Using plain FTP without TLS. Credentials and data are transmitted in clear text.',
      );
    }
  }

  /**
   * Establishes the connection. Idempotent: calling twice replaces the
   * underlying socket.
   */
  async connect(): Promise<void> {
    await this.disconnect();

    const client = new BasicFtpClient(this.options.timeoutMs);
    if (this.options.onLog) {
      client.ftp.verbose = true;
      client.ftp.log = this.options.onLog;
    }

    const accessOptions: AccessOptions = {
      host: this.options.host,
      port: this.options.port,
      user: this.options.user,
      password: this.options.password,
      secure: this.options.protocol === 'ftps',
      secureOptions: {
        rejectUnauthorized: this.options.verifyCertificate,
        // skipHostnameCheck=true keeps `rejectUnauthorized` honest about
        // the chain but treats the hostname mismatch as benign. Used by
        // the StarServer / lolipop-style shared hosts where the cert CN
        // does not include the customer's vanity domain.
        ...(this.options.skipHostnameCheck && this.options.verifyCertificate !== false
          ? { checkServerIdentity: () => undefined }
          : {}),
      },
    };

    try {
      await client.access(accessOptions);
    } catch (error: unknown) {
      client.close();
      throw mapFtpError(error, 'connect');
    }
    this.client = client;

    // Optional NOOP keepalive. Best-effort: if a NOOP fails because the
    // socket is mid-transfer or torn down, swallow it -- the next real
    // operation will surface the actual error.
    const interval = this.options.noopIntervalSec ?? 0;
    if (interval > 0) {
      this.noopTimer = setInterval(() => {
        if (!this.client) return;
        this.client.send('NOOP').catch(() => undefined);
      }, interval * 1000);
      // Don't hold the process open just for the keepalive.
      this.noopTimer.unref?.();
    }
  }

  /**
   * Closes the connection. Safe to call multiple times.
   */
  async disconnect(): Promise<void> {
    if (this.noopTimer) {
      clearInterval(this.noopTimer);
      this.noopTimer = null;
    }
    if (this.client) {
      try {
        this.client.close();
      } catch {
        // Ignore close errors; we are tearing down.
      }
      this.client = null;
    }
  }

  /**
   * Reports whether the client believes it is connected. Note that the
   * server may have closed the connection without our knowledge; the next
   * operation will surface that case as an error.
   */
  isConnected(): boolean {
    return this.client !== null && !this.client.closed;
  }

  private requireConnection(): BasicFtpClient {
    if (!this.client || this.client.closed) {
      throw new FtpConnectionError('Not connected. Call connect() first.');
    }
    return this.client;
  }

  async upload(localPath: string, remotePath: string): Promise<UploadResult> {
    const client = this.requireConnection();
    try {
      await client.uploadFrom(localPath, remotePath);
      const bytes = await client.size(remotePath).catch(() => 0);
      return { remotePath, bytesUploaded: bytes };
    } catch (error: unknown) {
      throw mapFtpError(error, `upload(${remotePath})`);
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const client = this.requireConnection();
    try {
      await client.downloadTo(localPath, remotePath);
    } catch (error: unknown) {
      throw mapFtpError(error, `download(${remotePath})`);
    }
  }

  async list(remotePath?: string): Promise<ListEntry[]> {
    const client = this.requireConnection();
    try {
      const entries = await client.list(remotePath);
      return entries.map((e) => ({
        name: e.name,
        size: e.size,
        type: mapFileType(e.type),
        modifiedAt: e.modifiedAt,
      }));
    } catch (error: unknown) {
      throw mapFtpError(error, `list(${remotePath ?? '.'})`);
    }
  }

  async delete(remotePath: string): Promise<void> {
    const client = this.requireConnection();
    try {
      await client.remove(remotePath);
    } catch (error: unknown) {
      throw mapFtpError(error, `delete(${remotePath})`);
    }
  }

  async size(remotePath: string): Promise<number> {
    const client = this.requireConnection();
    try {
      return await client.size(remotePath);
    } catch (error: unknown) {
      throw mapFtpError(error, `size(${remotePath})`);
    }
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.size(remotePath);
      return true;
    } catch (error: unknown) {
      if (error instanceof FtpNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  async mkdir(remotePath: string): Promise<void> {
    const client = this.requireConnection();
    let originalDir: string | undefined;
    try {
      // basic-ftp's ensureDir is "mkdir -p" but has a side effect: it leaves
      // the CWD at the deepest created directory. Restore it so subsequent
      // operations see a stable working directory.
      try {
        originalDir = await client.pwd();
      } catch {
        // pwd may fail in unusual server states; restore is best-effort.
      }
      await client.ensureDir(remotePath);
    } catch (error: unknown) {
      throw mapFtpError(error, `mkdir(${remotePath})`);
    } finally {
      if (originalDir) {
        try {
          await client.cd(originalDir);
        } catch {
          // Best-effort restore.
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Diagnostic helpers (used by packages/core/src/diagnostics/ftp-probe.ts).
  // These are deliberately narrow so the probe module does not reach into
  // basic-ftp internals.
  // ---------------------------------------------------------------------

  /**
   * Return the TLS peer certificate when the underlying socket is a
   * TLSSocket, or `null` for plain FTP / pre-connect / unsupported sockets.
   */
  getPeerCertificate(): { subject?: { CN?: string }; subjectaltname?: string } | null {
    try {
      const client = this.requireConnection();
      // basic-ftp exposes the active socket on .ftp.socket; the raw type is
      // a Node net.Socket | tls.TLSSocket. We duck-type via getPeerCertificate.
      const socket = (
        client as unknown as {
          ftp: { socket?: { getPeerCertificate?: () => unknown } };
        }
      ).ftp.socket;
      if (!socket || typeof socket.getPeerCertificate !== 'function') return null;
      const cert = socket.getPeerCertificate();
      if (!cert || typeof cert !== 'object') return null;
      return cert as { subject?: { CN?: string }; subjectaltname?: string };
    } catch {
      return null;
    }
  }

  /**
   * Return the server's FEAT response keyed by uppercase feature name.
   * Useful for detecting MLSD / SIZE / AUTH TLS support.
   */
  async getFeatures(): Promise<Map<string, string>> {
    const client = this.requireConnection();
    try {
      return await client.features();
    } catch (error: unknown) {
      throw mapFtpError(error, 'FEAT');
    }
  }

  /**
   * Send a raw FTP command and return the parsed reply code + message.
   */
  async sendRaw(command: string): Promise<{ code: number; message: string }> {
    const client = this.requireConnection();
    try {
      const response = await client.send(command);
      return { code: response.code, message: response.message };
    } catch (error: unknown) {
      throw mapFtpError(error, `send(${command})`);
    }
  }

  /**
   * Change working directory. Thin wrapper around basic-ftp's `cd` so the
   * diagnostic probe can verify a configured `remote_root` resolves.
   */
  async cd(remotePath: string): Promise<void> {
    const client = this.requireConnection();
    try {
      await client.cd(remotePath);
    } catch (error: unknown) {
      throw mapFtpError(error, `cd(${remotePath})`);
    }
  }
}
