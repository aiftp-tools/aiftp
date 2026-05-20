import { describe, expect, it } from 'vitest';
import { extractHookPaths, relativizeIntoProject } from './hook.js';

describe('extractHookPaths', () => {
  it('extracts file_path from a Write tool payload', () => {
    const result = extractHookPaths({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/project/index.html' },
    });
    expect(result.reason).toBe('extracted');
    expect(result.paths).toEqual(['/project/index.html']);
  });

  it('extracts file_path from an Edit tool payload', () => {
    const result = extractHookPaths({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/project/about.html' },
    });
    expect(result.paths).toEqual(['/project/about.html']);
  });

  it('extracts paths from MultiEdit-style edits array', () => {
    const result = extractHookPaths({
      hook_event_name: 'PostToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        edits: [
          { file_path: '/project/a.html' },
          { file_path: '/project/b.html' },
          { file_path: '/project/a.html' }, // duplicate — dedupe
        ],
      },
    });
    expect(result.paths).toEqual(['/project/a.html', '/project/b.html']);
  });

  it('skips non-edit tools (Bash, Read, etc.)', () => {
    const result = extractHookPaths({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(result.reason).toBe('not-an-edit-tool');
    expect(result.paths).toEqual([]);
  });

  it('skips payloads from other hook events (PreToolUse etc.)', () => {
    const result = extractHookPaths({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/project/index.html' },
    });
    expect(result.reason).toBe('wrong-event');
  });

  it('treats absent hook_event_name as PostToolUse (defensive)', () => {
    // Some agent harnesses don't include the event name. Default to
    // accepting rather than refusing so we don't silently no-op.
    const result = extractHookPaths({
      tool_name: 'Write',
      tool_input: { file_path: '/project/index.html' },
    });
    expect(result.reason).toBe('extracted');
  });

  it('reports no-paths-in-tool-input when the tool_input has nothing actionable', () => {
    const result = extractHookPaths({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        /* no file_path */
      },
    });
    expect(result.reason).toBe('no-paths-in-tool-input');
  });

  it('returns malformed-payload (never throws) for unstructured input', () => {
    // A misconfigured hook could pipe in non-JSON or a primitive. The
    // function must not crash the agent's tool-use loop.
    expect(extractHookPaths(null).reason).toBe('malformed-payload');
    expect(extractHookPaths('not-an-object').reason).toBe('malformed-payload');
    expect(extractHookPaths(42).reason).toBe('malformed-payload');
  });
});

describe('relativizeIntoProject', () => {
  it('keeps only paths under cwd and strips the prefix', () => {
    const out = relativizeIntoProject('/project', [
      '/project/index.html',
      '/project/sub/about.html',
      '/elsewhere/leak.html',
    ]);
    expect(out).toEqual(['index.html', 'sub/about.html']);
  });

  it('handles cwd with trailing slash equivalently', () => {
    const out = relativizeIntoProject('/project/', ['/project/index.html']);
    expect(out).toEqual(['index.html']);
  });

  it('drops paths that share a prefix but not a directory boundary', () => {
    // `/projects/other.html` starts with `/project` literally but is
    // outside `/project/`. Must NOT be treated as inside.
    const out = relativizeIntoProject('/project', ['/projects/other.html']);
    expect(out).toEqual([]);
  });
});
