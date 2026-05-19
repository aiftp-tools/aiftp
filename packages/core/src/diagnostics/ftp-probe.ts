import type { FtpsProbeResult } from './doctor.js';

/**
 * Minimal interface the probe needs from an *already connected* FTP client.
 *
 * Modelled as a structural type so we can test the probe with cheap stubs
 * and still wire it to `FtpClient` in production. Implementations:
 *
 * - `FtpClient.toProbeClient()` for the real path
 * - in-memory object literal for unit tests
 */
export interface FtpProbeClient {
  /**
   * The TLS peer certificate, when the underlying socket is a TLSSocket.
   * Returns `null` for plain FTP connections.
   */
  getPeerCertificate(): { subject?: { CN?: string }; subjectaltname?: string } | null;

  /**
   * Wrap basic-ftp's FEAT response. Keys are uppercase feature names
   * ("MLSD", "SIZE", "AUTH TLS", ...). Values are the rest of the FEAT line.
   */
  getFeatures(): Promise<Map<string, string>>;

  /**
   * Issue a raw FTP command and return the reply code + raw message.
   */
  sendRaw(command: string): Promise<{ code: number; message: string }>;

  /**
   * Change working directory. Used to verify the configured `remote_root`
   * actually exists on the server.
   */
  cd(path: string): Promise<void>;
}

export interface FtpProbeContext {
  client: FtpProbeClient;
  requestedHost: string;
  remoteRoot: string;
}

const PASV_TUPLE_RE = /\((\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),\d{1,3},\d{1,3}\)/u;

/**
 * Parse the IP portion of a standard 227 PASV reply such as
 * "227 Entering Passive Mode (192,168,1,5,234,5)." Returns the
 * dotted-quad string, or `null` if no tuple is present.
 *
 * Exported for unit testing; callers should normally rely on
 * `probeFtps` which already pipes the result through `isPrivateIp`.
 */
export function parsePasvReply(reply: string): string | null {
  if (typeof reply !== 'string' || reply.length === 0) return null;
  const match = reply.match(PASV_TUPLE_RE);
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if ([a, b, c, d].some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return `${a}.${b}.${c}.${d}`;
}

/**
 * Return true if `ip` is a RFC1918 private address, loopback, or
 * link-local. These are the typical "NAT misconfiguration" IPs that
 * leak through a PASV reply on shared hosts.
 */
export function isPrivateIp(ip: string): boolean {
  if (typeof ip !== 'string') return false;
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function parseSubjectAltName(raw: string | undefined): string[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => entry.replace(/^(?:DNS|IP Address|URI|email):\s*/iu, ''))
    .filter((entry) => entry.length > 0);
}

/**
 * Run a focused set of FTPS-level diagnostic checks against an already
 * connected client. Designed to be called by `aiftp doctor`'s default
 * `probeFtps` dependency.
 *
 * Best-effort: any check that throws is reported as the conservative
 * "not OK" / "not supported" answer rather than propagating, so the
 * caller can still build a complete report.
 */
export async function probeFtps(context: FtpProbeContext): Promise<FtpsProbeResult> {
  const { client, remoteRoot } = context;

  // TLS handshake info. If the client got here, basic-ftp considered the
  // connection healthy, so handshakeOk is true. Cert details are only
  // available for TLS sockets.
  const cert = (() => {
    try {
      return client.getPeerCertificate();
    } catch {
      return null;
    }
  })();
  const certCommonName = cert && typeof cert.subject?.CN === 'string' ? cert.subject.CN : undefined;
  const certAltNames = parseSubjectAltName(cert?.subjectaltname);

  // FEAT response. If FEAT itself fails, we treat MLSD/SIZE as unsupported.
  let features: Map<string, string>;
  try {
    features = await client.getFeatures();
  } catch {
    features = new Map();
  }
  const mlsdSupported = features.has('MLSD');
  const sizeSupported = features.has('SIZE');

  // PASV probe. Returns the leaked private IP, or null if absent / routable.
  let pasvAddressLeak: string | null = null;
  try {
    const reply = await client.sendRaw('PASV');
    const ip = parsePasvReply(reply.message);
    if (ip && isPrivateIp(ip)) pasvAddressLeak = ip;
  } catch {
    // PASV unsupported / refused -> no leak signal.
    pasvAddressLeak = null;
  }

  // CWD probe. False on any error (550, 530, network drop mid-probe, etc.).
  // Capture the error message so the doctor report can surface the actual
  // FTP reply rather than "could not be selected" -- a 550 vs 530 vs a
  // network error suggest very different fixes.
  let remoteRootCwdOk = false;
  let remoteRootCwdError: string | undefined;
  try {
    await client.cd(remoteRoot);
    remoteRootCwdOk = true;
  } catch (error: unknown) {
    remoteRootCwdOk = false;
    remoteRootCwdError = error instanceof Error ? error.message : String(error);
  }

  return {
    handshakeOk: true,
    certCommonName,
    certAltNames,
    pasvAddressLeak,
    mlsdSupported,
    sizeSupported,
    remoteRootCwdOk,
    remoteRootCwdError,
  };
}
