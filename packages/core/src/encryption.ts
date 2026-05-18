import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

const ALGORITHM = 'aes-256-gcm';
const ALGORITHM_LABEL = 'AES-256-GCM';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ALGORITHM_FIELD_BYTES = 16;
const RESERVED_BYTES = 28;

export const ENCRYPTED_FILE_MAGIC = 'AIFTP01\0';
export const ENCRYPTED_FILE_HEADER_BYTES =
  ENCRYPTED_FILE_MAGIC.length + ALGORITHM_FIELD_BYTES + NONCE_BYTES + RESERVED_BYTES;

export class EncryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EncryptionError';
  }
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new EncryptionError(`AES-256-GCM key must be exactly ${KEY_BYTES} bytes`);
  }
}

function buildHeader(nonce: Buffer): Buffer {
  if (nonce.length !== NONCE_BYTES) {
    throw new EncryptionError(`AES-256-GCM nonce must be exactly ${NONCE_BYTES} bytes`);
  }

  const header = Buffer.alloc(ENCRYPTED_FILE_HEADER_BYTES);
  header.write(ENCRYPTED_FILE_MAGIC, 0, 'ascii');
  header.write(ALGORITHM_LABEL, ENCRYPTED_FILE_MAGIC.length, 'ascii');
  nonce.copy(header, ENCRYPTED_FILE_MAGIC.length + ALGORITHM_FIELD_BYTES);
  return header;
}

function parseHeader(header: Buffer): Buffer {
  if (header.length !== ENCRYPTED_FILE_HEADER_BYTES) {
    throw new EncryptionError('Encrypted payload header is incomplete');
  }

  const magic = header.subarray(0, ENCRYPTED_FILE_MAGIC.length);
  if (!magic.equals(Buffer.from(ENCRYPTED_FILE_MAGIC, 'ascii'))) {
    throw new EncryptionError('Encrypted payload has an invalid magic header');
  }

  const algorithm = header
    .subarray(ENCRYPTED_FILE_MAGIC.length, ENCRYPTED_FILE_MAGIC.length + ALGORITHM_FIELD_BYTES)
    .toString('ascii')
    .replace(/\0+$/u, '');
  if (algorithm !== ALGORITHM_LABEL) {
    throw new EncryptionError(`Unsupported encryption algorithm: ${algorithm}`);
  }

  return header.subarray(
    ENCRYPTED_FILE_MAGIC.length + ALGORITHM_FIELD_BYTES,
    ENCRYPTED_FILE_MAGIC.length + ALGORITHM_FIELD_BYTES + NONCE_BYTES,
  );
}

function wrapCryptoError(message: string, error: unknown): EncryptionError {
  if (error instanceof EncryptionError) {
    return error;
  }
  return new EncryptionError(message, { cause: error });
}

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encryptBuffer(data: Buffer, key: Buffer): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([buildHeader(nonce), encrypted, tag]);
}

export function decryptBuffer(data: Buffer, key: Buffer): Buffer {
  assertKey(key);
  if (data.length < ENCRYPTED_FILE_HEADER_BYTES + AUTH_TAG_BYTES) {
    throw new EncryptionError('Encrypted payload is too short');
  }

  try {
    const header = data.subarray(0, ENCRYPTED_FILE_HEADER_BYTES);
    const nonce = parseHeader(header);
    const encrypted = data.subarray(ENCRYPTED_FILE_HEADER_BYTES, data.length - AUTH_TAG_BYTES);
    const tag = data.subarray(data.length - AUTH_TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (error: unknown) {
    throw wrapCryptoError('Failed to decrypt payload', error);
  }
}

async function endWithTag(output: NodeJS.WritableStream, tag: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.once('error', reject);
    output.end(tag, () => {
      output.off('error', reject);
      resolve();
    });
  });
}

export async function encryptFile(srcPath: string, destPath: string, key: Buffer): Promise<void> {
  assertKey(key);
  await mkdir(dirname(destPath), { recursive: true });

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const output = createWriteStream(destPath, { mode: 0o600 });
  output.write(buildHeader(nonce));

  try {
    await pipeline(createReadStream(srcPath), cipher, output, { end: false });
    await endWithTag(output, cipher.getAuthTag());
  } catch (error: unknown) {
    output.destroy();
    await unlink(destPath).catch(() => undefined);
    throw wrapCryptoError(`Failed to encrypt file: ${srcPath}`, error);
  }
}

export async function decryptFile(srcPath: string, destPath: string, key: Buffer): Promise<void> {
  assertKey(key);
  await mkdir(dirname(destPath), { recursive: true });

  const fileStat = await stat(srcPath);
  if (fileStat.size < ENCRYPTED_FILE_HEADER_BYTES + AUTH_TAG_BYTES) {
    throw new EncryptionError('Encrypted file is too short');
  }

  const handle = await open(srcPath, 'r');
  try {
    const header = Buffer.alloc(ENCRYPTED_FILE_HEADER_BYTES);
    const tag = Buffer.alloc(AUTH_TAG_BYTES);
    const headerRead = await handle.read(header, 0, header.length, 0);
    const tagRead = await handle.read(tag, 0, tag.length, fileStat.size - AUTH_TAG_BYTES);
    if (headerRead.bytesRead !== header.length || tagRead.bytesRead !== tag.length) {
      throw new EncryptionError('Encrypted file is truncated');
    }

    const nonce = parseHeader(header);
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);

    await pipeline(
      createReadStream(srcPath, {
        start: ENCRYPTED_FILE_HEADER_BYTES,
        end: fileStat.size - AUTH_TAG_BYTES - 1,
      }),
      decipher,
      createWriteStream(destPath, { mode: 0o600 }),
    );
  } catch (error: unknown) {
    await unlink(destPath).catch(() => undefined);
    throw wrapCryptoError(`Failed to decrypt file: ${srcPath}`, error);
  } finally {
    await handle.close();
  }
}
