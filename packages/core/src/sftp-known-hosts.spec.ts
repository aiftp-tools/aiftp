import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fingerprintHostKey,
  hostId,
  parseKnownHosts,
  serializeEntry,
  verifyHostKey,
} from './sftp-known-hosts.js';

describe('sftp-known-hosts', () => {
  let tempDir: string;
  let knownHostsPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aiftp-known-hosts-'));
    knownHostsPath = join(tempDir, '.aiftp', 'known_hosts');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('fingerprints host key bytes as sha256 hex', () => {
    expect(fingerprintHostKey(Buffer.from('server-key-a'))).toBe(
      'ff3cbeece9e239e74dcd2ba5e7bacbc12a64da76a5ede915b503a82c08edcef8',
    );
  });

  it('parses comments, blank lines, and host+port entries', () => {
    const parsed = parseKnownHosts(`
# aiftp known_hosts

sftp.example.com 22 abc123
sftp.example.com 2222 def456
`);

    expect(parsed.get(hostId('sftp.example.com', 22))).toBe('abc123');
    expect(parsed.get(hostId('sftp.example.com', 2222))).toBe('def456');
    expect(parsed.size).toBe(2);
  });

  it('serializes an entry in the on-disk format', () => {
    expect(serializeEntry('sftp.example.com', 22, 'abc123')).toBe('sftp.example.com 22 abc123');
    expect(hostId('sftp.example.com', 22)).toBe('sftp.example.com:22');
  });

  it('first connection pins the host key and creates private parent/file modes', async () => {
    const result = await verifyHostKey({
      knownHostsPath,
      host: 'sftp.example.com',
      port: 22,
      key: Buffer.from('server-key-a'),
    });

    expect(result).toEqual({
      outcome: 'pinned',
      fingerprint: fingerprintHostKey(Buffer.from('server-key-a')),
    });
    const source = await readFile(knownHostsPath, 'utf8');
    expect(source).toMatch(/^# aiftp known_hosts/m);
    expect(source).toContain(
      serializeEntry('sftp.example.com', 22, fingerprintHostKey(Buffer.from('server-key-a'))),
    );

    if (process.platform !== 'win32') {
      expect((await stat(join(tempDir, '.aiftp'))).mode & 0o777).toBe(0o700);
      expect((await stat(knownHostsPath)).mode & 0o777).toBe(0o600);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'repairs permissive modes on a pre-existing directory and known_hosts file',
    async () => {
      // v0.12.4 (LOW-2): mkdir/appendFile only apply `mode` when they CREATE
      // the entry. On machines upgraded from older versions -- or where the
      // state was hand-made -- ~/.aiftp could already be 0755 and known_hosts
      // 0644, and the pin path would silently leave them that way.
      await mkdir(join(tempDir, '.aiftp'), { recursive: true });
      await chmod(join(tempDir, '.aiftp'), 0o755);
      await writeFile(knownHostsPath, '# aiftp known_hosts\n', { encoding: 'utf8' });
      await chmod(knownHostsPath, 0o644);

      await verifyHostKey({
        knownHostsPath,
        host: 'sftp.example.com',
        port: 22,
        key: Buffer.from('server-key-a'),
      });

      expect((await stat(join(tempDir, '.aiftp'))).mode & 0o777).toBe(0o700);
      expect((await stat(knownHostsPath)).mode & 0o777).toBe(0o600);
    },
  );

  it('returns matched without rewriting when the fingerprint already exists', async () => {
    const first = await verifyHostKey({
      knownHostsPath,
      host: 'sftp.example.com',
      port: 22,
      key: Buffer.from('server-key-a'),
    });
    expect(first.outcome).toBe('pinned');
    const before = await readFile(knownHostsPath, 'utf8');

    const second = await verifyHostKey({
      knownHostsPath,
      host: 'sftp.example.com',
      port: 22,
      key: Buffer.from('server-key-a'),
    });

    expect(second).toEqual({
      outcome: 'matched',
      fingerprint: fingerprintHostKey(Buffer.from('server-key-a')),
      knownFingerprint: fingerprintHostKey(Buffer.from('server-key-a')),
    });
    expect(await readFile(knownHostsPath, 'utf8')).toBe(before);
  });

  it('detects a changed key and does not overwrite the existing pin', async () => {
    await verifyHostKey({
      knownHostsPath,
      host: 'sftp.example.com',
      port: 22,
      key: Buffer.from('server-key-a'),
    });
    const before = await readFile(knownHostsPath, 'utf8');

    const result = await verifyHostKey({
      knownHostsPath,
      host: 'sftp.example.com',
      port: 22,
      key: Buffer.from('server-key-b'),
    });

    expect(result).toEqual({
      outcome: 'mismatch',
      fingerprint: fingerprintHostKey(Buffer.from('server-key-b')),
      knownFingerprint: fingerprintHostKey(Buffer.from('server-key-a')),
    });
    expect(await readFile(knownHostsPath, 'utf8')).toBe(before);
  });

  it('treats the same host on a different port as a separate pin', async () => {
    const key = Buffer.from('server-key-a');
    await verifyHostKey({ knownHostsPath, host: 'sftp.example.com', port: 22, key });
    const result = await verifyHostKey({
      knownHostsPath,
      host: 'sftp.example.com',
      port: 2222,
      key,
    });

    expect(result.outcome).toBe('pinned');
    const parsed = parseKnownHosts(await readFile(knownHostsPath, 'utf8'));
    expect(parsed.get(hostId('sftp.example.com', 22))).toBe(fingerprintHostKey(key));
    expect(parsed.get(hostId('sftp.example.com', 2222))).toBe(fingerprintHostKey(key));
  });

  it('throws when the pin cannot be persisted', async () => {
    await writeFile(join(tempDir, '.aiftp'), 'not a directory', 'utf8');

    await expect(
      verifyHostKey({
        knownHostsPath,
        host: 'sftp.example.com',
        port: 22,
        key: Buffer.from('server-key-a'),
      }),
    ).rejects.toThrow();
  });
});
