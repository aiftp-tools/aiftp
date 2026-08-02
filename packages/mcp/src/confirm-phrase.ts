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
  // Trim the stored phrase the same way normalize() trims the operator's
  // typed phrase (leading/trailing only, internal whitespace preserved).
  // Without this, a phrase saved with a stray leading/trailing space (a
  // routine paste accident from a Claude Desktop settings text field)
  // could never be matched by anything a human types -- verifyConfirmation
  // would return false forever with no diagnostic pointing at the cause.
  return createHash('sha256').update(`${challenge}\n${phrase.trim()}`, 'utf8').digest('hex');
}

export function verifyConfirmation(raw: string, expectedHash: string): boolean {
  const actual = createHash('sha256').update(normalize(raw), 'utf8').digest('hex');
  const actualBuf = Buffer.from(actual, 'hex');
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  // actualBuf is always a 32-byte sha256 digest. expectedHash is normally
  // the same, but this function is exported with a bare `string` parameter,
  // so guard the length before timingSafeEqual (which throws on a length
  // mismatch) instead of relying on every caller to only ever pass a
  // well-formed 64-hex digest.
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}
