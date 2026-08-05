import { randomInt } from 'node:crypto';
import { isUsableConfirmPhrase } from '@aiftp-tools/mcp';
import type { Command } from 'commander';

/**
 * Alphabet the generated phrase is drawn from: 32 upper-case symbols with
 * I, O, 0 and 1 removed, so an instructor reading the phrase out of a
 * password manager cannot confuse two characters. 32 is also a power of two,
 * which is what makes the entropy arithmetic below exact rather than
 * approximate.
 */
export const CONFIRM_PHRASE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Characters per hyphen-separated group. Grouping is for the human eye. */
export const CONFIRM_PHRASE_GROUP_LENGTH = 6;

/** Number of groups. */
export const CONFIRM_PHRASE_GROUP_COUNT = 5;

/**
 * Entropy of a generated phrase, in bits.
 *
 * Each of the 5 * 6 = 30 characters is drawn independently and uniformly
 * from a 32-symbol alphabet by `randomInt` (CSPRNG-backed, and rejection-
 * sampled internally so there is no modulo bias), so the entropy is exactly
 *
 *     30 * log2(32) = 30 * 5 = 150 bits
 *
 * The hyphens are at fixed positions and contribute nothing. 150 clears the
 * 128-bit floor with room to spare; the margin is what pays for the one
 * conditioning below.
 *
 * That conditioning: outputs with fewer than 4 distinct characters are
 * redrawn, so that a generated phrase always satisfies the gate's own
 * predicate. The redrawn set has probability at most
 * C(32,3) * (3/32)^30 ≈ 7e-28 (below 2^-90), so the entropy it removes is
 * far below one part in 10^25 of a bit — immaterial to the 150 claimed here,
 * and to the 128 promised in the docs.
 */
export const CONFIRM_PHRASE_ENTROPY_BITS = 150;

function drawGroup(): string {
  let group = '';
  for (let i = 0; i < CONFIRM_PHRASE_GROUP_LENGTH; i += 1) {
    group += CONFIRM_PHRASE_ALPHABET.charAt(randomInt(CONFIRM_PHRASE_ALPHABET.length));
  }
  return group;
}

/**
 * Generate a confirm phrase with at least 128 bits of entropy (see
 * CONFIRM_PHRASE_ENTROPY_BITS for the arithmetic).
 *
 * The result is validated against `isUsableConfirmPhrase` — the MCP gate's
 * own predicate, not a copy of the rule — and redrawn if it somehow fails.
 * A generator whose output the gate then refuses would be worse than no
 * generator, and this makes that outcome structurally impossible rather than
 * merely improbable.
 */
export function generateConfirmPhrase(): string {
  for (;;) {
    const phrase = Array.from({ length: CONFIRM_PHRASE_GROUP_COUNT }, drawGroup).join('-');
    if (isUsableConfirmPhrase(phrase)) return phrase;
  }
}

export interface ConfirmPhraseCommandDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/**
 * Register `aiftp confirm-phrase generate`.
 *
 * Deliberately CLI-only. There is no MCP tool, prompt or resource for this:
 * a phrase that passed through the MCP server would land in the model's
 * context before the human ever used it, which defeats the gate it exists to
 * arm. The phrase goes to stdout alone so it can be piped or double-clicked;
 * everything a human needs to read goes to stderr, so the two never have to
 * be untangled from one stream.
 */
export function registerConfirmPhraseCommand(
  program: Command,
  deps: ConfirmPhraseCommandDeps,
): void {
  const confirmPhrase = program
    .command('confirm-phrase')
    .description('Manage the production confirm phrase used by the MCP push gate');

  confirmPhrase
    .command('generate')
    .description('Generate a strong confirm phrase and print it to stdout')
    .action(() => {
      const phrase = generateConfirmPhrase();
      deps.stdout(phrase);
      deps.stderr('');
      deps.stderr(
        `Generated a confirm phrase with ${CONFIRM_PHRASE_ENTROPY_BITS} bits of entropy (printed above, on stdout).`,
      );
      deps.stderr(
        'Paste it into the Claude Desktop aiftp extension settings, in the "合言葉" (confirm phrase) field, or set it as AIFTP_CONFIRM_PHRASE for a terminal MCP server. Restart the server afterwards.',
      );
      deps.stderr(
        'Keep it: you type it once per production push, after the AI shows you a challenge code.',
      );
      deps.stderr(
        'Do not show it on slides or on a shared screen, do not paste it into a chat window except to approve a push, and do not reuse your FTP password for it.',
      );
    });
}
