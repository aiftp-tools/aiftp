import { lookup } from 'node:dns/promises';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type DeployClient,
  type DeployUploader,
  type DoctorReport,
  type ExportProfile,
  FtpAuthError,
  FtpClient,
  FtpTlsError,
  type ProfileBlockFields,
  type PushBackupStore,
  type PushOptions,
  type PushResult,
  type RollbackBackupStore,
  type RollbackResult,
  type RollbackUploader,
  type SnapshotMeta,
  type StatusOptions,
  type StatusResult,
  type TemplateConfig,
  VERSION,
  type VerifyResult,
  appendProfileBlock,
  backupKeyService,
  checkAll,
  createDefaultBackupStore,
  createDeployClient,
  createExcluder,
  createWatchDebouncer,
  deletePassword,
  extractHookPaths,
  generateKey,
  getPassword,
  getTemplate,
  hasPassword,
  isProdProfile,
  isValidProfileName,
  isValidSnapshotId,
  listTemplates,
  loadConfig,
  loadState,
  migrateV1ToV2Source,
  parseFfftpIni,
  parseFilezillaXml,
  probeFtps,
  relativizeIntoProject,
  removeProfileBlock,
  renameProfileBlock,
  renderFilezillaXml,
  resolveDefaultProfile,
  resolveRollbackTarget,
  runDoctor as runCoreDoctor,
  runPush,
  runRollback,
  runStatus,
  saveDefaultProfile,
  saveState,
  setPassword,
  setProfileField,
} from '@aiftp-tools/core';
import { Command, CommanderError } from 'commander';
import prompts from 'prompts';
import { buildInitFieldsWithTemplate } from './init-flow.js';
import { PromptFlow } from './prompt-framework/prompt-flow.js';

export { VERSION };

type PromptQuestion = Parameters<typeof prompts>[0];

export type CliPrompt = (questions: PromptQuestion) => Promise<Record<string, unknown>>;

export interface CliKeychain {
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
  hasPassword(service: string, account: string): Promise<boolean>;
  getPassword(service: string, account: string): Promise<string>;
}

export interface CliBackupStore {
  listSnapshots(): Promise<SnapshotMeta[]>;
  verify(id: string): Promise<VerifyResult>;
  prune(keepCount: number): Promise<string[]>;
  restoreFile(id: string, path: string): Promise<Buffer>;
  createAutoSnapshot?: PushBackupStore['createAutoSnapshot'];
}

export interface CliContext {
  cwd: string;
  profileName: string;
}

export interface CliMcpContext {
  cwd: string;
}

export interface CliDoctorContext {
  cwd: string;
  profile: string;
}

export interface CliRuntime {
  runStatus?(options: StatusOptions): Promise<StatusResult>;
  runPush?(options: PushOptions): Promise<PushResult>;
  createUploader?(context: CliContext): Promise<DeployUploader>;
  createBackupStore?(context: CliContext): Promise<CliBackupStore>;
  runDoctor?(context: CliDoctorContext): Promise<DoctorReport>;
  startMcp?(context: CliMcpContext): Promise<void>;
  /**
   * v0.5.0: rollback runner. The test harness injects a mock that returns
   * a pre-canned RollbackResult without standing up FTP/backup deps; the
   * production default (`defaultRunRollback`) resolves the target snapshot
   * and runs core's `runRollback` against the live FTP client + backup
   * store.
   *
   * The hook receives the CLI-shaped options (`steps` / `snapshotId` are
   * pre-resolution inputs, not the final snapshot id). Resolution happens
   * inside the runner so the hook can swap in a different selection
   * strategy if needed.
   */
  runRollback?(options: CliRollbackOptions): Promise<RollbackResult>;
}

export interface CliRollbackOptions {
  cwd: string;
  profile: string;
  /** Undo the N-th most recent push. Ignored when `snapshotId` is set. */
  steps?: number;
  /** Explicit snapshot id (mutually exclusive with `steps`). */
  snapshotId?: string;
  dryRun: boolean;
}

interface InitCommandOptions {
  force?: boolean;
  template?: string;
}

interface ManagedUploader {
  uploader: DeployUploader;
  close(): Promise<void>;
}

