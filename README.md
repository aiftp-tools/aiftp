# aiftp

> **The safe FTP/FTPS deploy tool for the AI-agent era — built for Japanese shared hosting.**
> AI エージェント時代の、日本のレンタルサーバー向け安全 FTP デプロイツール。

[![CI](https://github.com/aiftp-tools/aiftp/actions/workflows/ci.yml/badge.svg)](https://github.com/aiftp-tools/aiftp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Status**: v0.11.0 — published to npm as `@aiftp-tools/{core,cli,mcp}`. Continuously verified on Star Server (Japan); Sakura / Xserver / Lolipop were verified end-to-end at v0.9.3 (2026-05-22), with those accounts since cancelled and re-verified on demand (see [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md)). v0.11 adds WordPress-focused templates, SFTP support, and an expanded smoke CI.

```bash
npm install -g @aiftp-tools/cli
aiftp --version   # 0.11.0
```

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
> to WordPress admin paths rather than FTP — was verified at v0.9.3
> and is tracked in
> [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md);
> those provider accounts have since been cancelled, so it is
> re-verified on demand rather than every release.

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

## What's new in v0.11 (templates, SFTP, smoke CI)

The v0.11 series ships four pillars under one theme — *"work with an AI
agent on the 50%+ of Japanese rental servers where SSH isn't available"*
— aimed squarely at the **制作者 (Builder)** persona (WordPress / static
site builders on SSH-less shared hosting; see [`CONTEXT.md`](CONTEXT.md)).

- **WordPress-focused templates — 7 presets** (Pillar β) — `aiftp init
  --template <id>` applies sensible hard-exclude / safety / preflight
  defaults per stack. Presets: `wordpress-swell`, `wordpress-lightning`,
  `wordpress-cocoon`, `wordpress-standard`, `static`, `laravel`,
  `php-simple`. `aiftp init --template list` prints the catalog; with no
  flag, the template is chosen interactively. The registry is a closed
  set validated by a strict Zod schema at module load (MCP-injection
  safe).
- **SFTP support** (Pillar γ) — `SftpClient` shares the exact `FtpClient`
  interface, so setting `protocol = "sftp"` in `.aiftp.toml` routes every
  command (deploy / rollback / backup) through SFTP via the deploy-client
  factory. SSH key auth enforces `0o600` / `0o400` permissions (rejects
  over-permissive keys before connect, with a `chmod 600` hint). `doctor`
  gains four SFTP checks (`ssh-port-reachable`, `ssh-key-permissions`,
  `sftp-handshake`, `sftp-remote-root`); FileZilla import now maps SFTP
  sites instead of skipping them.
- **`:back` navigation in `aiftp init`** (Pillar α) — the new PromptFlow
  state machine adds per-field hints/examples and a `:back` keyword to
  step back to a previous field. Combined with the v0.10.4 summary
  review, the init path is now fully recoverable from input mistakes.
- **MCP `aiftp_init_template_list` tool** — a read-only tool so an AI
  client (Claude Code, Cursor, etc.) can fetch the template catalog
  before scaffolding a project.
- **Smoke CI — 3 OS × 2 Node** (Pillar δ) — `.github/workflows/smoke.yml`
  runs on macOS / Ubuntu / Windows × Node 22 / 24 on release, dispatch,
  and a Monday 09:00 JST schedule; an MCP stdio JSON-RPC probe verifies
  the tool surface. Competitive positioning is documented in
  [`docs/competitive-comparison.md`](docs/competitive-comparison.md).

Built across 2026-05-25 – 26 via spec → writing-plans → TDD → a Claude
implements / Codex independently reviews loop (Phase 1 spec + Phase 2
implementation), which caught a critical SFTP bug — the config schema
accepted an SSH key while the deploy path silently fell back to password
auth — before release.

**Quality gates (v0.11.0)**: 740 tests passed / 3 skipped / 0 failed,
Branches coverage 84%+, biome lint clean, `tsc --noEmit` clean. See
[CHANGELOG](CHANGELOG.md) for the full per-pillar detail.

## What's new in v0.10 (init UX hardening)

The v0.10 series focuses on the `aiftp init` path — the first thing any
new user touches, and historically the place where input mistakes were
most expensive (one bad port, missing keychain service name, or a
trailing whitespace would surface as an opaque error at the end of the
flow).

- **Per-field validation at the prompt boundary** (v0.10.1 / v0.10.2) —
  host / user / remoteRoot / localRoot / keychainService / password are
  validated on the spot; the port prompt enforces `1-65535` (no more
  `-Infinity` slipping through).
- **Keychain service default** (v0.10.1) — derived as
  `aiftp:<profile-name>` instead of an empty default.
- **Non-standard port warn-and-confirm** (v0.10.3) — anything other
  than `21` (FTP) or `21`/`990` (FTPS implicit) triggers an explicit
  `Continue?` confirmation, with `aborted: non-standard FTP/FTPS port`
  on decline.
- **Numbered summary review with edit loop** (v0.10.4) — after the
  prompts, every captured value is displayed in a numbered table.
  `Y`/Enter confirms, `n` aborts, `1-10` jumps back to that specific
  field to edit it in place. Editing the protocol re-fires the
  non-standard port check. The loop is capped at 10 iterations to
  prevent runaway.
- **Per-field sanitization** (v0.10.4) — text fields are trimmed and
  rejected if they contain control characters (`U+0000`-`U+001F`)
  before the value reaches TOML or the keychain.
- **Strict summary-choice parsing** (v0.10.4) — `１０` (全角), `01`,
  `1abc`, `1.5`, `1 5` are all rejected. Paste-with-trailing-newline
  is trimmed and accepted.
- **Non-TTY guard** (v0.10.4) — `aiftp init < /dev/null` fails fast
  instead of hanging.

The whole series was driven by 田中さん's review feedback —
"ユーザは必ず入力ミスする前提で仕様を考える / 入力間違いの
recovery path も仕様化する" — and validated by a Codex Phase 1
(spec review) + Phase 2 (implementation review) loop. Spec doc:
[`docs/superpowers/specs/2026-05-24-init-input-validation-recovery-design.md`](docs/superpowers/specs/2026-05-24-init-input-validation-recovery-design.md).

**Quality gates (v0.10.4)**: 630 tests passed / 3 skipped / 0 failed,
Branches coverage 83.29%, Statements 90.25%, biome lint clean.

## What's in v0.9.1

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
# 0. Install globally from npm (Node.js 22+ required)
npm install -g @aiftp-tools/cli
aiftp --version   # → 0.11.0

# 1. Initialize a new project (asks host, port, protocol, etc.;
#    stores the password in macOS Keychain or Windows Credential Manager;
#    shows a numbered summary and lets you edit any field before saving)
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
| Lolipop / Sakura / Xserver | ✅ Verified end-to-end at v0.9.3 (2026-05-22); accounts since cancelled, re-verified on demand — see [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md) |
| Generic vsftpd / pure-ftpd / FileZilla Server | Works with default settings |

If you run aiftp against a host not in
[`docs/compatibility-matrix.md`](docs/compatibility-matrix.md), please
open a PR with the row.

## MCP / Claude Code integration

With the npm-installed CLI on your `$PATH` (`npm install -g @aiftp-tools/cli`):

```json
{
  "mcpServers": {
    "aiftp": {
      "command": "aiftp",
      "args": ["mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Or, when developing aiftp from a local clone:

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

This is a pnpm monorepo. All three packages are published to npm under
the `@aiftp-tools` scope:

| Package | npm | Purpose |
|---|---|---|
| [`packages/core`](packages/core) | [`@aiftp-tools/core`](https://www.npmjs.com/package/@aiftp-tools/core) | Config (zod), diff, deploy, backup, keychain, importers/exporters, diagnostics, migrations |
| [`packages/cli`](packages/cli) | [`@aiftp-tools/cli`](https://www.npmjs.com/package/@aiftp-tools/cli) | `aiftp` command-line interface |
| [`packages/mcp`](packages/mcp) | [`@aiftp-tools/mcp`](https://www.npmjs.com/package/@aiftp-tools/mcp) | MCP server (`aiftp mcp`) for AI agent integration |

End users install only the CLI: `npm install -g @aiftp-tools/cli`
(the CLI depends on `core` and `mcp` transitively).

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

## Security limitations (v0.11)

**Known limitation — SFTP host key verification is NOT enforced in v0.11.** `SftpClient.connect()` accepts any host key the server presents on the first connection, and does NOT pin / compare against a `known_hosts` file. This means a man-in-the-middle attacker on the path between the client and the SFTP server could intercept the connection and capture password authentication credentials or operate as a signing oracle for SSH key authentication.

**Risk mitigation in v0.11**:
- Run aiftp on a trusted network path (the same posture you would use for FTPS without TLS pinning).
- Prefer SSH key authentication over password authentication when possible (an attacker who intercepts the SFTP transport still cannot extract the private key, only obtain signed challenges).
- Verify the server's host key fingerprint out-of-band against the hosting provider's documentation before the first connection.

**Planned in v0.12**: `.aiftp/known_hosts` Trust-On-First-Use (TOFU) pinning with explicit prompt on host key change. Tracked in: [docs/superpowers/specs/2026-05-26-v0.11-security-codex-review.md](docs/superpowers/specs/2026-05-26-v0.11-security-codex-review.md) (Finding 3).

Other security boundaries (encryption at rest, hard-exclude of secret files, prepare→confirm 2-step gate, Keychain-only credential storage, profile name + remote_root + ssh_key_path traversal rejection) are all enforced in v0.11.

## Status / roadmap

| | |
|---|---|
| **Released** | v0.11.0 (2026-05-26) — see [CHANGELOG](CHANGELOG.md) |
| **npm** | `@aiftp-tools/cli` · `@aiftp-tools/core` · `@aiftp-tools/mcp` |
| **Spec** | [docs/spec.md (in parent dir)](../docs/spec.md) |
| **Init UX design spec (v0.10.4)** | [docs/superpowers/specs/2026-05-24-init-input-validation-recovery-design.md](docs/superpowers/specs/2026-05-24-init-input-validation-recovery-design.md) |
| **Walkthrough** | [docs/v0.2-walkthrough.md](docs/v0.2-walkthrough.md) |
| **Compatibility** | [docs/compatibility-matrix.md](docs/compatibility-matrix.md) |
| **FFFTP/FileZilla migration** | [docs/migration-from-ffftp.md](docs/migration-from-ffftp.md) |
| **Competitive positioning** | [docs/competitive-comparison.md](docs/competitive-comparison.md) — vs alxspiker/mcp-server-ftp / Computer Use / WordPress 公式 MCP / git-ftp 系 |
| **Target OS** | macOS ✅ (continuously verified on Star Server; Sakura / Xserver / Lolipop verified at v0.9.3, accounts since cancelled — see [compatibility-matrix](docs/compatibility-matrix.md)). Windows ✅ (v0.3 — `cmdkey` + Win32 `CredRead` via PowerShell, CI-tested on `windows-latest`). Linux is a Phase 2+ candidate. |
| **Language** | TypeScript / Node.js 22+ |
| **License** | MIT |

## License

[MIT](LICENSE)
