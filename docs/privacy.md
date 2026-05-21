# Privacy Policy — aiftp

**Effective**: 2026-05-21 (aiftp v0.9.1)
**Last reviewed**: 2026-05-21

🇯🇵 日本語版は本文後半にあります。

---

## Summary (the short version)

- aiftp is a **local CLI / MCP server**. It runs on your machine.
- aiftp **does not send any data to any aiftp-tools server**. There is
  no telemetry, no analytics, no crash reporting, no usage stats.
- aiftp **does not have an aiftp-tools server** for the Free tier.
- The only network traffic aiftp generates goes to:
  - The FTP/FTPS server you configure (your hosting provider)
  - npm.org if you install or update aiftp via `npm` / `pnpm`
  - GitHub if you `git clone` the source

---

## What data aiftp processes

### Locally, on your machine only

| Data | Where it lives | Purpose |
|---|---|---|
| FTP host, user, port, remote_root | `.aiftp.toml` (your project) | Connection config |
| FTP password | OS keychain (macOS Keychain / Windows DPAPI via `cmdkey`) | Authentication |
| Local file paths and contents | `local_root` (you choose) | The files being deployed |
| Local diff state | `.aiftp/state/files/*.json` | Incremental sync |
| Encrypted backups of remote files | `.aiftp/backups/*.enc` (AES-256-GCM) | Rollback after push |
| Logs (with passwords masked) | `.aiftp/logs/*.log` | Debugging |
| Migration audit trail | `.aiftp/logs/migrations.jsonl` | Schema version history |
| Plan/confirm token store | In-memory (process lifetime) | MCP two-step gate state |

All of this stays on your machine. **None of it is transmitted to
aiftp-tools or any third party.**

### Sent over the network (by you, to your hosting provider)

When you run `aiftp push`, the following is sent over FTP/FTPS to
**the host you configured**:

- Your username and password (FTPS-encrypted in transit if FTPS is in
  use — which is the default and strongly recommended)
- The contents of files in `local_root` that have changed

This is normal FTP operation. aiftp is the transport; the destination
is your hosting account.

---

## What data aiftp does NOT collect

- ❌ Telemetry (usage, command frequency, errors, performance)
- ❌ Crash reports
- ❌ Analytics (Mixpanel / Segment / GA / etc.)
- ❌ Error reporting (Sentry / Rollbar / etc.)
- ❌ Update checks against aiftp-tools servers (we don't run any)
- ❌ Machine identifiers, hostnames, MAC addresses, IPs
- ❌ Anything else, period

This is enforced **by absence** — there is no telemetry code in the
codebase to disable, because there is no code to send it in the first
place. You can verify by:

```bash
grep -r "fetch\|http\.request\|https\.request\|Sentry\|Mixpanel\|Segment" packages/ | grep -v node_modules
```

The only HTTP code in aiftp is the MCP server's HTTP transport (which
binds to localhost or a stdio transport, not a remote endpoint).

---

## Credentials handling

This is the area we care about most.

### Storage

- **macOS**: passwords are stored via the `security` command in
  Keychain. The Keychain item is scoped to `service=<your-keychain-service-name>`
  and `account=<your-ftp-user>`. macOS protects it with your login
  password / Touch ID.
- **Windows**: passwords are stored via `cmdkey` (Windows Credential
  Manager). Reads use Win32 `CredRead` via PowerShell. Windows
  protects it via DPAPI tied to your user account.
- **Never**: passwords are not written to `.aiftp.toml`, not written
  to `.aiftp/state/`, not written to logs (logging code masks
  password-like values), not exposed via MCP responses, not included
  in `aiftp://config` MCP resource.

### Lifetime

- In-process only. aiftp holds the password in memory just long enough
  to authenticate to the FTP server, then releases the reference.
- aiftp does not cache the password to disk under any code path.

### MCP exposure

- AI agents using the MCP transport never see passwords.
  `aiftp://config` redacts credentials. Tool responses do not include
  credentials. Error messages do not include credentials.
- This is intentional: AI agents have chat history, which is itself a
  data exposure surface aiftp cannot control.

---

## Hard-excluded files

The following files are **never read, never uploaded, never backed up,
and never restored** by aiftp:

- `.env`, `.env.*`
- `wp-config.php`
- `db.php`
- `*.pem`, `*.key`
- (Full pattern list: `packages/core/src/exclude.ts`)

This protects you from accidentally pushing local-development
credentials, database passwords, or TLS private keys to a remote FTP
server.

---

## Update mechanism

aiftp does not auto-update. It does not check for new versions in
the background. Updates happen when you run `npm install -g aiftp@latest`
or your package manager's equivalent.

When you run `npm install`, npm contacts the npm registry. That
interaction is governed by npm's privacy policy, not aiftp's.

---

## Pro tier (future)

