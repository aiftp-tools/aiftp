import { lookup } from 'node:dns/promises';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  type DeployUploader,
  type DoctorReport,
  type ExportProfile,
  FtpClient,
  type PushOptions,
  type PushResult,
  type SnapshotMeta,
  type StatusOptions,
  type StatusResult,
  VERSION,
  type VerifyResult,
  backupKeyService,
  checkAll,
  createDefaultBackupStore,
  createExcluder,
  deletePassword,
  generateKey,
  getPassword,
  hasPassword,
  isValidSnapshotId,
  loadConfig,
  loadState,
  migrateV1ToV2Source,
  parseFilezillaXml,
  probeFtps,
  renderFilezillaXml,
  runDoctor as runCoreDoctor,
  runPush,
  runStatus,
  saveState,
  setPassword,
} from '@aiftp-tools/core';
import { Command, CommanderError } from 'commander';
import prompts from 'prompts';

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
  return prompts(questions) as Promise<Record<string, unknown>>;
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

function renderConfig(answers: InitAnswers): string {
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
  return {
    profile: requireString(raw.profile, 'profile'),
    host: requireString(raw.host, 'host'),
    port: requireNumber(raw.port, 'port'),
    protocol: requireString(raw.protocol, 'protocol') as InitAnswers['protocol'],
    user: requireString(raw.user, 'user'),
    remoteRoot: requireString(raw.remoteRoot, 'remoteRoot'),
    localRoot: requireString(raw.localRoot, 'localRoot'),
    keychainService: requireString(raw.keychainService, 'keychainService'),
    serverKind: requireString(raw.serverKind, 'serverKind') as InitAnswers['serverKind'],
    password: requireString(raw.password, 'password'),
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
      userPatterns: [...DEFAULT_EXCLUDE_PATTERNS, ...config.exclude.patterns],
      additionalHardPatterns: config.backup.hard_exclude.additional_patterns,
    }),
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
  };
}

async function createDefaultFtpClient(
  cwd: string,
  profileName: string,
  keychain: CliKeychain,
): Promise<FtpClient> {
  const config = await loadConfig(join(cwd, '.aiftp.toml'));
  const profile = config.profile[profileName];
  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  const client = new FtpClient({
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password: await keychain.getPassword(profile.keychain_service, profile.user),
    protocol: profile.protocol,
    requireTls: config.safety.require_tls,
    verifyCertificate: config.safety.verify_certificate,
    timeoutMs: config.connection.timeout_ms,
  });
  await client.connect();
  return client;
}

