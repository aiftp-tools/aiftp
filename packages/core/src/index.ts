export const VERSION = '0.0.0';

export {
  type BackupConfig,
  type Config,
  ConfigError,
  ConfigParseError,
  type ConnectionConfig,
  type ExcludeConfig,
  type HooksConfig,
  type ProfileConfig,
  type SafetyConfig,
  ConfigValidationError,
  configSchema,
  loadConfig,
  validateConfig,
} from './config.js';

export {
  KeychainError,
  KeychainNotFoundError,
  KeychainPlatformError,
  deletePassword,
  getPassword,
  hasPassword,
  setPassword,
} from './keychain.js';

export {
  Excluder,
  type ExcluderOptions,
  type ExcludeMatch,
  type ExcludeReason,
  HARD_EXCLUDE_PATTERNS,
  createExcluder,
} from './exclude.js';