aiftp Pro (proprietary, planned for late 2026 / 2027) will introduce
license verification, which requires a one-time online activation
followed by an offline grace period. **Details of what data the Pro
license server collects will be specified in a separate Privacy
Policy at the time Pro launches**. This policy applies only to the
Free / open-source CLI and MCP server.

---

## Legal basis (Japan & EU)

### Japan (個人情報保護法 / APPI)

aiftp-tools, as the publisher of the Free CLI, **does not receive or
collect any personal information** from users of the Free CLI/MCP
server, because the software does not transmit any data to
aiftp-tools or any other endpoint we operate. Whether your local use
of aiftp involves 個人情報 under APPI is determined by what files
*you* choose to deploy and is outside the scope of this Privacy Policy.

(This is a statement of aiftp-tools' practice, not legal advice. If
APPI compliance is critical to your situation, consult a qualified
adviser.)

### EU (GDPR)

For the same reason — no data flows from your machine to
aiftp-tools — aiftp-tools does not act as a data controller or
data processor for personal data in the Free CLI/MCP server. You
remain the controller of your own local files.

(Again: a statement of practice, not legal advice. DPIA-grade
assessments should be carried out with your own counsel.)

If you deploy aiftp in a context that requires DPIA or vendor
risk assessment, the relevant facts are:

- **Data residency**: local only
- **Sub-processors**: none for the Free tier
- **Encryption at rest**: AES-256-GCM for backups; OS-native
  encryption (Keychain / DPAPI) for credentials
- **Encryption in transit**: FTPS (TLS 1.2+) when configured, which
  is the default

---

## Children's privacy

aiftp is a developer tool. We do not knowingly collect data from
anyone under 13.

---

## Changes to this policy

We may update this document as aiftp evolves (e.g. when Pro launches
and introduces its own data flows). Material changes will be noted
at the top of this file with a new `Last reviewed` date, and the
change will be summarized in `CHANGELOG.md`.

---

## Contact

For privacy questions:

- File a Discussion: <https://github.com/aiftp-tools/aiftp/discussions>
- For private inquiries: aiftp-tools organization owner email at
  <https://github.com/aiftp-tools>

---

## プライバシーポリシー（日本語版）

### サマリ

- aiftp はあなたのマシン上で動作する **ローカル CLI / MCP サーバ**です。
- aiftp は **aiftp-tools のサーバには一切データを送信しません**。テレメトリ・アナリティクス・クラッシュレポート・利用統計いずれも収集していません。
- そもそも Free tier 向けの aiftp-tools サーバは存在しません。
- aiftp が発生させるネットワーク通信は：
  - 設定された FTP/FTPS サーバ（あなたのレンタルサーバ）
  - npm install / pnpm install 時の npm.org
  - git clone 時の GitHub
  - それだけです。

### aiftp が扱うデータ（すべてローカル）

- FTP 接続情報（ホスト、ユーザ、ポート、リモートルート）→ プロジェクトの `.aiftp.toml`
- FTP パスワード → OS Keychain（macOS） / DPAPI（Windows）
- ローカルファイル → `local_root`
- リモートファイルの暗号化バックアップ → `.aiftp/backups/*.enc` (AES-256-GCM)
- ログ（パスワードはマスク済） → `.aiftp/logs/*.log`

これらはすべてあなたのマシン上に留まります。

### 収集しないもの

- ❌ テレメトリ
- ❌ クラッシュレポート
- ❌ アナリティクス
- ❌ アップデートチェック
- ❌ マシン識別子・IP アドレス

「収集していない」は**コードの不在**で保証されています。`packages/` 配下に外部送信用のコードが存在しないことを `grep` で確認できます。

### 認証情報の取扱い

- **macOS**: `security` コマンド経由で Keychain に保存（Touch ID 保護）
- **Windows**: `cmdkey` で Windows 資格情報マネージャに保存（DPAPI 保護）
- パスワードは `.aiftp.toml` にもログにも書きません。MCP レスポンスにも含めません

### 法的位置づけ

aiftp-tools（Free CLI の提供元）は、Free CLI/MCP サーバ経由でユーザーの個人情報を**受領・収集していません**。本ソフトウェアが aiftp-tools のサーバ（および当社が運営する第三者）にデータを送信しないためです。ローカルでの使用が個人情報保護法（APPI）/ GDPR にいう個人情報の処理に該当するかは、**ユーザーがデプロイするファイルの内容次第**であり、本ポリシーの範囲外です。

（本記述は aiftp-tools の運用実態の説明であり、法的アドバイスではありません。法的判断が必要な場合は専門家にご相談ください。）

### 連絡先

- 公開議論: <https://github.com/aiftp-tools/aiftp/discussions>
- 個別問い合わせ: aiftp-tools 所有者メール（<https://github.com/aiftp-tools> 参照）

---

**Version**: 1.0 (2026-05-21)
