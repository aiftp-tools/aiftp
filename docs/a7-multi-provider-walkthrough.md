# A-7 実機検証ウォークスルー — 3 社同時 14 日ウィンドウ

**作成**: 2026-05-21
**対象**: aiftp v0.9.1 を ロリポップ！ / さくらのレンタルサーバ / エックスサーバー の 3 社で同時実機検証
**目的**: `docs/research-sources.md` §C-4（国外IPフィルタの provider 別挙動）と `docs/compatibility-matrix.md` を**一次データ**で埋め切り、v1.0.0 READY の前提を満たす
**所要**: 14 日（カレンダー）/ 集中作業時間 約 8 時間
**最大コスト**: **0〜572 円**（ロリポップ 1ヶ月契約のみ）

---

## D-day カレンダー

> 「D」= 申込み完了日（基準日）

| 日 | アクション | 何が必要か |
|---|---|---|
| **D-1** | 各社の利用規約・無料試用条件を 5 分読む | 自動課金条件 / 解約締切 |
| **D+0 (申込日)** | 3 社まとめて申込み完了 → 接続情報受領 | クレカ / 連絡先メール |
| **D+1〜2** | `aiftp init` × 3 / `aiftp doctor --json` × 3 を実行・保存 | 本書 §3 のスクリプト |
| **D+3** | 最小 push → rollback テスト × 3 | 本書 §4 |
| **D+4** | Shift_JIS ファイル名テスト × 3 | 本書 §5 |
| **D+5** | **国外IPフィルタ挙動の実機確認**（最重要）| 本書 §6 |
| **D+6〜7** | 各社固有の検証（§7〜§9） | 本書 §7〜§9 |
| **D+8** | 結果を `compatibility-matrix.md` に書き込み | 本書 §10 |
| **D+9** | aiftp v0.9.x patch リリースが必要なら準備 | 別ブランチ |
| **D+10** | **Xserver 10 日試用期限**: 解約 or 継続判断 | カレンダーリマインダー |
| **D+10〜13** | バッファ（テスト不足分を消化） | — |
| **D+13** | ロリポップ 10日試用期限（場合により）。延長するなら 1ヶ月契約 ¥572 | カレンダーリマインダー |
| **D+14** | **さくら 2 週間試用期限**: 解約 or 継続判断 | カレンダーリマインダー |
| **D+15** | 振り返り & compat-matrix 最終確認 | — |

> **重要**: 各社の試用期間は申し込み手順を完了した日からカウントされる。
> 試用が「サーバー設定完了」から始まるか「申し込み完了」から始まるかは
> 各社で異なるので、申込時に必ず**解約締切日**をメモする。
> Google Calendar 等にリマインダーを必ず設定すること（推奨: 期限の 2 日前 + 当日朝）。

---

## §1. 申込みチェックリスト（D+0）

### 1-1. ロリポップ！ライト 10日無料お試し

- 申込み URL: <https://lolipop.jp/order/form/>
- 推奨: **ライト プラン**（FTPS / PHP / MySQL あり、月 572 円〜）
- 期間中は無料、自動課金されないことを確認
- 初期ドメイン: `*.lolipop.jp` で OK（独自ドメイン不要）
- 接続情報メモ:
  - サーバー名（例: `userN.lolipop.jp`）
  - FTP ユーザー（=ロリポップアカウント）
  - FTP パスワード（ユーザー設定）
  - 初期ドメイン

### 1-2. さくらのレンタルサーバ スタンダード 2週間無料お試し

- 申込み URL: <https://secure.sakura.ad.jp/order/rs/>
- 推奨: **スタンダード プラン**（FTPS / PHP / MySQL / 国外IPフィルタ確認可、月 425 円〜）
- 初期ドメイン: `*.sakura.ne.jp` で OK
- **国外IPフィルタが初期 ON** なので、検証用に**いったん OFF にする**かどうかをここで判断
- 接続情報メモ:
  - FTP サーバー（例: `userN.sakura.ne.jp`）
  - FTP アカウント / パスワード
  - 国外IPフィルタの管理画面 URL（コントロールパネル内）

