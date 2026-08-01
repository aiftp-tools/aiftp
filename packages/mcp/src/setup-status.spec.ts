import { describe, expect, it } from 'vitest';
import { buildSetupStatus } from './setup-status.js';

const phrase = 'sakura-2026';

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
    expect(check?.message).toBe('bootstrap-incomplete: confirm phrase not set');
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
    });
    const bootstrap = report.checks.find((check) => check.id === 'bootstrap');
    expect(report.ok).toBe(false);
    expect(bootstrap?.status).toBe('fail');
    expect(bootstrap?.message).toBe(
      'bootstrap-incomplete: site "gwco" is not fully configured (missing: registry)',
    );
  });

  it('reaches and fails the project_dir check when the config path is not readable', async () => {
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
});
