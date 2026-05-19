import { XMLParser } from 'fast-xml-parser';

export type FilezillaProtocol = 'ftp' | 'ftps_explicit' | 'ftps_implicit' | 'sftp';

export type FilezillaPasswordStatus =
  | { kind: 'plaintext'; value: string }
  | { kind: 'encoded'; value: string }
  | { kind: 'master-encrypted'; cipherText: string }
  | { kind: 'absent' };

export type FilezillaEncoding = 'utf-8' | 'shift_jis' | 'euc-jp' | 'auto';

export interface ImportedProfile {
  /** Suggested aiftp profile name (kebab-cased, folder-prefixed). */
  name: string;
  /** Top-down folder ancestors. Empty when the server sits at the root. */
  folderPath: readonly string[];
  host: string;
  port: number;
  protocol: FilezillaProtocol;
  user: string;
  account?: string;
  passive_mode?: boolean;
  encoding?: FilezillaEncoding;
  timezone_offset_min?: number;
  remote_root: string;
  password: FilezillaPasswordStatus;
  warnings: string[];
}

export interface FilezillaImportResult {
  profiles: ImportedProfile[];
  /** File-level warnings (parser-level, not bound to a single server). */
  warnings: string[];
}

// preserveOrder=true gives us a uniform array-of-tags shape that makes mixed
// folder/server content easy to walk. Each node is *either* a text-only node
// ({ "#text": string }) or a tag node with one tag-name key whose value is an
// array of further child nodes, plus an optional `:@` attribute bag. The
// shape is documented as a discriminated record rather than a single index
// signature because TypeScript otherwise rejects the heterogeneous values.
type XmlChild = Record<string, unknown>;

const SUPPORTED_PASS_ENCODINGS = new Set(['base64']);

function mapProtocol(code: string): FilezillaProtocol {
  switch (code.trim()) {
    case '0':
      return 'ftp';
    case '1':
      return 'sftp';
    case '3':
      return 'ftps_implicit';
    case '4':
      return 'ftps_explicit';
    default:
      // Unknown protocol codes default to plain FTP with a warning generated
      // by the caller. 0 (FTP) is the safest fallback because aiftp will then
      // refuse the upload if `safety.require_tls` is on.
      return 'ftp';
  }
}

function mapEncodingType(
  encodingType: string | undefined,
  customEncoding: string | undefined,
): FilezillaEncoding {
  if (!encodingType) return 'auto';
  const type = encodingType.trim();
  if (type === 'UTF-8') return 'utf-8';
  if (type === 'Auto') return 'auto';
  if (type === 'Custom' && customEncoding) {
    const ce = customEncoding.trim();
    if (/^shift[-_]?jis$/iu.test(ce)) return 'shift_jis';
    if (/^euc[-_]?jp$/iu.test(ce)) return 'euc-jp';
    if (/^utf-?8$/iu.test(ce)) return 'utf-8';
  }
  return 'auto';
}

/**
 * Decode FileZilla's `<RemoteDir>` token format. Examples:
 *   "1 0 11 public_html"             -> "/public_html"
 *   "1 0 5 stage"                    -> "/stage"
 *   "1 0 11 public_html 4 demo"      -> "/public_html/demo"
 *   "8 0 1 C 4 docs"                 -> "/C/docs"   (Windows-style; aiftp does
 *                                                      not preserve drive)
 *   ""                               -> "/"
 *
 * The first two tokens are a "path type" header (1 = Unix, 8 = Windows) that
 * we currently ignore beyond logging. The remainder is a sequence of
 * `<length> <segment>` pairs, where `length` is the *character* length of
 * the next segment. We deliberately consume by the declared length rather
 * than splitting on whitespace, because segment names may contain spaces.
 */
