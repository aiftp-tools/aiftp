import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFilezillaXml, renderFilezillaXml } from './filezilla.js';
import type { ExportProfile } from './filezilla.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  join(here, '..', '__fixtures__', 'importers', 'filezilla', name);

async function loadFixture(name: string): Promise<string> {
  return await readFile(fixture(name), 'utf8');
}

describe('parseFilezillaXml: protocol mapping', () => {
  it('maps Protocol code 0 -> "ftp", 4 -> "ftps_explicit", 3 -> "ftps_implicit", 1 -> "sftp"', async () => {
    const xml = await loadFixture('protocols-mixed.xml');
    const { profiles } = parseFilezillaXml(xml);
    const protocols = Object.fromEntries(profiles.map((p) => [p.host, p.protocol]));
    expect(protocols['ftp-plain.example.com']).toBe('ftp');
    expect(protocols['ftps-explicit.example.com']).toBe('ftps_explicit');
    expect(protocols['ftps-implicit.example.com']).toBe('ftps_implicit');
    expect(protocols['sftp.example.com']).toBe('sftp');
  });
});

describe('parseFilezillaXml: single site', () => {
  it('extracts host / port / user / name from a flat sitemanager.xml', async () => {
    const xml = await loadFixture('single-site.xml');
    const { profiles } = parseFilezillaXml(xml);
    expect(profiles).toHaveLength(1);
    const profile = profiles[0];
    expect(profile?.host).toBe('ftp.example.com');
    expect(profile?.port).toBe(21);
    expect(profile?.user).toBe('deploy');
    expect(profile?.name).toBe('example-production');
    expect(profile?.folderPath).toEqual([]);
  });

  it('exposes the Pass element as a structured FilezillaPasswordStatus (kind = "encoded" for base64)', async () => {
    const xml = await loadFixture('single-site.xml');
    const [profile] = parseFilezillaXml(xml).profiles;
    expect(profile?.password.kind).toBe('encoded');
    if (profile?.password.kind === 'encoded') {
      expect(profile.password.value).toBe('deploy-password');
    }
  });

  it('decodes RemoteDir token format ("1 0 11 public_html") to a plain remote_root', async () => {
    const xml = await loadFixture('single-site.xml');
    const [profile] = parseFilezillaXml(xml).profiles;
    expect(profile?.remote_root).toBe('/public_html');
  });
});

describe('parseFilezillaXml: folder hierarchy', () => {
  it('records the FileZilla folder path for each server in folderPath (top-down)', async () => {
    const xml = await loadFixture('folder-tree.xml');
    const { profiles } = parseFilezillaXml(xml);
    const acmeProd = profiles.find(
      (p) => p.host === 'ftp.acme.example.com' && p.user === 'acme-deploy',
    );
    expect(acmeProd?.folderPath).toEqual(['Clients', 'Acme Corp']);
    const beta = profiles.find((p) => p.host === 'ftp.beta.example.com');
    expect(beta?.folderPath).toEqual(['Clients']);
  });

  it('generates suggested profile names by joining folderPath with kebab-cased Name', async () => {
    const xml = await loadFixture('folder-tree.xml');
    const { profiles } = parseFilezillaXml(xml);
    const acmeProd = profiles.find((p) => p.user === 'acme-deploy');
    expect(acmeProd?.name).toMatch(/clients[-/]acme-corp[-/]production/);
    const beta = profiles.find((p) => p.host === 'ftp.beta.example.com');
    expect(beta?.name).toMatch(/clients[-/]beta-direct/);
  });
});

describe('parseFilezillaXml: encoding inference', () => {
  it('maps EncodingType=Custom + CustomEncoding=Shift_JIS to encoding = "shift_jis"', async () => {
    const xml = await loadFixture('japanese-shift_jis.xml');
    const [profile] = parseFilezillaXml(xml).profiles;
    expect(profile?.encoding).toBe('shift_jis');
  });

  it('maps EncodingType=Auto to encoding = "auto"', async () => {
    const xml = await loadFixture('single-site.xml');
    const [profile] = parseFilezillaXml(xml).profiles;
    expect(profile?.encoding).toBe('auto');
  });
});

describe('parseFilezillaXml: password edge cases', () => {
  it('marks master-password-encrypted entries with password.kind = "master-encrypted"', async () => {
    const xml = await loadFixture('master-password-encrypted.xml');
    const [profile] = parseFilezillaXml(xml).profiles;
    expect(profile?.password.kind).toBe('master-encrypted');
    expect(profile?.warnings.some((w) => /master password/i.test(w))).toBe(true);
  });

  it('marks Logontype=2 (Ask) entries with password.kind = "absent"', async () => {
    const xml = await loadFixture('ask-login-no-password.xml');
    const [profile] = parseFilezillaXml(xml).profiles;
    expect(profile?.password.kind).toBe('absent');
  });
});

