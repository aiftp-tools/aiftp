import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SiteRegistry,
  SiteRegistryDuplicateError,
  SiteRegistryValidationError,
} from './registry.js';
import type { SiteEntry } from './types.js';

const FIRST_SITE: SiteEntry = {
  name: 'gwco',
  path: '/projects/gwco',
  label: 'glocalworks.co.jp',
  default_profile: 'production',
};

describe('SiteRegistry', () => {
  let temporaryHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    temporaryHome = await mkdtemp(join(tmpdir(), 'aiftp-sites-home-'));
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, 'HOME');
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      Reflect.deleteProperty(process.env, 'USERPROFILE');
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await rm(temporaryHome, { recursive: true, force: true });
  });

  it('returns an empty result when the registry file does not exist', async () => {
    const registry = new SiteRegistry();

    await expect(registry.read()).resolves.toEqual({ entries: [] });
    await expect(registry.list()).resolves.toEqual([]);
  });

  it('supports an add, list, and remove round trip', async () => {
    const registry = new SiteRegistry();

    await registry.add(FIRST_SITE);
    expect(await registry.list()).toEqual([FIRST_SITE]);

    await registry.remove(FIRST_SITE.name);
    expect(await registry.list()).toEqual([]);
  });

  it('rejects a duplicate site name with an explicit error', async () => {
    const registry = new SiteRegistry();
    await registry.add(FIRST_SITE);

    await expect(
      registry.add({ name: FIRST_SITE.name, path: '/projects/other' }),
    ).rejects.toBeInstanceOf(SiteRegistryDuplicateError);
    await expect(registry.add({ name: FIRST_SITE.name, path: '/projects/other' })).rejects.toThrow(
      "Site 'gwco' is already registered",
    );
  });

  it('renames an entry in place, keeping path/label/default_profile untouched', async () => {
    const registry = new SiteRegistry();
    await registry.add(FIRST_SITE);

    const next = await registry.rename('gwco', 'gwco-corrected');

    expect(next).toEqual([{ ...FIRST_SITE, name: 'gwco-corrected' }]);
    expect(await registry.list()).toEqual([{ ...FIRST_SITE, name: 'gwco-corrected' }]);
  });

  it('leaves other entries untouched when renaming one of several', async () => {
    const registry = new SiteRegistry();
    await registry.add(FIRST_SITE);
    await registry.add({ name: 'other-site', path: '/projects/other' });

    await registry.rename('gwco', 'gwco-corrected');

    const names = (await registry.list()).map((entry) => entry.name).sort();
    expect(names).toEqual(['gwco-corrected', 'other-site']);
  });

  it('rejects renaming a site that is not registered', async () => {
    const registry = new SiteRegistry();
    await expect(registry.rename('does-not-exist', 'new-name')).rejects.toThrow(
      "Cannot rename: site 'does-not-exist' is not registered",
    );
  });

  it('rejects renaming onto a name that is already taken by a different entry', async () => {
    const registry = new SiteRegistry();
    await registry.add(FIRST_SITE);
    await registry.add({ name: 'other-site', path: '/projects/other' });

    await expect(registry.rename('gwco', 'other-site')).rejects.toBeInstanceOf(
      SiteRegistryDuplicateError,
    );
    // Neither entry was touched by the failed rename.
    expect((await registry.list()).map((entry) => entry.name).sort()).toEqual([
      'gwco',
      'other-site',
    ]);
  });

  it('rejects an invalid new name without mutating the registry', async () => {
    const registry = new SiteRegistry();
    await registry.add(FIRST_SITE);

    await expect(registry.rename('gwco', '../escape')).rejects.toBeInstanceOf(
      SiteRegistryValidationError,
    );
    expect(await registry.list()).toEqual([FIRST_SITE]);
  });

  it('handles malformed TOML without throwing and preserves it from mutation', async () => {
    const registryDirectory = join(temporaryHome, '.aiftp');
    const registryPath = join(registryDirectory, 'sites.toml');
    const malformedSource = '[sites.gwco\npath = "unterminated';
    await mkdir(registryDirectory, { recursive: true });
    await writeFile(registryPath, malformedSource, 'utf8');
    const registry = new SiteRegistry();

    const result = await registry.read();

    expect(result.entries).toEqual([]);
    expect(result.warning).toMatch(/Failed to parse site registry/);
    await expect(registry.add(FIRST_SITE)).rejects.toThrow(/Refusing to overwrite/);
    expect(await readFile(registryPath, 'utf8')).toBe(malformedSource);
  });

  // v0.12.4 (LOW-1): a hand-edited registry could previously carry any
  // non-empty string as a site name or path. A path-shaped name shadows the
  // operator's intended `aiftp init --from <path>` argument (the registry
  // name match wins before filesystem resolution), redirecting inheritance
  // to a different config. Names are now an allowlist and paths must be
  // absolute and already normalized.
  it.each([
    ['a path traversal name', '../prod'],
    ['a slash-separated name', 'client/a'],
    ['a colon-separated name', 'gw:co'],
    ['a bare dot name', '.'],
  ])('rejects %s in a hand-edited registry', async (_label, siteName) => {
    const registryDirectory = join(temporaryHome, '.aiftp');
    await mkdir(registryDirectory, { recursive: true });
    await writeFile(
      join(registryDirectory, 'sites.toml'),
      ['schema_version = 1', '', `[sites."${siteName}"]`, 'path = "/projects/gwco"', ''].join('\n'),
      'utf8',
    );

    const result = await new SiteRegistry().read();

    expect(result.entries).toEqual([]);
    expect(result.warning).toMatch(/Failed to validate site registry/);
  });

  // The relative case and the absolute-but-traversing case fail for
  // different reasons, so both are covered. Note the path check is
  // separator-agnostic on purpose: `normalize()` rewrites `/projects/gwco`
  // to `\projects\gwco` on Windows, so an exact-match rule would reject
  // valid slash-written absolute paths there.
  it.each([
    ['a relative path', 'projects/gwco'],
    ['an absolute path with traversal segments', '/projects/../../etc/gwco'],
  ])('rejects %s in a hand-edited registry', async (_label, sitePath) => {
    const registryDirectory = join(temporaryHome, '.aiftp');
    await mkdir(registryDirectory, { recursive: true });
    await writeFile(
      join(registryDirectory, 'sites.toml'),
      ['schema_version = 1', '', '[sites.gwco]', `path = "${sitePath}"`, ''].join('\n'),
      'utf8',
    );

    const result = await new SiteRegistry().read();

    expect(result.entries).toEqual([]);
    expect(result.warning).toMatch(/Failed to validate site registry/);
  });

  it('writes atomically through a temporary file and leaves only the final registry', async () => {
    const registry = new SiteRegistry();
    const replacement: SiteEntry = { name: 'docs', path: '/projects/docs' };

    await registry.write([FIRST_SITE]);
    await registry.write([replacement]);

    const registryDirectory = join(temporaryHome, '.aiftp');
    expect(await readdir(registryDirectory)).toEqual(['sites.toml']);
    const source = await readFile(join(registryDirectory, 'sites.toml'), 'utf8');
    expect(source).toContain('schema_version = 1');
    expect(source).toContain('[sites.docs]');
    expect(source).not.toContain('[sites.gwco]');
    expect(await registry.list()).toEqual([replacement]);
  });

  it('rejects connection or secret fields instead of persisting them', async () => {
    const registry = new SiteRegistry();
    const unsafeEntry = {
      ...FIRST_SITE,
      host: 'ftp.example.com',
      user: 'deploy',
      password: 'secret',
      remote_root: '/public_html',
      keychain_service: 'aiftp:production',
    } as SiteEntry;

    await expect(registry.write([unsafeEntry])).rejects.toBeInstanceOf(SiteRegistryValidationError);
    await expect(readdir(join(temporaryHome, '.aiftp'))).rejects.toThrow();
  });
});