function decodeRemoteDir(raw: string | undefined): string {
  if (!raw) return '/';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '/';

  const segments: string[] = [];
  // Tokenise lazily so we can read variable-length segments.
  let cursor = 0;

  // Skip the leading "1 0" / "8 0" header (two whitespace-separated tokens).
  const headerMatch = trimmed.match(/^\s*(\d+)\s+(\d+)\s*/u);
  if (headerMatch?.[0]) {
    cursor = headerMatch[0].length;
  }

  while (cursor < trimmed.length) {
    const lenMatch = trimmed.slice(cursor).match(/^\s*(\d+)\s/u);
    if (!lenMatch) break;
    const segmentLength = Number.parseInt(lenMatch[1] ?? '0', 10);
    cursor += lenMatch[0].length;
    const segment = trimmed.slice(cursor, cursor + segmentLength);
    cursor += segmentLength;
    if (segment.length > 0) segments.push(segment);
  }

  if (segments.length === 0) return '/';
  return `/${segments.join('/')}`;
}

function kebabize(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/[\s_/\\.]+/gu, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase();
}

function generateProfileName(folderPath: readonly string[], rawName: string): string {
  const parts = [...folderPath, rawName]
    .map((part) => kebabize(part))
    .filter((part) => part.length > 0);
  if (parts.length === 0) return 'imported-profile';
  return parts.join('-');
}

function decodePassword(
  passText: string,
  encodingAttr: string | undefined,
  logontype: string | undefined,
  collectWarning: (msg: string) => void,
  rawNameForWarning: string,
): FilezillaPasswordStatus {
  if (logontype && logontype.trim() === '2') {
    return { kind: 'absent' };
  }
  if (!passText || passText.length === 0) {
    return { kind: 'absent' };
  }
  if (!encodingAttr) {
    // FileZilla 3.27+ defaults to base64; older versions stored plaintext.
    return { kind: 'plaintext', value: passText };
  }
  const enc = encodingAttr.trim().toLowerCase();
  if (enc === 'crypt') {
    collectWarning(
      `master password protected entry: ${rawNameForWarning} (re-enter the password via 'aiftp auth set' after import)`,
    );
    return { kind: 'master-encrypted', cipherText: passText };
  }
  if (SUPPORTED_PASS_ENCODINGS.has(enc)) {
    try {
      const decoded = Buffer.from(passText, 'base64').toString('utf8');
      return { kind: 'encoded', value: decoded };
    } catch {
      collectWarning(`failed to base64-decode password for ${rawNameForWarning}`);
      return { kind: 'absent' };
    }
  }
  collectWarning(`unknown Pass encoding '${enc}' for ${rawNameForWarning}; treating as plaintext`);
  return { kind: 'plaintext', value: passText };
}

function findChild(node: XmlChild[], tag: string): XmlChild[] | undefined {
  for (const entry of node) {
    if (tag in entry) {
      return (entry as Record<string, XmlChild[]>)[tag];
    }
  }
  return undefined;
}

function getTextContent(children: XmlChild[] | undefined): string {
  if (!children) return '';
  for (const child of children) {
    if ('#text' in child) {
      return String((child as Record<'#text', unknown>)['#text']);
    }
  }
  return '';
}

function getAttribute(node: XmlChild, attr: string): string | undefined {
  const attrs = (node as { ':@'?: Record<string, string> })[':@'];
  if (!attrs) return undefined;
  return attrs[`@_${attr}`];
}

function readServerFields(serverChildren: XmlChild[]): {
  fields: Record<string, string>;
  passText: string;
  passEncoding?: string;
} {
  const fields: Record<string, string> = {};
  let passText = '';
  let passEncoding: string | undefined;

  for (const child of serverChildren) {
    if ('#text' in child) continue;
    const tag = Object.keys(child).find((k) => k !== ':@');
    if (!tag) continue;
    const children = (child as Record<string, XmlChild[]>)[tag];
    if (!children) continue;
    if (tag === 'Pass') {
      passText = getTextContent(children);
      passEncoding = getAttribute(child, 'encoding');
      continue;
    }
    fields[tag] = getTextContent(children);
  }

  return { fields, passText, passEncoding };
}

