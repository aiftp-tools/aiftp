import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  type DeployUploader,
  type PushOptions,
  type PushResult,
  type SnapshotMeta,
  type StatusOptions,
  type StatusResult,
  VERSION,
  type VerifyResult,
  checkAll,
  createDefaultBackupStore,
  createExcluder,
  loadConfig,
  loadState,
  runPush,
  runStatus,
  saveState,
} from '@aiftp-tools/core';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export { VERSION };

const DEFAULT_PROFILE = 'production';

export interface AiftpBackupStore {
  listSnapshots(): Promise<SnapshotMeta[]>;
  verify(id: string): Promise<VerifyResult>;
  prune(keepCount: number): Promise<string[]>;
  restoreFile(id: string, path: string): Promise<Buffer>;
}

export interface AiftpMcpContext {
  cwd: string;
  profileName: string;
}

export interface AiftpMcpRuntime {
  runStatus?(options: StatusOptions): Promise<StatusResult>;
  runPush?(options: PushOptions): Promise<PushResult>;
  createUploader?(context: AiftpMcpContext): Promise<DeployUploader>;
  createBackupStore?(context: AiftpMcpContext): Promise<AiftpBackupStore>;
  listRemote?(context: AiftpMcpContext, path: string): Promise<string[]>;
}

export interface AiftpMcpOptions {
  cwd?: string;
  runtime?: AiftpMcpRuntime;
}

export type AiftpToolName =
  | 'aiftp_status'
  | 'aiftp_push'
  | 'aiftp_backup_list'
  | 'aiftp_backup_restore'
  | 'aiftp_backup_verify'
  | 'aiftp_backup_prune'
  | 'aiftp_log'
  | 'aiftp_list_remote';

export interface AiftpMcpApp {
  cwd: string;
  runtime: AiftpMcpRuntime;
  server: McpServer;
  tools: readonly AiftpToolName[];
  resources: readonly string[];
}

const profileSchema = z
  .object({
    profile: z.string().min(1).default(DEFAULT_PROFILE),
  })
  .strict();

const pushSchema = profileSchema
  .extend({
    files: z.array(z.string().min(1)).optional(),
    dry_run: z.boolean().default(true),
  })
  .strict();

const backupRestoreSchema = profileSchema
  .extend({
    id: z.string().min(1),
    path: z.string().min(1),
    output: z.string().min(1),
  })
  .strict();

const backupVerifySchema = profileSchema
  .extend({
    id: z.string().min(1),
  })
  .strict();

const backupPruneSchema = profileSchema
  .extend({
    keep_count: z.number().int().positive().default(30),
  })
  .strict();

const logSchema = z
  .object({
    limit: z.number().int().positive().default(20),
  })
  .strict();

const listRemoteSchema = profileSchema
  .extend({
    path: z.string().min(1).default('/'),
  })
  .strict();

const toolSchemas = {
  aiftp_status: profileSchema,
  aiftp_push: pushSchema,
  aiftp_backup_list: profileSchema,
  aiftp_backup_restore: backupRestoreSchema,
  aiftp_backup_verify: backupVerifySchema,
  aiftp_backup_prune: backupPruneSchema,
  aiftp_log: logSchema,
  aiftp_list_remote: listRemoteSchema,
} satisfies Record<AiftpToolName, z.ZodType>;

const toolDescriptions = {
  aiftp_status: 'Show local deployment diff.',
  aiftp_push: 'Run a dry-run or real push through the configured aiftp profile.',
  aiftp_backup_list: 'List encrypted backup snapshots.',
  aiftp_backup_restore: 'Restore one file from a backup snapshot to a local output path.',
  aiftp_backup_verify: 'Verify a backup snapshot.',
  aiftp_backup_prune: 'Prune old backup snapshots.',
  aiftp_log: 'Read recent local aiftp operation log entries.',
  aiftp_list_remote: 'List a remote directory through the configured runtime.',
} satisfies Record<AiftpToolName, string>;

function projectPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
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

async function readLogEntries(cwd: string): Promise<Array<Record<string, unknown>>> {
  const source = (await readFile(logPath(cwd), 'utf8').catch(() => '')) as string;
  return source
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function appendLogEntry(cwd: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(logPath(cwd)), { recursive: true });
  await appendFile(logPath(cwd), `${JSON.stringify(entry)}\n`, 'utf8');
}

