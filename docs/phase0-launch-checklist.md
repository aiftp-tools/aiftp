# Phase 0 launch checklist (v1.0.0)

> このファイルは v1.0.0 を切る前の punch-list。**⛔ が 0 件になったら 1.0 を出せる**。
> 方針は [ADR 0001](adr/0001-product-direction-builder-wedge-services-monetization.md)（楔=制作者・収益化=既存サービス・Pro 据え置き）と
> [ADR 0002](adr/0002-v1.0-release-gate-redefinition.md)（3社ライブ再認証ゲート撤廃）に従う。
> Last updated: 2026-05-29

凡例: ✅ 完了 / ⛔ 未解決（リリースを止める）/ 🟡 進行中 / 🔵 任意・要再検討

## 検証（ADR 0002 準拠）

- ⛔ **Star Server（GWco）実機での E2E 再検証をリリースコミット上で実行**（init / status / push / backup / restore / doctor）。これが新ゲートの中核。
- ✅ Lolipop / Sakura / Xserver は v0.9.3（2026-05-22）で検証済み。アカウント解約済みのため再実行はしない。`compatibility-matrix.md` に「verified-then-cancelled・需要発生時に再検証」を注記済み。
- ✅ smoke CI（3 OS × 2 Node、ftp-srv モック、MCP stdio probe）稼働中。
- 🔵 未消化 delta（最小 push の再確認・Shift_JIS 挙動）は代行案件で実サーバに触れた時に再検証（リリースを止めない）。

## ドキュメント

- 🟡 **README を最終文言に確定**し、「制作者向け安定版」トーンに統一（ADR 0001）。マス製品トーン（"officially recommend to the world" 等）を残さない。
  - ⛔ README が参照する `docs/research-sources.md` が**存在しない**。実体を作る or README の fact-check 参照を実在ソースに張り替える、のどちらかで解消する。
- 🟡 `docs/release/v1.0.0-draft.md` の本文を最終化（ゲート文言・トーンは是正済み）。
- ⛔ `CHANGELOG.md` の `[Unreleased]` を `[1.0.0] — YYYY-MM-DD` に変換し、Release body と同期。
- ✅ NOTICE.md / SECURITY.md / LICENSE 整備済み。

## コミュニティ on-ramp

- ✅ CONTRIBUTING.md / CODE_OF_CONDUCT.md 整備済み。
- ✅ Issue テンプレ（bug / feature / hosting_compatibility）・PR テンプレ・triage ラベル整備済み。

## ランディング / 告知

- 🔵 **`aiftp.dev` ランディングページ** — ADR 0001 下では「マス向け LP」は過剰投資の疑い。**v1.0 の必須ゲートから外すか要判断**。出すなら制作者1ペルソナに絞った軽量1枚で十分。
- 🟡 v1.0 ローンチ記事（Zenn、日本語）。※告知は主砲=制作者実務／副砲=AIクロスチェックの役割分離を守る。
- ✅ v0.11 Zenn 記事は公開済み（v1.0 用は別途）。

## リリース機構

- ⛔ 3パッケージ（core / cli / mcp）のバージョンを `1.0.0` に同時 bump。
- ⛔ `npm publish --dry-run` が通ること。
- ⛔ tag + push + GitHub Release（**田中さんの最終承認が必要**）。
- ⛔ npm publish（**田中さんの最終承認が必要**）。

## 既知の dangling 参照（解消対象）

- ✅ 本ファイル（`phase0-launch-checklist.md`）自体が幽霊参照だったため新規作成（2026-05-29）。
- ⛔ `docs/research-sources.md`（README が参照、未作成）。上記「ドキュメント」節で解消する。
