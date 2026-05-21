# Changelog

All notable changes to **aiftp** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release tags live in the GitHub repository:
<https://github.com/aiftp-tools/aiftp/releases>

---

## [Unreleased]

Working toward v0.10.0 then v1.0.0. See
[the roadmap](docs/roadmap.md) for what's planned next.

---

## [0.9.2] — 2026-05-22

A-7 multi-provider verification (Lolipop / Sakura / Xserver) revealed
several issues; the BLOCK-level ones are fixed in this release, the
rest are tracked under "Known limitations" below and queued for
v0.10.0.

### Fixed

- **Backup snapshot is now created on added-only pushes.**
  Previously `deploy.ts` only invoked `createAutoSnapshot` when
  `modified > 0`, so an initial push (which is typically all
  `added`) created **no snapshot at all**, leaving the operator
  unable to roll back. The condition is now `planned.length > 0`,
  and the snapshot is built from the union of added + modified
  targets. This was discovered during A-7 verification on Sakura
  (oliveferret65.sakura.ne.jp) and confirms the spec's
  "every push is reversible" promise.

### Added

- **`aiftp doctor` surfaces the underlying error message on stderr**
  when the FTPS probe path fails. Previously every probe failure
  (TLS handshake, 530 login incorrect, PASV refused, etc.) was
  reported as the catch-all "FTPS handshake failed." Now the doctor
  prints `[doctor probeFtps error] <message>` so the operator can
  tell, for example, that the real problem is a wrong password
  rather than a TLS layer issue. `AIFTP_DEBUG=1 aiftp doctor`
  additionally pipes basic-ftp's verbose FTP-command log to stderr.

### Documentation

- README lead rewritten with the "foreign-IP filtering on Japanese
  shared hosting × AI-agent safety" angle, citing Sakura's
  2014-03 announcement and Claude Code's public issue tracker
  generically (rather than naming specific issues that may close).
- CHANGELOG, NOTICE (production-only license inventory), privacy
  policy, roadmap, and v1.0.0 release-notes draft added.
- Community templates added: CONTRIBUTING.md, CODE_OF_CONDUCT.md,
  SECURITY.md, and four Issue / PR templates.
- `docs/a7-multi-provider-walkthrough.md` documents the 14-day
  3-provider verification procedure used to find the bugs above.

### Verified on real hosting (A-7)

| Provider | doctor result | Notes |
|---|---|---|
| Star Server | ✅ (since v0.1.0) | — |
| Lolipop! Light | ✅ 9 pass / 3 warn / 0 fail | `tls_check_hostname=false` recommended for shared TLS cert; `use_mlsd=false` (Lolipop is MLSD-less). 海外アタックガード ON does not affect FTP. |
| Sakura Rental Server | ✅ 9 pass / 3 warn / 0 fail | Same TLS quirk pattern as Lolipop. **国外IPフィルタ default ON (FTP included) confirmed in 2026, matching the 2014-03 announcement.** |
| Xserver Standard | ✅ 9 pass / 3 warn / 0 fail | Same TLS quirk pattern. FTP unrestricted by default (per public docs). |

### Known limitations (planned for v0.10.0)

These were discovered during A-7 verification but are out of scope
for v0.9.2's BLOCK fix. They will land in v0.10.0:

1. **Snapshot for added-only pushes has `files=0`** — `createSnapshot`
   reads via `source.readFile(path)`, which (correctly per the spec)
   downloads the *remote* old version. For genuinely new files,
   there is no remote old version, so the snapshot is metadata-only.
   `aiftp rollback` therefore reports `0 file(s) uploaded` and the
   newly-added files are not deleted from the remote. v0.10.0 will
   redesign the snapshot to carry added/modified/removed
   classification so `rollback` can `delete` for added, `restore`
   for modified, and `restore` for removed.

2. **`local_root = "."` walks every file in the working directory.**
   During A-7 verification, doctor output files (`doctor-*.txt`,
   `*.json`) the operator had saved locally were inadvertently
   uploaded. The hard-exclude list catches credentials but not
   general-purpose work files. v0.10.0 will add either an explicit
   `include` allow-list mode or a more conservative default-exclude
   list (`doctor-*`, `*.bak`, common editor swap files, etc.).

3. **`doctor`'s `ftps-handshake: fail` is over-broad.** As of v0.9.2,
   the underlying error message reaches stderr, but the result
   *status* is still "FTPS handshake failed" even for 530 (login
   incorrect) where the TLS handshake actually succeeded. v0.10.0
   will split this into `ftps-handshake` (TLS layer) and `ftp-auth`
   (USER/PASS) with distinct status codes.

