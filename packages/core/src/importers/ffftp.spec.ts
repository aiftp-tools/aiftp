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

  it('emits password.kind=absent + a per-profile warning when Password field is present (v0.9.1 BLOCK fix)', () => {
    // Codex BLOCK from v0.7.0 review: emitting master-encrypted here
    // made every Password-bearing FFFTP profile get skipped by the apply
    // pipeline — i.e. virtually every real FFFTP user lost their entire
    // import. We now emit `absent` so the profile lands in TOML, and
    // surface the password situation as a per-profile warning that the
    // CLI relays to the operator.
    const buf = sjisIni([
      '[host0]',
      'HostAddress=ftp.example.com',
      'UserName=u',
      'Password=ZF6GBQHPYWXY',
    ]);
    const result = parseFfftpIni(buf);
    expect(result.profiles).toHaveLength(1);
    const profile = result.profiles[0];
    expect(profile?.password.kind).toBe('absent');
    expect(profile?.warnings.join(' ')).toMatch(/FFFTP|password|aiftp auth/i);
    // The Mask cipherText must NEVER appear in the imported result —
    // we never decode it, and we never carry it forward.
    expect(JSON.stringify(profile)).not.toContain('ZF6GBQHPYWXY');
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

  it('respects [Hosts] SetNumber to skip stale host sections (v0.9.1 fix)', async () => {
    // FFFTP keeps `[hostN]` sections around after deletion; only the
    // first SetNumber of them are "active". Without this guard we'd
    // import phantom servers.
    const buf = sjisIni([
      '[Hosts]',
      'SetNumber=2',
      '',
      '[host0]',
      'HostAddress=active-1.example.com',
      'UserName=u',
      '',
      '[host1]',
      'HostAddress=active-2.example.com',
      'UserName=u',
      '',
      '[host2]',
      'HostAddress=stale-deleted.example.com',
      'UserName=u',
    ]);
    const result = parseFfftpIni(buf);
    expect(result.profiles.map((p) => p.host)).toEqual([
      'active-1.example.com',
      'active-2.example.com',
    ]);
    expect(result.warnings.join(' ')).toMatch(/stale/i);
  });

  it('imports all host sections when [Hosts] SetNumber is absent (backwards compat)', () => {
    const buf = sjisIni([
      '[host0]',
      'HostAddress=a.example.com',
      'UserName=u',
      '[host1]',
      'HostAddress=b.example.com',
      'UserName=u',
    ]);
    const result = parseFfftpIni(buf);
    expect(result.profiles).toHaveLength(2);
  });

  it('accepts an already-decoded string as input (round-trip safety)', () => {
    // When a caller has already decoded the file (e.g. for testing or
    // for non-SJIS environments), `parseFfftpIni` accepts a string too.
    const text = ['[host0]', 'HostAddress=ftp.example.com', 'UserName=u'].join('\n');
    const result = parseFfftpIni(text);
    expect(result.profiles).toHaveLength(1);
  });
});
