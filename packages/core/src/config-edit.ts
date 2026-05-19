/**
 * Text-level editing of `.aiftp.toml` profile blocks.
 *
 * Why text-level and not `@iarna/toml.stringify`?
 *
 * - stringify discards user comments, key/section ordering, and whitespace
 *   that operators care about (the v0.2 schema migration faced the same
 *   problem and uses a text-level transform; v0.4 follows the same pattern).
 * - Profile blocks are deliberately small and well-shaped (`[profile.NAME]`
 *   followed by `key = value` lines, terminated by the next `[...]` section
 *   or EOF) so a simple line-based parser is sufficient.
 *
 * Trade-offs:
 *
 * - We only manipulate `[profile.NAME]` blocks. `[encoding]`, `[quirks]`,
 *   `[safety]`, etc. are untouched even if they appear between two profiles.
 * - We do not support nested tables like `[profile.NAME.subkey]` because
 *   the current schema does not use them; if v0.5+ introduces nested
 *   tables, this module will need a stricter parser.
 * - Profile names are validated by `isValidProfileName` before being
 *   substituted into regex patterns or block headers, so quote / dot /
 *   space / slash injection is impossible by construction.
 */

/** Pattern for valid aiftp profile names (kebab-case, ASCII, no separators). */
const PROFILE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

export function isValidProfileName(name: string): boolean {
  return typeof name === 'string' && PROFILE_NAME_PATTERN.test(name);
}

/** Fields a structured `appendProfileBlock` call accepts. */
export interface ProfileBlockFields {
  host: string;
  port: number;
  protocol: 'ftp' | 'ftps';
  user: string;
  remote_root: string;
  local_root: string;
  keychain_service: string;
  server_kind: 'starserver' | 'lolipop' | 'sakura' | 'xserver' | 'generic';
  account?: string;
  ftps_mode?: 'explicit' | 'implicit';
  passive_mode?: boolean;
}

/** Line-index range of a profile block (half-open: [start, end)). */
export interface ProfileBlockRange {
  /** Line index of the `[profile.NAME]` header. */
  start: number;
  /** Line index of the next `[...]` table header, or `lines.length` at EOF. */
  end: number;
}

function tableHeaderPattern(): RegExp {
  // Matches any TOML table or array-of-tables header at the start of a line.
  return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/u;
}

function profileHeaderFor(name: string): string {
  return `[profile.${name}]`;
}

function findProfileBlockRangeInLines(
  lines: readonly string[],
  name: string,
): ProfileBlockRange | null {
  const header = profileHeaderFor(name);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return null;
  const tablePattern = tableHeaderPattern();
  for (let i = start + 1; i < lines.length; i++) {
    if (tablePattern.test(lines[i] ?? '')) {
      return { start, end: i };
    }
  }
  return { start, end: lines.length };
}

export function findProfileBlockRange(source: string, name: string): ProfileBlockRange | null {
  if (!isValidProfileName(name)) return null;
  return findProfileBlockRangeInLines(source.split('\n'), name);
}

export function extractProfileBlock(source: string, name: string): string | null {
  const lines = source.split('\n');
  const range = findProfileBlockRangeInLines(lines, name);
  if (!range) return null;
  // Trim trailing blank lines from the block (the blanks belong to the
  // separator between blocks, not to the block itself).
  let end = range.end;
  while (end > range.start + 1 && (lines[end - 1] ?? '').trim() === '') {
    end--;
  }
  return lines.slice(range.start, end).join('\n');
}

export function removeProfileBlock(source: string, name: string): string {
  const lines = source.split('\n');
  const range = findProfileBlockRangeInLines(lines, name);
  if (!range) return source;
  // Also consume a single trailing blank line if present (to keep the file
  // from accumulating empty lines after repeated remove/add cycles).
  const end = range.end;
  if (end < lines.length && (lines[end - 1] ?? '').trim() === '') {
    // Keep the blank line so the next [table] still has spacing -- only
    // drop one if the block itself ended with a blank AND the next section
    // already has its own preceding blank. Conservative: keep it.
  }
  const before = lines.slice(0, range.start);
  const after = lines.slice(end);
  return [...before, ...after].join('\n');
}

export function renameProfileBlock(source: string, oldName: string, newName: string): string {
  if (!isValidProfileName(oldName)) {
    throw new Error(`Invalid source profile name: ${JSON.stringify(oldName)}`);
  }
  if (!isValidProfileName(newName)) {
    throw new Error(`Invalid destination profile name: ${JSON.stringify(newName)}`);
  }
  const lines = source.split('\n');
  if (findProfileBlockRangeInLines(lines, newName)) {
    throw new Error(`Profile already exists: ${newName}`);
  }
  const range = findProfileBlockRangeInLines(lines, oldName);
  if (!range) return source;
  const newLines = [...lines];
  newLines[range.start] = profileHeaderFor(newName);
  return newLines.join('\n');
}

function renderField(key: string, value: string | number | boolean): string {
  if (typeof value === 'string') return `${key} = ${JSON.stringify(value)}`;
  return `${key} = ${value}`;
}

export function appendProfileBlock(
  source: string,
  name: string,
  fields: ProfileBlockFields,
): string {
  if (!isValidProfileName(name)) {
    throw new Error(`Invalid profile name: ${JSON.stringify(name)}`);
  }
  const lines = source.split('\n');
  if (findProfileBlockRangeInLines(lines, name)) {
    throw new Error(`Profile already exists: ${name}`);
  }

  const blockLines: string[] = [
    profileHeaderFor(name),
    renderField('host', fields.host),
    renderField('port', fields.port),
    renderField('protocol', fields.protocol),
    renderField('user', fields.user),
    renderField('remote_root', fields.remote_root),
    renderField('local_root', fields.local_root),
    renderField('keychain_service', fields.keychain_service),
    renderField('server_kind', fields.server_kind),
  ];
  if (fields.account !== undefined) blockLines.push(renderField('account', fields.account));
  if (fields.ftps_mode !== undefined) blockLines.push(renderField('ftps_mode', fields.ftps_mode));
  if (fields.passive_mode !== undefined)
    blockLines.push(renderField('passive_mode', fields.passive_mode));

  const trimmedSource = source.replace(/\n+$/u, '');
  const sep = trimmedSource.length === 0 ? '' : '\n\n';
  return `${trimmedSource}${sep}${blockLines.join('\n')}\n`;
}

export function setProfileField(
  source: string,
  name: string,
  field: string,
  rawValue: string,
): string {
  const lines = source.split('\n');
  const range = findProfileBlockRangeInLines(lines, name);
  if (!range) {
    throw new Error(`Profile not found: ${name}`);
  }
  const fieldLinePattern = new RegExp(`^\\s*${field}\\s*=`, 'u');
  let replaced = false;
  for (let i = range.start + 1; i < range.end; i++) {
    if (fieldLinePattern.test(lines[i] ?? '')) {
      lines[i] = `${field} = ${rawValue}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    // Insert just before the end of the block (i.e., at range.end position,
    // pushing everything down by 1). Skip trailing blank lines so the field
    // attaches to the block, not to the spacer between blocks.
    let insertAt = range.end;
    while (insertAt > range.start + 1 && (lines[insertAt - 1] ?? '').trim() === '') {
      insertAt--;
    }
    lines.splice(insertAt, 0, `${field} = ${rawValue}`);
  }
  return lines.join('\n');
}
