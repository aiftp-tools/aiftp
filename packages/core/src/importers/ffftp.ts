import iconv from 'iconv-lite';
import type {
  FilezillaEncoding,
  FilezillaImportResult,
  FilezillaPasswordStatus,
  FilezillaProtocol,
  ImportedProfile,
} from './filezilla.js';

/**
 * Parse a Windows-style FFFTP `ffftp.ini` (the "INI mode" export).
 *
 * FFFTP stores each saved host as `[host{N}]` section. The fields that
 * map cleanly onto aiftp profiles are:
 *
 *   HostName       → host
 *   HostAddress    → host (preferred when present)
 *   UserName       → user
 *   RemoteDir      → remote_root
 *   Port           → port
 *   PassV          → passive_mode (0/1)
 *   KanjiCode      → encoding.file_name (Shift_JIS / EUC-JP / UTF-8 / auto)
 *   UseSecure      → protocol (FTPS variant)
 *   Account        → account
 *   HostName{N}    → profile display name (used as `name`)
 *
 * Spec §17.6 #3: normalize to the same `ImportedProfile` shape the
 * FileZilla importer emits so the CLI/MCP layers can reuse the
 * existing queueing/conflict-detection logic without a parallel
 * implementation.
 *
 * SECURITY: the `Password` field in ffftp.ini is encrypted with FFFTP's
 * custom Mask scheme. **We do not decrypt it** (the algorithm is
 * non-standard and would require shipping a reverse-engineered routine
 * with no upstream maintenance). The imported profile carries
 * `password.kind = 'master-encrypted'` so the CLI / MCP layers know to
 * skip the entry and prompt the operator to run `aiftp auth` instead.
 *
 * Shift_JIS handling: ffftp.ini is typically written in Shift_JIS on
 * Japanese Windows. We always decode through iconv-lite — never assume
 * UTF-8.
 */
export interface ParseFfftpIniOptions {
  /**
   * Optional override of the assumed source encoding. Defaults to
   * 'shift_jis' which is what FFFTP writes on every Japanese Windows
   * install we've seen.
   */
  sourceEncoding?: 'shift_jis' | 'utf-8' | 'euc-jp';
}

export function parseFfftpIni(
  source: Buffer | string,
  options: ParseFfftpIniOptions = {},
): FilezillaImportResult {
  const encoding = options.sourceEncoding ?? 'shift_jis';
  const text = typeof source === 'string' ? source : decode(source, encoding);
  const sections = parseIniSections(text);

  const profiles: ImportedProfile[] = [];
  const warnings: string[] = [];

  for (const section of sections) {
    // We only care about host sections; FFFTP also stores `[Options]`,
    // `[Hosts]`, `[Multi]` etc. which we ignore.
    if (!/^host\d+$/iu.test(section.name)) continue;

    const fields = section.fields;
    const name = fields.HostName ?? fields.HostAddress ?? fields.HostName1 ?? section.name;
    const host = fields.HostAddress ?? fields.HostName ?? '';
    if (!host) {
      warnings.push(`Skipped [${section.name}]: missing HostAddress/HostName`);
      continue;
    }
    const port = parseIntSafe(fields.Port, fields.UseSecure ? 990 : 21);
    const protocol: FilezillaProtocol = mapProtocol(fields.UseSecure);
    const passwordKind: FilezillaPasswordStatus =
      fields.Password && fields.Password.length > 0
        ? { kind: 'master-encrypted', cipherText: fields.Password }
        : { kind: 'absent' };

    profiles.push({
      name: sanitizeName(name),
      // FFFTP has no folder hierarchy in INI; we report a flat list.
      folderPath: [],
      host,
      port,
      protocol,
      user: fields.UserName ?? '',
      account: fields.Account || undefined,
      passive_mode: fields.PassV === '1' ? true : fields.PassV === '0' ? false : undefined,
      encoding: mapKanjiCode(fields.KanjiCode),
      remote_root: fields.RemoteDir ?? '/',
      password: passwordKind,
      warnings: [],
    });
  }

  return { profiles, warnings };
}

interface IniSection {
  name: string;
  fields: Record<string, string>;
}

function parseIniSections(text: string): IniSection[] {
  // FFFTP's INI uses CRLF on Windows; the decoder may already have
  // normalized but we strip both. Comments are `;` or `#`.
  const sections: IniSection[] = [];
  let current: IniSection | null = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/u);
    if (sectionMatch) {
      current = { name: sectionMatch[1] ?? '', fields: {} };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    current.fields[key] = value;
  }
  return sections;
}

function decode(bytes: Buffer, encoding: ParseFfftpIniOptions['sourceEncoding']): string {
  // iconv-lite accepts `'shift_jis'` / `'utf-8'` / `'euc-jp'` directly
  // through `decode`. Fall back to identity on unrecognized strings —
  // shouldn't happen given the typed enum, but defensive.
  const codec = encoding === 'utf-8' ? 'utf8' : (encoding ?? 'shift_jis');
  return iconv.decode(bytes, codec);
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function mapProtocol(useSecure: string | undefined): FilezillaProtocol {
  // FFFTP's UseSecure values (best-known mapping):
  //   0 = plain FTP
  //   1 = FTPS Explicit  (FTPES)
  //   2 = FTPS Implicit  (port 990)
  //   3 = SFTP (rare in ffftp; mark sftp so aiftp's filezilla path
  //       skips it consistently)
  switch (useSecure?.trim()) {
    case '1':
      return 'ftps_explicit';
    case '2':
      return 'ftps_implicit';
    case '3':
      return 'sftp';
    default:
      return 'ftp';
  }
}

function mapKanjiCode(kanji: string | undefined): FilezillaEncoding {
  // FFFTP KanjiCode integer mapping:
  //   0 = no conversion / "auto"
  //   1 = Shift_JIS
  //   2 = JIS
  //   3 = EUC-JP
  //   4 = UTF-8 (HFS)
  //   5 = UTF-8 (NFC)
  switch (kanji?.trim()) {
    case '1':
      return 'shift_jis';
    case '3':
      return 'euc-jp';
    case '4':
    case '5':
      return 'utf-8';
    default:
      return 'auto';
  }
}

function sanitizeName(raw: string): string {
  // FFFTP host names may contain spaces and arbitrary Unicode. aiftp
  // profile names are constrained by `isValidProfileName` (lowercase
  // alphanumeric + '-'). We lower-case and collapse anything else to
  // '-'. Empty result → 'imported-host'.
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return cleaned.length > 0 ? cleaned : 'imported-host';
}
