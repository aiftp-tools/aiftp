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
| **Star Server**（スターサーバー） | ⚠️ `*.star.ne.jp` vs `*.stars.ne.jp` mismatch | ✅ | — | ✅ | UTF-8 OK | `starserver` | ✅ verified on `glocalworks.co.jp` (田中さん本人) |
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

**v0.2.1 plan**: ship a `server_kind = "starserver"` quirk that
auto-relaxes hostname verification *only* when the server certificate
matches one of the known Star Server upstreams (`*.star.ne.jp`). The
quirk will be opt-in per profile via `[quirks].tls_check_hostname`.

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