4. **`certificateMatchesHost` is exact-match, not wildcard-aware.**
   `*.sakura.ne.jp` does not match `oliveferret65.sakura.ne.jp` in
   the current implementation, so `ftps-cert: warn` is raised even
   when the cert is genuinely valid for the host. v0.10.0 will add
   RFC 6125 wildcard matching to `certificateMatchesHost`.

5. **`aiftp init` is the only path that creates `.aiftp/backups/`
   and the backup-key.** Operators who hand-edit `.aiftp.toml`
   (e.g. for multi-environment workflows) need a separate
   `aiftp backup init` command or an auto-create path in
   `aiftp push`. v0.10.0 will add the missing initialization
   path with an explicit warning rather than silent failure.

### Notes

- Test suite at v0.9.2: **486 passed / 3 skipped** across 28 files.
- macOS / Windows CI both green.
- No `.aiftp.toml` schema changes from v0.9.1 → v0.9.2.

---

## [0.9.1] — 2026-05-21

### Fixed

- **FFFTP importer**: password-protected profiles were silently dropped
  during import. Now emits `password.kind = 'absent'` plus a per-profile
  warning prompting the operator to run `aiftp auth <profile>`.
- **FFFTP importer**: respect `[Hosts] SetNumber` so stale (deleted)
  `[hostN]` sections past the active count are no longer imported as
  phantom profiles.
- **FFFTP importer**: explicit handling of `KanjiCode=2` (JIS) — falls
  through to `auto` rather than silently defaulting.
- **MCP `acknowledge_production`**: schema tightened from `z.boolean()`
  to `z.literal(true).optional()` so a bare `false` is now rejected at
  the schema layer rather than the handler layer.
- **`aiftp hook`**: stdin now has a 10 MB hard cap and 10 s timeout via
  `Promise.race`, preventing OOM and indefinite hangs on runaway hook
  producers.
- **`relativizeIntoProject`** (hook path mapping): Windows-style
  `C:\project\file.html` paths now resolve correctly, with proper
  case-folding (Windows is case-insensitive by default).

### Notes

- Phase 2 (import / watch / hook / multi-profile / rollback / production
  gate) is now considered complete.
- Test suite: **485 passed / 3 skipped** across 28 files.

---

## [0.9.0] — 2026-05-21

### Added

- **`aiftp hook`** — Claude Code / Cursor `PostToolUse` hook handler.
  Reads JSON from stdin, extracts edited file paths, prints a dry-run
  status notification. **Never pushes** — strictly notification-only.
- **`extractHookPaths` / `relativizeIntoProject`** in `packages/core` —
  defensive parsers for hook payloads (Write / Edit / MultiEdit /
  NotebookEdit), with cross-platform path handling.

### Phase 2 #5 complete.

---

## [0.8.0] — 2026-05-21

### Added

- **`aiftp watch`** — debounced filesystem watcher using `fs.watch`
  recursive (Node 22+). On detected changes, prints a dry-run push
  preview. **Never pushes on its own**; the operator stays in the loop.
- **`createWatchDebouncer`** in `packages/core` — pure function with
  test-injectable clock for deterministic debouncing tests.

### Phase 2 #4 complete.

---

## [0.7.0] — 2026-05-21

### Added

- **`aiftp import ffftp`** — direct FFFTP `ffftp.ini` parser, reads
  Shift_JIS via `iconv-lite`. Maps `[hostN]` sections to `[profile.*]`
  entries with encoding, protocol, and per-profile warnings.
- **`iconv-lite`** lifted to a direct dependency.

### Notes

- FFFTP's `Password` field is Mask-encrypted with a non-standard scheme;
  aiftp intentionally does not decode it. The operator runs
  `aiftp auth <profile>` after import.

### Phase 2 #3 complete.

---

## [0.6.0] — 2026-05-20

### Added

- **Production push type-to-confirm gate**: `[safety] production_profile_patterns`
  (glob list) flags profiles as production. Pushing to a production
  profile requires the operator to type a non-trivial acknowledgement
  string — not a y/n the AI can auto-skip.
- **`isProdProfile`** utility in `packages/core/src/safety.ts`,
  anchored-glob match with optional warn-on-unmatched mode.
- **MCP `acknowledge_production`** parameter added to `aiftp_push_confirm`.

### Phase 2 #7 (誤配信防止 UX) complete.

---

## [0.5.0] — 2026-05-20

### Added

