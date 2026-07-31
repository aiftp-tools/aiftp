import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { appendProfileBlock } from '../config-edit.js';
import { ensureGitignoreEntry } from '../init/gitignore.js';
import { buildKeychainService } from '../init/keychain-name.js';
import { hasPassword, setPassword } from '../keychain.js';
import { SiteRegistry } from '../sites/registry.js';
import {
  type BootstrapDeps,
  type BootstrapInput,
  type BootstrapResult,
  BootstrapValidationError,
  type ConfigOutcome,
  type CredentialOutcome,
  type RegistryOutcome,
} from './types.js';
import { validateBootstrapInput } from './validate.js';

export * from './types.js';
export { validateBootstrapInput } from './validate.js';

const CREDENTIAL_HINT =
  'Claude Desktop の設定 → 拡張機能 → aiftp で「パスワード」欄を入力し、Claude Desktop を再起動してください。';

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)) !== undefined;
  } catch {
    return false;
  }
}

export async function runBootstrap(
  rawInput: Partial<BootstrapInput>,
  deps: BootstrapDeps = {},
): Promise<BootstrapResult> {
  const input = validateBootstrapInput(rawInput);
  const pathExists = deps.pathExists ?? defaultPathExists;
  const readTextFile = deps.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
  const writeTextFile =
    deps.writeTextFile ??
    ((path: string, contents: string) =>
      writeFile(path, contents, { encoding: 'utf8', mode: 0o600 }));
  const storeCredential = deps.storeCredential ?? setPassword;
  const credentialExists = deps.credentialExists ?? hasPassword;
  const createRegistry = deps.createRegistry ?? (() => new SiteRegistry());
  const ensureGitignore =
    deps.ensureGitignore ?? ((cwd: string) => ensureGitignoreEntry(cwd, { requireGitRepo: true }));

  if (!(await pathExists(input.localRoot))) {
    throw new BootstrapValidationError(
      `bootstrap-invalid: local_root does not exist: ${input.localRoot}`,
      'Claude Desktop の設定 → 拡張機能 → aiftp で「サイトフォルダ」を存在するフォルダに選び直し、Claude Desktop を再起動してください。',
    );
  }

  const keychainService = buildKeychainService(input.siteName, input.profileName);
  const configPath = join(input.localRoot, '.aiftp.toml');

  // 1. .aiftp.toml — never overwrite an existing file. A trainee (or the CLI)
  //    may have edited it; the extension must not clobber that.
  let config: ConfigOutcome;
  if (await pathExists(configPath)) {
    await readTextFile(configPath);
    config = 'existing';
  } else {
    const source = appendProfileBlock('schema = 2', input.profileName, {
      host: input.host,
      port: input.protocol === 'sftp' ? 22 : 21,
      protocol: input.protocol,
      user: input.username,
      remote_root: input.remoteRoot,
      local_root: '.',
      keychain_service: keychainService,
      server_kind: 'generic',
    });
    await writeTextFile(configPath, source);
    config = 'created';
  }

  // 2. credential — copy the env-provided value into aiftp's own keychain
  //    exactly once, then stop reading the env.
  let credential: CredentialOutcome;
  if (await credentialExists(keychainService, input.username)) {
    credential = 'already-stored';
  } else if (input.credential !== undefined && input.credential.length > 0) {
    await storeCredential(keychainService, input.username, input.credential);
    credential = 'stored';
  } else {
    credential = 'missing';
  }

  // 3. fleet registry
  const registrySurface = createRegistry();
  const entries = await registrySurface.list();
  const existing = entries.find((entry) => entry.name === input.siteName);
  let registry: RegistryOutcome;
  if (existing) {
    if (resolvePath(existing.path) !== resolvePath(input.localRoot)) {
      throw new BootstrapValidationError(
        `bootstrap-conflict: site "${input.siteName}" is already registered for a different folder (${existing.path})`,
        'Claude Desktop の設定 → 拡張機能 → aiftp で「サイト名」を別の名前に変えるか、「サイトフォルダ」を登録済みのフォルダに合わせてください。',
      );
    }
    registry = 'already-registered';
  } else {
    await registrySurface.add({
      name: input.siteName,
      path: input.localRoot,
      default_profile: input.profileName,
    });
    registry = 'registered';
  }

  const gitignore = await ensureGitignore(input.localRoot);
  const missing = credential === 'missing' ? ['credential'] : [];

  return {
    ok: missing.length === 0,
    siteName: input.siteName,
    profileName: input.profileName,
    keychainService,
    configPath,
    config,
    credential,
    registry,
    gitignore,
    missing,
    ...(credential === 'missing' ? { hint: CREDENTIAL_HINT } : {}),
  };
}
