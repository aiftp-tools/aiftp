# Server compatibility matrix

> Status as of v0.2.0. Last updated 2026-05-19.

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
| **Star Server**（スターサーバー） | ⚠️ `*.star.ne.jp` vs `*.stars.ne.jp` mismatch | ✅ | ⚠️ FEAT does not advertise MLSD | ✅ | UTF-8 OK | `starserver` | ✅ end-to-end push + doctor verified on `glocalworks.co.jp` Master FTP account (v0.2.5, 2026-05-19) |
| ロリポップ | — | — | — | — | — | `lolipop` | — |
| さくらインターネット | — | — | — | — | — | `sakura` | — |
| エックスサーバー | — | — | — | — | — | `xserver` | — |

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