function unavailableUploader(): DeployUploader {
  return {
    upload: async () => {
      throw new Error(
        'MCP push uploader is not configured yet. Use dry_run or provide a runtime uploader.',
      );
    },
  };
}

async function backupStoreFor(app: AiftpMcpApp, profileName: string): Promise<AiftpBackupStore> {
  return (
    (await app.runtime.createBackupStore?.({ cwd: app.cwd, profileName })) ??
    (await createDefaultBackupStore({ cwd: app.cwd, profileName }))
  );
}

function dryRunBackupStore(): PushOptions['backupStore'] {
  return {
    createAutoSnapshot: async () => {
      throw new Error('Dry-run backup store must not create snapshots.');
    },
  } as unknown as PushOptions['backupStore'];
}

async function pushBackupStoreFor(
  app: AiftpMcpApp,
  profileName: string,
  dryRun: boolean,
): Promise<PushOptions['backupStore']> {
  const store = await app.runtime.createBackupStore?.({ cwd: app.cwd, profileName });
  if (store) {
    return store as unknown as PushOptions['backupStore'];
  }
  if (dryRun) {
    return dryRunBackupStore();
  }
  return createDefaultBackupStore({ cwd: app.cwd, profileName });
}

function textResult(payload: unknown, isError?: boolean): CallToolResult {
  return {
    isError,
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
  };
}

function toolError(error: unknown): CallToolResult {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  return textResult({ ok: false, error: { name, message } }, true);
}

async function handleStatus(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = profileSchema.parse(rawArgs ?? {});
  const status = await (app.runtime.runStatus ?? runStatus)(
    await loadStatusContext(app.cwd, args.profile),
  );
  return textResult({ ok: true, profile: args.profile, status });
}

async function handlePush(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = pushSchema.parse(rawArgs ?? {});
  const config = await loadConfig(join(app.cwd, '.aiftp.toml'));
  const profile = config.profile[args.profile];
  if (!profile) {
    throw new Error(`Profile not found: ${args.profile}`);
  }
  const backupStore = await pushBackupStoreFor(app, args.profile, args.dry_run);
  const uploader =
    (await app.runtime.createUploader?.({ cwd: app.cwd, profileName: args.profile })) ??
    unavailableUploader();
  const result = await (app.runtime.runPush ?? runPush)({
    ...(await loadStatusContext(app.cwd, args.profile)),
    backupStore: backupStore as unknown as PushOptions['backupStore'],
    uploader,
    remoteRoot: profile.remote_root,
    files: args.files,
    dryRun: args.dry_run,
    safety: {
      maxFilesPerPush: config.safety.max_files_per_push,
      maxTotalSizeBytes: config.safety.max_total_size_mb * 1024 * 1024,
      verifyAfterUpload: config.safety.verify_after_upload === 'off' ? 'off' : 'size',
    },
    preflight: (paths) => checkAll(paths),
  });

  if (!result.dryRun) {
    await saveState(stateDir(app.cwd, args.profile), result.nextState);
    await appendLogEntry(app.cwd, {
      at: new Date().toISOString(),
      event: 'push',
      profile: args.profile,
      uploaded: result.uploaded.length,
    });
  }

  return textResult({ ok: true, profile: args.profile, result });
}

async function handleBackupList(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = profileSchema.parse(rawArgs ?? {});
  const snapshots = await (await backupStoreFor(app, args.profile)).listSnapshots();
  return textResult({ ok: true, profile: args.profile, snapshots });
}

async function handleBackupRestore(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = backupRestoreSchema.parse(rawArgs ?? {});
  const data = await (await backupStoreFor(app, args.profile)).restoreFile(args.id, args.path);
  const output = projectPath(app.cwd, args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, data);
  return textResult({ ok: true, profile: args.profile, restored: args.output });
}

async function handleBackupVerify(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = backupVerifySchema.parse(rawArgs ?? {});
  const report = await (await backupStoreFor(app, args.profile)).verify(args.id);
  return textResult({ ok: true, profile: args.profile, report });
}

