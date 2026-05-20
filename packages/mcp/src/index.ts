import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  type DeployUploader,
  type DoctorReport,
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
  hasPassword,
  isValidSnapshotId,
  loadConfig,
  loadState,
  resolveDefaultProfile,
  runPush,
  runStatus,
  saveState,
} from '@aiftp-tools/core';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export { VERSION };

/**
 * Fallback used only by URI templates like `aiftp://state/{profile}` when no
 * `{profile}` segment is supplied. Tool calls *never* use this constant —
 * they go through `resolveProfileArg()` which consults
 * `resolveDefaultProfile()` so AI agents and the operator share the same
 * default-profile resolution rules.
 */
const FALLBACK_PROFILE_FOR_RESOURCE_URIS = 'production';

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
  /**
   * Optional hook used by `aiftp_profile_test`. When omitted the MCP server
   * refuses the tool call (the default doctor runner needs network access and
   * a keychain probe that we don't want to wire in implicitly). Tests inject
   * a mock; the CLI wires a real runner.
   */
  runDoctor?(context: AiftpMcpContext): Promise<DoctorReport>;
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
  | 'aiftp_backup_restore_prepare'
  | 'aiftp_backup_restore_confirm'
  | 'aiftp_backup_verify'
  | 'aiftp_backup_prune'
  | 'aiftp_log'
  | 'aiftp_list_remote'
  | 'aiftp_profile_list'
  | 'aiftp_profile_current'
  | 'aiftp_profile_test';

export interface AiftpMcpApp {
  cwd: string;
  runtime: AiftpMcpRuntime;
  server: McpServer;
  tools: readonly AiftpToolName[];
  resources: readonly string[];
}

/**
 * `profile` is intentionally optional on read-only / dry-run schemas. When
 * the caller omits it, the server resolves the default via
 * `resolveDefaultProfile()` (env > `.aiftp/state` file > single-profile
 * fallback). Hard-coding "production" here would regress single-profile
 * configs whose only profile is named "staging" etc.
 *
 * Confirm schemas (`pushConfirmSchema`, `backupRestoreConfirmSchema`) use
 * `requiredProfileSchema` instead — they MUST be invoked with the same
 * profile name the prepare step returned, otherwise an AIFTP_PROFILE flip
 * between prepare and confirm could change the default resolution and
 * trigger a misleading "profile mismatch" instead of an intentional skip.
 */
const profileSchema = z
  .object({
    profile: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Profile name from .aiftp.toml. Optional — when omitted, resolved via AIFTP_PROFILE env > .aiftp/state/_default-profile.json > sole-profile fallback. Errors when multi-profile config has nothing pinned.',
      ),
  })
  .strict();

const requiredProfileSchema = z
  .object({
    profile: z
      .string()
      .min(1)
      .describe(
        'Profile name from .aiftp.toml. Required for confirm steps so the prepare-time profile is echoed back verbatim (no default resolution).',
      ),
  })
  .strict();

const noArgsSchema = z.object({}).strict();

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

const pushConfirmSchema = requiredProfileSchema
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

const backupRestorePrepareSchema = profileSchema
  .extend({
    id: z.string().min(1),
    path: z.string().min(1),
    output: z.string().min(1),
  })
  .strict();