function buildProfile(serverChildren: XmlChild[], folderPath: readonly string[]): ImportedProfile {
  const { fields, passText, passEncoding } = readServerFields(serverChildren);
  const rawName = fields.Name ?? 'imported';
  const warnings: string[] = [];
  const collect = (msg: string): void => {
    warnings.push(msg);
  };

  const protocolCode = fields.Protocol ?? '0';
  const protocol = mapProtocol(protocolCode);
  if (protocol === 'ftp' && !['0'].includes(protocolCode.trim())) {
    collect(`unknown Protocol code '${protocolCode}', falling back to plain FTP`);
  }

  const portRaw = fields.Port ?? '';
  const port = /^\d+$/u.test(portRaw.trim())
    ? Number.parseInt(portRaw, 10)
    : protocol === 'ftps_implicit'
      ? 990
      : 21;

  const tzRaw = fields.TimezoneOffset;
  const timezone_offset_min =
    tzRaw && /^-?\d+$/u.test(tzRaw.trim()) ? Number.parseInt(tzRaw, 10) : undefined;

  return {
    name: generateProfileName(folderPath, rawName),
    folderPath: [...folderPath],
    host: (fields.Host ?? '').trim(),
    port,
    protocol,
    user: (fields.User ?? '').trim(),
    account: fields.Account ? fields.Account.trim() || undefined : undefined,
    passive_mode:
      fields.PasvMode === 'MODE_PASSIVE'
        ? true
        : fields.PasvMode === 'MODE_ACTIVE'
          ? false
          : undefined,
    encoding: mapEncodingType(fields.EncodingType, fields.CustomEncoding),
    timezone_offset_min,
    remote_root: decodeRemoteDir(fields.RemoteDir),
    password: decodePassword(passText, passEncoding, fields.Logontype, collect, rawName),
    warnings,
  };
}

function walkServers(
  nodes: XmlChild[] | undefined,
  folderPath: string[],
  profiles: ImportedProfile[],
): void {
  if (!nodes) return;
  for (const node of nodes) {
    if ('#text' in node) continue;
    const tag = Object.keys(node).find((k) => k !== ':@');
    if (!tag) continue;
    const children = (node as Record<string, XmlChild[]>)[tag];
    if (!children) continue;
    if (tag === 'Folder') {
      // Folder name lives in the first #text child of the Folder element.
      const folderName = getTextContent(children).trim();
      walkServers(children, [...folderPath, folderName], profiles);
    } else if (tag === 'Server') {
      profiles.push(buildProfile(children, folderPath));
    }
  }
}

/** Minimal data needed to round-trip an aiftp profile into FileZilla XML. */
export interface ExportProfile {
  /** Profile name -- becomes both the FileZilla <Name> and the inline label. */
  name: string;
  host: string;
  port: number;
  protocol: FilezillaProtocol | 'ftp' | 'ftps_explicit' | 'ftps_implicit';
  user: string;
  account?: string;
  passive_mode?: boolean;
  encoding?: FilezillaEncoding;
  timezone_offset_min?: number;
  remote_root: string;
  /** Only used when `RenderOptions.includePassword === true`. */
  password?: string;
}

export interface RenderOptions {
  /**
   * When true, embed each profile's `password` (base64-encoded) into the
   * resulting XML's `<Pass>` element. Off by default -- exporting credentials
   * is explicit and noisy by design.
   */
  includePassword?: boolean;
}

function protocolToCode(protocol: ExportProfile['protocol']): string {
  switch (protocol) {
    case 'ftp':
      return '0';
    case 'sftp':
      return '1';
    case 'ftps_implicit':
      return '3';
    case 'ftps_explicit':
      return '4';
  }
}

