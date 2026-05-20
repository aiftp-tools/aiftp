/**
 * v0.9.0 Phase 2 #5: Claude Code `PostToolUse` hook parser.
 *
 * Claude Code (and Cursor / Copilot CLI / similar) can run a shell hook
 * after each tool call. We use this to surface a dry-run aiftp status
 * notification immediately after the agent edits a file, so the operator
 * sees "you just changed 3 files in localRoot → 3 would push" without
 * having to remember to run `aiftp status` themselves.
 *
 * Spec §17.6 #5 mandates the hook is **dry-run / notification only**.
 * Auto-pushing on every Write/Edit is exactly the foot-gun the
 * plan/confirm gate exists to prevent — the hook respects that boundary.
 *
 * This module ships only the pure parser. The CLI command (`aiftp hook`)
 * wires stdin and the actual status runner.
 */

/**
 * Subset of the Claude Code PostToolUse hook input we care about.
 * Documented at https://docs.claude.com/en/docs/claude-code/hooks#input.
 * Only Write / Edit / MultiEdit tools carry file paths we want to
 * react to.
 */
export interface ClaudeCodeHookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    files?: Array<{ file_path?: string }>;
    edits?: Array<{ file_path?: string }>;
  };
}

export interface ExtractedHookPaths {
  /** File paths the tool touched. Absolute paths from Claude Code. */
  paths: string[];
  /** Why we picked / skipped this payload (debug aid surfaced to stderr). */
  reason:
    | 'extracted'
    | 'not-an-edit-tool'
    | 'no-paths-in-tool-input'
    | 'wrong-event'
    | 'malformed-payload';
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Extract the list of file paths a PostToolUse hook payload describes.
 *
 * Returns an empty paths list (with a `reason`) for any payload we
 * shouldn't act on — wrong event, non-edit tool, malformed input. The
 * CLI layer logs the reason at the appropriate verbosity.
 *
 * Defensive: never throws. A malformed hook payload should not crash
 * the agent's tool-use feedback loop.
 */
export function extractHookPaths(payload: unknown): ExtractedHookPaths {
  if (typeof payload !== 'object' || payload === null) {
    return { paths: [], reason: 'malformed-payload' };
  }
  const p = payload as ClaudeCodeHookPayload;
  // PostToolUse is the event we want; defensively accept other names
  // too (different agent harnesses may use slightly different names).
  // If the field is absent we assume PostToolUse (the most common
  // wiring).
  if (p.hook_event_name && p.hook_event_name !== 'PostToolUse') {
    return { paths: [], reason: 'wrong-event' };
  }
  if (!p.tool_name || !EDIT_TOOLS.has(p.tool_name)) {
    return { paths: [], reason: 'not-an-edit-tool' };
  }
  const collected: string[] = [];
  const input = p.tool_input;
  if (typeof input === 'object' && input !== null) {
    if (typeof input.file_path === 'string') collected.push(input.file_path);
    if (Array.isArray(input.files)) {
      for (const f of input.files) {
        if (f && typeof f.file_path === 'string') collected.push(f.file_path);
      }
    }
    if (Array.isArray(input.edits)) {
      for (const e of input.edits) {
        if (e && typeof e.file_path === 'string') collected.push(e.file_path);
      }
    }
  }
  if (collected.length === 0) return { paths: [], reason: 'no-paths-in-tool-input' };
  return { paths: dedupe(collected), reason: 'extracted' };
}

function dedupe(paths: readonly string[]): string[] {
  return Array.from(new Set(paths));
}

/**
 * Convert absolute paths from the hook payload into project-relative
 * paths against `cwd`. Returns null for any path that lives outside the
 * project (those are uninteresting for aiftp status — they cannot
 * possibly affect the FTP upload set). The CLI uses this to filter
 * before invoking `runStatus`.
 */
export function relativizeIntoProject(cwd: string, absolutePaths: readonly string[]): string[] {
  const cwdNormalized = cwd.endsWith('/') ? cwd : `${cwd}/`;
  const out: string[] = [];
  for (const p of absolutePaths) {
    if (!p.startsWith(cwdNormalized)) continue;
    out.push(p.slice(cwdNormalized.length));
  }
  return out;
}
