/**
 * Match a profile name against the user-configured `safety.prod_profile_patterns`.
 *
 * Patterns use simple glob semantics (`*` matches any run of characters).
 * Anchored to the full profile name. This matches the user's mental model
 * — `prod*` should match `production` but not `not-production`.
 *
 * Used by both the CLI (`aiftp push`) and the MCP layer (`aiftp_push_prepare`)
 * to surface an additional confirmation prompt before any production-bound
 * upload. The point is to prevent a half-asleep operator (or an AI agent)
 * from accidentally pushing the wrong code path to a production-facing
 * profile.
 *
 * `warnEnabled` lets the caller short-circuit when the user has explicitly
 * disabled production warnings via `safety.warn_on_prod_profile = false`
 * — useful for CI environments where the prompt would block forever.
 */
export function isProdProfile(options: {
  profileName: string;
  patterns: readonly string[];
  warnEnabled?: boolean;
}): boolean {
  if (options.warnEnabled === false) return false;
  return options.patterns.some((pattern) => matchProfilePattern(options.profileName, pattern));
}

function matchProfilePattern(name: string, pattern: string): boolean {
  if (!pattern) return false;
  // Convert glob to RegExp, escaping everything except `*`.
  const regexSource = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*');
  const re = new RegExp(`^${regexSource}$`, 'u');
  return re.test(name);
}
