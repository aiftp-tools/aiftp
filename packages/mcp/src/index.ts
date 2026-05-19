import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
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
  checkAll,
  createDefaultBackupStore,
  createExcluder,
  getPassword,
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
  | 'aiftp_push_prepare'
  | 'aiftp_push_confirm'
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

const pushPrepareSchema = profileSchema
  .extend({
    files: z.array(z.string().min(1)).optional(),
  })
  .strict();

const pushConfirmSchema = profileSchema
  .extend({
    plan_id: z.string().min(1),
    diff_hash: z.string().min(1),
    confirm_token: z.string().min(1),
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
  aiftp_push_prepare: pushPrepareSchema,
  aiftp_push_confirm: pushConfirmSchema,
  aiftp_backup_list: profileSchema,
  aiftp_backup_restore: backupRestoreSchema,
  aiftp_backup_verify: backupVerifySchema,
  aiftp_backup_prune: backupPruneSchema,
  aiftp_log: logSchema,
  aiftp_list_remote: listRemoteSchema,
} satisfies Record<AiftpToolName, z.ZodType>;

const toolDescriptions = {
  aiftp_status: 'Show local deployment diff.',
  aiftp_push: 'Run a dry-run push. For a real push, use aiftp_push_prepare + aiftp_push_confirm.',
  aiftp_push_prepare:
    'Prepare a real push: returns plan_id, diff_hash, confirm_token, expected_file_count, and expected_remote_root. Pass these back to aiftp_push_confirm within the TTL to actually upload.',
  aiftp_push_confirm:
    'Confirm a previously-prepared real push. Requires the exact plan_id / diff_hash / confirm_token from aiftp_push_prepare.',
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

async function createDefaultFtpClient(cwd: string, profileName: string): Promise<FtpClient> {
  const config = await loadConfig(join(cwd, '.aiftp.toml'));
  const profile = config.profile[profileName];
  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  const client = new FtpClient({
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password: await getPassword(profile.keychain_service, profile.user),
    protocol: profile.protocol,
    requireTls: config.safety.require_tls,
    verifyCertificate: config.safety.verify_certificate,
    timeoutMs: config.connection.timeout_ms,
  });
  await client.connect();
  return client;
}

function uploaderFromClient(client: FtpClient): DeployUploader {
  return {
    upload: (localPath, remotePath) => client.upload(localPath, remotePath),
    size: (remotePath) => client.size(remotePath),
    mkdir: (remoteDir) => client.mkdir(remoteDir),
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
  ftpClient?: FtpClient,
  runtimeStore?: AiftpBackupStore,
): Promise<PushOptions['backupStore']> {
  if (runtimeStore) {
    return runtimeStore as unknown as PushOptions['backupStore'];
  }
  if (dryRun) {
    return dryRunBackupStore();
  }
  return createDefaultBackupStore({ cwd: app.cwd, profileName, ftpClient });
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
  if (args.dry_run === false) {
    throw new Error(
      'aiftp_push refuses dry_run=false. Use the two-step flow: aiftp_push_prepare to get a plan_id/diff_hash/confirm_token, then aiftp_push_confirm to actually upload.',
    );
  }
  const config = await loadConfig(join(app.cwd, '.aiftp.toml'));
  const profile = config.profile[args.profile];
  if (!profile) {
    throw new Error(`Profile not found: ${args.profile}`);
  }
  const runtimeStore = await app.runtime.createBackupStore?.({
    cwd: app.cwd,
    profileName: args.profile,
  });
  const runtimeUploader = await app.runtime.createUploader?.({
    cwd: app.cwd,
    profileName: args.profile,
  });
  const needsDefaultFtp =
    !app.runtime.runPush &&
    !args.dry_run &&
    (runtimeStore === undefined || runtimeUploader === undefined);
  const sharedFtpClient = needsDefaultFtp
    ? await createDefaultFtpClient(app.cwd, args.profile)
    : undefined;

  const result = await (async () => {
    const backupStore = await pushBackupStoreFor(
      app,
      args.profile,
      args.dry_run,
      sharedFtpClient,
      runtimeStore,
    );
    const uploader =
      runtimeUploader ??
      (sharedFtpClient ? uploaderFromClient(sharedFtpClient) : unavailableUploader());
    return (app.runtime.runPush ?? runPush)({
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
  })().finally(() => sharedFtpClient?.disconnect());

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

// ---------------------------------------------------------------------------
// Two-step push: prepare + confirm.
// ---------------------------------------------------------------------------

interface PreparedPushPlan {
  planId: string;
  diffHash: string;
  confirmToken: string;
  profile: string;
  files?: readonly string[];
  expectedFileCount: number;
  expectedRemoteRoot: string;
  createdAt: number;
}

const PLAN_TTL_MS = 5 * 60 * 1000;
const planStore = new Map<string, PreparedPushPlan>();

function pruneExpiredPlans(now: number): void {
  for (const [id, plan] of planStore) {
    if (now - plan.createdAt > PLAN_TTL_MS) planStore.delete(id);
  }
}

function hashPlannedFiles(files: readonly string[]): string {
  const stable = [...files].sort().join('\n');
  return createHash('sha256').update(stable).digest('hex');
}

async function executePush(
  app: AiftpMcpApp,
  args: { profile: string; files?: readonly string[]; dry_run: boolean },
): Promise<PushResult> {
  const config = await loadConfig(join(app.cwd, '.aiftp.toml'));
  const profile = config.profile[args.profile];
  if (!profile) {
    throw new Error(`Profile not found: ${args.profile}`);
  }
  const runtimeStore = await app.runtime.createBackupStore?.({
    cwd: app.cwd,
    profileName: args.profile,
  });
  const runtimeUploader = await app.runtime.createUploader?.({
    cwd: app.cwd,
    profileName: args.profile,
  });
  const needsDefaultFtp =
    !app.runtime.runPush &&
    !args.dry_run &&
    (runtimeStore === undefined || runtimeUploader === undefined);
  const sharedFtpClient = needsDefaultFtp
    ? await createDefaultFtpClient(app.cwd, args.profile)
    : undefined;
  try {
    const backupStore = await pushBackupStoreFor(
      app,
      args.profile,
      args.dry_run,
      sharedFtpClient,
      runtimeStore,
    );
    const uploader =
      runtimeUploader ??
      (sharedFtpClient ? uploaderFromClient(sharedFtpClient) : unavailableUploader());
    return await (app.runtime.runPush ?? runPush)({
      ...(await loadStatusContext(app.cwd, args.profile)),
      backupStore: backupStore as unknown as PushOptions['backupStore'],
      uploader,
      remoteRoot: profile.remote_root,
      files: args.files ? [...args.files] : undefined,
      dryRun: args.dry_run,
      safety: {
        maxFilesPerPush: config.safety.max_files_per_push,
        maxTotalSizeBytes: config.safety.max_total_size_mb * 1024 * 1024,
        verifyAfterUpload: config.safety.verify_after_upload === 'off' ? 'off' : 'size',
      },
      preflight: (paths) => checkAll(paths),
    });
  } finally {
    await sharedFtpClient?.disconnect();
  }
}

async function handlePushPrepare(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = pushPrepareSchema.parse(rawArgs ?? {});
  const config = await loadConfig(join(app.cwd, '.aiftp.toml'));
  const profile = config.profile[args.profile];
  if (!profile) {
    throw new Error(`Profile not found: ${args.profile}`);
  }
  // Run a dry-run to compute the plan + diff that the operator will later
  // be confirming. The diff_hash binds the confirm to *this* set of files;
  // if anything changes between prepare and confirm (e.g. the user edits
  // another file), the hash will not match and confirm refuses.
  const previewResult = await executePush(app, {
    profile: args.profile,
    files: args.files,
    dry_run: true,
  });
  const now = Date.now();
  pruneExpiredPlans(now);
  const planId = randomUUID();
  const diffHash = hashPlannedFiles(previewResult.planned);
  const confirmToken = randomBytes(24).toString('base64url');
  planStore.set(planId, {
    planId,
    diffHash,
    confirmToken,
    profile: args.profile,
    files: args.files,
    expectedFileCount: previewResult.planned.length,
    expectedRemoteRoot: profile.remote_root,
    createdAt: now,
  });
  return textResult({
    ok: true,
    profile: args.profile,
    plan_id: planId,
    diff_hash: diffHash,
    confirm_token: confirmToken,
    expected_file_count: previewResult.planned.length,
    expected_remote_root: profile.remote_root,
    diff: previewResult.diff,
    planned: previewResult.planned,
    ttl_ms: PLAN_TTL_MS,
  });
}

async function handlePushConfirm(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = pushConfirmSchema.parse(rawArgs ?? {});
  const now = Date.now();
  pruneExpiredPlans(now);
  const plan = planStore.get(args.plan_id);
  if (!plan) {
    throw new Error(
      `Unknown or expired plan_id: ${args.plan_id}. Call aiftp_push_prepare again to obtain a fresh plan.`,
    );
  }
  if (plan.profile !== args.profile) {
    throw new Error(
      `Plan ${args.plan_id} was prepared for profile "${plan.profile}", not "${args.profile}".`,
    );
  }
  if (plan.diffHash !== args.diff_hash) {
    throw new Error(
      'diff_hash mismatch: the local diff drifted between prepare and confirm. Call aiftp_push_prepare again to inspect the new plan.',
    );
  }
  if (plan.confirmToken !== args.confirm_token) {
    throw new Error('confirm_token mismatch: refusing to push.');
  }
  // Consume the plan before performing the side-effectful push so a second
  // confirm with the same token cannot replay the upload.
  planStore.delete(args.plan_id);
  const result = await executePush(app, {
    profile: plan.profile,
    files: plan.files,
    dry_run: false,
  });
  if (!result.dryRun) {
    await saveState(stateDir(app.cwd, plan.profile), result.nextState);
    await appendLogEntry(app.cwd, {
      at: new Date().toISOString(),
      event: 'push',
      profile: plan.profile,
      uploaded: result.uploaded.length,
    });
  }
  return textResult({
    ok: true,
    profile: plan.profile,
    plan_id: args.plan_id,
    result,
  });
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
  aiftp_push_prepare: handlePushPrepare,
  aiftp_push_confirm: handlePushConfirm,
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

/**
 * Build a safe, AI-consumable summary of `.aiftp.toml`. This is what
 * `aiftp://config` returns over MCP -- the raw TOML would leak host /
 * user / remote_root / keychain_service to any tool that can read the
 * resource, which Codex flagged in the v0.2 plan review.
 */
async function buildConfigSummary(app: AiftpMcpApp): Promise<{
  schema: number;
  encoding: { file_name: string };
  profiles: Record<
    string,
    {
      protocol: string;
      ftps_mode?: string;
      server_kind: string;
      passive_mode?: boolean;
      credentials_configured: boolean;
    }
  >;
}> {
  const config = await loadConfig(join(app.cwd, '.aiftp.toml'));
  const profiles: Record<
    string,
    {
      protocol: string;
      ftps_mode?: string;
      server_kind: string;
      passive_mode?: boolean;
      credentials_configured: boolean;
    }
  > = {};
  for (const [name, profile] of Object.entries(config.profile)) {
    if (!profile) continue;
    profiles[name] = {
      protocol: profile.protocol,
      ftps_mode: profile.ftps_mode,
      server_kind: profile.server_kind,
      passive_mode: profile.passive_mode,
      credentials_configured: Boolean(profile.keychain_service && profile.user),
    };
  }
  return {
    schema: config.schema,
    encoding: { file_name: config.encoding?.file_name ?? 'auto' },
    profiles,
  };
}

export async function readAiftpResource(app: AiftpMcpApp, uri: string): Promise<string> {
  if (uri === 'aiftp://config') {
    return JSON.stringify(await buildConfigSummary(app));
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
