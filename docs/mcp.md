# MCP Setup

`aiftp mcp` starts the aiftp MCP server over stdio. Add this to the MCP client
configuration for a local checkout:

Run `pnpm build` first so the CLI entry point exists in `packages/cli/dist/`.

Recommended (launch Node directly to keep MCP stdio clean):

```json
{
  "mcpServers": {
    "aiftp": {
      "command": "node",
      "args": ["<repo>/packages/cli/dist/bin.js", "mcp"]
    }
  }
}
```

The following pnpm-based configuration can fail because pnpm logging may pollute
stdio and break the MCP connection:

```json
{
  "mcpServers": {
    "aiftp": {
      "command": "pnpm",
      "args": ["--dir", "/Users/ytanaka/Projects/Web/AIftp/aiftp", "exec", "aiftp", "mcp"]
    }
  }
}
```

For an installed package, use:

```json
{
  "mcpServers": {
    "aiftp": {
      "command": "npx",
      "args": ["-y", "@aiftp-tools/cli", "mcp"]
    }
  }
}
```

Available tools:

Read-only (safe, no confirmation):

- `aiftp_status`
- `aiftp_log`
- `aiftp_list_remote`
- `aiftp_profile_current`
- `aiftp_profile_list`
- `aiftp_profile_test`
- `aiftp_sites_list` — list sites registered in the global registry (`~/.aiftp/sites.toml`), redacted (no credentials)
- `aiftp_setup_status` — report pass/fail for 6 checks (bootstrap, project_dir, config_file, credential, registry, confirm_phrase), each with a Japanese `hint` on failure. Aimed at the Claude Desktop `.mcpb` extension: the report is built from a startup report that only the Desktop extension writes, so from a terminal MCP client this tool returns a single `bootstrap-missing` check.
- `aiftp_init_template_list`
- `aiftp_backup_list`
- `aiftp_backup_verify`

State-changing (two-step `prepare` → `confirm` token gate):

- `aiftp_push` (dry-run preview) · `aiftp_push_prepare` · `aiftp_push_confirm`
- `aiftp_rollback` (dry-run preview) · `aiftp_rollback_prepare` · `aiftp_rollback_confirm`
- `aiftp_backup_restore` · `aiftp_backup_restore_prepare` · `aiftp_backup_restore_confirm`
- `aiftp_backup_prune`
- `aiftp_import_filezilla` · `aiftp_import_filezilla_prepare` · `aiftp_import_filezilla_confirm`
- `aiftp_config_migrate` · `aiftp_config_migrate_prepare` · `aiftp_config_migrate_confirm`

The registry is **read-only over MCP**: there is no tool to write or mutate
`~/.aiftp/sites.toml` from an AI client. Registration happens only through the
`aiftp sites add` / `aiftp init` CLI paths.

### `aiftp_push_confirm`'s `confirmation` argument (v0.13)

`aiftp_push_confirm` accepts an optional `confirmation` string argument:
`"<challenge> <phrase>"`. It only matters when the server was started with
`AIFTP_CONFIRM_PHRASE` set in its environment:

- **`AIFTP_CONFIRM_PHRASE` unset** (the default for a terminal/Claude Code MCP
  client): behaviour is unchanged from v0.12. A production-profile push still
  requires `acknowledge_production: true`; `confirmation` is not required and
  is ignored.
- **`AIFTP_CONFIRM_PHRASE` set**: `aiftp_push_prepare` additionally returns a
  `confirmation_challenge` for a push that needs production confirmation, and
  `aiftp_push_confirm` is rejected unless called with
  `confirmation: "<challenge> <phrase>"` where `<phrase>` matches the
  configured secret. This is an opt-in hardening for terminal use; it is
  always-on and fail-closed in the Claude Desktop `.mcpb` extension (see
  `docs/desktop-extension.md`).

**Which pushes need production confirmation.** Two separate decisions, kept
separate on purpose — `.aiftp.toml` is a file the AI being gated can edit, so
it cannot be the only input to an authorization decision:

- *Display* (`prod_profile_warning` in the prepare response) always follows
  `safety.prod_profile_patterns` and `safety.warn_on_prod_profile`.