### 1-3. エックスサーバー スタンダード 10日無料お試し

- 申込み URL: <https://www.xserver.ne.jp/order/>
- 推奨: **スタンダード プラン**（月 990 円〜、3年契約最安）
- **半額キャッシュバックキャンペーン**（2026/5/7〜6/4、実質 495 円〜）: 検証期間と被るので長期契約を考えるなら活用可
- 初期ドメイン: `*.xsrv.jp` で OK
- 接続情報メモ:
  - サーバーパネル / FTP サーバー名
  - FTP アカウント / パスワード

### 1-4. 申込み後の即時アクション

- 各社の管理画面に**初回ログイン**（パスワード設定/変更が要る場合あり）
- 各社で **FTP / FTPS 接続情報**を確認
- 各社で **TLS 証明書**（FTPS 用）の状況を確認
- **解約締切日を Google Calendar に登録**（最重要）

---

## §2. 検証用ローカル準備

```bash
# aiftp の最新を確認
cd ~/Projects/Web/AIftp/aiftp
git log --oneline -5
aiftp --version   # v0.9.1 になっているか

# 検証専用の作業ディレクトリを作る
mkdir -p ~/aiftp-verify/{lolipop,sakura,xserver}
cd ~/aiftp-verify
```

### 2-1. 検証用 fixture（3 社共通で同じ内容を上げる）

```bash
# シンプルな HTML / 画像 / Shift_JIS ファイル名混在の小さなセット
cat > ~/aiftp-verify/.fixtures/index.html <<'EOF'
<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>aiftp test</title></head>
<body><h1>aiftp v0.9.1 verification</h1>
<p>このファイルは aiftp の実機検証で配置されました。</p></body></html>
EOF

# Shift_JIS ファイル名（中身は ASCII OK）
mkdir -p ~/aiftp-verify/.fixtures/sjis
touch ~/aiftp-verify/.fixtures/sjis/日本語ファイル.html

# サブディレクトリ（mkdir 連鎖の検証）
mkdir -p ~/aiftp-verify/.fixtures/sub/deep/dir
echo "deep" > ~/aiftp-verify/.fixtures/sub/deep/dir/leaf.txt
```

各社の作業ディレクトリに **`.fixtures` を symlink** することで、全社同じ内容を上げて差分が出ない状態を作る。

---

## §3. doctor 検証（D+1〜2）

各社で同じ手順を踏む。**出力はそのまま `docs/walkthrough-<provider>.md` に保存**して、本書の判定の一次データとする。

```bash
# 1. プロジェクト初期化
cd ~/aiftp-verify/lolipop  # / sakura / xserver
aiftp init  # 対話的に host / port / protocol / user / remote_root を入力

# 2. doctor を JSON で取得（一次データ）
aiftp doctor --profile production --json > doctor.json
cat doctor.json | jq '.checks[] | {id, status, hint}'

# 3. doctor を人間用にも保存
aiftp doctor --profile production > doctor.txt 2>&1
```

### 期待する pass/fail パターン

| Check ID | ロリポップ | さくら（フィルタ ON） | さくら（フィルタ OFF） | Xserver |
|---|---|---|---|---|
| `config-exists` | pass | pass | pass | pass |
| `gitignore-aiftp` | pass | pass | pass | pass |
| `keychain` | pass | pass | pass | pass |
| `dns` | pass | pass | pass | pass |
| `tcp-reach` | pass | **fail (国外 IP に応じる)** | pass | pass |
| `ftps-handshake` | pass | fail | pass | pass |
| `cert-chain` | pass / warn | fail | pass / warn | pass |
| `pasv-private-addr` | warn / pass | warn / pass | warn / pass | warn / pass |
| `mlsd-support` | pass | pass | pass | pass |
| `size-support` | pass | pass | pass | pass |
| `remote-root-cwd` | pass | fail | pass | pass |
| `encoding-sniff` | shift_jis or utf-8 | shift_jis or utf-8 | shift_jis or utf-8 | shift_jis or utf-8 |