async function handleBackupPrune(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = backupPruneSchema.parse(rawArgs ?? {});
  const deleted = await (await backupStoreFor(app, args.profile)).prune(args.keep_count);
  return textResult({ ok: true, profile: args.profile, deleted });
}

async function handleLog(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = logSchema.parse(rawArgs ?? {});
  const entries = await readLogEntries(app.cwd);
  return textResult({ ok: true, entries: entries.slice(-args.limit) });
}

async function handleListRemote(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = listRemoteSchema.parse(rawArgs ?? {});
  const entries = await app.runtime.listRemote?.(
    { cwd: app.cwd, profileName: args.profile },
    args.path,
  );
  if (!entries) {
    throw new Error('MCP remote listing is not configured.');
  }
  return textResult({ ok: true, profile: args.profile, path: args.path, entries });
}

const handlers = {
  aiftp_status: handleStatus,
  aiftp_push: handlePush,
  aiftp_backup_list: handleBackupList,
  aiftp_backup_restore: handleBackupRestore,
  aiftp_backup_verify: handleBackupVerify,
  aiftp_backup_prune: handleBackupPrune,
  aiftp_log: handleLog,
  aiftp_list_remote: handleListRemote,
} satisfies Record<AiftpToolName, (app: AiftpMcpApp, args: unknown) => Promise<CallToolResult>>;

export async function callAiftpTool(
  app: AiftpMcpApp,
  name: AiftpToolName,
  args: unknown,
): Promise<CallToolResult> {
  try {
    return await handlers[name](app, args);
  } catch (error: unknown) {
    return toolError(error);
  }
}

export async function readAiftpResource(app: AiftpMcpApp, uri: string): Promise<string> {
  if (uri === 'aiftp://config') {
    return readFile(join(app.cwd, '.aiftp.toml'), 'utf8');
  }
  const statePrefix = 'aiftp://state/';
  if (uri.startsWith(statePrefix)) {
    const profileName = uri.slice(statePrefix.length) || DEFAULT_PROFILE;
    return readFile(join(stateDir(app.cwd, profileName), 'state.json'), 'utf8');
  }
  const backupPrefix = 'aiftp://backups/';
  if (uri.startsWith(backupPrefix)) {
    const profileName = uri.slice(backupPrefix.length) || DEFAULT_PROFILE;
    const snapshots = await (await backupStoreFor(app, profileName)).listSnapshots();
    return JSON.stringify(snapshots);
  }
  throw new Error(`Unknown resource: ${uri}`);
}

export function createAiftpMcp(options: AiftpMcpOptions = {}): AiftpMcpApp {
  const app: AiftpMcpApp = {
    cwd: options.cwd ?? process.cwd(),
    runtime: options.runtime ?? {},
    server: new McpServer({ name: 'aiftp', version: VERSION }),
    tools: Object.keys(handlers) as AiftpToolName[],
    resources: ['aiftp://config', 'aiftp://state/{profile}', 'aiftp://backups/{profile}'],
  };

  for (const name of app.tools) {
    app.server.registerTool(
      name,
      {
        description: toolDescriptions[name],
        inputSchema: toolSchemas[name],
      },
      async (args: unknown) => callAiftpTool(app, name, args),
    );
  }

  app.server.registerResource(
    'config',
    'aiftp://config',
    { title: 'aiftp config', mimeType: 'text/plain' },
    async (uri) => ({
      contents: [{ uri: uri.toString(), text: await readAiftpResource(app, uri.toString()) }],
    }),
  );
  app.server.registerResource(
    'state',
    new ResourceTemplate('aiftp://state/{profile}', { list: undefined }),
    { title: 'aiftp profile state', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.toString(), text: await readAiftpResource(app, uri.toString()) }],
    }),
  );
  app.server.registerResource(
    'backups',
    new ResourceTemplate('aiftp://backups/{profile}', { list: undefined }),
    { title: 'aiftp backup snapshots', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.toString(), text: await readAiftpResource(app, uri.toString()) }],
    }),
  );

  return app;
}

export async function startStdioServer(options: AiftpMcpOptions = {}): Promise<void> {
  await createAiftpMcp(options).server.connect(new StdioServerTransport());
}
