import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type Config,
  type DeployClient,
  type DeployUploader,
  type DestinationFingerprint,
  type DoctorReport,
  type ImportedProfile,
  type ProfileConfig,
  type PushBackupStore,
  type PushOptions,
  type PushResult,
  type ResolvedSite,
  type RollbackBackupStore,
  type RollbackUploader,
  type SiteEntry,
  SiteRegistry,
  type SnapshotMeta,
  type StatusOptions,
  type StatusResult,
  VERSION,
  type VerifyResult,
  buildDeployClientOptions,
  checkAll,
  computeDestinationFingerprint,
  createDefaultBackupStore,
  createDeployClient,
  createExcluder,
  describeDestinationChange,
  getPassword,
  hasPassword,
  isProdProfile,
  isValidSnapshotId,
  listTemplates,
  loadConfig,
  loadState,
  migrateV1ToV2Source,
  parseFilezillaXml,
  removeProfileBlock,
  requiresProductionConfirmation,
  resolveDefaultProfile,
  resolveRollbackTarget,
  resolveSite,
  runPush,
  runRollback,
  runStatus,
  saveState,
} from '@aiftp-tools/core';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { generateChallenge, hashConfirmation, verifyConfirmation } from './confirm-phrase.js';
import { buildSetupPromptText } from './setup-prompt.js';
import { buildSetupStatus } from './setup-status.js';

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
  createAutoSnapshot?: PushBackupStore['createAutoSnapshot'];
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
  /**
   * v0.5.0: Buffer-shaped uploader for `aiftp_rollback_confirm`. Codex
   * BLOCK review pointed out that `createUploader` (path-shaped, push
   * style) cannot supply the in-memory bytes a rollback needs — so we
   * carry a SEPARATE optional hook. When omitted, the MCP server builds
   * an FtpClient-backed implementation via `createDefaultFtpClient`.
   * Test harnesses inject a mock that observes Buffer-level uploads.
   */
  createRollbackUploader?(context: AiftpMcpContext): Promise<RollbackUploader>;
  createSiteRegistry?(): { list(): Promise<readonly SiteEntry[]> };
  resolveSite?(entry: SiteEntry): Promise<ResolvedSite>;
  /**
   * v0.12.4: credential-presence probe used by `aiftp_profile_list`.
   * Mirrors `ResolveSiteDeps.hasPassword` in core. Defaults to the real OS
   * keychain, so tests MUST inject a fake -- the default spawns `security`
   * (macOS) or PowerShell + `Add-Type` (Windows, which compiles C# at
   * runtime and can exceed vitest's 5s timeout under CI load).
   */
  hasPassword?(service: string, account: string): Promise<boolean>;
}

export interface AiftpMcpOptions {
  cwd?: string;
  runtime?: AiftpMcpRuntime;
  /** Shared secret for the production push gate. Never echoed in tool output. */
  confirmPhrase?: string;
  /**
   * v0.13 (Task 5, B1/B3): explicit signal that this server is running
   * inside the Claude Desktop extension. Deliberately NOT inferred from
   * `AIFTP_DESKTOP_STARTUP` -- that env var is the startup-report
   * transport, not a mode flag, and keying a safety gate off it would mean
   * the gate silently loosens the day the transport changes. Production
   * default: `process.env.AIFTP_DESKTOP === '1'`, set by
   * packages/desktop-ext/src/server-entry.ts. Terminal / Claude Code users
   * never set this, so it defaults to false.
   */
  desktopMode?: boolean;
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
  | 'aiftp_sites_list'
  | 'aiftp_init_template_list'
  | 'aiftp_profile_current'
  | 'aiftp_profile_test'
  | 'aiftp_config_migrate'
  | 'aiftp_config_migrate_prepare'
  | 'aiftp_config_migrate_confirm'
  | 'aiftp_import_filezilla'
  | 'aiftp_import_filezilla_prepare'
  | 'aiftp_import_filezilla_confirm'
  | 'aiftp_rollback'
  | 'aiftp_rollback_prepare'
  | 'aiftp_rollback_confirm'
  | 'aiftp_setup_status';

export interface AiftpMcpApp {
  cwd: string;
  runtime: AiftpMcpRuntime;
  server: McpServer;
  tools: readonly AiftpToolName[];
  resources: readonly string[];
  readonly confirmPhrase?: string;
  /**
   * v0.13 (Task 5, B3): always populated by createAiftpMcp (never left
   * undefined) so every read site can do a plain `=== true` check instead
   * of juggling undefined-means-false. See AiftpMcpOptions.desktopMode for
   * the production-default rule.
   */
  readonly desktopMode: boolean;
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
    expected_site: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Always specify this to declare the intended destination site. The value must match the registered fleet site name or label for the current working directory.',
      ),
  })
  .strict();

const pushConfirmSchema = requiredProfileSchema
  .extend({
    plan_id: z.string().min(1),
    diff_hash: z.string().min(1),
    confirm_token: z.string().min(1),
    acknowledge_deletions: z
      .literal(true)
      .optional()
      .describe(
        'Required when the prepare step returned one or more plannedDeletes. Must be the literal `true` to apply remote deletes.',
      ),
    /**
     * v0.6.0 #7: when the prepare step set `prod_profile_warning: true`
     * (profile matched `safety.prod_profile_patterns`), the confirm step
     * MUST set this to `true` as well. The point is to make the
     * production push impossible to apply by reflex — the agent has to
     * read the warning and decide.
     */
    acknowledge_production: z
      .literal(true)
      .optional()
      .describe(
        'Required when the prepare step returned prod_profile_warning=true. Must be the literal `true` to apply a push to a profile that matches safety.prod_profile_patterns. Schema-rejected if `false` is sent (no silent fallthrough to the runtime guard).',
      ),
    confirmation: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Required when the prepare step returned confirmation_challenge. The human operator must type "<challenge> <phrase>" into chat; the phrase is a shared secret the model cannot know. Do not guess it and do not compose it yourself — wait for the operator to send it.',
      ),
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

const configMigrateConfirmSchema = z
  .object({
    plan_id: z.string().min(1),
    diff_hash: z.string().min(1),
    confirm_token: z.string().min(1),
  })
  .strict();

const importFilezillaSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'Filesystem path to a FileZilla sitemanager.xml. Relative paths resolve against the MCP server cwd.',
      ),
  })
  .strict();

const importFilezillaPrepareSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'Filesystem path to a FileZilla sitemanager.xml. Relative paths resolve against the MCP server cwd.',
      ),
    keychain_prefix: z
      .string()
      .min(1)
      .default('aiftp:imported')
      .describe(
        'Keychain service prefix recorded on each imported profile. MCP never writes the Keychain — operators must run `aiftp auth` separately.',
      ),
    overwrite: z
      .boolean()
      .default(false)
      .describe(
        'When true, imported profiles replace existing entries with the same name. Default false: collisions are reported in `skipped`.',
      ),
  })
  .strict();

const importFilezillaConfirmSchema = z
  .object({
    plan_id: z.string().min(1),
    diff_hash: z.string().min(1),
    confirm_token: z.string().min(1),
  })
  .strict();

const rollbackTargetFields = {
  steps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Undo the N-th most recent push. Default 1 (most recent). Counts only auto-snapshots produced at push time — manual `aiftp backup create` snapshots are ignored unless `snapshot_id` is passed.',
    ),
  snapshot_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Explicit snapshot id from aiftp_backup_list. When set, `steps` is ignored and any snapshot type (auto / full) can be the rollback target.',
    ),
} as const;

