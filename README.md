# aiftp

> **The safe FTP/FTPS deploy tool for the AI-agent era — built for Japanese shared hosting.**
> AI エージェント時代の、日本のレンタルサーバー向け安全 FTP デプロイツール。

[![CI](https://github.com/aiftp-tools/aiftp/actions/workflows/ci.yml/badge.svg)](https://github.com/aiftp-tools/aiftp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Status**: v0.9.3 — verified on Star Server / Sakura / Xserver / Lolipop (Japan). Phase 2 complete (import / watch / hook / multi-profile / rollback). v0.9.3 adds RFC 6125 wildcard cert matching and the `ftp-auth` doctor check.

## Two problems aiftp solves

AI agents that deploy to FTP servers face two structural problems that
older deploy tools were never designed for:

### 1. AI agents bypass safety protocols and overwrite remote files

AI-assisted deployment has a known failure mode: an agent may act
on stale local files, skip a backup step, or interpret an ambiguous
instruction as permission to overwrite production. Public reports
in major AI coding assistants' issue trackers describe this class
of incident; see for example
[anthropics/claude-code#49344](https://github.com/anthropics/claude-code/issues/49344)
and the long-running-FTP hang report at
[anthropics/claude-code#45806](https://github.com/anthropics/claude-code/issues/45806).
Issue contents change over time — what matters is that the failure
mode is real and that the deploy tool, not the agent, should be the
one enforcing safety.

aiftp's response: **every push is reversible** (encrypted local backup
of the remote version is taken before every upload), **every real
push requires a two-step `prepare → confirm` token gate**, and
**hard-excluded files** (`.env`, `wp-config.php`, `*.pem`, `db.php`)
cannot be touched even on operator command.

### 2. Foreign-IP filtering on Japanese shared hosting conflicts with cloud CI/CD

Several Japanese rental-hosting providers offer **foreign-IP
address filtering** as a security feature. When this filter is
enabled for FTP/FTPS — which is the documented default on Sakura
Internet's Rental Server since the
[2014-03 announcement](https://www.sakura.ad.jp/corporate/information/announcements/2014/03/10/870/) —
cloud CI/CD services with non-Japanese egress (Vercel / Netlify /
Cloudflare Pages / GitHub Actions and similar) may not be able to
complete FTP file operations against the server.

aiftp sidesteps that conflict by running the FTP client **locally
on the developer's machine** (i.e. from the operator's own IP),
while still letting an AI agent (Claude Code, Cursor, etc.) plan
and confirm the upload through MCP. No provider-side security
setting needs to be weakened.

> **Per-provider notes**: behavior differs between providers and
> can change over time. What we've verified so far — Sakura's
> foreign-IP filter ON by default and including FTP, Xserver's FTP
> unrestricted by default, Lolipop's "海外アタックガード" scoped
> to WordPress admin paths rather than FTP — is tracked in
> [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md)
> and re-checked each release.

### Market context

Why this matters for the Japanese Web development market:

- **Xserver alone hosts ~31.7% of Japanese WordPress sites**
  ([WP-Search 2026-01](https://wp-search.net/), cross-checked against
  [W3Techs](https://w3techs.com/) Japan locale = 29.8%)
- **Sakura adds ~10.7%** (same source). Sakura users hit the
  foreign-IP filter problem out of the box
- The FFFTP / FileZilla user base in this segment is large, deeply
  entrenched, and has *no idiomatic path* into modern AI-assisted
  CI/CD workflows. aiftp's `import filezilla` / `import ffftp` is the
  bridge.

## Failure-mode matrix

| Failure mode | aiftp's gate |
|---|---|
| AI overwrites a production file | **Encrypted local backup of the remote version is taken before every push** |
| AI generates syntax-broken PHP / JSON | **Pre-flight `php -l` / JSON / HTML checks** |
| AI sees the password in chat history | **Credentials live in OS keychain (macOS Keychain / Windows Credential Manager), never in TOML, never in AI context** |
| AI commits `.env` to FTP | **Hard-excluded files: `.env`, `wp-config.php`, `*.pem`, `db.php`, ...** |
| AI fires an unintended real push from an MCP tool call | **Two-step `aiftp_push_prepare` → `aiftp_push_confirm` gate (token-bound, expires in 5 min)** |
| AI deploys to the wrong profile | **Type-to-confirm production gate (no y/n the AI can auto-skip)** |
| Two agents race on the same site | **Server-side lock file** |
| Foreign-IP filter blocks cloud CI from reaching Japanese hosting | **Run locally from a Japanese IP — no infrastructure change needed** |
| Hangs on long-running FTP operations through generic AI tool loops | **MCP exposes one `prepare/confirm` round-trip per push, not a per-file tool loop** |

## What's in v0.9.1 (current release)

**Safety & MCP gates**

- **MCP two-step push** — `aiftp_push(dry_run=false)` is refused.
  Real pushes require `aiftp_push_prepare` (returns `plan_id`,
  `diff_hash`, `confirm_token`) followed by `aiftp_push_confirm` with
  those exact values. Plans expire after 5 minutes and cannot be
  replayed. The same `prepare → confirm` gate also wraps
  `aiftp_backup_restore`, `aiftp_config_migrate`, `aiftp_import_filezilla`,
  and `aiftp_import_ffftp`.
- **Two-phase atomic rollback** — `aiftp rollback` and
  `aiftp_rollback_prepare` / `_confirm` upload all files to staging
  paths first, then atomically rename them into place. A mid-rollback
  failure cannot leave the site half-rolled.
- **Production push type-to-confirm gate** — pushing to a profile
  flagged as production (matched by glob in `[safety] production_profile_patterns`)
  requires the operator to type a non-trivial acknowledgement, not a
  y/n the AI can auto-skip.
- **`aiftp://config` MCP resource redaction** — only protocol,
  server_kind, and "credentials are configured" are exposed; host /
  user / remote_root / keychain_service stay private.

**Import / export**

- **`aiftp import filezilla`** — point at a `sitemanager.xml`, get
  ready-to-use `[profile.*]` entries with passwords routed to Keychain.
  Plain-text and master-password-encrypted XML both handled. See
  [`docs/migration-from-ffftp.md`](docs/migration-from-ffftp.md).
- **`aiftp import ffftp`** — read FFFTP's `ffftp.ini` directly
  (Shift_JIS via iconv-lite). Stale `[hostN]` sections past
  `[Hosts] SetNumber` are skipped. Mask-encrypted FFFTP passwords are
  intentionally not decoded; a per-profile warning prompts the operator
  to run `aiftp auth <profile>` afterwards.
- **`aiftp profile export filezilla`** — round-trip back to a
  FileZilla XML when you need to share a site list (passwords are
  excluded by default).

**Profile management**

- **`aiftp profile list / use / show / test`** — multi-site management
  with sole-profile fallback, plus matching read-only MCP tools
  (`aiftp_profile_list` / `_current` / `_test`) for AI agents.
- **`AIFTP_PROFILE` env var** — explicit override of the default
  profile, layered above the state file's last-used profile.

**Diagnostics & migration**

- **`aiftp doctor`** — twelve diagnostic checks covering config /
  Keychain / DNS / TCP / TLS / PASV / MLSD / SIZE / encoding /
  remote_root reachability, with `--json` for AI consumption.
- **`aiftp config migrate`** — automatic v1→v2 schema upgrade with
  atomic write, original preserved as `.aiftp.toml.v1.bak`, multi-run
  guard, and `.aiftp/logs/migrations.jsonl` audit trail.

**Watch / hook integration**

- **`aiftp watch`** — debounced filesystem watcher (`fs.watch` recursive,
  Node 22+) that prints dry-run pushes when files change. Never pushes
  on its own; the operator stays in the loop.
- **`aiftp hook`** — reads Claude Code / Cursor `PostToolUse` hook
  payloads from stdin and prints a dry-run aiftp status notification.
  Strictly notification-only — never pushes.

**Schema v2**

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
| Lolipop / Sakura / Xserver | Adapter present, end-to-end verification underway ahead of v1.0.0 |
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
pnpm vitest run          # 485 passed / 3 skipped (v0.9.1)
pnpm -r typecheck
pnpm biome check packages
```

## Status / roadmap

| | |
|---|---|
| **Released** | v0.9.1 (2026-05-21) |
| **Spec** | [docs/spec.md (in parent dir)](../docs/spec.md) |
| **Walkthrough** | [docs/v0.2-walkthrough.md](docs/v0.2-walkthrough.md) |
| **Compatibility** | [docs/compatibility-matrix.md](docs/compatibility-matrix.md) |
| **FFFTP/FileZilla migration** | [docs/migration-from-ffftp.md](docs/migration-from-ffftp.md) |
| **Target OS** | macOS ✅ (end-to-end verified on Star Server). Windows ✅ (v0.3 — `cmdkey` + Win32 `CredRead` via PowerShell, CI-tested on `windows-latest`). Linux is a Phase 2+ candidate. |
| **Language** | TypeScript / Node.js 22+ |
| **License** | MIT |

## License

[MIT](LICENSE)
