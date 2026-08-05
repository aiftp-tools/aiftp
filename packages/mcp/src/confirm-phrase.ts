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

/**
 * Minimum length of a usable confirm phrase, counted in Unicode code points
 * (not UTF-16 units, so a Japanese phrase is measured the way a human reads
 * it).
 *
 * v0.13 Codex cross-review, H2. The challenge half of the pair is handed to
 * the caller, so the phrase is the ONLY secret; and while a mismatch spends
 * the plan, the AI can call `aiftp_push_prepare` again for a fresh challenge
 * and try the next candidate. There is deliberately no attempt budget — a
 * counter would hand a malicious AI a lockout it could trigger on purpose,
 * mid-lesson. Strength is the stateless alternative: raise the cost of the
 * search space instead of capping the attempts.
 *
 * 12 is the boundary because the guessable phrases this finding is about are
 * a course name plus a year — typically 8 to 11 characters — while every
 * phrase we tell instructors to use (a password-manager string, or a
 * several-word passphrase) clears it without thinking about it. It is an
 * honest floor, not a proof of strength: a long but predictable phrase still
 * passes, which is why the docs say to generate it rather than invent it.
 */
export const CONFIRM_PHRASE_MIN_LENGTH = 12;

/**
 * Distinct code points required, so `aaaaaaaaaaaa` and `abababababab` cannot
 * buy their way past the length floor. Four is low enough that no genuine
 * passphrase in any script comes close to failing it.
 */
export const CONFIRM_PHRASE_MIN_DISTINCT_CHARS = 4;

/**
 * Whether a configured phrase is strong enough to gate a production push.
 *
 * The single source of truth for "is this phrase usable?". The push gate in
 * `index.ts` and the `confirm_phrase` check in `setup-status.ts` both reach
 * this predicate — the gate through `resolveConfirmPhrase` below — so the
 * two can never disagree about a given value.
 *
 * Note what this does NOT decide: whether a phrase was supplied at all. That
 * is `resolveConfirmPhrase`'s job, and conflating the two is exactly the bug
 * this file used to have.
 */
export function isUsableConfirmPhrase(raw: string | undefined): raw is string {
  if (typeof raw !== 'string') return false;
  // Trimmed, because hashConfirmation() hashes the trimmed phrase: padding
  // must not buy length that the matcher later discards.
  const chars = [...raw.trim()];
  if (chars.length < CONFIRM_PHRASE_MIN_LENGTH) return false;
  return new Set(chars).size >= CONFIRM_PHRASE_MIN_DISTINCT_CHARS;
}

/**
 * The three states a confirm-phrase setting can be in.
 *
 * v0.13 Codex cross-review round 3, M1. Two states are not enough:
 *
 * - `absent`   — nothing was supplied. Every v0.12 npm user is here, so the
 *                terminal keeps its `acknowledge_production`-only behaviour
 *                byte for byte; Claude Desktop still fails closed.
 * - `rejected` — something WAS supplied and it is below the floor. The
 *                operator asked for a gate, so they get a gate or an error —
 *                never a silent downgrade to the `absent` path. Fail-closed
 *                everywhere, terminal included.
 * - `usable`   — passes `isUsableConfirmPhrase`; gates as designed.
 */
export type ConfirmPhraseResolution =
  | { readonly state: 'absent' }
  | { readonly state: 'rejected' }
  | { readonly state: 'usable'; readonly phrase: string };

/**
 * Classify a raw confirm-phrase setting into one of the three states above.
 *
 * Empty and whitespace-only count as `absent`, not `rejected`: Claude
 * Desktop writes `AIFTP_CONFIRM_PHRASE=""` for a settings field the operator
 * never touched, and an empty variable says the same thing as no variable.
 *
 * The usable phrase is returned verbatim, untrimmed — `hashConfirmation`
 * owns the trimming, and trimming in two places is how two places drift.
 */
export function resolveConfirmPhrase(raw: string | undefined): ConfirmPhraseResolution {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { state: 'absent' };
  if (!isUsableConfirmPhrase(raw)) return { state: 'rejected' };
  return { state: 'usable', phrase: raw };
}

/**
 * Operator-facing statement of the rule above, in Japanese. Shared by the
 * push-gate refusal and the `aiftp_setup_status` hint so the two cannot drift
 * apart. States the requirement and how to satisfy it; deliberately contains
 * no example phrase, since anything printed here would enter the model's
 * context (and could be pasted verbatim by a trainee) before the human ever
 * used it.
 */
export const CONFIRM_PHRASE_REQUIREMENT_JA = `合言葉は ${CONFIRM_PHRASE_MIN_LENGTH} 文字以上・${CONFIRM_PHRASE_MIN_DISTINCT_CHARS} 種類以上の文字が必要です。未設定の場合と短すぎる場合は同じ扱いで、本番反映は拒否されます。パスワード管理ツールで生成した20文字以上の文字列を推奨します（講座名や西暦のような推測しやすい文字列は避けてください）。`;

/**
 * The same rule in English, for the terminal / Claude Code path — where the
 * operator sets `AIFTP_CONFIRM_PHRASE` themselves. Built from the same two
 * constants as the Japanese text, so the published numbers cannot drift
 * between the two.
 *
 * Deliberately does NOT name the CLI generator, even though the docs make it
 * the recommended path. This string is an MCP surface: naming a runnable
 * command here invites the client to run it and read the phrase off its own
 * stdout, and a phrase the AI has seen does not gate the AI. The generator
 * is named where only humans read — the CLI's help, the Claude Desktop
 * settings field, the README and docs/.
 *
 * Contains no example phrase for the same reason: an example printed here is
 * the phrase people paste in.
 */
export const CONFIRM_PHRASE_REQUIREMENT_EN = `A confirm phrase must be at least ${CONFIRM_PHRASE_MIN_LENGTH} Unicode code points after trimming and contain at least ${CONFIRM_PHRASE_MIN_DISTINCT_CHARS} distinct code points; a password-manager string of 20 or more characters clears it comfortably. It must be generated rather than invented, and generated by the human operator rather than by an AI assistant — a phrase the assistant has seen cannot gate the assistant. See "Production confirm phrase" in the aiftp README. The floor is a floor, not proof of strength.`;

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
