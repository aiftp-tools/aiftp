import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENCRYPTED_FILE_HEADER_BYTES,
  ENCRYPTED_FILE_MAGIC,
  EncryptionError,
  decryptBuffer,
  decryptFile,
  encryptBuffer,
  encryptFile,
  generateKey,
} from './encryption.js';

describe('encryption', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `aiftp-encryption-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('generates 256-bit AES keys', () => {
    const key = generateKey();

    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key).toHaveLength(32);
  });

  it('encrypts and decrypts buffers with the specified file format', () => {
    const key = generateKey();
    const encrypted = encryptBuffer(Buffer.from('hello encrypted world', 'utf8'), key);

    expect(encrypted.subarray(0, 8)).toEqual(Buffer.from(ENCRYPTED_FILE_MAGIC));
    expect(encrypted.subarray(8, 24).toString('ascii').replace(/\0+$/u, '')).toBe('AES-256-GCM');
    expect(encrypted).toHaveLength(ENCRYPTED_FILE_HEADER_BYTES + 21 + 16);
    expect(decryptBuffer(encrypted, key).toString('utf8')).toBe('hello encrypted world');
  });

  it('uses a fresh nonce for each encryption operation', () => {
    const key = generateKey();
    const payload = Buffer.from('same payload', 'utf8');

    const first = encryptBuffer(payload, key);
    const second = encryptBuffer(payload, key);

    expect(first.subarray(24, 36)).not.toEqual(second.subarray(24, 36));
    expect(first).not.toEqual(second);
    expect(decryptBuffer(first, key)).toEqual(payload);
    expect(decryptBuffer(second, key)).toEqual(payload);
  });

  it('detects encrypted payload tampering', () => {
    const key = generateKey();
    const encrypted = Buffer.from(encryptBuffer(Buffer.from('do not tamper', 'utf8'), key));
    encrypted[ENCRYPTED_FILE_HEADER_BYTES] ^= 0xff;

    expect(() => decryptBuffer(encrypted, key)).toThrow(EncryptionError);
  });

  it('fails decryption with a different key', () => {
    const encrypted = encryptBuffer(Buffer.from('secret', 'utf8'), generateKey());

    expect(() => decryptBuffer(encrypted, generateKey())).toThrow(EncryptionError);
  });

  it('round-trips files without loading the whole file into the API surface', async () => {
    const key = generateKey();
    const sourcePath = join(tempDir, 'source.bin');
    const encryptedPath = join(tempDir, 'source.bin.enc');
    const decryptedPath = join(tempDir, 'source.restored.bin');
    const source = randomBytes(256 * 1024);
    await writeFile(sourcePath, source);

    await encryptFile(sourcePath, encryptedPath, key);
    await decryptFile(encryptedPath, decryptedPath, key);

    await expect(readFile(decryptedPath)).resolves.toEqual(source);
    const encrypted = await readFile(encryptedPath);
    expect(encrypted.subarray(0, 8)).toEqual(Buffer.from(ENCRYPTED_FILE_MAGIC));
    expect(encrypted).toHaveLength(ENCRYPTED_FILE_HEADER_BYTES + source.length + 16);
  });

  it('rejects invalid key lengths', () => {
    expect(() => encryptBuffer(Buffer.from('payload'), randomBytes(31))).toThrow(EncryptionError);
    expect(() => decryptBuffer(Buffer.alloc(0), randomBytes(33))).toThrow(EncryptionError);
  });

  it('rejects empty buffer for decryption (v0.10.3 branch coverage)', () => {
    expect(() => decryptBuffer(Buffer.alloc(0), generateKey())).toThrow(/too short|magic/i);
  });

  it('rejects payload too short for auth tag (v0.10.3 branch coverage)', () => {
    const key = generateKey();
    const AUTH_TAG_BYTES_LOCAL = 16;
    const tooShort = Buffer.alloc(ENCRYPTED_FILE_HEADER_BYTES + AUTH_TAG_BYTES_LOCAL - 1);
    expect(() => decryptBuffer(tooShort, key)).toThrow(EncryptionError);
  });

  it('rejects payload with invalid magic header (v0.10.3 branch coverage)', () => {
    const key = generateKey();
    const encrypted = encryptBuffer(Buffer.from('data'), key);
    const tampered = Buffer.from(encrypted);
    tampered.write('BADMAGIC', 0);
    expect(() => decryptBuffer(tampered, key)).toThrow(/magic/i);
  });

  it('rejects payload with unsupported algorithm label (v0.10.3 branch coverage)', () => {
    const key = generateKey();
    const encrypted = encryptBuffer(Buffer.from('data'), key);
    const tampered = Buffer.from(encrypted);
    // Algorithm field starts after MAGIC (8B) + NONCE (12B)
    tampered.write('AES-128-CBC\0\0\0\0\0', 20, 'ascii');
    expect(() => decryptBuffer(tampered, key)).toThrow(/algorithm/i);
  });

  it('wraps crypto errors when auth tag is corrupted (v0.10.3 branch coverage)', () => {
    const key = generateKey();
    const encrypted = encryptBuffer(Buffer.from('payload'), key);
    const tampered = Buffer.from(encrypted);
    const lastIndex = tampered.length - 1;
    const lastByte = tampered[lastIndex] ?? 0;
    tampered[lastIndex] = lastByte ^ 0xff;
    expect(() => decryptBuffer(tampered, key)).toThrow(EncryptionError);
  });

  it('rejects encrypted file shorter than header+tag (v0.10.3 branch coverage)', async () => {
    const key = generateKey();
    const tooShortPath = join(tempDir, 'too-short.enc');
    await writeFile(tooShortPath, Buffer.alloc(8));
    await expect(decryptFile(tooShortPath, join(tempDir, 'out'), key)).rejects.toThrow(
      /too short/i,
    );
  });
});
