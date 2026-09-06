# aiftp 恒久的な注意点（実測ベース）

> 開発・リリース・実機運用で**実際に踏んだ**落とし穴だけを記録する。推測は書かない。
> ここは恒久情報の置き場であり、セッションの作業ログは `memory.md` に書く
> （役割分担はグローバル規約 `~/.claude/rules/common/session-safety.md` に従う）。
>
> Claude / Codex とも着手前に本ファイルを読むこと。
> 新しい落とし穴を踏んだら、**原因と実測日を添えて**ここに追記する。

**最終更新**: 2026-09-05


## v0.13 Windows 実機で判明（2026-08-15）

- 🔴 **`display_name` にパス区切り文字を入れない** — Claude Desktop はこれを MCP サーバ識別子＝パス要素に使う。スラッシュで `path escape` になり有効化が失敗する。**macOS / Windows の両方で発生**（2026-08-15 に Windows で発見、2026-09-05 に macOS でも実測。当初「Windows 固有」と記録していたのは誤り）。**回帰テストで固定済み**（`manifest.spec.ts`）
- **拡張の設定変更は Claude Desktop 再起動まで反映されない** — bootstrap は MCP サーバ起動時にしか走らない。`.aiftp.toml` の `user` 行が古いまま残るのを実測
- **`setup_status` は存在チェックのみ** — pass でも中身が正しいとは限らない。障害切り分けの前提として覚えておく
- **`.mcpb` のビルドは再現的でない** — 同一ソースでもハッシュが変わる（zip タイムスタンプ）。配布物の同一性は展開して `manifest.json` を見る
- **ログ（`%APPDATA%\Claude\logs\`）は追記式** — `Select-String` のマッチは過去の記録を拾う。**メッセージ内の名前やタイムスタンプで新旧を判別する**

## 拡張の再インストール（2026-09-05 実測）

- 🔴 **同一バージョン番号の `.mcpb` は上書きインストールで置き換わらない** — Claude Desktop はバージョン番号で更新可否を判断する。開発中ビルドとリリース版がともに `0.13.0` だったため、8/15 の `display_name` 修正が 8/8 インストール分に届かず `path escape` が 9/5 まで残っていた。**修正版を実機へ反映するときは、必ず設定画面から一度アンインストールしてから入れ直す**
- **インストール済み拡張の実体は `~/Library/Application Support/Claude/Claude Extensions/<extension-id>/`** — `manifest.json` を直接読めば UI を開かずに版ズレを判定できる（`display_name` と `version` を見る）
- 🔴 **アンインストールすると sensitive 項目（`password` / `confirm_phrase`）だけが消える** — 他の項目は残るため「設定は生きている」ように見える。必須項目が欠けると Claude Desktop は `mcp_config` を解決できず、**`No MCP config found for extension ...` を warn で出すだけでサーバーを起動しない**。error ではなく warn なので見落としやすい
- ⚷ **設定値の実体は `~/Library/Application Support/Claude/Claude Extensions Settings/<extension-id>.json`**（Windows は `%APPDATA%\\Claude\\...`）。`userConfig` に **パスワードと合言葉が平文**で入る。切り分けでバックアップしたら作業後に必ず削除する

## npm publish（2026-08 の変更）

- 🔴 **publish に 2FA のワンタイムパスワードが必要**になった。AI は代行できない → **publish 3本は田中さんがターミナルで実行**（`--otp=` を付ければブラウザ不要）
- **classic token は 2027-01 に直接 publish 不可**になる → Granular Access Token への移行が必要
- 🔴 **publish は必ず `pnpm` 経由**（npm CLI は `workspace:*` を変換せず v0.12.2 を壊した）
- ⚠️ E403 `cannot publish over...` は失敗ではなく「成功済みの再実行」。`npm view <pkg> versions --json` で実測してから判断
- publish 前に `npm whoami`（トークン失効を先に検出する）

## v0.13 の設計上の落とし穴

- **`.aiftp.toml` を信頼境界にしない** — AI が編集できる。認可はここに依存させない
- **`.mcpb` は実体が zip** — 中身はそのまま受講者に配られる。展開して実測する
- **`pnpm deploy` は使えない** — symlink ループで `mcpb pack` が `ENAMETOOLONG`。`pnpm pack` + `npm install --omit=dev --ignore-scripts` 方式
- **`--ignore-scripts` は意図的** — ネイティブモジュールは macOS 版が Windows 向けバンドルに混入する。代償は `ssh2` が純 JS＝ SFTP がやや遅い
- **合言葉を MCP のどこにも出さない** — ツール応答・prompt・リソース・エラー文・ログ。**AI が見た合言葉はその AI をゲートできない**
- **Desktop 判定は明示フラグ `AIFTP_DESKTOP`** — 他の環境変数の有無で代用しない
- **ターミナル利用者（v0.12 既存ユーザー）の挙動を変えない**
- MCP elicitation は Claude Desktop に存在しない（Claude Code のみ）
- ⚠️ **破壊的変更（v0.13）**: `aiftp_rollback_confirm` が `safety.prod_profile_patterns` 一致時に `acknowledge_production: true` を要求する
- 🔴 **`.aiftp.toml` に該当プロファイルのブロックが無いと bootstrap は黙って何もしない** — `reconcileOwnedFields`（`packages/core/src/bootstrap/index.ts`）は `findProfileBlockRange` が空振りするとそのまま返し、`config = 'existing'` になる。**設定と反映先が食い違ったまま全チェックが pass する**構図だった。v0.13.1 の `setup_status` の `config_match` はこれを捕まえるためにある
- 🔴 **拡張機能の設定はプロセス起動時の環境変数だけ** — 動作中のプロセスからは Desktop 側の設定変更を検知できない（原理的に不可能）。`setup_status` の `notice`（読み込み時刻）はこの制約を利用者に伝えるためのもの。「変更を検知して自動再読み込み」は実装できないので設計に入れない

## 認証情報の実務知識（実測で判明）

- 🔴 **Keychain 保存値は `aiftp-v1:` + base64**（`packages/core/src/keychain.ts` の `encodeStored`）。生値を `security -w` で読むと 530 になる
- **Windows の資格情報ターゲット名は `<service>:<account>`** — アカウント（＝FTP ユーザー名）を変えると**古いエントリが取り残される**
- 合言葉は**サイト単位ではなく拡張機能に1本**（`user_config.confirm_phrase`）
- 照合仕様（`packages/mcp/src/confirm-phrase.ts`）: 最初の空白1個で分割／チャレンジは大文字小文字を無視／**合言葉は大文字小文字を区別**／前後空白は両側で trim
- ⚠️ `confirm_phrase: pass` は新旧どちらの値かを判別できない（未設定と弱すぎるも区別しない）

## 従来からの項目

- **npm パッケージ名は `@aiftp-tools/cli`** — 旧名 `ftpush` は別物
- **スターサーバー本番 `/public_html`** に直接テストファイルを置かない
- **`@aiftp-tools/core` は dist/ から export** — core 変更後は `pnpm -F @aiftp-tools/core build` 必須
- **ローカルフックが `--no-verify` をブロック**（`aiftp/CLAUDE.md` の Codex 向け記載と矛盾するが、フックが優先）。**コミット subject は 72 文字以内**
- **テストの HOME 隔離は Windows で USERPROFILE 併設必須**
- **CLI エントリは `packages/cli/dist/bin.js`**
- **basic-ftp は PASV でなく EPSV** — FTP ログの grep は 227 でなく **229**
- **squash merge 運用のため「merge 済みか」は `git rev-list` / `git diff` では判定できない** — `gh pr list --state merged --json headRefName` で見る
- CI の flaky 再実行: `gh run rerun -R aiftp-tools/aiftp --job <jobId>`
- **Bash の作業ディレクトリはセッション内で持続する** — `cd` 後にリポジトリ外へ戻ると git コマンドが失敗する。長いセッションでは絶対パスを使う