function managedUploaderFromClient(client: FtpClient): ManagedUploader {
  return {
    uploader: {
      upload: (localPath, remotePath) => client.upload(localPath, remotePath),
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
  ftpClient?: FtpClient,
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
  ftpClient?: FtpClient,
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
  const mod = (await import('@aiftp-tools/mcp')) as unknown as {
    startStdioServer(options: { cwd?: string }): Promise<void>;
  };
  await mod.startStdioServer({ cwd: context.cwd });
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
        const client = new FtpClient({
          host: profile.host,
          port: profile.port,
          user: profile.user,
          password,
          protocol: profile.protocol,
          requireTls: true,
          // The probe is the one place we *want* to keep verification on so
          // a hostname mismatch surfaces as a hard error rather than
          // silently being accepted. Operators who need to bypass it use
          // [quirks].tls_check_hostname in v0.2.1+.
          verifyCertificate: true,
        });
        try {
          await client.connect();
          return await probeFtps({
            client: {
              getPeerCertificate: () => client.getPeerCertificate(),
              getFeatures: () => client.getFeatures(),
              sendRaw: (cmd) => client.sendRaw(cmd),
              cd: (path) => client.cd(path),
            },
            requestedHost: profile.host,
            remoteRoot: profile.remote_root,
          });
        } catch {
          // Any connection error is reported as "handshake failed" by the
          // caller; we return the shape doctor.ts expects.
          return {
            handshakeOk: false,
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

/**
 * Remove a `[profile.<name>]` block from a TOML source string by simple
 * text-level scanning. Preserves user comments and unrelated sections. Used
 * by `aiftp import filezilla --overwrite` to drop the prior profile before
 * appending the imported one.
 */
function removeProfileBlock(source: string, name: string): string {
  const lines = source.split('\n');
  const target = `[profile.${name}]`;
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === target) {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith('[') && trimmed.endsWith(']')) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

async function runImportFilezilla(options: RunImportFilezillaOptions): Promise<void> {
  const { cwd, xmlPath, dryRun, overwrite, keychainPrefix, stdout, keychain } = options;
  const absoluteXmlPath = isAbsolute(xmlPath) ? xmlPath : join(cwd, xmlPath);
  const xml = await readFile(absoluteXmlPath, 'utf8');
  const result = parseFilezillaXml(xml);

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
    .action(async (cmd: { force?: boolean }) => {
      const configPath = join(cwd, '.aiftp.toml');
      if ((await exists(configPath)) && !cmd.force) {
        throw new Error('.aiftp.toml already exists. Use --force to overwrite.');
      }

      const answers = parseInitAnswers(
        await prompt([
          { type: 'text', name: 'profile', message: 'Profile name', initial: 'production' },
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
          { type: 'text', name: 'remoteRoot', message: 'Remote root', initial: '/public_html' },
          { type: 'text', name: 'localRoot', message: 'Local root', initial: '.' },
          { type: 'text', name: 'keychainService', message: 'Keychain service' },
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
          { type: 'confirm', name: 'consent', message: 'Store encrypted backups locally?' },
        ]),
      );

      if (!answers.consent) {
        throw new Error('Explicit consent is required before initializing aiftp.');
      }

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

      await writeFile(configPath, renderConfig(answers), { encoding: 'utf8', mode: 0o600 });
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
    .action(async (cmd: { profile: string; dryRun?: boolean; json?: boolean; only?: string[] }) => {
      const config = await loadConfig(join(cwd, '.aiftp.toml'));
      const profile = config.profile[cmd.profile];
      if (!profile) {
        throw new Error(`Profile not found: ${cmd.profile}`);
      }
      const context = await loadStatusContext(cwd, cmd.profile);
      const runtimeBackupStore = await runtime.createBackupStore?.({
        cwd,
        profileName: cmd.profile,
      });
      const runtimeUploader = await runtime.createUploader?.({
        cwd,
        profileName: cmd.profile,
      });
      const needsDefaultFtp =
        !runtime.runPush &&
        !cmd.dryRun &&
        (runtimeBackupStore === undefined || runtimeUploader === undefined);
      let sharedFtpClient: FtpClient | undefined;
      try {
        sharedFtpClient = needsDefaultFtp
          ? await createDefaultFtpClient(cwd, cmd.profile, keychain)
          : undefined;
        const backupStore =
          runtimeBackupStore ??
          (await createDefaultBackupStore({
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
          backupStore: backupStore as PushOptions['backupStore'],
          uploader: managedUploader.uploader,
          remoteRoot: profile.remote_root,
          files: cmd.only,
          dryRun: cmd.dryRun,
          safety: {
            maxFilesPerPush: config.safety.max_files_per_push,
            maxTotalSizeBytes: config.safety.max_total_size_mb * 1024 * 1024,
            verifyAfterUpload: config.safety.verify_after_upload === 'off' ? 'off' : 'size',
          },
          preflight: (paths) => checkAll(paths),
        }).finally(() => managedUploader.close());

        if (!result.dryRun) {
          await saveState(stateDir(cwd, cmd.profile), result.nextState);
          await appendLogEntry(cwd, {
            at: new Date().toISOString(),
            event: 'push',
            profile: cmd.profile,
            uploaded: result.uploaded.length,
          });
        }

        if (cmd.json) {
          stdout(JSON.stringify(result));
        } else if (result.dryRun) {
          stdout(`Planned ${result.planned.length} file(s)`);
        } else {
          stdout(`Uploaded ${result.uploaded.length} file(s)`);
        }
      } finally {
        await sharedFtpClient?.disconnect();
      }
    });

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
