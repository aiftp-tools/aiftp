#!/usr/bin/env node
// Assemble the .mcpb bundle:
//   1. `pnpm pack` the three real runtime dependencies (core / mcp / cli) to
//      tarballs, then `npm install --omit=dev` them into stage/server so a
//      real node_modules tree exists.
//
//      We deliberately do NOT bundle with esbuild: ssh2 (used by the SFTP
//      client) has dynamic requires and an optional native dependency
//      (cpu-features) that bundlers break. `cpu-features` is optional, so
//      omitting it lets one .mcpb run on both macOS and Windows via the
//      pure-JS crypto fallback.
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
//   3. `mcpb pack`.

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../dist/manifest.js';

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

execFileSync('npm', ['install', '--omit=dev'], { cwd: stageServer, stdio: 'inherit' });

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

// 3. pack
execFileSync(
  'pnpm',
  ['exec', 'mcpb', 'pack', stage, join(pkgRoot, 'dist', `aiftp-${version}.mcpb`)],
  { cwd: pkgRoot, stdio: 'inherit' },
);

console.log(`[build-mcpb] wrote packages/desktop-ext/dist/aiftp-${version}.mcpb`);
