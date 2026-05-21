# Roadmap

**Last updated**: 2026-05-21 (aiftp v0.9.1)
**Status**: Pre-v1.0.0. Phase 0 launch preparation in progress.

This roadmap describes what aiftp aims to do **next**, and what it
**deliberately won't do**. It is non-binding — priorities shift based
on community feedback, real-world usage data, and the maintainer's
capacity (aiftp is currently maintained by one person alongside his
full-time business).

🇯🇵 日本語サマリは末尾。

---

## Where we are

| Phase | Status | What landed |
|---|---|---|
| **Phase 1 (v0.1.x)** | ✅ Done | MVP: TOML config, diff, push, encrypted backup, Keychain, hard exclude, lock file, Star Server verified |
| **Phase 1.1 (v0.1.1, v0.2.5)** | ✅ Done | Init UX, TLS diagnostics, auto-mkdir, `ls`, backup hardening |
| **Phase 1.5 (v0.3)** | ✅ Done | Windows credential backend, CI matrix expanded |
| **Phase 2 (v0.4.x – v0.9.1)** | ✅ Done | Multi-profile, MCP two-step gates everywhere, FileZilla + FFFTP import, schema v2, doctor, rollback, watch, hook, production gate |
| **Phase 0 launch prep** | 🟡 In progress | 3-provider compat verification, CHANGELOG, NOTICE, community templates, docs.aiftp.dev LP |

---

## Near-term: v1.0.0

**Target release**: 2026-06 (subject to A-7 compatibility verification)
**Theme**: "Officially safe to recommend"

**v1.0 ships when:**

- [`docs/phase0-launch-checklist.md`](phase0-launch-checklist.md) is
  fully green
- 3 major providers (Lolipop / Sakura / Xserver) are end-to-end
  verified and documented in `compatibility-matrix.md`
- README is in its final wording, fact-checked against
  `research-sources.md`
- Community on-ramps (Issue/PR templates, CONTRIBUTING, CoC,
  Security policy) are live
- `aiftp.dev` landing page is published
- First Zenn launch article is published in Japanese

**v1.0 does NOT add new features.** It is the "we are ready to be
recommended" milestone.

---

## Mid-term: v1.x patch / minor releases

Driven by **community feedback after v1.0**, not by maintainer wishlist.
Likely candidates in priority order, all in the **Free tier (MIT)**:

| Likely | Item | Notes |
|---|---|---|
| **High** | More provider quirk presets (ConoHa WING, mixhost, kagoya, etc.) | Each one driven by a hosting-compatibility issue report |
| **High** | Better error messages around foreign-IP filtering | When `tcp-reach` fails and the server is known to filter foreign IPs, doctor should suggest the specific control-panel toggle by name |
| **High** | Linux credential backend | `libsecret` / `kwallet` integration; currently Linux uses an in-memory backend |
| Medium | `aiftp pull` improvements (selective pull, dry-run pull) | Currently push is the well-trodden path |
| Medium | SFTP support | Currently FTP/FTPS only; SFTP is a separate transport layer and a significant addition |
| Medium | `aiftp diff <profile>` showing detailed file-level diff before push | Beyond the current change-set summary |
| Medium | i18n for CLI strings beyond Japanese/English | If the project gets international traction |
| Low | Pre-flight checks for additional file types (CSS, JS minifier sanity) | Currently PHP / JSON / HTML |
| Low | Optional bandwidth throttle for shared connections | If users hit ToS issues |

We will **not** open a new "v2.0" milestone until either (a) v1.x can't
solve a real user problem, or (b) we need to break a public CLI / MCP
contract. Conservatism here is deliberate.

---

## Long-term: Pro tier (open-core, planned)

aiftp follows an **open-core** model. The Free tier (MIT) covers
everything described above. A Pro tier (proprietary license) is in
planning, targeting late 2026 / 2027.

**Pro will be considered only after** the Free tier has demonstrable
sustained usage. We will not build paid features in advance of
demand.

### Pro tier candidate features (subject to revision)

These are **candidates**, not commitments. If Pro ships, the final
feature list may differ:

| Candidate | Why it might be Pro and not Free |
|---|---|
| **Cloud-backed backup vault** | Requires running infra (sub-processor risk) — not appropriate for the Free CLI's all-local design |
| **Team / multi-seat license + audit log central collection** | Team coordination is a team-scale concern |
| **Push approval workflow with Slack/email notifications** | Requires sending data to third-party services |
| **GUI app (macOS / Windows)** | Maintenance cost is high; Pro can fund it |
| **Priority support / faster security patches** | Direct value, doesn't dilute the Free CLI's surface |

