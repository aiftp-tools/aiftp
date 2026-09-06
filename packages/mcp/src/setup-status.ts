import { dirname } from 'node:path';
import { z } from 'zod';
import { CONFIRM_PHRASE_REQUIREMENT_JA, isUsableConfirmPhrase } from './confirm-phrase.js';

export interface SetupCheck {
  readonly id: string;
  readonly status: 'pass' | 'fail';
  readonly message: string;
  readonly hint?: string;
}

export interface SetupStatusReport {
  readonly ok: boolean;
  readonly checks: readonly SetupCheck[];
  /**
   * Always present when the startup report carries a timestamp. Not a check:
   * nothing here is wrong, the operator simply cannot tell from the tool
   * output alone whether the settings they are looking at in the Desktop UI
   * are the ones this process is running on.
   */
  readonly notice?: string;
}

/** The five `.aiftp.toml` fields bootstrap owns and therefore can verify. */
export interface SetupProfileSnapshot {
  readonly host: string;
  readonly user: string;
  readonly protocol: string;
  readonly remote_root: string;
  readonly keychain_service: string;
}

export interface SetupStatusDeps {
  readonly startup: string | undefined;
  readonly confirmPhrase: string | undefined;
  readonly pathExists: (path: string) => Promise<boolean>;
  /**
   * Reads the bootstrap-owned fields out of the profile actually present in
   * `.aiftp.toml` right now, or `undefined` when that profile block does not
   * exist. Resolves the blind spot in `reconcileOwnedFields`
   * (`packages/core/src/bootstrap/index.ts`): a config file with no matching
   * profile is left untouched and reported as `existing`, so without this
   * read every check can pass while the config points somewhere else.
   */
  readonly readProfile: (
    configPath: string,
    profileName: string,
  ) => Promise<SetupProfileSnapshot | undefined>;
  /**
   * Whether the AES-256-GCM backup key is actually in the OS keychain.
   * Measured the same way `siteRegistered` is — a real read, not a field
   * copied out of the startup report — because a key the report claims was
   * created can still be absent (deleted by hand, different keychain, a
   * keychain write that failed after the report was written).
   */
  readonly backupKeyExists: (keychainService: string, profileName: string) => Promise<boolean>;
  /**
   * Whether `siteName` is actually present in the fleet registry, pointing
   * at `projectDir`. Backed by a real registry read (see
   * `packages/mcp/src/index.ts`'s `handleSetupStatus`) so the `registry`
   * check below can fail for real instead of being an unconditional pass.
   */
  readonly siteRegistered: (siteName: string, projectDir: string) => Promise<boolean>;
}

/**
 * Mirrors the *outcome enums* of `BootstrapResult` from `@aiftp-tools/core`
 * (Task 2). Kept as a local, minimal schema rather than importing the real
 * type: `AIFTP_DESKTOP_STARTUP` is untrusted external input (an env var
 * written by a different process — Task 3's `server-entry.ts`), so it must
 * be validated with `safeParse`, never trusted via a type assertion. A value
 * that is valid JSON but the wrong *shape* (missing fields, an unrecognised
 * enum member, a typo) must fail closed here rather than silently reporting
 * "pass".
 */
const configOutcomeSchema = z.enum(['created', 'updated', 'existing']);
const credentialOutcomeSchema = z.enum(['stored', 'already-stored', 'missing']);
const registryOutcomeSchema = z.enum(['registered', 'already-registered', 'renamed']);

const backupKeyOutcomeSchema = z.enum(['created', 'already-present', 'failed']);

/**
 * `profileName` / `keychainService` / `backupKey` are deliberately optional
 * even though the current `BootstrapResult` always supplies them. An
 * installed extension build older than this server writes a report without
 * them (exactly the failure mode hit on 2026-09-05, where a stale build kept
 * running under an unchanged version number). Requiring them would collapse
 * that case into the generic `bootstrap-invalid`, which says nothing about
 * the real problem; optional lets the checks below name it instead.
 */