describe('renderFilezillaXml: aiftp -> FileZilla 3 XML', () => {
  const base: ExportProfile = {
    name: 'example-production',
    host: 'ftp.example.com',
    port: 21,
    protocol: 'ftps_explicit',
    user: 'deploy',
    remote_root: '/public_html',
    encoding: 'auto',
  };

  it('produces a well-formed FileZilla3 document with the expected root elements', () => {
    const xml = renderFilezillaXml([base]);
    expect(xml).toMatch(/^<\?xml version="1\.0"/);
    expect(xml).toContain('<FileZilla3');
    expect(xml).toContain('<Servers>');
    expect(xml).toContain('</FileZilla3>');
  });

  it('maps aiftp protocols back to FileZilla numeric codes (4/0/3) and omits SFTP-only fields', () => {
    const xml = renderFilezillaXml([
      { ...base, protocol: 'ftp' },
      { ...base, name: 'tls', protocol: 'ftps_explicit' },
      { ...base, name: 'imp', protocol: 'ftps_implicit', port: 990 },
    ]);
    const servers = xml.split('<Server>').slice(1);
    expect(servers[0]).toContain('<Protocol>0</Protocol>');
    expect(servers[1]).toContain('<Protocol>4</Protocol>');
    expect(servers[2]).toContain('<Protocol>3</Protocol>');
  });

  it('re-encodes remote_root to the FileZilla token format ("1 0 11 public_html")', () => {
    const xml = renderFilezillaXml([{ ...base, remote_root: '/public_html' }]);
    expect(xml).toContain('<RemoteDir>1 0 11 public_html</RemoteDir>');
  });

  it('re-encodes nested remote_root segments preserving each length prefix', () => {
    const xml = renderFilezillaXml([{ ...base, remote_root: '/public_html/demo' }]);
    expect(xml).toContain('<RemoteDir>1 0 11 public_html 4 demo</RemoteDir>');
  });

  it('emits an empty <Pass></Pass> by default (no Keychain leak via export)', () => {
    const xml = renderFilezillaXml([base]);
    expect(xml).toMatch(/<Pass>\s*<\/Pass>|<Pass\/>/);
    expect(xml).not.toContain('Pass>secret');
  });

  it('includes Pass only when the caller explicitly passes includePassword=true', () => {
    const xml = renderFilezillaXml([{ ...base, password: 'topsecret' }], {
      includePassword: true,
    });
    expect(xml).toContain('<Pass encoding="base64">');
    // base64 of "topsecret"
    expect(xml).toContain('dG9wc2VjcmV0');
  });

  it('refuses to embed a password when includePassword is not set, even if one is provided', () => {
    const xml = renderFilezillaXml([{ ...base, password: 'topsecret' }]);
    expect(xml).not.toContain('topsecret');
    expect(xml).not.toContain('dG9wc2VjcmV0');
  });

  it('encodes Shift_JIS encoding as Custom + CustomEncoding fields', () => {
    const xml = renderFilezillaXml([{ ...base, encoding: 'shift_jis' }]);
    expect(xml).toContain('<EncodingType>Custom</EncodingType>');
    expect(xml).toContain('<CustomEncoding>Shift_JIS</CustomEncoding>');
  });

  it('round-trips through parse(render(profile)) preserving host / port / user / protocol', () => {
    const xml = renderFilezillaXml([base]);
    const { profiles } = parseFilezillaXml(xml);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.host).toBe('ftp.example.com');
    expect(profiles[0]?.port).toBe(21);
    expect(profiles[0]?.user).toBe('deploy');
    expect(profiles[0]?.protocol).toBe('ftps_explicit');
    expect(profiles[0]?.remote_root).toBe('/public_html');
  });
});

describe('parseFilezillaXml: malformed input', () => {
  it('throws an explicit error on invalid XML rather than returning partial results', () => {
    expect(() => parseFilezillaXml('<<not-xml')).toThrow(/parse|xml/i);
  });

  it('returns an empty profile list when <Servers> is empty', () => {
    const xml = '<?xml version="1.0"?><FileZilla3><Servers></Servers></FileZilla3>';
    const result = parseFilezillaXml(xml);
    expect(result.profiles).toEqual([]);
  });

  it('rejects an XML that is not a FileZilla sitemanager (missing FileZilla3 root)', () => {
    expect(() =>
      parseFilezillaXml('<?xml version="1.0"?><SomethingElse><Servers/></SomethingElse>'),
    ).toThrow(/FileZilla|sitemanager/i);
  });
});
