#!/usr/bin/env bash
# v0.11 Pillar δ smoke probe — verifies the published @aiftp-tools/cli
# stdio MCP server boots, responds to initialize / tools/list, and
# exposes the expected tool count.
#
# Asserts:
#   - server starts and writes a JSON-RPC response
#   - tools/list returns at least MIN_TOOL_COUNT `aiftp_*` tools
# v0.11 ships 26 tools (25 from v0.10.4 + aiftp_init_template_list);
# we keep the floor conservative so a Pro fork that omits some tools
# does not flake the smoke check.

set -euo pipefail

MIN_TOOL_COUNT=${MIN_TOOL_COUNT:-22}
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"aiftp-smoke","version":"0.0.1"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  # Give the server time to write its responses before SIGPIPE.
  sleep 1
} | aiftp mcp 2>mcp-stderr.log >mcp-stdout.log || true

TOOL_COUNT=$(grep -o '"aiftp_[a-z_]*"' mcp-stdout.log | sort -u | wc -l | tr -d ' ')

if [ "$TOOL_COUNT" -lt "$MIN_TOOL_COUNT" ]; then
  echo "FAIL: expected >= $MIN_TOOL_COUNT aiftp_* tools, got $TOOL_COUNT"
  echo "--- stdout ---"
  head -c 4096 mcp-stdout.log || true
  echo
  echo "--- stderr ---"
  head -c 4096 mcp-stderr.log || true
  exit 1
fi

echo "PASS: $TOOL_COUNT aiftp_* tools listed (floor=$MIN_TOOL_COUNT)"
