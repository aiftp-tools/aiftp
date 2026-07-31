import { isAbsolute } from 'node:path';
import { isValidProfileName } from '../config-edit.js';
import type { SiteProtocol } from '../sites/types.js';
import { type BootstrapInput, BootstrapValidationError } from './types.js';

const SITE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;
const PROTOCOLS: readonly SiteProtocol[] = ['ftps', 'sftp', 'ftp'];
const DEFAULT_PROFILE = 'production';

function settingsHint(field: string): string {
  return `Claude Desktop の設定 → 拡張機能 → aiftp で「${field}」欄を修正し、Claude Desktop を再起動してください。`;
}

function requireText(value: unknown, name: string, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) {
    throw new BootstrapValidationError(
      `bootstrap-invalid: ${name} must not be empty`,
      settingsHint(field),
    );
  }
  return text;
}

export function validateBootstrapInput(raw: Partial<BootstrapInput>): BootstrapInput {
  const siteName = requireText(raw.siteName, 'site_name', 'サイト名');
  if (!SITE_NAME_PATTERN.test(siteName) || siteName === '.' || siteName === '..') {
    throw new BootstrapValidationError(
      'bootstrap-invalid: site_name must contain only letters, digits, dot, underscore, or hyphen',
      settingsHint('サイト名'),
    );
  }

  const localRoot = requireText(raw.localRoot, 'local_root', 'サイトフォルダ');
  if (!isAbsolute(localRoot)) {
    throw new BootstrapValidationError(
      'bootstrap-invalid: local_root must be an absolute path',
      'Claude Desktop の設定 → 拡張機能 → aiftp で「サイトフォルダ」をフォルダ選択ボタンから選び直し、Claude Desktop を再起動してください。',
    );
  }

  const protocolRaw = raw.protocol === undefined ? 'ftps' : String(raw.protocol).trim();
  if (!PROTOCOLS.includes(protocolRaw as SiteProtocol)) {
    throw new BootstrapValidationError(
      `bootstrap-invalid: protocol must be one of ftps, sftp, ftp (got ${JSON.stringify(protocolRaw)})`,
      'Claude Desktop の設定 → 拡張機能 → aiftp で「プロトコル」欄に ftps / sftp / ftp のいずれかを入力し、Claude Desktop を再起動してください。',
    );
  }

  const profileName =
    raw.profileName === undefined ? DEFAULT_PROFILE : String(raw.profileName).trim();
  if (!isValidProfileName(profileName)) {
    throw new BootstrapValidationError(
      `bootstrap-invalid: profile name is not valid: ${JSON.stringify(profileName)}`,
      settingsHint('プロファイル名'),
    );
  }

  return {
    siteName,
    localRoot,
    host: requireText(raw.host, 'host', 'ホスト名'),
    protocol: protocolRaw as SiteProtocol,
    username: requireText(raw.username, 'username', 'ユーザー名'),
    remoteRoot: requireText(raw.remoteRoot, 'remote_root', 'サーバー側フォルダ'),
    profileName,
    ...(raw.credential === undefined ? {} : { credential: raw.credential }),
  };
}
