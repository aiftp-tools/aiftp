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
 *
 * The same envelope is used by both the macOS and Windows backends so a
 * password written on one platform is decoded the same way on the other (in
 * principle -- in practice they don't share a vault).
 */
const STORAGE_PREFIX = 'aiftp-v1:';

function encodeStored(password: string): string {
  return STORAGE_PREFIX + Buffer.from(password, 'utf8').toString('base64');
}

function decodeStored(raw: string): string {
  if (!raw.startsWith(STORAGE_PREFIX)) {
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

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KeychainError(`${name} must be a non-empty string`);
  }
}

// ---------------------------------------------------------------------------
// Backend interface + dependency injection seam
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecFn = (cmd: string, args: readonly string[]) => Promise<ExecResult>;

export interface KeychainBackend {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string>;
  deletePassword(service: string, account: string): Promise<void>;
}

interface ExecError extends Error {
  code?: number;
  stderr?: string;
  stdout?: string;
}

function isExecError(error: unknown): error is ExecError {
  return error instanceof Error && 'code' in error;
}

/**
 * Default `ExecFn` that wraps Node's `execFile`. The factory pattern lets
 * tests substitute a stub exec while keeping the backend logic pure.
 */
function defaultExec(): ExecFn {
  return async (cmd, args) => {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, [...args], { maxBuffer: MAX_BUFFER });
      return { stdout, stderr, code: 0 };
    } catch (error: unknown) {
      if (isExecError(error)) {
        return {
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? error.message,
          code: typeof error.code === 'number' ? error.code : 1,
        };
      }
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// macOS backend (security command)
// ---------------------------------------------------------------------------

export function createDarwinKeychainBackend(exec: ExecFn): KeychainBackend {
  return {
    async setPassword(service, account, password) {
      assertNonEmpty(service, 'service');
      assertNonEmpty(account, 'account');
      if (typeof password !== 'string') {
        throw new KeychainError('password must be a string');
      }
      const result = await exec(SECURITY_BIN, [
        'add-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
        encodeStored(password),
        '-U',
      ]);
      if (result.code !== 0) {
        throw new KeychainError(
          `Failed to store Keychain entry for service='${service}' account='${account}': ${result.stderr.trim()}`,
        );
      }
    },

    async getPassword(service, account) {
      assertNonEmpty(service, 'service');
      assertNonEmpty(account, 'account');
      const result = await exec(SECURITY_BIN, [
        'find-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
      ]);
      if (result.code === ERR_SEC_ITEM_NOT_FOUND) {
        throw new KeychainNotFoundError(service, account);
      }
      if (result.code !== 0) {
        throw new KeychainError(
          `Failed to read Keychain entry for service='${service}' account='${account}': ${result.stderr.trim()}`,
        );
      }
      return decodeStored(result.stdout.replace(/\r?\n$/, ''));
    },

    async deletePassword(service, account) {
      assertNonEmpty(service, 'service');
      assertNonEmpty(account, 'account');
      const result = await exec(SECURITY_BIN, [
        'delete-generic-password',
        '-s',
        service,
        '-a',
        account,
      ]);
      if (result.code === ERR_SEC_ITEM_NOT_FOUND) {
        throw new KeychainNotFoundError(service, account);
      }
      if (result.code !== 0) {
        throw new KeychainError(
          `Failed to delete Keychain entry for service='${service}' account='${account}': ${result.stderr.trim()}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Windows backend (cmdkey for write/delete, PowerShell + Win32 CredRead for read)
// ---------------------------------------------------------------------------

const CMDKEY_BIN = 'cmdkey';
const POWERSHELL_BIN = 'powershell';

/**
 * Compose the Credential Manager target name for a (service, account) pair.
 * We use `<service>:<account>` so a single Windows account can own multiple
 * aiftp credentials without collisions.
 */
function windowsTarget(service: string, account: string): string {
  return `${service}:${account}`;
}

/**
 * PowerShell script template that reads the password via Win32 `CredRead`.
 * `$target` is the only externally-bound variable -- it is set in the
 * preamble we prepend before sending the script to PowerShell. The script
 * prints the password to stdout (no trailing newline) on success, prints
 * nothing (exit 0) when the credential does not exist, and writes errors to
 * stderr with a non-zero exit on real failures.
 */
const PS_CRED_READ_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AiftpCredManager {
  [DllImport("Advapi32.dll", SetLastError=true, EntryPoint="CredReadW", CharSet=CharSet.Unicode)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("Advapi32.dll", SetLastError=true)]
  private static extern void CredFree(IntPtr ptr);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  public static string Read(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return null;
    try {
      var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (cred.CredentialBlobSize == 0) return "";
      byte[] bytes = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
      return Encoding.Unicode.GetString(bytes);
    } finally { CredFree(ptr); }
  }
}
"@
$result = [AiftpCredManager]::Read($target)
if ($result -eq $null) { exit 0 }
[Console]::Out.Write($result)
`;

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/gu, "''");
}

export function createWindowsKeychainBackend(exec: ExecFn): KeychainBackend {
  return {
    async setPassword(service, account, password) {
      assertNonEmpty(service, 'service');
      assertNonEmpty(account, 'account');
      if (typeof password !== 'string') {
        throw new KeychainError('password must be a string');
      }
      const target = windowsTarget(service, account);
      const result = await exec(CMDKEY_BIN, [
        `/generic:${target}`,
        `/user:${account}`,
        `/pass:${encodeStored(password)}`,
      ]);
      if (result.code !== 0) {
        throw new KeychainError(
          `Failed to store Credential Manager entry for service='${service}' account='${account}': ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
    },

    async getPassword(service, account) {
      assertNonEmpty(service, 'service');
      assertNonEmpty(account, 'account');
      const target = windowsTarget(service, account);
      const escaped = escapePowerShellSingleQuoted(target);
      const script = `$target = '${escaped}'\n${PS_CRED_READ_SCRIPT}`;
      const result = await exec(POWERSHELL_BIN, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]);
      if (result.code !== 0) {
        throw new KeychainError(
          `Failed to read Credential Manager entry for service='${service}' account='${account}': ${result.stderr.trim() || `exit ${result.code}`}`,
        );
      }
      const raw = result.stdout.replace(/\r?\n$/u, '');
      if (raw.length === 0) {
        throw new KeychainNotFoundError(service, account);
      }
      return decodeStored(raw);
    },

    async deletePassword(service, account) {
      assertNonEmpty(service, 'service');
      assertNonEmpty(account, 'account');
      const target = windowsTarget(service, account);
      const result = await exec(CMDKEY_BIN, [`/delete:${target}`]);
      if (result.code !== 0) {
        // cmdkey returns "Element not found." in stderr for unknown targets.
        if (/element not found|cannot find/iu.test(result.stderr) || result.code === 1) {
          throw new KeychainNotFoundError(service, account);
        }
        throw new KeychainError(
          `Failed to delete Credential Manager entry for service='${service}' account='${account}': ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Platform routing for the public API
// ---------------------------------------------------------------------------

let cachedBackend: KeychainBackend | undefined;

function backend(): KeychainBackend {
  if (cachedBackend) return cachedBackend;
  if (process.platform === 'darwin') {
    cachedBackend = createDarwinKeychainBackend(defaultExec());
  } else if (process.platform === 'win32') {
    cachedBackend = createWindowsKeychainBackend(defaultExec());
  } else {
    throw new KeychainPlatformError(
      `Keychain backend not available for platform '${process.platform}'. aiftp supports macOS and Windows.`,
    );
  }
  return cachedBackend;
}

// Test helper: reset the cached backend (used by Linux platform-guard test).
export function _resetKeychainBackendForTests(): void {
  cachedBackend = undefined;
}

export async function setPassword(
  service: string,
  account: string,
  password: string,
): Promise<void> {
  return backend().setPassword(service, account, password);
}

export async function getPassword(service: string, account: string): Promise<string> {
  return backend().getPassword(service, account);
}

export async function deletePassword(service: string, account: string): Promise<void> {
  return backend().deletePassword(service, account);
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
