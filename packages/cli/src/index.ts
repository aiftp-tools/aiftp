import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  type DeployUploader,
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

export interface CliRuntime {
  runStatus?(options: StatusOptions): Promise<StatusResult>;
  runPush?(options: PushOptions): Promise<PushResult>;
  createUploader?(context: CliContext): Promise<DeployUploader>;
  createBackupStore?(context: CliContext): Promise<CliBackupStore>;
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
  return [
    'schema = 1',
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
  ].join('\n');
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
