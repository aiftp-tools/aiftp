import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

// I/O/0/1 are omitted so a trainee reading the challenge off the screen and
// typing it into chat cannot confuse them.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHALLENGE_LENGTH = 6;

export function generateChallenge(): string {
  let out = '';
  for (let i = 0; i < CHALLENGE_LENGTH; i += 1) {
    out += ALPHABET.charAt(randomInt(ALPHABET.length));
  }
  return out;
}

function normalize(raw: string): string {
  const trimmed = raw.trim();
  const separator = trimmed.search(/\s/u);
  if (separator < 0) return `${trimmed}\n`;
  return `${trimmed.slice(0, separator)}\n${trimmed.slice(separator + 1).trim()}`;
}

export function hashConfirmation(challenge: string, phrase: string): string {
  return createHash('sha256').update(`${challenge}\n${phrase}`, 'utf8').digest('hex');
}

export function verifyConfirmation(raw: string, expectedHash: string): boolean {
  const actual = createHash('sha256').update(normalize(raw), 'utf8').digest('hex');
  // Both operands are fixed-length sha256 digests, so timingSafeEqual never throws.
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'));
}
