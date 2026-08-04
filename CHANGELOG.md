# Changelog

All notable changes to **aiftp** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release tags live in the GitHub repository:
<https://github.com/aiftp-tools/aiftp/releases>

---

## [Unreleased]

(Pending work for v0.12.x and beyond.)

---

## [0.13.0] — 2026-08-04

**Minor release** — Claude Desktop 用の `.mcpb` 拡張を追加。ターミナルと Node.js の導入なしで aiftp を使えるようにし、本番反映に人間の合言葉ゲートを設けた。

### Added

- **Claude Desktop 拡張（`.mcpb`）** — GitHub Release に `aiftp-0.13.0.mcpb` を添付。ダブルクリックで導入でき、Node.js の導入も MCP 設定 JSON の手編集も不要。設定 UI で選んだサイトフォルダを起動時に冪等ブートストラップし（`.aiftp.toml` 生成・キーチェーン保存・サイト台帳登録）、以後は CLI 版とまったく同じ状態を共有する。**未署名配布**（理由と安全性の根拠は `docs/desktop-extension.md`）。
- **`aiftp_setup_status` ツール** — 拡張の設定が揃っているかを 6 項目（bootstrap / プロジェクトフォルダ / `.aiftp.toml` / キーチェーン / サイト台帳 / 合言葉）で報告する読み取り専用ツール。失敗した項目には**日本語の `hint`** が付く。設定不足でサーバ起動を失敗させると Claude Desktop は「接続エラー」としか表示しないため、起動は常に成功させ不足はここで返す設計。
- **`aiftp_setup` prompt** — 接続確認 → テスト領域へ push → 本番反映 → ロールバックの 4 ステップを案内する MCP prompt。本リポジトリ初の prompt。
- **本番 push の合言葉ゲート** — 本番プロファイルへの `aiftp_push_prepare` がプランごとのチャレンジコードを返し、`aiftp_push_confirm` は `confirmation: "<チャレンジ> <合言葉>"` の完全一致を要求する（タイミング安全比較・ハッシュのみ保持）。合言葉はツール出力に一切出ないため、**人間がチャットに入力するまで confirm は通らない**。提示と受理は `.aiftp/log.jsonl` に記録される。**同一会話内での再利用という既知の限界**は `docs/desktop-extension.md` に明記した。合言葉が未設定の場合、**ターミナル / Claude Code からの利用は** v0.12 と同じ `acknowledge_production` のみのゲートになる（CLI 利用者との互換）。**Claude Desktop 拡張からの利用ではこのフォールバックは適用されず、本番反映はエラーで拒否される**（詳細は `docs/desktop-extension.md`）。

### Changed

- **ロールバックの本番プロファイルゲート（`aiftp_rollback_confirm`）、破壊的変更** — 最終レビューで、`aiftp_rollback_confirm` が本番反映と違って**一切のゲートを持たない**（`plan_id` / `diff_hash` / `confirm_token` と、AI 自身が渡せるリテラル `acknowledge_deletions: true` だけで、リモートサーバへの書き込み・削除が実行できる）ことが判明した。`aiftp_rollback_prepare` は `aiftp_push_prepare` と同じ方法で `safety.prod_profile_patterns` に対してプロファイルを照合し、一致すれば `prod_profile_warning: true` を返す。一致した場合、`aiftp_rollback_confirm` は `acknowledge_production: true` を明示的に渡さない限り拒否される（`false` はスキーマレベルで拒否し、実行時ガードへのすり抜けを許さない — push と同じ設計）。**合言葉ゲートは意図的に対象外のまま**: ロールバックは復旧手段であり、合言葉を忘れた・設定し忘れた受講者でも本番を壊れたままにしないため。**破壊的変更**: 既存の v0.12 ターミナル利用者は、`safety.prod_profile_patterns`（既定値 `prod*` / `production*` / `main*`）に一致するプロファイルへロールバックする際、新たに `acknowledge_production: true` を渡す必要がある。一致しないプロファイルへのロールバックは無変更。
- **init プリミティブを core へ移設** — キーチェーンのサービス名生成（`buildKeychainService`）と `.gitignore` への `.aiftp/` 追加（`ensureGitignoreEntry`）を `@aiftp-tools/cli` から `@aiftp-tools/core` へ移した。CLI の挙動は変わらない。Desktop 拡張が同じ規約を再実装せずに済むようにするための整理。

---

## [0.12.4] — 2026-07-27

**Patch release** — Windows CI の flaky を根本解決し、`[preflight]` 設定を実際に効くよう接続、サイト台帳と `known_hosts` のセキュリティ強化、エラーメッセージの改善。**ユーザー向けの挙動変更は `[preflight]` の接続と `json_check` の既定値のみ**（下記参照）。

### Fixed

- **Windows CI の flaky テストを根絶** — `aiftp_push_confirm rejects a stale plan_id` が Windows Node 22 でのみ 5000ms タイムアウトしていた。原因は MCP のユニットテスト 2 件が fake を注入し忘れて実 OS キーチェーンに到達していたこと。Windows のキーチェーン読み取りは `powershell` を起動して `Add-Type -TypeDefinition` で C# を実行時コンパイルするため、CI の並列負荷下で vitest 既定の 5 秒タイムアウトを超えていた。あわせて、テスト中に実 OS キーチェーンへ到達したら即座に失敗する fail-closed ガードを追加し、同種の漏れが Windows 限定の flaky ではなく全環境で即時に露見するようにした。ユーザー環境での事故を防ぐため、ガードは `NODE_ENV=test` と `AIFTP_TEST_NO_REAL_KEYCHAIN=1` の両方が揃ったときのみ作動する。
- **`stale plan_id` テストが 1 回目の confirm の失敗を隠していた問題** — plan の consume が実 push より前に起きるため、1 回目の confirm が失敗してもリプレイ拒否のアサーションは緑のままだった。実際には state スタブが不正な `schema: 2` を返しており常に失敗していた。1 回目の成功を明示的に検証するようにした。

- **`[preflight]` の設定が実際に効くようになった** — `php_lint` / `json_check` はテンプレートが `.aiftp.toml` に書き込んでいたが、CLI / MCP が `checkAll(paths)` を options なしで呼んでいたため **runtime に一切反映されていなかった**。設定を push 経路へ接続した。あわせて `json_check` の既定値を `false` → `true` に変更している（従来は設定が無視されて常に実行されていたため、`false` をそのまま honor すると全ユーザーの JSON 検証が黙って無効化されてしまう）。`php_lint` は `php -l` をファイルごとに起動して遅く、PHP 環境がなければ無意味なので既定 `false` のまま。
- **`local_root` の設定ミスが読めるエラーになった** — 従来は `ENOENT: no such file or directory, scandir '<絶対パス>'` という生のエラーで、どの設定が悪いのか人にも AI にも分からなかった。設定名と解決後のパスを含むメッセージに変更。
- **サイト台帳のサイト名・パス検証を厳格化（セキュリティ LOW-1）** — 手編集された `~/.aiftp/sites.toml` が任意の文字列をサイト名として受け付けていた。`aiftp init --from <x>` は `x` をファイルパスとして解決する **前に** 登録サイト名を照合するため、`../prod` や `client/a` のようなパス形状の名前が利用者の意図した引数を横取りし、設定の継承元をすり替えられた。サイト名を `^[A-Za-z0-9._-]+$` の許可リストに限定し、`path` は絶対かつ正規化済みを必須にした。`sites add` は元々 `resolve()` で書き込むため既存の正規レジストリは影響を受けない。
- **`known_hosts` のパーミッションを修復するようにした（セキュリティ LOW-2）** — `mkdir` / `appendFile` の `mode` は**新規作成時にしか効かない**ため、旧バージョンや手作業で作られた `~/.aiftp`（0755）や `known_hosts`（0644）が緩いまま放置されていた。ピン留め時に 0700 / 0600 へ明示的に修復する（POSIX のみ）。
- **CLI のロールバックが注入された keychain を伝播するようにした** — `defaultRunRollback` が `createDefaultBackupStore` に keychain を渡しておらず、呼び出し側が指定しても実 OS キーチェーンにフォールバックしていた。
- **秘密値を「形」で検証していたテストの誤検知を解消** — Keychain に保存された値が「`/` で始まらないこと」を確認していたが、自動生成のバックアップ鍵は標準 base64（アルファベットに `/` を含む）なので **実測 1.4%（144/10000、理論 1/64）で実際の欠陥なく落ちていた**。実際のパス値と比較する形に修正。OS 非依存の問題で、たまたま Windows で顕在化していた。

