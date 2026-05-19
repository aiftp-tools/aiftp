import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_STATE_FILE,
  loadDefaultProfile,
  resolveDefaultProfile,
  saveDefaultProfile,
} from './default-profile.js';

describe('default-profile: filename', () => {
  it('uses an underscore-prefixed filename to avoid collision with any user profile path', () => {
    // _default-profile.json sits next to .aiftp/state/<profile>/state.json
    // The leading underscore guarantees a real profile literally named
    // "default-profile" would not clash, since profile names are validated
    // to start with [a-z0-9] (see config-edit.isValidProfileName).
    expect(DEFAULT_PROFILE_STATE_FILE).toBe('_default-profile.json');
  });
});

describe('saveDefaultProfile / loadDefaultProfile', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = join(tmpdir(), `aiftp-default-profile-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('round-trips a profile name through .aiftp/state/_default-profile.json', async () => {
    await saveDefaultProfile(cwd, 'production');
    expect(await loadDefaultProfile(cwd)).toBe('production');
  });

  it('returns null when the state file does not exist', async () => {
    expect(await loadDefaultProfile(cwd)).toBeNull();
  });

  it('returns null when the state file is corrupted JSON (does not throw)', async () => {
    await mkdir(join(cwd, '.aiftp', 'state'), { recursive: true });
    await writeFile(join(cwd, '.aiftp', 'state', '_default-profile.json'), 'not-json{', 'utf8');
    expect(await loadDefaultProfile(cwd)).toBeNull();
  });

  it('returns null when the state file has the wrong shape', async () => {
    await mkdir(join(cwd, '.aiftp', 'state'), { recursive: true });
    await writeFile(
      join(cwd, '.aiftp', 'state', '_default-profile.json'),
      JSON.stringify({ schema: 1 }), // missing `name`
      'utf8',
    );
    expect(await loadDefaultProfile(cwd)).toBeNull();
  });

  it('overwrites an existing default profile', async () => {
    await saveDefaultProfile(cwd, 'production');
    await saveDefaultProfile(cwd, 'staging');
    expect(await loadDefaultProfile(cwd)).toBe('staging');
  });
});

describe('resolveDefaultProfile', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = join(tmpdir(), `aiftp-resolve-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: env var must be truly unset
    delete (process.env as Record<string, string | undefined>).AIFTP_PROFILE;
  });

  it('AIFTP_PROFILE env wins over everything', async () => {
    await saveDefaultProfile(cwd, 'production');
    process.env.AIFTP_PROFILE = 'override';
    const result = await resolveDefaultProfile(cwd, {
      availableProfiles: ['production', 'override'],
    });
    expect(result).toBe('override');
  });

  it('state file wins when env is unset', async () => {
    await saveDefaultProfile(cwd, 'staging');
    const result = await resolveDefaultProfile(cwd, {
      availableProfiles: ['production', 'staging'],
    });
    expect(result).toBe('staging');
  });

  it('falls back to the only profile when neither env nor state is set', async () => {
    const result = await resolveDefaultProfile(cwd, {
      availableProfiles: ['only-one'],
    });
    expect(result).toBe('only-one');
  });

  it('returns null when no env, no state, and multiple profiles exist (ambiguous)', async () => {
    const result = await resolveDefaultProfile(cwd, {
      availableProfiles: ['production', 'staging', 'demo'],
    });
    expect(result).toBeNull();
  });

  it('returns null when availableProfiles is empty', async () => {
    const result = await resolveDefaultProfile(cwd, {
      availableProfiles: [],
    });
    expect(result).toBeNull();
  });

  it('returns null when env / state name is not in availableProfiles', async () => {
    // This guards against stale state pointing at a deleted profile.
    process.env.AIFTP_PROFILE = 'deleted-profile';
    expect(await resolveDefaultProfile(cwd, { availableProfiles: ['production'] })).toBeNull();

    // biome-ignore lint/performance/noDelete: env var must be truly unset
    delete (process.env as Record<string, string | undefined>).AIFTP_PROFILE;
    await saveDefaultProfile(cwd, 'also-deleted');
    expect(await resolveDefaultProfile(cwd, { availableProfiles: ['production'] })).toBeNull();
  });
});
