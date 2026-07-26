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

Available resources:

- `aiftp://config`
- `aiftp://state/{profile}`
- `aiftp://backups/{profile}`
