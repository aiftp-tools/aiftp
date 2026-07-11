export interface SiteEntry {
  readonly name: string;
  readonly path: string;
  readonly label?: string;
  readonly default_profile?: string;
}

export type SiteProtocol = 'ftp' | 'ftps' | 'sftp';
export type CredentialsStatus = 'present' | 'missing' | 'unknown';
export type SiteHealth = 'ok' | 'missing' | 'invalid';

/**
 * Live site information assembled by the resolution layer in Task 2.
 * The registry implemented in Task 1 stores only the inherited pointer fields.
 */
export interface ResolvedSite extends SiteEntry {
  readonly profiles: readonly string[];
  readonly protocol?: SiteProtocol;
  readonly credentialsStatus: CredentialsStatus;
  readonly lastPushAt?: string;
  readonly health: SiteHealth;
}