const rollbackSchema = profileSchema.extend(rollbackTargetFields).strict();
const rollbackPrepareSchema = profileSchema.extend(rollbackTargetFields).strict();
const rollbackConfirmSchema = requiredProfileSchema
  .extend({
    plan_id: z.string().min(1),
    diff_hash: z.string().min(1),
    confirm_token: z.string().min(1),
    acknowledge_deletions: z.literal(true).optional(),
    /**
     * v0.13 (post-review): mirrors aiftp_push_confirm's acknowledge_production
     * gate exactly — same schema shape, same fail-closed behaviour on a
     * schema-rejected `false`. Rollback does NOT gate on the confirm phrase
     * (see handleRollbackConfirm): it is the recovery path and must stay
     * reachable even when the phrase is lost or misconfigured, but it still
     * writes to and deletes from a live server, so a deliberate
     * acknowledgement is required for profiles matching
     * safety.prod_profile_patterns.
     */
    acknowledge_production: z
      .literal(true)
      .optional()
      .describe(
        'Required when the prepare step returned prod_profile_warning=true. Must be the literal `true` to apply a rollback to a profile that matches safety.prod_profile_patterns. Schema-rejected if `false` is sent (no silent fallthrough to the runtime guard).',
      ),
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
  aiftp_sites_list: noArgsSchema,
  aiftp_init_template_list: noArgsSchema,
  aiftp_profile_current: noArgsSchema,
  aiftp_profile_test: profileSchema,
  aiftp_config_migrate: noArgsSchema,
  aiftp_config_migrate_prepare: noArgsSchema,
  aiftp_config_migrate_confirm: configMigrateConfirmSchema,
  aiftp_import_filezilla: importFilezillaSchema,
  aiftp_import_filezilla_prepare: importFilezillaPrepareSchema,
  aiftp_import_filezilla_confirm: importFilezillaConfirmSchema,
  aiftp_rollback: rollbackSchema,
  aiftp_rollback_prepare: rollbackPrepareSchema,
  aiftp_rollback_confirm: rollbackConfirmSchema,
  aiftp_setup_status: noArgsSchema,
} satisfies Record<AiftpToolName, z.ZodType>;

const toolDescriptions = {
  aiftp_status: 'Show local deployment diff.',
  aiftp_push: 'Run a dry-run push. For a real push, use aiftp_push_prepare + aiftp_push_confirm.',
  aiftp_push_prepare:
    'Prepare a real push: always pass expected_site to declare the intended destination site. Returns destination, plan_id, diff_hash, confirm_token, expected_file_count, and expected_remote_root. Pass the confirmation values back to aiftp_push_confirm within the TTL to actually upload. NOTE on deletions: `diff.removed` lists files that vanished locally but are still tracked in state — it is an observation, not an action. `plannedDeletes` is the subset that will actually be deleted on the remote, after safety.deletion_policy is applied. `diff.removed` non-empty with `plannedDeletes` empty means the policy is suppressing the deletes, not that they are pending.',
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
  aiftp_sites_list:
    'List registered sites as redacted summaries: name, label, path, profiles, default_profile, protocol, credentialsStatus, lastPushAt, health. Host / user / remote_root / keychain_service are NEVER surfaced. Read-only.',
  aiftp_init_template_list:
    'List available .aiftp.toml templates for `aiftp init --template <name>`. Read-only.',
  aiftp_profile_current:
    'Return the resolved default profile name (AIFTP_PROFILE env > .aiftp/state file > single-profile fallback), or null when ambiguous. Read-only.',
  aiftp_profile_test:
    'Run the connection-subset of doctor against the chosen profile. Requires the server to be constructed with `runtime.runDoctor` (the CLI wires it; bare MCP servers refuse the call). Excludes local-only checks (config-file, gitignore, profile-exists). The `ok` flag is recomputed from the filtered subset. Read-only.',
  aiftp_config_migrate:
    'Direct migration is refused — use aiftp_config_migrate_prepare + aiftp_config_migrate_confirm. Schema v1 → v2 is a one-way TOML rewrite and must echo back a plan/token.',
  aiftp_config_migrate_prepare:
    'Preview the schema v1 → v2 migration of .aiftp.toml. Returns the migrated source text, schema_before / schema_after, plan_id / diff_hash / confirm_token / ttl_ms. Idempotent: reports changed=false if already at v2. Does not write.',
  aiftp_config_migrate_confirm:
    'Apply a prepared schema migration. Triggers loadConfig() which performs the atomic write (.aiftp.toml.v1.bak as the rollback file).',
  aiftp_import_filezilla:
    'Direct import is refused — use aiftp_import_filezilla_prepare + aiftp_import_filezilla_confirm. The two-step gate keeps an AI agent from materializing arbitrary FTP profiles without operator review.',
  aiftp_import_filezilla_prepare:
    'Parse a FileZilla sitemanager.xml and return a REDACTED preview (profile names + non-credential metadata + password_kind only — actual password values are NEVER surfaced through MCP). Reports collisions against existing .aiftp.toml profile names and the list of profiles that will be skipped (SFTP / master-password-encrypted). Does not write.',
  aiftp_import_filezilla_confirm:
    'Apply a prepared FileZilla import to .aiftp.toml. Never writes the Keychain — the confirm result includes a `next_steps` field telling the operator to run `aiftp auth` for each imported profile. The MCP server never has the password value.',
  aiftp_rollback:
    'Direct rollback is refused — use aiftp_rollback_prepare + aiftp_rollback_confirm. Uploading a snapshot back to the server changes production state and must echo a plan/token.',
  aiftp_rollback_prepare:
    'Resolve the rollback target (by steps or explicit snapshot_id), apply the hard-exclude filter, and return planned files + skipped (auth-bearing) files + plan_id / diff_hash / confirm_token. No upload yet.',
  aiftp_rollback_confirm:
    'Execute a prepared rollback: decrypt each file in the snapshot and upload it back to the configured remote_root. Hard-excluded files are NEVER re-uploaded (auth credentials). Requires acknowledge_deletions: true when the prepare step returned one or more plannedDeletes.',
  aiftp_setup_status:
    'Report whether the Claude Desktop extension is fully configured: bootstrap, project directory, .aiftp.toml, keychain credential, fleet registration, production confirm phrase. Each failing check carries a Japanese `hint`. Credentials are never surfaced. Read-only.',
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
      userPatterns: config.exclude.patterns,
      useDefaults: config.exclude.use_defaults,
      additionalHardPatterns: config.backup.hard_exclude.additional_patterns,
    }),
    // v0.9.4+: forward walk policy so MCP push respects the same
    // symlink rule as the CLI.
    followSymlinks: config.walk.follow_symlinks,
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
    delete: async () => {
      throw new Error(
        'MCP push uploader is not configured yet. Use dry_run or provide a runtime uploader.',
      );
    },
  };
}

async function createDefaultFtpClient(cwd: string, profileName: string): Promise<DeployClient> {
  const config = await loadConfigForMcp(cwd);
  const profile = config.profile[profileName];
  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  const password = await getPassword(profile.keychain_service, profile.user);
  const client = createDeployClient(buildDeployClientOptions({ profile, config, password }));
  await client.connect();
  return client;
}

