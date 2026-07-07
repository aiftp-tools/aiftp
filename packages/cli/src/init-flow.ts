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

import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  type BackupConfig,
  type Config,
  type ConnectionConfig,
  type EncodingConfig,
  type ExcludeConfig,
  type PreflightConfig,
  type ProfileConfig,
  type QuirksConfig,
  type SafetyConfig,
  type SiteEntry,
  SiteRegistry,
  type TemplateConfig,
  configSchema,
  getTemplate,
  listTemplates,
  loadConfig,
} from '@aiftp-tools/core';
import type { PromptField } from './prompt-framework/types.js';

export interface SiteRegistryLookup {
  list(): Promise<readonly SiteEntry[]>;
}

export interface ResolveInitFromRefOptions {
  readonly cwd: string;
  readonly registry?: SiteRegistryLookup;
}

export interface ResolveInitSiteNameOptions {
  readonly cwd: string;
  readonly registry?: SiteRegistryLookup;
}

export interface LoadInitInheritanceOptions extends ResolveInitFromRefOptions {
  readonly loadConfig?: typeof loadConfig;
}

export interface InheritedProfileInitials {
  readonly serverKind: ProfileConfig['server_kind'];
  readonly protocol: ProfileConfig['protocol'];
  readonly port: number;
  readonly ftpsMode?: NonNullable<ProfileConfig['ftps_mode']>;
  readonly passiveMode?: boolean;
}

type Immutable<T> = T extends readonly (infer Value)[]
  ? readonly Immutable<Value>[]
  : T extends object
    ? { readonly [Key in keyof T]: Immutable<T[Key]> }
    : T;
type SectionDiff<T> = Readonly<Partial<{ readonly [Key in keyof T]: Immutable<T[Key]> }>>;
type BackupDiff = Readonly<
  Omit<SectionDiff<BackupConfig>, 'hard_exclude'> & {
    readonly hard_exclude?: SectionDiff<BackupConfig['hard_exclude']>;
  }
>;

export interface InheritedSections {
  readonly safety?: SectionDiff<SafetyConfig>;
  readonly backup?: BackupDiff;
  readonly connection?: SectionDiff<ConnectionConfig>;
  readonly encoding?: SectionDiff<EncodingConfig>;
  readonly quirks?: SectionDiff<QuirksConfig>;
  readonly walk?: SectionDiff<Config['walk']>;
  readonly preflight?: SectionDiff<PreflightConfig>;
  readonly exclude?: SectionDiff<ExcludeConfig>;
}

export interface LoadedInitInheritance {
  readonly sourcePath: string;
  readonly profileName: string;
  readonly initials: InheritedProfileInitials;
  readonly sections: InheritedSections;
}

export class InitFromNotFoundError extends Error {
  constructor(ref: string) {
    super(`init --from "${ref}" did not match a registered site or an existing path`);
    this.name = 'InitFromNotFoundError';
  }
}

export class InitFromInvalidError extends Error {
  constructor(path: string, options?: { cause?: unknown }) {
    super(
      `Unable to load inherited config at ${path}. Check that it is readable and valid.`,
      options,
    );
    this.name = 'InitFromInvalidError';
  }
}

interface ResolvedInitFromRef {
  readonly path: string;
  readonly site?: SiteEntry;
}

async function resolveInitFromRefDetails(
  ref: string,
  options: ResolveInitFromRefOptions,
): Promise<ResolvedInitFromRef> {
  const registry = options.registry ?? new SiteRegistry();
  const site = (await registry.list()).find((entry) => entry.name === ref);
  if (site) {
    return { path: join(site.path, '.aiftp.toml'), site };
  }

  const candidate = resolve(options.cwd, ref);
  try {
    const info = await stat(candidate);
    return {
      path:
        candidate.endsWith('.aiftp.toml') || !info.isDirectory()
          ? candidate
          : join(candidate, '.aiftp.toml'),
    };
  } catch {
    throw new InitFromNotFoundError(ref);
  }
}

export async function resolveInitFromRef(
  ref: string,
  options: ResolveInitFromRefOptions,
): Promise<string> {
  return (await resolveInitFromRefDetails(ref, options)).path;
}

export async function resolveInitSiteName(options: ResolveInitSiteNameOptions): Promise<string> {
  const absoluteCwd = resolve(options.cwd);
  const fallback = basename(absoluteCwd);
  const registry = options.registry ?? new SiteRegistry();
  try {
    const site = (await registry.list()).find((entry) => resolve(entry.path) === absoluteCwd);
    return site?.name && site.name.trim().length > 0 ? site.name : fallback;
  } catch {
    return fallback;
  }
}

const BASELINE_CONFIG: Config = configSchema.parse({
  schema: 2,
  profile: {
    baseline: {
      host: 'baseline.invalid',
      user: 'baseline',
      remote_root: '/',
      local_root: '.',
      keychain_service: 'aiftp:baseline',
    },
  },
});

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return (
      keys.length === Object.keys(rightRecord).length &&
      keys.every((key) => valuesEqual(leftRecord[key], rightRecord[key]))
    );
  }
  return Object.is(left, right);
}

function diffSection<T extends object>(source: T, baseline: T): Partial<T> {
  return Object.fromEntries(
    (Object.keys(source) as Array<keyof T>)
      .filter((key) => !valuesEqual(source[key], baseline[key]))
      .map((key) => [key, Array.isArray(source[key]) ? [...source[key]] : source[key]]),
  ) as Partial<T>;
}

function hasFields(value: object): boolean {
  return Object.keys(value).length > 0;
}

