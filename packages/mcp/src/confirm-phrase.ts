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
  // Only the challenge segment is upper-cased: it is a public, non-secret
  // code read off a screen (ALPHABET is upper-case-only), so a lowercase
  // typo should not cost a trainee a whole aiftp_push_prepare round-trip.
  // The phrase segment is left exactly as typed -- it is the secret half
  // of the pair and must stay case-sensitive.
  if (separator < 0) return `${trimmed.toUpperCase()}\n`;
  const challenge = trimmed.slice(0, separator).toUpperCase();
  const phrase = trimmed.slice(separator + 1).trim();
  return `${challenge}\n${phrase}`;
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
