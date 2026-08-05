import { randomUUID } from 'node:crypto';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findStagedTreeProblems, guardStagedTree } from './staged-tree-guard.js';

describe('staged tree guard', () => {
  let root: string;
  let buildRoot: string;

  beforeEach(async () => {
    root = join(tmpdir(), `aiftp-stage-${randomUUID()}`);
    buildRoot = join(tmpdir(), `aiftp-build-${randomUUID()}`);
    await mkdir(join(root, 'server'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function problems(): Promise<readonly string[]> {
    return findStagedTreeProblems(root, { forbiddenPaths: [buildRoot] });
  }

  it('passes a clean staged tree', async () => {
    await writeFile(join(root, 'manifest.json'), '{"name":"aiftp"}\n', 'utf8');
    await writeFile(
      join(root, 'server', 'package.json'),
      JSON.stringify({ name: 'aiftp-desktop-server', dependencies: {} }),
      'utf8',
    );
    await expect(problems()).resolves.toEqual([]);
    await expect(guardStagedTree(root, { forbiddenPaths: [buildRoot] })).resolves.toBeUndefined();
  });

  it('rejects a build path baked into a file even when it is not under the home directory', async () => {
    // The bug: the old guard only searched for os.homedir(), so a build in
    // a CI workspace or /private/tmp shipped its absolute paths silently.
    const leaked = join(buildRoot, 'packages', 'desktop-ext');
    await writeFile(
      join(root, 'server', 'config.gypi'),
      `{"module_root_dir": "${leaked}"}`,
      'utf8',
    );
    const found = await problems();
    expect(found.join('\n')).toMatch(/config\.gypi/);
    expect(found.join('\n')).toMatch(/build machine/i);
    await expect(guardStagedTree(root, { forbiddenPaths: [buildRoot] })).rejects.toThrow(
      /config\.gypi/,
    );
  });

  it('finds a build path that was JSON-escaped or slash-flipped on the way in', async () => {
    const escaped = join(buildRoot, 'x').split('\\').join('\\\\');
    await writeFile(join(root, 'server', 'meta.json'), `{"_where":"${escaped}"}`, 'utf8');
    expect((await problems()).join('\n')).toMatch(/meta\.json/);

    const flipped = join(buildRoot, 'y').split('\\').join('/');
    await writeFile(join(root, 'server', 'other.json'), `{"_where":"${flipped}"}`, 'utf8');
    expect((await problems()).join('\n')).toMatch(/other\.json/);
  });

  it('rejects a POSIX absolute path in a package.json value', async () => {
    await writeFile(
      join(root, 'server', 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { dep: 'file:/opt/build/dep.tgz' } }),
      'utf8',
    );
    expect((await problems()).join('\n')).toMatch(/absolute path/i);
  });

  it('rejects a Windows drive path in a package.json value', async () => {
    await writeFile(
      join(root, 'server', 'package.json'),
      JSON.stringify({ name: 'x', _where: 'C:\\Users\\builder\\aiftp' }),
      'utf8',
    );
    expect((await problems()).join('\n')).toMatch(/Windows drive path/i);
  });

  it('rejects a Windows UNC path in a package.json value', async () => {
    await writeFile(
      join(root, 'server', 'package.json'),
      JSON.stringify({ name: 'x', _resolved: '\\\\buildserver\\share\\dep.tgz' }),
      'utf8',
    );
    expect((await problems()).join('\n')).toMatch(/UNC path/i);
  });

  it('rejects a file: URL with an authority component', async () => {
    await writeFile(
      join(root, 'server', 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { dep: 'file://buildhost/dep.tgz' } }),
      'utf8',
    );
    expect((await problems()).join('\n')).toMatch(/file:/);
  });

  it('allows the bundle-relative file: specifiers the build deliberately writes', async () => {
    // build-mcpb.mjs writes tarball paths relative to stage/server on
    // purpose: a relative specifier cannot disclose the build machine's
    // layout, which is the whole point of this guard.
    await writeFile(
      join(root, 'server', 'package.json'),
      JSON.stringify({
        name: 'aiftp-desktop-server',
        dependencies: { '@aiftp-tools/core': 'file:../../tarballs/aiftp-tools-core-0.13.0.tgz' },
      }),
      'utf8',
    );
    await expect(problems()).resolves.toEqual([]);
  });

  it('rejects a native .node binary', async () => {
    await mkdir(join(root, 'server', 'node_modules'), { recursive: true });
    await writeFile(join(root, 'server', 'node_modules', 'cpufeatures.node'), 'binary', 'utf8');
    expect((await problems()).join('\n')).toMatch(/cpufeatures\.node/);
  });

  it('rejects a symlink with an absolute target instead of skipping it', async () => {
    // entry.isFile() is false for a symlink, so the old guard never looked
    // at one — a symlink could point anywhere on the build machine.
    await writeFile(join(root, 'server', 'real.js'), 'export {};\n', 'utf8');
    await symlink(join(buildRoot, 'secret.js'), join(root, 'server', 'link.js'));
    const found = (await problems()).join('\n');
    expect(found).toMatch(/link\.js/);
    expect(found).toMatch(/symlink/i);
    // The target is a build-machine path; it must not be echoed back.
    expect(found).not.toContain(buildRoot);
  });

  it('rejects a relative symlink whose target escapes the staged tree', async () => {
    await symlink(join('..', '..', '..', 'secret.js'), join(root, 'server', 'escape.js'));
    const found = (await problems()).join('\n');
    expect(found).toMatch(/escape\.js/);
    expect(found).toMatch(/outside the bundle/i);
  });

  it('allows the relative in-bundle symlinks npm creates in node_modules/.bin', async () => {
    // Proven against a real `pnpm build:mcpb` run: npm links
    // server/node_modules/.bin/aiftp -> ../@aiftp-tools/cli/dist/bin.js.
    // Those links are what make the installed CLI runnable, and they stay
    // inside the archive.
    await mkdir(join(root, 'server', 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(root, 'server', 'node_modules', 'cli'), { recursive: true });
    await writeFile(join(root, 'server', 'node_modules', 'cli', 'bin.js'), '#!/usr/bin/env node\n');
    await symlink(
      join('..', 'cli', 'bin.js'),
      join(root, 'server', 'node_modules', '.bin', 'aiftp'),
    );
    await expect(problems()).resolves.toEqual([]);
  });

  it('reports every offending file, not just the first', async () => {
    await writeFile(join(root, 'a.txt'), join(buildRoot, 'a'), 'utf8');
    await writeFile(join(root, 'b.txt'), join(buildRoot, 'b'), 'utf8');
    const found = (await problems()).join('\n');
    expect(found).toMatch(/a\.txt/);
    expect(found).toMatch(/b\.txt/);
  });
});
