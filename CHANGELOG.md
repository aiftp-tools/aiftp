# Changelog

All notable changes to **aiftp** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release tags live in the GitHub repository:
<https://github.com/aiftp-tools/aiftp/releases>

---

## [Unreleased]

(Pending work for v0.11+.)

---

## [0.10.3] — 2026-05-24

**Quality patch** — reflective release closing the prompt-validation coverage gap surfaced by v0.10.1 / v0.10.2. 田中さんの指摘 ("port は標準ポート以外なら確認すべき / 非正常系のテストはどの程度か") への対応。

### Added

- **`aiftp init`** now warns and asks for explicit confirmation when the FTP port is non-standard. Standard ports are `21` (FTP) and `21` or `990` (FTPS implicit); any other value triggers a `Non-standard FTPS port 8021 (standard: 21 or 990). Continue?` confirmation. Declining aborts init with `aborted: non-standard FTP/FTPS port N was not confirmed`. ([F-X8 / v0.10.3])

### Tests

- `packages/core/src/encryption.spec.ts`: +6 branch-coverage tests (empty buffer / payload too short / invalid magic / unsupported algorithm / corrupted auth tag / encrypted file too short). `encryption.ts` Branches coverage **61.53% → 83.87%** (+22.34 pp).
- `packages/cli/src/index.spec.ts`: +4 init non-standard-port tests (confirm-yes / confirm-no / FTPS 990 standard / port 990 over plain FTP).

### Quality gates (post-fix)

| Metric | v0.10.2 | v0.10.3 |
|---|---|---|
| Statements coverage | 89.99% | **90.25%** |
| Branches coverage | 82.81% | **83.29%** |
| Functions coverage | 95.36% | **95.36%** |
| Total tests | 580 | **590** (+10) |

### Process improvements

CLAUDE.md / memory.md に "prompt 実装時のチェックリスト" を追記する方針を確認:

- [ ] 全 prompt 型 (`text` / `password` / `number` / `select` / `confirm`) を横断 review
- [ ] 各型で空 / 不正値 / 境界値 (`Infinity`, `NaN`, 範囲外) を listing
- [ ] Branches coverage が 80% 未満のファイルは PR ブロック対象
- [ ] 非対話的 mock テストとは別に、実機 smoke test を CI 化 (next milestone)

---

## [0.10.2] — 2026-05-24

**Patch release** — follow-up to v0.10.1 closing the same-day `aiftp init` UX gap.

### Fixed

