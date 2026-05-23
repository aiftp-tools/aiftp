# Server compatibility matrix

> Status as of v0.9.3. Last updated 2026-05-22.

aiftp's safety story is only as good as how well it handles each
real-world FTPS server's quirks. This page records what's actually been
exercised end-to-end, plus the known gotchas for hosts that have not
yet been verified.

Legend:

- ✅ verified end-to-end (init / status / push / backup / restore / doctor)
- ⚠️ partial — works but a documented quirk applies
- ❌ known-failing — needs explicit config or a future quirk to ship
- — not yet attempted

## Japanese shared hosting (the primary v0.2 audience)

| Provider | TLS hostname | PASV | MLSD | SIZE | Encoding | `server_kind` preset | Status |
|---|---|---|---|---|---|---|---|
| **Star Server**（スターサーバー） | ⚠️ `*.star.ne.jp` vs `*.stars.ne.jp` mismatch (v0.9.3 still warns — CN truly doesn't cover the host) | ✅ | ⚠️ FEAT does not advertise MLSD | ✅ | UTF-8 OK | `starserver` | ✅ end-to-end push + doctor verified on `glocalworks.co.jp` Master FTP account (v0.2.5, 2026-05-19) |
| **ロリポップ！** | ✅ `*.lolipop.jp` covers `ftp-*.lolipop.jp` (v0.9.3 wildcard match) | ✅ | ⚠️ FEAT does not advertise MLSD | ✅ | UTF-8 OK | `lolipop` | ✅ doctor 11/2/0 on Light plan (v0.9.3, 2026-05-22). 海外アタックガード ON does NOT affect FTP (verified). |
| **さくらインターネット** | ✅ `*.sakura.ne.jp` covers `<user>.sakura.ne.jp` (v0.9.3 wildcard match) | ✅ | ⚠️ FEAT does not advertise MLSD | ✅ | UTF-8 OK | `sakura` | ✅ doctor 11/2/0 on Standard plan (v0.9.3, 2026-05-22). push + rollback verified at v0.9.2 (Sakura). **国外IPフィルタは 2026-05 新規契約でもデフォルト ON、FTP を含む** — verified against the 2014-03 announcement. |
| **エックスサーバー** | ✅ `*.xserver.jp` covers `sv<N>.xserver.jp` (v0.9.3 wildcard match) | ✅ | ⚠️ FEAT does not advertise MLSD | ✅ | UTF-8 OK | `xserver` | ✅ doctor 11/2/0 on Standard plan (v0.9.3, 2026-05-22). FTP unrestricted by default per public docs — verified. |

### Star Server (starserver) notes

The certificate served on `ftp.glocalworks.co.jp` (the typical
`<your-domain>` form) is a wildcard issued for `*.star.ne.jp`, not the
customer's vanity host. Node's TLS layer correctly raises
`ERR_TLS_CERT_ALTNAME_INVALID`.

**v0.2 behaviour**: `aiftp doctor` and `aiftp push` surface this as a
detailed `FtpTlsError` with the cert CN, the SAN list, the requested
host, and a recommended next step. We do *not* silently disable
verification. The operator decides whether to set
`safety.verify_certificate = false` after confirming the server
identity through another channel.

**v0.2.1 — landed**: `aiftp init` with `server_kind = "starserver"`
pre-fills `[quirks].tls_check_hostname = false` plus inline TOML
comments. v0.2.2 wires the quirk to a hostname-only TLS bypass
(`checkServerIdentity: () => undefined`) so the full chain stays
validated.

**v0.2.3 — landed**: `aiftp doctor`'s FTPS probe now respects the
quirk too, so the handshake step succeeds on Star Server while the
`ftps-cert` check still surfaces the mismatch as a `warn` with the
cert CN / SAN / requested host in `details`.

### Star Server account types

Star Server exposes FTP through two account shapes that have *different
chroot layouts*. This matters when you choose `remote_root`:

| Account | Chroot at | `remote_root` shape | Example |
|---|---|---|---|
| **Master FTP** (control panel default) | `/<home-dir>/` (above all domains) | `/<your-domain>/public_html/<subpath>` | `/glocalworks.co.jp/public_html/aiftp-test` |
| **Sub FTP** (per-domain) | `/<your-domain>/public_html/` | `/<subpath>` or `/` | `/aiftp-test` |

If you don't know which one you have, run `aiftp ls /` and look at what's
visible at the root:

- **Multiple domain directories** (`glocalworks.co.jp/`, `u16tanaka.com/`,
  ...) → Master FTP
- **Web files directly** (`index.html`, `wp-content/`, ...) → Sub FTP

`aiftp ls` was added in v0.2.5 specifically for this diagnosis.

### Live `aiftp doctor` output on Star Server (v0.2.5, 2026-05-19, Master FTP)

Profile: `glocalworks.co.jp` → `glocalworks.stars.ne.jp` (`157.112.187.94:21`)
`remote_root = "/glocalworks.co.jp/public_html/aiftp-test"` (Master FTP)

```text
summary: pass=10 warn=2 fail=0 skip=0

config-file:     pass
profile-exists:  pass
gitignore:       pass
keychain:        pass
dns:             pass  (157.112.187.94)
tcp:             pass  (port 21)
ftps-handshake:  pass  (TLS via the starserver quirk)
ftps-cert:       warn  (CN=*.star.ne.jp; requested glocalworks.stars.ne.jp)
pasv:            pass  (no NAT leak)
mlsd:            warn  (FEAT does not advertise MLSD; LIST fallback works)
size:            pass  (SIZE supported)
remote-root:     pass  (CWD <remote_root> succeeds after v0.2.5 auto-mkdir)
```

`aiftp push` upload succeeded; `aiftp ls /glocalworks.co.jp/public_html/aiftp-test`
returned `index.html` after the push. End-to-end loop confirmed.

### Investigation history (v0.2.3 → v0.2.5)

- **v0.2.3**: probe reported `remote-root: fail` with the vague message
  `remote_root could not be selected.`
- **v0.2.4**: surfaced the actual FTP reply (`550 not found`) and the
  configured path in `details`, so the operator can diagnose without
  re-running with `--verbose`.
- **v0.2.5**: the underlying cause turned out to be that the deploy
  engine deliberately skipped `mkdir` on the configured `remote_root`
  itself (v0.1.1 design bug — intended as "operator told us this
  exists" optimisation, but broke first-time pushes to fresh
  subdirectories). v0.2.5 removed the skip; `ensureDir`'s mkdir-p
  semantics handle the existing-dir case as a single cd. v0.2.5 also
  added `aiftp ls` for read-only server exploration.

## v0.10.0 feature verification (2026-05-23)

The v0.10.0 breaking release introduces:

- Snapshot schema 2 (per-file `operation` field: `added` / `modified` / `removed`; `added` files stored as tombstones)
- `[safety].deletion_policy` config (`never` default / `prune-auto` / `prune-with-confirm`)
- `rollback` performs real remote `delete` for `added` tombstones in the target snapshot
- MCP `aiftp_rollback_confirm` requires `acknowledge_deletions: true` when deletes are planned

Provider verification status against the
[`docs/v0.10.0-field-verification.md`](v0.10.0-field-verification.md)
7-step plan:

| Provider | doctor | initial push | modify push | prune w/ confirm | rollback restore | rollback delete | hard-exclude | Notes |
|---|---|---|---|---|---|---|---|---|
| **ロリポップ！** (Light, trial) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 2026-05-23. Schema 2 tombstone snapshot (`files=N bytes=0`), `modified`/`removed` snapshots carry old remote content (`bytes>0`). Typed `DELETE` prompt fired. Rollback verified end-to-end via independent raw FTPS LIST (Python `ftplib` + Keychain decode). Two P1 issues surfaced during this run (CLI rollback real-run output missing `deleted` count; `state.json` not updated after rollback) and were fixed in v0.10.0 before tag (commits `a71e659` / `fa674f4` / `1794cfe`), then re-verified on the same Lolipop workspace. |
| **さくらインターネット** (Standard, trial) | — | — | — | — | — | — | — | Target: before 2026-06-04 trial deadline. |
| **エックスサーバー** (Standard, trial) | — | — | — | — | — | — | — | Target: before 2026-05-31 trial deadline. |

### Verification method

For each provider, Claude Lead walks 田中さん through `docs/v0.10.0-field-verification.md` steps 1–7. The fixture directory is `~/aiftp-verify/<provider>-v0100/` with disposable `*-v0100.{html,css}` files and `remote_root = "/test-v0100/"` (NEVER the provider's `/public_html` root). Independent ground truth for remote state is captured via raw FTPS `LIST` (Python `ftplib.FTP_TLS`, password decoded from the aiftp-v1 wrapped Keychain entry), not via `aiftp status` (which can lag — see P1-B).

### Live trace artifact (Lolipop, 2026-05-23)

- Workspace: `~/aiftp-verify/lolipop-v0100/`
- Snapshots created (4 total):
  - `09-49-56-...-bbd36e98` — initial push of 3 fixtures (`files=3 bytes=0`, all tombstones)
  - `09-52-58-...-1647ed4c` — modified push of `hello-v0100.html` (`files=1 bytes=260`, pre-modification content)
  - `10-03-17-...-c24daf47` — prune push removing `styles-v0100.css` (`files=1 bytes=279`, pre-deletion content)
  - `10-20-40-...-db89fc22` — added push of `new-page-v0100.html` (`files=1 bytes=0`, tombstone)
- Rollback to `09-52-58` snapshot: hello restored to 260 B (verified by raw FTPS LIST).
- Rollback to `10-20-40` snapshot: `new-page-v0100.html` removed from remote (verified by raw FTPS LIST: `/test-v0100/` only contains `about-v0100.html` and `hello-v0100.html`).
- Hard-exclude guard: a sentinel `wp-config.php` placed in the test directory was correctly excluded from both upload and delete planning.

## Generic / VPS

| Server | Notes | Status |
|---|---|---|
| FileZilla Server (Windows / self-hosted) | Modern defaults — MLSD on, SIZE on, no PASV NAT issues if configured properly | — |
| vsftpd | Standard config works; needs `pasv_address` set correctly behind NAT | — |
| pure-ftpd | Standard config works | — |

## Known quirks aiftp can already handle (config)

| Quirk | Where it lives | Effect |
|---|---|---|
| Server reports private PASV address behind NAT | `[quirks].ignore_pasv_address = true` | Use the control connection's host instead of the PASV reply |
| MLSD not supported | `[quirks].use_mlsd = false` | Fall back to LIST parsing (basic-ftp default) |
| Idle disconnect under N seconds | `[quirks].noop_interval_sec = <secs>` | Send NOOP keepalive (wired in v0.2.2; basic-ftp control connection receives NOOP every N seconds) |
| Shared wildcard cert (Sakura / Xserver / Lolipop) | (handled automatically by v0.9.3 wildcard matching — **no quirk needed**) | RFC 6125 §6.4.3 single-label leading wildcard; `*.sakura.ne.jp` matches `<user>.sakura.ne.jp` etc. |
| TLS hostname check needs to be skipped (legacy v0.9.2 escape hatch) | `[quirks].tls_check_hostname = false` | Bypass Node's `checkServerIdentity`. **Rarely needed in v0.9.3+** — only for hosts where the cert CN truly doesn't cover the requested host (e.g. Star Server's `*.star.ne.jp` vs `*.stars.ne.jp`) and the operator has confirmed server identity another way. |

## Operator platform support

| Platform | Status | Credential storage |
|---|---|---|
| macOS 12+ (Monterey or newer) | ✅ verified end-to-end (Star Server) | macOS Keychain via the `security` CLI |
| Windows 10+ / Windows 11 | ✅ v0.3 — CI green on `windows-latest` for Node 22 / 24, awaiting first live operator run | Windows Credential Manager via `cmdkey` + PowerShell-hosted Win32 `CredRead` |
| Linux | ❌ not supported in v0.3 | `libsecret` is a Phase 2+ candidate |

## How to contribute a new row

If you run aiftp against a host not on this list, please open a PR that
adds a row with at minimum:

- Provider name / version
- Whether TLS hostname matches the FTPS endpoint
- PASV / MLSD / SIZE behaviour
- File-name encoding the server returns over `LIST` / `MLSD`
- Whether `aiftp doctor` returns `summary.fail === 0`
- Any quirks you had to set in `[quirks]`
