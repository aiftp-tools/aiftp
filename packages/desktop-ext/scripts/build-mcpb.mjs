#!/usr/bin/env node
// Assemble the .mcpb bundle:
//   1. `pnpm pack` the three real runtime dependencies (core / mcp / cli) to
//      tarballs, then `npm install --omit=dev --ignore-scripts` them into
//      stage/server so a real node_modules tree exists.
//
//      We deliberately do NOT bundle with esbuild: ssh2 (used by the SFTP
//      client) has dynamic requires and an optional native dependency
//      (cpu-features) that bundlers break.
//
//      `--ignore-scripts` is load-bearing, not an optimization: without it,
//      npm runs node-gyp for ssh2's optional `sshcrypto` binding and for
//      `cpu-features`, which (a) compiles a macOS-only .node binary even
//      though the manifest targets both darwin and win32 — the wrong
//      artifact for Windows attendees — and (b) leaves node-gyp
//      Makefile/config.gypi/*.o.d files behind that bake in the build
//      machine's home directory and toolchain paths, which then ship inside
//      the .mcpb. Both packages are optional accelerators: ssh2 has a
//      pure-JS crypto fallback and cpu-features is optional, so skipping
//      their native builds costs SFTP crypto speed, not correctness — the
//      right trade for an audience of FTPS-mostly beginners on shared
//      hosting. `guardStagedTree` below re-checks this at build time so a
//      regression here fails the build instead of shipping silently.
//
//      We use the `pnpm pack` + `npm install` route instead of `pnpm deploy`:
//      in this environment `pnpm deploy --prod --legacy` produced a
//      self-referential symlink inside the deployed node_modules
//      (packages/desktop-ext nested inside its own .pnpm virtual store),
//      which made `mcpb pack` fail with `ENAMETOOLONG` while walking the
//      archive. `npm install` of plain tarballs has no such symlink, so it
//      sidesteps the bug entirely. package.json `overrides` pin every
//      `@aiftp-tools/*` package to its local tarball so npm never resolves
//      those names from the public registry (they are already published
//      there under overlapping version numbers).
//   2. Write manifest.json from the compiled buildManifest().
//   3. Guard the staged tree, then `mcpb pack`.

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../dist/manifest.js';

/**
 * Fails the build if the staged tree (what's about to be zipped into the
 * .mcpb) contains either:
 *   - a file whose contents reference the build machine's home directory
 *     (an absolute-path / identity leak into a file every attendee gets), or
 *   - a `*.node` native binary (platform-specific; the manifest declares
 *     both darwin and win32, so a binary built on this machine is wrong for
 *     the other platform).
 * This class of defect surfaced twice during Task 7 review without the test
 * suite ever catching it, so it gets its own build-time check rather than
 * relying on a human unzipping the artifact again next time.
 */
