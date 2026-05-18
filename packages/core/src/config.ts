import { readFile } from 'node:fs/promises';
import { parse as parseToml } from '@iarna/toml';
import { z } from 'zod';

const SUPPORTED_SCHEMA = 1;
const PROTOCOLS = ['ftps', 'ftp'] as const;
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
  })
  .strict();

const excludeSchema = z
  .object({
    patterns: z.array(z.string()).default([]),
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

export const configSchema = z
  .object({
    schema: z.literal(SUPPORTED_SCHEMA),
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
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type ProfileConfig = z.infer<typeof profileSchema>;
export type SafetyConfig = z.infer<typeof safetySchema>;
export type BackupConfig = z.infer<typeof backupSchema>;
export type ConnectionConfig = z.infer<typeof connectionSchema>;
export type ExcludeConfig = z.infer<typeof excludeSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;

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

export async function loadConfig(path: string): Promise<Config> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error: unknown) {
    throw new ConfigError(`Failed to read config at ${path}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = parseToml(source);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigParseError(`Failed to parse TOML at ${path}: ${message}`, { cause: error });
  }

  return validateConfig(parsed);
}
