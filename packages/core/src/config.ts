import { randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { z } from 'zod';
import { VERSION } from './index.js';
import { migrateV1ToV2Source } from './migrations/v1-to-v2.js';

const SUPPORTED_SCHEMAS = [1, 2] as const;
const PROTOCOLS = ['ftps', 'ftp'] as const;
const FTPS_MODES = ['explicit', 'implicit'] as const;
const ON_LIMIT_EXCEEDED = ['halt', 'rotate', 'warn'] as const;
const FULL_BACKUP_ON_FIRST_PUSH = ['recommend', 'force', 'off'] as const;
const FULL_BACKUP_SCHEDULE = ['off', 'daily', 'weekly', 'manual'] as const;
const VERIFY_AFTER_UPLOAD = ['off', 'size', 'sha256'] as const;
const DELETION_POLICY = ['never', 'prune-with-confirm', 'prune-auto'] as const;
const KEY_STORAGE = ['os-keychain'] as const;
const ENCRYPTION_ALGORITHM = ['aes-256-gcm'] as const;
const SERVER_KINDS = ['starserver', 'lolipop', 'sakura', 'xserver', 'generic'] as const;

const profileSchema = z
  .object({
    host: z.string().min(1, 'host must not be empty'),
    port: z.number().int().min(1).max(65535).default(21),
    protocol: z.enum(PROTOCOLS).default('ftps'),
    user: z.string().min(1, 'user must not be empty'),
    remote_root: z.string().min(1),
    local_root: z.string().min(1),
    keychain_service: z.string().min(1),
    server_kind: z.enum(SERVER_KINDS).default('generic'),
    account: z.string().optional(),
    ftps_mode: z.enum(FTPS_MODES).optional(),
    passive_mode: z.boolean().optional(),
  })
  .strict();

const excludeSchema = z
  .object({
    patterns: z.array(z.string()).default([]),
    // v0.9.4+: auto-apply DEFAULT_EXCLUDE_PATTERNS (`.aiftp.toml`,
    // `.DS_Store`, `doctor-*.txt`, editor swap files, etc.) on top of
    // `patterns`. Defaults to `true`; set to `false` only if you have
    // a legitimate reason to upload those files (rare).
    use_defaults: z.boolean().default(true),
  })
  .strict();

const safetySchema = z
  .object({
    require_tls: z.boolean().default(true),
    verify_certificate: z.boolean().default(true),
    confirm_on_delete: z.boolean().default(true),
    max_files_per_push: z.number().int().positive().default(500),
    max_total_size_mb: z.number().int().positive().default(100),
    require_full_backup_before_first_push: z.boolean().default(false),
    warn_on_prod_profile: z.boolean().default(true),
    prod_profile_patterns: z.array(z.string()).default(['prod*', 'production*', 'main*']),
    syntax_check: z.boolean().default(true),
    server_lock: z.boolean().default(true),
    lock_timeout_min: z.number().int().positive().default(10),
    verify_after_upload: z.enum(VERIFY_AFTER_UPLOAD).default('size'),
    deletion_policy: z.enum(DELETION_POLICY).default('never'),
  })
  .strict();

const backupHardExcludeSchema = z
  .object({
    additional_patterns: z.array(z.string()).default([]),
  })
  .strict();

const backupSchema = z
  .object({
    auto_before_push: z.literal(true).default(true),
    retention_count: z.number().int().positive().default(30),
    max_disk_mb: z.number().int().positive().default(500),
    on_limit_exceeded: z.enum(ON_LIMIT_EXCEEDED).default('halt'),
    full_backup_on_first_push: z.enum(FULL_BACKUP_ON_FIRST_PUSH).default('recommend'),
    full_backup_schedule: z.enum(FULL_BACKUP_SCHEDULE).default('weekly'),
    full_backup_retention: z.number().int().positive().default(4),
    encrypt: z.literal(true).default(true),
    encryption_algorithm: z.enum(ENCRYPTION_ALGORITHM).default('aes-256-gcm'),
    key_storage: z.enum(KEY_STORAGE).default('os-keychain'),
    cloud_backup: z.boolean().default(false),
    hard_exclude: backupHardExcludeSchema.prefault({}),
  })
  .strict();

const connectionSchema = z
  .object({
    max_concurrent: z.number().int().positive().default(2),
    throttle_per_minute: z.number().int().positive().default(30),
    retry_count: z.number().int().min(0).default(5),
    retry_backoff_ms: z
      .array(z.number().int().positive())
      .default([1000, 3000, 9000, 27000, 60000]),
    timeout_ms: z.number().int().positive().default(60000),
    resume_partial_upload: z.boolean().default(true),
  })
  .strict();

const hooksSchema = z
  .object({
    pre_push: z.array(z.string()).default([]),
    post_push: z.array(z.string()).default([]),
  })
  .strict();

const encodingSchema = z
  .object({
    file_name: z.enum(['auto', 'utf-8', 'shift_jis', 'euc-jp']).default('auto'),
  })
  .strict();

const quirksSchema = z
  .object({
    ignore_pasv_address: z.boolean().default(false),
    use_mlsd: z.boolean().default(true),
    tls_check_hostname: z.boolean().default(true),
    noop_interval_sec: z.number().int().nonnegative().default(0),
  })
  .strict();

// v0.9.4+: file-walker policy. Defaults match the prior implicit
// behaviour: do NOT follow symbolic links. Operators who legitimately
// share fixtures via symlink can opt in.
const walkSchema = z
  .object({
    follow_symlinks: z.boolean().default(false),
  })
  .strict();

export const configSchema = z
  .object({
    schema: z.union([z.literal(SUPPORTED_SCHEMAS[0]), z.literal(SUPPORTED_SCHEMAS[1])]),
    profile: z
      .record(z.string(), profileSchema)
      .refine((profiles) => Object.keys(profiles).length > 0, {
        message: 'At least one profile must be defined',
      }),
    exclude: excludeSchema.prefault({}),
    safety: safetySchema.prefault({}),
    backup: backupSchema.prefault({}),
    connection: connectionSchema.prefault({}),
    hooks: hooksSchema.prefault({}),
    encoding: encodingSchema.prefault({}),
    quirks: quirksSchema.prefault({}),
    walk: walkSchema.prefault({}),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type ProfileConfig = z.infer<typeof profileSchema>;
export type SafetyConfig = z.infer<typeof safetySchema>;
export type BackupConfig = z.infer<typeof backupSchema>;
export type ConnectionConfig = z.infer<typeof connectionSchema>;
export type ExcludeConfig = z.infer<typeof excludeSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;
export type EncodingConfig = z.infer<typeof encodingSchema>;
export type QuirksConfig = z.infer<typeof quirksSchema>;
export type WalkConfig = z.infer<typeof walkSchema>;

export interface LoadConfigOptions {
  autoMigrate?: boolean;
}

export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

export class ConfigParseError extends ConfigError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigParseError';
  }
}

export class ConfigValidationError extends ConfigError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigValidationError';
  }
}

