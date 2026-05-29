# Research sources

> aiftp が README・compatibility-matrix・competitive-comparison 等で行う主張の**一次資料**。
> 各エントリは「主張 / ソース / 状態」を記録する。ここに無い主張は本文に書かない。
> 検証状態は [ADR 0002](adr/0002-v1.0-release-gate-redefinition.md) に従い正直に記す
> （3社は v0.9.3 で検証後アカウント解約済み・継続検証は Star Server のみ）。
> Last updated: 2026-05-29

## §A. AI エージェントが安全手順を迂回する失敗モード

- **A-1**: AI コーディングアシスタントがリモートファイルを古い状態のまま上書き／安全手順をスキップする事象が公開報告されている。
  - Source: claude-code issues [#45806](https://github.com/anthropics/claude-code/issues/45806), [#49344](https://github.com/anthropics/claude-code/issues/49344)
  - 状態: 公開 issue を直接参照（一次）。

## §B. 市場（日本の WordPress ホスティングシェア）

- **B-1**: エックスサーバーが日本の WordPress サイトの約 31.7% をホスト。
  - Source: [WP-Search 2026-01](https://wp-search.net/)、[W3Techs](https://w3techs.com/)（Japan locale = 29.8%）でクロスチェック。
  - 状態: 二次集計サービス。数値は時点依存のため "約" 付きで引用。
- **B-2**: さくらインターネットが約 10.7% を追加（同ソース）。さくらユーザは国外IPフィルタ問題に標準で当たる。
  - Source: 同上 WP-Search 2026-01。

## §C. 日本のレンタルサーバの事実（国外IPフィルタ等）

- **C-1**: さくらインターネットのレンタルサーバは、国外IPアドレスフィルタが **FTP を含めデフォルト ON**。
  - Source: [さくら 2014-03-10 告知](https://www.sakura.ad.jp/corporate/information/announcements/2014/03/10/870/)
  - 状態: provider 公式告知（一次）。2026-05 新規契約でもデフォルト ON を v0.9.3 で実機確認（以後アカウント解約）。
- **C-2**: エックスサーバーは FTP がデフォルトで無制限（公開ドキュメント準拠）。
  - Source: [Xserver 申込](https://www.xserver.ne.jp/order/) ＋公開ドキュメント。v0.9.3 で実機確認（以後解約）。
- **C-3**: ロリポップ！の「海外アタックガード」は WordPress 管理画面パス向けで、FTP には影響しない。
  - Source: [ロリポップ 申込](https://lolipop.jp/order/form/) ＋ v0.9.3 実機確認（海外アタックガード ON でも FTP 不変を確認・以後解約）。
- **C-4**: **国外IPフィルタの provider 別挙動まとめ**（a7-multi-provider-walkthrough §14 から参照される節）。
  - さくら: フィルタ ON 既定・FTP 含む（C-1）
  - エックスサーバー: FTP 既定無制限（C-2）
  - ロリポップ: 海外アタックガードは FTP 非対象（C-3）
  - Star Server: 継続検証中（[compatibility-matrix.md](compatibility-matrix.md) 参照）
  - 状態: 3社は v0.9.3 時点の実機確認。最新の per-provider 状態は [`compatibility-matrix.md`](compatibility-matrix.md) を正とする。

## §D. 競合

- **D-1**: 既存の FTP/MCP・デプロイ系ツールとの差分。
  - Source: [alxspiker/mcp-server-ftp](https://github.com/alxspiker/mcp-server-ftp)、git-ftp ほか。
  - 詳細: [`competitive-comparison.md`](competitive-comparison.md) に整理。

## 引用方針

- 数値・provider 挙動は時点依存。本文では "約" / "v0.9.3 時点" 等の限定を付け、誇張しない。
- provider 実機の再検証はアカウント解約済みのため需要発生時（代行案件等）に行う（[ADR 0002](adr/0002-v1.0-release-gate-redefinition.md)）。
