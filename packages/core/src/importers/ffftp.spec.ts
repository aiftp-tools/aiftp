import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { parseFfftpIni } from './ffftp.js';

/**
 * Build a synthetic ffftp.ini byte buffer in Shift_JIS — exactly how
 * a real FFFTP install writes it on Japanese Windows.
 */
function sjisIni(lines: string[]): Buffer {
  return iconv.encode(lines.join('\r\n'), 'shift_jis');
}

describe('parseFfftpIni', () => {
  it('parses a basic [host0] section into an ImportedProfile', () => {
    const buf = sjisIni([
      '[Options]',
      'Version=5',
      '',
      '[host0]',
      'HostName=My Star Server',
      'HostAddress=ftp.example.com',
      'Port=21',
      'UserName=deploy',
      'RemoteDir=/public_html',
      'UseSecure=1',
      'PassV=1',
      'KanjiCode=1',
    ]);
    const result = parseFfftpIni(buf);
    expect(result.profiles).toHaveLength(1);
    const p = result.profiles[0];
    expect(p?.host).toBe('ftp.example.com');
    expect(p?.port).toBe(21);
    expect(p?.user).toBe('deploy');
    expect(p?.remote_root).toBe('/public_html');
    expect(p?.protocol).toBe('ftps_explicit');
    expect(p?.passive_mode).toBe(true);
    expect(p?.encoding).toBe('shift_jis');
    // FFFTP "My Star Server" → sanitized for aiftp's profile-name rules.
    expect(p?.name).toBe('my-star-server');
  });

  it('decodes Japanese host names from Shift_JIS source bytes', () => {
    const buf = sjisIni([
      '[host0]',
      'HostName=本番サーバー',
      'HostAddress=ftp.example.jp',
      'UserName=u',
      'Port=21',
    ]);
    const result = parseFfftpIni(buf);
    // The DISPLAY name is Japanese but sanitizeName collapses anything
    // outside [a-z0-9] to '-'. The host MUST decode correctly so the
    // resulting connect attempt goes to the right address.
    expect(result.profiles[0]?.host).toBe('ftp.example.jp');
  });

  it('marks the password as master-encrypted when Password field is non-empty (never decrypts)', () => {
    const buf = sjisIni([
      '[host0]',
      'HostAddress=ftp.example.com',
      'UserName=u',
      'Password=ZF6GBQHPYWXY',
    ]);
    const result = parseFfftpIni(buf);
    const pw = result.profiles[0]?.password;
    expect(pw?.kind).toBe('master-encrypted');
    // The cipherText is preserved verbatim so debug tooling can inspect
    // it, but it must NEVER be auto-decoded.
    if (pw?.kind === 'master-encrypted') {
      expect(pw.cipherText).toBe('ZF6GBQHPYWXY');
    }
  });

  it('reports absent password when the Password field is missing or empty', () => {
    const buf = sjisIni(['[host0]', 'HostAddress=ftp.example.com', 'UserName=u']);
    const result = parseFfftpIni(buf);
    expect(result.profiles[0]?.password.kind).toBe('absent');
  });

  it('skips non-host sections (e.g. [Options], [Hosts])', () => {
    const buf = sjisIni([
      '[Options]',
      'Version=5',
      '[Hosts]',
      'Count=1',
      '[host0]',
      'HostAddress=ftp.example.com',
      'UserName=u',
    ]);
    const result = parseFfftpIni(buf);
    expect(result.profiles).toHaveLength(1);
  });

  it('emits a warning and skips a host section missing HostAddress/HostName', () => {
    const buf = sjisIni(['[host0]', 'UserName=orphan-user', 'Port=21']);
    const result = parseFfftpIni(buf);
    expect(result.profiles).toHaveLength(0);
    expect(result.warnings.join('\n')).toMatch(/HostAddress|HostName/);
  });

  it('maps UseSecure values to FilezillaProtocol', () => {
    const cases: Array<[string, string]> = [
      ['0', 'ftp'],
      ['1', 'ftps_explicit'],
      ['2', 'ftps_implicit'],
      ['3', 'sftp'],
      ['', 'ftp'], // unset → plain FTP
    ];
    for (const [useSecure, expected] of cases) {
      const buf = sjisIni([
        '[host0]',
        'HostAddress=ftp.example.com',
        'UserName=u',
        `UseSecure=${useSecure}`,
      ]);
      expect(parseFfftpIni(buf).profiles[0]?.protocol).toBe(expected);
    }
  });

  it('maps KanjiCode values to file_name encoding', () => {
    const cases: Array<[string, string]> = [
      ['0', 'auto'],
      ['1', 'shift_jis'],
      ['3', 'euc-jp'],
      ['4', 'utf-8'],
      ['5', 'utf-8'],
    ];
    for (const [kanji, expected] of cases) {
      const buf = sjisIni([
        '[host0]',
        'HostAddress=ftp.example.com',
        'UserName=u',
        `KanjiCode=${kanji}`,
      ]);
      expect(parseFfftpIni(buf).profiles[0]?.encoding).toBe(expected);
    }
  });

  it('accepts an already-decoded string as input (round-trip safety)', () => {
    // When a caller has already decoded the file (e.g. for testing or
    // for non-SJIS environments), `parseFfftpIni` accepts a string too.
    const text = ['[host0]', 'HostAddress=ftp.example.com', 'UserName=u'].join('\n');
    const result = parseFfftpIni(text);
    expect(result.profiles).toHaveLength(1);
  });
});