### Added

- **`AiftpMcpRuntime.hasPassword`（任意）** — `aiftp_profile_list` が返す `credentialsStatus` の資格情報プローブを差し替えられるようにした。既定は従来どおり実 OS キーチェーンなので本番挙動は不変。core の `ResolveSiteDeps.hasPassword` と同じ依存注入パターン。

### Changed

- **`aiftp_push_prepare` の説明に `diff.removed` と `plannedDeletes` の違いを明記** — `diff.removed` は「ローカルから消えたが state には残っている」観測結果、`plannedDeletes` は `safety.deletion_policy` 適用後に実際にリモートから削除される部分集合。前者が非空で後者が空なのは、削除が保留中なのではなくポリシーが抑止している状態を意味する。

---

## [0.12.3] — 2026-07-27

**Patch release** — MCP ローカル起動、CLI エラー表示、バックアップ復元エラー、CHANGELOG リンクを改善。

> **0.12.2 は欠番。** 同一内容を 0.12.2 として公開したが、`npm publish` が
> `workspace:*` を実バージョンへ変換しないため、`@aiftp-tools/{cli,mcp}@0.12.2`
> は `npm install` できない成果物になっていた。`latest` は 0.12.1 へ巻き戻し済み。
> npm はバージョン番号を再利用できないため、同じ変更を 0.12.3 として公開する。

### Added

- **MCP のローカル起動手順に Node 直接実行例を追加** — `pnpm` のログによる stdio 汚染を避ける推奨設定として、ビルド済みの `packages/cli/dist/bin.js` を `node` で直接起動する。
- **`restoreFile()` のファイル未検出エラーにパス一覧を追加** — manifest 内の remote-relative path を最大10件表示し、残りがある場合は件数を要約する。

### Fixed

- **`aiftp init` の引数エラーが2回表示される問題を修正** — action site で報告済みの `CommanderError` は CLI entry point で再表示せず、終了コードだけを反映する。help/version の exit code 0 は成功扱いを維持する。

### Changed

- **CHANGELOG の比較・リリースリンクを現行タグまで補完** — `[Unreleased]` の比較起点を v0.12.1 に更新し、実在する v0.10.0〜v0.12.1 のリリースリンクを追加する。

---

## [0.12.1] — 2026-07-26

**Patch release** — v0.12.0 で入った `aiftp init` の非対話 stdin ガード回帰を修正。

### Fixed

- **`aiftp init` が非対話 stdin (パイプ / リダイレクト) を再び拒否するようになった** — 非対話 stdin ガードがフロー終盤の確認画面 (`runInitSummaryReview`) にしか無く、v0.12.0 で init 冒頭に追加された「サイト台帳解決 → テンプレート選択プロンプト」が先に走るため、`aiftp init </dev/null` がテンプレート選択の表示のまま **exit 0** で終了していた。ガードを共通関数 `assertInteractiveInitStdin()` に統一し、**プロンプト・台帳参照・資格情報書き込みのいずれよりも前**で発火させる。週次 smoke CI (3 OS × Node 22/24) がこの回帰を検出していた。

### Changed

- **`aiftp init --template list` は非対話 stdin でも実行できる** — テンプレート一覧はプロンプトを一切出さない情報表示なので、非対話ガードの対象外とした。AI エージェントやシェルパイプから一覧を取得できる (AI-first 設計)。ガードは引数検証と一覧表示の直後に置かれ、対話が必要な処理は従来どおり全て遮断される。

---

## [0.12.0] — 2026-07-11

**Feature release** — 「サイト台帳 (site fleet)」。1 台のマシンで複数のレンタルサーバー / サイトを AI エージェント経由で運用する際の資格情報衝突・誤送信・設定重複を解消する 4 機能 (F1〜F4) と、v0.11 で残課題だった SFTP ホスト鍵検証 (TOFU) を実装。本人ドッグフード (glocalworks.co.jp) で顕在化した痛点「複数サイトの資格情報管理が煩雑」への直接対応。

### Added

#### F1 — サイト台帳 (site registry)

- **グローバル台帳** `~/.aiftp/sites.toml` — 登録済みサイトへの **ポインタのみ** (絶対パス + `default_profile`) を保持。**資格情報は一切書かない** (資格情報は従来どおり OS Keychain のみ)。原子的書き込み (temp + rename)。
- **`aiftp sites` サブコマンド** — `list` (登録一覧、`--json` で機械可読出力) / `add [path]` (`--name` / `--label` / `--default-profile`) / `remove <name>` / `doctor` (全登録サイトの設定検査、`--connect` で実接続チェック)。
- **MCP `aiftp_sites_list`** — read-only tool。AI クライアントが登録サイト一覧を取得可能。台帳を **書き換える MCP tool は提供しない** (登録は CLI 経由のみ)。

#### F2 — `aiftp init --from <ref>` (設定継承)

- 既存サイト (台帳名) またはパスから、`.aiftp.toml` の defaults + カスタマイズ済みセクション (port / protocol / FTPS mode / passive mode / server kind / file-name encoding) を継承して新規サイトを初期化。
- **host / user / keychain_service は継承しない** — サイト固有値の取り違え・資格情報の相互汚染を防ぐ。`--from` と `--template` は排他。

#### F3 — 宛先バナー + MCP fail-closed 照合

- **宛先バナー** — `aiftp push` / `aiftp rollback` 実行時に `⛳ 宛先: <site> (<label>)` を表示。`--yes` でも表示され、cwd が未登録なら profile 名にフォールバック。**host 等の資格情報はバナーに出さない**。
- **MCP `expected_site` fail-closed** — AI クライアントが宣言した `expected_site` と cwd の解決結果が一致しない場合、`site-mismatch` で拒否 (実 push は起動しない・plan_id や秘密は漏らさない)。AI の宛先取り違え事故を構造的に遮断。

#### F4 — Keychain サービス命名のサイト固有化

- keychain サービスの既定値を `aiftp:<profile>` → **`aiftp:<site>-<profile>`** に変更。複数プロジェクトで同じ profile 名 (例 `production`) を使っても keychain サービス名が衝突せず、資格情報の相互上書きを防ぐ。`<site>` は制御文字等をサニタイズ、解決不能時は従来形式にフォールバック (既存 config の migration は不要 — 変わるのは init 時の提案既定値のみ)。
- **`doctor` に `keychain-collision` warn** — サイト非固有な `aiftp:<profile>` 形式を使い、かつ同一 `default_profile` を持つサイトが台帳に複数ある場合に警告。

#### セキュリティ — SFTP ホスト鍵 TOFU ピンニング (CWE-295)

- **`.aiftp/known_hosts` Trust-On-First-Use** — SFTP 初回接続時にホスト鍵をピン留めし、以降は照合。**鍵が変化した場合は明示的に拒否** (MITM 検知)。v0.11 の既知の制限 (ホスト鍵を無検証で受理) を解消。

#### WordPress テンプレート

- 全 4 WordPress テンプレ (`wordpress-swell` / `wordpress-lightning` / `wordpress-cocoon` / `wordpress-standard`) の `excludeAdd` に **`wp-content/debug.log`** を追加。WP_DEBUG_LOG が残したデバッグログの誤アップロードを防止。

### Fixed

- **`aiftp sites list --json`** が table 形式を返していた不具合を修正 — 子コマンドが親スコープの `--json` フラグを継承していなかった (Commander.js の親子オプション解決)。

開発: 2026-07-06 〜 07。spec → 実装計画 → Claude 実装 / Codex 独立レビュー ループ → 多サイト統合 E2E テスト。品質ゲート: 857 tests passed / 3 skipped / 0 failed、Branches coverage 89%+、biome lint clean、`tsc --noEmit` clean。

---

