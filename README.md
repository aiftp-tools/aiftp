# aiftp

> AI-first FTP/FTPS deploy tool for developers using rental hosting.

[![CI](https://github.com/aiftp-tools/aiftp/actions/workflows/ci.yml/badge.svg)](https://github.com/aiftp-tools/aiftp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Status**: 🎉 **v0.1.0 MVP — verified on Star Server (Japan)** _(2026-05-19)_

Real-world checklist verified on a production Star Server account:
push, encrypted backup capture from the remote, restore-to-pre-push,
TLS warning, hard-excluded credentials, Keychain-resident secrets.

Phase 1.1 follow-ups (auto-mkdir parent directories, init UX for
`/`-prefixed `remote_root` on shared hosts, server-specific TLS quirks)
are tracked in `../docs/spec.md` and will land in v0.2.

---

## What

**aiftp** lets AI agents (Claude Code, Cursor, etc.) deploy HTML / PHP / images directly to FTP/FTPS servers — safely, with encrypted backups, syntax pre-flight checks, and rollback support. Built for Japanese rental hosting environments (Star Server, Lolipop, Sakura, Xserver) where Git deploy and SSH aren't available.

## Why

Most existing FTP deploy tools (`git-ftp`, `ftp-deploy`, `dg/ftp-deployment`) assume a human at the keyboard. `aiftp` assumes an AI agent — and protects against the new failure modes that brings:

- AI accidentally overwrites production files → **mandatory encrypted local backup before every push**
- AI generates syntax-broken PHP → **pre-flight `php -l` / JSON / HTML checks**
- AI pushes credentials by mistake → **hard-excluded files (`.env`, `wp-config.php`, `*.pem`)**
- Two agents push concurrently → **server-side lock file**

## Status

| | |
|---|---|
| **Phase** | 1 (MVP) |
| **Spec** | [docs/spec.md (in parent dir)](../docs/spec.md) |
| **WBS** | [docs/wbs.md (in parent dir)](../docs/wbs.md) |
| **Target OS** | macOS (Phase 1), Windows (Phase 1.5) |
| **Language** | TypeScript / Node.js 22+ |
| **License** | MIT |

## Quick start (not ready yet)

```bash
# Install (when published)
npm install -g aiftp

# Setup
aiftp init

# Use
aiftp status
aiftp push --dry-run
aiftp push
```

## Packages

This is a pnpm monorepo:

- [`packages/core`](packages/core) — Core engine: config, diff, deploy, backup, keychain
- [`packages/cli`](packages/cli) — `aiftp` command-line interface
- [`packages/mcp`](packages/mcp) — MCP server for AI agent integration

## Development

```bash
pnpm install
pnpm test
pnpm lint
pnpm typecheck
```

## License

[MIT](LICENSE)