const FORBIDDEN_FIELDS = ['password', 'pass', 'pwd', 'secret'] as const;

function rejectForbiddenFields(raw: unknown, path: string[] = []): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_FIELDS.includes(key as (typeof FORBIDDEN_FIELDS)[number])) {
      const location = [...path, key].join('.');
      throw new ConfigValidationError(
        `Forbidden field '${key}' at ${location}. Credentials must be stored in OS Keychain, not in config files.`,
      );
    }
    rejectForbiddenFields(value, [...path, key]);
  }
}

/**
 * Synchronous validation against the *current* config schema. v0.2 accepts
 * both schema=1 and schema=2 to support the auto-migration path through
 * `loadConfig`. v0.3 will drop v1 acceptance once migration has had a full
 * release to land.
 */
export function validateConfig(raw: unknown): Config {
  rejectForbiddenFields(raw);
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigValidationError(`Config validation failed:\n${issues}`, {
      cause: result.error,
    });
  }
  return result.data;
}

function parseConfigSource(source: string, configFilePath: string): unknown {
  try {
    return parseToml(source);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigParseError(`Failed to parse TOML at ${configFilePath}: ${message}`, {
      cause: error,
    });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function appendMigrationLog(configFilePath: string): Promise<void> {
  const migrationLogPath = join(dirname(configFilePath), '.aiftp', 'logs', 'migrations.jsonl');
  await mkdir(dirname(migrationLogPath), { recursive: true });
  await appendFile(
    migrationLogPath,
    `${JSON.stringify({
      fromSchema: 1,
      toSchema: 2,
      migratedAt: new Date().toISOString(),
      toolVersion: VERSION,
    })}\n`,
    'utf8',
  );
}

async function writeMigratedConfig(configFilePath: string, source: string): Promise<void> {
  const backupPath = `${configFilePath}.v1.bak`;
  if (await pathExists(backupPath)) {
    throw new ConfigError(`Refusing to migrate because ${backupPath} already exists.`);
  }

  const tempPath = `${configFilePath}.tmp.${process.pid}.${randomUUID()}`;
  let originalRenamed = false;
  try {
    await writeFile(tempPath, source, { encoding: 'utf8', mode: 0o600 });
    await rename(configFilePath, backupPath);
    originalRenamed = true;
    await rename(tempPath, configFilePath);
  } catch (error: unknown) {
    await unlink(tempPath).catch(() => undefined);
    if (originalRenamed) {
      await rename(backupPath, configFilePath).catch(() => undefined);
    }
    throw error;
  }
}

function shouldAutoMigrate(
  configFilePath: string,
  options: LoadConfigOptions | undefined,
): boolean {
  return options?.autoMigrate !== false && basename(configFilePath) === '.aiftp.toml';
}

export async function loadConfig(path: string, options: LoadConfigOptions = {}): Promise<Config> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error: unknown) {
    throw new ConfigError(`Failed to read config at ${path}`, { cause: error });
  }

  const parsed = parseConfigSource(source, path);
  const schema = (parsed as { schema?: unknown }).schema;
  if (schema === 1 && shouldAutoMigrate(path, options)) {
    const result = migrateV1ToV2Source(source);
    if (result.changed) {
      await writeMigratedConfig(path, result.source);
      await appendMigrationLog(path);
    }
    return validateConfig(parseConfigSource(result.source, path));
  }

  return validateConfig(parsed);
}
