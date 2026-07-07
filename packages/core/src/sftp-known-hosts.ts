import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const HEADER = '# aiftp known_hosts - do not edit by hand';

export type HostKeyVerificationOutcome = 'pinned' | 'matched' | 'mismatch';

export interface VerifyHostKeyOptions {
  knownHostsPath: string;
  host: string;
  port: number;
  key: Buffer;
}

export interface VerifyHostKeyResult {
  outcome: HostKeyVerificationOutcome;
  fingerprint: string;
  knownFingerprint?: string;
}

export function fingerprintHostKey(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}

export function hostId(host: string, port: number): string {
  return `${host}:${port}`;
}

export function serializeEntry(host: string, port: number, fingerprint: string): string {
  return `${host} ${port} ${fingerprint}`;
}

export function parseKnownHosts(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const [host, portText, fingerprint] = line.split(/\s+/u);
    const port = Number(portText);
    if (!host || !Number.isInteger(port) || port <= 0 || !fingerprint) {
      continue;
    }
    entries.set(hostId(host, port), fingerprint);
  }
  return entries;
}

async function readKnownHosts(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export async function verifyHostKey(options: VerifyHostKeyOptions): Promise<VerifyHostKeyResult> {
  const fingerprint = fingerprintHostKey(options.key);
  const source = await readKnownHosts(options.knownHostsPath);
  const known = parseKnownHosts(source).get(hostId(options.host, options.port));
  if (known === fingerprint) {
    return { outcome: 'matched', fingerprint, knownFingerprint: known };
  }
  if (known !== undefined) {
    return { outcome: 'mismatch', fingerprint, knownFingerprint: known };
  }

  await mkdir(dirname(options.knownHostsPath), { recursive: true, mode: 0o700 });
  const prefix = source.trim() === '' ? `${HEADER}\n` : '';
  await appendFile(
    options.knownHostsPath,
    `${prefix}${serializeEntry(options.host, options.port, fingerprint)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return { outcome: 'pinned', fingerprint };
}