> **さくらでフィルタ ON のとき `tcp-reach` が fail する**ことを確認できれば、それが README リード文の最強の一次データになる。**スクリーンショットも取る**。

---

## §4. 最小 push → rollback（D+3）

```bash
# dry-run で計画確認
aiftp push --dry-run

# 実 push
aiftp push   # type-to-confirm が必要なら確認文を入力

# サーバ上の存在確認（ブラウザで http://<initial-domain>/aiftp-test/index.html）

# rollback テスト
aiftp backup list
aiftp rollback --steps 1  # 直前の push を巻き戻し

# 再度 doctor / list で巻き戻り確認
aiftp list-remote
```

### 検証ポイント

- [ ] `push --dry-run` の出力に **upload するファイル一覧 + size + dest path** が出る
- [ ] `push` 実行直前に **暗号化バックアップ**が作成される（`.aiftp/backups/` 内）
- [ ] 実 push が成功する
- [ ] `rollback --steps 1` で**ファイルが元に戻る**（または削除される）
- [ ] サーバ上でブラウザアクセスして整合性確認

---

## §5. Shift_JIS ファイル名テスト（D+4）

```bash
# encoding.file_name = "shift_jis" を設定してから push
# .aiftp.toml で:
#   [encoding]
#   file_name = "shift_jis"

aiftp push --dry-run
aiftp push

# サーバ上で「日本語ファイル.html」がそのままの名前で存在するか確認
aiftp list-remote | grep "日本語"
```

### 検証ポイント

- [ ] `file_name = "shift_jis"` で日本語ファイル名がモジバケなく上がる
- [ ] `file_name = "utf-8"` だと **どこかでモジバケする**ことも確認（後でレポートに記録）
- [ ] `file_name = "auto"` の挙動を観察

---

## §6. 国外IPフィルタ挙動（最重要・D+5）

### 6-1. さくら：フィルタ ON のままで FTP 接続を試す

```bash
# さくらのコントロールパネルで「国外IPアドレスフィルタ」が ON のままを確認
# その状態で aiftp doctor / push を試行
aiftp doctor --profile sakura --json | jq '.checks[] | select(.status != "pass")'
aiftp push --dry-run
```

### 期待結果

- `tcp-reach` または `ftps-handshake` が **fail**
- **エラーメッセージに「国外」「filter」「timeout」等の文言**が出るか観察
- スクリーンショット保存

### 6-2. さくら：フィルタ OFF にして再試行

```bash
# さくらのコントロールパネルで「国外IPアドレスフィルタ」を OFF
# 数分待ってから再試行
aiftp doctor --profile sakura --json
aiftp push --dry-run
```

### 期待結果

- doctor が全て pass
- push --dry-run が成功

### 6-3. Xserver: FTP のデフォルト国外制限を確認

- 公式マニュアル通り「FTP はデフォルト無制限」を実測で確認
- `.ftpaccess` を作って IP 制限を入れた場合に挙動が変わるかも追加検証可（時間あれば）

### 6-4. ロリポップ：海外アタックガード OFF が FTP に影響するか確認

- 海外アタックガードはデフォルト ON（WordPress 管理画面系のみが対象のはず）
- FTP 接続には影響しないことを実測で確認

---

## §7. ロリポップ固有検証（D+6）

- [ ] 共有 IP / SNI の TLS 証明書 CN が**ロリポップ汎用名**になっているか
- [ ] 証明書 CN ミスマッチが `doctor cert-chain` で warn になるか fail になるか
- [ ] `.ftpaccess` を置いた場合の挙動
- [ ] ファイル名・パーミッション関連の独自挙動

---

## §8. さくら固有検証（D+6〜7）

- [ ] §6-1 / §6-2 のフィルタ挙動
- [ ] `.htaccess` / `.ftpaccess` の編集権限
- [ ] PASV モード時のアドレス書き換え（NAT 配下）
- [ ] アクセス制限の柔軟性（時々で違うので IP 単位許可も確認）

---

## §9. Xserver 固有検証（D+7）

