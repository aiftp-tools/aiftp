import type { SiteEntry, SiteProtocol } from '../sites/types.js';

export interface BootstrapInput {
  readonly siteName: string;
  readonly localRoot: string;
  readonly host: string;
  readonly protocol: SiteProtocol;
  readonly username: string;
  readonly remoteRoot: string;
  readonly profileName: string;
  /** The value Claude Desktop passes in from its "パスワード" field, once. */
  readonly credential?: string;
}

export interface BootstrapRegistrySurface {
  list(): Promise<readonly SiteEntry[]>;
  add(entry: SiteEntry): Promise<readonly SiteEntry[]>;
  rename(oldName: string, newName: string): Promise<readonly SiteEntry[]>;
}

export interface BootstrapDeps {
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly writeTextFile?: (path: string, contents: string) => Promise<void>;
  readonly storeCredential?: (service: string, account: string, value: string) => Promise<void>;
  readonly credentialExists?: (service: string, account: string) => Promise<boolean>;
  readonly createRegistry?: () => BootstrapRegistrySurface;
  readonly ensureGitignore?: (cwd: string) => Promise<string>;
}

export type ConfigOutcome = 'created' | 'updated' | 'existing';
export type CredentialOutcome = 'stored' | 'already-stored' | 'missing';
export type RegistryOutcome = 'registered' | 'already-registered' | 'renamed';

export interface BootstrapResult {
  readonly ok: boolean;
  readonly siteName: string;
  readonly profileName: string;
  readonly keychainService: string;
  readonly configPath: string;
  readonly config: ConfigOutcome;
  readonly credential: CredentialOutcome;
  readonly registry: RegistryOutcome;
  readonly gitignore: string;
  readonly missing: readonly string[];
  readonly hint?: string;
}

export class BootstrapValidationError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'BootstrapValidationError';
    this.hint = hint;
  }
}