function encodeRemoteDir(remoteRoot: string): string {
  // Reverse of `decodeRemoteDir`. We emit Unix-style ("1 0") because aiftp
  // does not preserve drive letters.
  const segments = remoteRoot
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return '1 0';
  const encoded = segments.map((segment) => `${segment.length} ${segment}`).join(' ');
  return `1 0 ${encoded}`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function encodingToFilezilla(encoding: FilezillaEncoding | undefined): {
  encodingType: string;
  customEncoding?: string;
} {
  switch (encoding) {
    case 'utf-8':
      return { encodingType: 'UTF-8' };
    case 'shift_jis':
      return { encodingType: 'Custom', customEncoding: 'Shift_JIS' };
    case 'euc-jp':
      return { encodingType: 'Custom', customEncoding: 'EUC-JP' };
    default:
      return { encodingType: 'Auto' };
  }
}

function renderServer(profile: ExportProfile, includePassword: boolean): string {
  const code = protocolToCode(profile.protocol);
  const pasv =
    profile.passive_mode === true
      ? 'MODE_PASSIVE'
      : profile.passive_mode === false
        ? 'MODE_ACTIVE'
        : 'MODE_DEFAULT';
  const { encodingType, customEncoding } = encodingToFilezilla(profile.encoding);

  const passElement =
    includePassword && profile.password
      ? `<Pass encoding="base64">${xmlEscape(Buffer.from(profile.password, 'utf8').toString('base64'))}</Pass>`
      : '<Pass></Pass>';

  const lines: string[] = [
    '    <Server>',
    `      <Host>${xmlEscape(profile.host)}</Host>`,
    `      <Port>${profile.port}</Port>`,
    `      <Protocol>${code}</Protocol>`,
    '      <Type>0</Type>',
    `      <User>${xmlEscape(profile.user)}</User>`,
    `      ${passElement}`,
    `      <Account>${profile.account ? xmlEscape(profile.account) : ''}</Account>`,
    `      <Logontype>${profile.user ? '1' : '0'}</Logontype>`,
    `      <TimezoneOffset>${profile.timezone_offset_min ?? 0}</TimezoneOffset>`,
    `      <PasvMode>${pasv}</PasvMode>`,
    '      <MaximumMultipleConnections>2</MaximumMultipleConnections>',
    `      <EncodingType>${encodingType}</EncodingType>`,
  ];
  if (customEncoding) {
    lines.push(`      <CustomEncoding>${xmlEscape(customEncoding)}</CustomEncoding>`);
  }
  lines.push('      <BypassProxy>0</BypassProxy>');
  lines.push(`      <Name>${xmlEscape(profile.name)}</Name>`);
  lines.push('      <LocalDir></LocalDir>');
  lines.push(`      <RemoteDir>${encodeRemoteDir(profile.remote_root)}</RemoteDir>`);
  lines.push('      <SyncBrowsing>0</SyncBrowsing>');
  lines.push(`      ${xmlEscape(profile.name)}`);
  lines.push('    </Server>');
  return lines.join('\n');
}

/**
 * Render an array of aiftp profiles as a FileZilla 3 sitemanager XML
 * document. Round-trips through `parseFilezillaXml` for the fields that
 * actually matter (host / port / protocol / user / remote_root / encoding).
 * Passwords are *never* embedded unless the caller explicitly opts in via
 * `options.includePassword = true`; the default emits empty `<Pass>` tags.
 */
export function renderFilezillaXml(
  profiles: readonly ExportProfile[],
  options: RenderOptions = {},
): string {
  const includePassword = options.includePassword === true;
  const head = '<?xml version="1.0" encoding="UTF-8"?>';
  const root = '<FileZilla3 version="3.66.0" platform="aiftp-export">';
  const inner = profiles.map((p) => renderServer(p, includePassword)).join('\n');
  return `${head}\n${root}\n  <Servers>\n${inner}\n  </Servers>\n</FileZilla3>\n`;
}

export function parseFilezillaXml(xml: string): FilezillaImportResult {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    throw new Error('Failed to parse FileZilla XML: empty input');
  }

  let parsed: XmlChild[];
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      attributesGroupName: ':@',
      textNodeName: '#text',
      preserveOrder: true,
      trimValues: false,
      processEntities: true,
    });
    parsed = parser.parse(xml) as XmlChild[];
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse FileZilla XML: ${detail}`);
  }

  // The root sequence may begin with the XML declaration node, comments, etc.
  const root = parsed.find(
    (node): node is { FileZilla3: XmlChild[] } =>
      typeof node === 'object' && node !== null && 'FileZilla3' in node,
  );
  if (!root) {
    throw new Error('Failed to parse FileZilla sitemanager: expected a <FileZilla3> root element');
  }

  const servers = findChild(root.FileZilla3, 'Servers');
  if (!servers) {
    return { profiles: [], warnings: [] };
  }

  const profiles: ImportedProfile[] = [];
  walkServers(servers, [], profiles);
  return { profiles, warnings: [] };
}