export function computeInheritedSections(source: Config): InheritedSections {
  const safety = diffSection(source.safety, BASELINE_CONFIG.safety);
  const { hard_exclude: sourceHardExclude, ...sourceBackup } = source.backup;
  const { hard_exclude: baselineHardExclude, ...baselineBackup } = BASELINE_CONFIG.backup;
  const backupFields = diffSection(sourceBackup, baselineBackup);
  const hardExclude = diffSection(sourceHardExclude, baselineHardExclude);
  const backup: BackupDiff = {
    ...backupFields,
    ...(hasFields(hardExclude) ? { hard_exclude: hardExclude } : {}),
  };
  const connection = diffSection(source.connection, BASELINE_CONFIG.connection);
  const encoding = diffSection(source.encoding, BASELINE_CONFIG.encoding);
  const quirks = diffSection(source.quirks, BASELINE_CONFIG.quirks);
  const walk = diffSection(source.walk, BASELINE_CONFIG.walk);
  const preflight = diffSection(source.preflight, BASELINE_CONFIG.preflight);
  const exclude = diffSection(source.exclude, BASELINE_CONFIG.exclude);

  return {
    ...(hasFields(safety) ? { safety } : {}),
    ...(hasFields(backup) ? { backup } : {}),
    ...(hasFields(connection) ? { connection } : {}),
    ...(hasFields(encoding) ? { encoding } : {}),
    ...(hasFields(quirks) ? { quirks } : {}),
    ...(hasFields(walk) ? { walk } : {}),
    ...(hasFields(preflight) ? { preflight } : {}),
    ...(hasFields(exclude) ? { exclude } : {}),
  };
}

export function extractInheritedProfileInitials(
  source: Config,
  profileName: string,
): InheritedProfileInitials {
  const profile = source.profile[profileName];
  if (!profile) {
    throw new Error(`Inherited profile not found: ${profileName}`);
  }
  return {
    serverKind: profile.server_kind,
    protocol: profile.protocol,
    port: profile.port,
    ...(profile.ftps_mode === undefined ? {} : { ftpsMode: profile.ftps_mode }),
    ...(profile.passive_mode === undefined ? {} : { passiveMode: profile.passive_mode }),
  };
}

export async function loadInitInheritance(
  ref: string,
  options: LoadInitInheritanceOptions,
): Promise<LoadedInitInheritance> {
  const resolved = await resolveInitFromRefDetails(ref, options);
  let source: Config;
  try {
    source = await (options.loadConfig ?? loadConfig)(resolved.path, { autoMigrate: false });
  } catch (error: unknown) {
    throw new InitFromInvalidError(resolved.path, { cause: error });
  }
  const firstProfile = Object.keys(source.profile)[0];
  const profileName =
    resolved.site?.default_profile && source.profile[resolved.site.default_profile]
      ? resolved.site.default_profile
      : firstProfile;
  if (!profileName) {
    throw new InitFromInvalidError(resolved.path);
  }
  return {
    sourcePath: resolved.path,
    profileName,
    initials: extractInheritedProfileInitials(source, profileName),
    sections: computeInheritedSections(source),
  };
}

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

export function sanitizeKeychainSiteName(siteName: string | undefined): string {
  if (siteName === undefined) return '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional keychain identifier sanitization
  const controlCharacters = /[\u0000-\u001f\u007f]+/gu;
  return siteName
    .trim()
    .replace(controlCharacters, '-')
    .replace(/[:/\\]+/gu, '-')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

export function buildKeychainServiceInitial(
  siteName: string | undefined,
  profileName: string,
): string {
  const sanitizedSiteName = sanitizeKeychainSiteName(siteName);
  return sanitizedSiteName.length > 0
    ? `aiftp:${sanitizedSiteName}-${profileName}`
    : `aiftp:${profileName}`;
}

export function buildInitFields(siteName?: string): PromptField[] {
  return buildInitFieldsWithTemplate(true, undefined, undefined, siteName);
}

export function buildInitFieldsFromInherited(
  initials: InheritedProfileInitials,
  siteName?: string,
): PromptField[] {
  return buildInitFieldsWithTemplate(true, undefined, initials, siteName);
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
  inherited?: InheritedProfileInitials,
  siteName?: string,
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
      initial: inherited?.port ?? 21,
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
      hint: 'FTPS (TLS) 推奨。FTP は平文 (非推奨)。SFTP は SSH 経由 — v0.11+ で対応。',
      initial: inherited?.protocol ?? 'ftps',
      choices: [
        { title: 'FTPS', value: 'ftps' },
        { title: 'SFTP', value: 'sftp' },
        { title: 'FTP', value: 'ftp' },
      ],
    },
    ...(inherited?.ftpsMode === undefined
      ? []
      : [
          {
            name: 'ftpsMode',
            label: 'FTPS mode',
            type: 'select' as const,
            hint: 'Explicit は通常ポート21、implicit は通常ポート990でTLS接続します。',
            initial: inherited.ftpsMode,
            choices: [
              { title: 'Explicit', value: 'explicit' },
              { title: 'Implicit', value: 'implicit' },
            ],
          },
        ]),
    ...(inherited?.passiveMode === undefined
      ? []
      : [
          {
            name: 'passiveMode',
            label: 'Passive mode',
            type: 'confirm' as const,
            hint: 'PASV接続を使う場合は有効にします。継承元の値を初期値として確認できます。',
            initial: inherited.passiveMode,
          },
        ]),
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
        return buildKeychainServiceInitial(siteName, profile);
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
      initial: inherited?.serverKind,
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
