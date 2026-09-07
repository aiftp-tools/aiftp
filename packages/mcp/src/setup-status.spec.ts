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
  backupKey: 'created',
  missing: [] as string[],
};

/** The Desktop settings form values behind `bootstrapOk`. */
const settingsOk = {
  siteName: 'gwco',
  localRoot: '/abs/site',
  host: 'ftp.example.test',
  protocol: 'ftps',
  username: 'deployer',
  remoteRoot: '/public_html',
  profileName: 'production',
};

/** The `.aiftp.toml` profile that matches `settingsOk` exactly. */
const profileOk = {
  host: 'ftp.example.test',
  user: 'deployer',
  protocol: 'ftps',
  remote_root: '/public_html',
  keychain_service: 'aiftp:gwco-production',
};

const happy = {
  startup: JSON.stringify({
    bootstrap: bootstrapOk,
    settings: settingsOk,
    startedAt: '2026-09-06T00:00:00.000Z',
  }),
  confirmPhrase: phrase,
  pathExists: async () => true,
  siteRegistered: async () => true,
  backupKeyStatus: async () => 'ok' as const,
  readProfile: async () => ({ kind: 'ok' as const, profile: profileOk }),
};

describe('buildSetupStatus', () => {
  it('reports every check as pass in the happy path', async () => {
    const report = await buildSetupStatus(happy);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      'bootstrap',
      'project_dir',
      'config_file',
      'config_match',
      'credential',
      'backup_key',
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

  it('keeps the eight frozen check ids', async () => {
    const report = await buildSetupStatus({ ...happy, confirmPhrase: weakPhrase });
    expect(report.checks.map((entry) => entry.id)).toEqual([
      'bootstrap',
      'project_dir',
      'config_file',
      'config_match',
      'credential',
      'backup_key',
      'registry',
      'confirm_phrase',
    ]);
  });

  it('passes config_match when .aiftp.toml agrees with the extension settings', async () => {
    const report = await buildSetupStatus(happy);
    const check = report.checks.find((entry) => entry.id === 'config_match');
    expect(check?.status).toBe('pass');
  });

  it('fails config_match and names every field that disagrees', async () => {
    const report = await buildSetupStatus({
      ...happy,
      readProfile: async () => ({
        kind: 'ok' as const,
        profile: { ...profileOk, host: 'stale.example.test', remote_root: '/old_html' },
      }),
    });
    const check = report.checks.find((entry) => entry.id === 'config_match');

    expect(report.ok).toBe(false);
    expect(check?.status).toBe('fail');
    // `host` is named but its values stay off the wire (redaction contract);
    // `remote_root` is deploy metadata, so both values are shown.
    expect(check?.message).toContain('host');
    expect(check?.message).not.toContain('stale.example.test');
    expect(check?.message).not.toContain('ftp.example.test');
    expect(check?.message).toContain('remote_root');
    expect(check?.message).toContain('/old_html');
    expect(check?.message).not.toContain('user');
  });

  it('fails config_match when .aiftp.toml has no matching profile block', async () => {
    // The exact case reconcileOwnedFields silently skips: bootstrap reports
    // `existing` and every other check passes while the config is wrong.
    const report = await buildSetupStatus({
      ...happy,
      startup: JSON.stringify({
        bootstrap: { ...bootstrapOk, config: 'existing' },
        settings: settingsOk,
      }),
      readProfile: async () => ({ kind: 'no-profile' as const }),
    });
    const check = report.checks.find((entry) => entry.id === 'config_match');

    expect(report.ok).toBe(false);
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('production');
  });

  it('does not blame the profile when .aiftp.toml itself is missing', async () => {
    const report = await buildSetupStatus({
      ...happy,
      pathExists: async (path: string) => !path.endsWith('.aiftp.toml'),
    });
    const configFile = report.checks.find((entry) => entry.id === 'config_file');
    const configMatch = report.checks.find((entry) => entry.id === 'config_match');

    expect(configFile?.status).toBe('fail');
    expect(configMatch?.status).toBe('fail');
    expect(configMatch?.message).toContain('.aiftp.toml is missing');
    expect(configMatch?.message).not.toContain('no profile');
  });

  it('tells the operator the installed extension is outdated when settings are absent', async () => {
    const report = await buildSetupStatus({
      ...happy,
      startup: JSON.stringify({ bootstrap: bootstrapOk }),
    });
    const check = report.checks.find((entry) => entry.id === 'config_match');

    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('extension-outdated');
    expect(check?.hint).toContain('再インストール');
  });

  it('fails backup_key when no key is stored in the keychain', async () => {
    const report = await buildSetupStatus({ ...happy, backupKeyStatus: async () => 'missing' });
    const check = report.checks.find((entry) => entry.id === 'backup_key');

    expect(report.ok).toBe(false);
    expect(check?.status).toBe('fail');
    expect(check?.hint).toContain('再起動');
  });

  it('measures the backup key itself rather than trusting the startup report', async () => {
    const calls: Array<[string, string]> = [];
    const report = await buildSetupStatus({
      ...happy,
      // The report claims the key was created; the keychain says otherwise.
      backupKeyStatus: async (service: string, account: string) => {
        calls.push([service, account]);
        return 'missing' as const;
      },
    });

    expect(calls).toEqual([['aiftp:gwco-production', 'production']]);
    expect(report.checks.find((entry) => entry.id === 'backup_key')?.status).toBe('fail');
  });

  it('carries the startup time forward as an advisory notice', async () => {
    const report = await buildSetupStatus(happy);
    expect(report.notice).toContain('2026-09-06T00:00:00.000Z');
    expect(report.notice).toContain('再起動');
  });

  it('never leaks the confirm phrase through the new checks', async () => {
    const report = await buildSetupStatus({
      ...happy,
      backupKeyStatus: async () => 'missing' as const,
      readProfile: async () => ({
        kind: 'ok' as const,
        profile: { ...profileOk, host: 'stale.example.test' },
      }),
    });
    expect(JSON.stringify(report)).not.toContain(phrase);
  });

  // --- Codex 独立レビュー HIGH-1: redaction 契約 ---

  it('never puts host / user / keychain_service values in a config_match failure', async () => {
    const report = await buildSetupStatus({
      ...happy,
      readProfile: async () => ({
        kind: 'ok' as const,
        profile: {
          ...profileOk,
          host: 'leaked.example.test',
          user: 'leaked-account',
          keychain_service: 'aiftp:leaked-production',
        },
      }),
    });
    const serialized = JSON.stringify(report);

    // The v0.12 redaction contract forbids host / user / keychain_service on
    // the wire. Both sides of the comparison must stay off it -- the expected
    // value is just as much a credential as the actual one.
    for (const secret of [
      'leaked.example.test',
      'leaked-account',
      'aiftp:leaked-production',
      'ftp.example.test',
      'deployer',
      'aiftp:gwco-production',
    ]) {
      expect(serialized, `"${secret}" must not appear in the report`).not.toContain(secret);
    }
    // The operator still learns which fields are wrong.
    const check = report.checks.find((entry) => entry.id === 'config_match');
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('host');
    expect(check?.message).toContain('user');
    expect(check?.message).toContain('keychain_service');
  });

  it('still shows both values for protocol and remote_root (deploy metadata, not credentials)', async () => {
    const report = await buildSetupStatus({
      ...happy,
      readProfile: async () => ({
        kind: 'ok' as const,
        profile: { ...profileOk, remote_root: '/old_html', protocol: 'ftp' },
      }),
    });
    const check = report.checks.find((entry) => entry.id === 'config_match');

    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('/old_html');
    expect(check?.message).toContain('/public_html');
    expect(check?.message).toContain('ftp');
  });

  // --- Codex 独立レビュー HIGH-2: fail-open ---

  it('fails closed when the settings snapshot is present but incomplete', async () => {
    // Reproduces the reported fail-open: a partial `settings` used to make
    // every comparison skip, so a completely wrong .aiftp.toml reported pass.
    const report = await buildSetupStatus({
      ...happy,
      startup: JSON.stringify({
        bootstrap: bootstrapOk,
        settings: { profileName: 'production', localRoot: '/abs/site' },
      }),
      readProfile: async () => ({
        kind: 'ok' as const,
        profile: {
          host: 'wrong.example.test',
          user: 'wrong-user',
          protocol: 'ftp',
          remote_root: '/wrong',
          keychain_service: 'aiftp:gwco-production',
        },
      }),
    });
    const check = report.checks.find((entry) => entry.id === 'config_match');

    expect(report.ok).toBe(false);
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('extension-outdated');
  });

  it('fails when the report disagrees with itself about the profile name', async () => {
    const report = await buildSetupStatus({
      ...happy,
      startup: JSON.stringify({
        bootstrap: bootstrapOk,
        settings: { ...settingsOk, profileName: 'staging' },
      }),
    });
    const check = report.checks.find((entry) => entry.id === 'config_match');

    expect(report.ok).toBe(false);
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('report-inconsistent');
  });

  it('fails when the config path does not sit inside the configured site folder', async () => {
    const report = await buildSetupStatus({
      ...happy,
      startup: JSON.stringify({
        bootstrap: bootstrapOk,
        settings: { ...settingsOk, localRoot: '/somewhere/else' },
      }),
    });
    const check = report.checks.find((entry) => entry.id === 'config_match');

    expect(report.ok).toBe(false);
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('report-inconsistent');
  });

  // --- Codex 独立レビュー MEDIUM-3: 鍵の実質検証 ---

  it('fails backup_key when the stored key is not valid 32-byte material', async () => {
    const report = await buildSetupStatus({ ...happy, backupKeyStatus: async () => 'invalid' });
    const check = report.checks.find((entry) => entry.id === 'backup_key');

    expect(report.ok).toBe(false);
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('backup-key-invalid');
    // Recovery must warn that re-creating the key abandons old snapshots.
    expect(check?.hint).toContain('復元できなくなります');
  });

  it('distinguishes an unreadable keychain from a missing key', async () => {
    const report = await buildSetupStatus({ ...happy, backupKeyStatus: async () => 'unreadable' });
    const check = report.checks.find((entry) => entry.id === 'backup_key');

    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('backup-key-unreadable');
    expect(check?.message).not.toContain('not stored');
  });

  // --- Codex 独立レビュー LOW: missing / unreadable / invalid の分離 ---

  it('never tells the operator to delete .aiftp.toml when it cannot be parsed', async () => {
    const report = await buildSetupStatus({
      ...happy,
      readProfile: async () => ({ kind: 'invalid' as const }),
    });
    const check = report.checks.find((entry) => entry.id === 'config_match');

    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('config-invalid');
    expect(check?.hint).not.toContain('削除');
  });

  it('reports an unreadable config separately from a missing profile', async () => {
    const report = await buildSetupStatus({
      ...happy,
      readProfile: async () => ({ kind: 'unreadable' as const }),
    });
    const check = report.checks.find((entry) => entry.id === 'config_match');

    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('config-unreadable');
    expect(check?.hint).not.toContain('削除');
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
      ...happy,
      startup: JSON.stringify({
        bootstrap: { ...bootstrapOk, ok: false, missing: ['registry'] },
        settings: settingsOk,
      }),
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