- [ ] §6-3 確認
- [ ] SSH 設定の「国内のみ許可」を有効にしても FTP には影響しないか
- [ ] サーバーパネルの「アクセス拒否設定」で IP 単位許可を入れた場合の挙動
- [ ] FTPS の証明書状況

---

## §10. compatibility-matrix への反映（D+8）

`docs/compatibility-matrix.md` の各 provider 行を、以下のフォーマットで埋める：

```markdown
### Lolipop / ロリポップ！

- **Plan tested**: Light (10日試用)
- **aiftp version**: v0.9.1
- **Test date**: 2026-MM-DD
- **Overall**: ✅ Works / ⚠️ Works with quirks / ❌ Fails
- **Protocol**: FTPS Explicit
- **Doctor result**: 12/12 pass (or N/12 — list fails)
- **Quirks needed**:
  - `[encoding] file_name = "..."` if needed
  - `[quirks] tls_check_hostname = false` if needed
  - `[quirks] ignore_pasv_address = ...` if needed
- **Foreign-IP filter**:
  - 「海外アタックガード」=  ON by default, **FTP に影響なし**を実測確認
- **Notes**: …
- **Walkthrough log**: docs/walkthrough-lolipop.md
```

同様の構造で `Sakura` / `Xserver` セクションも書く。

---

## §11. 終了処理（D+10 / D+13 / D+14）

各社の試用期限**前日**に必ず：

1. 検証データ（doctor JSON / スクリーンショット / push ログ）を `docs/walkthrough-<provider>.md` に転記済か確認
2. 解約 or 継続を判断
3. 解約する場合は管理画面で**確実にキャンセル手続きを完了**
4. クレジットカード請求明細で**自動課金されていないことを翌月確認**

### 継続候補

- **Xserver の半額キャッシュバック中**: 長期利用予定なら活用（実質 495 円〜）
- **さくら**: 国外IPフィルタの**継続観察用に契約**もありうる（月 425 円〜）
- **ロリポップ**: aiftp の主要ターゲット層なので**最低 3〜6 ヶ月の継続観察**を推奨（月 264 円〜＝最安）

---

## §12. 不測事態への備え

| 起こりうること | 対応 |
|---|---|
| **試用期間中にバグ発覚** | v0.9.x patch を別ブランチで準備 → 試用環境で再確認 |
| **試用 → 自動課金されてしまった** | 即座にサポートへ連絡（多くの場合は返金対応可） |
| **TLS 証明書が想定外に self-signed** | doctor で warn が出るはず。aiftp 側のメッセージング改善案を Issue 化 |
| **国外IPフィルタが ON で aiftp が誤動作** | エラーメッセージの分かりやすさを改善する patch を Issue 化 |
| **3 社並列で集中力が切れた** | さくら（国外フィルタ）のみ最優先で完了させる。他は順次 |

---

## §13. 田中さんの作業範囲 / Claude の作業範囲

### 田中さんが手を動かすところ

- 申込み × 3 社（クレカ・電話番号入力等）
- 管理画面操作（国外IPフィルタ ON/OFF など）
- 解約手続き
- スクリーンショット取得

### Claude が事前に準備するもの（このセッションで完了）

- 本書（`docs/a7-multi-provider-walkthrough.md`）
- `docs/walkthrough-<provider>.md` の雛形（次のセクションで作成可）
- `compatibility-matrix.md` の各 provider セクション枠

### Claude が事後に支援できるもの

- doctor JSON の解析・整理
- compat-matrix へのコピペ・整形
- 発見した bug の Issue 起票文ドラフト
- 必要なら aiftp 側 patch の TDD 実装

---

## §14. 関連ドキュメント

- 一次資料: `docs/research-sources.md` §C-4
- 現行 compatibility: `docs/compatibility-matrix.md`
- ローンチチェックリスト: `docs/phase0-launch-checklist.md`（A-7 ライブ再認証ゲートは [ADR 0002](adr/0002-v1.0-release-gate-redefinition.md) で撤廃済み）
- 既存検証ログ: `docs/v0.2-walkthrough.md` (Star Server)

---

**Version**: 2026-05-21
**Status**: Ready — 田中さんの「申込み D-day」決定待ち
