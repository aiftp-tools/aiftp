# MCP Setup

`aiftp mcp` starts the aiftp MCP server over stdio. Add this to the MCP client
configuration for a local checkout:

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
      "args": ["-y", "aiftp", "mcp"]
    }
  }
}
```

Available tools:

- `aiftp_status`
- `aiftp_push`
- `aiftp_backup_list`
- `aiftp_backup_restore`
- `aiftp_backup_verify`
- `aiftp_backup_prune`
- `aiftp_log`
- `aiftp_list_remote`

Available resources:

- `aiftp://config`
- `aiftp://state/{profile}`
- `aiftp://backups/{profile}`