## [0.11.0] — 2026-05-26

**Feature release** — 「SSH が使えない 50%+ の日本のレンタルサーバーで、AI と仕事をする」をコンセプトに、4 ピラーを実装。

- **Pillar α**: PromptFlow ステートマシン (`packages/cli/src/prompt-framework/`) — 三重防御 A (入力ヒント表示) と B (`:back` 戻りナビ) を実装。v0.10.4 の C (summary review) と組み合わせて完成。
- **Pillar β**: WordPress 特化テンプレ 7 種 (`packages/core/src/templates/`)。
- **Pillar γ**: SFTP 対応 (`packages/core/src/sftp-client.ts` + `deploy-client-factory.ts`)。
- **Pillar δ**: 3 OS × 2 Node smoke CI + 競合比較ドキュメント。

開発期間: 2026-05-25 〜 2026-05-26 (2 日)。spec → writing-plans → TDD → Codex Phase 1/2 review → 統合テスト → release。

### Added

#### Pillar α (init UX framework)

- **PromptFlow ステートマシン** (`packages/cli/src/prompt-framework/prompt-flow.ts`) — 順次フィールド prompt + sanitize + validate + iter cap (100) + `:back` keyword navigation。30 箇所の既存 prompt を順次移行する基盤。v0.11 では `aiftp init` のみ移行、残りは v0.11.x で順次対応。
- **入力ヒント表示** (A) — 各 field に `hint` + `example` を表示。「何を入れるべきか分からない」誤入力を未然防止。
- **`:back` 戻りナビゲーション** (B) — 任意の field で `:back` と入力すると前 field に戻る。連続戻りも可能。
- **hint 重複抑制** (S1) — validate 失敗ループ中の hint スパムを抑制し、UX を改善。

#### Pillar β (WordPress 特化テンプレ)

- **テンプレレジストリ** (`packages/core/src/templates/`) — zod strict schema + 7 preset を module-load 時に検証 (closed set, MCP injection 防止)。
- **7 プリセット**: `wordpress-swell` / `wordpress-lightning` / `wordpress-cocoon` / `wordpress-standard` / `static` / `laravel` / `php-simple`。各テンプレが hard-exclude / safety / preflight の妥当な既定値を提供。
- **CLI**: `aiftp init --template <id>` でテンプレ適用、`aiftp init --template list` で 7 件一覧表示、未指定時は PromptFlow で対話選択。
- **MCP**: `aiftp_init_template_list` read-only tool — AI クライアントがテンプレ一覧を取得可能。
- **renderConfig 拡張** — `[backup.hard_exclude]` / `[safety]` / `[preflight]` セクションをテンプレに応じて出力。

#### Pillar γ (SFTP 対応)

- **SftpClient** (`packages/core/src/sftp-client.ts`) — `ssh2-sftp-client` ベース。FtpClient と同 interface (connect / disconnect / list / upload / uploadBuffer / download / delete / size / exists / rename / mkdir) で透過に切替可能。
- **SSH 鍵認証** — `0o600` / `0o400` permission check (`ssh(1)` ポリシー準拠)。over-permissive な鍵ファイルは connect 前に拒否し、`chmod 600 <path>` 修復ヒントを出す。
- **deploy-client-factory** — protocol 別に FtpClient / SftpClient を切替。deploy / rollback / backup は factory 経由で動作するため、`protocol = "sftp"` を `.aiftp.toml` に書くだけで全コマンドが SFTP 経由になる。
- **config schema 拡張** — `protocol` enum に `"sftp"` 追加、`ssh_key_path` optional 追加。
- **doctor SFTP 4 check** — `ssh-port-reachable` / `ssh-key-permissions` / `sftp-handshake` / `sftp-remote-root`。FTP/FTPS profile では skip、SFTP profile では FTPS 系 check が skip される dispatch。
- **FileZilla import SFTP 対応** — `<Protocol>1</Protocol>` (SFTP) を `protocol = "sftp"` + port 22 として取り込み (従来は skip していた)。
- **`aiftp init` の protocol prompt に SFTP 追加** — FTPS / SFTP / FTP の 3 択。

#### Pillar δ (smoke CI + 競合比較)

- **`.github/workflows/smoke.yml`** — 3 OS (macOS / Ubuntu / Windows) × 2 Node (22 / 24) matrix。release / workflow_dispatch / 月曜 09:00 JST スケジュール。
- **`.github/workflows/scripts/mcp-smoke.sh`** — `aiftp mcp` stdio JSON-RPC probe (≥ 22 tools 確認)。
- **`docs/competitive-comparison.md`** — vs alxspiker/mcp-server-ftp / Computer Use / WordPress 公式 MCP / git-ftp / SamKirkland 系の比較。aiftp の立ち位置を明文化。

### Changed

- `parseInitAnswers` の `protocol` 型が `'ftp' | 'ftps'` から `'ftp' | 'ftps' | 'sftp'` に拡張。
- `deploy.ts` / `rollback.ts` / `backup/` の `new FtpClient(...)` 直接構築箇所 (cli, mcp, backup の 3 箇所) を `createDeployClient(...)` 経由に refactor。FTP/FTPS profile の挙動は完全互換。
- doctor の FTPS probe 出力に SFTP 専用 4 check を追加 (SFTP profile 以外は skip)。
- `aiftp init` の protocol prompt に SFTP 選択肢が追加され、SFTP profile を init 経由で作成可能に。

### Quality gates

- 全テスト **740 passed / 3 skipped** (v0.10.4 baseline 630 から +110)
- biome lint clean / build clean / tsc --noEmit clean
- branches coverage 84%+ (v0.10.4 の 83.29% から維持・改善)
- smoke CI は release 後に自動起動 (3 OS × 2 Node = 6 matrix jobs)

### Security

- SFTP 鍵 permission gate: world/group-readable な秘密鍵は connect 前に拒否。
- HIGH 1 fix: テンプレ適用時に `safety.prod_profile_patterns` の default `main*` が消失するバグを修正。`main` プロファイルでも production type-to-confirm gate が外れない。
- HIGH 2 fix: `static` / `laravel` テンプレで summary review でユーザーが確認した `localRoot` 値が render 時に template default で上書きされるバグを修正。ユーザー編集値が常に最優先。
- **Codex セキュリティ専用 review (v0.11.0 release 直前)** で発見した CWE-22/94/200/295/367/732/664/400/527 系を release blocker として全 fix:
  - **CWE-22/94**: profile 名の TOML key injection — schema + init parse + FileZilla importer の 3 層で `isValidProfileName` を強制。`[profile."../tmp"]` が `.aiftp/state` / `.aiftp/backups` 外への path traversal にならない。
  - **CWE-22**: `remote_root` / FileZilla `<RemoteDir>` の `..` segment / backslash / control char / `//` empty segment を拒否（`assertSafeRemotePath`）。
  - **CWE-22/367**: `ssh_key_path` の `..` segment を tilde 展開前にも拒否（`safeExpandLocalPath`）。さらに `lstatSync` で symlink を refuse し、stat-then-read の TOCTOU window を縮小。
  - **CWE-200/732**: MCP FileZilla import の confirm tempfile が `mode: 0o600` を明示。post-rename `.aiftp.toml` が umask 起因で world-readable にならない。

### Platform notes

- **Windows SFTP key auth**: `SftpClient.loadSshKey()` skips the `0o600/0o400` POSIX mode-bit check on Windows because NTFS does not honour Node `chmod` faithfully (a 0o600 key reads back as 0o666). The real Windows security mechanism is NTFS ACL; operators on Windows should use `icacls` to restrict the key file (e.g., `icacls C:\path\to\id_ed25519 /inheritance:r /grant:r %USERNAME%:R`). `aiftp doctor` returns `ssh-key-permissions: skip` with `keyMode: windows-acl` to surface the platform difference.

### Known security limitations (v0.11)