### Safety primitives stay in the Free CLI

These features define what aiftp *is*, so they will continue to be
available in the Free CLI/MCP product:

- Two-step MCP gate (`prepare → confirm`)
- Encrypted local backup
- Hard-exclude list
- OS Keychain credential storage
- Provider quirk presets
- FileZilla / FFFTP import
- Production push gate
- The other "safety" primitives that make AI-assisted deployment
  safe in the first place

The intended split is **safety in Free**, **collaboration &
convenience in Pro**. We have no plans to move existing Free safety
features behind a paywall, and we will give clear notice and a
migration path well in advance if anything in that intent ever has
to change.

### Pro pricing

**No Pro pricing has been announced.** If Pro ships, pricing will
be published together with the Pro terms, privacy policy, and
license details at that time.

---

## What the Free CLI deliberately does not do today

These come up repeatedly. The current decisions for the Free
CLI/MCP product are:

- **Auto-push on file save** — would defeat the safety model. Use
  `aiftp watch` for notifications instead.
- **AI agent that decides which files to push without operator
  confirmation** — would defeat the safety model. The MCP
  `prepare → confirm` gate is the whole point.
- **Performance / "fast" modes that bypass backup, encryption,
  hard-exclude, or the confirmation gate** — we will not ship a
  foot-gun in the Free product.
- **Built-in CMS staging logic (WordPress sync, etc.)** — out of
  scope; CMS-specific tooling is a separate project. aiftp transports
  bytes; it does not understand WordPress semantics.
- **GUI wrapper in the Free CLI today** — maintenance cost is too
  high for a one-person team at the moment. May be reconsidered for
  Pro, or revisited if community contribution support changes.
- **Telemetry in the Free CLI** — the Free CLI does not include any
  telemetry, including opt-in usage stats. (Whether Pro services
  introduce telemetry will be specified in Pro's own privacy policy
  at that time.)

If you disagree with any of these, please open a Discussion. The
list above describes today's product, not a permanent veto; positions
can change with strong evidence, but we will not change them
silently or because of one-off requests.

---

## How priorities are set

1. **Bug reports** that affect data safety jump the queue.
2. **Provider compatibility issues** reported with reproducible
   doctor output get high priority — the value of aiftp is its
   safety, and that hinges on it actually working on the target
   server.
3. **Feature requests** with a clear user-problem narrative + at
   least one other 👍 are prioritized over pure wishlist items.
4. **Maintainer time** is finite. Trade-offs are communicated
   transparently in `docs/`.

---

## Contributing to the roadmap

- Open a Discussion in the "Ideas" category to propose a new
  direction.
- Open an Issue with `[feature]` for a specific small item.
- Tag-team this file via a PR if you spot a contradiction or stale
  entry.

---

## ロードマップ（日本語サマリ）

- **現状**: v0.9.1 / Phase 2 完了。v1.0.0 ローンチ準備中
- **v1.0.0 (2026-06 想定)**: 3 プロバイダ実機検証 + ドキュメント完成 + コミュニティ受け入れ態勢が揃った時点で「**安心して薦められる**」マイルストーンとしてリリース
- **v1.x patch/minor**: コミュニティのフィードバックで決める。SFTP / Linux credential / プロバイダ quirks 拡張など
- **Pro tier (将来)**: 2026 年末〜2027 年想定。Free が継続的に使われ始めてから着手。
  - **Pro 化候補**: クラウドバックアップ / チーム機能 / 承認ワークフロー / GUI / 優先サポート
  - **Free CLI に残す安全機能**: 二段ゲート / 暗号化バックアップ / hard-exclude / Keychain / プロバイダ quirks / production gate（Pro 化の予定はなく、変える場合は事前周知と移行経路を用意する）
  - **方針**: Free = 安全性、Pro = 協働・利便性
- **Free CLI の今の方針として行わないこと**: 自動 push、AI 自律 push、暗号化バックアップを無効化する fast mode、Free CLI 側のテレメトリ、CMS 特化機能、Free 版 GUI（時代変化に応じて見直す可能性あり）

---

**Version**: 1.0 (2026-05-21)