const bootstrapResultSchema = z.object({
  ok: z.boolean(),
  siteName: z.string(),
  profileName: z.string().optional(),
  keychainService: z.string().optional(),
  configPath: z.string(),
  config: configOutcomeSchema,
  credential: credentialOutcomeSchema,
  registry: registryOutcomeSchema,
  backupKey: backupKeyOutcomeSchema.optional(),
  missing: z.array(z.string()),
  hint: z.string().optional(),
});

const settingsSchema = z.object({
  siteName: z.string().optional(),
  localRoot: z.string().optional(),
  host: z.string().optional(),
  protocol: z.string().optional(),
  username: z.string().optional(),
  remoteRoot: z.string().optional(),
  profileName: z.string().optional(),
});

const startupErrorSchema = z.object({
  message: z.string(),
  hint: z.string(),
});

/**
 * Top level: `bootstrap` and `error` are both optional and either-or-neither
 * is a legitimate shape (not corruption) — Task 3's `DesktopStartupReport`
 * documents both fields as optional. `bootstrap` is accepted as `unknown`
 * here and re-validated against `bootstrapResultSchema` below, so a
 * structurally wrong `bootstrap` object fails at that (more specific) step
 * rather than this one.
 */
const startupShapeSchema = z.object({
  bootstrap: z.unknown().optional(),
  error: startupErrorSchema.optional(),
  startedAt: z.string().optional(),
  settings: settingsSchema.optional(),
});

const SETTINGS = 'Claude Desktop の設定 → 拡張機能 → aiftp';
const RESTART = 'Claude Desktop を再起動してください。';
const REINSTALL =
  'インストール済みの拡張機能が、この MCP サーバーより古い可能性があります。拡張機能をいったん削除してから最新の .mcpb を再インストールしてください。';

const bootstrapMissingCheck: SetupCheck = {
  id: 'bootstrap',
  status: 'fail',
  message: 'bootstrap-missing: the extension has not been configured yet',
  hint: `${SETTINGS} で各項目を入力し、${RESTART}`,
};

const bootstrapInvalidCheck: SetupCheck = {
  id: 'bootstrap',
  status: 'fail',
  message: 'bootstrap-invalid: the startup report has an unexpected shape',
  hint: `${SETTINGS} で各項目を入力し、${RESTART}`,
};

/**
 * Parses the raw env var into `unknown`. Never throws: unset, empty, and
 * syntactically malformed JSON are indistinguishable from "the extension
 * has not run bootstrap yet" as far as an attendee is concerned, so all
 * three collapse to the same `undefined` result and the same top-level
 * "not configured" check.
 */
function parseStartupJson(raw: string | undefined): unknown | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function registryOutcomeMessage(outcome: z.infer<typeof registryOutcomeSchema>): string {
  switch (outcome) {
    case 'registered':
      return 'site registered in the fleet';
    case 'renamed':
      return 'site renamed in the fleet registry';
    default:
      return 'site already registered';
  }
}

function startupNotice(startedAt: string | undefined): string | undefined {
  if (startedAt === undefined) return undefined;
  return `この設定は ${startedAt} に読み込まれたものです。それ以降に${SETTINGS} を変更した場合、変更はまだ反映されていません。${RESTART}`;
}

