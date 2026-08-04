import { describe, expect, it } from 'vitest';
import {
  CONFIRM_PHRASE_MIN_DISTINCT_CHARS,
  CONFIRM_PHRASE_MIN_LENGTH,
  generateChallenge,
  hashConfirmation,
  isUsableConfirmPhrase,
  verifyConfirmation,
} from './confirm-phrase.js';

describe('generateChallenge', () => {
  it('returns six characters from an unambiguous alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const challenge = generateChallenge();
      expect(challenge).toHaveLength(6);
      expect(challenge).toMatch(/^[A-HJ-NP-Z2-9]{6}$/u);
    }
  });

  it('does not repeat on consecutive calls', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateChallenge()));
    expect(seen.size).toBeGreaterThan(45);
  });
});

describe('isUsableConfirmPhrase', () => {
  it('publishes the rule it enforces', () => {
    expect(CONFIRM_PHRASE_MIN_LENGTH).toBe(12);
    expect(CONFIRM_PHRASE_MIN_DISTINCT_CHARS).toBe(4);
  });

  it('rejects an unset, empty or whitespace-only phrase', () => {
    expect(isUsableConfirmPhrase(undefined)).toBe(false);
    expect(isUsableConfirmPhrase('')).toBe(false);
    expect(isUsableConfirmPhrase('   \t \n ')).toBe(false);
  });

  it('rejects the course-name-plus-year shape the finding calls out', () => {
    // 11 code points -- exactly the kind of instructor-chosen token an
    // online dictionary attack works against.
    expect('sakura-2026'.length).toBe(11);
    expect(isUsableConfirmPhrase('sakura-2026')).toBe(false);
  });

  it('draws the length boundary at exactly CONFIRM_PHRASE_MIN_LENGTH', () => {
    expect(isUsableConfirmPhrase('abcdefghijk')).toBe(false); // 11
    expect(isUsableConfirmPhrase('abcdefghijkl')).toBe(true); // 12
  });

  it('measures the trimmed phrase, matching hashConfirmation', () => {
    // hashConfirmation() trims the stored phrase before hashing, so padding
    // must not buy length that the matcher will later throw away.
    expect(isUsableConfirmPhrase('     short      ')).toBe(false);
    expect(isUsableConfirmPhrase('  abcdefghijkl  ')).toBe(true);
  });

  it('accepts a long multi-word passphrase', () => {
    expect(isUsableConfirmPhrase('correct battery staple horse fence')).toBe(true);
  });

  it('accepts a Japanese phrase of at least the minimum length', () => {
    expect(isUsableConfirmPhrase('とうきょうのそらはあおい')).toBe(true);
    expect(isUsableConfirmPhrase('みじかいことば')).toBe(false);
  });

  it('counts code points, not UTF-16 code units', () => {
    // 11 astral code points = 22 UTF-16 units. A `.length >= 12` check
    // would wrongly accept this.
    const elevenAstral = '𝔞𝔟𝔠𝔡𝔢𝔣𝔤𝔥𝔦𝔧𝔨';
    expect(elevenAstral.length).toBe(22);
    expect(isUsableConfirmPhrase(elevenAstral)).toBe(false);
  });

  it('rejects a long run of too few distinct characters', () => {
    expect(isUsableConfirmPhrase('aaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(isUsableConfirmPhrase('abababababababab')).toBe(false);
    expect(isUsableConfirmPhrase('abcabcabcabcabc')).toBe(false); // 3 distinct
    expect(isUsableConfirmPhrase('abcdabcdabcdabcd')).toBe(true); // 4 distinct
  });
});

describe('verifyConfirmation', () => {
  // Deliberately still a weak phrase: the hash/compare layer is strength
  // agnostic by design. Strength is enforced once, where the phrase is
  // resolved (isUsableConfirmPhrase above), so a phrase that reaches
  // hashConfirmation has already passed.
  const hash = hashConfirmation('AB3K9P', 'sakura-2026');

  it('accepts the exact challenge + phrase pair', () => {
    expect(verifyConfirmation('AB3K9P sakura-2026', hash)).toBe(true);
  });

  it('tolerates surrounding and repeated whitespace', () => {
    expect(verifyConfirmation('  AB3K9P   sakura-2026  ', hash)).toBe(true);
  });

  it('rejects a wrong challenge with the right phrase', () => {
    expect(verifyConfirmation('ZZ9Y2Q sakura-2026', hash)).toBe(false);
  });

  it('rejects the right challenge with a wrong phrase', () => {
    expect(verifyConfirmation('AB3K9P momiji-2026', hash)).toBe(false);
  });

  it('rejects both wrong', () => {
    expect(verifyConfirmation('ZZ9Y2Q momiji-2026', hash)).toBe(false);
  });

  it('rejects the challenge alone', () => {
    expect(verifyConfirmation('AB3K9P', hash)).toBe(false);
  });

  it('rejects the phrase alone', () => {
    expect(verifyConfirmation('sakura-2026', hash)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(verifyConfirmation('', hash)).toBe(false);
  });

  it('is case-sensitive on the phrase', () => {
    expect(verifyConfirmation('AB3K9P SAKURA-2026', hash)).toBe(false);
  });

  it('is case-insensitive on the challenge, so a lowercase typo still matches', () => {
    expect(verifyConfirmation('ab3k9p sakura-2026', hash)).toBe(true);
    expect(verifyConfirmation('Ab3K9p sakura-2026', hash)).toBe(true);
  });

  it('keeps internal whitespace inside a multi-word phrase', () => {
    const multi = hashConfirmation('AB3K9P', 'sakura no ki');
    expect(verifyConfirmation('AB3K9P sakura no ki', multi)).toBe(true);
    expect(verifyConfirmation('AB3K9P sakura  no ki', multi)).toBe(false);
  });

  it('verifies against a stored phrase that has baked-in surrounding whitespace', () => {
    // A phrase saved via a Claude Desktop settings text field can easily
    // pick up a stray leading/trailing space. hashConfirmation() must trim
    // it the same way normalize() trims what the operator types, or no
    // input could ever match (reviewer finding, 2026-08-02).
    const hash = hashConfirmation('AB3K9P', ' sakura ');
    expect(verifyConfirmation('AB3K9P sakura', hash)).toBe(true);
  });

  it('rejects a malformed expectedHash without throwing', () => {
    expect(() => verifyConfirmation('AB3K9P sakura-2026', 'not-a-valid-hex-digest')).not.toThrow();
    expect(verifyConfirmation('AB3K9P sakura-2026', 'not-a-valid-hex-digest')).toBe(false);
    expect(verifyConfirmation('AB3K9P sakura-2026', '')).toBe(false);
  });
});
