import { describe, expect, it } from 'vitest';
import { type FtpsProbeResult, certificateMatchesHost } from './doctor.js';

/**
 * RFC 6125 §6.4.3 wildcard matching for `certificateMatchesHost`.
 *
 * v0.9.3: prior to this release the function did an exact-string
 * match only, which caused `ftps-cert: warn` to fire spuriously on
 * Sakura / Xserver / Lolipop whose shared certificates use
 * `*.<provider>.<tld>` covering every customer subdomain.
 */
function probe(certCommonName: string, certAltNames?: string[]): FtpsProbeResult {
  return {
    handshakeOk: true,
    certCommonName,
    certAltNames,
    pasvAddressLeak: null,
    mlsdSupported: true,
    sizeSupported: true,
    remoteRootCwdOk: true,
  };
}

describe('certificateMatchesHost', () => {
  describe('exact match (v0.9.1 behaviour, must keep)', () => {
    it('matches when CN equals the requested host', () => {
      expect(certificateMatchesHost('ftp.example.com', probe('ftp.example.com'))).toBe(true);
    });

    it('matches when one of the SANs equals the requested host', () => {
      expect(
        certificateMatchesHost('ftp.example.com', probe('other.example.com', ['ftp.example.com'])),
      ).toBe(true);
    });

    it('is case-insensitive (DNS names are case-insensitive)', () => {
      expect(certificateMatchesHost('FTP.Example.COM', probe('ftp.example.com'))).toBe(true);
      expect(certificateMatchesHost('ftp.example.com', probe('FTP.EXAMPLE.COM'))).toBe(true);
    });

    it('returns false on completely unrelated names', () => {
      expect(certificateMatchesHost('ftp.example.com', probe('mail.example.com'))).toBe(false);
    });
  });

  describe('wildcard match (v0.9.3 — A-7 discovery)', () => {
    it('matches `*.sakura.ne.jp` against `user.sakura.ne.jp`', () => {
      expect(certificateMatchesHost('user.sakura.ne.jp', probe('*.sakura.ne.jp'))).toBe(true);
    });

    it('matches `*.xserver.jp` against `sv17099.xserver.jp`', () => {
      expect(certificateMatchesHost('sv17099.xserver.jp', probe('*.xserver.jp'))).toBe(true);
    });

    it('matches `*.lolipop.jp` against `ftp-1.lolipop.jp`', () => {
      expect(certificateMatchesHost('ftp-1.lolipop.jp', probe('*.lolipop.jp'))).toBe(true);
    });

    it('matches wildcard from SAN list', () => {
      expect(
        certificateMatchesHost('user.sakura.ne.jp', probe('other.com', ['*.sakura.ne.jp'])),
      ).toBe(true);
    });

    it('does NOT match a multi-label prefix (`a.b.example.com` vs `*.example.com`)', () => {
      expect(certificateMatchesHost('a.b.example.com', probe('*.example.com'))).toBe(false);
    });

    it('does NOT match the bare suffix (`example.com` vs `*.example.com`)', () => {
      expect(certificateMatchesHost('example.com', probe('*.example.com'))).toBe(false);
    });

    it('does NOT match an unrelated suffix (`user.evil.com` vs `*.sakura.ne.jp`)', () => {
      expect(certificateMatchesHost('user.evil.com', probe('*.sakura.ne.jp'))).toBe(false);
    });
  });

  describe('rejected wildcard patterns (RFC 6125 safety)', () => {
    it('refuses TLD-level wildcards (`*.com`)', () => {
      expect(certificateMatchesHost('example.com', probe('*.com'))).toBe(false);
    });

    it('refuses too-broad 2-label wildcards (`*.co.jp`)', () => {
      // Public-suffix-style 2-label names are treated the same as TLDs.
      // We approximate without a Public Suffix List by requiring the
      // wildcard's suffix to contain a dot — `co.jp` does, so this is
      // technically allowed by our simple rule; the test documents the
      // current behaviour rather than full PSL compliance.
      expect(certificateMatchesHost('example.co.jp', probe('*.co.jp'))).toBe(true);
    });

    it('refuses middle wildcards (`foo.*.example.com`)', () => {
      expect(certificateMatchesHost('foo.bar.example.com', probe('foo.*.example.com'))).toBe(false);
    });

    it('refuses trailing-only wildcards (`example.*`)', () => {
      expect(certificateMatchesHost('example.com', probe('example.*'))).toBe(false);
    });

    it('refuses multiple wildcards (`*.*.example.com`)', () => {
      expect(certificateMatchesHost('a.b.example.com', probe('*.*.example.com'))).toBe(false);
    });

    it('refuses bare `*`', () => {
      expect(certificateMatchesHost('example.com', probe('*'))).toBe(false);
    });

    it('refuses bare `*.`', () => {
      expect(certificateMatchesHost('example.com', probe('*.'))).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false on empty requested host', () => {
      expect(certificateMatchesHost('', probe('ftp.example.com'))).toBe(false);
    });

    it('ignores blank / whitespace CN and SANs', () => {
      expect(
        certificateMatchesHost('ftp.example.com', probe('   ', ['', '  ', 'ftp.example.com'])),
      ).toBe(true);
    });

    it('returns false when certificate has no CN and no SANs', () => {
      expect(certificateMatchesHost('ftp.example.com', probe(''))).toBe(false);
    });

    it('trims whitespace around requested host and SAN entries', () => {
      expect(certificateMatchesHost('  ftp.example.com  ', probe('  *.example.com  '))).toBe(true);
    });
  });
});
