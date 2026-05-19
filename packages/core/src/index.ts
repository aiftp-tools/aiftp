export const VERSION = '0.0.0';

export {
  type BackupFtpClient,
  backupKeyService,
  type BackupKeychain,
  createDefaultBackupStore,
  type CreateDefaultBackupStoreOptions,
} from './backup/default-store.js';

export {
  BackupError,
  BackupLimitError,
  type BackupSource,
  BackupStore,
  type BackupStoreOptions,
  isValidSnapshotId,
  type SnapshotFileMeta,
  type SnapshotId,
  type SnapshotMeta,
  type SnapshotType,
  type VerifyResult,
} from './backup/store.js';

export {
  type BackupConfig,
  type Config,
  ConfigError,
  ConfigParseError,
  type ConnectionConfig,
  type EncodingConfig,
  type ExcludeConfig,
  type HooksConfig,
  type LoadConfigOptions,
  type ProfileConfig,
  type QuirksConfig,
  type SafetyConfig,
  ConfigValidationError,
  configSchema,
  loadConfig,
  validateConfig,
} from './config.js';

export { migrateV1ToV2Source } from './migrations/v1-to-v2.js';

export { computeDiff, type Diff } from './diff.js';

export {
  DeployError,
  DeployLimitError,
  type DeployLock,
  type DeployUploader,
  DeployVerificationError,
  type PushOptions,
  type PushResult,
  type PushSafetyOptions,
  runPush,
  runStatus,
  type StatusOptions,
  type StatusResult,
  type UploadedFileResult,
} from './deploy.js';

export {
  decryptBuffer,
  decryptFile,
  encryptBuffer,
  encryptFile,
  ENCRYPTED_FILE_HEADER_BYTES,
  ENCRYPTED_FILE_MAGIC,
  EncryptionError,
  generateKey,
} from './encryption.js';

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
  DEFAULT_EXCLUDE_PATTERNS,
  Excluder,
  type ExcluderOptions,
  type ExcludeMatch,
  type ExcludeReason,
  HARD_EXCLUDE_PATTERNS,
  createExcluder,
} from './exclude.js';

export { RetryExhaustedError, type RetryOptions, withRetry } from './retry.js';

export {
  computeHash,
  loadState,
  saveState,
  type State,
  StateError,
  type StateFileEntry,
  updateFileEntry,
} from './state.js';

export {
  FtpAuthError,
  FtpClient,
  type FtpClientOptions,
  FtpConnectionError,
  FtpError,
  FtpNotFoundError,
  type FtpProtocol,
  FtpTimeoutError,
  FtpTlsError,
  type ListEntry,
  type UploadResult,
} from './ftp-client.js';

export {
  checkAll,
  checkFile,
  PreflightError,
  type PreflightIssue,
  type PreflightKind,
  type PreflightOptions,
  type PreflightReport,
  type PreflightResult,
  type PreflightSeverity,
  type PreflightStatus,
  type PhpLintResult,
  type PhpLintRunner,
} from './preflight.js';