export async function buildSetupStatus(deps: SetupStatusDeps): Promise<SetupStatusReport> {
  const parsedJson = parseStartupJson(deps.startup);
  if (parsedJson === undefined) {
    return { ok: false, checks: [bootstrapMissingCheck] };
  }

  const topLevel = startupShapeSchema.safeParse(parsedJson);
  if (!topLevel.success) {
    // Valid JSON, but not even the {bootstrap?, error?} envelope shape.
    // Fail closed the same way as an unrecognised bootstrap sub-shape.
    return { ok: false, checks: [bootstrapInvalidCheck] };
  }

  const startup = topLevel.data;

  if (startup.error) {
    return {
      ok: false,
      checks: [
        {
          id: 'bootstrap',
          status: 'fail',
          message: startup.error.message,
          hint: startup.error.hint,
        },
      ],
    };
  }

  if (startup.bootstrap === undefined) {
    return {
      ok: false,
      checks: [
        {
          id: 'bootstrap',
          status: 'fail',
          message: 'bootstrap-missing: startup did not complete',
          hint: `${SETTINGS} で各項目を入力し、${RESTART}`,
        },
      ],
    };
  }

  const bootResult = bootstrapResultSchema.safeParse(startup.bootstrap);
  if (!bootResult.success) {
    // `credential`/`config`/`registry` outside their known enum values,
    // missing required fields, etc. — never falls through to a per-field
    // check that could default to "pass" (finding 1). One fail check,
    // same as the other "can't make sense of this" branches above.
    return { ok: false, checks: [bootstrapInvalidCheck] };
  }

  const boot = bootResult.data;
  const missingSuffix = boot.missing.length > 0 ? ` (missing: ${boot.missing.join(', ')})` : '';

  const checks: SetupCheck[] = [
    boot.ok
      ? { id: 'bootstrap', status: 'pass', message: `site "${boot.siteName}" bootstrapped` }
      : {
          id: 'bootstrap',
          status: 'fail',
          message: `bootstrap-incomplete: site "${boot.siteName}" is not fully configured${missingSuffix}`,
          hint: boot.hint ?? `${SETTINGS} で各項目を入力し、${RESTART}`,
        },
  ];

  // The site folder itself (dirname of the config path, which is always
  // `<localRoot>/.aiftp.toml`). project_dir checks this directory;
  // config_file below checks the file inside it -- two genuinely different
  // things that can each fail independently (e.g. someone deletes
  // `.aiftp.toml` by hand but the folder itself is fine).
  const projectDir = dirname(boot.configPath);

  checks.push(
    (await deps.pathExists(projectDir))
      ? { id: 'project_dir', status: 'pass', message: 'project directory is readable' }
      : {
          id: 'project_dir',
          status: 'fail',
          message: 'bootstrap-incomplete: project directory is not readable',
          hint: `${SETTINGS} で「サイトフォルダ」を選び直し、${RESTART}`,
        },
  );

  const configFileExists = await deps.pathExists(boot.configPath);
  checks.push(
    configFileExists
      ? {
          id: 'config_file',
          status: 'pass',
          message:
            boot.config === 'created' ? '.aiftp.toml created' : '.aiftp.toml already present',
        }
      : {
          id: 'config_file',
          status: 'fail',
          message: 'bootstrap-incomplete: .aiftp.toml is missing',
          hint: `.aiftp.toml が見つかりません。${RESTART}`,
        },
  );

  // The Desktop settings form is authoritative, but bootstrap can only
  // reconcile a profile block that already exists. When it cannot, it reports
  // `existing` and every other check still passes -- so compare the file that
  // is on disk *now* against the settings this process was started with.
  const settings = startup.settings;
  const profileName = boot.profileName ?? settings?.profileName;
  if (!configFileExists) {
    // `config_file` already reported the missing file with the right hint.
    // Repeating it here as "the profile is missing" would give an attendee
    // two failures and two different-sounding causes for one problem.
    checks.push({
      id: 'config_match',
      status: 'fail',
      message: 'config-mismatch: .aiftp.toml is missing, so it cannot match the settings',
      hint: `.aiftp.toml が見つかりません。${RESTART}`,
    });
  } else if (settings === undefined || profileName === undefined) {
    checks.push({
      id: 'config_match',
      status: 'fail',
      message: 'extension-outdated: the startup report carries no settings to compare against',
      hint: REINSTALL,
    });
  } else {
    const profile = await deps.readProfile(boot.configPath, profileName);
    if (profile === undefined) {
      checks.push({
        id: 'config_match',
        status: 'fail',
        message: `config-mismatch: .aiftp.toml has no profile "${profileName}"`,
        hint: `.aiftp.toml に [profile.${profileName}] がないため、${SETTINGS} の設定が反映されていません。.aiftp.toml を削除するか [profile.${profileName}] を追加したうえで、${RESTART}`,
      });
    } else {
      // Only fields the settings form actually supplied are compared: an
      // absent expected value means "nothing to check", never "mismatch".
      // None of these five are credentials, so both values can be shown --
      // an operator cannot fix a mismatch they are not allowed to see.
      const comparisons: ReadonlyArray<readonly [string, string | undefined, string]> = [
        ['host', settings.host, profile.host],
        ['user', settings.username, profile.user],
        ['protocol', settings.protocol, profile.protocol],
        ['remote_root', settings.remoteRoot, profile.remote_root],
        ['keychain_service', boot.keychainService, profile.keychain_service],
      ];
      const mismatches = comparisons
        .filter(([, expected, actual]) => expected !== undefined && expected !== actual)
        .map(
          ([field, expected, actual]) => `${field}: .aiftp.toml="${actual}" / 設定="${expected}"`,
        );
      checks.push(
        mismatches.length === 0
          ? {
              id: 'config_match',
              status: 'pass',
              message: '.aiftp.toml matches the extension settings',
            }
          : {
              id: 'config_match',
              status: 'fail',
              message: `config-mismatch: ${mismatches.join('; ')}`,
              hint: `.aiftp.toml が${SETTINGS} の設定と一致していません。どちらか正しい方に揃えたうえで、${RESTART}`,
            },
      );
    }
  }

  checks.push(
    boot.credential === 'missing'
      ? {
          id: 'credential',
          status: 'fail',
          message: 'bootstrap-incomplete: credential not stored',
          hint: `${SETTINGS} で「パスワード」欄を入力し、${RESTART}`,
        }
      : { id: 'credential', status: 'pass', message: 'credential stored in the OS keychain' },
  );

  // Measured against the keychain, not read out of the startup report: a
  // missing key only shows up at the first production push otherwise, which
  // is the worst possible moment to discover it.
  if (boot.keychainService === undefined || profileName === undefined) {
    checks.push({
      id: 'backup_key',
      status: 'fail',
      message: 'extension-outdated: the startup report does not say where the backup key lives',
      hint: REINSTALL,
    });
  } else {
    checks.push(
      (await deps.backupKeyExists(boot.keychainService, profileName))
        ? { id: 'backup_key', status: 'pass', message: 'backup key stored in the OS keychain' }
        : {
            id: 'backup_key',
            status: 'fail',
            message: 'bootstrap-incomplete: backup key not stored',
            hint: `バックアップ用の暗号鍵が OS キーチェーンにありません。キーチェーンへのアクセスを許可したうえで、${RESTART}`,
          },
    );
  }

  checks.push(
    (await deps.siteRegistered(boot.siteName, projectDir))
      ? {
          id: 'registry',
          status: 'pass',
          message: registryOutcomeMessage(boot.registry),
        }
      : {
          id: 'registry',
          status: 'fail',
          message: 'bootstrap-incomplete: site not found in the fleet registry',
          hint: `サイト台帳に登録が見つかりません。${RESTART}`,
        },
  );

  // v0.13 Codex cross-review, H2: "set" means "set AND strong enough to
  // gate a production push". `isUsableConfirmPhrase` is the same predicate
  // `createAiftpMcp` applies when resolving the phrase, so this check and
  // the push gate can never disagree — a weak phrase is reported absent
  // here exactly as the gate treats it.
  //
  // Both the message and the hint are identical for "unset" and "too weak"
  // on purpose. Saying which one it is would tell a guesser that a phrase
  // exists and is below the published minimum, narrowing the search space;
  // the hint states the requirement instead, which is what the instructor
  // actually needs to fix it.
  const phraseSet = isUsableConfirmPhrase(deps.confirmPhrase);
  checks.push(
    phraseSet
      ? { id: 'confirm_phrase', status: 'pass', message: 'production confirm phrase is set' }
      : {
          id: 'confirm_phrase',
          status: 'fail',
          message: 'bootstrap-incomplete: confirm phrase not set or too weak',
          hint: `${SETTINGS} で「合言葉」欄に FTP のパスワードとは違う文字列を入力し、${RESTART}${CONFIRM_PHRASE_REQUIREMENT_JA}`,
        },
  );

  const notice = startupNotice(startup.startedAt);
  return {
    ok: checks.every((check) => check.status === 'pass'),
    checks,
    ...(notice ? { notice } : {}),
  };
}
