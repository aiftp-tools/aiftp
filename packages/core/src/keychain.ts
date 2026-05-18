import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SECURITY_BIN = 'security';

/**
 * macOS `security` command exit code returned when a Keychain entry is not found.
 * Source: Apple SecurityTool source. The number is stable across macOS versions.
 */
const ERR_SEC_ITEM_NOT_FOUND = 44;

/**
 * Maximum stdout/stderr buffer the child process may produce (1 MiB).
 * Password material is small; this caps abuse of unexpected output.
 */
const MAX_BUFFER = 1024 * 1024;

/**
 * Storage envelope prefix. When `aiftp` writes a Keychain entry, the value is
 * encoded as `aiftp-v1:<base64-of-utf8-password>`. This keeps the stored bytes
 * inside printable ASCII so the macOS `security -w` flag never falls back to
 * its hex output mode (which is lossy for round-tripping). Entries that lack
 * the prefix are treated as foreign (manually added by the user via Keychain
 * Access or by another tool) and returned as-is.
 */
const STORAGE_PREFIX = 'aiftp-v1:';

function encodeStored(password: string): string {
  return STORAGE_PREFIX + Buffer.from(password, 'utf8').toString('base64');
}

function decodeStored(raw: string): string {
  if (!raw.startsWith(STORAGE_PREFIX)) {
    // Foreign entry. Return verbatim and let the caller deal with encoding
    // quirks. We do not attempt to detect `security`'s hex fallback because
    // it cannot be distinguished reliably from ordinary hex-looking passwords.
    return raw;
  }
  const payload = raw.slice(STORAGE_PREFIX.length);
  return Buffer.from(payload, 'base64').toString('utf8');
}

export class KeychainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeychainError';
  }
}

export class KeychainNotFoundError extends KeychainError {
  constructor(service: string, account: string, options?: { cause?: unknown }) {
    super(`Keychain entry not found: service='${service}' account='${account}'`, options);
    this.name = 'KeychainNotFoundError';
  }
}

export class KeychainPlatformError extends KeychainError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeychainPlatformError';
  }
}

function assertSupportedPlatform(): void {
  if (process.platform !== 'darwin') {
    throw new KeychainPlatformError(
      `Keychain is only available on macOS. Current platform: ${process.platform}. Windows support is planned for Phase 1.5.`,
    );
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KeychainError(`${name} must be a non-empty string`);
  }
}

interface ExecError extends Error {
  code?: number;
  stderr?: string;
}

function isExecError(error: unknown): error is ExecError {
  return error instanceof Error && 'code' in error;
}

/**
 * Stores a password in the macOS Keychain under (service, account).
 * If an entry already exists, it is updated atomically (-U flag).
 *
 * SECURITY NOTE: the password is passed via the `-w` argument of the
 * `security` binary. For the duration of the child process the password
 * is visible in process arguments (e.g., via `ps`). This is a known
 * limitation of the macOS `security` CLI; switching to a native binding
 * (@napi-rs/keyring) is on the Phase 2 backlog.
 */
export async function setPassword(
  service: string,
  account: string,
  password: string,
): Promise<void> {
  assertSupportedPlatform();
  assertNonEmpty(service, 'service');
  assertNonEmpty(account, 'account');
  if (typeof password !== 'string') {
    throw new KeychainError('password must be a string');
  }

  try {
    await execFileAsync(
      SECURITY_BIN,
      ['add-generic-password', '-s', service, '-a', account, '-w', encodeStored(password), '-U'],
      { maxBuffer: MAX_BUFFER },
    );
  } catch (error: unknown) {
    const detail = isExecError(error) ? error.stderr || error.message : String(error);
    throw new KeychainError(
      `Failed to store Keychain entry for service='${service}' account='${account}': ${detail.trim()}`,
      { cause: error },
    );
  }
}

/**
 * Retrieves a password from the macOS Keychain.
 * Throws KeychainNotFoundError if (service, account) does not exist.
 */
export async function getPassword(service: string, account: string): Promise<string> {
  assertSupportedPlatform();
  assertNonEmpty(service, 'service');
  assertNonEmpty(account, 'account');

  try {
    const { stdout } = await execFileAsync(
      SECURITY_BIN,
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { maxBuffer: MAX_BUFFER },
    );
    // `security -w` outputs the stored value followed by a newline.
    // Strip the trailing LF/CRLF and decode our storage envelope.
    return decodeStored(stdout.replace(/\r?\n$/, ''));
  } catch (error: unknown) {
    if (isExecError(error) && error.code === ERR_SEC_ITEM_NOT_FOUND) {
      throw new KeychainNotFoundError(service, account, { cause: error });
    }
    const detail = isExecError(error) ? error.stderr || error.message : String(error);
    throw new KeychainError(
      `Failed to read Keychain entry for service='${service}' account='${account}': ${detail.trim()}`,
      { cause: error },
    );
  }
}

/**
 * Deletes a Keychain entry. Throws KeychainNotFoundError if it does not exist.
 */
export async function deletePassword(service: string, account: string): Promise<void> {
  assertSupportedPlatform();
  assertNonEmpty(service, 'service');
  assertNonEmpty(account, 'account');

  try {
    await execFileAsync(SECURITY_BIN, ['delete-generic-password', '-s', service, '-a', account], {
      maxBuffer: MAX_BUFFER,
    });
  } catch (error: unknown) {
    if (isExecError(error) && error.code === ERR_SEC_ITEM_NOT_FOUND) {
      throw new KeychainNotFoundError(service, account, { cause: error });
    }
    const detail = isExecError(error) ? error.stderr || error.message : String(error);
    throw new KeychainError(
      `Failed to delete Keychain entry for service='${service}' account='${account}': ${detail.trim()}`,
      { cause: error },
    );
  }
}

/**
 * Returns true if a Keychain entry exists. Catches NotFound but lets
 * other errors propagate (e.g., user denial of access prompt).
 */
export async function hasPassword(service: string, account: string): Promise<boolean> {
  try {
    await getPassword(service, account);
    return true;
  } catch (error: unknown) {
    if (error instanceof KeychainNotFoundError) {
      return false;
    }
    throw error;
  }
}
