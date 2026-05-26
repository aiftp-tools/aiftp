# aiftp 競合比較 — v0.11 立ち位置

> **最終更新**: 2026-05-26 (v0.11 リリース直前)
> **見直し頻度**: 四半期ごと
> **対象読者**: aiftp の採用判断をする開発者・AI agent 利用者

aiftp が「他のどれとも違う」と言える根拠と、棲み分けを明示するためのドキュメント。
各カテゴリで「aiftp が選ばれるべきシナリオ」「他ツールが選ばれるべきシナリオ」を率直に書く。

---

## カテゴリ図解

```
                AI が WP を操作したい
                       │
        ┌──────────────┼──────────────┐
   GUI 自動操作     ファイル deploy    WP 機能 API
        │              │              │
  Computer Use       aiftp        WP 公式 MCP
   / Operator                    (Abilities API)
   / Claude in
   Chrome
```

**3 カテゴリは併用が最強**で、互いに置き換える関係ではない。

---

## vs alxspiker / mcp-server-ftp (同カテゴリ最大の競合)

GitHub: [alxspiker/mcp-server-ftp](https://github.com/alxspiker/mcp-server-ftp)

| 項目 | alxspiker | **aiftp** |
|---|---|---|
| 言語 | TypeScript | TypeScript |
| プロトコル | FTP / FTPS / SFTP | FTP / FTPS / **SFTP (v0.11+)** |
| 認証情報の保管 | 環境変数 / 設定ファイル | **OS Keychain** (macOS Keychain / Windows Credential Manager) |
| バックアップ | なし | **AES-256-GCM 暗号化、push 前に自動取得** |
| **prepare → confirm 2 段ゲート** | なし | **あり** (plan_id / diff_hash / confirm_token + TTL) |
| **hard-exclude (`.env` / `wp-config.php` / `db.php`)** | なし | **あり** (config で off にできない非交渉ルール) |
| multi-profile (production / staging / dev) | なし | あり |
| 日本のレンタルサーバー quirks (StarServer cert, Sakura encoding 等) | なし | あり |
| FFFTP / FileZilla import | なし | あり (v0.11+ で SFTP profile も) |
| `aiftp doctor` 診断 (DNS / TCP / TLS / Keychain / remote_root reach) | なし | あり |
| MCP read-only ツール (`profile_list`, `init_template_list` 等) | 一部 | あり |
| 監査ログ (`.aiftp/log.jsonl`) | なし | あり |
| Windows / Linux / macOS native | あり | あり |

### 採用判断

| シナリオ | alxspiker | **aiftp** |
|---|---|---|
| AI agent が単発で FTP に 1 ファイル UP | ◎ シンプル | △ オーバースペック |
| 本番デプロイパイプライン (毎日 push) | △ 認証情報の扱いが軽い | ◎ Keychain + バックアップ + 2 段ゲート |
| 日本のレンタルサーバー × WordPress | × quirks 非対応 | ◎ |
| AI に「いつでも書き換えていい」と任せる | × 暴走防止なし | ◎ prepare→confirm が必須 |
| `.env` / `wp-config.php` 誤デプロイ防止 | × | ◎ hard-exclude |

**結論**: alxspiker は「AI が FTP を直接叩ける」レイヤー。aiftp は「AI が **安全に** 本番 deploy できる」レイヤー。

---

## vs Computer Use / Operator / Claude in Chrome (GUI 自動操作カテゴリ)

| シナリオ | Computer Use / Operator | **aiftp** |
|---|---|---|
| WordPress 投稿 1 件作成 | ◎ ブラウザ操作 | × 守備範囲外 |
| WP 管理画面でテーマファイル 1 個編集 → 保存 | ◎ テーマエディタ操作 | △ ローカル編集 + aiftp push |
| 100 ファイル一括 deploy | × 10〜20 分 + スクロール疲労 | ◎ 数十秒、転送状況は構造化ログ |
| ローカル → 本番 deploy | × ブラウザ経由は非現実的 | ◎ |
| 誤デプロイの即時ロールバック | × ブラウザでは戻せない | ◎ snapshot から 1 コマンド |
| AI が誤って本番を上書き防止 | × クリック確認のみ | ◎ prepare → confirm + diff_hash |
| 共有レンタルサーバー (SSH 非対応) | △ ブラウザ依存 | ◎ FTP/FTPS/SFTP どれでも |

**棲み分け**: Computer Use は「WP の管理 UI でしかできない作業」(投稿、プラグイン設定、テーマカスタマイザ) 専用。aiftp は「ファイルそのものを動かす作業」(コード deploy、メディアアップロード、設定ファイル更新) 専用。

---

## vs WordPress 公式 MCP (Abilities API, WP 6.7+)

WordPress 6.7+ で導入された Abilities API ベースの公式 MCP サーバー。WP コア機能を AI から直接呼べる。

| シナリオ | 公式 WP MCP | **aiftp** |
|---|---|---|
| 投稿・固定ページ作成 / 編集 / 公開 | ◎ | × 守備範囲外 |
| プラグイン管理 (有効化 / 無効化 / 設定) | ◎ (WP-CLI 連携) | × |
| ユーザー管理 / ロール変更 | ◎ | × |
| テーマ / プラグインのソースコード編集 | △ (テーマエディタ経由) | ◎ |
| カスタムプラグイン deploy | × WP-CLI 必要 → SSH 必須 | ◎ FTP のみで OK |
| 共有レンタルサーバーへのファイル配置 | × WP-CLI 不可 | ◎ |
| ロールバック (誤デプロイ復旧) | × WP 側に履歴なし | ◎ |

**棲み分け**: WP 公式 MCP は **WP の中で完結する操作**、aiftp は **WP の外からファイルを動かす操作**。両方併用が最強の体制になる。

---

## vs git-ftp / SamKirkland 系 (FTP デプロイ CLI 競合)

| 項目 | git-ftp (Bash) | SamKirkland/FTP-Deploy-Action | SamKirkland/ftp-deploy (Node) | **aiftp** |
|---|---|---|---|---|
| ライセンス | GPL-3.0 | MIT | MIT | MIT (open core) |
| インストール | 各 OS 専用 | GitHub Actions 専用 | npm | npm |
| AI agent (MCP server) | × | × | × | **◎ ファーストクラス** |
| 認証情報 Keychain 保管 | × | × (GitHub Secrets) | × | **◎** |
| 暗号化バックアップ | × | × | × | **◎** |
| prepare → confirm 2 段ゲート | × | × | × | **◎** |
| 日本のレンタルサーバー quirks | × | × | × | **◎** |
| FileZilla / FFFTP import | × | × | × | **◎** |
| SFTP 対応 | △ (実装次第) | × (FTP のみ) | × (FTP のみ) | **◎ (v0.11+)** |
| 大規模採用実績 | ◎ 5,582★ | ◎ 4,995★ | △ 113★ | 新規 |

**結論**: 既存 CLI 系は「git push と同じノリで FTP に push」する道具。aiftp は「**AI が自律的に判断して deploy する** のを **人間が安全に許可** する」道具。ターゲットがそもそも違う。

---

## aiftp の立ち位置（一言）

> **SSH / WP-CLI / GUI に頼らない、ファイル単位の FTP / FTPS / SFTP deploy の安全レイヤー。**
> 特に「AI agent が deploy する」シナリオで、prepare → confirm の 2 段ゲートと
> 暗号化バックアップにより、人間レビューを最小限に抑えながら本番を守れる。

### 想定読者

| プロファイル | aiftp はあなた向けか? |
|---|---|
| **日本のレンタルサーバー (Lolipop / Sakura / Xserver / StarServer 等) で WordPress を運用** | ✅ 第一ターゲット |
| **AI agent (Claude Code / Codex / Cursor 等) で WordPress テーマ・プラグインを開発** | ✅ 第一ターゲット |
| **共有レンタルサーバーでカスタム PHP / Laravel を運用** | ✅ |
| **SSH 経由で `rsync` / `git pull` できる本番環境を持っている** | △ aiftp は要らない、rsync で十分 |
| **VPS / EC2 上でフル管理者権限がある** | △ aiftp はオーバースペック |
| **Vercel / Netlify / Cloudflare Pages で静的サイト** | × 守備範囲外 |

---

## 比較表メンテナンス指針

- 四半期ごとに alxspiker / SamKirkland 系の最新版を確認し、機能差分を更新する。
- 新規競合が出たら章を追加する (例: GitHub Marketplace の新 FTP MCP 等)。
- aiftp 側で新機能が出たら該当列に追加する。
- 「× 守備範囲外」を恥じない — 棲み分けの明示は採用判断を助ける。
