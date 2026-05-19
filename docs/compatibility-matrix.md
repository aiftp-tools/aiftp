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
| **Star Server**（スターサーバー） | ⚠️ `*.star.ne.jp` vs `*.stars.ne.jp` mismatch | ✅ | ⚠️ FEAT does not advertise MLSD | ✅ | UTF-8 OK | `starserver` | ✅ verified end-to-end on `glocalworks.co.jp` (v0.2.0) + doctor probe v0.2.3 |
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

### Live `aiftp doctor` output on Star Server (v0.2.3, 2026-05-19)

Profile: `glocalworks.co.jp` → `glocalworks.stars.ne.jp` (`157.112.187.94:21`)

```text
summary: pass=9 warn=2 fail=1 skip=0

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
remote-root:     fail  (CWD <remote_root> returns non-2xx; under investigation)
```

The `remote-root: fail` is an open investigation: end-to-end `aiftp
push` succeeds on this same profile (verified during the v0.2.0
walkthrough), so the probe's `CWD <remote_root>` is hitting something
that basic-ftp's `STOR /<remote_root>/<file>` path does not. Plausible
cause: chrooted FTP where absolute-path `CWD` is rejected even though
absolute-path `STOR` is accepted. Likely fixed in v0.2.4 by switching
the probe to a less strict reachability check (`PWD` + `LIST`).

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
| Idle disconnect under N seconds | `[quirks].noop_interval_sec = <secs>` | Send NOOP keepalive (planned wiring — exposed in schema, not yet sent automatically) |

## How to contribute a new row

If you run aiftp against a host not on this list, please open a PR that
adds a row with at minimum:

- Provider name / version
- Whether TLS hostname matches the FTPS endpoint
- PASV / MLSD / SIZE behaviour
- File-name encoding the server returns over `LIST` / `MLSD`
- Whether `aiftp doctor` returns `summary.fail === 0`
- Any quirks you had to set in `[quirks]`
