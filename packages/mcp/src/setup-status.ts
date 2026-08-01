import { z } from 'zod';

export interface SetupCheck {
  readonly id: string;
  readonly status: 'pass' | 'fail';
  readonly message: string;
  readonly hint?: string;
}

export interface SetupStatusReport {
  readonly ok: boolean;
  readonly checks: readonly SetupCheck[];
}

export interface SetupStatusDeps {
  readonly startup: string | undefined;
  readonly confirmPhrase: string | undefined;
  readonly pathExists: (path: string) => Promise<boolean>;
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
const registryOutcomeSchema = z.enum(['registered', 'already-registered']);

const bootstrapResultSchema = z.object({
  ok: z.boolean(),
  siteName: z.string(),
  configPath: z.string(),
  config: configOutcomeSchema,
  credential: credentialOutcomeSchema,
  registry: registryOutcomeSchema,
  missing: z.array(z.string()),
  hint: z.string().optional(),
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
});

const SETTINGS = 'Claude Desktop の設定 → 拡張機能 → aiftp';
const RESTART = 'Claude Desktop を再起動してください。';

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

  checks.push(
    (await deps.pathExists(boot.configPath))
      ? { id: 'project_dir', status: 'pass', message: 'project directory is readable' }
      : {
          id: 'project_dir',
          status: 'fail',
          message: 'bootstrap-incomplete: project directory is not readable',
          hint: `${SETTINGS} で「サイトフォルダ」を選び直し、${RESTART}`,
        },
  );

  checks.push({
    id: 'config_file',
    status: 'pass',
    message: boot.config === 'created' ? '.aiftp.toml created' : '.aiftp.toml already present',
  });

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

  checks.push({
    id: 'registry',
    status: 'pass',
    message:
      boot.registry === 'registered' ? 'site registered in the fleet' : 'site already registered',
  });

  const phraseSet = typeof deps.confirmPhrase === 'string' && deps.confirmPhrase.trim().length > 0;
  checks.push(
    phraseSet
      ? { id: 'confirm_phrase', status: 'pass', message: 'production confirm phrase is set' }
      : {
          id: 'confirm_phrase',
          status: 'fail',
          message: 'bootstrap-incomplete: confirm phrase not set',
          hint: `${SETTINGS} で「合言葉」欄に FTP のパスワードとは違う文字列を入力し、${RESTART}`,
        },
  );

  return { ok: checks.every((check) => check.status === 'pass'), checks };
}
