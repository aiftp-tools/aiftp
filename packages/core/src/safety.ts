/**
 * This module holds two deliberately separate decisions. They used to be one
 * value, and that is exactly how a v0.13 security review found the Desktop
 * confirm-phrase gate could be switched off from `.aiftp.toml`:
 *
 *   - `isProdProfile()` — the DISPLAY decision. "Should this look like a
 *     production target?" Fully governed by `safety.*`, including the
 *     `warn_on_prod_profile = false` opt-out that CI pipelines rely on.
 *   - `requiresProductionConfirmation()` — the AUTHORIZATION decision.
 *     "May this push proceed without a human confirmation?" `safety.*` may
 *     WIDEN it (classify more profiles as production) but may never narrow
 *     it below the Desktop-mode floor.
 *
 * Never collapse them back into one value: `.aiftp.toml` is a project file
 * the AI agent being gated can itself edit, so it cannot be the sole input
 * to an authorization decision.
 */

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

/**
 * Authorization decision for a production-bound push: does this plan need a
 * human confirmation (the confirm phrase, plus `acknowledge_production`)
 * before it may be applied?
 *
 * `desktopMode` is the floor. Inside the Claude Desktop extension there is
 * no terminal, no MCP elicitation, and no operator watching the tool call —
 * the confirm phrase held by the instructor is the ONLY thing standing
 * between the AI and a live server, so it is required unconditionally. The
 * Desktop bundle bootstraps exactly one profile, so "always" is also the
 * simplest correct rule. `safety.*` is consulted only to widen the gate for
 * terminal users; it can never lower this floor.
 *
 * Outside Desktop mode the result is exactly `isProdProfile()`, so v0.12
 * terminal behaviour — including `warn_on_prod_profile = false` as a CI
 * escape hatch — is preserved byte for byte.
 */
export function requiresProductionConfirmation(options: {
  profileName: string;
  patterns: readonly string[];
  warnEnabled?: boolean;
  desktopMode: boolean;
}): boolean {
  if (options.desktopMode) return true;
  return isProdProfile(options);
}

function matchProfilePattern(name: string, pattern: string): boolean {
  if (!pattern) return false;
  // Convert glob to RegExp, escaping everything except `*`.
  const regexSource = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*');
  const re = new RegExp(`^${regexSource}$`, 'u');
  return re.test(name);
}
