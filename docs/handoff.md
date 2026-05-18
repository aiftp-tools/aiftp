# AIftp Handoff

Updated: 2026-05-18 19:42 JST

## Current Status

Working directory: `/Users/ytanaka/Projects/Web/AIftp/aiftp`

This checkout is mid-MVP implementation. No commit or push has been made in the
current work session.

Implemented so far:

- Day 6: local state management
  - `packages/core/src/state.ts`
  - `packages/core/src/state.spec.ts`
- Day 7: diff engine
  - `packages/core/src/diff.ts`
  - `packages/core/src/diff.spec.ts`
- Day 8: encrypted file format and AES-256-GCM helpers
  - `packages/core/src/encryption.ts`
  - `packages/core/src/encryption.spec.ts`
- Day 9: encrypted backup store
  - `packages/core/src/backup/store.ts`
  - `packages/core/src/backup/store.spec.ts`
- Day 10: deploy/status core flow
  - `packages/core/src/deploy.ts`
  - `packages/core/src/deploy.spec.ts`
- Day 11: preflight checks and deploy integration
  - `packages/core/src/preflight.ts`
  - `packages/core/src/preflight.spec.ts`
- Day 12: CLI `init` and `auth`
  - `packages/cli/src/index.ts`
  - `packages/cli/src/index.spec.ts`
  - `packages/cli/src/bin.ts`
- Day 13: CLI `status`, `push`, `push --dry-run`, `log`, `backup`
  - `push --dry-run` works without FTP connection
  - real `push` now resolves FTP credentials from Keychain and uses `FtpClient`
  - `.aiftp/`, `.git/`, and `.aiftp.toml` are excluded from deploy diff by default
- Day 14: MCP server entrypoint and CLI `aiftp mcp`
  - `packages/mcp/src/index.ts`
  - `packages/mcp/src/index.spec.ts`
  - `docs/mcp.md`

Dependencies added:

- CLI package:
  - `commander`
  - `prompts`
  - `@types/prompts`
  - `@aiftp-tools/mcp`
- MCP package:
  - `@modelcontextprotocol/sdk`
  - `zod`

## Verification

Latest successful checks:

```bash
pnpm lint
pnpm typecheck
pnpm build
CI=true pnpm test
CI=true pnpm test:coverage
```

Latest full test result:

- Test files: 14 passed
- Tests: 194 passed, 15 skipped

Latest coverage:

- Statements: 86.15%
- Branches: 82.26%
- Functions: 92.59%
- Lines: 86.15%

Note: full tests and coverage require sandbox escalation because FTP integration
tests use local listening sockets.

## Git State To Expect

Modified:

- `packages/cli/package.json`
- `packages/cli/src/bin.ts`
- `packages/cli/src/index.spec.ts`
- `packages/cli/src/index.ts`
- `packages/core/src/index.ts`
- `packages/mcp/package.json`
- `packages/mcp/src/index.spec.ts`
- `packages/mcp/src/index.ts`
- `pnpm-lock.yaml`

Untracked:

- `docs/`
- `packages/core/src/backup/`
- `packages/core/src/deploy.spec.ts`
- `packages/core/src/deploy.ts`
- `packages/core/src/diff.spec.ts`
- `packages/core/src/diff.ts`
- `packages/core/src/encryption.spec.ts`
- `packages/core/src/encryption.ts`
- `packages/core/src/preflight.spec.ts`
- `packages/core/src/preflight.ts`
- `packages/core/src/state.spec.ts`
- `packages/core/src/state.ts`

## Important Constraints

- Do not push or commit without explicit approval.
- Do not touch real production FTP paths directly.
- StarServer/GWco testing must use a test subdirectory first, not `/public_html`
  root.
- Do not write passwords to config files or command arguments.
- Plain FTP is only allowed when `safety.require_tls = false`; FTPS remains the
  default.

## Next Recommended Steps

1. Review current diff once:

```bash
git diff --stat
git diff -- packages/cli/src/index.ts packages/mcp/src/index.ts
```

2. Run local checks again if the session resumed cold:

```bash
pnpm lint
pnpm typecheck
pnpm build
CI=true pnpm test
CI=true pnpm test:coverage
```

3. Proceed to Day 15 only after confirming the diff:

- create/configure `.aiftp.toml` for the GWco project
- register credentials in Keychain
- run `aiftp status`
- run `aiftp push --dry-run`
- perform the first real push only to a test subdirectory
- verify encrypted backup creation and restore

4. Only after test-subdirectory verification, decide whether to prepare a scoped
commit. Do not deploy to production root without a separate explicit approval.