function uploaderFromClient(client: DeployClient): DeployUploader {
  return {
    upload: (localPath, remotePath) => client.upload(localPath, remotePath),
    delete: (remotePath) => client.delete(remotePath),
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

function dryRunBackupStore(): PushBackupStore {
  return {
    createAutoSnapshot: async () => {
      throw new Error('Dry-run backup store must not create snapshots.');
    },
  };
}

function isPushBackupStore(
  store: AiftpBackupStore | undefined,
): store is AiftpBackupStore & PushBackupStore {
  return typeof store?.createAutoSnapshot === 'function';
}

async function pushBackupStoreFor(
  app: AiftpMcpApp,
  profileName: string,
  dryRun: boolean,
  ftpClient?: DeployClient,
  runtimeStore?: PushBackupStore,
): Promise<PushBackupStore> {
  if (runtimeStore) {
    return runtimeStore;
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
  const runtimePushStore = isPushBackupStore(runtimeStore) ? runtimeStore : undefined;
  const runtimeUploader = await app.runtime.createUploader?.({
    cwd: app.cwd,
    profileName,
  });
  const needsDefaultFtp =
    !app.runtime.runPush &&
    !args.dry_run &&
    (runtimePushStore === undefined || runtimeUploader === undefined);
  const sharedFtpClient = needsDefaultFtp
    ? await createDefaultFtpClient(app.cwd, profileName)
    : undefined;

  const result = await (async () => {
    const backupStore = await pushBackupStoreFor(
      app,
      profileName,
      args.dry_run,
      sharedFtpClient,
      runtimePushStore,
    );
    const uploader =
      runtimeUploader ??
      (sharedFtpClient ? uploaderFromClient(sharedFtpClient) : unavailableUploader());
    return (app.runtime.runPush ?? runPush)({
      ...(await loadStatusContext(app.cwd, profileName, config)),
      backupStore,
      uploader,
      remoteRoot: profile.remote_root,
      files: args.files,
      dryRun: args.dry_run,
      safety: {
        maxFilesPerPush: config.safety.max_files_per_push,
        maxTotalSizeBytes: config.safety.max_total_size_mb * 1024 * 1024,
        verifyAfterUpload: config.safety.verify_after_upload === 'off' ? 'off' : 'size',
        deletionPolicy: config.safety.deletion_policy,
      },
      // v0.12.4 (Task 10 Part B): honour the config's [preflight] toggles.
      // Previously the template-written values had no runtime effect.
      preflight: (paths) =>
        checkAll(paths, {
          phpLint: config.preflight.php_lint,
          jsonCheck: config.preflight.json_check,
        }),
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
  expectedDeleteCount: number;
  expectedRemoteRoot: string;
  planned: readonly string[];
  plannedDeletes: readonly string[];
  /**
   * DISPLAY only: true when the profile matched
   * `safety.prod_profile_patterns` at prepare time (v0.6.0 #7). Decides how
   * the plan is described, never whether it may be applied — see
   * `productionConfirmationRequired`.
   */
  matchedProdPattern: boolean;
  /**
   * AUTHORIZATION: true when this plan may only be applied with a human
   * confirmation (`acknowledge_production` plus, when a phrase is
   * configured, the confirm phrase). Computed by core's
   * `requiresProductionConfirmation()`, which floors it at `true` in
   * Desktop mode so `safety.*` cannot switch the gate off from a file the
   * AI can edit (v0.13 Codex cross-review, H1). Outside Desktop mode this
   * equals `matchedProdPattern`, preserving v0.12 terminal behaviour.
   */
  productionConfirmationRequired: boolean;
  /**
   * v0.13 Codex cross-review, H3: hash of the destination this plan was
   * approved against (host / port / protocol / user / keychain service /
   * remote root / TLS settings / production classification). Re-checked
   * immediately before the upload runs.
   */
  destination: DestinationFingerprint;
  createdAt: number;
  /**
   * v0.13 (Task 5): SHA-256 digest of the human confirmation phrase, set
   * only when `productionConfirmationRequired` is true AND
   * `app.confirmPhrase` was configured at prepare time. Never the phrase itself — see
   * confirm-phrase.ts. Absence of this field on a production plan is the
   * fail-closed signal consumed by `handlePushConfirm`.
   */
  confirmationHash?: string;
}

const PLAN_TTL_MS = 5 * 60 * 1000;
const PUSH_PLAN_STORE_LIMIT = 50;
const planStore = new Map<string, PreparedPushPlan>();

function pruneExpiredPlans(now: number): void {
  for (const [id, plan] of planStore) {
    if (now - plan.createdAt > PLAN_TTL_MS) planStore.delete(id);
  }
}

function sortedCopy(files: readonly string[]): string[] {
  return [...files].sort((a, b) => a.localeCompare(b));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = sortedCopy(left);
  const sortedRight = sortedCopy(right);
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function plannedDeletesOf(result: PushResult): readonly string[] {
  return result.plannedDeletes ?? [];
}

function hashPushPlan(input: {
  profile: string;
  remoteRoot: string;
  planned: readonly string[];
  plannedDeletes: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      [
        'aiftp-push-plan-v2',
        VERSION,
        `profile=${input.profile}`,
        `remote_root=${input.remoteRoot}`,
        '[uploads]',
        ...sortedCopy(input.planned),
        '[deletes]',
        ...sortedCopy(input.plannedDeletes),
      ].join('\n'),
    )
    .digest('hex');
}

async function executePush(
  app: AiftpMcpApp,
  args: { profile: string; files?: readonly string[]; dry_run: boolean; confirmDeletes?: boolean },
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
  const runtimePushStore = isPushBackupStore(runtimeStore) ? runtimeStore : undefined;
  const runtimeUploader = await app.runtime.createUploader?.({
    cwd: app.cwd,
    profileName: args.profile,
  });
  const needsDefaultFtp =
    !app.runtime.runPush &&
    !args.dry_run &&
    (runtimePushStore === undefined || runtimeUploader === undefined);
  const sharedFtpClient = needsDefaultFtp
    ? await createDefaultFtpClient(app.cwd, args.profile)
    : undefined;
  try {
    const backupStore = await pushBackupStoreFor(
      app,
      args.profile,
      args.dry_run,
      sharedFtpClient,
      runtimePushStore,
    );
    const uploader =
      runtimeUploader ??
      (sharedFtpClient ? uploaderFromClient(sharedFtpClient) : unavailableUploader());
    return await (app.runtime.runPush ?? runPush)({
      ...(await loadStatusContext(app.cwd, args.profile, config)),
      backupStore,
      uploader,
      remoteRoot: profile.remote_root,
      files: args.files ? [...args.files] : undefined,
      dryRun: args.dry_run,
      confirmDeletes: args.confirmDeletes,
      safety: {
        maxFilesPerPush: config.safety.max_files_per_push,
        maxTotalSizeBytes: config.safety.max_total_size_mb * 1024 * 1024,
        verifyAfterUpload: config.safety.verify_after_upload === 'off' ? 'off' : 'size',
        deletionPolicy: config.safety.deletion_policy,
      },
      // v0.12.4 (Task 10 Part B): honour the config's [preflight] toggles.
      // Previously the template-written values had no runtime effect.
      preflight: (paths) =>
        checkAll(paths, {
          phpLint: config.preflight.php_lint,
          jsonCheck: config.preflight.json_check,
        }),
    });
  } finally {
    await sharedFtpClient?.disconnect();
  }
}

/**
 * Fingerprint the destination a prepare step is about to hand out, from the
 * config it just read. Confirm re-runs this against a freshly-read config
 * and refuses on any difference (v0.13 Codex cross-review, H3).
 *
 * Both call sites go through this one function so the two fingerprints can
 * never be computed over different inputs — the production classification in
 * particular has to be derived identically on both sides.
 */
function fingerprintDestination(
  app: AiftpMcpApp,
  profileName: string,
  profile: ProfileConfig,
  config: Config,
): DestinationFingerprint {
  return computeDestinationFingerprint({
    profile,
    config,
    productionConfirmationRequired: requiresProductionConfirmation({
      profileName,
      patterns: config.safety.prod_profile_patterns,
      warnEnabled: config.safety.warn_on_prod_profile,
      desktopMode: app.desktopMode === true,
    }),
  });
}

/**
 * Refuse, as a structured tool error, when the destination drifted between
 * prepare and confirm. Names the changed components (`host`, `user`, ...)
 * rather than echoing their values: this project's redaction contract allows
 * remote_root / host / user in messages, but naming beats dumping — and the
 * fingerprint itself only ever holds hashes.
 */
function assertDestinationUnchanged(input: {
  app: AiftpMcpApp;
  profileName: string;
  expected: DestinationFingerprint;
  config: Config;
  prepareToolName: 'aiftp_push_prepare' | 'aiftp_rollback_prepare';
}): void {
  const profile = input.config.profile[input.profileName];
  if (!profile) {
    throw new Error(
      `destination-changed: profile "${input.profileName}" is no longer defined in .aiftp.toml. Call ${input.prepareToolName} again to inspect the current destination.`,
    );
  }
  const current = fingerprintDestination(input.app, input.profileName, profile, input.config);
  if (current.digest === input.expected.digest) return;
  const changed = describeDestinationChange(input.expected, current);
  const detail = changed.length > 0 ? ` (changed: ${changed.join(', ')})` : '';
  throw new Error(
    `destination-changed: the deployment destination for profile "${input.profileName}" changed between prepare and confirm${detail}. Refusing to write to a destination the operator did not approve. Call ${input.prepareToolName} again to inspect the current destination.`,
  );
}

/**
 * First sentence of every production-gate message. When the profile matched
 * the user's own patterns it says so (the v0.12 wording, byte-identical on
 * the terminal). When the gate comes from the Desktop-mode floor instead, it
 * must NOT claim a pattern match that did not happen — the operator may have
 * emptied `prod_profile_patterns` and would rightly distrust a message that
 * contradicts their own config.
 */
function productionGateReason(profileName: string, matchedProdPattern: boolean): string {
  return matchedProdPattern
    ? `Profile "${profileName}" matches safety.prod_profile_patterns.`
    : `Claude Desktop mode always requires human confirmation before writing to profile "${profileName}", regardless of safety.prod_profile_patterns.`;
}

async function handlePushPrepare(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = pushPrepareSchema.parse(rawArgs ?? {});
  const config = await loadConfigForMcp(app.cwd);
  const profileName = await resolveProfileArg(app.cwd, args.profile, config);
  const profile = config.profile[profileName];
  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  const { destination, matchedEntry, registryReadFailed } = await resolveDestination(
    app,
    profileName,
    profile,
  );
  if (args.expected_site !== undefined) {
    if (registryReadFailed) {
      throw new Error(
        `site-mismatch: cannot verify expected site "${args.expected_site}" because the fleet registry is unavailable.`,
      );
    }
    if (!matchedEntry) {
      throw new Error(
        `site-mismatch: cannot verify expected site "${args.expected_site}" because the current working directory is not registered in the fleet.`,
      );
    }
    if (args.expected_site !== matchedEntry.name && args.expected_site !== matchedEntry.label) {
      const actualLabel = matchedEntry.label ? ` (label: "${matchedEntry.label}")` : '';
      throw new Error(
        `site-mismatch: expected site "${args.expected_site}" does not match actual site "${matchedEntry.name}"${actualLabel}.`,
      );
    }
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
  // Two separate decisions, deliberately not one value (v0.13 Codex
  // cross-review, H1 — see packages/core/src/safety.ts):
  //   matchedProdPattern              -> how the plan is DESCRIBED
  //   productionConfirmationRequired  -> whether it may be APPLIED
  // v0.6.0 #7: the description tells AI agents to echo
  // `acknowledge_production: true` back to confirm, preventing reflexive
  // end-to-end automation from blowing up production. The authorization
  // value is floored at true in Desktop mode, so writing
  // `warn_on_prod_profile = false` (or emptying `prod_profile_patterns`)
  // into `.aiftp.toml` can no longer remove the gate.
  const matchedProdPattern = isProdProfile({
    profileName,
    patterns: config.safety.prod_profile_patterns,
    warnEnabled: config.safety.warn_on_prod_profile,
  });
  const productionConfirmationRequired = requiresProductionConfirmation({
    profileName,
    patterns: config.safety.prod_profile_patterns,
    warnEnabled: config.safety.warn_on_prod_profile,
    desktopMode: app.desktopMode === true,
  });
  const destinationFingerprint = fingerprintDestination(app, profileName, profile, config);
  const now = Date.now();
  pruneExpiredPlans(now);
  const planId = randomUUID();
  const diffHash = hashPushPlan({
    profile: profileName,
    remoteRoot: profile.remote_root,
    planned: previewResult.planned,
    plannedDeletes: plannedDeletesOf(previewResult),
  });
  const plannedDeletes = plannedDeletesOf(previewResult);
  const confirmToken = randomBytes(24).toString('base64url');
  // v0.13 (Task 5): production pushes are gated behind a human-supplied
  // confirmation phrase — the replacement for MCP elicitation, which
  // Claude Desktop does not support. A challenge is only minted when this
  // is a production plan AND a phrase is actually configured; see the
  // fail-closed check in handlePushConfirm for what happens otherwise.
  const confirmationChallenge =
    productionConfirmationRequired && app.confirmPhrase !== undefined
      ? generateChallenge()
      : undefined;
  planStore.set(planId, {
    planId,
    diffHash,
    confirmToken,
    profile: profileName,
    files: args.files,
    expectedFileCount: previewResult.planned.length,
    expectedDeleteCount: plannedDeletes.length,
    expectedRemoteRoot: profile.remote_root,
    planned: previewResult.planned,
    plannedDeletes,
    matchedProdPattern,
    productionConfirmationRequired,
    destination: destinationFingerprint,
    createdAt: now,
    ...(confirmationChallenge === undefined || app.confirmPhrase === undefined
      ? {}
      : { confirmationHash: hashConfirmation(confirmationChallenge, app.confirmPhrase) }),
  });
  while (planStore.size > PUSH_PLAN_STORE_LIMIT) {
    const oldest = planStore.keys().next().value;
    if (oldest === undefined) break;
    planStore.delete(oldest);
  }
  if (confirmationChallenge !== undefined) {
    await appendLogEntry(app.cwd, {
      at: new Date().toISOString(),
      event: 'confirm-phrase-challenge',
      profile: profileName,
      plan_id: planId,
    });
  }
  return textResult({
    ok: true,
    profile: profileName,
    destination,
    plan_id: planId,
    diff_hash: diffHash,
    confirm_token: confirmToken,
    expected_file_count: previewResult.planned.length,
    expected_delete_count: plannedDeletes.length,
    expected_remote_root: profile.remote_root,
    diff: previewResult.diff,
    planned: previewResult.planned,
    plannedDeletes,
    ttl_ms: PLAN_TTL_MS,
    // Reports the DISPLAY decision, so an operator who set
    // `warn_on_prod_profile = false` still sees their own classification.
    // The gate below follows the AUTHORIZATION decision instead.
    prod_profile_warning: matchedProdPattern,
    // v0.13 (Task 5, B4/B5): the message text must match which of the four
    // (desktopMode, confirmPhrase) rows this plan falls into. Outside
    // Desktop mode with no phrase configured (row 4), the message is
    // byte-for-byte the original v0.12 text -- no mention of a confirm
    // phrase or Claude Desktop, since that row's behaviour is unchanged.
    // Outside Desktop mode `productionConfirmationRequired` always equals
    // `matchedProdPattern`, so every terminal response below is identical
    // to v0.12's, down to the leading sentence.
    ...(productionConfirmationRequired
      ? {
          prod_profile_message:
            app.confirmPhrase !== undefined
              ? `${productionGateReason(profileName, matchedProdPattern)} To confirm, pass acknowledge_production: true to aiftp_push_confirm along with the plan_id / diff_hash / confirm_token, plus the confirmation phrase below.`
              : app.desktopMode === true
                ? `${productionGateReason(profileName, matchedProdPattern)} No confirmation phrase is configured, so aiftp_push_confirm will refuse this plan even with acknowledge_production: true. Claude Desktop の設定 → 拡張機能 → aiftp で「合言葉」欄を入力し、Claude Desktop を再起動してください。`
                : `${productionGateReason(profileName, matchedProdPattern)} To confirm, pass acknowledge_production: true to aiftp_push_confirm along with the plan_id / diff_hash / confirm_token.`,
        }
      : {}),
    ...(confirmationChallenge === undefined
      ? {}
      : {
          confirmation_challenge: confirmationChallenge,
          confirmation_instruction: `本番へ反映します。人間が次の1行をそのままチャットに入力してください: 「${confirmationChallenge} <合言葉>」。合言葉は Claude Desktop の設定に登録されたもので、AI は知りません。`,
        }),
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
  // v0.6.0 #7: production gate. When prepare decided this plan needs a
  // human confirmation, confirm requires explicit `acknowledge_production
  // = true`. This makes echo-the-plan-verbatim insufficient — the
  // agent has to make a separate decision.
  if (plan.productionConfirmationRequired && args.acknowledge_production !== true) {
    // The matched-pattern wording is v0.12's, character for character:
    // outside Desktop mode this is the only branch reachable, and terminal
    // callers must not see a changed message.
    throw new Error(
      plan.matchedProdPattern
        ? `Production push refused: profile "${plan.profile}" matches safety.prod_profile_patterns. Re-call aiftp_push_confirm with acknowledge_production: true.`
        : `Production push refused: Claude Desktop mode always requires human confirmation before writing to profile "${plan.profile}", regardless of safety.prod_profile_patterns. Re-call aiftp_push_confirm with acknowledge_production: true.`,
    );
  }
  // v0.13 (Task 5, amended by 「Task 5 修正条項」B4): production pushes are
  // gated behind a human confirmation phrase — the replacement for MCP
  // elicitation (unavailable in Claude Desktop). `plan.confirmationHash` is
  // set whenever a phrase was configured at prepare time (rows 1 & 3),
  // regardless of desktopMode, so the gate below applies uniformly. In
  // Desktop mode `productionConfirmationRequired` is always true (H1), so
  // "which plans reach this gate" is no longer answerable from
  // `.aiftp.toml` there. It is ONLY when a gated plan has NO
  // confirmationHash that desktopMode
  // decides the outcome: fail closed inside Claude Desktop (row 2, where a
  // missing phrase is a misconfiguration), but preserve the v0.12
  // acknowledge_production-only behaviour on the terminal (row 4, where a
  // missing phrase is normal and expected — existing npm users never
  // configure one).
  if (plan.productionConfirmationRequired) {
    if (plan.confirmationHash === undefined) {
      if (app.desktopMode === true) {
        throw new Error(
          'confirm-phrase-not-configured: production pushes require a human confirmation phrase, and none is configured. Claude Desktop の設定 → 拡張機能 → aiftp で「合言葉」欄を入力し、Claude Desktop を再起動してください。',
        );
      }
      // desktopMode is false: row 4, v0.12 behaviour preserved on purpose.
      // Skip the rest of this block entirely — acknowledge_production
      // alone (already checked above) is sufficient, and the confirm
      // phrase is never mentioned.
    } else {
      if (args.confirmation === undefined) {
        throw new Error(
          'confirmation-required: this production plan needs the human confirmation phrase. Ask the operator to type "<challenge> <phrase>" in chat, then pass it verbatim as `confirmation`.',
        );
      }
      if (!verifyConfirmation(args.confirmation, plan.confirmationHash)) {
        // v0.13 Codex cross-review, H2: one challenge, one attempt. The
        // challenge is handed to the caller, so the phrase is the only
        // secret in the pair — and an instructor-chosen phrase (a course
        // name, a year) is dictionary-guessable given unlimited tries
        // against a live plan for the full 5-minute TTL. Consuming the
        // plan here (and ONLY here — a missing acknowledge_production, a
        // stale diff_hash or a bad confirm_token are ordinary mistakes,
        // not guesses at a secret) makes each guess cost a full
        // aiftp_push_prepare round-trip.
        planStore.delete(args.plan_id);
        throw new Error(
          'confirmation-mismatch: the confirmation phrase did not match. This plan is now spent — call aiftp_push_prepare again to obtain a fresh challenge.',
        );
      }
      await appendLogEntry(app.cwd, {
        at: new Date().toISOString(),
        event: 'confirm-phrase-accepted',
        profile: plan.profile,
        plan_id: plan.planId,
      });
    }
  }
  if (plan.plannedDeletes.length > 0 && args.acknowledge_deletions !== true) {
    throw new Error(
      `Deletion push refused: ${plan.plannedDeletes.length} remote delete(s) were planned. Re-call aiftp_push_confirm with acknowledge_deletions: true.`,
    );
  }
  const preview = await executePush(app, {
    profile: plan.profile,
    files: plan.files,
    dry_run: true,
  });
  const currentConfig = await loadConfigForMcp(app.cwd);
  const currentRemoteRoot =
    currentConfig.profile[plan.profile]?.remote_root ?? plan.expectedRemoteRoot;
  const currentDiffHash = hashPushPlan({
    profile: plan.profile,
    remoteRoot: currentRemoteRoot,
    planned: preview.planned,
    plannedDeletes: plannedDeletesOf(preview),
  });
  if (
    currentDiffHash !== plan.diffHash ||
    !sameStringSet(preview.planned, plan.planned) ||
    !sameStringSet(plannedDeletesOf(preview), plan.plannedDeletes)
  ) {
    throw new Error(
      'diff_hash mismatch: the upload/delete plan drifted between prepare and confirm. Call aiftp_push_prepare again to inspect the new plan.',
    );
  }
  // v0.13 Codex cross-review, H3: the drift check above only proves the
  // FILE SET is unchanged. Re-check WHERE those files are about to go,
  // from the freshly-read config, immediately before executing — editing
  // `.aiftp.toml`'s host / user / protocol / keychain service between
  // prepare and confirm would otherwise redirect this upload (and its
  // deletes) to a server the human never approved.
  assertDestinationUnchanged({
    app,
    profileName: plan.profile,
    expected: plan.destination,
    config: currentConfig,
    prepareToolName: 'aiftp_push_prepare',
  });
  // Consume the plan before performing the side-effectful push so a second
  // confirm with the same token cannot replay the upload.
  planStore.delete(args.plan_id);
  const result = await executePush(app, {
    profile: plan.profile,
    files: plan.files,
    dry_run: false,
    confirmDeletes: plan.plannedDeletes.length > 0,
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
  const probe = app.runtime.hasPassword ?? hasPassword;
  for (const name of names) {
    const profile = config.profile[name];
    if (!profile) continue;
    // Keychain probe — `security find-generic-password` on macOS and
    // CredRead on Windows only check whether an entry exists; they do not
    // expose the secret value. We surface three states so an AI agent can
    // tell "missing password" apart from "Keychain access blocked".
    let credentialsStatus: CredentialsStatus;
    try {
      credentialsStatus = (await probe(profile.keychain_service, profile.user))
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

interface SiteSummary {
  name: string;
  label?: string;
  path: string;
  profiles: readonly string[];
  default_profile?: string;
  protocol?: 'ftp' | 'ftps' | 'sftp';
  credentialsStatus: CredentialsStatus;
  lastPushAt?: string;
  health: 'ok' | 'missing' | 'invalid';
}

interface DestinationSummary {
  site?: string;
  label?: string;
  profile: string;
  remote_root: string;
  server_kind: string;
}

async function resolveDestination(
  app: AiftpMcpApp,
  profileName: string,
  profile: { readonly remote_root: string; readonly server_kind: string },
): Promise<{
  destination: DestinationSummary;
  matchedEntry?: SiteEntry;
  registryReadFailed: boolean;
}> {
  let matchedEntry: SiteEntry | undefined;
  let registryReadFailed = false;
  try {
    const registry = app.runtime.createSiteRegistry?.() ?? new SiteRegistry();
    const entries = await registry.list();
    matchedEntry = entries.find((entry) => resolve(entry.path) === resolve(app.cwd));
  } catch {
    registryReadFailed = true;
  }

  return {
    destination: {
      site: matchedEntry?.name,
      label: matchedEntry?.label,
      profile: profileName,
      remote_root: profile.remote_root,
      server_kind: profile.server_kind,
    },
    matchedEntry,
    registryReadFailed,
  };
}

async function handleSetupStatus(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  noArgsSchema.parse(rawArgs ?? {});
  const report = await buildSetupStatus({
    startup: process.env.AIFTP_DESKTOP_STARTUP,
    confirmPhrase: app.confirmPhrase,
    pathExists: async (path: string) => {
      try {
        return (await stat(path)) !== undefined;
      } catch {
        return false;
      }
    },
    siteRegistered: async (siteName: string, projectDir: string) => {
      try {
        const registry = app.runtime.createSiteRegistry?.() ?? new SiteRegistry();
        const entries = await registry.list();
        return entries.some(
          (entry) => entry.name === siteName && resolve(entry.path) === resolve(projectDir),
        );
      } catch {
        return false;
      }
    },
  });
  return textResult(report, report.ok ? undefined : true);
}

async function handleSitesList(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  noArgsSchema.parse(rawArgs ?? {});
  const registry = app.runtime.createSiteRegistry?.() ?? new SiteRegistry();
  const resolveSiteEntry =
    app.runtime.resolveSite ?? ((entry: SiteEntry) => resolveSite(entry, { hasPassword }));
  const entries = await registry.list();
  const resolvedSites = await Promise.all(entries.map((entry) => resolveSiteEntry(entry)));
  const sites: SiteSummary[] = resolvedSites.map((resolvedSite) => ({
    name: resolvedSite.name,
    label: resolvedSite.label,
    path: resolvedSite.path,
    profiles: resolvedSite.profiles,
    default_profile: resolvedSite.default_profile,
    protocol: resolvedSite.protocol,
    credentialsStatus: resolvedSite.credentialsStatus,
    lastPushAt: resolvedSite.lastPushAt,
    health: resolvedSite.health,
  }));
  return textResult({ ok: true, sites });
}

async function handleInitTemplateList(
  _app: AiftpMcpApp,
  rawArgs: unknown,
): Promise<CallToolResult> {
  noArgsSchema.parse(rawArgs ?? {});
  const payload = listTemplates().map(({ id, description, longDescription }) => ({
    id,
    description,
    longDescription,
  }));
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
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

// ---------------------------------------------------------------------------
// v0.4.2: prepare/confirm gates for aiftp_config_migrate and
// aiftp_import_filezilla. Same plan_id / diff_hash / confirm_token /
// in-memory-store discipline as aiftp_push to keep AI agents from applying
// either side-effectful operation without echoing the plan back verbatim.
// ---------------------------------------------------------------------------

interface PreparedMigratePlan {
  planId: string;
  confirmToken: string;
  /**
   * SHA-256 of the original (pre-migration) source. Used as BOTH the
   * `diff_hash` returned to the caller and the drift check at confirm
   * time. Claude review (medium): keeping a separate `diffHash` field
   * that always equaled `sourceHash` invited confusion — collapsed to
   * one field.
   */
  sourceHash: string;
  schemaBefore: number;
  schemaAfter: number;
  sectionsAdded: string[];
  changed: boolean;
  createdAt: number;
}

const migratePlanStore = new Map<string, PreparedMigratePlan>();

function pruneExpiredMigratePlans(now: number): void {
  for (const [id, plan] of migratePlanStore) {
    if (now - plan.createdAt > PLAN_TTL_MS) migratePlanStore.delete(id);
  }
}

async function handleConfigMigrate(_app: AiftpMcpApp, _rawArgs: unknown): Promise<CallToolResult> {
  throw new Error(
    'aiftp_config_migrate refuses direct invocation. Use the two-step flow: aiftp_config_migrate_prepare to preview the migration, then aiftp_config_migrate_confirm to apply it.',
  );
}

function detectSchemaVersion(source: string): number {
  const match = source.match(/^\s*schema\s*=\s*([0-9]+)/mu);
  if (!match) {
    throw new Error('Could not detect schema version in .aiftp.toml (missing `schema =` line).');
  }
  return Number(match[1]);
}

/**
 * Normalize Windows line endings before any diffing or hashing. FileZilla
 * is a Windows-first tool and operators frequently hand-edit `.aiftp.toml`
 * in editors that emit `\r\n`. We want the migration / drift check to
 * behave identically regardless of source line endings.
 */
function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/gu, '\n');
}

async function readTomlSource(cwd: string): Promise<string> {
  return readFile(join(cwd, '.aiftp.toml'), 'utf8')
    .then(normalizeLineEndings)
    .catch((error: unknown) => {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not read .aiftp.toml in ${cwd}. Run \`aiftp init\` to scaffold one. Underlying error: ${cause}`,
      );
    });
}

/**
 * Identify which top-level sections (`[encoding]`, `[quirks]`, ...) the
 * v1→v2 migration appended. This lets `aiftp_config_migrate_prepare`
 * surface a redacted *structural* diff to MCP clients without echoing
 * sensitive credentials inside `[profile.*]` blocks. Codex review
 * (block): returning the full TOML source through MCP violates the
 * aiftp://config redaction policy.
 */
function detectAddedSections(oldSource: string, newSource: string): string[] {
  const tagRe = /^\[[^\]\r\n]+\]/gmu;
  const oldSections = new Set(Array.from(oldSource.matchAll(tagRe)).map((m) => m[0]));
  const newSections = Array.from(newSource.matchAll(tagRe)).map((m) => m[0]);
  // Profile sections (`[profile.foo]`) are filtered out — those are
  // operator-defined identifiers, not migration-added scaffolding, and we
  // do not want their names appearing in the MCP response either.
  return newSections.filter((s) => !oldSections.has(s) && !s.startsWith('[profile.'));
}

async function handleConfigMigratePrepare(
  app: AiftpMcpApp,
  rawArgs: unknown,
): Promise<CallToolResult> {
  noArgsSchema.parse(rawArgs ?? {});
  const source = await readTomlSource(app.cwd);
  const schemaBefore = detectSchemaVersion(source);
  const migration = migrateV1ToV2Source(source);
  const schemaAfter = migration.changed ? 2 : schemaBefore;
  const sectionsAdded = migration.changed ? detectAddedSections(source, migration.source) : [];
  const now = Date.now();
  pruneExpiredMigratePlans(now);
  const planId = randomUUID();
  // diff_hash is the SHA-256 of the *original* source. At confirm time
  // we re-read the file and recompute this hash; any drift between
  // prepare and confirm causes confirm to refuse. (Codex review: storing
  // only the post-migration hash leaves a window where the operator
  // could hand-edit the pre-migration file and confirm an unreviewed
  // version.)
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const confirmToken = randomBytes(24).toString('base64url');
  migratePlanStore.set(planId, {
    planId,
    confirmToken,
    sourceHash,
    schemaBefore,
    schemaAfter,
    sectionsAdded,
    changed: migration.changed,
    createdAt: now,
  });
  // NOTE: `migrated_source` is intentionally NOT in the response. Returning
  // the full migrated TOML would echo every host / user / keychain_service
  // through MCP and contradict the aiftp://config redaction policy. The AI
  // agent gets a structured summary; the operator can `cat .aiftp.toml`
  // themselves for the literal preview.
  return textResult({
    ok: true,
    plan_id: planId,
    diff_hash: sourceHash,
    confirm_token: confirmToken,
    ttl_ms: PLAN_TTL_MS,
    changed: migration.changed,
    schema_before: schemaBefore,
    schema_after: schemaAfter,
    sections_added: sectionsAdded,
  });
}

async function handleConfigMigrateConfirm(
  app: AiftpMcpApp,
  rawArgs: unknown,
): Promise<CallToolResult> {
  const args = configMigrateConfirmSchema.parse(rawArgs ?? {});
  const now = Date.now();
  pruneExpiredMigratePlans(now);
  const plan = migratePlanStore.get(args.plan_id);
  if (!plan) {
    throw new Error(
      `Unknown or expired plan_id: ${args.plan_id}. Call aiftp_config_migrate_prepare again to obtain a fresh plan.`,
    );
  }
  if (plan.sourceHash !== args.diff_hash) {
    throw new Error(
      'diff_hash mismatch: refusing to migrate. The plan was prepared for a different .aiftp.toml. Call aiftp_config_migrate_prepare again to inspect the new plan.',
    );
  }
  if (plan.confirmToken !== args.confirm_token) {
    throw new Error('confirm_token mismatch: refusing to migrate.');
  }
  // Drift policy: SHA-256 of the file CONTENT. Inode / mode / permission
  // changes are intentionally ignored — we care about whether the bytes
  // we previewed at prepare time are still the bytes we are about to
  // migrate, not about ownership or timestamps. This matches `aiftp
  // config migrate` CLI semantics.
  const currentSource = await readTomlSource(app.cwd);
  const currentHash = createHash('sha256').update(currentSource).digest('hex');
  if (currentHash !== plan.sourceHash) {
    throw new Error(
      '.aiftp.toml drifted between prepare and confirm: refusing to migrate. Call aiftp_config_migrate_prepare again to review the new content.',
    );
  }
  // Consume the plan before any side-effectful work so a second confirm
  // with the same token cannot replay the migration. (Uniform contract:
  // one plan = at most one confirm. Replay on the changed=false branch
  // would be harmless, but consuming makes the rule trivial to reason
  // about — and matches aiftp_push_confirm / aiftp_backup_restore_confirm.)
  migratePlanStore.delete(args.plan_id);
  if (!plan.changed) {
    return textResult({
      ok: true,
      plan_id: args.plan_id,
      changed: false,
      schema_before: plan.schemaBefore,
      schema_after: plan.schemaAfter,
      message: 'Config is already at the latest schema; no write performed.',
    });
  }
  // Codex 2nd-round review (block): inline the migration write at the MCP
  // layer instead of delegating to loadConfig(). loadConfig re-reads the
  // file from disk, which opens a TOCTOU window between our hash check
  // above and core's read — a parallel CLI invocation could slip a
  // different file through. By computing the migration from the same
  // `currentSource` we just hash-verified, we close that window.
  //
  // The write itself mirrors core's `writeMigratedConfig`:
  //   1. multi-run guard (refuse if .v1.bak already exists)
  //   2. write new content to a tmp sibling
  //   3. rename original -> .v1.bak
  //   4. rename tmp -> original
  //   5. append a migration log entry
  // Each rename is atomic on a single filesystem. Steps 1+3 still have a
  // small TOCTOU window for the .v1.bak guard against truly concurrent
  // confirms; closing that completely would need flock(2) which is
  // overkill for the MCP single-operator MVP.
  const tomlPath = join(app.cwd, '.aiftp.toml');
  const backupPath = `${tomlPath}.v1.bak`;
  // Multi-run guard. Only ENOENT means "no existing backup, safe to
  // proceed". Permission errors and other I/O failures must surface
  // unchanged so we don't silently overwrite a backup we couldn't probe.
  let backupExists = false;
  try {
    await access(backupPath);
    backupExists = true;
  } catch (error: unknown) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== 'ENOENT') throw error;
  }
  if (backupExists) {
    throw new Error(
      `Refusing to migrate because ${backupPath} already exists. Move or delete it before running migrate again.`,
    );
  }
  const migration = migrateV1ToV2Source(currentSource);
  // tmp filename uses randomUUID for cross-process collision safety —
  // matches core/config.ts writeMigratedConfig. `migration.source` is
  // whatever migrateV1ToV2Source returns (LF-terminated as of v0.2);
  // if the original .aiftp.toml was CRLF, the bak preserves CRLF (we
  // rename it as-is) and the new file is LF. Documented limitation:
  // Windows operators who care can re-save in their editor with CRLF
  // after migration.
  const tmpPath = `${tomlPath}.tmp.${process.pid}.${randomUUID()}`;
  let originalRenamed = false;
  try {
    await writeFile(tmpPath, migration.source, { encoding: 'utf8', mode: 0o600 });
    await rename(tomlPath, backupPath);
    originalRenamed = true;
    await rename(tmpPath, tomlPath);
  } catch (error: unknown) {
    // Best-effort rollback. The second rename can still fail (filesystem
    // full, removed, etc.) and we cannot guarantee the original state is
    // perfectly restored — but we DO guarantee no half-written file ever
    // lives at `tomlPath` itself (because rename(2) is atomic per inode).
    // The worst case here is: tmp removed, original may live at
    // `backupPath` instead of `tomlPath`. The operator can `mv .aiftp
    // .toml.v1.bak .aiftp.toml` to recover. Mirroring CLI semantics.
    await unlink(tmpPath).catch(() => undefined);
    if (originalRenamed) {
      await rename(backupPath, tomlPath).catch(() => undefined);
    }
    throw error;
  }
  // Migration log format matches core/config.ts:appendMigrationLog so a
  // single parser (or `aiftp config history` in a future release) can
  // consume entries regardless of who triggered the migration.
  await mkdir(join(app.cwd, '.aiftp', 'logs'), { recursive: true });
  await appendFile(
    join(app.cwd, '.aiftp', 'logs', 'migrations.jsonl'),
    `${JSON.stringify({
      fromSchema: 1,
      toSchema: 2,
      migratedAt: new Date().toISOString(),
      toolVersion: VERSION,
      source: 'mcp',
    })}\n`,
    'utf8',
  );
  return textResult({
    ok: true,
    plan_id: args.plan_id,
    changed: true,
    schema_before: plan.schemaBefore,
    schema_after: plan.schemaAfter,
    backup_path: '.aiftp.toml.v1.bak',
  });
}

interface PreparedFilezillaImportPlan {
  planId: string;
  diffHash: string;
  confirmToken: string;
  /**
   * Profiles that will actually be written. Already filtered against
   * SFTP / master-encrypted / collision-without-overwrite / batch
   * duplicate, so confirm just needs to materialize TOML blocks.
   *
   * `isOverwrite` drives confirm-side block replacement: when true, the
   * existing `[profile.<name>]` block is removed before the new one is
   * appended. (Otherwise the previous v0.4.2 RC double-wrote.)
   */
  queued: Array<{
    name: string;
    block: string;
    keychainService: string;
    user: string;
    isOverwrite: boolean;
  }>;
  /**
   * SHA-256 of the existing `.aiftp.toml` source at prepare time. confirm
   * recomputes this hash; on drift we re-scan the live file for new
   * collisions rather than blindly refusing. Cosmetic edits (added
   * comments etc.) are tolerated.
   */
  existingHash: string;
  collisions: string[];
  skipped: Array<{ name: string; reason: string }>;
  warnings: string[];
  overwrite: boolean;
  createdAt: number;
}

const filezillaImportPlanStore = new Map<string, PreparedFilezillaImportPlan>();

function pruneExpiredFilezillaImportPlans(now: number): void {
  for (const [id, plan] of filezillaImportPlanStore) {
    if (now - plan.createdAt > PLAN_TTL_MS) filezillaImportPlanStore.delete(id);
  }
}

async function handleImportFilezilla(
  _app: AiftpMcpApp,
  _rawArgs: unknown,
): Promise<CallToolResult> {
  throw new Error(
    'aiftp_import_filezilla refuses direct invocation. Use the two-step flow: aiftp_import_filezilla_prepare to preview, then aiftp_import_filezilla_confirm to apply.',
  );
}

/**
 * Render a single imported FileZilla profile into the same TOML block
 * shape the CLI uses (see runImportFilezilla in packages/cli). Kept
 * narrowly here so the MCP server doesn't depend on the CLI internals.
 */
function renderImportedProfileBlock(
  profile: ImportedProfile,
  keychainService: string,
): { name: string; block: string } {
  const aiftpProtocol =
    profile.protocol === 'ftp' ? 'ftp' : profile.protocol === 'sftp' ? 'sftp' : 'ftps';
  const ftpsMode = profile.protocol.startsWith('ftps_')
    ? profile.protocol === 'ftps_explicit'
      ? 'explicit'
      : 'implicit'
    : undefined;
  const port =
    profile.port ||
    (profile.protocol === 'sftp' ? 22 : profile.protocol === 'ftps_implicit' ? 990 : 21);
  const lines: string[] = [
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
  return { name: profile.name, block: lines.join('\n') };
}

async function handleImportFilezillaPrepare(
  app: AiftpMcpApp,
  rawArgs: unknown,
): Promise<CallToolResult> {
  const args = importFilezillaPrepareSchema.parse(rawArgs ?? {});
  const xmlAbsolute = isAbsolute(args.path) ? args.path : join(app.cwd, args.path);
  const xml = await readFile(xmlAbsolute, 'utf8').catch((error: unknown) => {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read FileZilla sitemanager XML at ${args.path}. Underlying error: ${cause}`,
    );
  });
  const parsed = parseFilezillaXml(xml);

  // Read existing profile names from raw TOML to avoid triggering the
  // v1→v2 auto-migration as a side effect of the prepare step (the
  // operator opts in to the write via the confirm step instead).
  const tomlPath = join(app.cwd, '.aiftp.toml');
  const existingSource = normalizeLineEndings(await readFile(tomlPath, 'utf8').catch(() => ''));
  const existingHash = createHash('sha256').update(existingSource).digest('hex');
  const existingNames = new Set(
    Array.from(existingSource.matchAll(/^\[profile\.([^\]]+)\]/gmu)).map((m) => m[1] ?? ''),
  );

  const queued: PreparedFilezillaImportPlan['queued'] = [];
  const collisions: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const redactedProfiles: Array<Record<string, unknown>> = [];
  // Codex review (block): when the FileZilla XML contains two `<Server>`
  // entries with the same `<Name>`, both got queued and confirm wrote two
  // `[profile.<name>]` blocks. We dedup within the batch on first
  // occurrence — second one is reported as skipped with a clear reason.
  const seenInBatch = new Set<string>();

  for (const profile of parsed.profiles) {
    // Codex/Claude review: read ONLY the `kind` discriminator from the
    // password union. password.value / password.cipherText are
    // intentionally never read here so a future refactor that spreads
    // `profile.password` cannot leak the encoded password into MCP
    // responses. The typed Pick below is a structural guarantee.
    const passwordKind: ImportedProfile['password']['kind'] = profile.password.kind;
    if (seenInBatch.has(profile.name)) {
      // Skip duplicates BEFORE pushing to redactedProfiles — otherwise an
      // operator who reads `profiles.length` as "number of profiles to
      // import" gets a misleading count. (Codex MEDIUM/LOW.)
      skipped.push({
        name: profile.name,
        reason: 'duplicate name within import batch (kept the first occurrence)',
      });
      continue;
    }
    redactedProfiles.push({
      name: profile.name,
      host: profile.host,
      port: profile.port,
      protocol: profile.protocol,
      user: profile.user,
      remote_root: profile.remote_root,
      password_kind: passwordKind,
      warnings: profile.warnings,
    });
    if (passwordKind === 'master-encrypted') {
      skipped.push({
        name: profile.name,
        reason: 'master-password-encrypted entry skipped (cannot decrypt without master password)',
      });
      continue;
    }
    const conflict = existingNames.has(profile.name);
    if (conflict && !args.overwrite) {
      collisions.push(profile.name);
      skipped.push({
        name: profile.name,
        reason: 'name conflict with existing profile (pass overwrite=true to replace)',
      });
      continue;
    }
    const keychainService = `${args.keychain_prefix}:${profile.name}`;
    const { block } = renderImportedProfileBlock(profile, keychainService);
    queued.push({
      name: profile.name,
      block,
      keychainService,
      user: profile.user,
      isOverwrite: conflict,
    });
    seenInBatch.add(profile.name);
  }

  const now = Date.now();
  pruneExpiredFilezillaImportPlans(now);
  const planId = randomUUID();
  // diff_hash binds confirm to exactly this set of (name, block) pairs.
  // We sort with `localeCompare(en)` so the hash is stable across V8
  // versions and platforms. The sort is only used for hashing — the
  // operator-visible `queued_names` array preserves the original XML
  // order so the prepare output remains intuitive to review.
  const planSignature = queued
    .map((q) => `${q.name}\n${q.block}`)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .join('\n---\n');
  const diffHash = createHash('sha256').update(planSignature).digest('hex');
  const confirmToken = randomBytes(24).toString('base64url');
  filezillaImportPlanStore.set(planId, {
    planId,
    diffHash,
    confirmToken,
    queued,
    existingHash,
    collisions,
    skipped,
    warnings: parsed.warnings,
    overwrite: args.overwrite,
    createdAt: now,
  });

  return textResult({
    ok: true,
    plan_id: planId,
    diff_hash: diffHash,
    confirm_token: confirmToken,
    ttl_ms: PLAN_TTL_MS,
    profiles: redactedProfiles,
    queued_names: queued.map((q) => q.name),
    collisions,
    skipped,
    warnings: parsed.warnings,
  });
}

async function handleImportFilezillaConfirm(
  app: AiftpMcpApp,
  rawArgs: unknown,
): Promise<CallToolResult> {
  const args = importFilezillaConfirmSchema.parse(rawArgs ?? {});
  const now = Date.now();
  pruneExpiredFilezillaImportPlans(now);
  const plan = filezillaImportPlanStore.get(args.plan_id);
  if (!plan) {
    throw new Error(
      `Unknown or expired plan_id: ${args.plan_id}. Call aiftp_import_filezilla_prepare again to obtain a fresh plan.`,
    );
  }
  if (plan.diffHash !== args.diff_hash) {
    throw new Error(
      'diff_hash mismatch: the import plan drifted between prepare and confirm. Call aiftp_import_filezilla_prepare again.',
    );
  }
  if (plan.confirmToken !== args.confirm_token) {
    throw new Error('confirm_token mismatch: refusing to apply the import.');
  }
  filezillaImportPlanStore.delete(args.plan_id);

  if (plan.queued.length === 0) {
    return textResult({
      ok: true,
      plan_id: args.plan_id,
      imported: [],
      next_steps: ['No profiles to import — every profile was skipped (see prepare output).'],
      collisions: plan.collisions,
      skipped: plan.skipped,
    });
  }

  // Codex review (block): re-read .aiftp.toml at confirm time and verify
  // the on-disk content still matches the prepare-time hash + existing
  // profile names. If a new collision appeared (operator added the same
  // name through another tool between prepare and confirm), we refuse
  // rather than silently produce duplicate `[profile.X]` blocks.
  const tomlPath = join(app.cwd, '.aiftp.toml');
  const currentSourceRaw = await readFile(tomlPath, 'utf8').catch(() => '');
  const currentSource = normalizeLineEndings(currentSourceRaw);
  const currentHash = createHash('sha256').update(currentSource).digest('hex');
  if (currentHash !== plan.existingHash) {
    const currentNames = new Set(
      Array.from(currentSource.matchAll(/^\[profile\.([^\]]+)\]/gmu)).map((m) => m[1] ?? ''),
    );
    // Drift is only fatal when it introduces a new collision; cosmetic
    // edits (comment changes) are tolerated. This matches the operator
    // intent: the gate is about safety, not surface bookkeeping.
    const newCollisions: string[] = [];
    for (const entry of plan.queued) {
      const conflict = currentNames.has(entry.name);
      if (conflict && !entry.isOverwrite) {
        newCollisions.push(entry.name);
      }
    }
    if (newCollisions.length > 0) {
      throw new Error(
        `aiftp_import_filezilla_confirm refused: .aiftp.toml drifted and now contains a colliding profile name (${newCollisions.join(', ')}). Call aiftp_import_filezilla_prepare again to inspect the new collisions.`,
      );
    }
  }

  // Materialize the queued profile blocks. For overwrite entries, we
  // first remove the existing `[profile.<name>]` block from the source
  // (using the canonical `removeProfileBlock` helper from core) and then
  // append the new block at the end. For non-overwrite entries we just
  // append. The whole operation is committed via a tmp+rename atomic
  // write so a crash mid-write leaves either the old file or the new
  // file, never a half-rewritten state (Claude HIGH-1).
  let source = currentSource;
  for (const entry of plan.queued) {
    if (entry.isOverwrite) {
      source = removeProfileBlock(source, entry.name);
    }
    if (source.length > 0 && !source.endsWith('\n')) source += '\n';
    if (source.length > 0 && !source.endsWith('\n\n')) source += '\n';
    source += `${entry.block}\n`;
  }
  // Atomic write: write to a temp sibling, then rename. `rename(2)` on
  // the same filesystem is atomic with respect to other readers — they
  // see either the old inode or the new inode, never an intermediate
  // partial buffer.
  const tmpPath = `${tomlPath}.tmp.${process.pid}.${Date.now()}`;
  // v0.11 security review (CWE-200/732): tempfile mode must be 0o600
  // so the post-rename .aiftp.toml is NOT world-readable. Without the
  // explicit mode, umask default (typically 0o644) makes profile
  // metadata visible to other local users between the rename and any
  // later chmod. The matching config_migrate path already uses 0o600.
  await writeFile(tmpPath, source, { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, tomlPath);

  // The MCP server intentionally does not touch the Keychain — passwords
  // never traverse the MCP boundary. The operator runs `aiftp auth` for
  // each imported profile to populate Keychain entries the import created
  // placeholders for.
  const nextSteps = [
    'Run `aiftp auth <profile-name>` to set the password in Keychain for each imported profile.',
    'The MCP server never writes the Keychain — passwords are not transmitted through MCP.',
  ];

  return textResult({
    ok: true,
    plan_id: args.plan_id,
    imported: plan.queued.map((q) => q.name),
    keychain_services: plan.queued.map((q) => ({
      name: q.name,
      service: q.keychainService,
      user: q.user,
    })),
    collisions: plan.collisions,
    skipped: plan.skipped,
    warnings: plan.warnings,
    next_steps: nextSteps,
  });
}

// ---------------------------------------------------------------------------
// v0.5.0: aiftp_rollback{,_prepare,_confirm}
//
// Rollback = take a previous push-time snapshot and upload its files back to
// the FTP server. The gate is plan/confirm/token, exactly like push: the
// diff_hash is computed from the planned (post-hard-exclude) file set so
// that any drift between prepare and confirm refuses.
// ---------------------------------------------------------------------------

interface PreparedRollback {
  planId: string;
  confirmToken: string;
  diffHash: string;
  profile: string;
  snapshotId: string;
  remoteRoot: string;
  planned: readonly string[];
  plannedDeletes: readonly string[];
  /**
   * The hard-exclude-skipped list captured at prepare. Returned again at
   * confirm so the operator can audit which credentials-bearing files
   * stayed protected.
   */
  skipped: ReadonlyArray<{ path: string; reason: string; status: string }>;
  /**
   * v0.13 (post-review): true when the profile matched
   * `safety.prod_profile_patterns` at prepare time, computed the same way
   * as push's `prodProfileWarning`. When set, `aiftp_rollback_confirm`
   * requires `acknowledge_production: true` in the arguments. Unlike push,
   * this never gates on the confirm phrase — rollback is the recovery path
   * and must stay usable even if the phrase is lost or misconfigured.
   */
  prodProfileWarning: boolean;
  /**
   * v0.13 Codex cross-review, H3: hash of the destination this rollback was
   * planned against. Rollback deletes remote files and rebuilds its FTP
   * connection from the freshly-read profile at confirm time, so it needs
   * the same binding push has.
   */
  destination: DestinationFingerprint;
  createdAt: number;
}

const rollbackPlanStore = new Map<string, PreparedRollback>();

function hashRollbackPlan(input: {
  snapshotId: string;
  remoteRoot: string;
  planned: readonly string[];
  plannedDeletes: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      [
        'aiftp-rollback-plan-v2',
        VERSION,
        `snapshot_id=${input.snapshotId}`,
        `remote_root=${input.remoteRoot}`,
        '[uploads]',
        ...sortedCopy(input.planned),
        '[deletes]',
        ...sortedCopy(input.plannedDeletes),
      ].join('\n'),
    )
    .digest('hex');
}

/**
 * Upper bound on outstanding rollback plans. Combined with PLAN_TTL_MS
 * (TTL pruning), this caps memory footprint even if an automated agent
 * spams `aiftp_rollback_prepare` without ever confirming. When the cap
 * is exceeded the OLDEST plan is evicted (FIFO via insertion order on
 * Map). Codex MEDIUM review.
 */
const ROLLBACK_PLAN_STORE_LIMIT = 50;

function pruneExpiredRollbackPlans(now: number): void {
  for (const [id, plan] of rollbackPlanStore) {
    if (now - plan.createdAt > PLAN_TTL_MS) rollbackPlanStore.delete(id);
  }
  while (rollbackPlanStore.size > ROLLBACK_PLAN_STORE_LIMIT) {
    const oldest = rollbackPlanStore.keys().next().value;
    if (oldest === undefined) break;
    rollbackPlanStore.delete(oldest);
  }
}

async function handleRollback(_app: AiftpMcpApp, _rawArgs: unknown): Promise<CallToolResult> {
  throw new Error(
    'aiftp_rollback refuses direct invocation. Use the two-step flow: aiftp_rollback_prepare to compute the planned file set, then aiftp_rollback_confirm to actually re-upload.',
  );
}

/**
 * Adapter from the AiftpBackupStore interface (which is what the runtime
 * hook returns) to the structural type runRollback wants. Both expose the
 * methods we need, but the union of the original BackupStore returns
 * extra fields that runRollback doesn't care about.
 */
function asRollbackStore(store: AiftpBackupStore): RollbackBackupStore {
  return {
    listSnapshots: () => store.listSnapshots(),
    restoreFile: (id, path) => store.restoreFile(id, path),
  };
}

async function handleRollbackPrepare(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = rollbackPrepareSchema.parse(rawArgs ?? {});
  const config = await loadConfigForMcp(app.cwd);
  const profileName = await resolveProfileArg(app.cwd, args.profile, config);
  const profile = config.profile[profileName];
  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  const { destination } = await resolveDestination(app, profileName, profile);
  const backupStore = await backupStoreFor(app, profileName);
  const rollbackStore = asRollbackStore(backupStore);
  const target = await resolveRollbackTarget({
    store: rollbackStore,
    steps: args.steps,
    snapshotId: args.snapshot_id,
  });
  // Compute the planned file set via runRollback dry-run. This is the
  // same logic the confirm step will use (hard-exclude filtering),
  // guaranteeing that diff_hash binds to the exact upload set.
  const excluder = createExcluder({
    userPatterns: config.exclude.patterns,
    useDefaults: config.exclude.use_defaults,
    additionalHardPatterns: config.backup.hard_exclude.additional_patterns,
  });
  const preview = await runRollback({
    snapshotId: target.id,
    backupStore: rollbackStore,
    uploader: { upload: async () => undefined },
    state: await loadState(stateDir(app.cwd, profileName)),
    remoteRoot: profile.remote_root,
    excluder,
    dryRun: true,
  });
  const diffHash = hashRollbackPlan({
    snapshotId: target.id,
    remoteRoot: profile.remote_root,
    planned: preview.planned,
    plannedDeletes: preview.plannedDeletes,
  });
  // v0.13 (post-review): surface the same production-profile warning push's
  // prepare step does, computed the same way from the resolved profile and
  // safety.prod_profile_patterns. aiftp_rollback_confirm requires
  // acknowledge_production: true back when this is set -- see
  // handleRollbackConfirm. This does NOT gate on the confirm phrase; that
  // stays push-only (rollback is the recovery path).
  const prodProfileWarning = isProdProfile({
    profileName,
    patterns: config.safety.prod_profile_patterns,
    warnEnabled: config.safety.warn_on_prod_profile,
  });
  const confirmToken = randomBytes(24).toString('base64url');
  const planId = randomUUID();
  const now = Date.now();
  pruneExpiredRollbackPlans(now);
  rollbackPlanStore.set(planId, {
    planId,
    confirmToken,
    diffHash,
    profile: profileName,
    snapshotId: target.id,
    remoteRoot: profile.remote_root,
    planned: preview.planned,
    plannedDeletes: preview.plannedDeletes,
    skipped: preview.skipped.map((s) => ({
      path: s.path,
      reason: s.reason ?? 'hard-exclude',
      status: s.status,
    })),
    prodProfileWarning,
    destination: fingerprintDestination(app, profileName, profile, config),
    createdAt: now,
  });
  return textResult({
    ok: true,
    plan_id: planId,
    diff_hash: diffHash,
    confirm_token: confirmToken,
    ttl_ms: PLAN_TTL_MS,
    profile: profileName,
    destination,
    snapshot_id: target.id,
    snapshot_type: target.type,
    snapshot_created_at: target.createdAt,
    remote_root: profile.remote_root,
    planned: preview.planned,
    plannedDeletes: preview.plannedDeletes,
    skipped: preview.skipped.map((s) => ({
      path: s.path,
      remote_path: s.remotePath,
      status: s.status,
      reason: s.reason,
    })),
    prod_profile_warning: prodProfileWarning,
    ...(prodProfileWarning
      ? {
          prod_profile_message: `Profile "${profileName}" matches safety.prod_profile_patterns. To confirm, pass acknowledge_production: true to aiftp_rollback_confirm along with the plan_id / diff_hash / confirm_token.`,
        }
      : {}),
  });
}

async function handleRollbackConfirm(app: AiftpMcpApp, rawArgs: unknown): Promise<CallToolResult> {
  const args = rollbackConfirmSchema.parse(rawArgs ?? {});
  const profileName = args.profile;
  const now = Date.now();
  pruneExpiredRollbackPlans(now);
  const plan = rollbackPlanStore.get(args.plan_id);
  if (!plan) {
    throw new Error(
      `Unknown or expired plan_id: ${args.plan_id}. Call aiftp_rollback_prepare again to obtain a fresh plan.`,
    );
  }
  if (plan.profile !== profileName) {
    throw new Error(
      `Plan ${args.plan_id} was prepared for profile "${plan.profile}", not "${profileName}".`,
    );
  }
  if (plan.diffHash !== args.diff_hash) {
    throw new Error(
      'diff_hash mismatch: rollback plan drifted between prepare and confirm. Call aiftp_rollback_prepare again to inspect the new plan.',
    );
  }
  if (plan.confirmToken !== args.confirm_token) {
    throw new Error('confirm_token mismatch: refusing to roll back.');
  }
  // v0.13 (post-review): production profile gate, mirroring push's
  // acknowledge_production check exactly. Rollback is the recovery path —
  // it must stay reachable even when the confirm phrase is lost or
  // misconfigured, so this check is deliberately independent of any phrase.
  // It still writes to and deletes from a live server, so a plan flagged
  // prod at prepare time cannot be applied by echoing plan_id/diff_hash/
  // confirm_token alone.
  if (plan.prodProfileWarning && args.acknowledge_production !== true) {
    throw new Error(
      `Production rollback refused: profile "${plan.profile}" matches safety.prod_profile_patterns. Re-call aiftp_rollback_confirm with acknowledge_production: true.`,
    );
  }
  if (plan.plannedDeletes.length > 0 && args.acknowledge_deletions !== true) {
    throw new Error(
      `Deletion rollback refused: ${plan.plannedDeletes.length} remote delete(s) were planned. Re-call aiftp_rollback_confirm with acknowledge_deletions: true.`,
    );
  }
  // Consume before side effects: a second confirm with the same token
  // cannot replay the rollback. (Replaying a rollback would re-upload an
  // already-restored file — usually harmless but pointless. Consistent
  // contract = uniform reasoning.)
  rollbackPlanStore.delete(args.plan_id);

  const backupStore = await backupStoreFor(app, profileName);
  const rollbackStore = asRollbackStore(backupStore);
  const config = await loadConfigForMcp(app.cwd);
  const excluder = createExcluder({
    userPatterns: config.exclude.patterns,
    useDefaults: config.exclude.use_defaults,
    additionalHardPatterns: config.backup.hard_exclude.additional_patterns,
  });

  // Codex+Claude HIGH review: re-run the dry-run classification BEFORE
  // any upload. If the planned set changed (e.g. operator added an
  // additional hard-exclude pattern between prepare and confirm), refuse
  // immediately — previously this check ran after partial upload.
  const preview = await runRollback({
    snapshotId: plan.snapshotId,
    backupStore: rollbackStore,
    uploader: { upload: async () => undefined },
    state: await loadState(stateDir(app.cwd, profileName)),
    remoteRoot: plan.remoteRoot,
    excluder,
    dryRun: true,
  });
  const currentDiffHash = hashRollbackPlan({
    snapshotId: plan.snapshotId,
    remoteRoot: plan.remoteRoot,
    planned: preview.planned,
    plannedDeletes: preview.plannedDeletes,
  });
  if (
    currentDiffHash !== plan.diffHash ||
    !sameStringSet(preview.planned, plan.planned) ||
    !sameStringSet(preview.plannedDeletes, plan.plannedDeletes)
  ) {
    throw new Error(
      'rollback plan drifted between prepare and confirm (hard-exclude config may have changed). Call aiftp_rollback_prepare again to inspect the new plan.',
    );
  }

  // v0.13 Codex cross-review, H3: rollback re-uploads to — and deletes
  // from — whatever profile `.aiftp.toml` names at this moment (see the
  // createDefaultFtpClient call below). Bind it to the destination the
  // operator approved at prepare time, immediately before that connection
  // is built.
  assertDestinationUnchanged({
    app,
    profileName,
    expected: plan.destination,
    config,
    prepareToolName: 'aiftp_rollback_prepare',
  });

  // Build a real Buffer-shaped uploader. Codex BLOCK review: the old
  // code tried to duck-type a DeployUploader (path-shaped) into a
  // RollbackUploader (buffer-shaped) which silently fell back to a fake
  // localPath when the runtime didn't expose `uploadBuffer`. Now we use
  // a dedicated `createRollbackUploader` hook. Default to FtpClient
  // when no hook is wired.
  let sharedFtp: DeployClient | undefined;
  const uploader: RollbackUploader =
    (await app.runtime.createRollbackUploader?.({
      cwd: app.cwd,
      profileName,
    })) ??
    (await (async () => {
      sharedFtp = await createDefaultFtpClient(app.cwd, profileName);
      const client = sharedFtp;
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
        delete: async (remote) => {
          await client.delete(remote);
        },
      } satisfies RollbackUploader;
    })());

  try {
    const result = await runRollback({
      snapshotId: plan.snapshotId,
      backupStore: rollbackStore,
      uploader,
      state: await loadState(stateDir(app.cwd, profileName)),
      remoteRoot: plan.remoteRoot,
      excluder,
      dryRun: false,
    });
    await saveState(stateDir(app.cwd, profileName), result.nextState);
    await appendLogEntry(app.cwd, {
      at: new Date().toISOString(),
      event: 'rollback',
      profile: profileName,
      snapshot: plan.snapshotId,
      rolled_back: result.rolledBack.length,
      skipped: result.skipped.length,
    });
    return textResult({
      ok: true,
      profile: profileName,
      plan_id: args.plan_id,
      snapshot_id: plan.snapshotId,
      rolled_back: result.rolledBack.map((r) => r.path),
      deleted: result.deleted.map((r) => r.path),
      skipped: result.skipped.map((s) => ({
        path: s.path,
        status: s.status,
        reason: s.reason,
      })),
    });
  } finally {
    if (sharedFtp) await sharedFtp.disconnect().catch(() => undefined);
  }
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
  aiftp_sites_list: handleSitesList,
  aiftp_init_template_list: handleInitTemplateList,
  aiftp_profile_current: handleProfileCurrent,
  aiftp_profile_test: handleProfileTest,
  aiftp_config_migrate: handleConfigMigrate,
  aiftp_config_migrate_prepare: handleConfigMigratePrepare,
  aiftp_config_migrate_confirm: handleConfigMigrateConfirm,
  aiftp_import_filezilla: handleImportFilezilla,
  aiftp_import_filezilla_prepare: handleImportFilezillaPrepare,
  aiftp_import_filezilla_confirm: handleImportFilezillaConfirm,
  aiftp_rollback: handleRollback,
  aiftp_rollback_prepare: handleRollbackPrepare,
  aiftp_rollback_confirm: handleRollbackConfirm,
  aiftp_setup_status: handleSetupStatus,
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
    // v0.13 (Task 5, B3): explicit Desktop signal, production default reads
    // the real env var set by packages/desktop-ext/src/server-entry.ts.
    desktopMode: options.desktopMode ?? process.env.AIFTP_DESKTOP === '1',
    ...(() => {
      const phrase = options.confirmPhrase ?? process.env.AIFTP_CONFIRM_PHRASE;
      // Aligned with setup-status.ts's phraseSet check: a whitespace-only
      // value counts as unset, so the two subsystems agree on presence.
      return phrase === undefined || phrase.trim().length === 0 ? {} : { confirmPhrase: phrase };
    })(),
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

  app.server.registerPrompt(
    'aiftp_setup',
    {
      title: 'aiftp セットアップ',
      description:
        'Guide the operator through the four onboarding steps: connection check, test-area push, production push behind the confirmation phrase, and rollback.',
    },
    () => ({
      messages: [{ role: 'user', content: { type: 'text', text: buildSetupPromptText() } }],
    }),
  );

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