const backupRestoreConfirmSchema = requiredProfileSchema
  .extend({
    plan_id: z.string().min(1),
    diff_hash: z.string().min(1),
    confirm_token: z.string().min(1),
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
  aiftp_backup_restore_prepare: backupRestorePrepareSchema,
  aiftp_backup_restore_confirm: backupRestoreConfirmSchema,
  aiftp_backup_verify: backupVerifySchema,
  aiftp_backup_prune: backupPruneSchema,
  aiftp_log: logSchema,
  aiftp_list_remote: listRemoteSchema,
  aiftp_profile_list: noArgsSchema,
  aiftp_profile_current: noArgsSchema,
  aiftp_profile_test: profileSchema,
} satisfies Record<AiftpToolName, z.ZodType>;

const toolDescriptions = {
  aiftp_status: 'Show local deployment diff.',
  aiftp_push: 'Run a dry-run push. For a real push, use aiftp_push_prepare + aiftp_push_confirm.',
  aiftp_push_prepare:
    'Prepare a real push: returns plan_id, diff_hash, confirm_token, expected_file_count, and expected_remote_root. Pass these back to aiftp_push_confirm within the TTL to actually upload.',
  aiftp_push_confirm:
    'Confirm a previously-prepared real push. Requires the exact plan_id / diff_hash / confirm_token from aiftp_push_prepare.',
  aiftp_backup_list: 'List encrypted backup snapshots.',
  aiftp_backup_restore:
    'Direct restore is refused — use aiftp_backup_restore_prepare + aiftp_backup_restore_confirm.',
  aiftp_backup_restore_prepare:
    'Prepare a backup restore: validates the snapshot id and output path (must stay inside the project root), returns plan_id / diff_hash / confirm_token.',
  aiftp_backup_restore_confirm:
    'Confirm a previously-prepared backup restore. Requires the exact plan_id / diff_hash / confirm_token from aiftp_backup_restore_prepare.',
  aiftp_backup_verify: 'Verify a backup snapshot.',
  aiftp_backup_prune: 'Prune old backup snapshots.',
  aiftp_log: 'Read recent local aiftp operation log entries.',
  aiftp_list_remote: 'List a remote directory through the configured runtime.',
  aiftp_profile_list:
    'List profiles from .aiftp.toml as redacted summaries: name, protocol, server_kind, credentialsStatus (present/missing/unknown), isDefault. Host / user / remote_root / keychain_service are NEVER surfaced (mirrors aiftp://config redaction policy). Read-only.',
  aiftp_profile_current:
    'Return the resolved default profile name (AIFTP_PROFILE env > .aiftp/state file > single-profile fallback), or null when ambiguous. Read-only.',
  aiftp_profile_test:
    'Run the connection-subset of doctor against the chosen profile. Requires the server to be constructed with `runtime.runDoctor` (the CLI wires it; bare MCP servers refuse the call). Excludes local-only checks (config-file, gitignore, profile-exists). The `ok` flag is recomputed from the filtered subset. Read-only.',
} satisfies Record<AiftpToolName, string>;

function projectPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

/**
 * Read `.aiftp.toml` from `cwd` and wrap any failure with a message that
 * tells the AI agent what file the MCP server was trying to read. Without
 * this wrapper, an `ENOENT` from `loadConfig` surfaces through `toolError`
 * as a bare `ENOENT: no such file or directory` which is hard for an AI
 * agent to act on. Codex review flagged the missing context.
 */
async function loadConfigForMcp(cwd: string): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  try {
    return await loadConfig(join(cwd, '.aiftp.toml'));
  } catch (error: unknown) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read .aiftp.toml in ${cwd}. Run \`aiftp init\` to scaffold one, or cd into a project that has it. Underlying error: ${cause}`,
    );
  }
}

/**
 * Resolve which profile a tool call should act on.
 *
 * 1. If the caller passed an explicit profile, honor it.
 * 2. Otherwise consult `resolveDefaultProfile(cwd, { availableProfiles })`
 *    which checks: AIFTP_PROFILE env > `.aiftp/state/_default-profile.json`
 *    > sole-profile fallback.
 *
 * Returning the same name an operator would see from `aiftp profile current`
 * is the whole point of v0.4.1 — AI agents and humans share one resolution.
 *
 * Throws when no profile can be determined (multi-profile config with
 * nothing pinned) so the caller surfaces a clear error instead of operating
 * on the wrong target.
 *
 * Optional `preloadedConfig` short-circuits the disk read for handlers that
 * already had to call `loadConfigForMcp()` themselves — this avoids the
 * double fs.readFile that Claude review flagged in v0.4.1 RC.
 */
async function resolveProfileArg(
  cwd: string,
  requested: string | undefined,
  preloadedConfig?: Awaited<ReturnType<typeof loadConfig>>,
): Promise<string> {
  if (requested && requested.length > 0) return requested;
  const config = preloadedConfig ?? (await loadConfigForMcp(cwd));
  const available = Object.keys(config.profile);
  const resolved = await resolveDefaultProfile(cwd, { availableProfiles: available });
  if (!resolved) {
    throw new Error(
      'Could not resolve a default profile from .aiftp.toml. Set AIFTP_PROFILE, run `aiftp profile use <name>`, or pass `profile` explicitly.',
    );
  }
  return resolved;
}

