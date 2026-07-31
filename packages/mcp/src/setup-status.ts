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

interface StartupShape {
  bootstrap?: {
    ok: boolean;
    siteName: string;
    configPath: string;
    config: string;
    credential: string;
    registry: string;
  };
  error?: { message: string; hint: string };
}

const SETTINGS = 'Claude Desktop の設定 → 拡張機能 → aiftp';
const RESTART = 'Claude Desktop を再起動してください。';

function parseStartup(raw: string | undefined): StartupShape | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as StartupShape;
  } catch {
    return undefined;
  }
}

export async function buildSetupStatus(deps: SetupStatusDeps): Promise<SetupStatusReport> {
  const startup = parseStartup(deps.startup);

  if (!startup) {
    return {
      ok: false,
      checks: [
        {
          id: 'bootstrap',
          status: 'fail',
          message: 'bootstrap-missing: the extension has not been configured yet',
          hint: `${SETTINGS} で各項目を入力し、${RESTART}`,
        },
      ],
    };
  }

  if (startup.error || !startup.bootstrap) {
    return {
      ok: false,
      checks: [
        {
          id: 'bootstrap',
          status: 'fail',
          message: startup.error?.message ?? 'bootstrap-missing: startup did not complete',
          hint: startup.error?.hint ?? `${SETTINGS} で各項目を入力し、${RESTART}`,
        },
      ],
    };
  }

  const boot = startup.bootstrap;
  const checks: SetupCheck[] = [
    { id: 'bootstrap', status: 'pass', message: `site "${boot.siteName}" bootstrapped` },
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