- **CWE-295: SFTP host key verification は v0.11 では実装されない**。`SftpClient.connect()` は known_hosts / TOFU pinning を行わず、初回接続時のサーバ提示 host key を盲目的に受理する。経路上の MITM 攻撃で password / 鍵 signing oracle が悪用される可能性。`aiftp doctor` の `sftp-handshake` check は `warn` 状態を返し続け、毎回 limitation をログに出す。 v0.12 で `.aiftp/known_hosts` TOFU pinning を実装予定（[review log](docs/superpowers/specs/2026-05-26-v0.11-security-codex-review.md) Finding 3）。
- **CWE-664: SFTP upload が atomic rename ではない** — 接続断で remote に partial file が残る。v0.11.1 で `.aiftp-tmp-<uuid>` 経由の atomic rename を実装予定（同 Finding 7）。
- **CWE-400: FileZilla XML parser の `processEntities: true`** — entity expansion 系 DoS の理論的耐性が低い。fast-xml-parser@5.8.0 では既知 CVE なし。v0.11.1 で `processEntities: false` + 入力サイズ上限を予定（同 Finding 6）。

### Deferred (v0.11.x へ繰越)

Pillar β Codex review で挙がった MEDIUM / LOW:

- WP 4 templates の `wp-content/debug.log` 共通 exclude (wordpress-standard のみ実装済み)
- `vendor/**` hard exclude の方針再検討 (Composer 不可サーバーでは vendor を FTP 配置するケースあり)
- preflight `php_lint` / `json_check` を CLI/MCP runtime に接続 (現状 schema + TOML 出力のみ)
- MCP `aiftp_init_template_show` tool 追加 (defaults を surface する read-only 補助)
- edge test 追加 (空文字 `--template` / `--template list` への余剰引数 / template-select cancel)
- 他 prompt 箇所の PromptFlow 移行 (`aiftp auth` / `aiftp config edit` 等 30 箇所)

詳細: [docs/superpowers/specs/2026-05-26-v0.11-pillar-beta-codex-review.md](docs/superpowers/specs/2026-05-26-v0.11-pillar-beta-codex-review.md)

### Process

- brainstorming → spec (2026-05-25) → writing-plans (2026-05-25) → TDD (各 task) → Codex Phase 1/2 review (Pillar β で実施、γ/δ は次マイルストーン)
- Codex `--write` モードのサンドボックス制限 (`.git/index.lock` 書き込み拒否) を回避する hybrid 体制: **Codex が実装 + Claude が commit 代行**

### Notes for adopters

`.aiftp.toml` の `protocol = "sftp"` + `ssh_key_path = "~/.ssh/id_ed25519"` で SFTP deploy 可能。FTP/FTPS profile は v0.10.4 と完全互換 — 移行作業不要。

---

## [0.10.4] — 2026-05-25

**Reflective patch release** — addresses 田中さんの 2026-05-24 review feedback ("ユーザは必ず入力ミスする前提で仕様を考える / 入力間違いの recovery path も仕様化する / 抜け落ちた点がないかテストする / Codex にダブルチェック").

Implementation followed the brainstorming → spec → plan → TDD → Codex Phase 1/2 review → release flow. Spec doc lives at `docs/superpowers/specs/2026-05-24-init-input-validation-recovery-design.md`.

### Added

- **`aiftp init` summary review** — after answering all prompts, a summary table now lists every captured value with a number, and the user can confirm with `Y`/Enter, abort with `n`, or enter `1-10` to edit a specific field in place. Edit loop is capped at 10 iterations to prevent runaway. The summary is the C-leg of the "三重防御 (A hint + B back-nav + C summary review)" plan; A and B are scheduled for the v0.11 input validation framework.
- **Per-field sanitization at the initial-prompt boundary** (`sanitizeFieldInput`): all text fields are trimmed and rejected if they contain control characters (`U+0000`-`U+001F`) before the value reaches TOML / keychain. Password keeps leading/trailing whitespace (intentional) but rejects control characters.
- **Strict summary-choice parsing** (`parseSummaryChoice`): rejects 全角数字 (`１０`), ambiguous numerics (`01`, `1abc`, `1.5`), and internal whitespace (`1 5`). Paste-with-trailing-newline is trimmed and accepted. `null` / `undefined` is treated as cancel (Ctrl+C / EOF), not as accept.
- **Non-TTY guard** in `runInitSummaryReview` — `aiftp init < /dev/null` style invocations fail explicitly instead of blocking on stdin forever.
- **`onCancel` callback** in `defaultPrompt` — real prompts library no longer auto-`process.exit()` on Ctrl+C; cancel is detected downstream.
- **Non-standard port confirmation re-fires on protocol edit** — changing FTPS to FTP with port `990` still in the answers now prompts the user, instead of silently accepting an incompatible combination.
- **Non-standard port decline returns to summary loop** instead of aborting the whole init — the user gets another chance.

### Tests

- **40 new tests** in `packages/cli/src/index.spec.ts`:
  - 15 helper tests for `sanitizeFieldInput` / `parseSummaryChoice`
  - 25 summary-review integration tests (Codex Phase 1 review reflected: cancel safety, strict choice parsing, --force collision, profile rename desync, whitespace normalization, control char reject, very long strings, non-Latin, non-TTY, abort side-effect ordering)

### Process

