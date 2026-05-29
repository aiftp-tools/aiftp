# Server compatibility matrix

> Status as of v0.10.0 (release candidate). Last updated 2026-05-23.

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

> **Verification status note (2026-05, [ADR 0002](adr/0002-v1.0-release-gate-redefinition.md))**:
> ロリポップ / さくら / エックスサーバー の上記 ✅ は **v0.9.3（2026-05-22）時点で実アカウントにて検証した記録**です。**その後これら3社のレンタル契約は解約済み**で、現在ライブ再実行はできません。残る未検証 delta（最小 push の再確認・Shift_JIS 挙動）は、需要発生時——特にデプロイ代行案件で実際に客のサーバへ触れた機会——に再検証します。継続的にライブ検証されているのは **Star Server（GWco）のみ**で、smoke CI は ftp-srv モックで動いています。検証状況を誇張せず正直に記録するのは、aiftp の信用の土台が安全性であるためです。

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
| **さくらインターネット** (Standard, trial) | ✅ | ✅ | ✅ | ✅¹ | ✅ | ✅ | ✅ | 2026-05-23. doctor 11/2/0 (mlsd warn only). All 7 steps pass on `oliveferret65.sakura.ne.jp`. ¹ Step 4 prune validated via Step 6 rollback-delete code path (shares the same remote DELETE implementation). Pre-existing state.json drift from v0.9.2 testing (`test-v092.html`) detected but `deletion_policy="never"` makes it inert — does not block release. |
| **エックスサーバー** (Standard, trial) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 2026-05-23. doctor 12/1/0 (mlsd warn only). All 7 steps pass on `sv17099.xserver.jp`, `remote_root = /aiftp.xsrv.jp/public_html/aiftp-test-v0100/`. Step 4 verified by cleaning up an unintended `.aiftp.toml.before-v0100` backup file (see F-X1 below). Hard-exclude (`wp-config.php`) verified absent from both upload and delete plans. v0.9.3 wildcard match handles `*.xserver.jp` → `sv<N>.xserver.jp` cleanly (no quirk needed). |

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

### Live trace artifact (Xserver, 2026-05-23)

- Workspace: `~/aiftp-verify/xserver/`
- `host = sv17099.xserver.jp`, `remote_root = /aiftp.xsrv.jp/public_html/aiftp-test-v0100/`
- Snapshots created (4 total):
  - `14-04-20-...-288f2b04` — initial push of 3 fixtures + 1 unintended `.aiftp.toml.before-v0100` (`files=4 bytes=0`, all tombstones)
  - `14-17-10-...-a2a70213` — prune push removing `.aiftp.toml.before-v0100` (`files=1 bytes=1155`, pre-deletion content)
  - `14-22-34-...-5999a38e` — modified push of `hello-v0100.html` (`files=1 bytes=157`, pre-modification content)
  - `14-28-04-...-99431edd` — added push of `new-page-v0100.html` + re-modified `hello-v0100.html` (`files=2 bytes=157`)
- Rollback to `14-22-34` snapshot: hello restored from 207 → 157 B (verified by `aiftp ls`).
- Rollback to `14-28-04` snapshot: `new-page-v0100.html` deleted from remote, hello restored from 207 → 157 B (verified by `aiftp ls`).
- Hard-exclude guard: `wp-config.php` sentinel correctly excluded from both upload and delete planning.

### Live trace artifact (Sakura, 2026-05-23)

- Workspace: `~/aiftp-verify/sakura/`
- `host = oliveferret65.sakura.ne.jp`, `remote_root = /home/oliveferret65/www/aiftp-test-v0100/`
- Snapshots created (3 new):
  - `14-41-58-...-b90ff3dc` — initial push of 3 fixtures (`files=3 bytes=0`, all tombstones)
  - `14-43-37-...-52806ade` — modified push of `hello-v0100.html` (`files=1 bytes=156`, pre-modification content)
  - `14-46-21-...-c90de1cc` — added push of `new-page-v0100.html` + re-modified hello (`files=2 bytes=156`)
- Rollback to `14-43-37` snapshot: hello restored from 209 → 156 B (verified by `aiftp ls`).
- Rollback to `14-46-21` snapshot: `new-page-v0100.html` deleted from remote, hello restored from 209 → 156 B.
- Hard-exclude guard: `wp-config.php` sentinel correctly excluded.
- Pre-existing drift: state.json contained a stale `test-v092.html` entry from a v0.9.2 test that was manually deleted from remote. Reported as `removed` in every dry-run but `plannedDeletes` stays empty because `deletion_policy="never"`. Tracked separately (does not block v0.10.0).

### Findings (Xserver / Sakura, 2026-05-23)

| ID | Severity | Subject | Disposition |
|---|---|---|---|
| F-X1 | P3 | `DEFAULT_EXCLUDE_PATTERNS` only matches the literal filename `.aiftp.toml.bak`, not arbitrary suffixes such as `.aiftp.toml.before-v0100`. A backup file made with a custom suffix was uploaded to Xserver's `aiftp-test-v0100/` and had to be pruned out. | Add glob `.aiftp.toml*` to `DEFAULT_EXCLUDE_PATTERNS` in v0.10.1+. Does not block v0.10.0. |
| F-X2 | docs | `local_root = "."` means anything under the working directory is in scope — moving a backup into a sibling subdirectory (`_archive-2026-05-22/`) does NOT exclude it. The workaround is to move it OUTSIDE the working directory entirely. | Add to `docs/v0.10.0-field-verification.md` Step 4 / cleanup notes. |
| F-X3 | info | aiftp does **not** follow symlinks during push (safe-by-default behaviour). A symlink to a fixture in a sibling directory was silently skipped. | Document explicitly in `docs/spec.md` push section. |
| F-X4 | info | Snapshot listing displays `bytes=0` for tombstone-only snapshots (the snapshot for "initial push of 3 added files" shows `files=3 bytes=0` because all entries are tombstones). Cosmetic only — `aiftp backup show` correctly reports per-file content. | Already tracked from Lolipop verification; UI improvement deferred. |
| F-S1 | info | state.json drift from prior version testing surfaces as a phantom `removed` entry in every dry-run. Inert when `deletion_policy = "never"`; would attempt a remote delete under `prune-auto` / `prune-with-confirm`. | Recommend `aiftp init --reset-state` or equivalent for users upgrading from v0.9.x mid-test-cycle. |

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
