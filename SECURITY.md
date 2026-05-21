# Security Policy

🇯🇵 日本語版は本文後半にあります。

---

## Supported versions

| Version range | Security fixes |
|---|---|
| **v0.9.x** (current) | ✅ Receives fixes |
| v0.4.x – v0.8.x | ⚠️ Critical fixes only, backported if requested |
| < v0.4.0 | ❌ Not supported; please upgrade |

Once **v1.0.0** is released, the policy switches to:
**latest minor + previous minor** receive security fixes.

---

## Reporting a vulnerability

**Please do not file public GitHub issues for security bugs.**

Use **GitHub Security Advisories** instead:

→ <https://github.com/aiftp-tools/aiftp/security/advisories/new>

This gives us a private channel to discuss, develop a fix, and
coordinate disclosure.

If you cannot use Security Advisories (e.g. you don't have a GitHub
account), contact the aiftp-tools organization owner via the public
email listed at <https://github.com/aiftp-tools> and use the subject
line `[security] aiftp <short summary>`.

### What to include

- A clear description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Impact assessment (what an attacker could achieve)
- Any proposed mitigation, if you have one
- Whether you'd like to be credited in the published advisory

### What to expect

**These are response targets, not guaranteed SLAs.** aiftp is
currently maintained by a single person alongside their main
business, and a response can be delayed by travel, illness, or other
real-world reasons.

| Stage | Target time | Notes |
|---|---|---|
| **Acknowledgement** | Usually within **3 business days** (JST) | Maintainer confirms receipt |
| **Initial triage** | Usually within **7 business days** | Confirm reproducibility, assess severity |
| **Fix in development** | Depends on severity & complexity | We'll keep you updated |
| **Coordinated disclosure** | After a fix is released (or after a 90-day default deadline) | We'll discuss public disclosure timing with you |

If you have not heard back within **10 business days**, please send
a polite follow-up via the same channel — your report may have been
missed.

### Bug bounty

aiftp does not currently offer a paid bug bounty. We can offer:

- Public credit in the published advisory and release notes (opt-in,
  with the name / handle of your choice)
- A heartfelt thank-you in Japanese or English 🙇

---

## Categories of security issues we care about (non-exhaustive)

These are the areas where a vulnerability would be considered a real
threat to aiftp users:

### High impact

- **Credentials leaking** out of Keychain / DPAPI into TOML, logs,
  MCP responses, or stdout/stderr
- **Two-step MCP gate bypass** — any way to perform a destructive
  action (push, restore, migrate, import) without a valid
  `prepare → confirm` token round-trip
- **Hard-exclude bypass** — uploading or backing up `.env*`,
  `wp-config.php`, `*.pem`, `db.php`, or any pattern in
  `packages/core/src/exclude.ts`
- **Path traversal** — restore-to-cwd-escape, FTP-server-side
  upload-path-escape, or symlink-following that escapes
  `local_root`
- **Backup encryption weakness** — backups not encrypted, or
  encrypted with a guessable key
- **TLS verification bypass** without the operator explicitly
  setting `[safety] verify_certificate = false`
- **Plan/token replay** — a single `confirm_token` accepted twice,
  or a `plan_id` accepted past its TTL

### Medium impact

- **Race conditions** between `prepare` and `confirm` that allow
  data to mutate while still passing the diff-hash check (TOCTOU)
- **Lock-file bypass** allowing two agents to push concurrently
- **Importer mishandling** of password fields (e.g. cipher text
  leaking into TOML or warnings)
- **Path-handling errors on Windows** (case folding, UNC paths,
  drive letters) that cause files to be missed from the upload set

### Lower impact (still worth reporting)

- Denial of service via malformed input (importer hangs, hook
  parser hangs)
- Information disclosure via unredacted `aiftp://config` resource
- Doctor exposing more than necessary in `--json` output

### Out of scope

- **Vulnerabilities in upstream dependencies** that don't manifest
  in aiftp's actual use of them (please report to the upstream
  project instead)
- **Theoretical attacks requiring host-level compromise** (if an
  attacker already has shell access to your dev machine, they can
  read your Keychain via OS APIs — that's not a vulnerability in aiftp)
- **Attacks against a hosting provider's FTP server itself** (please
  report to the provider)

---

## Disclosure policy

We follow **coordinated disclosure**:

1. You report the vulnerability privately
2. We confirm, develop a fix, and release it
3. We publish a GitHub Security Advisory with details (or a CVE if
   warranted) once a fix is available
4. Default disclosure timeline: **90 days** from initial report. We
   may extend this for complex issues with your agreement, or
   shorten it if a fix lands faster

---

## セキュリティポリシー（日本語版）

### サポート対象バージョン

| バージョン | セキュリティ修正 |
|---|---|
| **v0.9.x**（現行） | ✅ |
| v0.4.x – v0.8.x | ⚠️ Critical 修正のみ・要請があればバックポート |
| v0.4.0 未満 | ❌ サポート対象外。アップグレード推奨 |

### 報告先

**公開 Issue で報告しないでください。**

→ GitHub Security Advisory: <https://github.com/aiftp-tools/aiftp/security/advisories/new>

GitHub アカウントを持っていない場合は、aiftp-tools 所有者の公開メール宛にお送りください。件名: `[security] aiftp <概要>`

### 含める情報

- 脆弱性の説明 / 再現手順 / 影響範囲 / 影響を受けるバージョン / 緩和策（あれば） / 公開時のクレジット希望

### 対応 SLA

**以下はあくまで目安であり、保証された SLA ではありません。** aiftp は現在 1 人で運営しているため、出張・体調・本業の繁忙等で対応が遅れる可能性があります。

| ステージ | 目安 |
|---|---|
| 受領通知 | 通常 **3 営業日**以内（JST） |
| 初動トリアージ | 通常 **7 営業日**以内 |
| 修正開発 | 重大度・複雑度による |
| 公開協調 | 修正リリース後、または 90 日のデフォルト期限 |

**10 営業日**経っても返信がない場合は同じチャネルで再送してください。報告自体を見落としている可能性があります。

### バグバウンティ

現在、金銭報奨は提供していません。代わりに：

- Advisory とリリースノートでの謝辞（希望者のみ、お好きな名義で）
- 心からの感謝 🙇

### 重視するカテゴリ

- 認証情報の漏洩（Keychain / DPAPI → TOML / ログ / MCP 応答 / 標準出力）
- 二段階 MCP ゲート（prepare → confirm）の迂回
- Hard-exclude の迂回（`.env*` / `wp-config.php` / `*.pem` / `db.php`）
- パストラバーサル
- バックアップ暗号化の脆弱性
- TLS 検証の暗黙的なバイパス
- plan_id / confirm_token のリプレイ

詳細は英語版セクションを参照してください。

---

**Version**: 2026-05-21 (aiftp v0.9.1 baseline)
