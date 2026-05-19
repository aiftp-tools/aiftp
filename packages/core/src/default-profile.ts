import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Filename of the default-profile state file relative to `.aiftp/state/`.
 *
 * The leading underscore is deliberate: profile names are validated by
 * `isValidProfileName` to start with `[a-z0-9]`, so an underscore-prefixed
 * filename can never collide with a directory created by another profile's
 * state (`.aiftp/state/<profile-name>/state.json`).
 */
export const DEFAULT_PROFILE_STATE_FILE = '_default-profile.json';

interface DefaultProfileState {
  schema: 1;
  name: string;
  updatedAt: string;
}

function statePath(cwd: string): string {
  return join(cwd, '.aiftp', 'state', DEFAULT_PROFILE_STATE_FILE);
}

/**
 * Persist `name` as the workspace's default profile. Atomic via tmp+rename
 * so a crash mid-write leaves the previous default intact (or no default
 * at all on first write).
 */
export async function saveDefaultProfile(cwd: string, name: string): Promise<void> {
  const target = statePath(cwd);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const body: DefaultProfileState = {
    schema: 1,
    name,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

/**
 * Read the saved default profile name. Returns null when the file does
 * not exist, is malformed JSON, or does not match the expected shape --
 * the caller is expected to fall back through env / single-profile rules
 * (see `resolveDefaultProfile`).
 */
export async function loadDefaultProfile(cwd: string): Promise<string | null> {
  const target = statePath(cwd);
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { name?: unknown }).name !== 'string'
  ) {
    return null;
  }
  return (parsed as { name: string }).name;
}

export interface ResolveDefaultProfileOptions {
  /**
   * Names of profiles defined in the operator's `.aiftp.toml`. Used to
   * (a) fall back to the only profile when neither env nor state is set,
   * and (b) ignore stale env/state values pointing at a deleted profile.
   */
  availableProfiles: readonly string[];
}

/**
 * Resolve the default profile name using this precedence:
 *
 * 1. `AIFTP_PROFILE` environment variable
 * 2. `.aiftp/state/_default-profile.json`
 * 3. The sole available profile, when exactly one exists
 *
 * Each step also requires the chosen name to appear in
 * `availableProfiles`. Returns null when the resolution is ambiguous
 * (multiple profiles and nothing pinned), the available list is empty,
 * or every candidate points at a profile that no longer exists.
 *
 * The same resolver is consumed by both the CLI and the MCP server so an
 * AI agent and the operator see the same default.
 */
export async function resolveDefaultProfile(
  cwd: string,
  options: ResolveDefaultProfileOptions,
): Promise<string | null> {
  const available = new Set(options.availableProfiles);
  if (available.size === 0) return null;

  const envName = process.env.AIFTP_PROFILE;
  if (envName && envName.length > 0) {
    return available.has(envName) ? envName : null;
  }

  const stateName = await loadDefaultProfile(cwd);
  if (stateName !== null) {
    return available.has(stateName) ? stateName : null;
  }

  if (available.size === 1) {
    const [only] = options.availableProfiles;
    return only ?? null;
  }

  return null;
}