- **Codex Phase 1 review** (spec test list) — session `019e5895-3d1f-7103-850e-2de1da665313`, surfaced 12 missing edge cases (cancel safety, 全角数字, control chars, whitespace, non-TTY, etc.) which were incorporated into spec §6.1 #14-25.
- **Codex Phase 2 review** (implementation vs spec) — session `019e5b56-c7bc-7c03-ba40-4cb625ff8673`, surfaced 3 Critical + 5 Should-fix items which were all addressed (C1 parseInitAnswers sanitization, C2 onCancel, C3 isTTY !== true, S1 keychain default, S2 port decline returns to loop, S3 protocol-port cross check, S4 test #17 strengthened, S5 mock limitation documented).
- **Spec divergences resolved**:
  - `10\n` paste: implementation trims-then-parses (more forgiving UX for paste); spec updated to match
  - profile name with non-ASCII: TOML bare-key constraint forbids it; spec updated to test host/password for non-Latin instead. Quoted-key TOML support deferred to v0.11.

### Quality gates

- 630 tests passed / 3 skipped / 0 failed (+40 from v0.10.3)
- Branches coverage 83.29% maintained; Statements 90.25%
- biome lint clean; build clean

---

## [0.10.3] — 2026-05-24

**Quality patch** — reflective release closing the prompt-validation coverage gap surfaced by v0.10.1 / v0.10.2. 田中さんの指摘 ("port は標準ポート以外なら確認すべき / 非正常系のテストはどの程度か") への対応。

### Added

- **`aiftp init`** now warns and asks for explicit confirmation when the FTP port is non-standard. Standard ports are `21` (FTP) and `21` or `990` (FTPS implicit); any other value triggers a `Non-standard FTPS port 8021 (standard: 21 or 990). Continue?` confirmation. Declining aborts init with `aborted: non-standard FTP/FTPS port N was not confirmed`. ([F-X8 / v0.10.3])

### Tests

- `packages/core/src/encryption.spec.ts`: +6 branch-coverage tests (empty buffer / payload too short / invalid magic / unsupported algorithm / corrupted auth tag / encrypted file too short). `encryption.ts` Branches coverage **61.53% → 83.87%** (+22.34 pp).
- `packages/cli/src/index.spec.ts`: +4 init non-standard-port tests (confirm-yes / confirm-no / FTPS 990 standard / port 990 over plain FTP).

### Quality gates (post-fix)

| Metric | v0.10.2 | v0.10.3 |
|---|---|---|
| Statements coverage | 89.99% | **90.25%** |
| Branches coverage | 82.81% | **83.29%** |
| Functions coverage | 95.36% | **95.36%** |
| Total tests | 580 | **590** (+10) |

### Process improvements

CLAUDE.md / memory.md に "prompt 実装時のチェックリスト" を追記する方針を確認:

- [ ] 全 prompt 型 (`text` / `password` / `number` / `select` / `confirm`) を横断 review
- [ ] 各型で空 / 不正値 / 境界値 (`Infinity`, `NaN`, 範囲外) を listing
- [ ] Branches coverage が 80% 未満のファイルは PR ブロック対象
- [ ] 非対話的 mock テストとは別に、実機 smoke test を CI 化 (next milestone)

---

## [0.10.2] — 2026-05-24

**Patch release** — follow-up to v0.10.1 closing the same-day `aiftp init` UX gap.

### Fixed

- **`aiftp init`** now validates the **FTP port** prompt as well. The v0.10.1 fix (#7) added per-prompt validation only to `text` / `password` prompt types; the `number` type port prompt was left untouched, and in certain input sequences the `prompts` library returned `-Infinity` for it, causing init to fail at the end with `port must be an integer`. The port prompt now enforces `min: 1, max: 65535` with a descriptive `validate` callback. The terminal `parseInitAnswers` validator was also tightened with a dedicated `requirePort` helper that rejects out-of-range integers with an explicit error message (`port must be between 1 and 65535 (e.g. 21 for FTP, 990 for FTPS implicit)`). ([#8 — F-X7](https://github.com/aiftp-tools/aiftp/issues/8))

### Tests

- Two regression guards added in `packages/cli/src/index.spec.ts`:
  - `init rejects -Infinity port`
  - `init rejects port outside 1-65535 range`

---

## [0.10.1] — 2026-05-24

**Patch release** — quick follow-ups from v0.10.0 field verification (Xserver, Sakura) and npm publish smoke test (Lolipop fresh init).

### Fixed

- **`aiftp init`** now provides a sensible default for the **Keychain service** prompt (`aiftp:<profile-name>`). Previously the prompt was empty, and pressing Enter silently advanced past the field; init then failed at the final step. ([#6 — F-X5](https://github.com/aiftp-tools/aiftp/issues/6))
- **`aiftp init`** now validates required fields **per prompt** (host / user / remoteRoot / localRoot / keychainService / password). Empty input is rejected on the spot instead of letting all prompts complete and then aborting at validation. ([#7 — F-X6](https://github.com/aiftp-tools/aiftp/issues/7))

### Changed

- `DEFAULT_EXCLUDE_PATTERNS` now uses the glob `.aiftp.toml.*` instead of the literal `.aiftp.toml.bak`. This covers arbitrary backup suffixes (`.bak`, `.before-vXXX`, `.old`, …) and prevents accidental leakage of pre-upgrade config snapshots — observed on Xserver during v0.10.0 field verification. ([#3 — F-X1](https://github.com/aiftp-tools/aiftp/issues/3))

### Documentation

- `docs/v0.10.0-field-verification.md` §4/§6/§8 now explicitly call out that `local_root = "."` recurses into ALL subdirectories under the working directory, and that archive / scratch directories MUST live **outside** the working directory. ([#4 — F-X2](https://github.com/aiftp-tools/aiftp/issues/4))

### npm registry

All three packages are published under the `@aiftp-tools` scope:

- [`@aiftp-tools/cli`](https://www.npmjs.com/package/@aiftp-tools/cli) (renamed from unscoped `aiftp` due to npm spam protection; bin name `aiftp` preserved)
- [`@aiftp-tools/core`](https://www.npmjs.com/package/@aiftp-tools/core)
- [`@aiftp-tools/mcp`](https://www.npmjs.com/package/@aiftp-tools/mcp)

```bash
npm install -g @aiftp-tools/cli
aiftp --version  # → 0.10.1
```

---

## [0.10.0] — 2026-05-23

**Breaking release** — Snapshot manifest schema 1 → 2, remote delete/prune semantics, and MCP rollback confirmation contract change.

See [`docs/migration-v0.10.0.md`](docs/migration-v0.10.0.md) for migration guidance.

### Breaking changes

- Snapshot manifest schema bumped to `2`. v0.9.x cannot read schema 2 manifests; downgrade is unsupported once v0.10.0 has written a snapshot to `.aiftp/`. Restore from manual backup of `.aiftp/` if a downgrade is required.
- `aiftp_rollback_confirm` (MCP) now **requires** `acknowledge_deletions: true` when the corresponding prepare returned `plannedDeletes.length > 0`. Rollback was previously single-factor (`confirm_token`); it is now 2-factor in line with `aiftp_push_confirm`.
- `diff_hash` format updated to `aiftp-push-plan-v2` / `aiftp-rollback-plan-v2`. The hash input now includes both upload and delete sets. Older hashes are rejected on confirm.

### Added

- **Snapshot schema 2**: per-file `operation` field (`"added" | "modified" | "removed"`) and manifest-level `counts: { added, modified, removed }`. `added` files are recorded as tombstones (no content stored) so rollback can issue a real `delete`.
- **`[safety].deletion_policy`** config (default `"never"`): `"never"` / `"prune-auto"` / `"prune-with-confirm"`. Default preserves v0.9.x behavior.
- **CLI `aiftp push` interactive delete confirmation**: when `deletion_policy = "prune-with-confirm"` and at least one remote delete is planned, the CLI now requires the operator to type `DELETE` at an interactive prompt before mutating. There is no `--confirm-deletes` flag — the typed-prompt is the only confirmation path (intentionally, to prevent muscle-memory `y`/Enter from deleting production files).
- **CLI `aiftp rollback`** now issues a real remote `delete` for `added` tombstones in the target snapshot. Dry-run output now shows planned deletes alongside planned uploads.
- **MCP `aiftp_push_prepare` / `aiftp_push_confirm`** now bind `plannedDeletes`, `expected_delete_count`, and re-run the dry-run on confirm to detect drift in both upload and delete sets.
- **MCP `aiftp_rollback_prepare` / `aiftp_rollback_confirm`** now bind `plannedDeletes`, surface `deleted` in the confirm response, and require `acknowledge_deletions: true` when deletes are planned (see Breaking changes).
- **New docs**: [`docs/migration-v0.10.0.md`](docs/migration-v0.10.0.md), [`docs/v0.10.0-field-verification.md`](docs/v0.10.0-field-verification.md).

### Changed

- `max_files_per_push` now counts uploads + deletes combined (was upload-only).
- Hard-exclude (`wp-config.php`, `.env*`, `db.php`, ...) now applies to both upload AND delete planning. Auth-bearing files are NEVER deleted or rolled back.
- `runPush` schedules upload first, then delete second; snapshot creation happens before any remote mutation (push or delete) so every push remains reversible.
- `rollback` delete intentionally does NOT swallow `FtpNotFoundError` (FTP 550): on Sakura / Lolipop the same code can also mean "permission denied", so the error surfaces to the caller.
- MCP `aiftp_push` (direct dry-run tool) now wires `deletion_policy` into the underlying `runPush` `safety` block. Previously direct dry-run preview always showed `plannedDeletes: []`.

### Fixed

- `restoreAll()` JSDoc now documents the schema 2 tombstone throw behavior. (`restoreAll()` itself has no production callers in v0.10.0; the public surface is reserved for future runtime adapters.)
- Stale `default-store.spec.ts` assertion (`fileCount === 0` for added-only push) aligned with schema 2 semantics (`fileCount === 1` for one tombstone).

### Internal

- New `PushBackupStore` interface in `@aiftp-tools/core` minimizes the backup-store contract that `runPush` requires, eliminating `as unknown as` casts in MCP and CLI runtime/dry-run wiring.
- `SnapshotCounts` is now re-exported from `@aiftp-tools/core` root index.

---

## [0.9.5] — 2026-05-22

Release-check hardening patch for v0.9.4.

### Fixed

- `pnpm test` and `pnpm test:coverage` now generate the core
  `VERSION` module before Vitest imports `@aiftp-tools/core`, so a
  fresh clone no longer depends on an ignored local
  `packages/core/src/version.generated.ts` file.
- `aiftp push --dry-run` no longer requires an initialized backup key.
  The CLI now mirrors the MCP dry-run path and uses a no-op backup store
  because core never creates snapshots during dry runs.

### Tests

- Added regression coverage for backup-key-free CLI dry runs, root
  test-script version generation, and `[walk] follow_symlinks` behavior.

---

## [0.9.4] — 2026-05-22

UX / init hardening patch — four small features bundled together so
the v0.10.0 snapshot redesign starts from a less footgun-prone base.

### Fixed

- **Default-exclude rules are now actually applied.** Prior to v0.9.4,
  `DEFAULT_EXCLUDE_PATTERNS` (`.aiftp.toml`, `.aiftp/`, `.git/`) was
  only respected when the CLI / MCP layers manually merged it into
  `userPatterns`. The A-7 verification accidentally uploaded the
  operator's `doctor-*.txt` / `doctor-*.json` files to a Sakura test
  account because that merge happened in some codepaths but not
  others. `Excluder` now auto-applies the list internally (controlled
  by a new `useDefaults` option, default `true`), and the manual
  merges in CLI / MCP / `default-store.ts` were removed to avoid
  double-prepending.

### Added

- **Expanded `DEFAULT_EXCLUDE_PATTERNS`**: `doctor-*.{txt,json}`,
  editor swap files (`*.swp`, `*.swo`, `*~`, `#*#`, `.#*`), OS
  metadata (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`), and
  VCS metadata (`.gitignore`, `.gitattributes` joined the existing
  `.git/`). All are gitignore-style soft excludes so an operator
  who legitimately needs to ship a `.DS_Store` can opt back in via
  a `!` negation pattern.
- **`[exclude] use_defaults` config option** (default `true`). Set
  to `false` in `.aiftp.toml` to skip the defaults entirely.
- **`[walk] follow_symlinks` config option** (default `false`).
  The file walker now explicitly documents and controls symlink
  behaviour. Setting it to `true` lets the walker resolve symlinks
  via `stat()`, useful for operators sharing fixture directories
  via `ln -s`. The A-7 verification hit this when
  `~/aiftp-verify/sakura/index.html` was a symlink and produced
  `added=0`; opting in now fixes that.
- **`packages/core/scripts/generate-version.mjs`** auto-generates
  the runtime `VERSION` constant from `packages/core/package.json`
  at build time (`prebuild` / `pretypecheck` hooks). The generated
  file `packages/core/src/version.generated.ts` is gitignored. This
  closes the "v0.9.2 shipped twice with `aiftp --version` reporting
  `0.0.0`" footgun: bumping the package version is now enough.
- **New `aiftp backup init` CLI command**. Creates a fresh
  AES-256-GCM backup key in the OS keychain for a profile without
  re-running `aiftp init` (which would overwrite `.aiftp.toml`).
  Use this after hand-editing `.aiftp.toml` to add a profile. The
  `--force` flag overwrites an existing key (and breaks all prior
  encrypted snapshots — there's a loud warning).
- **Friendlier error from `default-store` when the backup key is
  missing**: previously surfaced the bare
  `Keychain entry not found: service=... account=...`; now wraps
  it in a `BackupError` whose message includes the exact
  `aiftp backup init --profile <name>` command to fix it. The
  underlying error is preserved as `cause` for debugging.

### Documentation

- `Excluder.getEffectivePatterns()` now returns the defaults as
  part of the user-pattern list (per the new auto-apply behaviour).
  Two tests in `exclude.spec.ts` were updated to reflect the new
  expectation and a new test was added for the `useDefaults: false`
  opt-out path.
- `default-exclude.spec.ts` is new (16 cases covering the A-7
  leak vector, hard-exclude precedence, user negation, and opt-out).

### Notes

- Test suite at v0.9.4: **530 passed / 3 skipped** across 30 files.
- No `.aiftp.toml` schema changes beyond the two new optional
  fields (`exclude.use_defaults`, `walk.follow_symlinks`); existing
  configs continue to load.
- v0.10.0 (snapshot semantic redesign — `docs/v0.10.0-plan.md`)
  remains the next planned release; v0.9.4 closes out the small
  hardening work first so the v0.10.0 PR series can focus on data
  model changes.

---

## [0.9.3] — 2026-05-22

Safety hardening patch — two targeted fixes that came out of A-7
multi-provider verification on the day after v0.9.2 shipped.

### Fixed

- **`certificateMatchesHost` now supports RFC 6125 single-label
  leading wildcards.** Previously it did exact-string matching only,
  so `*.sakura.ne.jp` did not match `<user>.sakura.ne.jp` and
  `ftps-cert: warn` fired spuriously on every Sakura / Xserver /
  Lolipop hostname (all three use shared wildcard certs). The
  matcher now follows §6.4.3 of RFC 6125:
  - exact match always wins
  - `*.example.com` matches exactly one host label
    (`foo.example.com`, not `foo.bar.example.com` and not
    `example.com`)
  - middle wildcards (`foo.*.example.com`), trailing wildcards
    (`example.*`), bare `*`, and `*.` are refused
  - matching is case-insensitive (DNS names are case-insensitive)
  - both the CN and every SAN are tested
  See `packages/core/src/diagnostics/cert-match.spec.ts` for the
  full table of accepted / rejected patterns (22 cases).

### Added

- **`aiftp doctor` now has a dedicated `ftp-auth` check** (split
  out of `ftps-handshake`). Before v0.9.3 a wrong password and a
  broken TLS handshake both reported as `ftps-handshake: fail`,
  which during A-7 verification cost about an hour of debugging a
  "TLS issue" that was actually a typo'd password. Now:
  - `ftps-handshake`: TLS layer only — pass if the TLS handshake
    completes (cert obtained, cipher negotiated)
  - `ftp-auth`: USER/PASS only — pass if login succeeds, fail with
    `recommendation: aiftp auth set --profile <name>` if the
    server returns 530, skip when handshake failed first or the
    probe stub didn't separate the two phases
  The CLI's `probeFtps` wrapper classifies `FtpAuthError` /
  `FtpTlsError` from the core FTP client so the new split is
  driven by the real underlying error, not by string-matching
  the message.

### Documentation

- CHANGELOG entry for v0.9.3 lists the cert-match rules
  explicitly so operators can predict whether their provider's
  shared cert will pass without `tls_check_hostname=false`.

### Known limitations (still planned for v0.9.4 / v0.10.0)

- VERSION constant in `packages/core/src/index.ts` still has to
  be hand-bumped alongside the four package.json files; v0.9.4
  will auto-generate it at build time.
- `local_root = "."` still walks every file in the working
  directory; v0.9.4 will introduce a default-exclude list.
- `aiftp init` is still the only path that creates
  `.aiftp/backups/`; v0.9.4 will add an auto-init path or a
  clearer error.
- Snapshot semantic for added-only push is still metadata-only;
  v0.10.0 (`docs/v0.10.0-plan.md`) is the redesign.

### Notes

- Test suite at v0.9.3: **508 passed / 3 skipped** across 29 files.
- No schema changes from v0.9.2 → v0.9.3.

---

## [0.9.2] — 2026-05-22

A-7 multi-provider verification (Lolipop / Sakura / Xserver) revealed
several issues; the BLOCK-level ones are fixed in this release, the
rest are tracked under "Known limitations" below and queued for
v0.10.0.

### Fixed

- **Backup snapshot is now created on added-only pushes.**
  Previously `deploy.ts` only invoked `createAutoSnapshot` when
  `modified > 0`, so an initial push (which is typically all
  `added`) created **no snapshot at all**, leaving the operator
  unable to roll back. The condition is now `planned.length > 0`,
  and the snapshot is built from the union of added + modified
  targets. This was discovered during A-7 verification against a
  freshly-contracted Sakura Rental Server test account and confirms
  the spec's "every push is reversible" promise.

### Added

- **`aiftp doctor` surfaces the underlying error message on stderr**
  when the FTPS probe path fails. Previously every probe failure
  (TLS handshake, 530 login incorrect, PASV refused, etc.) was
  reported as the catch-all "FTPS handshake failed." Now the doctor
  prints `[doctor probeFtps error] <message>` so the operator can
  tell, for example, that the real problem is a wrong password
  rather than a TLS layer issue. `AIFTP_DEBUG=1 aiftp doctor`
  additionally pipes basic-ftp's verbose FTP-command log to stderr.

### Documentation

- README lead rewritten with the "foreign-IP filtering on Japanese
  shared hosting × AI-agent safety" angle, citing Sakura's
  2014-03 announcement and Claude Code's public issue tracker
  generically (rather than naming specific issues that may close).
- CHANGELOG, NOTICE (production-only license inventory), privacy
  policy, roadmap, and v1.0.0 release-notes draft added.
- Community templates added: CONTRIBUTING.md, CODE_OF_CONDUCT.md,
  SECURITY.md, and four Issue / PR templates.
- `docs/a7-multi-provider-walkthrough.md` documents the 14-day
  3-provider verification procedure used to find the bugs above.

### Verified on real hosting (A-7)

| Provider | doctor result | Notes |
|---|---|---|
| Star Server | ✅ (since v0.1.0) | — |
| Lolipop! Light | ✅ 9 pass / 3 warn / 0 fail | `tls_check_hostname=false` recommended for shared TLS cert; `use_mlsd=false` (Lolipop is MLSD-less). 海外アタックガード ON does not affect FTP. |
| Sakura Rental Server | ✅ 9 pass / 3 warn / 0 fail | Same TLS quirk pattern as Lolipop. **国外IPフィルタ default ON (FTP included) confirmed in 2026, matching the 2014-03 announcement.** |
| Xserver Standard | ✅ 9 pass / 3 warn / 0 fail | Same TLS quirk pattern. FTP unrestricted by default (per public docs). |

### Known limitations (planned for v0.10.0)

These were discovered during A-7 verification but are out of scope
for v0.9.2's BLOCK fix. They will land in v0.10.0:

1. **Snapshot for added-only pushes has `files=0`** — `createSnapshot`
   reads via `source.readFile(path)`, which (correctly per the spec)
   downloads the *remote* old version. For genuinely new files,
   there is no remote old version, so the snapshot is metadata-only.
   `aiftp rollback` therefore reports `0 file(s) uploaded` and the
   newly-added files are not deleted from the remote. v0.10.0 will
   redesign the snapshot to carry added/modified/removed
   classification so `rollback` can `delete` for added, `restore`
   for modified, and `restore` for removed.

2. **`local_root = "."` walks every file in the working directory.**
   During A-7 verification, doctor output files (`doctor-*.txt`,
   `*.json`) the operator had saved locally were inadvertently
   uploaded. The hard-exclude list catches credentials but not
   general-purpose work files. v0.10.0 will add either an explicit
   `include` allow-list mode or a more conservative default-exclude
   list (`doctor-*`, `*.bak`, common editor swap files, etc.).

3. **`doctor`'s `ftps-handshake: fail` is over-broad.** As of v0.9.2,
   the underlying error message reaches stderr, but the result
   *status* is still "FTPS handshake failed" even for 530 (login
   incorrect) where the TLS handshake actually succeeded. v0.10.0
   will split this into `ftps-handshake` (TLS layer) and `ftp-auth`
   (USER/PASS) with distinct status codes.

4. **`certificateMatchesHost` is exact-match, not wildcard-aware.**
   `*.sakura.ne.jp` does not match `<user>.sakura.ne.jp` in
   the current implementation, so `ftps-cert: warn` is raised even
   when the cert is genuinely valid for the host. v0.10.0 will add
   RFC 6125 wildcard matching to `certificateMatchesHost`.

5. **`aiftp init` is the only path that creates `.aiftp/backups/`
   and the backup-key.** Operators who hand-edit `.aiftp.toml`
   (e.g. for multi-environment workflows) need a separate
   `aiftp backup init` command or an auto-create path in
   `aiftp push`. v0.10.0 will add the missing initialization
   path with an explicit warning rather than silent failure.

### Notes

- Test suite at v0.9.2: **486 passed / 3 skipped** across 28 files.
- macOS / Windows CI both green.
- No `.aiftp.toml` schema changes from v0.9.1 → v0.9.2.

---

## [0.9.1] — 2026-05-21

### Fixed

- **FFFTP importer**: password-protected profiles were silently dropped
  during import. Now emits `password.kind = 'absent'` plus a per-profile
  warning prompting the operator to run `aiftp auth <profile>`.
- **FFFTP importer**: respect `[Hosts] SetNumber` so stale (deleted)
  `[hostN]` sections past the active count are no longer imported as
  phantom profiles.
- **FFFTP importer**: explicit handling of `KanjiCode=2` (JIS) — falls
  through to `auto` rather than silently defaulting.
- **MCP `acknowledge_production`**: schema tightened from `z.boolean()`
  to `z.literal(true).optional()` so a bare `false` is now rejected at
  the schema layer rather than the handler layer.
- **`aiftp hook`**: stdin now has a 10 MB hard cap and 10 s timeout via
  `Promise.race`, preventing OOM and indefinite hangs on runaway hook
  producers.
- **`relativizeIntoProject`** (hook path mapping): Windows-style
  `C:\project\file.html` paths now resolve correctly, with proper
  case-folding (Windows is case-insensitive by default).

### Notes

- Phase 2 (import / watch / hook / multi-profile / rollback / production
  gate) is now considered complete.
- Test suite: **485 passed / 3 skipped** across 28 files.

---

## [0.9.0] — 2026-05-21

### Added

- **`aiftp hook`** — Claude Code / Cursor `PostToolUse` hook handler.
  Reads JSON from stdin, extracts edited file paths, prints a dry-run
  status notification. **Never pushes** — strictly notification-only.
- **`extractHookPaths` / `relativizeIntoProject`** in `packages/core` —
  defensive parsers for hook payloads (Write / Edit / MultiEdit /
  NotebookEdit), with cross-platform path handling.

### Phase 2 #5 complete.

---

## [0.8.0] — 2026-05-21

### Added

- **`aiftp watch`** — debounced filesystem watcher using `fs.watch`
  recursive (Node 22+). On detected changes, prints a dry-run push
  preview. **Never pushes on its own**; the operator stays in the loop.
- **`createWatchDebouncer`** in `packages/core` — pure function with
  test-injectable clock for deterministic debouncing tests.

### Phase 2 #4 complete.

---

## [0.7.0] — 2026-05-21

### Added

- **`aiftp import ffftp`** — direct FFFTP `ffftp.ini` parser, reads
  Shift_JIS via `iconv-lite`. Maps `[hostN]` sections to `[profile.*]`
  entries with encoding, protocol, and per-profile warnings.
- **`iconv-lite`** lifted to a direct dependency.

### Notes

- FFFTP's `Password` field is Mask-encrypted with a non-standard scheme;
  aiftp intentionally does not decode it. The operator runs
  `aiftp auth <profile>` after import.

### Phase 2 #3 complete.

---

## [0.6.0] — 2026-05-20

### Added

- **Production push type-to-confirm gate**: `[safety] production_profile_patterns`
  (glob list) flags profiles as production. Pushing to a production
  profile requires the operator to type a non-trivial acknowledgement
  string — not a y/n the AI can auto-skip.
- **`isProdProfile`** utility in `packages/core/src/safety.ts`,
  anchored-glob match with optional warn-on-unmatched mode.
- **MCP `acknowledge_production`** parameter added to `aiftp_push_confirm`.

### Phase 2 #7 (誤配信防止 UX) complete.

---

## [0.5.0] — 2026-05-20

### Added

- **`aiftp rollback`** CLI command with `--steps N` / `--snapshot <id>`
  selectors.
- **`aiftp_rollback_prepare` / `_confirm`** MCP tools, following the
  same two-step gate pattern as push / restore / migrate / import.
- **`createRollbackUploader`** hook to keep rollback's atomic
  guarantees independent of the regular upload path.
- **Two-phase atomic rollback**: all files upload to staging paths
  first, then are atomically renamed into place. A mid-rollback failure
  cannot leave the site half-rolled.

### Fixed (v0.5.0 review block-fixes)

- **HIGH**: drift detection now re-runs between prepare and confirm so
  a file changed after prepare is caught instead of silently uploaded.
- **HIGH**: uploader contract narrowed — duck-typing on `basic-ftp`'s
  client was replaced with an explicit interface that the rollback path
  injects, so a future basic-ftp signature change cannot silently break
  rollback.
- **HIGH/MEDIUM**: 4 + 6 review issues from Codex + Claude resolved
  before tag.

---

## [0.4.2] — 2026-05-20

### Added

- **MCP `aiftp_config_migrate_prepare` / `_confirm`** and
  **`aiftp_import_filezilla_prepare` / `_confirm`** — completing the
  two-step gate coverage across all destructive MCP tools.
- **`toolVersion`** field in `.aiftp/logs/migrations.jsonl` audit
  entries.
- **`randomUUID`** for migration temp file names to prevent collision
  on concurrent runs.

### Fixed

- **BLOCK**: `config_migrate_prepare` previously returned the full
  generated TOML in the prepare response, leaking credentials. Now
  returns a structured `sections_added` summary instead.
- **BLOCK**: TOCTOU race in `config_migrate` between read and write
  fixed by inline atomic write (no longer delegates to `loadConfig`).
- **HIGH/MEDIUM (10 issues from Claude + Codex)**: migrated_source
  redaction, drift recheck, batch dedup, atomic write hardening, and
  more.

---

## [0.4.1] — 2026-05-20

### Added

- **MCP `aiftp_profile_list` / `_current` / `_test`** — read-only
  profile inspection tools for AI agents. All return redacted views
  (no credentials).
- **`resolveDefaultProfile`** utility replacing the hardcoded
  `DEFAULT_PROFILE = 'production'`. Precedence: `AIFTP_PROFILE` env >
  state file's last-used > sole-profile fallback.
- **`runtime.runDoctor?`** hook on `AiftpMcpRuntime` (CLI wiring is a
  v0.4.2 candidate).

### Fixed (review block-fixes)

- **HIGH**: schema-required vs optional handler-resolved profile
  consistency.
- **HIGH**: redaction of resolved-profile info from `aiftp://config`.
- **HIGH/MEDIUM (5 + 5 issues)**: from dual Claude + Codex review.

---

## [0.4.0] — 2026-05-20

### Added

- **`aiftp profile`** command group: `list`, `use`, `show`, `test`.
- **Multi-profile support** with sole-profile fallback (single
  `[profile.*]` defined → auto-use without explicit selection).
- **State file `.aiftp/state/last-profile`** tracking the last-used
  profile per project directory.

---

## [0.3.0] — 2026-05-19

### Added

- **Windows credential backend**: `cmdkey` for writes, Win32
  `CredRead` via PowerShell for reads (DPAPI-protected at rest).
- **`KeychainBackend` interface** isolating macOS `security` and
  Windows `cmdkey`/`CredRead` behind a common contract.
- **CI matrix expanded to `windows-latest`** alongside `macos-latest`
  and `ubuntu-latest`.

---

## [0.2.5] — 2026-05-19

### Added

- **Auto-mkdir for `remote_root`** when the directory doesn't exist
  on first connect. Surfaced as a one-time `info` in doctor.
- **`aiftp ls <remote-path>`** quick diagnostic command for verifying
  CWD behavior without a full doctor run.

---

## [0.2.4] — 2026-05-19

### Added

- **`remote-root: fail` details**: doctor and `probeFtps` now report
  the CWD error code and the path that triggered it, instead of a
  bare "fail" status.

---

## [0.2.3] — 2026-05-19

### Fixed

- **`aiftp doctor probe`** now respects `[quirks] tls_check_hostname`,
  matching the runtime FTP client's hostname-verification policy.

---

## [0.2.2] — 2026-05-19

### Added

- **MCP `aiftp_backup_restore_prepare` / `_confirm`** with explicit
  path-traversal guard.
- **`[quirks] noop_interval_sec`** wired to `basic-ftp`'s keepalive,
  preventing idle disconnects on hosts with aggressive timeouts.
- **`[quirks] tls_check_hostname`** to opt out of hostname verification
  (with a loud warning) for hosts that present a generic shared
  certificate.

---

## [0.2.1] — 2026-05-19

### Added

- **`probeFtps`** pure utility for testing FTPS handshake + certificate
  chain without committing to a full client connection.
- **`server_kind = "starserver"`** quirk preset bundling Star
  Server-specific defaults (hostname-only TLS, PASV behavior, etc.).
- **FtpClient helper methods** for use in doctor and import tooling.

---

## [0.2.0] — 2026-05-19

### Added

- **`aiftp import filezilla`** — FileZilla `sitemanager.xml` importer
  with passwords routed to Keychain. Handles plain-text and
  master-password-encrypted XML.
- **`aiftp profile export filezilla`** — round-trip back to FileZilla
  XML (passwords excluded by default).
- **`aiftp doctor`** — 12 diagnostic checks (config, gitignore,
  keychain, DNS, TCP, FTPS, cert chain, PASV, MLSD, SIZE,
  remote_root CWD, encoding sniff).
- **`aiftp config migrate`** — v1 → v2 schema migration with atomic
  write, `.aiftp.toml.v1.bak` preservation, multi-run guard, audit
  log in `.aiftp/logs/migrations.jsonl`.
- **MCP two-step push gate**: `aiftp_push(dry_run=false)` is now
  refused. Real pushes require `aiftp_push_prepare` →
  `aiftp_push_confirm` with matching `plan_id`, `diff_hash`,
  `confirm_token`. Plans expire after 5 minutes.
- **`aiftp://config` MCP resource redaction** — host / user /
  remote_root / keychain_service no longer exposed.
- **`[encoding]` and `[quirks]` schema v2 sections** —
  Shift_JIS file names, NAT'd PASV addresses, MLSD-less servers, etc.

### Documentation

- README major rewrite.
- `docs/compatibility-matrix.md` created.
- `docs/migration-from-ffftp.md` created.

---

## [0.1.1] — 2026-05-19

### Added

- **`aiftp init`** UX improvements: warning on `/`-prefixed
  `remote_root`, template for `server_kind = "starserver"`.
- **TLS hostname mismatch diagnostics** in `FtpClient` — surfaces
  `cert.subject.CN` and `cert.subjectaltname` plus a recommended
  action. **Does not auto-bypass.**
- **`backup restore` hardening**: empty snapshot id → clear error,
  snapshot id format validation, `--output` path-traversal guard,
  existing-file `--force` requirement.
- **SJIS file name regression test** for `restoreFile`.

---

## [0.1.0] — 2026-05-19 — First public MVP

### Added

- **Core**: TOML config schema v1, diff engine, deploy pipeline,
  encrypted local backup (AES-256-GCM), OS Keychain credential
  storage (macOS `security`), pre-flight checks (`php -l`, JSON, HTML).
- **CLI**: `init`, `status`, `push`, `pull`, `backup`, `auth`,
  `verify`, `restore`.
- **MCP server**: `aiftp_status`, `aiftp_push` (dry-run),
  `aiftp_backup_list` / `_restore` / `_verify` / `_prune`,
  `aiftp_log`, `aiftp_list_remote`.
- **Hard-excluded files**: `.env*`, `wp-config.php`, `*.pem`,
  `db.php`, etc. — cannot be uploaded, backed up, or restored.
- **Server-side lock file** preventing concurrent agent pushes.
- **Star Server verified** end-to-end on the maintainer's production
  hosting.

### Notes

- Phase 1.1 follow-ups (auto-mkdir, init UX, TLS diagnostics)
  landed in v0.1.1.
- Phase 2 work (import / watch / hook / multi-profile / rollback)
  followed across v0.2.x – v0.9.1.

---

[Unreleased]: https://github.com/aiftp-tools/aiftp/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.13.0
[0.12.4]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.12.4
[0.12.3]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.12.3
[0.12.1]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.12.1
[0.12.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.12.0
[0.11.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.11.0
[0.10.4]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.10.4
[0.10.3]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.10.3
[0.10.2]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.10.2
[0.10.1]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.10.1
[0.10.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.10.0
[0.9.5]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.5
[0.9.4]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.4
[0.9.3]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.3
[0.9.2]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.2
[0.9.1]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.1
[0.9.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.9.0
[0.8.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.8.0
[0.7.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.7.0
[0.6.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.6.0
[0.5.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.5.0
[0.4.2]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.4.2
[0.4.1]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.4.1
[0.4.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.4.0
[0.3.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.3.0
[0.2.5]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.5
[0.2.4]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.4
[0.2.3]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.3
[0.2.2]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.2
[0.2.1]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.1
[0.2.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.2.0
[0.1.1]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.1.1
[0.1.0]: https://github.com/aiftp-tools/aiftp/releases/tag/v0.1.0