- **`aiftp init`** now validates the **FTP port** prompt as well. The v0.10.1 fix (#7) added per-prompt validation only to `text` / `password` prompt types; the `number` type port prompt was left untouched, and in certain input sequences the `prompts` library returned `-Infinity` for it, causing init to fail at the end with `port must be an integer`. The port prompt now enforces `min: 1, max: 65535` with a descriptive `validate` callback. The terminal `parseInitAnswers` validator was also tightened with a dedicated `requirePort` helper that rejects out-of-range integers with an explicit error message (`port must be between 1 and 65535 (e.g. 21 for FTP, 990 for FTPS implicit)`). ([#8 — F-X7](https://github.com/aiftp-tools/aiftp/issues/8))

### Tests

- Two regression guards added in `packages/cli/src/index.spec.ts`:
  - `init rejects -Infinity port`
  - `init rejects port outside 1-65535 range`

---

## [0.10.1] — 2026-05-24

**Patch release** — quick follow-ups from v0.10.0 field verification (Xserver, Sakura) and npm publish smoke test (Lolipop fresh init).

### Fixed

- **`aiftp init`** now provides a sensible default for the **Keychain service** prompt (`aiftp:<profile-name>`). Previously the prompt was empty, and pressing Enter silently advanced past the field; init then failed at the final step. ([#6 — F-X5](https://github.com/aiftp-tools/aiftp/issues/6))
- **`aiftp init`** now validates required fields **per prompt** (host / user / remoteRoot / localRoot / keychainService / password). Empty input is rejected on the spot instead of letting all prompts complete and then aborting at validation. ([#7 — F-X6](https://github.com/aiftp-tools/aiftp/issues/7))

### Changed

- `DEFAULT_EXCLUDE_PATTERNS` now uses the glob `.aiftp.toml.*` instead of the literal `.aiftp.toml.bak`. This covers arbitrary backup suffixes (`.bak`, `.before-vXXX`, `.old`, …) and prevents accidental leakage of pre-upgrade config snapshots — observed on Xserver during v0.10.0 field verification. ([#3 — F-X1](https://github.com/aiftp-tools/aiftp/issues/3))

### Documentation

- `docs/v0.10.0-field-verification.md` §4/§6/§8 now explicitly call out that `local_root = "."` recurses into ALL subdirectories under the working directory, and that archive / scratch directories MUST live **outside** the working directory. ([#4 — F-X2](https://github.com/aiftp-tools/aiftp/issues/4))

### npm registry

All three packages are published under the `@aiftp-tools` scope:

- [`@aiftp-tools/cli`](https://www.npmjs.com/package/@aiftp-tools/cli) (renamed from unscoped `aiftp` due to npm spam protection; bin name `aiftp` preserved)
- [`@aiftp-tools/core`](https://www.npmjs.com/package/@aiftp-tools/core)
- [`@aiftp-tools/mcp`](https://www.npmjs.com/package/@aiftp-tools/mcp)

```bash
npm install -g @aiftp-tools/cli
aiftp --version  # → 0.10.1
```

---

## [0.10.0] — 2026-05-23

**Breaking release** — Snapshot manifest schema 1 → 2, remote delete/prune semantics, and MCP rollback confirmation contract change.

See [`docs/migration-v0.10.0.md`](docs/migration-v0.10.0.md) for migration guidance.

### Breaking changes

- Snapshot manifest schema bumped to `2`. v0.9.x cannot read schema 2 manifests; downgrade is unsupported once v0.10.0 has written a snapshot to `.aiftp/`. Restore from manual backup of `.aiftp/` if a downgrade is required.
- `aiftp_rollback_confirm` (MCP) now **requires** `acknowledge_deletions: true` when the corresponding prepare returned `plannedDeletes.length > 0`. Rollback was previously single-factor (`confirm_token`); it is now 2-factor in line with `aiftp_push_confirm`.
- `diff_hash` format updated to `aiftp-push-plan-v2` / `aiftp-rollback-plan-v2`. The hash input now includes both upload and delete sets. Older hashes are rejected on confirm.

### Added

- **Snapshot schema 2**: per-file `operation` field (`"added" | "modified" | "removed"`) and manifest-level `counts: { added, modified, removed }`. `added` files are recorded as tombstones (no content stored) so rollback can issue a real `delete`.
- **`[safety].deletion_policy`** config (default `"never"`): `"never"` / `"prune-auto"` / `"prune-with-confirm"`. Default preserves v0.9.x behavior.
- **CLI `aiftp push` interactive delete confirmation**: when `deletion_policy = "prune-with-confirm"` and at least one remote delete is planned, the CLI now requires the operator to type `DELETE` at an interactive prompt before mutating. There is no `--confirm-deletes` flag — the typed-prompt is the only confirmation path (intentionally, to prevent muscle-memory `y`/Enter from deleting production files).
- **CLI `aiftp rollback`** now issues a real remote `delete` for `added` tombstones in the target snapshot. Dry-run output now shows planned deletes alongside planned uploads.
- **MCP `aiftp_push_prepare` / `aiftp_push_confirm`** now bind `plannedDeletes`, `expected_delete_count`, and re-run the dry-run on confirm to detect drift in both upload and delete sets.
- **MCP `aiftp_rollback_prepare` / `aiftp_rollback_confirm`** now bind `plannedDeletes`, surface `deleted` in the confirm response, and require `acknowledge_deletions: true` when deletes are planned (see Breaking changes).
- **New docs**: [`docs/migration-v0.10.0.md`](docs/migration-v0.10.0.md), [`docs/v0.10.0-field-verification.md`](docs/v0.10.0-field-verification.md).

### Changed

- `max_files_per_push` now counts uploads + deletes combined (was upload-only).
- Hard-exclude (`wp-config.php`, `.env*`, `db.php`, ...) now applies to both upload AND delete planning. Auth-bearing files are NEVER deleted or rolled back.
- `runPush` schedules upload first, then delete second; snapshot creation happens before any remote mutation (push or delete) so every push remains reversible.
- `rollback` delete intentionally does NOT swallow `FtpNotFoundError` (FTP 550): on Sakura / Lolipop the same code can also mean "permission denied", so the error surfaces to the caller.
- MCP `aiftp_push` (direct dry-run tool) now wires `deletion_policy` into the underlying `runPush` `safety` block. Previously direct dry-run preview always showed `plannedDeletes: []`.

### Fixed

- `restoreAll()` JSDoc now documents the schema 2 tombstone throw behavior. (`restoreAll()` itself has no production callers in v0.10.0; the public surface is reserved for future runtime adapters.)
- Stale `default-store.spec.ts` assertion (`fileCount === 0` for added-only push) aligned with schema 2 semantics (`fileCount === 1` for one tombstone).

### Internal

- New `PushBackupStore` interface in `@aiftp-tools/core` minimizes the backup-store contract that `runPush` requires, eliminating `as unknown as` casts in MCP and CLI runtime/dry-run wiring.
- `SnapshotCounts` is now re-exported from `@aiftp-tools/core` root index.

---

## [0.9.5] — 2026-05-22

Release-check hardening patch for v0.9.4.

### Fixed

- `pnpm test` and `pnpm test:coverage` now generate the core
  `VERSION` module before Vitest imports `@aiftp-tools/core`, so a
  fresh clone no longer depends on an ignored local
  `packages/core/src/version.generated.ts` file.
- `aiftp push --dry-run` no longer requires an initialized backup key.
  The CLI now mirrors the MCP dry-run path and uses a no-op backup store
  because core never creates snapshots during dry runs.

### Tests

- Added regression coverage for backup-key-free CLI dry runs, root
  test-script version generation, and `[walk] follow_symlinks` behavior.

---

## [0.9.4] — 2026-05-22

UX / init hardening patch — four small features bundled together so
the v0.10.0 snapshot redesign starts from a less footgun-prone base.

### Fixed

- **Default-exclude rules are now actually applied.** Prior to v0.9.4,
  `DEFAULT_EXCLUDE_PATTERNS` (`.aiftp.toml`, `.aiftp/`, `.git/`) was
  only respected when the CLI / MCP layers manually merged it into
  `userPatterns`. The A-7 verification accidentally uploaded the
  operator's `doctor-*.txt` / `doctor-*.json` files to a Sakura test
  account because that merge happened in some codepaths but not
  others. `Excluder` now auto-applies the list internally (controlled
  by a new `useDefaults` option, default `true`), and the manual
  merges in CLI / MCP / `default-store.ts` were removed to avoid
  double-prepending.

### Added

- **Expanded `DEFAULT_EXCLUDE_PATTERNS`**: `doctor-*.{txt,json}`,
  editor swap files (`*.swp`, `*.swo`, `*~`, `#*#`, `.#*`), OS
  metadata (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`), and
  VCS metadata (`.gitignore`, `.gitattributes` joined the existing
  `.git/`). All are gitignore-style soft excludes so an operator
  who legitimately needs to ship a `.DS_Store` can opt back in via
  a `!` negation pattern.
- **`[exclude] use_defaults` config option** (default `true`). Set
  to `false` in `.aiftp.toml` to skip the defaults entirely.
- **`[walk] follow_symlinks` config option** (default `false`).
  The file walker now explicitly documents and controls symlink
  behaviour. Setting it to `true` lets the walker resolve symlinks
  via `stat()`, useful for operators sharing fixture directories
  via `ln -s`. The A-7 verification hit this when
  `~/aiftp-verify/sakura/index.html` was a symlink and produced
  `added=0`; opting in now fixes that.
- **`packages/core/scripts/generate-version.mjs`** auto-generates
  the runtime `VERSION` constant from `packages/core/package.json`
  at build time (`prebuild` / `pretypecheck` hooks). The generated
  file `packages/core/src/version.generated.ts` is gitignored. This
  closes the "v0.9.2 shipped twice with `aiftp --version` reporting
  `0.0.0`" footgun: bumping the package version is now enough.
- **New `aiftp backup init` CLI command**. Creates a fresh
  AES-256-GCM backup key in the OS keychain for a profile without
  re-running `aiftp init` (which would overwrite `.aiftp.toml`).
  Use this after hand-editing `.aiftp.toml` to add a profile. The
  `--force` flag overwrites an existing key (and breaks all prior
  encrypted snapshots — there's a loud warning).
- **Friendlier error from `default-store` when the backup key is
  missing**: previously surfaced the bare
  `Keychain entry not found: service=... account=...`; now wraps
  it in a `BackupError` whose message includes the exact
  `aiftp backup init --profile <name>` command to fix it. The
  underlying error is preserved as `cause` for debugging.

### Documentation

- `Excluder.getEffectivePatterns()` now returns the defaults as
  part of the user-pattern list (per the new auto-apply behaviour).
  Two tests in `exclude.spec.ts` were updated to reflect the new
  expectation and a new test was added for the `useDefaults: false`
  opt-out path.
- `default-exclude.spec.ts` is new (16 cases covering the A-7
  leak vector, hard-exclude precedence, user negation, and opt-out).

### Notes

- Test suite at v0.9.4: **530 passed / 3 skipped** across 30 files.
- No `.aiftp.toml` schema changes beyond the two new optional
  fields (`exclude.use_defaults`, `walk.follow_symlinks`); existing
  configs continue to load.
- v0.10.0 (snapshot semantic redesign — `docs/v0.10.0-plan.md`)
  remains the next planned release; v0.9.4 closes out the small
  hardening work first so the v0.10.0 PR series can focus on data
  model changes.

---

## [0.9.3] — 2026-05-22

Safety hardening patch — two targeted fixes that came out of A-7
multi-provider verification on the day after v0.9.2 shipped.

### Fixed

- **`certificateMatchesHost` now supports RFC 6125 single-label
  leading wildcards.** Previously it did exact-string matching only,
  so `*.sakura.ne.jp` did not match `<user>.sakura.ne.jp` and
  `ftps-cert: warn` fired spuriously on every Sakura / Xserver /
  Lolipop hostname (all three use shared wildcard certs). The
  matcher now follows §6.4.3 of RFC 6125:
  - exact match always wins
  - `*.example.com` matches exactly one host label
    (`foo.example.com`, not `foo.bar.example.com` and not
    `example.com`)
  - middle wildcards (`foo.*.example.com`), trailing wildcards
    (`example.*`), bare `*`, and `*.` are refused
  - matching is case-insensitive (DNS names are case-insensitive)
  - both the CN and every SAN are tested
  See `packages/core/src/diagnostics/cert-match.spec.ts` for the
  full table of accepted / rejected patterns (22 cases).

### Added

- **`aiftp doctor` now has a dedicated `ftp-auth` check** (split
  out of `ftps-handshake`). Before v0.9.3 a wrong password and a
  broken TLS handshake both reported as `ftps-handshake: fail`,
  which during A-7 verification cost about an hour of debugging a
  "TLS issue" that was actually a typo'd password. Now:
  - `ftps-handshake`: TLS layer only — pass if the TLS handshake
    completes (cert obtained, cipher negotiated)
  - `ftp-auth`: USER/PASS only — pass if login succeeds, fail with
    `recommendation: aiftp auth set --profile <name>` if the
    server returns 530, skip when handshake failed first or the
    probe stub didn't separate the two phases
  The CLI's `probeFtps` wrapper classifies `FtpAuthError` /
  `FtpTlsError` from the core FTP client so the new split is
  driven by the real underlying error, not by string-matching
  the message.

### Documentation

- CHANGELOG entry for v0.9.3 lists the cert-match rules
  explicitly so operators can predict whether their provider's
  shared cert will pass without `tls_check_hostname=false`.

### Known limitations (still planned for v0.9.4 / v0.10.0)

- VERSION constant in `packages/core/src/index.ts` still has to
  be hand-bumped alongside the four package.json files; v0.9.4
  will auto-generate it at build time.
- `local_root = "."` still walks every file in the working
  directory; v0.9.4 will introduce a default-exclude list.
- `aiftp init` is still the only path that creates
  `.aiftp/backups/`; v0.9.4 will add an auto-init path or a
  clearer error.
- Snapshot semantic for added-only push is still metadata-only;
  v0.10.0 (`docs/v0.10.0-plan.md`) is the redesign.

### Notes

- Test suite at v0.9.3: **508 passed / 3 skipped** across 29 files.
- No schema changes from v0.9.2 → v0.9.3.

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
  targets. This was discovered during A-7 verification against a
  freshly-contracted Sakura Rental Server test account and confirms
  the spec's "every push is reversible" promise.

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
   `*.sakura.ne.jp` does not match `<user>.sakura.ne.jp` in
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

[Unreleased]: https://github.com/aiftp-tools/aiftp/compare/v0.9.5...HEAD
[0.9.5]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.5
[0.9.4]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.4
[0.9.3]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.3
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