function stateDir(cwd: string, profileName: string): string {
  return join(cwd, '.aiftp', 'state', profileName);
}

function logPath(cwd: string): string {
  return join(cwd, '.aiftp', 'log.jsonl');
}

async function loadStatusContext(
  cwd: string,
  profileName: string,
  preloadedConfig?: Awaited<ReturnType<typeof loadConfig>>,
): Promise<StatusOptions> {
  const config = preloadedConfig ?? (await loadConfigForMcp(cwd));
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
  const config = await loadConfigForMcp(cwd);
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
    skipHostnameCheck: config.quirks?.tls_check_hostname === false,
    timeoutMs: config.connection.timeout_ms,
    noopIntervalSec: config.quirks?.noop_interval_sec ?? 0,
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
  // Pre-load once and pass through so we avoid the double fs.readFile
  // that Claude review flagged in v0.4.1 RC.
  const config = await loadConfigForMcp(app.cwd);
  const profile = await resolveProfileArg(app.cwd, args.profile, config);
  const status = await (app.runtime.runStatus ?? runStatus)(
    await loadStatusContext(app.cwd, profile, config),
  );
  return textResult({ ok: true, profile, status });
}

async function handlePush(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = pushSchema.parse(rawArgs ?? {});
  if (args.dry_run === false) {
    throw new Error(
      'aiftp_push refuses dry_run=false. Use the two-step flow: aiftp_push_prepare to get a plan_id/diff_hash/confirm_token, then aiftp_push_confirm to actually upload.',
    );
  }
  const config = await loadConfigForMcp(app.cwd);
  const profileName = await resolveProfileArg(app.cwd, args.profile, config);
  const profile = config.profile[profileName];
  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  const runtimeStore = await app.runtime.createBackupStore?.({
    cwd: app.cwd,
    profileName,
  });
  const runtimeUploader = await app.runtime.createUploader?.({
    cwd: app.cwd,
    profileName,
  });
  const needsDefaultFtp =
    !app.runtime.runPush &&
    !args.dry_run &&
    (runtimeStore === undefined || runtimeUploader === undefined);
  const sharedFtpClient = needsDefaultFtp
    ? await createDefaultFtpClient(app.cwd, profileName)
    : undefined;

  const result = await (async () => {
    const backupStore = await pushBackupStoreFor(
      app,
      profileName,
      args.dry_run,
      sharedFtpClient,
      runtimeStore,
    );
    const uploader =
      runtimeUploader ??
      (sharedFtpClient ? uploaderFromClient(sharedFtpClient) : unavailableUploader());
    return (app.runtime.runPush ?? runPush)({
      ...(await loadStatusContext(app.cwd, profileName, config)),
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
    await saveState(stateDir(app.cwd, profileName), result.nextState);
    await appendLogEntry(app.cwd, {
      at: new Date().toISOString(),
      event: 'push',
      profile: profileName,
      uploaded: result.uploaded.length,
    });
  }

  return textResult({ ok: true, profile: profileName, result });
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
  const config = await loadConfigForMcp(app.cwd);
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
      ...(await loadStatusContext(app.cwd, args.profile, config)),
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
  const config = await loadConfigForMcp(app.cwd);
  const profileName = await resolveProfileArg(app.cwd, args.profile, config);
  const profile = config.profile[profileName];
  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  // Run a dry-run to compute the plan + diff that the operator will later
  // be confirming. The diff_hash binds the confirm to *this* set of files;
  // if anything changes between prepare and confirm (e.g. the user edits
  // another file), the hash will not match and confirm refuses.
  const previewResult = await executePush(app, {
    profile: profileName,
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
    profile: profileName,
    files: args.files,
    expectedFileCount: previewResult.planned.length,
    expectedRemoteRoot: profile.remote_root,
    createdAt: now,
  });
  return textResult({
    ok: true,
    profile: profileName,
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
  // profile is required at the schema level (see requiredProfileSchema) so
  // an AIFTP_PROFILE flip between prepare and confirm cannot silently change
  // which plan we look up. Operators must echo back the exact profile name
  // returned by aiftp_push_prepare.
  const profileName = args.profile;
  const now = Date.now();
  pruneExpiredPlans(now);
  const plan = planStore.get(args.plan_id);
  if (!plan) {
    throw new Error(
      `Unknown or expired plan_id: ${args.plan_id}. Call aiftp_push_prepare again to obtain a fresh plan.`,
    );
  }
  if (plan.profile !== profileName) {
    throw new Error(
      `Plan ${args.plan_id} was prepared for profile "${plan.profile}", not "${profileName}".`,
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
  const profile = await resolveProfileArg(app.cwd, args.profile);
  const snapshots = await (await backupStoreFor(app, profile)).listSnapshots();
  return textResult({ ok: true, profile, snapshots });
}

async function handleBackupRestore(_app: AiftpMcpApp, _rawArgs: unknown): Promise<CallToolResult> {
  throw new Error(
    'aiftp_backup_restore refuses direct invocation. Use the two-step flow: aiftp_backup_restore_prepare to validate the snapshot id and output path, then aiftp_backup_restore_confirm to actually write the file.',
  );
}

/**
 * Resolve `requested` relative to `cwd` and confirm the absolute result
 * stays inside the project root. Used by destructive write operations
 * (backup restore) to prevent path-traversal escapes through the MCP
 * interface. Mirrors the CLI's `restrictToProject` helper.
 */
function restrictOutputToProject(cwd: string, requested: string): string {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new Error('output path must not be empty');
  }
  const cwdResolved = resolve(cwd);
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(cwdResolved, requested);
  const rel = relative(cwdResolved, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`output path ${requested} resolves outside the project root`);
  }
  return absolute;
}

interface PreparedRestorePlan {
  planId: string;
  diffHash: string;
  confirmToken: string;
  profile: string;
  snapshotId: string;
  path: string;
  outputAbsolute: string;
  outputRequested: string;
  createdAt: number;
}

const restorePlanStore = new Map<string, PreparedRestorePlan>();

function pruneExpiredRestorePlans(now: number): void {
  for (const [id, plan] of restorePlanStore) {
    if (now - plan.createdAt > PLAN_TTL_MS) restorePlanStore.delete(id);
  }
}

async function handleBackupRestorePrepare(
  app: AiftpMcpApp,
  rawArgs: unknown,
): Promise<CallToolResult> {
  const args = backupRestorePrepareSchema.parse(rawArgs ?? {});
  const profileName = await resolveProfileArg(app.cwd, args.profile);
  if (!isValidSnapshotId(args.id)) {
    throw new Error(
      `Invalid snapshot id: ${JSON.stringify(args.id)}. Expected format: "<iso-timestamp>-<auto|full>-<uuid>" (see aiftp_backup_list).`,
    );
  }
  const outputAbsolute = restrictOutputToProject(app.cwd, args.output);
  const now = Date.now();
  pruneExpiredRestorePlans(now);
  const planId = randomUUID();
  // The diff_hash binds the confirm to *these exact target identifiers*; if
  // the user issues a second prepare for a different file, the prior token
  // becomes useless.
  const diffHash = createHash('sha256')
    .update(`${profileName}\n${args.id}\n${args.path}\n${outputAbsolute}`)
    .digest('hex');
  const confirmToken = randomBytes(24).toString('base64url');
  restorePlanStore.set(planId, {
    planId,
    diffHash,
    confirmToken,
    profile: profileName,
    snapshotId: args.id,
    path: args.path,
    outputAbsolute,
    outputRequested: args.output,
    createdAt: now,
  });
  return textResult({
    ok: true,
    profile: profileName,
    plan_id: planId,
    diff_hash: diffHash,
    confirm_token: confirmToken,
    snapshot_id: args.id,
    path: args.path,
    output: args.output,
    ttl_ms: PLAN_TTL_MS,
  });
}

async function handleBackupRestoreConfirm(
  app: AiftpMcpApp,
  rawArgs: unknown,
): Promise<CallToolResult> {
  const args = backupRestoreConfirmSchema.parse(rawArgs ?? {});
  // profile required for the same race-prevention reason as
  // handlePushConfirm — operators must echo the prepare-time profile back.
  const profileName = args.profile;
  const now = Date.now();
  pruneExpiredRestorePlans(now);
  const plan = restorePlanStore.get(args.plan_id);
  if (!plan) {
    throw new Error(
      `Unknown or expired plan_id: ${args.plan_id}. Call aiftp_backup_restore_prepare again to obtain a fresh plan.`,
    );
  }
  if (plan.profile !== profileName) {
    throw new Error(
      `Plan ${args.plan_id} was prepared for profile "${plan.profile}", not "${profileName}".`,
    );
  }
  if (plan.diffHash !== args.diff_hash) {
    throw new Error(
      'diff_hash mismatch: the restore target drifted between prepare and confirm. Call aiftp_backup_restore_prepare again.',
    );
  }
  if (plan.confirmToken !== args.confirm_token) {
    throw new Error('confirm_token mismatch: refusing to restore.');
  }
  // Consume the plan before side effects so a second confirm with the same
  // token cannot replay the restore.
  restorePlanStore.delete(args.plan_id);
  const data = await (await backupStoreFor(app, plan.profile)).restoreFile(
    plan.snapshotId,
    plan.path,
  );
  await mkdir(dirname(plan.outputAbsolute), { recursive: true });
  await writeFile(plan.outputAbsolute, data);
  return textResult({
    ok: true,
    profile: plan.profile,
    plan_id: args.plan_id,
    restored: plan.outputRequested,
    bytes: data.length,
  });
}

async function handleBackupVerify(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = backupVerifySchema.parse(rawArgs ?? {});
  const profile = await resolveProfileArg(app.cwd, args.profile);
  const report = await (await backupStoreFor(app, profile)).verify(args.id);
  return textResult({ ok: true, profile, report });
}

async function handleBackupPrune(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = backupPruneSchema.parse(rawArgs ?? {});
  const profile = await resolveProfileArg(app.cwd, args.profile);
  const deleted = await (await backupStoreFor(app, profile)).prune(args.keep_count);
  return textResult({ ok: true, profile, deleted });
}

async function handleLog(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = logSchema.parse(rawArgs ?? {});
  const entries = await readLogEntries(app.cwd);
  return textResult({ ok: true, entries: entries.slice(-args.limit) });
}

async function handleListRemote(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = listRemoteSchema.parse(rawArgs ?? {});
  const profile = await resolveProfileArg(app.cwd, args.profile);
  const entries = await app.runtime.listRemote?.({ cwd: app.cwd, profileName: profile }, args.path);
  if (!entries) {
    throw new Error('MCP remote listing is not configured.');
  }
  return textResult({ ok: true, profile, path: args.path, entries });
}

// ---------------------------------------------------------------------------
// v0.4.1: profile read-only tools. All three are read-only (no plan/confirm
// gate). The default-profile resolution mirrors `resolveProfileArg()` so
// `/mcp` users see the same name as `aiftp profile current`.
// ---------------------------------------------------------------------------

/**
 * Tri-state credential probe result. Distinguishes "Keychain entry is
 * missing" from "we couldn't probe the Keychain at all" (network drive
 * unavailable, security CLI errored, etc.). Codex review flagged that
 * silently coercing both to `false` would mislead an AI agent into a
 * remediation loop ("set the password again", which won't help if the
 * underlying error is something else).
 */
type CredentialsStatus = 'present' | 'missing' | 'unknown';

/**
 * Profile summary returned by `aiftp_profile_list`. Mirrors the redaction
 * policy of the `aiftp://config` MCP resource — host / port / user /
 * remote_root / keychain_service are NEVER surfaced to MCP clients.
 *
 * - `name`, `protocol`, `server_kind` are non-sensitive metadata.
 * - `credentialsStatus` is a tri-state Keychain probe result.
 * - `isDefault` mirrors `resolveDefaultProfile` so callers can mirror the
 *   operator's `aiftp profile current` view.
 */
interface ProfileSummary {
  name: string;
  protocol: string;
  server_kind: string;
  credentialsStatus: CredentialsStatus;
  isDefault: boolean;
}

async function handleProfileList(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  noArgsSchema.parse(rawArgs ?? {});
  const config = await loadConfigForMcp(app.cwd);
  const names = Object.keys(config.profile);
  const defaultName = await resolveDefaultProfile(app.cwd, { availableProfiles: names });
  const profiles: ProfileSummary[] = [];
  for (const name of names) {
    const profile = config.profile[name];
    if (!profile) continue;
    // Keychain probe — `security find-generic-password` on macOS and
    // CredRead on Windows only check whether an entry exists; they do not
    // expose the secret value. We surface three states so an AI agent can
    // tell "missing password" apart from "Keychain access blocked".
    let credentialsStatus: CredentialsStatus;
    try {
      credentialsStatus = (await hasPassword(profile.keychain_service, profile.user))
        ? 'present'
        : 'missing';
    } catch {
      credentialsStatus = 'unknown';
    }
    profiles.push({
      name,
      protocol: profile.protocol,
      server_kind: profile.server_kind,
      credentialsStatus,
      isDefault: defaultName === name,
    });
  }
  return textResult({ ok: true, profiles, default: defaultName });
}

async function handleProfileCurrent(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  noArgsSchema.parse(rawArgs ?? {});
  const config = await loadConfigForMcp(app.cwd);
  const available = Object.keys(config.profile);
  const resolved = await resolveDefaultProfile(app.cwd, { availableProfiles: available });
  return textResult({ ok: true, profile: resolved });
}

/**
 * IDs from the doctor checks that depend on remote / credential state. We
 * keep this subset explicit (rather than blacklisting config/file checks)
 * so a future doctor check that adds a new local-only id doesn't silently
 * leak into the connection-test view.
 */
const CONNECTION_TEST_CHECK_IDS: ReadonlySet<string> = new Set([
  'keychain',
  'dns',
  'tcp',
  'ftps-handshake',
  'ftps-cert',
  'pasv',
  'mlsd',
  'size',
  'remote-root',
]);

async function handleProfileTest(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = profileSchema.parse(rawArgs ?? {});
  const profile = await resolveProfileArg(app.cwd, args.profile);
  if (!app.runtime.runDoctor) {
    throw new Error(
      'aiftp_profile_test requires a runtime.runDoctor hook. The MCP server does not run network probes by default — use the aiftp CLI or wire runtime.runDoctor when constructing the server.',
    );
  }
  const report = await app.runtime.runDoctor({ cwd: app.cwd, profileName: profile });
  const filtered = report.results.filter((r) => CONNECTION_TEST_CHECK_IDS.has(r.id));
  // Recompute summary AND ok from the filtered set. Forwarding report.ok
  // (the full-doctor verdict) would surface non-connection failures
  // (e.g. `config-file` parse warnings, `gitignore` missing entries) as
  // `ok: false` even when the connection itself is healthy — which is
  // misleading for a tool whose contract is "test the connection". Codex
  // review caught this inconsistency in v0.4.1 RC.
  const summary = {
    pass: filtered.filter((r) => r.status === 'pass').length,
    warn: filtered.filter((r) => r.status === 'warn').length,
    fail: filtered.filter((r) => r.status === 'fail').length,
    skip: filtered.filter((r) => r.status === 'skip').length,
  };
  const ok = summary.fail === 0;
  return textResult({ ok, profile, results: filtered, summary });
}

const handlers = {
  aiftp_status: handleStatus,
  aiftp_push: handlePush,
  aiftp_push_prepare: handlePushPrepare,
  aiftp_push_confirm: handlePushConfirm,
  aiftp_backup_list: handleBackupList,
  aiftp_backup_restore: handleBackupRestore,
  aiftp_backup_restore_prepare: handleBackupRestorePrepare,
  aiftp_backup_restore_confirm: handleBackupRestoreConfirm,
  aiftp_backup_verify: handleBackupVerify,
  aiftp_backup_prune: handleBackupPrune,
  aiftp_log: handleLog,
  aiftp_list_remote: handleListRemote,
  aiftp_profile_list: handleProfileList,
  aiftp_profile_current: handleProfileCurrent,
  aiftp_profile_test: handleProfileTest,
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
  const config = await loadConfigForMcp(app.cwd);
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
    const profileName = uri.slice(statePrefix.length) || FALLBACK_PROFILE_FOR_RESOURCE_URIS;
    return readFile(join(stateDir(app.cwd, profileName), 'state.json'), 'utf8');
  }
  const backupPrefix = 'aiftp://backups/';
  if (uri.startsWith(backupPrefix)) {
    const profileName = uri.slice(backupPrefix.length) || FALLBACK_PROFILE_FOR_RESOURCE_URIS;
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