- *Authorization* (the `acknowledge_production` + confirm-phrase gate) follows
  the same patterns **outside** Desktop mode, but in Desktop mode
  (`AIFTP_DESKTOP=1`, set by the `.mcpb` server entry point) it is
  unconditionally required for every profile. `safety.*` can widen the gate
  there; it cannot narrow it. Outside Desktop mode nothing changed from
  v0.12 — `warn_on_prod_profile = false` still works as a CI escape hatch,
  and the messages are byte-identical.

**One challenge, one attempt.** A `confirmation` that does not match consumes
the plan: `plan_id` is discarded and `aiftp_push_prepare` must be called again
for a fresh challenge. The challenge is public (it is returned to the caller),
so the phrase is the only secret in the pair and unlimited retries against one
challenge would make a human-chosen phrase guessable. Non-secret mistakes — a
missing `acknowledge_production`, a stale `diff_hash`, a bad `confirm_token` —
do **not** consume the plan.

### Destination binding (v0.13)

`aiftp_push_prepare` and `aiftp_rollback_prepare` fingerprint the destination
they planned against: host, port, protocol, user, keychain service, remote
root, the TLS-related settings (`safety.require_tls`,
`safety.verify_certificate`, `quirks.tls_check_hostname`) and the production
classification. The matching `_confirm` recomputes that fingerprint from the
freshly-read config immediately before it uploads, and refuses with a
`destination-changed:` error naming the changed components when it differs.

Without this, editing `.aiftp.toml`'s `host` or `user` between prepare and
confirm would send the upload — and the deletes — to a server the operator
never approved, while the `diff_hash` drift check still passed, because the
remote root and file set were unchanged. Only hashes are stored and compared,
and the refusal names components (`host`, `user`) rather than echoing values.

### `aiftp_rollback_confirm`'s `acknowledge_production` argument (v0.13.0, breaking change)

`aiftp_rollback_prepare` now returns `prod_profile_warning: true` when the
profile matches `safety.prod_profile_patterns`. When the plan needs production
confirmation,
`aiftp_rollback_confirm` refuses (schema-rejects a literal `false`, and
refuses at runtime when the argument is simply omitted) unless called with
`acknowledge_production: true`.

Two things about this gate are decided separately, for different reasons.

**Which plans are gated** follows the same rule as push, including the Desktop
floor: outside Desktop mode it is `safety.prod_profile_patterns` /
`safety.warn_on_prod_profile`; in Desktop mode `acknowledge_production` is
required for every profile regardless of `safety.*`. The reason is the same one
that applies to push — `.aiftp.toml` is a file the AI being gated can edit — and
it applies here with more force, because rollback deletes remote files. The
destination binding below applies to rollback too.

**What satisfies the gate** is `acknowledge_production: true` alone.
`aiftp_rollback_confirm` never requires, checks, or mentions the confirm
phrase, on any server configuration. Rollback is the recovery path — an
operator who has lost or misconfigured the confirm phrase must still be able to
undo a bad push, or a fixable incident becomes a permanently broken site with
no way back short of a terminal. That reasoning justifies not demanding the
phrase; it does not justify letting a config edit remove the gate, which is why
the two are settled independently.

**Breaking change**: a v0.12 terminal/CLI user calling `aiftp_rollback_confirm`
against a profile matching `safety.prod_profile_patterns` (default patterns:
`prod*`, `production*`, `main*`) must now also pass
`acknowledge_production: true`, matching the requirement
`aiftp_push_confirm` already had. Rollbacks against non-prod profiles are
unaffected — no new argument is required.

### MCP prompt

The server registers one MCP **prompt**, `aiftp_setup` — this is the first
prompt this repository has shipped. It walks an operator through onboarding
in four steps (connection check → test-area push → production push behind
the confirm phrase → rollback demo) in Japanese. A client that only lists
tools, not prompts, will not see it; `aiftp_setup_status` and the tool
descriptions above remain fully usable without it.

Available resources:

- `aiftp://config`
- `aiftp://state/{profile}`
- `aiftp://backups/{profile}`