async function guardStagedTree(root) {
  const home = homedir();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const nativeBinaries = [];
  const leaks = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = join(entry.parentPath ?? entry.path, entry.name);
    if (filePath.endsWith('.node')) {
      nativeBinaries.push(filePath);
      continue;
    }
    const contents = await readFile(filePath);
    if (contents.includes(home)) {
      leaks.push(filePath);
    }
  }
  const problems = [];
  if (leaks.length > 0) {
    const list = leaks.map((f) => `  - ${relative(root, f)}`).join('\n');
    problems.push(
      `${leaks.length} file(s) contain the build machine's home directory ("${home}"):\n${list}`,
    );
  }
  if (nativeBinaries.length > 0) {
    const list = nativeBinaries.map((f) => `  - ${relative(root, f)}`).join('\n');
    problems.push(
      `${nativeBinaries.length} native .node binary/binaries found (platform-specific, breaks the other target platform):\n${list}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `build-mcpb: refusing to pack a tainted staging tree.\n\n${problems.join('\n\n')}`,
    );
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const stage = join(pkgRoot, 'dist', 'stage');
const stageServer = join(stage, 'server');
const tarballDir = join(pkgRoot, 'dist', 'tarballs');

const pkg = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'));
const { version } = pkg;
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version ?? '')) {
  throw new Error(`build-mcpb: package.json version "${version}" is not a valid semver string.`);
}

await rm(stage, { recursive: true, force: true });
await rm(tarballDir, { recursive: true, force: true });
await mkdir(stageServer, { recursive: true });
await mkdir(tarballDir, { recursive: true });

// 1a. Pack the three real runtime dependencies to plain tarballs.
const runtimeDeps = ['@aiftp-tools/core', '@aiftp-tools/mcp', '@aiftp-tools/cli'];
for (const name of runtimeDeps) {
  execFileSync('pnpm', ['--filter', name, 'pack', '--pack-destination', tarballDir], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

async function tarballPathFor(name) {
  // `pnpm pack` names the file after the *scoped* package, e.g.
  // "aiftp-tools-core-0.12.4.tgz" for "@aiftp-tools/core".
  const short = name.replace('@aiftp-tools/', '');
  const path = join(tarballDir, `aiftp-tools-${short}-${version}.tgz`);
  await readFile(path); // throws if pnpm named it differently than expected
  return path;
}

const [coreTarball, mcpTarball, cliTarball] = await Promise.all(
  runtimeDeps.map((name) => tarballPathFor(name)),
);

// 1b. Install the tarballs into stage/server. `overrides` forces every
// nested reference to @aiftp-tools/* (e.g. cli's own dependency on core) to
// resolve to the same local tarball instead of the public npm registry.
//
// Paths are written *relative* to stage/server, not absolute. An absolute
// `file:` path would bake the build machine's home directory into
// server/package.json, which ships inside the .mcpb to every attendee who
// installs the extension — an avoidable disclosure of the maintainer's
// filesystem layout, and dead metadata besides (the path would not exist on
// their machine). npm resolves relative `file:` specifiers against the
// directory of the package.json that declares them, so a path relative to
// stageServer is exactly what's needed.
const relativeTarball = (absPath) => `file:${relative(stageServer, absPath)}`;

await writeFile(
  join(stageServer, 'package.json'),
  `${JSON.stringify(
    {
      name: 'aiftp-desktop-server',
      version,
      private: true,
      type: 'module',
      dependencies: {
        '@aiftp-tools/cli': relativeTarball(cliTarball),
        '@aiftp-tools/core': relativeTarball(coreTarball),
      },
      overrides: {
        '@aiftp-tools/core': relativeTarball(coreTarball),
        '@aiftp-tools/mcp': relativeTarball(mcpTarball),
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts'], {
  cwd: stageServer,
  stdio: 'inherit',
});

// 1c. Copy desktop-ext's own compiled entry point (not installed as a
// dependency — it IS this package).
await mkdir(join(stageServer, 'dist'), { recursive: true });
await cp(join(pkgRoot, 'dist', 'server-entry.js'), join(stageServer, 'dist', 'server-entry.js'));

// The entry point Claude Desktop launches.
await writeFile(
  join(stageServer, 'index.js'),
  [
    "import { startDesktopServer } from './dist/server-entry.js';",
    '',
    'await startDesktopServer(process.env);',
    '',
  ].join('\n'),
  'utf8',
);

// 2. manifest + icon
await writeFile(
  join(stage, 'manifest.json'),
  `${JSON.stringify(buildManifest(version), null, 2)}\n`,
  'utf8',
);
await cp(join(pkgRoot, 'icon.png'), join(stage, 'icon.png'));

// 3. guard, then pack
await guardStagedTree(stage);
execFileSync(
  'pnpm',
  ['exec', 'mcpb', 'pack', stage, join(pkgRoot, 'dist', `aiftp-${version}.mcpb`)],
  { cwd: pkgRoot, stdio: 'inherit' },
);

console.log(`[build-mcpb] wrote packages/desktop-ext/dist/aiftp-${version}.mcpb`);