export interface CliOptions {
  cwd?: string;
  prompt?: CliPrompt;
  keychain?: CliKeychain;
  runtime?: CliRuntime;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface InitAnswers {
  profile: string;
  host: string;
  port: number;
  protocol: 'ftp' | 'ftps';
  user: string;
  remoteRoot: string;
  localRoot: string;
  keychainService: string;
  serverKind: 'starserver' | 'lolipop' | 'sakura' | 'xserver' | 'generic';
  password: string;
  consent: boolean;
}

function defaultPrompt(questions: PromptQuestion): Promise<Record<string, unknown>> {
  // v0.10.4 (Codex Phase 2 C2): onCancel returns false so prompts library does
  // not exit() the process; missing fields surface as undefined and are caught
  // by sanitizeFieldInput / parseSummaryChoice cancel handling downstream.
  return prompts(questions, {
    onCancel: () => false,
  }) as Promise<Record<string, unknown>>;
}

function defaultKeychain(): CliKeychain {
  return {
    setPassword,
    deletePassword,
    hasPassword,
    getPassword,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function renderStringArray(values: readonly string[]): string {
  return `[${values.map((value) => quote(value)).join(', ')}]`;
}

function renderConfig(answers: InitAnswers, template?: TemplateConfig): string {
  const defaults = template?.defaults;
  // v0.11 Pillar β review Phase 2-1: the user's localRoot answer always wins.
  // The template default is wired into init-flow.ts as the field's initial
  // so the operator sees and confirms it; any edit must reach the TOML
  // unchanged.
  const lines: string[] = [
    'schema = 2',
    '',
    `[profile.${answers.profile}]`,
    `host = ${quote(answers.host)}`,
    `port = ${answers.port}`,
    `protocol = ${quote(answers.protocol)}`,
    `user = ${quote(answers.user)}`,
    `remote_root = ${quote(answers.remoteRoot)}`,
    `local_root = ${quote(answers.localRoot)}`,
    `keychain_service = ${quote(answers.keychainService)}`,
    `server_kind = ${quote(answers.serverKind)}`,
    '',
  ];

  if (defaults) {
    if (defaults.excludeAdd.length > 0) {
      lines.push(
        '[backup.hard_exclude]',
        `additional_patterns = ${renderStringArray(defaults.excludeAdd)}`,
        '',
      );
    }

    if (defaults.safetyProductionPatterns.length > 0) {
      lines.push(
        '[safety]',
        `prod_profile_patterns = ${renderStringArray(defaults.safetyProductionPatterns)}`,
        '',
      );
    }

    if (defaults.preflightPhpLint !== undefined || defaults.preflightJsonCheck !== undefined) {
      lines.push(
        '[preflight]',
        ...(defaults.preflightPhpLint !== undefined
          ? [`php_lint = ${defaults.preflightPhpLint}`]
          : []),
        ...(defaults.preflightJsonCheck !== undefined
          ? [`json_check = ${defaults.preflightJsonCheck}`]
          : []),
        '',
      );
    }
  }

  if (answers.serverKind === 'starserver') {
    // Star Server presents `*.star.ne.jp` cert for `*.stars.ne.jp` hosts.
    // We pre-set the documented quirk so the operator does not have to
    // hand-edit the file after the first hostname-mismatch error. The
    // CLI emits a stderr warning when this happens so the trade-off is
    // explicit, not silent.
    lines.push(
      '[quirks]',
      '# Star Server quirk: certificate CN is *.star.ne.jp while customer',
      '# hosts are usually *.stars.ne.jp, so TLS hostname verification',
      '# fails by default. We disable hostname-only checking here. aiftp',
      '# still requires a valid certificate chain.',
      'tls_check_hostname = false',
      '',
    );
  }

  return lines.join('\n');
}

async function ensureGitignore(cwd: string): Promise<void> {
  const path = join(cwd, '.gitignore');
  const source = (await readFile(path, 'utf8').catch(() => '')) as string;
  const lines = source.split(/\r?\n/u);
  if (lines.includes('.aiftp/')) {
    return;
  }
  const prefix = source.length > 0 && !source.endsWith('\n') ? '\n' : '';
  await appendFile(path, `${prefix}.aiftp/\n`, 'utf8');
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function isStandardFtpPort(port: number, protocol: 'ftp' | 'ftps'): boolean {
  if (protocol === 'ftps') {
    return port === 21 || port === 990;
  }
  return port === 21;
}

function requirePort(value: unknown): number {
  const port = requireNumber(value, 'port');
  if (port < 1 || port > 65535) {
    throw new Error('port must be between 1 and 65535 (e.g. 21 for FTP, 990 for FTPS implicit)');
  }
  return port;
}

// v0.10.4 (Codex Phase 1 review): trim whitespace + reject control chars on text/password fields.
// Control chars (U+0000-U+001F) break TOML syntax and may corrupt keychain serialization.
function sanitizeFieldInput(raw: unknown, fieldName: string): string {
  if (typeof raw !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required (empty after trim)`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional TOML/keychain safety check
  if (/[\u0000-\u001f]/u.test(trimmed)) {
    throw new Error(`${fieldName} must not contain control characters or newlines`);
  }
  return trimmed;
}

type SummaryChoice =
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'edit'; fieldIndex: number }
  | { kind: 'cancel' }
  | { kind: 'invalid' };

// v0.10.4 (Codex Phase 1 review #16): strict parsing for summary prompt input.
// Rejects full-width digits, ambiguous numerics (01, 1abc, 1.5), and paste-with-junk.
// Returns { kind: 'cancel' } for null/undefined (prompts onCancel signal) so the caller
// can distinguish a user pressing Ctrl+C from a default "yes" Enter.
function parseSummaryChoice(raw: unknown): SummaryChoice {
  if (raw === null || raw === undefined) {
    return { kind: 'cancel' };
  }
  const s = String(raw).trim();
  if (s === '') return { kind: 'yes' };
  const lower = s.toLowerCase();
  if (lower === 'y' || lower === 'yes') return { kind: 'yes' };
  if (lower === 'n' || lower === 'no') return { kind: 'no' };
  if (/^[1-9]$|^10$/.test(s)) {
    return { kind: 'edit', fieldIndex: Number.parseInt(s, 10) };
  }
  return { kind: 'invalid' };
}

export const __test__sanitizeFieldInput = sanitizeFieldInput;
export const __test__parseSummaryChoice = parseSummaryChoice;

// v0.10.4: ordered list of fields shown in `aiftp init` summary review (consent omitted).
const INIT_SUMMARY_FIELDS = [
  { key: 'profile', label: 'Profile name' },
  { key: 'host', label: 'FTP host' },
  { key: 'port', label: 'FTP port' },
  { key: 'protocol', label: 'Protocol' },
  { key: 'user', label: 'FTP user' },
  { key: 'remoteRoot', label: 'Remote root' },
  { key: 'localRoot', label: 'Local root' },
  { key: 'keychainService', label: 'Keychain service' },
  { key: 'serverKind', label: 'Server kind' },
  { key: 'password', label: 'FTP password' },
] as const;

const MAX_INIT_EDIT_LOOPS = 10;
const SUMMARY_VALUE_PREVIEW_LIMIT = 80;

const SERVER_KIND_LABELS: Record<InitAnswers['serverKind'], string> = {
  starserver: 'StarServer',
  lolipop: 'Lolipop',
  sakura: 'Sakura',
  xserver: 'Xserver',
  generic: 'Generic',
};

function formatInitSummaryValue(
  answers: InitAnswers,
  key: (typeof INIT_SUMMARY_FIELDS)[number]['key'],
): string {
  if (key === 'protocol') return answers.protocol === 'ftps' ? 'FTPS' : 'FTP';
  if (key === 'serverKind') return SERVER_KIND_LABELS[answers.serverKind];
  if (key === 'password') {
    const len = answers.password.length;
    return `${'•'.repeat(Math.min(len, 11))} (hidden, ${len} chars)`;
  }
  if (key === 'port') return String(answers.port);
  return String(answers[key]);
}

function formatInitSummary(answers: InitAnswers): string {
  const lines = ['', `Review your aiftp init answers (${answers.profile} profile):`, ''];
  INIT_SUMMARY_FIELDS.forEach((field, idx) => {
    const num = String(idx + 1).padStart(2, ' ');
    let value = formatInitSummaryValue(answers, field.key);
    if (value.length > SUMMARY_VALUE_PREVIEW_LIMIT) {
      value = `${value.slice(0, SUMMARY_VALUE_PREVIEW_LIMIT - 3)}...`;
    }
    lines.push(`  ${num}. ${field.label.padEnd(20, ' ')}${value}`);
  });
  lines.push('');
  return lines.join('\n');
}

async function editInitField(
  current: InitAnswers,
  fieldIdx: number,
  prompt: CliPrompt,
  stderr: (line: string) => void,
): Promise<InitAnswers> {
  const field = INIT_SUMMARY_FIELDS[fieldIdx];
  if (!field) {
    throw new Error(`internal: unknown field index ${fieldIdx}`);
  }

  const textValidate = (label: string) => (value: unknown) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `${label} is required`;
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional TOML/keychain safety check
    if (/[\u0000-\u001f]/u.test(value)) {
      return `${label} must not contain control characters or newlines`;
    }
    return true as const;
  };

  let question: PromptQuestion;
  switch (field.key) {
    case 'profile':
      question = [
        {
          type: 'text',
          name: 'profile',
          message: 'Profile name',
          initial: current.profile,
          validate: textValidate('Profile name'),
        },
      ];
      break;
    case 'host':
      question = [
        {
          type: 'text',
          name: 'host',
          message: 'FTP host',
          initial: current.host,
          validate: textValidate('FTP host'),
        },
      ];
      break;
    case 'port':
      question = [
        {
          type: 'number',
          name: 'port',
          message: 'FTP port',
          initial: current.port,
          min: 1,
          max: 65535,
          validate: (value: unknown) => {
            if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
              return 'FTP port must be an integer (e.g. 21 for FTP, 990 for FTPS implicit)';
            }
            if (value < 1 || value > 65535) {
              return 'FTP port must be between 1 and 65535';
            }
            return true as const;
          },
        },
      ];
      break;
    case 'protocol':
      question = [
        {
          type: 'select',
          name: 'protocol',
          message: 'Protocol',
          choices: [
            { title: 'FTPS', value: 'ftps' },
            { title: 'FTP', value: 'ftp' },
          ],
          initial: current.protocol === 'ftps' ? 0 : 1,
        },
      ];
      break;
    case 'user':
      question = [
        {
          type: 'text',
          name: 'user',
          message: 'FTP user',
          initial: current.user,
          validate: textValidate('FTP user'),
        },
      ];
      break;
    case 'remoteRoot':
      question = [
        {
          type: 'text',
          name: 'remoteRoot',
          message: 'Remote root',
          initial: current.remoteRoot,
          validate: textValidate('Remote root'),
        },
      ];
      break;
    case 'localRoot':
      question = [
        {
          type: 'text',
          name: 'localRoot',
          message: 'Local root',
          initial: current.localRoot,
          validate: textValidate('Local root'),
        },
      ];
      break;
    case 'keychainService':
      question = [
        {
          type: 'text',
          name: 'keychainService',
          message: 'Keychain service',
          // v0.10.4 (Codex Phase 2 S1): default to aiftp:${profile} derived from
          // the *current* profile name (per spec §4.4), not the previously-saved
          // keychain service. Makes #8 obvious to re-default after #1 changed.
          initial: `aiftp:${current.profile}`,
          validate: textValidate('Keychain service'),
        },
      ];
      break;
    case 'serverKind': {
      const skChoices = [
        { title: 'StarServer', value: 'starserver' as const },
        { title: 'Lolipop', value: 'lolipop' as const },
        { title: 'Sakura', value: 'sakura' as const },
        { title: 'Xserver', value: 'xserver' as const },
        { title: 'Generic', value: 'generic' as const },
      ];
      question = [
        {
          type: 'select',
          name: 'serverKind',
          message: 'Server kind',
          choices: skChoices,
          initial: skChoices.findIndex((c) => c.value === current.serverKind),
        },
      ];
      break;
    }
    case 'password':
      question = [
        {
          type: 'password',
          name: 'password',
          message: 'FTP password',
          validate: textValidate('FTP password'),
        },
      ];
      break;
  }

  const result = await prompt(question);
  const rawValue = result[field.key];

  let nextValue: unknown;
  if (field.key === 'port') {
    nextValue = requirePort(rawValue);
  } else if (field.key === 'protocol' || field.key === 'serverKind') {
    nextValue = requireString(rawValue, field.key);
  } else if (field.key === 'password') {
    nextValue = requireString(rawValue, 'password');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional TOML/keychain safety check
    if (typeof nextValue === 'string' && /[\u0000-\u001f]/u.test(nextValue)) {
      throw new Error('FTP password must not contain control characters or newlines');
    }
  } else {
    nextValue = sanitizeFieldInput(rawValue, field.label);
  }

  // Post-validation: non-standard port confirmation (reused from v0.10.3)
  // v0.10.4 (Codex Phase 2 S2): decline returns the unchanged answers so the
  // summary loop re-displays — does NOT throw and abort the whole init.
  if (field.key === 'port' && typeof nextValue === 'number') {
    if (!isStandardFtpPort(nextValue, current.protocol)) {
      const standardDesc = current.protocol === 'ftps' ? '21 or 990' : '21';
      const confirmation = await prompt([
        {
          type: 'confirm',
          name: 'confirmNonStandard',
          message: `Non-standard ${current.protocol.toUpperCase()} port ${nextValue} (standard: ${standardDesc}). Continue?`,
          initial: false,
        },
      ]);
      if (confirmation.confirmNonStandard !== true) {
        stderr(
          `Non-standard port ${nextValue} was not confirmed; keeping previous port ${current.port}.\n`,
        );
        return current;
      }
    }
  }

  // v0.10.4 (Codex Phase 2 S3): protocol edit can also cause port to become
  // non-standard (e.g. FTPS 990 → FTP makes 990 non-standard for plain FTP).
  if (field.key === 'protocol') {
    const newProtocol = nextValue as 'ftp' | 'ftps';
    if (!isStandardFtpPort(current.port, newProtocol)) {
      const standardDesc = newProtocol === 'ftps' ? '21 or 990' : '21';
      const confirmation = await prompt([
        {
          type: 'confirm',
          name: 'confirmNonStandard',
          message: `Protocol change makes current port ${current.port} non-standard for ${newProtocol.toUpperCase()} (standard: ${standardDesc}). Continue?`,
          initial: false,
        },
      ]);
      if (confirmation.confirmNonStandard !== true) {
        stderr(`Protocol change cancelled; keeping previous protocol ${current.protocol}.\n`);
        return current;
      }
    }
  }

  // Post-validation: remote_root leading slash warning (mirrors existing init flow)
  if (field.key === 'remoteRoot' && typeof nextValue === 'string' && nextValue.startsWith('/')) {
    stderr(
      `Warning: remote_root starts with "/" (${nextValue}). On shared hosts the actual upload root is often "/<your-domain>/public_html/..." or "/<your-user>/public_html/...". Confirm with your provider's FTP setup guide.\n`,
    );
  }

  // Post-validation: starserver TLS hostname warning (mirrors existing init flow)
  if (field.key === 'serverKind' && nextValue === 'starserver') {
    stderr(
      'Warning: server_kind = "starserver" — Star Server presents a *.star.ne.jp certificate for *.stars.ne.jp hostnames. aiftp will set [quirks].tls_check_hostname = false in your .aiftp.toml so the deploy works out of the box. The certificate chain itself is still verified.\n',
    );
  }

  return { ...current, [field.key]: nextValue } as InitAnswers;
}

async function runInitSummaryReview(
  initial: InitAnswers,
  prompt: CliPrompt,
  stderr: (line: string) => void,
): Promise<InitAnswers> {
  // Codex Should-add #24: non-TTY environment must fail clearly, not block on stdin.
  // Codex Phase 2 C3: \`isTTY !== true\` catches both \`false\` and \`undefined\`
  // (the latter is what Node returns when stdin is a pipe or redirected file).
  if (process.stdin.isTTY !== true) {
    throw new Error(
      'aiftp init: non-interactive stdin not supported for summary review; re-run in a real terminal',
    );
  }

  let answers = initial;
  for (let loop = 0; loop < MAX_INIT_EDIT_LOOPS; loop += 1) {
    stderr(formatInitSummary(answers));
    const result = await prompt([
      {
        type: 'text',
        name: 'choice',
        message: 'Looks correct? [Y/n] or enter 1-10 to edit',
        initial: '',
      },
    ]);

    const choice = parseSummaryChoice(result.choice);
    if (choice.kind === 'yes') return answers;
    if (choice.kind === 'no') {
      throw new Error('aiftp init: aborted by user at summary review');
    }
    if (choice.kind === 'cancel') {
      throw new Error('aiftp init: cancelled at summary review (no changes made)');
    }
    if (choice.kind === 'invalid') {
      stderr('Invalid input. Enter Y, n, or 1-10 (half-width digits).\n');
      continue;
    }

    const oldProfile = answers.profile;
    answers = await editInitField(answers, choice.fieldIndex - 1, prompt, stderr);
    if (choice.fieldIndex === 1 && answers.profile !== oldProfile) {
      stderr(
        `Profile name changed from "${oldProfile}" to "${answers.profile}". Keychain service (#8) is NOT auto-updated; edit it separately if needed.\n`,
      );
    }
  }
  throw new Error(
    `aiftp init: edit loop limit exceeded (${MAX_INIT_EDIT_LOOPS}); aborting to prevent runaway`,
  );
}

export const __test__runInitSummaryReview = runInitSummaryReview;
export const __test__formatInitSummary = formatInitSummary;

function parseNonNegativeInteger(value: string, name: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseInitAnswers(raw: Record<string, unknown>): InitAnswers {
  // v0.10.4 (Codex Phase 2 C1): apply sanitizeFieldInput (trim + control-char reject)
  // at the initial-prompt boundary, not just inside the summary review.
  // Password keeps leading/trailing whitespace (can be intentional) but rejects control chars.
  const pw = requireString(raw.password, 'password');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional TOML/keychain safety check
  if (/[\u0000-\u001f]/u.test(pw)) {
    throw new Error('password must not contain control characters or newlines');
  }
  return {
    profile: sanitizeFieldInput(raw.profile, 'profile'),
    host: sanitizeFieldInput(raw.host, 'host'),
    port: requirePort(raw.port),
    protocol: requireString(raw.protocol, 'protocol') as InitAnswers['protocol'],
    user: sanitizeFieldInput(raw.user, 'user'),
    remoteRoot: sanitizeFieldInput(raw.remoteRoot, 'remoteRoot'),
    localRoot: sanitizeFieldInput(raw.localRoot, 'localRoot'),
    keychainService: sanitizeFieldInput(raw.keychainService, 'keychainService'),
    serverKind: requireString(raw.serverKind, 'serverKind') as InitAnswers['serverKind'],
    password: pw,
    consent: requireBoolean(raw.consent, 'consent'),
  };
}

async function loadProfile(cwd: string, name: string) {
  const config = await loadConfig(join(cwd, '.aiftp.toml'));
  const profile = config.profile[name];
  if (!profile) {
    throw new Error(`Profile not found: ${name}`);
  }
  return profile;
}

function projectPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

/**
 * Resolve `path` relative to `cwd` and verify the result stays inside the
 * project root. Absolute paths are accepted only when they already resolve
 * inside `cwd`. Throws otherwise. Used by destructive write operations such
 * as `backup restore --output ...` to prevent accidental writes outside the
 * project (path traversal via `..` or absolute escape).
 */
function restrictToProject(cwd: string, path: string): string {
  if (path.length === 0) {
    throw new Error('--output path must not be empty');
  }
  const cwdResolved = resolve(cwd);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwdResolved, path);
  const rel = relative(cwdResolved, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`--output ${path} resolves outside the project root`);
  }
  return absolute;
}

function validateSnapshotIdArg(id: string): void {
  if (id.trim().length === 0) {
    throw new Error('Snapshot id is required');
  }
  if (!isValidSnapshotId(id)) {
    throw new Error(
      `Invalid snapshot id: ${JSON.stringify(id)}. Expected format like "<iso-timestamp>-<auto|full>-<uuid>" (see \`aiftp backup list\`).`,
    );
  }
}

function stateDir(cwd: string, profileName: string): string {
  return join(cwd, '.aiftp', 'state', profileName);
}

function logPath(cwd: string): string {
  return join(cwd, '.aiftp', 'log.jsonl');
}

async function loadStatusContext(cwd: string, profileName: string): Promise<StatusOptions> {
  const config = await loadConfig(join(cwd, '.aiftp.toml'));
  const profile = config.profile[profileName];
  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  return {
    localRoot: projectPath(cwd, profile.local_root),
    state: await loadState(stateDir(cwd, profileName)),
    excluder: createExcluder({
      userPatterns: config.exclude.patterns,
      useDefaults: config.exclude.use_defaults,
      additionalHardPatterns: config.backup.hard_exclude.additional_patterns,
    }),
    // v0.9.4+: propagate walk policy so symlinks are followed only
    // when the operator opts in via [walk] follow_symlinks = true.
    followSymlinks: config.walk.follow_symlinks,
  };
}

async function appendLogEntry(cwd: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(logPath(cwd)), { recursive: true });
  await appendFile(logPath(cwd), `${JSON.stringify(entry)}\n`, 'utf8');
}

async function readLogEntries(cwd: string): Promise<Array<Record<string, unknown>>> {
  const source = (await readFile(logPath(cwd), 'utf8').catch(() => '')) as string;
  return source
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function injectedRuntimeUploader(): DeployUploader {
  return {
    upload: async () => {
      throw new Error('Injected runPush must not call the placeholder uploader.');
    },
    delete: async () => {
      throw new Error('Injected runPush must not call the placeholder uploader.');
    },
  };
}

function dryRunBackupStore(): PushBackupStore {
  return {
    createAutoSnapshot: async () => {
      throw new Error('Dry-run backup store must not create snapshots.');
    },
  };
}

function isPushBackupStore(
  store: CliBackupStore | undefined,
): store is CliBackupStore & PushBackupStore {
  return typeof store?.createAutoSnapshot === 'function';
}

function writeDryRunPathSection(
  stdout: (message: string) => void,
  title: string,
  paths: readonly string[],
): void {
  if (paths.length === 0) {
    return;
  }
  stdout(`  ${title}:`);
  for (const path of paths.slice(0, 10)) {
    stdout(`    - ${path}`);
  }
  const remaining = paths.length - 10;
  if (remaining > 0) {
    stdout(`  ... and ${remaining} more`);
  }
}

async function createDefaultFtpClient(
  cwd: string,
  profileName: string,
  keychain: CliKeychain,
): Promise<DeployClient> {
  const config = await loadConfig(join(cwd, '.aiftp.toml'));
  const profile = config.profile[profileName];
  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  const client = createDeployClient({
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password: await keychain.getPassword(profile.keychain_service, profile.user),
    protocol: profile.protocol,
    requireTls: config.safety.require_tls,
    verifyCertificate: config.safety.verify_certificate,
    skipHostnameCheck: config.quirks?.tls_check_hostname === false,
    timeoutMs: config.connection.timeout_ms,
    noopIntervalSec: config.quirks?.noop_interval_sec ?? 0,
  });
  await client.connect();
  return client;
}

function managedUploaderFromClient(client: DeployClient): ManagedUploader {
  return {
    uploader: {
      upload: (localPath, remotePath) => client.upload(localPath, remotePath),
      delete: (remotePath) => client.delete(remotePath),
      size: (remotePath) => client.size(remotePath),
      mkdir: (remoteDir) => client.mkdir(remoteDir),
    },
    close: async () => undefined,
  };
}

async function createDefaultManagedUploader(
  cwd: string,
  profileName: string,
  keychain: CliKeychain,
  ftpClient?: DeployClient,
): Promise<ManagedUploader> {
  if (ftpClient) {
    return managedUploaderFromClient(ftpClient);
  }
  const client = await createDefaultFtpClient(cwd, profileName, keychain);
  const managed = managedUploaderFromClient(client);
  return { ...managed, close: () => client.disconnect() };
}

async function resolveManagedUploader(
  cwd: string,
  profileName: string,
  dryRun: boolean | undefined,
  keychain: CliKeychain,
  runtime: CliRuntime,
  ftpClient?: DeployClient,
  runtimeUploader?: DeployUploader,
): Promise<ManagedUploader> {
  if (runtimeUploader) {
    return { uploader: runtimeUploader, close: async () => undefined };
  }
  if (runtime.runPush || dryRun) {
    return { uploader: injectedRuntimeUploader(), close: async () => undefined };
  }
  return createDefaultManagedUploader(cwd, profileName, keychain, ftpClient);
}

function printStatus(stdout: (line: string) => void, result: StatusResult, json?: boolean): void {
  if (json) {
    stdout(JSON.stringify(result));
    return;
  }
  stdout(
    `added=${result.counts.added} modified=${result.counts.modified} removed=${result.counts.removed} unchanged=${result.counts.unchanged}`,
  );
}

function formatLogEntry(entry: Record<string, unknown>): string {
  const at = String(entry.at ?? '');
  const event = String(entry.event ?? '');
  const profile = String(entry.profile ?? '');
  const uploaded = entry.uploaded === undefined ? '' : ` uploaded=${String(entry.uploaded)}`;
  return `${at} ${event} ${profile}${uploaded}`.trim();
}

async function defaultStartMcp(context: CliMcpContext): Promise<void> {
  // v0.4.2: wire the default doctor runner so `aiftp_profile_test` over MCP
  // actually does something useful. Without this hook, the MCP server has
  // no runDoctor implementation and the tool refuses every call (v0.4.1
  // design — see packages/mcp/src/index.ts handleProfileTest).
  //
  // The adapter shape converts the MCP runtime's `(context: { cwd, profileName })`
  // call into the CLI's `(context: { cwd, profile })` shape — they're the
  // same data, different field names.
  const mod = (await import('@aiftp-tools/mcp')) as unknown as {
    startStdioServer(options: {
      cwd?: string;
      runtime?: {
        runDoctor?(context: { cwd: string; profileName: string }): Promise<DoctorReport>;
      };
    }): Promise<void>;
  };
  await mod.startStdioServer({
    cwd: context.cwd,
    runtime: {
      runDoctor: async ({ cwd, profileName }) => defaultRunDoctor({ cwd, profile: profileName }),
    },
  });
}

async function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const socket = createConnection({ host, port });

    const settle = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(ok);
    };

