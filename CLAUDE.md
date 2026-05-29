# aiftp リポジトリ — エージェント向け設定

> このファイルは **git リポジトリ `aiftp-tools/aiftp` 専用** のエージェント設定です。
> プロジェクト全体の開発フロー・コーディング規約・安全ルールは、親フォルダの
> `../CLAUDE.md`（`/Users/ytanaka/Projects/Web/AIftp/CLAUDE.md`）と
> グローバル `~/.claude/CLAUDE.md` を参照してください。本書はそれらを上書きしません。

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `aiftp-tools/aiftp` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage roles use their default label names; `wontfix` reuses the existing label. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
