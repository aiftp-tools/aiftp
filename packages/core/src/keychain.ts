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

/**
 * `stdin` exists so secrets never travel in `args`. Anything on a command
 * line is readable from the process list (`ps`, Task Manager, any local
 * process) for as long as the child runs, and may be captured by process
 * accounting or an EDR agent. Existing injected fakes that ignore the third
 * parameter keep working unchanged.
 */
export interface ExecOptions {
  readonly stdin?: string;
}

export type ExecFn = (
  cmd: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

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
  return async (cmd, args, options) => {
    // v0.12.4: fail closed when a test forgot to inject a fake keychain.
    // Reaching the real OS keychain from a unit test spawns `security`
    // (macOS) or `powershell` + `Add-Type -TypeDefinition` (Windows, which
    // compiles C# at runtime). Under CI load the Windows path exceeded
    // vitest's 5s default timeout and produced a Windows-only flake whose
    // only symptom was "Test timed out in 5000ms".
    //
    // The check sits inside `defaultExec` so it fires only when a real
    // child process is about to be spawned -- injected exec stubs and the
    // unsupported-platform guard in `backend()` are unaffected. Both
    // variables are required so a stray variable in a real user's shell
    // cannot disable their keychain (vitest.config.ts sets both).
    if (process.env.NODE_ENV === 'test' && process.env.AIFTP_TEST_NO_REAL_KEYCHAIN === '1') {
      throw new KeychainError(
        `Refusing a real OS keychain call during tests: ${cmd}. Inject a fake instead (see AiftpMcpRuntime.hasPassword / createBackupStore). The Windows backend spawns PowerShell + Add-Type and can exceed vitest's 5s timeout under CI load.`,
      );
    }
    try {
      const pending = execFileAsync(cmd, [...args], { maxBuffer: MAX_BUFFER });
      if (options?.stdin !== undefined) {
        // `promisify(execFile)` exposes the spawned child on the returned
        // promise, which is the only way to reach its stdin. Closing the
        // stream is required: `security` waits on its prompt forever
        // otherwise. An EPIPE here means the child exited first — its exit
        // code is the real error, so do not mask it by rejecting on the
        // write.
        const child = (pending as unknown as { child?: { stdin?: NodeJS.WritableStream } }).child;
        child?.stdin?.on('error', () => undefined);
        child?.stdin?.end(options.stdin);
      }
      const { stdout, stderr } = await pending;
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

/**
 * `security -i` splits its input into arguments and honours double quotes,
 * so every field is quoted. Values that could end the quoted run are refused
 * outright rather than escaped: a service is always `aiftp:<site>-<profile>`
 * and an account is an FTP username, so none of these characters is ever
 * legitimate, and a reject is easier to reason about than an escape table.
 */
function isSecurityInteractiveSafe(value: string): boolean {
  // Checked by code point rather than by regex: a character class would have
  // to spell out the control range, which is exactly what this rejects.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"' || character === '\\' || code < 0x20) return false;
  }
  return true;
}

function quoteForSecurityInteractive(value: string, name: string): string {
  if (!isSecurityInteractiveSafe(value)) {
    throw new KeychainError(`${name} must not contain quotes, backslashes or control characters`);
  }
  return `"${value}"`;
}

export function createDarwinKeychainBackend(exec: ExecFn): KeychainBackend {
  return {
    async setPassword(service, account, password) {
      assertNonEmpty(service, 'service');
      assertNonEmpty(account, 'account');
      if (typeof password !== 'string') {
        throw new KeychainError('password must be a string');
      }
      // `security -i` reads whole commands from stdin, so nothing on this
      // line — the password included — ever appears in the process list.
      //
      // Rejected alternative: `-w` with no value, which puts `security` into
      // prompting mode and also reads from stdin. Measured on macOS 25.6:
      // the prompt **silently truncates at 128 bytes** (a 1024-char password
      // came back as 89 chars), which would store a wrong password and lock
      // the user out with no error. `-i` has no such limit.
      //
      // The cost of `-i` is that it parses arguments, which the previous argv
      // form did not: an unquoted service or account could smuggle in a flag.
      // Hence quoting plus a hard reject below.
      const result = await exec(SECURITY_BIN, ['-i'], {
        stdin: `${[
          'add-generic-password',
          '-s',
          quoteForSecurityInteractive(service, 'service'),
          '-a',
          quoteForSecurityInteractive(account, 'account'),
          '-U',
          '-w',
          quoteForSecurityInteractive(encodeStored(password), 'password'),
        ].join(' ')}\n`,
      });
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
// Windows backend (PowerShell + Win32 CredWrite/CredRead; cmdkey only for delete)
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

/**
 * PowerShell script that writes the credential via Win32 `CredWrite`, taking
 * the secret from **stdin** rather than from the command line.
 *
 * This replaces `cmdkey /pass:<value>`, which had no stdin form and therefore
 * put the password — and, since v0.13.1, the AES backup key — in the process
 * list for the lifetime of the child.
 *
 * `$target` and `$user` are bound by the preamble prepended before sending;
 * neither is a credential. `Encoding.Unicode` matches PS_CRED_READ_SCRIPT and
 * what `cmdkey` itself wrote, so entries created by either remain readable.
 */
const PS_CRED_WRITE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AiftpCredWriter {
  [DllImport("Advapi32.dll", SetLastError=true, EntryPoint="CredWriteW", CharSet=CharSet.Unicode)]
  private static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
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
  public static void Write(string target, string user, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL cred = new CREDENTIAL();
      cred.Type = 1;
      cred.TargetName = target;
      cred.CredentialBlobSize = (uint)bytes.Length;
      cred.CredentialBlob = blob;
      cred.Persist = 2;
      cred.UserName = user;
      if (!CredWrite(ref cred, 0)) {
        throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error());
      }
    } finally { Marshal.FreeHGlobal(blob); }
  }
}
"@
$secret = [Console]::In.ReadToEnd().TrimEnd([char]13, [char]10)
[AiftpCredWriter]::Write($target, $user, $secret)
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
      const preamble = `$target = '${escapePowerShellSingleQuoted(target)}'\n$user = '${escapePowerShellSingleQuoted(account)}'\n`;
      // The secret goes on stdin; only the target and user (neither a
      // credential) reach the command line.
      const result = await exec(
        POWERSHELL_BIN,
        ['-NoProfile', '-NonInteractive', '-Command', `${preamble}${PS_CRED_WRITE_SCRIPT}`],
        { stdin: encodeStored(password) },
      );
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
