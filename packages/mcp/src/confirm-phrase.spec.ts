import { describe, expect, it } from 'vitest';
import { generateChallenge, hashConfirmation, verifyConfirmation } from './confirm-phrase.js';

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

describe('verifyConfirmation', () => {
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