    socket.setTimeout(3000);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * v0.5.0: production rollback runner.
 *
 * Pipeline:
 *   1. Load config + resolve the live profile.
 *   2. Stand up the encrypted backup store (same path push uses).
 *   3. Build an FTP client and adapt it to the RollbackUploader shape
 *      (in-memory Buffer → uploadBuffer call, no temp file on disk).
 *   4. Resolve the rollback target via core's `resolveRollbackTarget`
 *      (steps or explicit snapshotId).
 *   5. Run `runRollback` (which applies hard-exclude protection before
 *      any decryption — auth-bearing files never enter memory).
 *   6. Disconnect FTP, return the result.
 */
async function defaultRunRollback(
  options: CliRollbackOptions,
  keychain: CliKeychain = defaultKeychain(),
): Promise<RollbackResult> {
  const config = await loadConfig(join(options.cwd, '.aiftp.toml'));
  const profile = config.profile[options.profile];
  if (!profile) {
    throw new Error(`Profile not found: ${options.profile}`);
  }
  const state = await loadState(stateDir(options.cwd, options.profile));
  const backupStore = await createDefaultBackupStore({
    cwd: options.cwd,
    profileName: options.profile,
  });
  const rollbackStore: RollbackBackupStore = {
    listSnapshots: () => backupStore.listSnapshots(),
    restoreFile: (id, path) => backupStore.restoreFile(id, path),
  };
  const target = await resolveRollbackTarget({
    store: rollbackStore,
    steps: options.steps,
    snapshotId: options.snapshotId,
  });
  // Build the uploader — dry-run gets a stub so we don't open an FTP
  // socket needlessly. Real rollback uses the FtpClient's buffer +
  // rename API so each file is written atomically (Codex BLOCK fix).
  let ftpClient: DeployClient | undefined;
  const uploader: RollbackUploader = options.dryRun
    ? {
        upload: async () => {
          throw new Error('dry-run rollback must not call upload');
        },
      }
    : await (async () => {
        ftpClient = await createDefaultFtpClient(options.cwd, options.profile, keychain);
        const client = ftpClient;
        return {
          upload: async (_localPath, remotePath, content) => {
            await client.uploadBuffer(content, remotePath);
          },
          mkdir: async (remoteDir: string) => {
            await client.mkdir(remoteDir);
          },
          rename: async (src, dest) => {
            await client.rename(src, dest);
          },
          unlink: async (remote) => {
            // basic-ftp's `remove` returns FTPResponse but we don't care
            // about the response — we just need the call.
            const internal = (
              client as unknown as { client?: { remove?: (p: string) => Promise<unknown> } }
            ).client;
            if (internal?.remove) {
              await internal.remove(remote).catch(() => undefined);
            }
          },
          delete: async (remote) => {
            await client.delete(remote);
          },
        };
      })();
  try {
    return await runRollback({
      snapshotId: target.id,
      backupStore: rollbackStore,
      uploader,
      state,
      remoteRoot: profile.remote_root,
      excluder: createExcluder({
        userPatterns: config.exclude.patterns,
        useDefaults: config.exclude.use_defaults,
        additionalHardPatterns: config.backup.hard_exclude.additional_patterns,
      }),
      dryRun: options.dryRun,
    });
  } finally {
    if (ftpClient) await ftpClient.disconnect().catch(() => undefined);
  }
}

async function defaultRunDoctor(context: CliDoctorContext): Promise<DoctorReport> {
  return runCoreDoctor(
    {
      readConfig: async () => {
        try {
          return await loadConfig(join(context.cwd, '.aiftp.toml'));
        } catch {
          return null;
        }
      },
      readGitignore: async () => {
        try {
          return await readFile(join(context.cwd, '.gitignore'), 'utf8');
        } catch {
          return null;
        }
      },
      hasKeychainEntry: (service, account) => hasPassword(service, account),
      getKeychainPassword: async (service, account) => {
        try {
          return await getPassword(service, account);
        } catch {
          return null;
        }
      },
      probeNetwork: async (host, port) => {
        try {
          const records = await lookup(host, { all: true });
          return {
            dnsOk: true,
            tcpOk: await probeTcp(host, port),
            addresses: records.map((record) => record.address),
          };
        } catch {
          return { dnsOk: false, tcpOk: false, addresses: [] };
        }
      },
      probeFtps: async (profile, password) => {
        // Mirror the production push/restore wiring so the probe reflects
        // what the operator's actual deploy will see. If the operator has
        // explicitly opted into [quirks].tls_check_hostname = false (the
        // documented Star Server workaround), the probe respects that --
        // otherwise the probe could not even complete the handshake on
        // hosts the operator has already decided are acceptable. The
        // separate `ftps-cert` doctor check still warns based on the
        // *post-connect* cert CN / altName vs requested host comparison,
        // so a mismatch is still surfaced as a warning even when the
        // hostname check itself is suppressed.
        //
        // v0.11 Pillar γ: this probe is FTP/FTPS-specific (basic-ftp +
        // RFC959 reply codes). SFTP profiles get dedicated checks in
        // Task 27. Short-circuit a "not applicable" result so `aiftp
        // doctor` does not blow up at FtpClient construction time for
        // protocol='sftp'.
        if (profile.protocol === 'sftp') {
          return {
            ok: true,
            handshakeOk: true,
            authOk: true,
            error: undefined,
          };
        }
        const probeConfig = await loadConfig(join(context.cwd, '.aiftp.toml')).catch(() => null);
        // v0.9.2 patch: pipe basic-ftp verbose log to stderr so the
        // operator can see *why* a handshake/login failed instead of
        // the catch-all "FTPS handshake failed." message that doctor
        // currently shows. This makes the catch path below diagnostic.
        const debugFtps = process.env.AIFTP_DEBUG === '1';
        const client = new FtpClient({
          host: profile.host,
          port: profile.port,
          user: profile.user,
          password,
          protocol: profile.protocol,
          requireTls: probeConfig?.safety.require_tls ?? true,
          verifyCertificate: probeConfig?.safety.verify_certificate ?? true,
          skipHostnameCheck: probeConfig?.quirks?.tls_check_hostname === false,
          timeoutMs: probeConfig?.connection.timeout_ms,
          onLog: debugFtps ? (msg: string) => process.stderr.write(`[ftp] ${msg}\n`) : undefined,
        });
        try {
          await client.connect();
          // v0.9.3: connect() includes AUTH TLS handshake AND USER/PASS
          // login (basic-ftp's access()). If we got here both succeeded
          // so mark authOk=true. The downstream probeFtps helper sets
          // handshakeOk: true.
          const probeResult = await probeFtps({
            client: {
              getPeerCertificate: () => client.getPeerCertificate(),
              getFeatures: () => client.getFeatures(),
              sendRaw: (cmd) => client.sendRaw(cmd),
              cd: (path) => client.cd(path),
            },
            requestedHost: profile.host,
            remoteRoot: profile.remote_root,
          });
          return { ...probeResult, authOk: true };
        } catch (error: unknown) {
          // v0.9.2: surface the underlying error to stderr so the operator
          // can tell apart "TLS handshake failed", "login incorrect", etc.
          const msg = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[doctor probeFtps error] ${msg}\n`);
          // v0.9.3: classify the failure into TLS / AUTH / UNKNOWN so the
          // new `ftp-auth` doctor check can report 530 (login incorrect)
          // separately from a real TLS-layer failure. If auth was the
          // problem the TLS handshake actually succeeded — surface that
          // so doctor doesn't mislabel a typo'd password as a TLS bug.
          if (error instanceof FtpAuthError) {
            return {
              handshakeOk: true,
              authOk: false,
              probeErrorKind: 'auth',
              pasvAddressLeak: null,
              mlsdSupported: false,
              sizeSupported: false,
              remoteRootCwdOk: false,
            };
          }
          if (error instanceof FtpTlsError) {
            return {
              handshakeOk: false,
              authOk: undefined,
              probeErrorKind: 'tls',
              pasvAddressLeak: null,
              mlsdSupported: false,
              sizeSupported: false,
              remoteRootCwdOk: false,
            };
          }
          return {
            handshakeOk: false,
            authOk: undefined,
            probeErrorKind: 'unknown',
            pasvAddressLeak: null,
            mlsdSupported: false,
            sizeSupported: false,
            remoteRootCwdOk: false,
          };
        } finally {
          await client.disconnect().catch(() => undefined);
        }
      },
    },
    { profile: context.profile },
  );
}

interface RunImportFilezillaOptions {
  cwd: string;
  xmlPath: string;
  dryRun: boolean;
  overwrite: boolean;
  keychainPrefix: string;
  stdout: (line: string) => void;
  keychain: CliKeychain;
}

// v0.4 PR #17: the local `removeProfileBlock` was promoted to
// `packages/core/src/config-edit.ts` as the canonical implementation so it
// can be shared with the new profile management commands. The core version
// is imported above and used by both `runImportFilezilla` (overwrite path)
// and `aiftp profile remove`.

async function runImportFilezilla(options: RunImportFilezillaOptions): Promise<void> {
  const { xmlPath, cwd } = options;
  const absoluteXmlPath = isAbsolute(xmlPath) ? xmlPath : join(cwd, xmlPath);
  const xml = await readFile(absoluteXmlPath, 'utf8');
  const result = parseFilezillaXml(xml);
  await runImportApply({
    cwd: options.cwd,
    result,
    dryRun: options.dryRun,
    overwrite: options.overwrite,
    keychainPrefix: options.keychainPrefix,
    stdout: options.stdout,
    keychain: options.keychain,
  });
}

/**
 * v0.7.0 #3: import an FFFTP `ffftp.ini`. Reads as raw bytes, decodes
 * Shift_JIS via iconv-lite, normalizes into the same `ImportedProfile[]`
 * shape the FileZilla parser emits, and funnels through `runImportApply`.
 * Conflict handling / password-skip semantics / Keychain writes are
 * therefore identical to `aiftp import filezilla`. Passwords are NOT
 * decrypted (FFFTP's Mask scheme is non-standard); `parseFfftpIni`
 * emits `password.kind = 'master-encrypted'` which `runImportApply`
 * skips. Operator runs `aiftp auth <profile>` after import.
 */
async function runImportFfftp(options: {
  cwd: string;
  iniPath: string;
  dryRun: boolean;
  overwrite: boolean;
  keychainPrefix: string;
  stdout: (line: string) => void;
  keychain: CliKeychain;
}): Promise<void> {
  const absoluteIniPath = isAbsolute(options.iniPath)
    ? options.iniPath
    : join(options.cwd, options.iniPath);
  const bytes = await readFile(absoluteIniPath);
  const result = parseFfftpIni(bytes);
  await runImportApply({
    cwd: options.cwd,
    result,
    dryRun: options.dryRun,
    overwrite: options.overwrite,
    keychainPrefix: options.keychainPrefix,
    stdout: options.stdout,
    keychain: options.keychain,
  });
}

interface RunImportApplyOptions {
  cwd: string;
  result: ReturnType<typeof parseFilezillaXml>;
  dryRun: boolean;
  overwrite: boolean;
  keychainPrefix: string;
  stdout: (line: string) => void;
  keychain: CliKeychain;
}

async function runImportApply(options: RunImportApplyOptions): Promise<void> {
  const { cwd, result, dryRun, overwrite, keychainPrefix, stdout, keychain } = options;

  // Dry-run reads the existing profile list from the raw TOML to avoid
  // triggering the v1 -> v2 auto-migration as a side effect. The non-dry-run
  // path uses loadConfig (with auto-migrate) because the user is opting in
  // to a write anyway.
  const tomlPath = join(cwd, '.aiftp.toml');
  let existingNames: Set<string>;
  if (dryRun) {
    const rawSource = await readFile(tomlPath, 'utf8');
    existingNames = new Set(
      Array.from(rawSource.matchAll(/^\[profile\.([^\]]+)\]/gmu)).map((m) => m[1] ?? ''),
    );
  } else {
    const existingConfig = await loadConfig(tomlPath);
    existingNames = new Set(Object.keys(existingConfig.profile));
  }

  type WriteEntry = {
    name: string;
    lines: string[];
    keychainService: string;
    user: string;
    passwordValue: string | null;
    warnings: string[];
    isOverwrite: boolean;
  };

  const queued: WriteEntry[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const profile of result.profiles) {
    if (profile.protocol === 'sftp') {
      skipped.push({
        name: profile.name,
        reason: `SFTP not supported by aiftp; skipped ${profile.name}`,
      });
      continue;
    }
    if (profile.password.kind === 'master-encrypted') {
      skipped.push({
        name: profile.name,
        reason: `master password protected entry skipped: ${profile.name}`,
      });
      continue;
    }
    const conflict = existingNames.has(profile.name);
    if (conflict && !overwrite) {
      skipped.push({
        name: profile.name,
        reason: `name conflict, skipped (use --overwrite): ${profile.name}`,
      });
      continue;
    }

    const aiftpProtocol = profile.protocol === 'ftp' ? 'ftp' : 'ftps';
    const ftpsMode = profile.protocol.startsWith('ftps_')
      ? profile.protocol === 'ftps_explicit'
        ? 'explicit'
        : 'implicit'
      : undefined;
    const port = profile.port || (profile.protocol === 'ftps_implicit' ? 990 : 21);
    const keychainService = `${keychainPrefix}:${profile.name}`;
    const lines: string[] = [
      '',
      `[profile.${profile.name}]`,
      `host = ${JSON.stringify(profile.host)}`,
      `port = ${port}`,
      `protocol = ${JSON.stringify(aiftpProtocol)}`,
      `user = ${JSON.stringify(profile.user)}`,
      `remote_root = ${JSON.stringify(profile.remote_root)}`,
      'local_root = "."',
      `keychain_service = ${JSON.stringify(keychainService)}`,
      'server_kind = "generic"',
    ];
    if (ftpsMode) lines.push(`ftps_mode = ${JSON.stringify(ftpsMode)}`);
    if (profile.passive_mode === true) lines.push('passive_mode = true');
    if (profile.passive_mode === false) lines.push('passive_mode = false');
    if (profile.account) lines.push(`account = ${JSON.stringify(profile.account)}`);

    const passwordValue =
      profile.password.kind === 'plaintext' || profile.password.kind === 'encoded'
        ? profile.password.value
        : null;

    queued.push({
      name: profile.name,
      lines,
      keychainService,
      user: profile.user,
      passwordValue,
      warnings: profile.warnings,
      isOverwrite: conflict,
    });
  }

  if (dryRun) {
    stdout(`dry-run mode: would import ${queued.length} profile(s), skipped ${skipped.length}`);
    for (const entry of queued) {
      stdout(
        `would create [profile.${entry.name}] host=${entry.lines
          .find((l) => l.startsWith('host = '))
          ?.replace(/^host = "?|"?$/gu, '')} user=${entry.user} password=***`,
      );
      for (const w of entry.warnings) stdout(`  warning: ${w}`);
    }
    for (const s of skipped) stdout(`  skipped: ${s.reason}`);
    return;
  }

  let source = await readFile(tomlPath, 'utf8');
  for (const entry of queued) {
    if (entry.isOverwrite) {
      source = removeProfileBlock(source, entry.name);
    }
  }
  if (queued.some((e) => e.isOverwrite)) {
    await writeFile(tomlPath, source, 'utf8');
  }

  const appendChunk = queued.flatMap((e) => e.lines).join('\n');
  if (appendChunk.length > 0) {
    const prefix = source.endsWith('\n') ? '' : '\n';
    await appendFile(tomlPath, `${prefix}${appendChunk}\n`, 'utf8');
  }

  for (const entry of queued) {
    if (entry.passwordValue !== null) {
      await keychain.setPassword(entry.keychainService, entry.user, entry.passwordValue);
    }
  }

  stdout(
    `imported ${queued.length} profile(s), skipped ${skipped.length}, warnings ${result.warnings.length}`,
  );
  for (const s of skipped) stdout(`  skipped: ${s.reason}`);
  for (const w of result.warnings) stdout(`  warning: ${w}`);
  for (const entry of queued) for (const w of entry.warnings) stdout(`  warning: ${w}`);
}

export function createCli(options: CliOptions = {}): Command {
  const cwd = options.cwd ?? process.cwd();
  const prompt = options.prompt ?? defaultPrompt;
  const keychain = options.keychain ?? defaultKeychain();
  const runtime = options.runtime ?? {};
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));

  const program = new Command();
  program.name('aiftp').description('AI-first FTP/FTPS deploy tool').version(VERSION);
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => stdout(text.trimEnd()),
    writeErr: (text) => stderr(text.trimEnd()),
  });

  program
    .command('init')
    .description('Create .aiftp.toml and register credentials')
    .option('-f, --force', 'overwrite an existing .aiftp.toml')
    .option('--template <id>', 'apply a built-in template, or use "list" to show templates')
    .action(async (cmd: InitCommandOptions) => {
      if (cmd.template === 'list') {
        for (const template of listTemplates()) {
          stderr(`${template.id} - ${template.description}`);
        }
        return;
      }

      const template =
        cmd.template === undefined || cmd.template.length === 0
          ? undefined
          : getTemplate(cmd.template);
      if (cmd.template !== undefined && !template) {
        const message = `unknown-template: ${cmd.template}. Run "aiftp init --template list" to see available templates.`;
        stderr(message);
        throw new CommanderError(1, 'aiftp.unknown-template', message);
      }

      const configPath = join(cwd, '.aiftp.toml');
      if ((await exists(configPath)) && !cmd.force) {
        throw new Error('.aiftp.toml already exists. Use --force to overwrite.');
      }

      // v0.11 Pillar α: init prompts now go through PromptFlow, which adds
      // input hints (A) and :back navigation (B) on top of the existing
      // v0.10.4 summary review (C). Field definitions live in init-flow.ts
      // so they can be reused / extended for templates (v0.11 Pillar β).
      const flowResult = await new PromptFlow(
        buildInitFieldsWithTemplate(template !== undefined, template),
        {
          prompt: (question) => prompt(question as PromptQuestion),
          stderr,
        },
      ).run();
      if (flowResult.kind === 'cancelled') {
        throw new Error('aborted: init cancelled');
      }
      const selectedTemplateId = flowResult.answers['template-select'];
      const selectedTemplate =
        template ??
        (typeof selectedTemplateId === 'string' && selectedTemplateId !== 'none'
          ? getTemplate(selectedTemplateId)
          : undefined);
      if (
        template === undefined &&
        typeof selectedTemplateId === 'string' &&
        selectedTemplateId !== 'none' &&
        selectedTemplate === undefined
      ) {
        const message = `unknown-template: ${selectedTemplateId}. Run "aiftp init --template list" to see available templates.`;
        stderr(message);
        throw new CommanderError(1, 'aiftp.unknown-template', message);
      }
      let answers = parseInitAnswers(flowResult.answers);

      if (!answers.consent) {
        throw new Error('Explicit consent is required before initializing aiftp.');
      }

      if (!isStandardFtpPort(answers.port, answers.protocol)) {
        const standardDesc = answers.protocol === 'ftps' ? '21 or 990' : '21';
        const portConfirmation = await prompt([
          {
            type: 'confirm',
            name: 'confirmNonStandard',
            message: `Non-standard ${answers.protocol.toUpperCase()} port ${answers.port} (standard: ${standardDesc}). Continue?`,
            initial: false,
          },
        ]);
        if (portConfirmation.confirmNonStandard !== true) {
          throw new Error(
            `aborted: non-standard ${answers.protocol.toUpperCase()} port ${answers.port} was not confirmed`,
          );
        }
      }

      // v0.10.4 (#6/#7/#8 reflective patch, Codex Phase 1 review): summary review
      answers = await runInitSummaryReview(answers, prompt, stderr);

      if (answers.remoteRoot.startsWith('/')) {
        stderr(
          `Warning: remote_root starts with "/" (${answers.remoteRoot}). On shared hosts (StarServer / Lolipop / Sakura / Xserver) the actual upload root is often "/<your-domain>/public_html/..." or "/<your-user>/public_html/...". Confirm with your provider's FTP setup guide that the leading "/" is intended.`,
        );
      }

      if (answers.serverKind === 'starserver') {
        stderr(
          'Warning: server_kind = "starserver" — Star Server presents a *.star.ne.jp certificate for *.stars.ne.jp hostnames. aiftp will set [quirks].tls_check_hostname = false in your .aiftp.toml so the deploy works out of the box. The certificate chain itself is still verified.',
        );
      }

      await writeFile(configPath, renderConfig(answers, selectedTemplate), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await ensureGitignore(cwd);
      await keychain.setPassword(answers.keychainService, answers.user, answers.password);
      const backupKeyEntryService = backupKeyService(answers.keychainService);
      const backupKeyExists = await keychain.hasPassword(backupKeyEntryService, answers.profile);
      let overwriteBackupKey = false;
      if (backupKeyExists) {
        const confirmation = await prompt([
          {
            type: 'confirm',
            name: 'overwriteBackupKey',
            message:
              'Existing backup key will be overwritten. All previous encrypted backups will become unrecoverable. Continue?',
            initial: false,
          },
        ]);
        overwriteBackupKey = confirmation.overwriteBackupKey === true;
      }
      if (!backupKeyExists || overwriteBackupKey) {
        await keychain.setPassword(
          backupKeyEntryService,
          answers.profile,
          generateKey().toString('base64'),
        );
      }

      stdout(`Initialized aiftp profile ${answers.profile}`);
    });

  const auth = program.command('auth').description('Manage stored FTP credentials');

  auth
    .command('set')
    .description('Store credentials for a profile')
    .option('-p, --profile <name>', 'profile name', 'production')
    .action(async (cmd: { profile: string }) => {
      const profile = await loadProfile(cwd, cmd.profile);
      const answers = await prompt([
        { type: 'password', name: 'password', message: `FTP password for ${cmd.profile}` },
      ]);
      await keychain.setPassword(
        profile.keychain_service,
        profile.user,
        requireString(answers.password, 'password'),
      );
      stdout(`Updated credentials for ${cmd.profile}`);
    });

  auth
    .command('list')
    .description('List configured profiles and credential status')
    .action(async () => {
      const config = await loadConfig(join(cwd, '.aiftp.toml'));
      for (const [name, profile] of Object.entries(config.profile)) {
        const status = (await keychain.hasPassword(profile.keychain_service, profile.user))
          ? 'stored'
          : 'missing';
        stdout(`${name} ${profile.user} ${status}`);
      }
    });

  auth
    .command('delete')
    .description('Delete credentials for a profile')
    .option('-p, --profile <name>', 'profile name', 'production')
    .action(async (cmd: { profile: string }) => {
      const profile = await loadProfile(cwd, cmd.profile);
      await keychain.deletePassword(profile.keychain_service, profile.user);
      stdout(`Deleted credentials for ${cmd.profile}`);
    });

  program
    .command('status')
    .description('Show local deployment diff')
    .option('-p, --profile <name>', 'profile name', 'production')
    .option('--json', 'print JSON output')
    .action(async (cmd: { profile: string; json?: boolean }) => {
      const context = await loadStatusContext(cwd, cmd.profile);
      const result = await (runtime.runStatus ?? runStatus)(context);
      printStatus(stdout, result, cmd.json);
    });

  program
    .command('push')
    .description('Upload changed files')
    .option('-p, --profile <name>', 'profile name', 'production')
    .option('--dry-run', 'plan without uploading')
    .option('--json', 'print JSON output')
    .option('--only <paths...>', 'limit push to specific path(s)')
    .option('--yes', 'skip the interactive production-profile confirmation (use with care)')
    .action(
      async (cmd: {
        profile: string;
        dryRun?: boolean;
        json?: boolean;
        only?: string[];
        yes?: boolean;
      }) => {
        const config = await loadConfig(join(cwd, '.aiftp.toml'));
        const profile = config.profile[cmd.profile];
        if (!profile) {
          throw new Error(`Profile not found: ${cmd.profile}`);
        }
        // v0.6.0 #7: Always surface the deploy target before any FTP
        // activity. The point is that the operator (or AI agent) reading
        // the terminal can spot a typo'd profile or wrong host before
        // bytes leave the machine. Doctor-output style so it's grep-able.
        stderr(
          `push target: profile=${cmd.profile}  host=${profile.host}  remote_root=${profile.remote_root}`,
        );

        // Production profile confirmation gate. The check fires when:
        //   1. The profile name matches `safety.prod_profile_patterns`
        //      (glob, see core/src/safety.ts)
        //   2. Production warning is enabled (`safety.warn_on_prod_profile`)
        //   3. The push is NOT a dry-run (dry-run never mutates the
        //      server, so the prompt would just be noise)
        //   4. `--yes` is not present (operator opt-out)
        //
        // The prompt asks the operator to TYPE the profile name back.
        // A typed match is the contract — not just a y/N — so that
        // muscle memory ("y, enter, y, enter...") cannot accidentally
        // ship to production.
        const prodMatch = isProdProfile({
          profileName: cmd.profile,
          patterns: config.safety.prod_profile_patterns,
          warnEnabled: config.safety.warn_on_prod_profile,
        });
        if (prodMatch && !cmd.dryRun && !cmd.yes) {
          stderr(
            `⚠️  '${cmd.profile}' matches a production-profile pattern. Type the profile name to confirm (or rerun with --dry-run / --yes):`,
          );
          const typed = await prompt({
            type: 'text',
            name: 'confirmation',
            message: `Type "${cmd.profile}" to push:`,
          });
          if (typed.confirmation !== cmd.profile) {
            throw new Error(
              `Production push aborted: typed value did not match profile name "${cmd.profile}".`,
            );
          }
        }

        const context = await loadStatusContext(cwd, cmd.profile);
        const pushSafety: PushOptions['safety'] = {
          maxFilesPerPush: config.safety.max_files_per_push,
          maxTotalSizeBytes: config.safety.max_total_size_mb * 1024 * 1024,
          verifyAfterUpload: config.safety.verify_after_upload === 'off' ? 'off' : 'size',
          deletionPolicy: config.safety.deletion_policy,
        };
        let confirmDeletes = false;
        if (config.safety.deletion_policy === 'prune-with-confirm' && !cmd.dryRun) {
          const preview = await (runtime.runPush ?? runPush)({
            ...context,
            backupStore: dryRunBackupStore(),
            uploader: injectedRuntimeUploader(),
            remoteRoot: profile.remote_root,
            files: cmd.only,
            dryRun: true,
            safety: pushSafety,
            preflight: (paths) => checkAll(paths),
          });
          const previewDeletes = preview.plannedDeletes ?? [];
          if (previewDeletes.length > 0) {
            stderr(
              `⚠️  ${previewDeletes.length} remote delete(s) are planned. Type DELETE to confirm:`,
            );
            const typed = await prompt({
              type: 'text',
              name: 'deleteConfirmation',
              message: 'Type "DELETE" to delete remote files:',
            });
            if (typed.deleteConfirmation !== 'DELETE') {
              throw new Error('Delete confirmation aborted: typed value did not match "DELETE".');
            }
            confirmDeletes = true;
          }
        }
        const runtimeBackupStore = await runtime.createBackupStore?.({
          cwd,
          profileName: cmd.profile,
        });
        const runtimePushBackupStore = isPushBackupStore(runtimeBackupStore)
          ? runtimeBackupStore
          : undefined;
        const runtimeUploader = await runtime.createUploader?.({
          cwd,
          profileName: cmd.profile,
        });
        const needsDefaultFtp =
          !runtime.runPush &&
          !cmd.dryRun &&
          (runtimePushBackupStore === undefined || runtimeUploader === undefined);
        let sharedFtpClient: DeployClient | undefined;
        try {
          sharedFtpClient = needsDefaultFtp
            ? await createDefaultFtpClient(cwd, cmd.profile, keychain)
            : undefined;
          const backupStore =
            runtimePushBackupStore ??
            (cmd.dryRun
              ? dryRunBackupStore()
              : await createDefaultBackupStore({
                  cwd,
                  profileName: cmd.profile,
                  keychain,
                  ftpClient: sharedFtpClient,
                }));
          const managedUploader = await resolveManagedUploader(
            cwd,
            cmd.profile,
            cmd.dryRun,
            keychain,
            runtime,
            sharedFtpClient,
            runtimeUploader,
          );
          const result = await (runtime.runPush ?? runPush)({
            ...context,
            backupStore,
            uploader: managedUploader.uploader,
            remoteRoot: profile.remote_root,
            files: cmd.only,
            dryRun: cmd.dryRun === true,
            confirmDeletes,
            safety: pushSafety,
            preflight: (paths) => checkAll(paths),
          }).finally(() => managedUploader.close());
          const plannedDeletes = result.plannedDeletes ?? [];
          const deleted = result.deleted ?? [];

          if (!result.dryRun) {
            await saveState(stateDir(cwd, cmd.profile), result.nextState);
            await appendLogEntry(cwd, {
              at: new Date().toISOString(),
              event: 'push',
              profile: cmd.profile,
              uploaded: result.uploaded.length,
              deleted: deleted.length,
            });
          }

          if (cmd.json) {
            stdout(JSON.stringify(result));
          } else if (result.dryRun) {
            stdout(
              `Planned ${result.planned.length} upload(s), ${plannedDeletes.length} delete(s)`,
            );
          } else {
            stdout(`Uploaded ${result.uploaded.length} file(s), deleted ${deleted.length} file(s)`);
          }
        } finally {
          await sharedFtpClient?.disconnect();
        }
      },
    );

  // Note: `isProdProfile` import lands above; keeping it adjacent to where
  // it is consumed keeps the file scannable.

  program
    .command('log')
    .description('Show operation log')
    .option('--limit <n>', 'number of entries to show', '20')
    .action(async (cmd: { limit: string }) => {
      const limit = Number.parseInt(cmd.limit, 10);
      const entries = await readLogEntries(cwd);
      for (const entry of entries.slice(-limit)) {
        stdout(formatLogEntry(entry));
      }
    });

  const backup = program.command('backup').description('Manage encrypted backups');

  async function backupStoreFor(profileName: string): Promise<CliBackupStore> {
    return (
      (await runtime.createBackupStore?.({ cwd, profileName })) ??
      (await createDefaultBackupStore({ cwd, profileName, keychain }))
    );
  }

  backup
    .command('init')
    .description(
      'Initialize the backup environment for a profile (stores a fresh AES-256-GCM key in the OS keychain). Use this after hand-editing `.aiftp.toml` instead of running `aiftp init`. v0.9.4+',
    )
    .option('-p, --profile <name>', 'profile name', 'production')
    .option(
      '--force',
      'overwrite an existing backup key (destroys ability to decrypt prior snapshots)',
      false,
    )
    .action(async (cmd: { profile: string; force: boolean }) => {
      const config = await loadConfig(join(cwd, '.aiftp.toml'));
      const profile = config.profile[cmd.profile];
      if (!profile) {
        throw new Error(`Profile not found: ${cmd.profile}`);
      }
      const keychainServiceName = profile.keychain_service;
      const backupKeyEntryService = backupKeyService(keychainServiceName);
      const alreadyExists = await keychain.hasPassword(backupKeyEntryService, cmd.profile);
      if (alreadyExists && !cmd.force) {
        stdout(
          `Backup key for profile '${cmd.profile}' already exists in the keychain. Run with --force to overwrite (this will make previously-encrypted snapshots unrecoverable).`,
        );
        return;
      }
      await keychain.setPassword(
        backupKeyEntryService,
        cmd.profile,
        generateKey().toString('base64'),
      );
      stdout(
        `Initialized backup environment for profile '${cmd.profile}' (keychain service '${backupKeyEntryService}', account '${cmd.profile}').`,
      );
    });

  backup
    .command('list')
    .option('-p, --profile <name>', 'profile name', 'production')
    .action(async (cmd: { profile: string }) => {
      const store = await backupStoreFor(cmd.profile);
      for (const snapshot of await store.listSnapshots()) {
        stdout(
          `${snapshot.id} ${snapshot.type} ${snapshot.createdAt} files=${snapshot.fileCount} bytes=${snapshot.totalBytes}`,
        );
      }
    });

  backup
    .command('verify')
    .argument('<id>')
    .option('-p, --profile <name>', 'profile name', 'production')
    .action(async (id: string, cmd: { profile: string }) => {
      const report = await (await backupStoreFor(cmd.profile)).verify(id);
      stdout(`${id} ${report.ok ? 'ok' : 'failed'} checked=${report.checkedFiles}`);
      for (const error of report.errors) {
        stderr(error);
      }
    });

  backup
    .command('prune')
    .option('-p, --profile <name>', 'profile name', 'production')
    .option('--keep <n>', 'number of newest snapshots to keep', '30')
    .action(async (cmd: { profile: string; keep: string }) => {
      const keepCount = parseNonNegativeInteger(cmd.keep, '--keep');
      const deleted = await (await backupStoreFor(cmd.profile)).prune(keepCount);
      stdout(`Pruned ${deleted.length} snapshot(s)`);
    });

  backup
    .command('restore')
    .argument('<id>')
    .argument('<path>')
    .option('-p, --profile <name>', 'profile name', 'production')
    .requiredOption('--output <path>', 'local restore output path')
    .option('-f, --force', 'overwrite the --output file if it already exists')
    .action(
      async (
        id: string,
        path: string,
        cmd: { profile: string; output: string; force?: boolean },
      ) => {
        validateSnapshotIdArg(id);
        const output = restrictToProject(cwd, cmd.output);
        if (!cmd.force && (await exists(output))) {
          throw new Error(`--output ${cmd.output} already exists. Pass --force to overwrite.`);
        }
        const data = await (await backupStoreFor(cmd.profile)).restoreFile(id, path);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, data);
        stdout(`Restored ${path} to ${cmd.output}`);
      },
    );

  const configCmd = program.command('config').description('Manage .aiftp.toml');

  configCmd
    .command('migrate')
    .description('Migrate .aiftp.toml from schema v1 to v2')
    .option('--dry-run', 'Preview the migration without writing')
    .action(async (cmd: { dryRun?: boolean }) => {
      const configPath = join(cwd, '.aiftp.toml');
      const source = await readFile(configPath, 'utf8');
      const result = migrateV1ToV2Source(source);
      if (!result.changed) {
        stdout('Already at latest schema (schema = 2)');
        return;
      }
      if (cmd.dryRun) {
        stdout('Dry-run preview: schema = 1 -> schema = 2');
        stdout(result.source);
        return;
      }
      await loadConfig(configPath);
      stdout(
        'Migrated .aiftp.toml from schema 1 to schema 2. Original preserved as .aiftp.toml.v1.bak',
      );
    });

  program
    .command('doctor')
    .description('Diagnose aiftp configuration and connectivity')
    .option('-p, --profile <name>', 'profile name', 'production')
    .option('--json', 'emit raw DoctorReport as JSON')
    .action(async (cmd: { profile: string; json?: boolean }) => {
      const report = runtime.runDoctor
        ? await runtime.runDoctor({ cwd, profile: cmd.profile })
        : await defaultRunDoctor({ cwd, profile: cmd.profile });

      if (cmd.json) {
        stdout(JSON.stringify(report));
        return;
      }

      stdout(
        `summary: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} skip=${report.summary.skip}`,
      );
      for (const result of report.results) {
        stdout(`  ${result.id}: ${result.status} -- ${result.message}`);
      }

      if (!report.ok) {
        throw new Error(`aiftp doctor: diagnostic checks failed (fail=${report.summary.fail})`);
      }
    });

  const profileCmd = program
    .command('profile')
    .description('Manage aiftp profiles (export to/import from other tools)');

  // -------------------------------------------------------------------
  // profile list / current / use
  // -------------------------------------------------------------------

  profileCmd
    .command('list')
    .description('List configured profiles')
    .option('--json', 'emit JSON instead of a table')
    .action(async (cmd: { json?: boolean }) => {
      const config = await loadConfig(join(cwd, '.aiftp.toml'));
      const names = Object.keys(config.profile);
      const defaultName = await resolveDefaultProfile(cwd, { availableProfiles: names });
      const rows = await Promise.all(
        names.map(async (name) => {
          const profile = config.profile[name];
          if (!profile) return null;
          const credentialsPresent = await keychain.hasPassword(
            profile.keychain_service,
            profile.user,
          );
          return {
            name,
            host: profile.host,
            user: profile.user,
            protocol: profile.protocol,
            server_kind: profile.server_kind,
            credentialsPresent,
            isDefault: name === defaultName,
          };
        }),
      );
      const profiles = rows.filter((r): r is NonNullable<typeof r> => r !== null);

      if (cmd.json) {
        stdout(JSON.stringify({ schema: 1, profiles }));
        return;
      }
      stdout(
        'NAME              HOST                          USER        PROTOCOL  CREDS    DEFAULT',
      );
      for (const p of profiles) {
        const creds = p.credentialsPresent ? 'ok     ' : 'missing';
        const def = p.isDefault ? '*' : ' ';
        stdout(
          `${p.name.padEnd(18)}${p.host.padEnd(30)}${p.user.padEnd(12)}${p.protocol.padEnd(10)}${creds}  ${def}`,
        );
      }
    });

  profileCmd
    .command('current')
    .description('Show the resolved default profile')
    .action(async () => {
      const config = await loadConfig(join(cwd, '.aiftp.toml'));
      const names = Object.keys(config.profile);
      const defaultName = await resolveDefaultProfile(cwd, { availableProfiles: names });
      if (defaultName === null) {
        stdout(
          'no default profile pinned (ambiguous). Use `aiftp profile use <name>` to pick one, or set the AIFTP_PROFILE environment variable.',
        );
        return;
      }
      stdout(defaultName);
    });

  profileCmd
    .command('use')
    .description('Set the workspace default profile')
    .argument('<name>')
    .action(async (name: string) => {
      const config = await loadConfig(join(cwd, '.aiftp.toml'));
      if (!config.profile[name]) {
        throw new Error(`Profile not found: ${name}`);
      }
      await saveDefaultProfile(cwd, name);
      stdout(`default profile set to ${name}`);
    });

  // -------------------------------------------------------------------
  // profile add / edit
  // -------------------------------------------------------------------

  profileCmd
    .command('add')
    .description('Add a new profile to the existing .aiftp.toml')
    .argument('<name>')
    .action(async (name: string) => {
      if (!isValidProfileName(name)) {
        throw new Error(
          `Invalid profile name: ${JSON.stringify(name)}. Use kebab-case (a-z, 0-9, "-").`,
        );
      }
      const tomlPath = join(cwd, '.aiftp.toml');
      const config = await loadConfig(tomlPath);
      if (config.profile[name]) {
        throw new Error(`Profile already exists: ${name}`);
      }
      const raw = await prompt([
        { type: 'text', name: 'host', message: 'FTP host' },
        { type: 'number', name: 'port', message: 'FTP port', initial: 21 },
        {
          type: 'select',
          name: 'protocol',
          message: 'Protocol',
          choices: [
            { title: 'FTPS', value: 'ftps' },
            { title: 'FTP', value: 'ftp' },
          ],
        },
        { type: 'text', name: 'user', message: 'FTP user' },
        { type: 'text', name: 'remoteRoot', message: 'Remote root', initial: '/' },
        { type: 'text', name: 'localRoot', message: 'Local root', initial: '.' },
        {
          type: 'text',
          name: 'keychainService',
          message: 'Keychain service',
          initial: `aiftp:${name}`,
        },
        {
          type: 'select',
          name: 'serverKind',
          message: 'Server kind',
          choices: [
            { title: 'StarServer', value: 'starserver' },
            { title: 'Lolipop', value: 'lolipop' },
            { title: 'Sakura', value: 'sakura' },
            { title: 'Xserver', value: 'xserver' },
            { title: 'Generic', value: 'generic' },
          ],
        },
        { type: 'password', name: 'password', message: 'FTP password' },
      ]);
      const fields: ProfileBlockFields = {
        host: requireString(raw.host, 'host'),
        port: requireNumber(raw.port, 'port'),
        protocol: requireString(raw.protocol, 'protocol') as 'ftp' | 'ftps',
        user: requireString(raw.user, 'user'),
        remote_root: requireString(raw.remoteRoot, 'remoteRoot'),
        local_root: requireString(raw.localRoot, 'localRoot'),
        keychain_service: requireString(raw.keychainService, 'keychainService'),
        server_kind: requireString(
          raw.serverKind,
          'serverKind',
        ) as ProfileBlockFields['server_kind'],
      };
      const source = await readFile(tomlPath, 'utf8');
      const updated = appendProfileBlock(source, name, fields);
      await writeFile(tomlPath, updated, { encoding: 'utf8', mode: 0o600 });
      await keychain.setPassword(
        fields.keychain_service,
        fields.user,
        requireString(raw.password, 'password'),
      );
      stdout(`added profile ${name}`);
    });

  profileCmd
    .command('edit')
    .description('Edit a single field of an existing profile')
    .argument('<name>')
    .action(async (name: string) => {
      const tomlPath = join(cwd, '.aiftp.toml');
      const config = await loadConfig(tomlPath);
      if (!config.profile[name]) {
        throw new Error(`Profile not found: ${name}`);
      }
      const raw = await prompt([
        {
          type: 'select',
          name: 'field',
          message: 'Which field to edit?',
          choices: [
            { title: 'host', value: 'host' },
            { title: 'port', value: 'port' },
            { title: 'protocol', value: 'protocol' },
            { title: 'user', value: 'user' },
            { title: 'remote_root', value: 'remote_root' },
            { title: 'local_root', value: 'local_root' },
            { title: 'keychain_service', value: 'keychain_service' },
            { title: 'server_kind', value: 'server_kind' },
          ],
        },
        { type: 'text', name: 'value', message: 'New value' },
      ]);
      const field = requireString(raw.field, 'field');
      const value = requireString(raw.value, 'value');
      const source = await readFile(tomlPath, 'utf8');
      // String fields go through JSON.stringify for safe quoting; numeric/
      // boolean field literals are passed through verbatim.
      const literal = field === 'port' ? value : JSON.stringify(value);
      const updated = setProfileField(source, name, field, literal);
      await writeFile(tomlPath, updated, { encoding: 'utf8', mode: 0o600 });
      stdout(`updated [profile.${name}].${field}`);
    });

  // -------------------------------------------------------------------
  // profile rename / duplicate / remove
  // -------------------------------------------------------------------

  profileCmd
    .command('rename')
    .description('Rename a profile (config + Keychain entries)')
    .argument('<old>')
    .argument('<new>')
    .action(async (oldName: string, newName: string) => {
      if (!isValidProfileName(newName)) {
        throw new Error(
          `Invalid profile name: ${JSON.stringify(newName)}. Use kebab-case (a-z, 0-9, "-").`,
        );
      }
      const tomlPath = join(cwd, '.aiftp.toml');
      const config = await loadConfig(tomlPath);
      const profile = config.profile[oldName];
      if (!profile) {
        throw new Error(`Profile not found: ${oldName}`);
      }
      if (config.profile[newName]) {
        throw new Error(`Profile already exists: ${newName}`);
      }
      // Keychain follow: copy password + backup-key to a new service name
      // (we use the same suffix scheme: aiftp:<profile>), then update TOML,
      // then delete the old entries. If TOML write fails between copy and
      // delete, the new entries are removed so the operator is not left
      // with stale credentials they cannot enumerate from the config.
      const oldService = profile.keychain_service;
      const newService = oldService.includes(oldName)
        ? oldService.replace(oldName, newName)
        : `${oldService}:${newName}`;
      const backupOldService = `${oldService}:backup-key`;
      const backupNewService = `${newService}:backup-key`;

      const pw = await keychain.getPassword(oldService, profile.user).catch(() => null);
      const backupKey = (await keychain.hasPassword(backupOldService, oldName))
        ? await keychain.getPassword(backupOldService, oldName).catch(() => null)
        : null;

      if (pw !== null) await keychain.setPassword(newService, profile.user, pw);
      if (backupKey !== null) await keychain.setPassword(backupNewService, newName, backupKey);

      const source = await readFile(tomlPath, 'utf8');
      let updated = renameProfileBlock(source, oldName, newName);
      // Also rewrite keychain_service to point at the new name.
      updated = setProfileField(updated, newName, 'keychain_service', JSON.stringify(newService));
      await writeFile(tomlPath, updated, { encoding: 'utf8', mode: 0o600 });

      // Best-effort cleanup of the old Keychain entries.
      await keychain.deletePassword(oldService, profile.user).catch(() => undefined);
      if (backupKey !== null) {
        await keychain.deletePassword(backupOldService, oldName).catch(() => undefined);
      }

      stdout(`renamed profile ${oldName} -> ${newName}`);
    });

  profileCmd
    .command('duplicate')
    .description('Clone a profile to a new name (credentials are NOT copied by default)')
    .argument('<src>')
    .argument('<new>')
    .option('--copy-credentials', 'also copy the password from Keychain to the new profile')
    .action(async (src: string, newName: string, cmd: { copyCredentials?: boolean }) => {
      if (!isValidProfileName(newName)) {
        throw new Error(
          `Invalid profile name: ${JSON.stringify(newName)}. Use kebab-case (a-z, 0-9, "-").`,
        );
      }
      const tomlPath = join(cwd, '.aiftp.toml');
      const config = await loadConfig(tomlPath);
      const srcProfile = config.profile[src];
      if (!srcProfile) {
        throw new Error(`Profile not found: ${src}`);
      }
      if (config.profile[newName]) {
        throw new Error(`Profile already exists: ${newName}`);
      }
      const newService = srcProfile.keychain_service.includes(src)
        ? srcProfile.keychain_service.replace(src, newName)
        : `${srcProfile.keychain_service}:${newName}`;
      const fields: ProfileBlockFields = {
        host: srcProfile.host,
        port: srcProfile.port,
        protocol: srcProfile.protocol,
        user: srcProfile.user,
        remote_root: srcProfile.remote_root,
        local_root: srcProfile.local_root,
        keychain_service: newService,
        server_kind: srcProfile.server_kind,
      };
      if (srcProfile.account) fields.account = srcProfile.account;
      if (srcProfile.ftps_mode) fields.ftps_mode = srcProfile.ftps_mode;
      if (srcProfile.passive_mode !== undefined) fields.passive_mode = srcProfile.passive_mode;
      const source = await readFile(tomlPath, 'utf8');
      const updated = appendProfileBlock(source, newName, fields);
      await writeFile(tomlPath, updated, { encoding: 'utf8', mode: 0o600 });

      if (cmd.copyCredentials) {
        const pw = await keychain
          .getPassword(srcProfile.keychain_service, srcProfile.user)
          .catch(() => null);
        if (pw !== null) {
          await keychain.setPassword(newService, srcProfile.user, pw);
          stdout(`duplicated profile ${src} -> ${newName} (credentials copied)`);
          return;
        }
      }
      stdout(
        `duplicated profile ${src} -> ${newName}. Run \`aiftp auth set --profile ${newName}\` to store its password.`,
      );
    });

  profileCmd
    .command('remove')
    .description('Remove a profile (config + Keychain by default)')
    .argument('<name>')
    .option('--yes', 'skip the interactive confirmation prompt')
    .option('--keep-credentials', 'preserve Keychain entries (only remove the config block)')
    .action(async (name: string, cmd: { yes?: boolean; keepCredentials?: boolean }) => {
      const tomlPath = join(cwd, '.aiftp.toml');
      const config = await loadConfig(tomlPath);
      const profile = config.profile[name];
      if (!profile) {
        throw new Error(`Profile not found: ${name}`);
      }
      let keepCredentials = cmd.keepCredentials === true;
      if (!cmd.yes) {
        const answer = await prompt([
          {
            type: 'text',
            name: 'confirmName',
            message: `Type "${name}" to confirm removal`,
          },
          {
            type: 'select',
            name: 'action',
            message: 'Also delete Keychain entries?',
            choices: [
              { title: 'Delete config + Keychain (full removal)', value: 'delete' },
              { title: 'Delete config only, keep Keychain', value: 'keep' },
              { title: 'Abort', value: 'abort' },
            ],
          },
        ]);
        const confirmName = typeof answer.confirmName === 'string' ? answer.confirmName : '';
        const action = typeof answer.action === 'string' ? answer.action : 'abort';
        if (confirmName !== name || action === 'abort') {
          throw new Error('aborted: profile name did not match or action was cancelled');
        }
        if (action === 'keep') {
          keepCredentials = true;
        }
      }

      const source = await readFile(tomlPath, 'utf8');
      const updated = removeProfileBlock(source, name);
      await writeFile(tomlPath, updated, { encoding: 'utf8', mode: 0o600 });

      if (!keepCredentials) {
        await keychain
          .deletePassword(profile.keychain_service, profile.user)
          .catch(() => undefined);
        const backupService = `${profile.keychain_service}:backup-key`;
        if (await keychain.hasPassword(backupService, name).catch(() => false)) {
          await keychain.deletePassword(backupService, name).catch(() => undefined);
        }
      }
      stdout(`removed profile ${name}`);
    });

  // -------------------------------------------------------------------
  // profile test (doctor subset)
  // -------------------------------------------------------------------

  profileCmd
    .command('test')
    .description('Run a connection-only subset of `aiftp doctor` against a profile')
    .option('-p, --profile <name>', 'profile name', 'production')
    .option('--json', 'emit JSON instead of a table')
    .action(async (cmd: { profile: string; json?: boolean }) => {
      const report = runtime.runDoctor
        ? await runtime.runDoctor({ cwd, profile: cmd.profile })
        : await defaultRunDoctor({ cwd, profile: cmd.profile });
      const subset = report.results.filter((r) =>
        ['keychain', 'dns', 'tcp', 'ftps-handshake', 'ftps-cert', 'remote-root'].includes(r.id),
      );
      if (cmd.json) {
        stdout(JSON.stringify({ ...report, results: subset }));
        return;
      }
      for (const r of subset) {
        stdout(`  ${r.id}: ${r.status} -- ${r.message}`);
      }
      if (!report.ok) {
        throw new Error(`profile test: failed (fail=${report.summary.fail})`);
      }
    });

  profileCmd
    .command('export')
    .description("Export aiftp profiles to another tool's format")
    .argument('<format>', 'export format (currently: filezilla)')
    .requiredOption('-o, --output <path>', 'output file path')
    .option('-p, --profile <name>', 'restrict export to a single profile')
    .option(
      '--include-password',
      'embed credentials from Keychain in the output (default: empty Pass)',
    )
    .action(
      async (
        format: string,
        cmd: { output: string; profile?: string; includePassword?: boolean },
      ) => {
        if (format !== 'filezilla') {
          throw new Error(`Unsupported export format: ${format} (only 'filezilla' is supported)`);
        }
        const outputPath = restrictToProject(cwd, cmd.output);
        const config = await loadConfig(join(cwd, '.aiftp.toml'));
        const entries = Object.entries(config.profile).filter(
          ([name]) => cmd.profile === undefined || name === cmd.profile,
        );
        if (entries.length === 0) {
          throw new Error(
            cmd.profile ? `Profile not found: ${cmd.profile}` : 'No profiles found in .aiftp.toml',
          );
        }

        const exportProfiles: ExportProfile[] = [];
        for (const [name, profile] of entries) {
          if (!profile) continue;
          const protocol = profile.ftps_mode
            ? profile.ftps_mode === 'explicit'
              ? 'ftps_explicit'
              : 'ftps_implicit'
            : profile.protocol === 'ftps'
              ? 'ftps_explicit'
              : 'ftp';
          let password: string | undefined;
          if (cmd.includePassword) {
            try {
              password = await keychain.getPassword(profile.keychain_service, profile.user);
            } catch {
              stdout(`  warning: could not fetch password for ${name} from Keychain (no entry?)`);
            }
          }
          exportProfiles.push({
            name,
            host: profile.host,
            port: profile.port,
            protocol,
            user: profile.user,
            account: profile.account,
            passive_mode: profile.passive_mode,
            encoding: config.encoding?.file_name,
            remote_root: profile.remote_root,
            password,
          });
        }

        if (cmd.includePassword) {
          stdout(
            'warning: --include-password embeds sensitive credentials in the XML; treat the output file as a secret.',
          );
        }
        const xml = renderFilezillaXml(exportProfiles, {
          includePassword: cmd.includePassword === true,
        });
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, xml, { encoding: 'utf8', mode: 0o600 });
        stdout(`wrote ${exportProfiles.length} profile(s) to ${cmd.output}`);
      },
    );

