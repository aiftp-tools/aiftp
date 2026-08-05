import { describe, expect, it } from 'vitest';
import { buildSetupStatus } from './setup-status.js';

/** A throwaway fixture that clears the strength floor. */
const phrase = 'spec-fixture-phrase-7Q2';
/** 11 code points: below CONFIRM_PHRASE_MIN_LENGTH, so treated as unset. */
const weakPhrase = 'sakura-2026';

const bootstrapOk = {
  ok: true,
  siteName: 'gwco',
  profileName: 'production',
  keychainService: 'aiftp:gwco-production',
  configPath: '/abs/site/.aiftp.toml',
  config: 'created',
  credential: 'stored',
  registry: 'registered',
  missing: [] as string[],
};

const happy = {
  startup: JSON.stringify({ bootstrap: bootstrapOk }),
  confirmPhrase: phrase,
  pathExists: async () => true,
  siteRegistered: async () => true,
};

describe('buildSetupStatus', () => {
  it('reports every check as pass in the happy path', async () => {
    const report = await buildSetupStatus(happy);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      'bootstrap',
      'project_dir',
      'config_file',
      'credential',
      'registry',
      'confirm_phrase',
    ]);
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
  });

  it('fails the credential check with a Japanese hint when it is not stored', async () => {
    const report = await buildSetupStatus({
      ...happy,
      startup: JSON.stringify({
        bootstrap: { ...bootstrapOk, ok: false, credential: 'missing', missing: ['credential'] },
      }),
    });
    const check = report.checks.find((entry) => entry.id === 'credential');
    expect(report.ok).toBe(false);
    expect(check?.status).toBe('fail');
    expect(check?.message).toBe('bootstrap-incomplete: credential not stored');
    expect(check?.hint).toBe(
      'Claude Desktop の設定 → 拡張機能 → aiftp で「パスワード」欄を入力し、Claude Desktop を再起動してください。',
    );
  });

  it('fails the confirm_phrase check when the phrase is unset', async () => {
    const report = await buildSetupStatus({ ...happy, confirmPhrase: undefined });
    const check = report.checks.find((entry) => entry.id === 'confirm_phrase');
    expect(report.ok).toBe(false);
    expect(check?.status).toBe('fail');
    expect(check?.message).toBe('bootstrap-incomplete: confirm phrase not set or too weak');
    expect(check?.hint).toBe(
      'Claude Desktop の設定 → 拡張機能 → aiftp で「合言葉」欄に FTP のパスワードとは違う文字列を入力し、Claude Desktop を再起動してください。合言葉は 12 文字以上・4 種類以上の文字が必要です。未設定の場合と短すぎる場合は同じ扱いで、本番反映は拒否されます。パスワード管理ツールで生成した20文字以上の文字列を推奨します（講座名や西暦のような推測しやすい文字列は避けてください）。',
    );
  });

  it('reports a too-weak phrase exactly like an unset one (v0.13 H2)', async () => {
    // The gate in index.ts drops a weak phrase, so setup_status must not
    // report it as present -- that disagreement (present here, absent at
    // the gate) was already a finding earlier on this branch.
    const weak = await buildSetupStatus({ ...happy, confirmPhrase: weakPhrase });
    const unset = await buildSetupStatus({ ...happy, confirmPhrase: undefined });
    const weakCheck = weak.checks.find((entry) => entry.id === 'confirm_phrase');
    const unsetCheck = unset.checks.find((entry) => entry.id === 'confirm_phrase');

    expect(weak.ok).toBe(false);
    expect(weakCheck?.status).toBe('fail');
    // Byte-identical to the unset case: the report must not reveal that a
    // phrase exists but is short, which would narrow it for a guesser.
    expect(weakCheck).toEqual(unsetCheck);
  });

  it('leaks neither the phrase nor its length on any confirm_phrase path', async () => {
    for (const value of [weakPhrase, phrase, undefined, '   ']) {
      const report = await buildSetupStatus({ ...happy, confirmPhrase: value });
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('sakura');
      expect(serialized).not.toContain('spec-fixture');
      // No "your phrase is N characters" anywhere: the only numbers in the
      // hint are the published rule (12 and 4), never a measured length.
      expect(serialized).not.toContain('11');
      expect(serialized).not.toContain('23');
    }
  });

  it('passes the confirm_phrase check for a long multi-word passphrase', async () => {
    const report = await buildSetupStatus({
      ...happy,
      confirmPhrase: 'correct battery staple horse fence',
    });
    const check = report.checks.find((entry) => entry.id === 'confirm_phrase');
    expect(check?.status).toBe('pass');
    expect(report.ok).toBe(true);
  });

  it('keeps the six frozen check ids', async () => {
    const report = await buildSetupStatus({ ...happy, confirmPhrase: weakPhrase });
    expect(report.checks.map((entry) => entry.id)).toEqual([
      'bootstrap',
      'project_dir',
      'config_file',
      'credential',
      'registry',
      'confirm_phrase',
    ]);
  });

  it('surfaces a startup error as the bootstrap check failure', async () => {
    const report = await buildSetupStatus({
      startup: JSON.stringify({
        error: {
          message: 'bootstrap-invalid: local_root must be an absolute path',
          hint: 'Claude Desktop の設定 → 拡張機能 → aiftp で「サイトフォルダ」をフォルダ選択ボタンから選び直し、Claude Desktop を再起動してください。',
        },
      }),
      confirmPhrase: phrase,
      pathExists: async () => false,
      siteRegistered: async () => true,
    });
    const bootstrap = report.checks.find((check) => check.id === 'bootstrap');
    expect(bootstrap?.status).toBe('fail');
    expect(bootstrap?.message).toBe('bootstrap-invalid: local_root must be an absolute path');
    expect(report.ok).toBe(false);
  });

  it('reports the extension as not configured when the startup report is absent', async () => {
    const report = await buildSetupStatus({
      startup: undefined,
      confirmPhrase: undefined,
      pathExists: async () => false,
      siteRegistered: async () => true,
    });
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toBe(
      'bootstrap-missing: the extension has not been configured yet',
    );
  });

  it('never leaks the confirm phrase into the report', async () => {
    const report = await buildSetupStatus(happy);
    expect(JSON.stringify(report)).not.toContain(phrase);
  });

  it('treats an empty startup string as not configured', async () => {
    const report = await buildSetupStatus({
      startup: '',
      confirmPhrase: undefined,
      pathExists: async () => false,
      siteRegistered: async () => true,
    });
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([
      {
        id: 'bootstrap',
        status: 'fail',
        message: 'bootstrap-missing: the extension has not been configured yet',
        hint: 'Claude Desktop の設定 → 拡張機能 → aiftp で各項目を入力し、Claude Desktop を再起動してください。',
      },
    ]);
  });

  it('treats syntactically malformed JSON as not configured, never throwing', async () => {
    await expect(
      buildSetupStatus({
        startup: '{not valid json',
        confirmPhrase: undefined,
        pathExists: async () => false,
        siteRegistered: async () => true,
      }),
    ).resolves.toEqual({
      ok: false,
      checks: [
        {
          id: 'bootstrap',
          status: 'fail',
          message: 'bootstrap-missing: the extension has not been configured yet',
          hint: 'Claude Desktop の設定 → 拡張機能 → aiftp で各項目を入力し、Claude Desktop を再起動してください。',
        },
      ],
    });
  });

  it('fails closed on a structurally wrong bootstrap object instead of silently passing', async () => {
    const report = await buildSetupStatus({
      startup: JSON.stringify({ bootstrap: {} }),
      confirmPhrase: phrase,
      pathExists: async () => true,
      siteRegistered: async () => true,
    });
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([
      {
        id: 'bootstrap',
        status: 'fail',
        message: 'bootstrap-invalid: the startup report has an unexpected shape',
        hint: 'Claude Desktop の設定 → 拡張機能 → aiftp で各項目を入力し、Claude Desktop を再起動してください。',
      },
    ]);
  });

  it('fails closed when credential is an unrecognised enum value instead of reporting pass', async () => {
    const report = await buildSetupStatus({
      startup: JSON.stringify({
        bootstrap: { ...bootstrapOk, credential: 'not-a-real-outcome' },
      }),
      confirmPhrase: phrase,
      pathExists: async () => true,
      siteRegistered: async () => true,
    });
    expect(report.ok).toBe(false);
    // Exactly one check — the malformed bootstrap short-circuits before any
    // individual check (including credential) could be derived and marked
    // "pass" from an unrecognised value.
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ id: 'bootstrap', status: 'fail' });
    expect(JSON.stringify(report)).not.toContain('not-a-real-outcome');
  });

  it('reports the bootstrap check as fail and lists what is missing when boot.ok is false', async () => {
    const report = await buildSetupStatus({
      startup: JSON.stringify({
        bootstrap: { ...bootstrapOk, ok: false, missing: ['registry'] },
      }),
      confirmPhrase: phrase,
      pathExists: async () => true,
      siteRegistered: async () => true,
    });
    const bootstrap = report.checks.find((check) => check.id === 'bootstrap');
    expect(report.ok).toBe(false);
    expect(bootstrap?.status).toBe('fail');
    expect(bootstrap?.message).toBe(
      'bootstrap-incomplete: site "gwco" is not fully configured (missing: registry)',
    );
  });

  it('reaches and fails the project_dir check when the site folder is not readable', async () => {
    const report = await buildSetupStatus({
      ...happy,
      pathExists: async () => false,
    });
    const projectDir = report.checks.find((check) => check.id === 'project_dir');
    expect(report.ok).toBe(false);
    expect(projectDir?.status).toBe('fail');
    expect(projectDir?.message).toBe('bootstrap-incomplete: project directory is not readable');
    expect(projectDir?.hint).toBe(
      'Claude Desktop の設定 → 拡張機能 → aiftp で「サイトフォルダ」を選び直し、Claude Desktop を再起動してください。',
    );
  });

  it('passes project_dir but fails config_file when only .aiftp.toml is missing', async () => {
    // The site folder itself exists (pathExists true for the directory) but
    // the config file inside it does not (pathExists false for the exact
    // configPath) -- e.g. a trainee deletes .aiftp.toml by hand. These two
    // checks must be able to fail independently of each other.
    const report = await buildSetupStatus({
      ...happy,
      pathExists: async (path: string) => path !== bootstrapOk.configPath,
    });
    const projectDir = report.checks.find((check) => check.id === 'project_dir');
    const configFile = report.checks.find((check) => check.id === 'config_file');
    expect(report.ok).toBe(false);
    expect(projectDir?.status).toBe('pass');
    expect(configFile?.status).toBe('fail');
    expect(configFile?.message).toBe('bootstrap-incomplete: .aiftp.toml is missing');
  });

  it('fails the registry check when the site is not actually in the fleet registry', async () => {
    const report = await buildSetupStatus({
      ...happy,
      siteRegistered: async () => false,
    });
    const registry = report.checks.find((check) => check.id === 'registry');
    expect(report.ok).toBe(false);
    expect(registry?.status).toBe('fail');
    expect(registry?.message).toBe('bootstrap-incomplete: site not found in the fleet registry');
  });

  it('passes the registry check only when siteRegistered resolves true for this site/folder', async () => {
    let receivedArgs: readonly [string, string] | undefined;
    const report = await buildSetupStatus({
      ...happy,
      siteRegistered: async (siteName: string, projectDir: string) => {
        receivedArgs = [siteName, projectDir];
        return true;
      },
    });
    const registry = report.checks.find((check) => check.id === 'registry');
    expect(registry?.status).toBe('pass');
    expect(receivedArgs).toEqual(['gwco', '/abs/site']);
  });
});
