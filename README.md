# aiftp

> AI agents that deploy to your FTP/FTPS server without making you nervous.

[![CI](https://github.com/aiftp-tools/aiftp/actions/workflows/ci.yml/badge.svg)](https://github.com/aiftp-tools/aiftp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Status**: v0.2.0 — verified on Star Server (Japan)

aiftp is the safety net around AI-driven FTP/FTPS uploads to Japanese
shared hosting (Star Server / Lolipop / Sakura / Xserver). You point
Claude Code, Cursor, or any MCP-aware agent at a project; aiftp
guarantees that **every push is reversible, every push has a backup,
and every credential stays in your OS keychain — not in the TOML, not
in the AI's context window**.

## Why this exists

Most existing FTP deploy tools (`git-ftp`, `ftp-deploy`,
`dg/ftp-deployment`) assume a human at the keyboard. aiftp assumes an
AI agent — and protects against the new failure modes that brings:

| Failure mode | aiftp's gate |
|---|---|
| AI overwrites a production file with broken HTML | **Encrypted local backup of the remote version is taken before every push** |
| AI generates syntax-broken PHP / JSON | **Pre-flight `php -l` / JSON / HTML checks** |
| AI sees the password in chat history | **Credentials live in OS keychain (macOS Keychain / Windows Credential Manager), never in TOML, never in AI context** |
| AI commits `.env` to FTP | **Hard-excluded files: `.env`, `wp-config.php`, `*.pem`, `db.php`, ...** |
| AI fires an unintended real push from an MCP tool call | **Two-step `aiftp_push_prepare` → `aiftp_push_confirm` gate** |
| Two agents race on the same site | **Server-side lock file** |

## What's in v0.2.0 (this release)

- **`aiftp import filezilla`** — point at a `sitemanager.xml`, get
  ready-to-use `[profile.*]` entries with passwords routed to Keychain.
  FFFTP can export the same XML format, so this is also the FFFTP
  migration path. See [`docs/migration-from-ffftp.md`](docs/migration-from-ffftp.md).
- **`aiftp profile export filezilla`** — round-trip back to a
  FileZilla XML when you need to share a site list (passwords are
  excluded by default).
- **`aiftp doctor`** — twelve diagnostic checks covering config /
  Keychain / DNS / TCP / TLS / PASV / MLSD / SIZE / encoding /
  remote_root reachability, with `--json` for AI consumption.
- **`aiftp config migrate`** — automatic v1→v2 schema upgrade with
  atomic write, original preserved as `.aiftp.toml.v1.bak`, multi-run
  guard, and `.aiftp/logs/migrations.jsonl` audit trail.
- **MCP two-step push** — `aiftp_push(dry_run=false)` is now refused.
  Real pushes require `aiftp_push_prepare` (returns `plan_id`,
  `diff_hash`, `confirm_token`) followed by `aiftp_push_confirm` with
  those exact values. Plans expire after 5 minutes and cannot be
  replayed.
- **`aiftp://config` MCP resource redaction** — only protocol,
  server_kind, and "credentials are configured" are exposed; host /
  user / remote_root / keychain_service stay private.
- **`[encoding]` and `[quirks]` config sections** — Shift_JIS file
  names, NAT'd PASV addresses, MLSD-less servers, all explicit and
  per-profile.

## Quick start

```bash
# 1. Initialize a new project (asks host, port, protocol, etc.;
#    stores the password in macOS Keychain or Windows Credential Manager)
aiftp init

# 2. Already have a FileZilla site list? Import it.
aiftp import filezilla ~/.config/filezilla/sitemanager.xml --dry-run
aiftp import filezilla ~/.config/filezilla/sitemanager.xml

# 3. Diagnose before pushing
aiftp doctor

# 4. Preview the diff
aiftp status

# 5. Dry-run the push
aiftp push --dry-run

# 6. Real push (encrypted backup is taken automatically beforehand)
aiftp push

# 7. Something went wrong? Restore the previous version from the
#    encrypted local snapshot.
aiftp backup list
aiftp backup restore <snapshot-id> <path> --output restored.html
```

## Supported servers

| Provider | Status |
|---|---|
| **Star Server**（スターサーバー） | ✅ Verified (with documented TLS hostname quirk — see [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md)) |
| Lolipop / Sakura / Xserver | Adapter present, end-to-end verification planned for v0.2.1 |
| Generic vsftpd / pure-ftpd / FileZilla Server | Works with default settings |

If you run aiftp against a host not in
[`docs/compatibility-matrix.md`](docs/compatibility-matrix.md), please
open a PR with the row.

## MCP / Claude Code integration

```json
{
  "mcpServers": {
    "aiftp": {
      "command": "node",
      "args": ["/path/to/aiftp/packages/cli/dist/bin.js", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Tools the AI sees:

- `aiftp_status` — show the local diff
- `aiftp_push` (dry-run only) — preview
- `aiftp_push_prepare` + `aiftp_push_confirm` — the two-step gate for real pushes
- `aiftp_backup_list` / `aiftp_backup_restore` / `aiftp_backup_verify` / `aiftp_backup_prune`
- `aiftp_log`, `aiftp_list_remote`

Resources:

- `aiftp://config` — redacted summary (no credentials)
- `aiftp://state/{profile}`
- `aiftp://backups/{profile}`

## Packages

This is a pnpm monorepo:

- [`packages/core`](packages/core) — Config (zod), diff, deploy, backup, keychain, importers/exporters, diagnostics, migrations
- [`packages/cli`](packages/cli) — `aiftp` command-line interface
- [`packages/mcp`](packages/mcp) — MCP server (`aiftp mcp`) for AI agent integration

## Development

```bash
pnpm install
pnpm vitest run          # 310 tests (v0.2.0)
pnpm -r typecheck
pnpm biome check packages
```

## Status / roadmap

| | |
|---|---|
| **Released** | v0.2.0 (2026-05-19) |
| **Spec** | [docs/spec.md (in parent dir)](../docs/spec.md) |
| **Walkthrough** | [docs/v0.2-walkthrough.md](docs/v0.2-walkthrough.md) |
| **Compatibility** | [docs/compatibility-matrix.md](docs/compatibility-matrix.md) |
| **FFFTP/FileZilla migration** | [docs/migration-from-ffftp.md](docs/migration-from-ffftp.md) |
| **Target OS** | macOS ✅ (end-to-end verified on Star Server). Windows ✅ (v0.3 — `cmdkey` + Win32 `CredRead` via PowerShell, CI-tested on `windows-latest`). Linux is a Phase 2+ candidate. |
| **Language** | TypeScript / Node.js 22+ |
| **License** | MIT |

## License

[MIT](LICENSE)