  const importCmd = program.command('import').description('Import settings from other tools');
  importCmd
    .command('filezilla')
    .description('Import profiles from a FileZilla sitemanager.xml')
    .argument('<path>', 'path to sitemanager.xml')
    .option('--dry-run', 'preview the import without writing')
    .option('--overwrite', 'replace existing profiles with the same name')
    .option(
      '--keychain-prefix <prefix>',
      'Keychain service prefix used for imported credentials',
      'aiftp:imported',
    )
    .action(
      async (
        xmlPath: string,
        cmd: { dryRun?: boolean; overwrite?: boolean; keychainPrefix: string },
      ) => {
        await runImportFilezilla({
          cwd,
          xmlPath,
          dryRun: cmd.dryRun === true,
          overwrite: cmd.overwrite === true,
          keychainPrefix: cmd.keychainPrefix,
          stdout,
          keychain,
        });
      },
    );

  importCmd
    .command('ffftp')
    .description('Import profiles from an FFFTP ffftp.ini (Shift_JIS supported via iconv-lite)')
    .argument('<path>', 'path to ffftp.ini (typically %APPDATA%/FFFTP/ffftp.ini on Windows)')
    .option('--dry-run', 'preview the import without writing')
    .option('--overwrite', 'replace existing profiles with the same name')
    .option(
      '--keychain-prefix <prefix>',
      'Keychain service prefix used for imported credentials',
      'aiftp:imported',
    )
    .action(
      async (
        iniPath: string,
        cmd: { dryRun?: boolean; overwrite?: boolean; keychainPrefix: string },
      ) => {
        await runImportFfftp({
          cwd,
          iniPath,
          dryRun: cmd.dryRun === true,
          overwrite: cmd.overwrite === true,
          keychainPrefix: cmd.keychainPrefix,
          stdout,
          keychain,
        });
        // FFFTP passwords are not decrypted; the operator must set them
        // separately via Keychain. Surface the next-step instruction so
        // the import doesn't feel "half done".
        if (cmd.dryRun !== true) {
          stdout(
            'Note: FFFTP passwords are encrypted with a non-standard scheme and were NOT imported. Run `aiftp auth <profile>` to set each password in Keychain.',
          );
        }
      },
    );

