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
});
