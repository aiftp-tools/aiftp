/**
 * v0.11 init UX framework — Field definitions for `aiftp init`.
 *
 * Each Field carries the user-visible label plus a v0.11 `hint` and
 * `example` (the "A" leg of 三重防御). Validators here are intentionally
 * lightweight — non-empty checks and bounds only — so the existing
 * v0.10.4 `parseInitAnswers` / `sanitizeFieldInput` pass can still
 * apply trim + control-character rejection downstream without
 * double-processing concerns.
 *
 * 11 fields match the existing InitAnswers interface in index.ts:
 *   profile, host, port, protocol, user, remoteRoot, localRoot,
 *   keychainService, serverKind, password, consent
 */

import { type TemplateConfig, getTemplate, listTemplates } from '@aiftp-tools/core';
import type { PromptField } from './prompt-framework/types.js';

function requireNonEmpty(label: string): (value: unknown) => true | string {
  return (value: unknown): true | string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `${label} is required`;
    }
    return true;
  };
}

function isStandardFtpPort(port: number, protocol: string): boolean {
  if (protocol === 'ftps') return port === 21 || port === 990;
  if (protocol === 'sftp') return port === 22;
  return port === 21;
}

export function buildInitFields(): PromptField[] {
  return buildInitFieldsWithTemplate(true);
}

/**
 * Resolves the localRoot initial value from either an explicit `--template`
 * flag (prefilledTemplate) or the in-flow `template-select` answer. The
 * v0.11 Pillar β review caught a Phase 2-1 regression where the prior code
 * forced `localRoot.initial = '.'` and renderConfig silently overwrote the
 * user's answer with `template.defaults.localRoot` — the screen value and
 * the TOML on disk diverged. Now the field's initial reflects the template
 * default so the user sees, edits, and confirms the final value.
 */
function resolveLocalRootInitial(
  answers: Record<string, unknown>,
  prefilledTemplate: TemplateConfig | undefined,
): string {
  if (prefilledTemplate) {
    return prefilledTemplate.defaults.localRoot ?? '.';
  }
  const selected = answers['template-select'];
  if (typeof selected === 'string' && selected.length > 0 && selected !== 'none') {
    const tpl = getTemplate(selected);
    if (tpl?.defaults.localRoot) {
      return tpl.defaults.localRoot;
    }
  }
  return '.';
}

export function buildInitFieldsWithTemplate(
  skipTemplate: boolean,
  prefilledTemplate?: TemplateConfig,
): PromptField[] {
  const fields: PromptField[] = [
    {
      name: 'profile',
      label: 'Profile name',
      type: 'text',
      hint: '.aiftp.toml の [profile.X] X 部分。ASCII 英数字とハイフン/アンダースコア推奨。',
      example: 'production',
      initial: 'production',
      validate: requireNonEmpty('Profile name'),
    },
    {
      name: 'host',
      label: 'FTP host',
      type: 'text',
      hint: 'サーバから渡されたホスト名（IP でも可）。',
      example: 'ftp.lolipop.jp',
      validate: requireNonEmpty('FTP host'),
    },
    {
      name: 'port',
      label: 'FTP port',
      type: 'number',
      hint: '標準: 21 (FTP), 990 (FTPS implicit), 22 (SFTP)。標準外なら確認画面が出ます。',
      example: '21',
      initial: 21,
      min: 1,
      max: 65535,
      validate: (value) => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
          return 'FTP port must be an integer (e.g. 21 for FTP, 990 for FTPS implicit)';
        }
        if (value < 1 || value > 65535) {
          return 'FTP port must be between 1 and 65535';
        }
        return true;
      },
    },
    {
      name: 'protocol',
      label: 'Protocol',
      type: 'select',
      hint: 'FTPS (TLS) 推奨。FTP は平文。SFTP は v0.11+ で対応予定。',
      initial: 'ftps',
      choices: [
        { title: 'FTPS', value: 'ftps' },
        { title: 'FTP', value: 'ftp' },
      ],
    },
    {
      name: 'user',
      label: 'FTP user',
      type: 'text',
      hint: 'サーバから渡された FTP ユーザー名。',
      example: 'deploy@example.com',
      validate: requireNonEmpty('FTP user'),
    },
    {
      name: 'remoteRoot',
      label: 'Remote root',
      type: 'text',
      hint: 'デプロイ先のサーバー側ルートディレクトリ。共有サーバーは public_html 配下が一般的。',
      example: '/public_html',
      initial: '/public_html',
      validate: requireNonEmpty('Remote root'),
    },
    {
      name: 'localRoot',
      label: 'Local root',
      type: 'text',
      hint: 'デプロイ元のローカルディレクトリ（プロジェクト直下からの相対 or 絶対）。テンプレ選択時はそのデフォルト値を初期値に。',
      example: '.',
      initial: (answers: Record<string, unknown>) =>
        resolveLocalRootInitial(answers, prefilledTemplate),
      validate: requireNonEmpty('Local root'),
    },
    {
      name: 'keychainService',
      label: 'Keychain service',
      type: 'text',
      hint: 'OS Keychain での識別子。プロファイル名から自動生成されます。',
      example: 'aiftp:production',
      initial: (answers: Record<string, unknown>) => {
        const profile =
          typeof answers.profile === 'string' && answers.profile.length > 0
            ? answers.profile
            : 'production';
        return `aiftp:${profile}`;
      },
      validate: requireNonEmpty('Keychain service'),
    },
    {
      name: 'serverKind',
      label: 'Server kind',
      type: 'select',
      hint: '日本のレンタルサーバー別に quirks (TLS hostname / PASV / MLSD 等) を自動設定します。',
      choices: [
        { title: 'StarServer', value: 'starserver' },
        { title: 'Lolipop', value: 'lolipop' },
        { title: 'Sakura', value: 'sakura' },
        { title: 'Xserver', value: 'xserver' },
        { title: 'Generic', value: 'generic' },
      ],
    },
    {
      name: 'password',
      label: 'FTP password',
      type: 'password',
      hint: 'OS Keychain (macOS Keychain / Windows Credential Manager) に保存されます。',
      validate: requireNonEmpty('FTP password'),
    },
    {
      name: 'consent',
      label: 'Store encrypted backups locally?',
      type: 'confirm',
      hint: '"y" を選ぶと .aiftp/backup/ に暗号化バックアップを取得します（push 前に自動）。',
    },
  ];

  if (skipTemplate) {
    return fields;
  }

  return [
    {
      name: 'template-select',
      label: 'Template',
      type: 'select',
      hint: 'サイト種別に合わせて .aiftp.toml の hard-exclude / safety / preflight 既定値を追加します。',
      initial: 'none',
      choices: [
        ...listTemplates().map((template) => ({
          title: template.id,
          value: template.id,
          description: template.description,
        })),
        { title: 'none', value: 'none', description: 'Blank init (advanced)' },
      ],
    },
    ...fields,
  ];
}

export { isStandardFtpPort };