- **`aiftp rollback`** CLI command with `--steps N` / `--snapshot <id>`
  selectors.
- **`aiftp_rollback_prepare` / `_confirm`** MCP tools, following the
  same two-step gate pattern as push / restore / migrate / import.
- **`createRollbackUploader`** hook to keep rollback's atomic
  guarantees independent of the regular upload path.
- **Two-phase atomic rollback**: all files upload to staging paths
  first, then are atomically renamed into place. A mid-rollback failure
  cannot leave the site half-rolled.

### Fixed (v0.5.0 review block-fixes)

- **HIGH**: drift detection now re-runs between prepare and confirm so
  a file changed after prepare is caught instead of silently uploaded.
- **HIGH**: uploader contract narrowed — duck-typing on `basic-ftp`'s
  client was replaced with an explicit interface that the rollback path
  injects, so a future basic-ftp signature change cannot silently break
  rollback.
- **HIGH/MEDIUM**: 4 + 6 review issues from Codex + Claude resolved
  before tag.

---

## [0.4.2] — 2026-05-20

### Added

- **MCP `aiftp_config_migrate_prepare` / `_confirm`** and
  **`aiftp_import_filezilla_prepare` / `_confirm`** — completing the
  two-step gate coverage across all destructive MCP tools.
- **`toolVersion`** field in `.aiftp/logs/migrations.jsonl` audit
  entries.
- **`randomUUID`** for migration temp file names to prevent collision
  on concurrent runs.

### Fixed

- **BLOCK**: `config_migrate_prepare` previously returned the full
  generated TOML in the prepare response, leaking credentials. Now
  returns a structured `sections_added` summary instead.
- **BLOCK**: TOCTOU race in `config_migrate` between read and write
  fixed by inline atomic write (no longer delegates to `loadConfig`).
- **HIGH/MEDIUM (10 issues from Claude + Codex)**: migrated_source
  redaction, drift recheck, batch dedup, atomic write hardening, and
  more.

---

## [0.4.1] — 2026-05-20

### Added

- **MCP `aiftp_profile_list` / `_current` / `_test`** — read-only
  profile inspection tools for AI agents. All return redacted views
  (no credentials).
- **`resolveDefaultProfile`** utility replacing the hardcoded
  `DEFAULT_PROFILE = 'production'`. Precedence: `AIFTP_PROFILE` env >
  state file's last-used > sole-profile fallback.
- **`runtime.runDoctor?`** hook on `AiftpMcpRuntime` (CLI wiring is a
  v0.4.2 candidate).

### Fixed (review block-fixes)

- **HIGH**: schema-required vs optional handler-resolved profile
  consistency.
- **HIGH**: redaction of resolved-profile info from `aiftp://config`.
- **HIGH/MEDIUM (5 + 5 issues)**: from dual Claude + Codex review.

---

## [0.4.0] — 2026-05-20

### Added

- **`aiftp profile`** command group: `list`, `use`, `show`, `test`.
- **Multi-profile support** with sole-profile fallback (single
  `[profile.*]` defined → auto-use without explicit selection).
- **State file `.aiftp/state/last-profile`** tracking the last-used
  profile per project directory.

---

## [0.3.0] — 2026-05-19

### Added

- **Windows credential backend**: `cmdkey` for writes, Win32
  `CredRead` via PowerShell for reads (DPAPI-protected at rest).
- **`KeychainBackend` interface** isolating macOS `security` and
  Windows `cmdkey`/`CredRead` behind a common contract.
- **CI matrix expanded to `windows-latest`** alongside `macos-latest`
  and `ubuntu-latest`.

---

## [0.2.5] — 2026-05-19

### Added

- **Auto-mkdir for `remote_root`** when the directory doesn't exist
  on first connect. Surfaced as a one-time `info` in doctor.
- **`aiftp ls <remote-path>`** quick diagnostic command for verifying
  CWD behavior without a full doctor run.

---

## [0.2.4] — 2026-05-19

### Added

- **`remote-root: fail` details**: doctor and `probeFtps` now report
  the CWD error code and the path that triggered it, instead of a
  bare "fail" status.

---

## [0.2.3] — 2026-05-19

### Fixed

- **`aiftp doctor probe`** now respects `[quirks] tls_check_hostname`,
  matching the runtime FTP client's hostname-verification policy.

---

## [0.2.2] — 2026-05-19

### Added

- **MCP `aiftp_backup_restore_prepare` / `_confirm`** with explicit
  path-traversal guard.
