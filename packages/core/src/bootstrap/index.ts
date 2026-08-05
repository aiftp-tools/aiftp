import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { appendProfileBlock, findProfileBlockRange, setProfileField } from '../config-edit.js';
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

/**
 * The Desktop settings form is authoritative: reconcile only the 5 fields
 * bootstrap owns (host/user/protocol/remote_root/keychain_service) into an
 * existing `.aiftp.toml`, leaving every other section (e.g. a user-added
 * `[safety]` block, or a config whose only profile has a different name)
 * completely untouched. Returns the reconciled source; the caller compares
 * it against `current` to decide whether a write actually happened.
 */
function reconcileOwnedFields(
  current: string,
  profileName: string,
  keychainService: string,
  input: BootstrapInput,
): string {
  if (!findProfileBlockRange(current, profileName)) {
    return current;
  }
  const owned: ReadonlyArray<readonly [string, string]> = [
    ['host', input.host],
    ['user', input.username],
    ['protocol', input.protocol],
    ['remote_root', input.remoteRoot],
    ['keychain_service', keychainService],
  ];
  let next = current;
  for (const [field, value] of owned) {
    next = setProfileField(next, profileName, field, JSON.stringify(value));
  }
  return next;
}

export async function runBootstrap(
  rawInput: Partial<BootstrapInput>,
  deps: BootstrapDeps = {},
): Promise<BootstrapResult> {
  // 1. validate
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

  // 2. local_root existence check
  if (!(await pathExists(input.localRoot))) {
    throw new BootstrapValidationError(
      `bootstrap-invalid: local_root does not exist: ${input.localRoot}`,
      'Claude Desktop の設定 → 拡張機能 → aiftp で「サイトフォルダ」を存在するフォルダに選び直し、Claude Desktop を再起動してください。',
    );
  }

  const keychainService = buildKeychainService(input.siteName, input.profileName);
  const configPath = join(input.localRoot, '.aiftp.toml');

  // 3. fleet registry lookup — a pure read, so any conflict can safely throw
  //    before any side effect (.aiftp.toml write, keychain write) happens.
  //
  //    Two independent lookups, both on resolved paths:
  //      - by name: the pre-existing genuine-conflict check (same name,
  //        different folder — refuse, unchanged behaviour).
  //      - by resolved path: the Desktop settings form is authoritative for
  //        the site name, the same way it already is for
  //        host/protocol/user/remote_root/keychain_service (see
  //        reconcileOwnedFields above). Renaming the site in the settings
  //        UI is the single most likely edit, and without this lookup it
  //        would silently create a second registry entry pointing at the
  //        same folder (add() only rejects duplicate *names*, never
  //        duplicate *paths*), leaving the stale name as the one
  //        `aiftp_push_prepare`'s `expected_site` resolution picks up.
  const registrySurface = createRegistry();
  const entries = await registrySurface.list();
  const nameMatch = entries.find((entry) => entry.name === input.siteName);
  if (nameMatch && resolvePath(nameMatch.path) !== resolvePath(input.localRoot)) {
    throw new BootstrapValidationError(
      `bootstrap-conflict: site "${input.siteName}" is already registered for a different folder (${nameMatch.path})`,
      'Claude Desktop の設定 → 拡張機能 → aiftp で「サイト名」を別の名前に変えるか、「サイトフォルダ」を登録済みのフォルダに合わせてください。',
    );
  }
  const pathMatch = nameMatch
    ? undefined
    : entries.find((entry) => resolvePath(entry.path) === resolvePath(input.localRoot));

  // 4. .aiftp.toml — create it, or reconcile the bootstrap-owned fields in
  //    place. Never overwrite a config whose matching profile does not
  //    exist (a trainee or the CLI may own that file).
  let config: ConfigOutcome;
  if (await pathExists(configPath)) {
    const current = await readTextFile(configPath);
    const next = reconcileOwnedFields(current, input.profileName, keychainService, input);
    if (next === current) {
      config = 'existing';
    } else {
      await writeTextFile(configPath, next);
      config = 'updated';
    }
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

  // 5. credential — the Desktop settings form is authoritative: a corrected
  //    or rotated password must be able to reach the keychain. Re-storing
  //    the same value on every launch is harmless. Whitespace-only input is
  //    treated as "not supplied" (a stray space is not a real password).
  let credential: CredentialOutcome;
  if (input.credential !== undefined && input.credential.trim().length > 0) {
    await storeCredential(keychainService, input.username, input.credential);
    credential = 'stored';
  } else if (await credentialExists(keychainService, input.username)) {
    credential = 'already-stored';
  } else {
    credential = 'missing';
  }

  // 6. fleet registry registration. Three outcomes, matching step 3's lookup:
  //    - nameMatch: this exact name is already registered for this exact
  //      folder (step 3 already refused any other case) — nothing to do.
  //    - pathMatch: a different name already points at this exact folder —
  //      rename that entry rather than adding a duplicate.
  //    - neither: genuinely new — add it.
  let registry: RegistryOutcome;
  if (nameMatch) {
    registry = 'already-registered';
  } else if (pathMatch) {
    await registrySurface.rename(pathMatch.name, input.siteName);
    registry = 'renamed';
  } else {
    await registrySurface.add({
      name: input.siteName,
      path: input.localRoot,
      default_profile: input.profileName,
    });
    registry = 'registered';
  }

  // 7. .gitignore
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
