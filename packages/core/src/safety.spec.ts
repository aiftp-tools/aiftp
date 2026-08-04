import { describe, expect, it } from 'vitest';
import { isProdProfile, requiresProductionConfirmation } from './safety.js';

describe('isProdProfile', () => {
  const defaultPatterns = ['prod*', 'production*', 'main*'];

  it('matches profile names that start with any pattern', () => {
    expect(isProdProfile({ profileName: 'production', patterns: defaultPatterns })).toBe(true);
    expect(isProdProfile({ profileName: 'prod', patterns: defaultPatterns })).toBe(true);
    expect(isProdProfile({ profileName: 'prod-us', patterns: defaultPatterns })).toBe(true);
    expect(isProdProfile({ profileName: 'main-deploy', patterns: defaultPatterns })).toBe(true);
  });

  it('does NOT match profile names that contain but do not start with the pattern', () => {
    // `not-production` must NOT count as prod (anchored match).
    expect(isProdProfile({ profileName: 'not-production', patterns: defaultPatterns })).toBe(false);
    expect(isProdProfile({ profileName: 'pre-prod', patterns: defaultPatterns })).toBe(false);
  });

  it('does not treat non-prod names as prod', () => {
    expect(isProdProfile({ profileName: 'staging', patterns: defaultPatterns })).toBe(false);
    expect(isProdProfile({ profileName: 'dev', patterns: defaultPatterns })).toBe(false);
    expect(isProdProfile({ profileName: 'local', patterns: defaultPatterns })).toBe(false);
  });

  it('short-circuits when warnEnabled is false (user opt-out via safety.warn_on_prod_profile)', () => {
    expect(
      isProdProfile({
        profileName: 'production',
        patterns: defaultPatterns,
        warnEnabled: false,
      }),
    ).toBe(false);
  });

  it('honors custom patterns from the user', () => {
    expect(isProdProfile({ profileName: 'gwco-live', patterns: ['*-live'] })).toBe(true);
    expect(isProdProfile({ profileName: 'gwco-dev', patterns: ['*-live'] })).toBe(false);
  });

  it('returns false for an empty patterns list', () => {
    expect(isProdProfile({ profileName: 'production', patterns: [] })).toBe(false);
  });

  it('escapes regex metacharacters in patterns so they match literally', () => {
    // A pattern like `prod.us` should match `prod.us` literally, not
    // `prodXus`. (Defense against accidental regex interpretation.)
    expect(isProdProfile({ profileName: 'prod.us', patterns: ['prod.us'] })).toBe(true);
    expect(isProdProfile({ profileName: 'prodXus', patterns: ['prod.us'] })).toBe(false);
  });
});

describe('requiresProductionConfirmation', () => {
  const defaultPatterns = ['prod*', 'production*', 'main*'];

  it('always requires confirmation in Desktop mode, whatever safety.* says', () => {
    // `.aiftp.toml` is a project file the AI itself can edit, so
    // `safety.warn_on_prod_profile = false` / `prod_profile_patterns = []`
    // must not be able to switch the Desktop gate off.
    expect(
      requiresProductionConfirmation({
        profileName: 'production',
        patterns: defaultPatterns,
        warnEnabled: false,
        desktopMode: true,
      }),
    ).toBe(true);
    expect(
      requiresProductionConfirmation({
        profileName: 'production',
        patterns: [],
        desktopMode: true,
      }),
    ).toBe(true);
    // Even a profile name that matches nothing at all.
    expect(
      requiresProductionConfirmation({
        profileName: 'staging',
        patterns: defaultPatterns,
        desktopMode: true,
      }),
    ).toBe(true);
  });

  it('falls back to the safety.* classification outside Desktop mode', () => {
    expect(
      requiresProductionConfirmation({
        profileName: 'production',
        patterns: defaultPatterns,
        desktopMode: false,
      }),
    ).toBe(true);
    expect(
      requiresProductionConfirmation({
        profileName: 'staging',
        patterns: defaultPatterns,
        desktopMode: false,
      }),
    ).toBe(false);
    // The CI escape hatch stays functional on the terminal.
    expect(
      requiresProductionConfirmation({
        profileName: 'production',
        patterns: defaultPatterns,
        warnEnabled: false,
        desktopMode: false,
      }),
    ).toBe(false);
    expect(
      requiresProductionConfirmation({
        profileName: 'production',
        patterns: [],
        desktopMode: false,
      }),
    ).toBe(false);
  });

  it('lets safety.* widen the gate outside Desktop mode', () => {
    expect(
      requiresProductionConfirmation({
        profileName: 'gwco-live',
        patterns: ['*-live'],
        desktopMode: false,
      }),
    ).toBe(true);
  });
});