- **`[quirks] noop_interval_sec`** wired to `basic-ftp`'s keepalive,
  preventing idle disconnects on hosts with aggressive timeouts.
- **`[quirks] tls_check_hostname`** to opt out of hostname verification
  (with a loud warning) for hosts that present a generic shared
  certificate.

---

## [0.2.1] — 2026-05-19

### Added

- **`probeFtps`** pure utility for testing FTPS handshake + certificate
  chain without committing to a full client connection.
- **`server_kind = "starserver"`** quirk preset bundling Star
  Server-specific defaults (hostname-only TLS, PASV behavior, etc.).
- **FtpClient helper methods** for use in doctor and import tooling.

---

## [0.2.0] — 2026-05-19

### Added

- **`aiftp import filezilla`** — FileZilla `sitemanager.xml` importer
  with passwords routed to Keychain. Handles plain-text and
  master-password-encrypted XML.
- **`aiftp profile export filezilla`** — round-trip back to FileZilla
  XML (passwords excluded by default).
- **`aiftp doctor`** — 12 diagnostic checks (config, gitignore,
  keychain, DNS, TCP, FTPS, cert chain, PASV, MLSD, SIZE,
  remote_root CWD, encoding sniff).
- **`aiftp config migrate`** — v1 → v2 schema migration with atomic
  write, `.aiftp.toml.v1.bak` preservation, multi-run guard, audit
  log in `.aiftp/logs/migrations.jsonl`.
- **MCP two-step push gate**: `aiftp_push(dry_run=false)` is now
  refused. Real pushes require `aiftp_push_prepare` →
  `aiftp_push_confirm` with matching `plan_id`, `diff_hash`,
  `confirm_token`. Plans expire after 5 minutes.
- **`aiftp://config` MCP resource redaction** — host / user /
  remote_root / keychain_service no longer exposed.
- **`[encoding]` and `[quirks]` schema v2 sections** —
  Shift_JIS file names, NAT'd PASV addresses, MLSD-less servers, etc.

### Documentation

- README major rewrite.
- `docs/compatibility-matrix.md` created.
- `docs/migration-from-ffftp.md` created.

---

## [0.1.1] — 2026-05-19

### Added

- **`aiftp init`** UX improvements: warning on `/`-prefixed
  `remote_root`, template for `server_kind = "starserver"`.
- **TLS hostname mismatch diagnostics** in `FtpClient` — surfaces
  `cert.subject.CN` and `cert.subjectaltname` plus a recommended
  action. **Does not auto-bypass.**
- **`backup restore` hardening**: empty snapshot id → clear error,
  snapshot id format validation, `--output` path-traversal guard,
  existing-file `--force` requirement.
- **SJIS file name regression test** for `restoreFile`.

---

## [0.1.0] — 2026-05-19 — First public MVP

### Added

- **Core**: TOML config schema v1, diff engine, deploy pipeline,
  encrypted local backup (AES-256-GCM), OS Keychain credential
  storage (macOS `security`), pre-flight checks (`php -l`, JSON, HTML).
- **CLI**: `init`, `status`, `push`, `pull`, `backup`, `auth`,
  `verify`, `restore`.
- **MCP server**: `aiftp_status`, `aiftp_push` (dry-run),
  `aiftp_backup_list` / `_restore` / `_verify` / `_prune`,
  `aiftp_log`, `aiftp_list_remote`.
- **Hard-excluded files**: `.env*`, `wp-config.php`, `*.pem`,
  `db.php`, etc. — cannot be uploaded, backed up, or restored.
- **Server-side lock file** preventing concurrent agent pushes.
- **Star Server verified** end-to-end on the maintainer's production
  hosting.

### Notes

- Phase 1.1 follow-ups (auto-mkdir, init UX, TLS diagnostics)
  landed in v0.1.1.
- Phase 2 work (import / watch / hook / multi-profile / rollback)
  followed across v0.2.x – v0.9.1.

---

[Unreleased]: https://github.com/aiftp-tools/aiftp/compare/v0.9.2...HEAD
[0.9.2]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.2
[0.9.1]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.1
[0.9.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.0
[0.8.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.8.0
[0.7.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.7.0
[0.6.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.6.0
[0.5.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.5.0
[0.4.2]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.4.2
[0.4.1]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.4.1
[0.4.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.4.0
[0.3.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.3.0
[0.2.5]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.5
[0.2.4]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.4
[0.2.3]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.3
[0.2.2]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.2
[0.2.1]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.1
[0.2.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.0
[0.1.1]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.1.1
[0.1.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.1.0
