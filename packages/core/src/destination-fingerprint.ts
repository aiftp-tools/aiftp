/**
 * Destination binding for two-step (prepare → confirm) operations.
 *
 * v0.13 Codex cross-review, H3: the push plan hash covered only the profile
 * name, the remote root and the file set. Confirm re-read `.aiftp.toml` and
 * built its FTP connection from whatever it found there, so editing `host` /
 * `port` / `protocol` / `user` / `keychain_service` between prepare and
 * confirm sent the upload — and the deletes — to a server the human never
 * approved, while the drift check happily passed because the remote root and
 * file set were unchanged. `.aiftp.toml` is a project file the AI itself can
 * edit, so nothing in it can be trusted to stay put across the two calls.
 *
 * The fix is to fingerprint the destination at prepare and re-check it
 * immediately before executing at confirm. Only hashes are stored and
 * compared: the fingerprint travels inside plan objects and its component
 * names appear in refusal messages, so it must never be a place a credential
 * or a keychain secret could be read back out of.
 */

import { createHash } from 'node:crypto';
import type { Config, ProfileConfig } from './config.js';

const FINGERPRINT_VERSION = 'aiftp-destination-v1';
/**
 * Stand-in for an absent optional field. Only ever applied to fields whose
 * real values are enum members or booleans, so it cannot collide with one.
 * A plain ASCII sentinel: no control characters (a stray NUL byte would
 * make git treat the source file as binary).
 */
const UNSET = '(unset)';

export interface DestinationFingerprint {
  /** Hash over every component. Equal digests ⇒ same approved destination. */
  readonly digest: string;
  /** component name → per-component hash, so a diff can name what changed. */
  readonly components: Readonly<Record<string, string>>;
}

function hashComponent(name: string, value: string): string {
  return createHash('sha256')
    .update(`${FINGERPRINT_VERSION}\n${name}\n${value}`, 'utf8')
    .digest('hex');
}

function asValue(raw: string | number | boolean | undefined): string {
  return raw === undefined ? UNSET : String(raw);
}

/**
 * Fingerprint everything that decides WHERE an upload lands and HOW the
 * connection to it is secured, plus the production classification (so
 * flipping `safety.warn_on_prod_profile` mid-flight cannot downgrade an
 * already-approved plan either).
 *
 * Deliberately excluded: timeouts, retry policy, concurrency, exclude
 * patterns. Those cannot redirect an upload, and invalidating a confirmed
 * plan over them would be noise.
 */
export function computeDestinationFingerprint(input: {
  profile: ProfileConfig;
  config: Config;
  productionConfirmationRequired: boolean;
}): DestinationFingerprint {
  const { profile, config } = input;
  const raw: Record<string, string> = {
    protocol: asValue(profile.protocol),
    host: asValue(profile.host),
    port: asValue(profile.port),
    user: asValue(profile.user),
    keychain_service: asValue(profile.keychain_service),
    remote_root: asValue(profile.remote_root),
    server_kind: asValue(profile.server_kind),
    ftps_mode: asValue(profile.ftps_mode),
    passive_mode: asValue(profile.passive_mode),
    ssh_key_path: asValue(profile.ssh_key_path),
    require_tls: asValue(config.safety.require_tls),
    verify_certificate: asValue(config.safety.verify_certificate),
    tls_check_hostname: asValue(config.quirks?.tls_check_hostname),
    production_confirmation: asValue(input.productionConfirmationRequired),
  };
  const components: Record<string, string> = {};
  for (const name of Object.keys(raw).sort()) {
    components[name] = hashComponent(name, raw[name] ?? UNSET);
  }
  const digest = createHash('sha256')
    .update(
      [
        FINGERPRINT_VERSION,
        ...Object.keys(components)
          .sort()
          .map((name) => `${name}=${components[name]}`),
      ].join('\n'),
      'utf8',
    )
    .digest('hex');
  return { digest, components };
}

/**
 * Names of the components that differ between two fingerprints, sorted.
 * Names only — the refusal message tells the operator WHAT changed without
 * echoing host names, user names or paths back at the caller.
 */
export function describeDestinationChange(
  expected: DestinationFingerprint,
  actual: DestinationFingerprint,
): readonly string[] {
  const names = new Set([...Object.keys(expected.components), ...Object.keys(actual.components)]);
  return [...names].filter((name) => expected.components[name] !== actual.components[name]).sort();
}