  program
    .command('ls')
    .description('List a remote FTP directory (read-only diagnostic for exploring the server)')
    .argument('[remote-path]', 'remote path to list', '/')
    .option('-p, --profile <name>', 'profile name', 'production')
    .option('--long', 'include file size, type, and modified time')
    .action(async (remotePath: string, cmd: { profile: string; long?: boolean }) => {
      const client = await createDefaultFtpClient(cwd, cmd.profile, keychain);
      try {
        const entries = await client.list(remotePath);
        if (entries.length === 0) {
          stdout(`(empty: ${remotePath})`);
          return;
        }
        for (const entry of entries) {
          if (cmd.long) {
            const kind = entry.type === 'directory' ? 'd' : entry.type === 'file' ? '-' : '?';
            const mtime = entry.modifiedAt
              ? entry.modifiedAt.toISOString()
              : '                    ';
            stdout(`${kind} ${String(entry.size).padStart(12)} ${mtime} ${entry.name}`);
          } else {
            stdout(entry.type === 'directory' ? `${entry.name}/` : entry.name);
          }
        }
      } finally {
        await client.disconnect().catch(() => undefined);
      }
    });

  program
    .command('rollback')
    .description('Rollback the last N push(es): uploads a snapshot back to the FTP server')
    .option(
      '-p, --profile <name>',
      'profile name (default: resolved via AIFTP_PROFILE / state file / sole profile)',
    )
    .option('--steps <n>', 'undo the N-th most recent push (default 1)', (v: string) =>
      Number.parseInt(v, 10),
    )
    .option('--snapshot-id <id>', 'explicit snapshot id from `aiftp backup list`')
    .option('--dry-run', 'preview the rollback without uploading')
    .action(
      async (cmd: {
        profile?: string;
        steps?: number;
        snapshotId?: string;
        dryRun?: boolean;
      }) => {
        if (cmd.steps === undefined && !cmd.snapshotId) {
          throw new Error(
            'aiftp rollback requires either --steps <n> or --snapshot-id <id>. See `aiftp backup list` for snapshot ids.',
          );
        }
        // Claude+Codex review: both specified is ambiguous (snapshotId
        // would silently win, steps would be ignored). Hard refuse so
        // the operator picks intentionally.
        if (cmd.steps !== undefined && cmd.snapshotId) {
          throw new Error(
            'aiftp rollback: --steps and --snapshot-id are mutually exclusive (pick one).',
          );
        }
        const config = await loadConfig(join(cwd, '.aiftp.toml'));
        const available = Object.keys(config.profile);
        const profileName =
          cmd.profile ?? (await resolveDefaultProfile(cwd, { availableProfiles: available }));
        if (!profileName) {
          throw new Error(
            'Could not resolve a default profile. Pass --profile, set AIFTP_PROFILE, or run `aiftp profile use <name>`.',
          );
        }
        if (!config.profile[profileName]) {
          throw new Error(`Profile not found: ${profileName}`);
        }
        const dryRun = cmd.dryRun === true;
        const cliOptions: CliRollbackOptions = {
          cwd,
          profile: profileName,
          steps: cmd.steps,
          snapshotId: cmd.snapshotId,
          dryRun,
        };
        // Codex MEDIUM review: thread the injected keychain into the
        // default runner so test environments don't fall through to the
        // OS Keychain. The runtime hook (if injected) takes precedence.
        const runner =
          runtime.runRollback ?? ((opts: CliRollbackOptions) => defaultRunRollback(opts, keychain));
        const result = await runner(cliOptions);
        if (result.dryRun) {
          const plannedDeletes = result.plannedDeletes ?? [];
          const deleteSummary =
            plannedDeletes.length > 0 ? `, ${plannedDeletes.length} file(s) would be deleted` : '';
          stdout(
            `Dry-run rollback to snapshot ${result.snapshotId}: ${result.planned.length} file(s) would be uploaded${deleteSummary}.`,
          );
          writeDryRunPathSection(stdout, 'Uploads', result.planned);
          writeDryRunPathSection(stdout, 'Deletes', plannedDeletes);
        } else {
          const deleted = result.deleted ?? [];
          stdout(
            `Rollback to snapshot ${result.snapshotId}: ${result.rolledBack.length} file(s) uploaded, ${deleted.length} file(s) deleted.`,
          );
          // Non-dry-run: show what WAS uploaded (rolledBack, sorted by
          // path so failures don't leave us reporting wrong file names).
          for (const r of result.rolledBack) {
            stdout(`  + ${r.path}`);
          }
          for (const r of deleted) {
            stdout(`  - ${r.path}`);
          }
          await saveState(stateDir(cwd, profileName), result.nextState);
        }
        if (result.skipped.length > 0) {
          stdout('');
          stdout(
            `${result.skipped.length} file(s) skipped (hard-exclude protection — auth credentials are never re-uploaded):`,
          );
          for (const skip of result.skipped) {
            stdout(`  - ${skip.path}    ${skip.reason ?? skip.status}`);
          }
        }
      },
    );

