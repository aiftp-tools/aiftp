# FFFTP / FileZilla からの移行ガイド

aiftp v0.2 は、FFFTP と FileZilla で蓄積した接続設定を **そのまま流用**
できます。サイトを 1 つずつ手で再登録する必要はありません。

このガイドは「FFFTP（または FileZilla）で日本のレンタルサーバーを長年
触ってきた人が、AI エージェントに同じサイトをデプロイさせたい」場合に
最短ルートを示します。所要時間は登録サイト数によりますが、目安として
1〜2 サイトなら 10 分。

---

## 全体像

```text
FFFTP                    FileZilla                   aiftp
(Hosts.ini, registry)    (sitemanager.xml)           (.aiftp.toml + Keychain)
       │                        │                          │
       │   export to            │   import / export        │
       │  FileZilla XML  ─────▶ │  ─────────────────────▶  │
       │                        │                          │
```

FFFTP は内部に「FileZilla XML エクスポーター」を持っているので、
直接 aiftp に取り込むより一度 FileZilla 形式に書き出すほうが、
読み手（aiftp）にとって境界の整理がきれいです。aiftp 側で FFFTP 固有の
INI / `.reg` 形式を扱うのは v0.3 / `--experimental` 予定。

---

## ルート 1: FileZilla から直接（推奨）

FileZilla を普段使っているなら、sitemanager.xml をそのまま渡すのが最短です。

### 1. sitemanager.xml の場所を確認

| OS | パス |
|---|---|
| macOS | `~/.config/filezilla/sitemanager.xml` |
| Windows | `%APPDATA%\FileZilla\sitemanager.xml` |
| Linux | `~/.config/filezilla/sitemanager.xml` |

### 2. 取り込み内容をプレビュー（書き込みなし）

```bash
cd ~/Projects/<your-project>
aiftp import filezilla ~/.config/filezilla/sitemanager.xml --dry-run
```

出力例：

```
dry-run mode: would import 3 profile(s), skipped 0
would create [profile.clients-acme-corp-production] host=ftp.acme.example.com user=acme-deploy password=***
would create [profile.clients-acme-corp-staging] host=ftp.acme.example.com user=acme-staging password=***
would create [profile.clients-beta-direct] host=ftp.beta.example.com user=beta-user password=***
```

`password=***` が表示されることに注目。**パスワードは画面にも `.aiftp.toml` にも出力されません**。

### 3. 取り込み実行

```bash
aiftp import filezilla ~/.config/filezilla/sitemanager.xml
```

出力例：

```
imported 3 profile(s), skipped 0, warnings 0
```

これで：

- `.aiftp.toml` に `[profile.*]` が追加される（host / user / remote_root / protocol 等）
- パスワードは macOS Keychain に `aiftp:imported:<profile-name>` という service name で保存される（Touch ID プロンプトが出る）

### 4. 動作確認

```bash
aiftp doctor --profile clients-acme-corp-production
```

`summary.fail === 0` であれば移行成功です。

---

## ルート 2: FFFTP から FileZilla 形式経由

### 1. FFFTP で FileZilla XML を書き出す

FFFTP のメニューから：

```
接続 → 設定 → 設定をファイルに保存 → "FileZilla 設定" を選択
→ 保存先を指定（例: ~/Desktop/ffftp-sites.xml）
```

### 2. あとはルート 1 と同じ

```bash
aiftp import filezilla ~/Desktop/ffftp-sites.xml --dry-run
aiftp import filezilla ~/Desktop/ffftp-sites.xml
```

---

## 重複名の取り扱い

すでに `.aiftp.toml` に同じ名前の profile があると、aiftp は **デフォルトでスキップ**します：

```text
skipped: name conflict, skipped (use --overwrite): production
```

上書きしたいときは `--overwrite`:

```bash
aiftp import filezilla sites.xml --overwrite
```

---

## エッジケース

| 状況 | aiftp の挙動 |
|---|---|
| **SFTP プロファイル** | skip（aiftp は v0.2 時点で SFTP 未サポート）。warning `SFTP not supported by aiftp; skipped <name>` |
| **FileZilla の master password で暗号化されたパスワード** | skip（aiftp は復号しない）。warning `master password protected entry skipped: <name>` 。`aiftp auth set --profile <name>` で再入力 |
| **`Logontype = 2`（接続時に聞く設定）** | パスワードは何も保存しない。`aiftp auth set` で後から登録 |
| **`Shift_JIS` ファイル名のサイト** | `[encoding]` セクションに `file_name = "shift_jis"` が自動で入る |
| **PASV モードが OFF** | `[profile.X].passive_mode = false` が自動で入る |

---

## 逆方向（aiftp → FileZilla）

aiftp の profile を FileZilla XML に書き戻すこともできます：

```bash
aiftp profile export filezilla -o exported.xml
```

デフォルトは **パスワード空**（`<Pass></Pass>`）。FileZilla 側で再入力する想定です。
パスワードを含める場合（注意して扱う前提）：

```bash
aiftp profile export filezilla -o exported-with-pass.xml --include-password
```

CLI が `warning: --include-password embeds sensitive credentials ...` と stderr に出します。
出力した XML は **そのファイル自体が秘密**になるので、適切に取り扱ってください。

---

## トラブルシューティング

### "Failed to parse FileZilla XML"

XML が壊れているか、FileZilla 3 系の sitemanager.xml ではない可能性。
`xmllint --noout sitemanager.xml` で文法チェックしてみてください。

### import 後に `aiftp doctor` で keychain: fail が出る

Keychain への書き込みに失敗している可能性。Touch ID をスキップしていないか確認：

```bash
security find-generic-password -s "aiftp:imported:<profile-name>" -a "<user>" 2>&1
```

エントリが見つからなければ `aiftp auth set --profile <profile-name>` で手動登録。

### Windows での Keychain

v0.2 時点では macOS Keychain のみサポート。Windows credential（cmdkey / DPAPI）は v0.3 / Phase 1.5 で予定。
