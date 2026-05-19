import { describe, expect, it } from 'vitest';
import type { FtpsProbeResult } from './doctor.js';
import type { FtpProbeClient } from './ftp-probe.js';
import { isPrivateIp, parsePasvReply, probeFtps } from './ftp-probe.js';

describe('parsePasvReply', () => {
  it('extracts the four-octet IP from a standard 227 reply', () => {
    expect(parsePasvReply('227 Entering Passive Mode (192,168,1,5,234,5).')).toBe('192.168.1.5');
    expect(parsePasvReply('227 PASV mode (203,0,113,42,150,200)')).toBe('203.0.113.42');
  });

  it('returns null when no IP tuple is present', () => {
    expect(parsePasvReply('227 PASV ok')).toBeNull();
    expect(parsePasvReply('500 Command not understood')).toBeNull();
    expect(parsePasvReply('')).toBeNull();
  });
});

describe('isPrivateIp', () => {
  it('returns true for RFC1918 ranges', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('10.255.255.254')).toBe(true);
    expect(isPrivateIp('172.16.0.5')).toBe(true);
    expect(isPrivateIp('172.31.255.254')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });

  it('returns true for loopback and link-local', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.1.1')).toBe(true);
  });

  it('returns false for routable IPs', () => {
    expect(isPrivateIp('203.0.113.5')).toBe(false);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('172.32.0.1')).toBe(false); // outside 172.16/12
  });

  it('returns false for malformed input', () => {
    expect(isPrivateIp('')).toBe(false);
    expect(isPrivateIp('not-an-ip')).toBe(false);
    expect(isPrivateIp('999.999.999.999')).toBe(false);
  });
});

describe('probeFtps (with stubbed FtpProbeClient)', () => {
  function makeClient(overrides: Partial<FtpProbeClient> = {}): FtpProbeClient {
    return {
      getPeerCertificate: () => ({
        subject: { CN: 'ftp.example.com' },
        subjectaltname: 'DNS:ftp.example.com',
      }),
      getFeatures: async () =>
        new Map([
          ['MLSD', ''],
          ['SIZE', ''],
        ]),
      sendRaw: async (_cmd: string) => ({
        code: 227,
        message: '227 Entering Passive Mode (203,0,113,5,234,5).',
      }),
      cd: async (_path: string) => undefined,
      ...overrides,
    };
  }

  it('reports handshakeOk + cert fields when the connection holds TLS info', async () => {
    const result: FtpsProbeResult = await probeFtps({
      client: makeClient(),
      requestedHost: 'ftp.example.com',
      remoteRoot: '/public_html',
    });
    expect(result.handshakeOk).toBe(true);
    expect(result.certCommonName).toBe('ftp.example.com');
    expect(result.certAltNames).toEqual(['ftp.example.com']);
  });

  it('flags PASV leak when the 227 reply IP is private', async () => {
    const result = await probeFtps({
      client: makeClient({
        sendRaw: async () => ({
          code: 227,
          message: '227 Entering Passive Mode (192,168,1,5,234,5).',
        }),
      }),
      requestedHost: 'ftp.example.com',
      remoteRoot: '/public_html',
    });
    expect(result.pasvAddressLeak).toBe('192.168.1.5');
  });

  it('reports pasvAddressLeak = null for a routable PASV reply', async () => {
    const result = await probeFtps({
      client: makeClient(),
      requestedHost: 'ftp.example.com',
      remoteRoot: '/public_html',
    });
    expect(result.pasvAddressLeak).toBeNull();
  });

  it('detects MLSD and SIZE support from the FEAT response', async () => {
    const result = await probeFtps({
      client: makeClient(),
      requestedHost: 'ftp.example.com',
      remoteRoot: '/public_html',
    });
    expect(result.mlsdSupported).toBe(true);
    expect(result.sizeSupported).toBe(true);
  });

  it('reports MLSD=false / SIZE=false when FEAT does not include them', async () => {
    const result = await probeFtps({
      client: makeClient({
        getFeatures: async () => new Map(),
      }),
      requestedHost: 'ftp.example.com',
      remoteRoot: '/public_html',
    });
    expect(result.mlsdSupported).toBe(false);
    expect(result.sizeSupported).toBe(false);
  });

  it('reports remoteRootCwdOk = false when cd throws', async () => {
    const result = await probeFtps({
      client: makeClient({
        cd: async () => {
          throw new Error('550 Not found');
        },
      }),
      requestedHost: 'ftp.example.com',
      remoteRoot: '/does-not-exist',
    });
    expect(result.remoteRootCwdOk).toBe(false);
  });

  it('reports cert as undefined when the client has no TLS (plain FTP)', async () => {
    const result = await probeFtps({
      client: makeClient({
        getPeerCertificate: () => null,
      }),
      requestedHost: 'ftp.example.com',
      remoteRoot: '/public_html',
    });
    expect(result.handshakeOk).toBe(true);
    expect(result.certCommonName).toBeUndefined();
    expect(result.certAltNames).toBeUndefined();
  });
});
