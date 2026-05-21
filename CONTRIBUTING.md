# Contributing to aiftp

Thanks for considering a contribution! aiftp is open-core software
([MIT licensed Free tier](LICENSE), proprietary Pro tier in development).
This document describes how to contribute to the Free tier.

🇯🇵 日本語で issue / PR を書いていただいて構いません。レビューも日本語可。

---

## Ground rules (non-negotiable)

These are design invariants. PRs that loosen any of these will be
closed, regardless of how well they're tested.

1. **No auto-push.** Every real upload requires explicit operator
   action (CLI `--confirm`-equivalent flow, or MCP
   `prepare → confirm` token round-trip). aiftp will never push on
   its own — not on a hook, not on file save, not on AI agent
   instruction alone.
2. **Encryption-by-default for backups.** Local backup files are
   AES-256-GCM encrypted with a key derived from the OS keychain.
   There is no option to disable this in the Free tier.
3. **Credentials never enter TOML, logs, or MCP responses.**
   Passwords live in the OS keychain (macOS Keychain / Windows
   Credential Manager) and are passed only as in-process secrets.
   Logging code MUST mask password-like values.
4. **Hard-excluded files.** `.env*`, `wp-config.php`, `*.pem`,
   `db.php`, `*.key`, and the patterns listed in
   `packages/core/src/exclude.ts` cannot be uploaded, cannot be
   backed up, and cannot be restored. This list grows; it never
   shrinks.
5. **Two-step MCP gate for destructive operations.** `push`,
   `backup_restore`, `config_migrate`, `import_filezilla`,
   `import_ffftp`, `rollback` all require
   `*_prepare` → `*_confirm` with matching `plan_id`, `diff_hash`,
   and short-lived `confirm_token`.
6. **TLS hostname mismatch is diagnosed, never silently bypassed.**
   `doctor` surfaces the cert chain; the operator must explicitly
   set `[safety] verify_certificate = false` per-profile if they
   accept the risk.

If you're unsure whether your contribution conflicts with one of
these, open a Discussion first.

---

## Development workflow

aiftp is a pnpm monorepo with three packages: `core`, `cli`, `mcp`.

### Prerequisites

- Node.js **22 LTS** or newer
- pnpm **9+**
- macOS or Windows (Linux is supported for development but not
  primary-tested for `keychain` flows)

### Initial setup

```bash
git clone https://github.com/aiftp-tools/aiftp.git
cd aiftp
pnpm install
pnpm vitest run            # 485+ tests at v0.9.1
pnpm -r typecheck
pnpm biome check packages
```

If any of the above fail on a fresh clone, that's a bug — open an issue.

### Tests are required for behavior changes; test-first is strongly preferred

aiftp's safety properties depend on a tight test suite. The
expectation:

1. **Behavior changes need tests.** A PR that changes runtime
   behavior without adding or updating tests will be asked to add
   coverage before merge.
2. **Test-first is the recommended flow** — write the failing test
   first (RED), make it pass with the minimum code (GREEN), then
   refactor (REFACTOR). For safety-critical changes (anything
   touching the MCP two-step gate, hard-exclude list, backup
   encryption, credential handling, or rollback semantics), the
   maintainer may ask you to produce a failing regression test
   *before* the implementation lands.
3. We care about the test contract more than policing the exact
   order in which lines of code were typed. If your test exercises
   the behavior properly, post-hoc or test-first both review the
   same way.
4. PR titles follow Conventional Commits: `<type>: <description>`.

Target coverage: **80%+** (current is around that). Small doc-only
or test-only PRs don't need to hit that bar themselves.

### Coding style

- TypeScript strict mode, no `any` (use `unknown` and narrow)
- Immutable updates only (`{ ...obj, field: newValue }`), no mutation
- Files under 800 lines, functions under 50 lines (soft caps)
- Errors handled explicitly at boundaries (FTP responses, file I/O,
  user input, network)
- File names: `kebab-case.ts`; types: `PascalCase`; functions: `camelCase`;
  constants: `SCREAMING_SNAKE_CASE`

See `~/.claude/rules/typescript/coding-style.md` for the full ruleset
that maintainers use during review.

---

## Pull request process

1. **Open an issue or discussion first** if your change is non-trivial
   (anything bigger than a doc fix or test addition). This prevents
   wasted work.
2. **Branch from `main`**. Branch naming:
   - `feat/<short-description>` for new features
   - `fix/<short-description>` for bug fixes
   - `docs/<short-description>` for documentation
   - `claude/<...>` if work was done with Claude Code (per session-safety convention)
   - `codex/<...>` if work was done with Codex
3. **Keep PRs small.** One concern per PR. If you find yourself
   touching unrelated files, split.
4. **Update docs.** README, `docs/spec.md`, `docs/compatibility-matrix.md`
   as appropriate. PR template will remind you.
5. **All checks must pass.** CI runs typecheck, biome, and vitest on
   macOS + Windows. PRs with failing CI will not be reviewed until
   green.
6. **Use the PR template.** It exists to save time on the safety-review
   checklist.

---

## Code review

- Maintainers will review within ~3 business days. If we miss that,
  ping the PR.
- Reviews focus on: safety invariants, test coverage, TypeScript
  type quality, naming, and whether the change matches an existing
  pattern.
- We use Conventional Comments style (`nit:`, `suggestion:`,
  `question:`, `issue:`). Anything not labeled is required.

---

## Reporting bugs

See [`.github/ISSUE_TEMPLATE/bug_report.yml`](.github/ISSUE_TEMPLATE/bug_report.yml).

**Please redact credentials** before pasting any logs or
`doctor` output.

---

## Reporting security issues

**Do not file public issues for security bugs.** Use GitHub Security
Advisories: <https://github.com/aiftp-tools/aiftp/security/advisories/new>

See [SECURITY.md](SECURITY.md) for details.

---

## Communication

- **Issues**: bugs and concrete feature proposals
- **Discussions**: open-ended questions, design ideas, hosting
  compatibility chatter
- **Security advisories**: vulnerabilities only

---

## License

By submitting a contribution, you agree that it will be released
under the [MIT License](LICENSE). aiftp does not use a CLA; the DCO
applies via the standard "by opening this PR I assert I have the
right to contribute this code" convention.

If your contribution depends on a new third-party package, please
verify in your PR description that the package is licensed under
MIT / ISC / BSD / Apache-2.0 (no copyleft). See [NOTICE.md](NOTICE.md)
for the current license inventory.

---

## Recognition

Contributors are listed in GitHub's automatic contributor graph. We
don't maintain a separate AUTHORS file. Substantial contributions
(features, significant bug fixes) are called out in release notes.

Thanks for helping make AI-assisted deployment safe!