  program
    .command('hook')
    .description(
      'Claude Code PostToolUse hook handler — reads JSON from stdin, runs dry-run status notification. v0.9.0 #5.',
    )
    .option('-p, --profile <name>', 'profile name (default: resolved via env/state/sole)')
    .action(async (cmd: { profile?: string }) => {
      // v0.9.1 fix (Codex MEDIUM): bound stdin reads in BOTH size and
      // time. The previous loop would hang forever if the hook invoker
      // forgot to close the pipe, and would happily OOM on a runaway
      // producer. 10 MB / 10 s are well beyond any realistic Claude
      // Code PostToolUse payload (a few KB at most) but small enough
      // that pathological input cannot wedge the agent's tool-use
      // feedback loop.
      const MAX_STDIN_BYTES = 10 * 1024 * 1024;
      const STDIN_TIMEOUT_MS = 10_000;
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const readPromise = (async () => {
        for await (const chunk of process.stdin) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          totalBytes += buf.length;
          if (totalBytes > MAX_STDIN_BYTES) {
            throw new Error(
              `hook stdin exceeded ${MAX_STDIN_BYTES} bytes — ignoring runaway producer.`,
            );
          }
          chunks.push(buf);
        }
      })();
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `hook stdin idle for ${STDIN_TIMEOUT_MS}ms — assuming the invoker forgot to close the pipe.`,
            ),
          );
        }, STDIN_TIMEOUT_MS);
      });
      try {
        await Promise.race([readPromise, timeoutPromise]);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        stderr(`aiftp hook: ${msg}`);
        return;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        stderr('aiftp hook: expected Claude Code PostToolUse JSON on stdin.');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        stderr(`aiftp hook: malformed JSON payload (${msg}). Ignoring.`);
        return;
      }
      const extracted = extractHookPaths(parsed);
      if (extracted.reason !== 'extracted') return; // silent for Bash/Read/etc.
      const projectRelative = relativizeIntoProject(cwd, extracted.paths);
      if (projectRelative.length === 0) return;
      try {
        const config = await loadConfig(join(cwd, '.aiftp.toml'));
        const available = Object.keys(config.profile);
        const profileName =
          cmd.profile ?? (await resolveDefaultProfile(cwd, { availableProfiles: available }));
        if (!profileName || !config.profile[profileName]) return;
        const context = await loadStatusContext(cwd, profileName);
        const status = await (runtime.runStatus ?? runStatus)(context);
        if (status.counts.added + status.counts.modified + status.counts.removed === 0) {
          return;
        }
        stderr(
          `[aiftp:${profileName}] status: +${status.counts.added} ~${status.counts.modified} -${status.counts.removed} (dry-run — run \`aiftp push\` to apply)`,
        );
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        stderr(`aiftp hook: status failed (${msg}). Ignoring.`);
      }
    });

  program
    .command('watch')
    .description(
      'Watch localRoot and notify (dry-run) on file changes — NEVER auto-pushes (spec §17.6 #4)',
    )
    .option(
      '-p, --profile <name>',
      'profile name (default: resolved via AIFTP_PROFILE / state / sole)',
    )
    .option('--debounce-ms <n>', 'debounce window in ms (default 500)', (v: string) =>
      Number.parseInt(v, 10),
    )
    .option('--max-wait-ms <n>', 'max wait for a burst in ms (default 5000)', (v: string) =>
      Number.parseInt(v, 10),
    )
    .action(async (cmd: { profile?: string; debounceMs?: number; maxWaitMs?: number }) => {
      const config = await loadConfig(join(cwd, '.aiftp.toml'));
      const available = Object.keys(config.profile);
      const profileName =
        cmd.profile ?? (await resolveDefaultProfile(cwd, { availableProfiles: available }));
      if (!profileName) {
        throw new Error(
          'Could not resolve a default profile. Pass --profile, set AIFTP_PROFILE, or run `aiftp profile use <name>`.',
        );
      }
      const profile = config.profile[profileName];
      if (!profile) {
        throw new Error(`Profile not found: ${profileName}`);
      }
      const localRoot = isAbsolute(profile.local_root)
        ? profile.local_root
        : join(cwd, profile.local_root);
      stdout(
        `Watching ${localRoot} for ${profileName} (dry-run notifications only — aiftp watch never auto-pushes).`,
      );

      // v0.8.0 #4: chokidar would be more reliable across platforms,
      // but Node 22+'s recursive fs.watch is good enough for the MVP
      // and keeps deps minimal. Excludes `.aiftp/` so backup-snapshot
      // writes don't trigger themselves.
      const { watch: fsWatch } = await import('node:fs');
      const debouncer = createWatchDebouncer(
        async (events) => {
          const paths = events.map((e) => e.path).slice(0, 10);
          const more =
            events.length > paths.length ? ` (+${events.length - paths.length} more)` : '';
          stderr(
            `[${new Date().toISOString()}] watch: ${events.length} change(s): ${paths.join(', ')}${more}`,
          );
          try {
            const context = await loadStatusContext(cwd, profileName);
            const status = await (runtime.runStatus ?? runStatus)(context);
            stdout(
              `  → status: +${status.counts.added} ~${status.counts.modified} -${status.counts.removed}`,
            );
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            stderr(`  → status failed: ${msg}`);
          }
        },
        { debounceMs: cmd.debounceMs ?? 500, maxWaitMs: cmd.maxWaitMs ?? 5000 },
      );

      const watcher = fsWatch(localRoot, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = filename.toString();
        // Skip aiftp's own metadata writes to avoid feedback loops.
        if (rel.startsWith('.aiftp/') || rel === '.aiftp' || rel.startsWith('.aiftp\\')) return;
        debouncer.push({
          path: rel,
          at: Date.now(),
          kind: eventType === 'rename' ? 'add' : 'change',
        });
      });

      // Keep the process alive until SIGINT.
      await new Promise<void>((resolveWatch) => {
        process.once('SIGINT', () => {
          watcher.close();
          debouncer.flush();
          debouncer.dispose();
          resolveWatch();
        });
      });
    });

  program
    .command('mcp')
    .description('Start the aiftp MCP server over stdio')
    .action(async () => {
      await (runtime.startMcp ?? defaultStartMcp)({ cwd });
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  try {
    await createCli().parseAsync(argv, { from: 'node' });
  } catch (error: unknown) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return;
    }
    throw error;
  }
}
