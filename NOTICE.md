# aiftp — Third-Party Notices

aiftp is licensed under the MIT License (see [LICENSE](LICENSE)).

This file enumerates the open-source components bundled or linked at
runtime, together with their respective licenses. All listed licenses
are compatible with MIT and with each other under standard
interpretation. No bundled component is licensed under a copyleft
license (GPL/LGPL/AGPL).

**Last reviewed**: 2026-05-21 (aiftp v0.9.1)
**Inventory tool**: `pnpm licenses list --recursive --prod`

---

## Production (runtime) dependency license summary

Output of `pnpm licenses list --recursive --prod` reduced to license
category counts (re-measured 2026-05-21):

| License | Count | Notes |
|---|---|---|
| MIT | 93 | Including `basic-ftp`, `commander`, `@modelcontextprotocol/sdk`, `fast-xml-parser`, `iconv-lite`, `hono`, `zod`, `prompts`, etc. |
| ISC | 8 | Including `@iarna/toml`, `inherits`, `once`, `setprototypeof`, `which`, `wrappy`, `zod-to-json-schema`, etc. |
| BSD-3-Clause | 2 | Including `fast-uri`, `qs` |
| BSD-2-Clause | 1 | `json-schema-typed` |
| **Total** | **104** | All MIT-compatible. No copyleft (GPL/LGPL/AGPL). |

## Development-only dependency licenses (not shipped at runtime)

The full `pnpm licenses list --recursive` (including dev tooling)
additionally surfaces Apache-2.0, BlueOak-1.0.0, and `MIT OR Apache-2.0`
entries from build/test tooling (TypeScript, `expect-type`, lockfile
path utilities, etc.). These are **not** bundled into the published
npm artifact; they're only present at build time.

---

## Key runtime dependencies (selected)

These are the dependencies most directly responsible for aiftp's
runtime behavior. Each is MIT-licensed unless otherwise noted.

| Package | License | Role in aiftp |
|---|---|---|
| `basic-ftp` | MIT | FTP / FTPS client (transport core) |
| `@modelcontextprotocol/sdk` | MIT | MCP server implementation |
| `commander` | MIT | CLI argument parsing |
| `prompts` | MIT | Interactive CLI prompts (`aiftp init`) |
| `@iarna/toml` | ISC | TOML parser for `.aiftp.toml` |
| `zod` | MIT | Schema validation for config & MCP tool inputs |
| `zod-to-json-schema` | ISC | Generates JSON Schema for MCP tool descriptors |
| `iconv-lite` | MIT | Shift_JIS / EUC-JP decoding (FFFTP imports, file-name encoding) |
| `fast-xml-parser` | MIT | FileZilla `sitemanager.xml` parsing |
| `hono` | MIT | HTTP server primitive (MCP transport when applicable) |
| `cross-spawn` | MIT | Cross-platform child process spawn |
| `which` | ISC | Locate `security` / `cmdkey` binaries for keychain access |

---

## How to regenerate this inventory

```bash
cd aiftp/
pnpm licenses list --recursive --prod
```

If a new dependency appears with a license not listed in the summary
above (or any copyleft license), it MUST be reviewed before being
added to a release.

---

## Full per-package list

To produce a full machine-readable list:

```bash
cd aiftp/
pnpm licenses list --recursive --prod --json > NOTICE.full.json
```

`NOTICE.full.json` is intentionally not committed because it changes
on every dependency update; regenerate it before any npm publish if
license-audit evidence is required.

---

## Reporting

If you believe a dependency is misclassified or a license is missing
here, please open an issue:
<https://github.com/aiftp-tools/aiftp/issues>
