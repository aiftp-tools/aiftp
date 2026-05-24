# Design: aiftp init Summary Review (v0.10.4)

**Date**: 2026-05-24
**Author**: Claude Lead (Opus 4.7) + 田中さん review
**Status**: design — pending approval
**Target release**: v0.10.4

## 1. Goal

`aiftp init` の対話プロンプトで「ユーザは必ず入力ミスをする」前提に立ち、**入力ミスに気づく機会**と**修正経路**を提供する。具体的には全プロンプト完了後に **summary review** ステップを挿入し、誤りを発見したら abort せず該当 field のみ修正できるようにする。

## 2. Why（背景）

2026-05-24 に v0.10.0 → v0.10.3 まで同日 4 リリース。v0.10.1〜v0.10.3 は田中さん本人の smoke test で踏んだ UX バグ：

- F-X5 (#6): keychain service プロンプトのデフォルト値欠落
- F-X6 (#7): 必須項目が空欄で全プロンプト完走、最後に reject
- F-X7 (#8): port prompt が `-Infinity` で reject

これらは「個別 validate を追加する」で対処したが、**根本的な構造課題**は未解決：

- ユーザが入力ミスに気づくのは「最後の保存後」になりがち
- 気づいた時点で **やり直す手段は init --force のみ**（全部再入力）
- 標準値で問題なくても、ユーザがあえて非標準値を使うケースの確認がない（v0.10.3 で port のみ追加）

田中さんの指摘（2026-05-24 11:45）：

> ユーザが入力するものは基本的に入力間違いをするものだという前提で仕様を考えなければなりません。入力間違いがあった場合にどのように修正できるようにするかも、仕様で決め、抜け落ちた点がないかテストしてください。

## 3. Non-goals（今回スコープ外、v0.11 framework 送り）

- 各 prompt 中の back/Esc ナビゲーション（prompts ライブラリ拡張が必要）
- prompt 前のヒント表示 / provider-specific 提案
- init 以外のコマンド（rollback confirm, push confirmation 等）の validation 強化
- CLI flag (`--profile xxx` 等) の入力検証
- `@inquirer/prompts` 等への置き換え

これらは **v0.11 input validation framework** として包括設計する（別 spec / 別 milestone）。

## 4. User-facing behavior

### 4.1 フロー

```
[既存] 全 prompt 完了 (profile..password..consent)
       ↓
[既存] consent check (false なら従来通り abort)
       ↓
[新規] runInitSummaryReview(answers)
       ↓
   ┌──→ Summary 表示
   │    Looks correct? [Y/n] or enter 1-9 to edit:
   │       │
   │       ├─ Y / Enter → return answers (loop 終了)
   │       ├─ n         → throw "aiftp init: aborted by user at summary review"
   │       ├─ 1-9       → 該当 field を再 prompt → loop 先頭へ
   │       ├─ それ以外  → "Invalid input. Enter Y, n, or 1-9." → loop 先頭へ
   │       └─ (10 ループ上限) → throw "edit loop limit exceeded (10)"
   │
   └─ 確定された answers
       ↓
[既存] hard-exclude warning, .aiftp.toml write, keychain set, .gitignore
```

### 4.2 Summary display 仕様

```
Review your aiftp init answers (production profile):

   1. Profile name        production
   2. FTP host            ftp-1.lolipop.jp
   3. FTP port            21
   4. Protocol            FTPS
   5. FTP user            nobushi.jp-aiftp
   6. Remote root         /public_html
   7. Local root          .
   8. Keychain service    aiftp:production
   9. Server kind         Lolipop
  10. FTP password        ••••••••••• (hidden, 11 chars)

Looks correct? [Y/n] or enter 1-10 to edit:
```

**仕様詳細**:

- 表示項目: **10** (profile name と password を含む、consent は **含まない**)
- consent は init 続行に必須の合意確認なので summary には載せない（一度 yes と言ったものを再 toggle できる UX は誤操作リスク高）
- password は `••• (hidden, N chars)` 形式：内容は漏らさないが長さで typo に気づける
- protocol/serverKind は **label** 表示（`FTPS`, `Lolipop`）。TOML 内部値（`ftps`, `lolipop`）は表示しない
- 番号は 1〜10（zero-padding なし、右寄せ）
- 各 field 名は左寄せ + 固定幅整列（20 char）

### 4.3 個別 field edit の挙動

ユーザが数字 N を入力した場合：

1. 該当 field の prompt を再表示
2. **`initial` には現在の値**を埋めて表示（password 以外）
3. 既存の `validate` callback が走る（空欄 reject、port 範囲チェック、keychain service required 等）
4. 以下の post-validation が**再発火**:
   - `port` を edit → 非標準ポート確認 prompt（v0.10.3 `isStandardFtpPort` ヘルパー再利用）
   - `remoteRoot` を edit → 先頭 `/` 警告 stderr 出力
   - `serverKind` を `starserver` に edit → TLS hostname check 警告 stderr 出力
5. answers 上書き → summary 表示に戻る

### 4.4 特殊ケース

| field | edit 時の挙動 |
|---|---|
| 1. Profile name | 変更時に stderr に警告: "Profile name changed; keychainService (#8) might also need updating." 自動連動なし |
| 8. Keychain service | デフォルト値は **現在の profile 名から派生**（`aiftp:${profile}`）。ユーザが Profile name を 1 で変更した直後の編集なら新 profile 名がデフォルトに |
| 10. FTP password | 再入力（既存 password を新入力で置き換え）。`initial` には現在値を入れない（password prompt の標準挙動） |
| 3. FTP port | edit 後、非標準値（21/990 以外）なら **v0.10.3 の confirmation prompt が再発火**。declined なら edit loop に戻る |

### 4.5 入力 normalization & cancel 仕様（Codex Phase 1 review 反映、2026-05-24）

**Whitespace 処理（全 text/password 系 field 共通）**:
- 入力受領時に **`trim()` を適用** してから validate / summary 表示 / TOML 書き込み / keychain 保存
- 結果が空文字なら既存 `validate` で reject（再 prompt）
- これにより「末尾改行つき paste」「先頭スペース」等の典型 typo を自動補正

**Control character 拒否**:
- 全 text/password 系 field で、入力に以下を含むなら validate で reject:
  - `\n` `\r` `\t` (制御文字、TOML 構文を壊す)
  - `\x00`〜`\x1F` の制御文字（ANSI escape, NUL 含む）
- エラーメッセージ: `"<field> must not contain control characters or newlines"`

**Summary 入力 (choice) 仕様**:
- accept する形式: 半角 ASCII の `y` / `n` / `Y` / `N` / `yes` / `no` / 空 Enter / 半角数字 1-10
- **拒否**: 全角数字 (`１０`) / `1abc` / `1.5` / `01`（leading zero、ambiguous）/ ANSI escape 等
- parse は `parseInt(s, 10)` ではなく `/^[1-9]$|^10$/` 正規表現で **strict match**
- match しないなら "Invalid input. Enter Y, n, or 1-10 (half-width digits)." を stderr 出力 → loop 継続

**Cancel / EOF / SIGINT 仕様（最重要、Critical from Codex）**:
- prompts ライブラリは Ctrl+C / stdin EOF / SIGINT 時に **空 object `{}` または abort signal** を返す
- summary review で `choice` が **`undefined` / `null` / 空文字 (trim 後)** の場合の挙動:
  - **空 Enter のみ**は accept (Y と同義) ← 通常 UX
  - **`undefined` / `null`** （prompts cancel signal） → **abort（throw "aiftp init: cancelled at summary review"）**
  - 「Y default + cancel = accept」と区別するため、prompts の cancel callback (`onCancel`) を実装して内部 abort flag を立てる
- abort 時の保証: `.aiftp.toml` 未書き込み / keychain set 未実行 / `.gitignore` 未追記

## 5. Implementation outline

### 5.1 変更するファイル

- `packages/cli/src/index.ts`
  - `runInitSummaryReview(answers, prompt)` 関数を新規 (~80 lines)
  - 既存 init action 内、consent check の **後**・hard-exclude warning の **前** に挿入
- `packages/cli/src/index.spec.ts`
  - 既存 `prompt(answers)` mock は object を 1 回返すだけ。**sequence mock** ヘルパー `promptSequence(answers[])` を追加（配列を順次返す）
  - 13 test cases 追加（§6 参照）

### 5.1.1 追加ヘルパー（Codex Phase 1 review 反映）

```typescript
// 全 text/password 系 field の input 受領時に通す
function sanitizeFieldInput(raw: unknown, fieldName: string): string {
  if (typeof raw !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required (empty after trim)`);
  }
  // U+0000-U+001F の制御文字は TOML 構文を壊すため拒否
  if (/[\x00-\x1F]/.test(trimmed)) {
    throw new Error(`${fieldName} must not contain control characters or newlines`);
  }
  return trimmed;
}

// summary choice の strict parse
type SummaryChoice =
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'edit'; fieldIndex: number }  // 1-10
  | { kind: 'invalid' };

function parseSummaryChoice(raw: unknown): SummaryChoice {
  if (raw === undefined || raw === null) {
    // prompts cancel / EOF signal — treat as explicit cancel, not as default
    return { kind: 'no' };  // ← runInitSummaryReview 側で cancel-specific error を throw
  }
  const s = String(raw).trim();
  if (s === '' || s.toLowerCase() === 'y' || s.toLowerCase() === 'yes') return { kind: 'yes' };
  if (s.toLowerCase() === 'n' || s.toLowerCase() === 'no') return { kind: 'no' };
  // 半角 ASCII 数字のみ accept、全角数字や leading zero は invalid
  if (/^[1-9]$|^10$/.test(s)) return { kind: 'edit', fieldIndex: Number.parseInt(s, 10) };
  return { kind: 'invalid' };
}
```

### 5.2 関数シグネチャ案

```typescript
interface InitAnswers { /* 既存 */ }

const INIT_SUMMARY_FIELDS = [
  { key: 'profile',          label: 'Profile name' },
  { key: 'host',             label: 'FTP host' },
  { key: 'port',             label: 'FTP port' },
  { key: 'protocol',         label: 'Protocol' },
  { key: 'user',             label: 'FTP user' },
  { key: 'remoteRoot',       label: 'Remote root' },
  { key: 'localRoot',        label: 'Local root' },
  { key: 'keychainService',  label: 'Keychain service' },
  { key: 'serverKind',       label: 'Server kind' },
  { key: 'password',         label: 'FTP password' },
] as const;

const MAX_EDIT_LOOPS = 10;

async function runInitSummaryReview(
  initial: InitAnswers,
  prompt: CliPrompt,
  stdout: (line: string) => void,
): Promise<InitAnswers> {
  let answers = initial;
  for (let loop = 0; loop < MAX_EDIT_LOOPS; loop++) {
    stdout(formatSummary(answers));
    const { choice } = await prompt([
      {
        type: 'text',
        name: 'choice',
        message: 'Looks correct? [Y/n] or enter 1-10 to edit',
        initial: 'Y',
      },
    ]);
    const normalized = String(choice ?? '').trim().toLowerCase();
    if (normalized === '' || normalized === 'y' || normalized === 'yes') {
      return answers;
    }
    if (normalized === 'n' || normalized === 'no') {
      throw new Error('aiftp init: aborted by user at summary review');
    }
    const fieldIndex = Number.parseInt(normalized, 10);
    if (!Number.isInteger(fieldIndex) || fieldIndex < 1 || fieldIndex > INIT_SUMMARY_FIELDS.length) {
      stdout('Invalid input. Enter Y, n, or 1-10.\n');
      continue;
    }
    answers = await editSingleField(answers, fieldIndex - 1, prompt, stdout);
  }
  throw new Error(`aiftp init: edit loop limit exceeded (${MAX_EDIT_LOOPS}); aborting`);
}

function formatSummary(a: InitAnswers): string { /* §4.2 format */ }

async function editSingleField(
  current: InitAnswers,
  fieldIdx: number,
  prompt: CliPrompt,
  stdout: (line: string) => void,
): Promise<InitAnswers> { /* re-prompt single field, return new answers */ }
```

## 6. Test plan

### 6.1 必須テストケース（25 cases、Codex Phase 1 review 反映後）

#### 基本フロー (1-13)

| # | 種別 | テスト | 期待挙動 |
|---|---|---|---|
| 1 | Happy | summary で `Y` | init 完了、.aiftp.toml + keychain 書き込み |
| 2 | Happy (Enter) | summary で空 Enter | Y と同じ扱い |
| 3 | Abort | summary で `n` | throw "aborted by user at summary review"、何も書かれない |
| 4 | Edit single | `5` → 新 remote_root → `Y` | 新値で .aiftp.toml 書き込み |
| 5 | Edit multiple | `5` → 新値 → `3` → 新 port → `Y` | 両方反映 |
| 6 | Invalid string | `xyz` → "Invalid..." → `Y` | 警告表示、loop 継続 |
| 7 | Out-of-range | `99` → "Invalid..." → `Y` | 同上 |
| 8 | Edit loop limit | 10 回 edit → 11 回目で abort | throw "edit loop limit exceeded" |
| 9 | Edit password | `10` → 新 pw → `Y` | keychain に新 pw 保存 |
| 10 | Edit then abort | `5` → 新値 → `n` | abort、何も書かれない（新値も書かれない） |
| 11 | Edit to invalid value | `5` を空文字 → reject | per-prompt validate で再入力（既存挙動） |
| 12 | Edit profile name warning | `1` → 新名 → stderr に警告 | 警告出力、keychainService は自動更新しない |
| 13 | Edit to non-standard port | `3` → 8021 → v0.10.3 confirmation 再発火 | declined なら summary に戻る |

#### Critical（Codex 指摘、リリースブロック級、14-16）

| # | 種別 | テスト | 期待挙動 |
|---|---|---|---|
| 14 | Cancel safety | Ctrl+C / stdin EOF / prompts cancel at summary | throw "cancelled at summary review"、.aiftp.toml + keychain + .gitignore **すべて未変更** |
| 15 | Cancel during edit | 5 (remote_root) edit 中に Ctrl+C | 同上、edit 前の状態に戻らず full abort |
| 16 | Strict choice parsing | `1abc` / `1.5` / `01` / `１０` (全角) → invalid; `10\n` paste → trim 後 `10` accept (typo guard for paste) | "Invalid input" 表示、誤って違う field を edit しない |

#### Should-add（Codex 指摘、必須、17-23）

| # | 種別 | テスト | 期待挙動 |
|---|---|---|---|
| 17 | --force collision | 既存 `.aiftp.toml` + 既存 keychain + 既存 backup key で `init --force` → summary で profile/keychainService edit | 既存 overwrite/preserve confirmations が **再発火**、backup key は explicit confirm なしに上書きされない |
| 18 | Profile rename desync | profile を `production` → `staging` に edit → `Y` (keychainService 触らず) | TOML `keychain_service` は **edit 前の値のまま**、keychain account は新 profile 名、stderr に desync 警告 |
| 19 | Whitespace normalization | host/user/remoteRoot を `"  ftp.example.com  "` / `"\tdeploy-user\t"` / paste-with-newline で入力 | trim 後の値で validate / summary 表示 / TOML 書き込み |
| 20 | Whitespace-only reject | host を `"   "` のみで入力 | trim 後空 → validate reject → 再 prompt |
| 21 | Control character reject | host/profile を `"a\nb"` / `"a\x00b"` / ANSI escape 含みで入力 | validate reject "must not contain control characters" |
| 22 | Very long string | profile / host / password に 50k char | summary 表示が hang しない、TOML 書き込み成功、keychain に full length 保存 (password 長さ表示は実数値) |
| 23 | Non-Latin input | profile=ASCII (TOML bare-key 制約) / host=`"ftp.例え.test"` / password=`"パス🔐word"` | host + password で round-trip 成立。profile は v0.11 で quoted-key TOML 対応検討 |

#### Should-add 追加（非 TTY、24-25）

| # | 種別 | テスト | 期待挙動 |
|---|---|---|---|
| 24 | Non-TTY environment | `aiftp init < /dev/null` 風（非対話 stdin）で summary review に到達 | **block せず明示エラー** "non-interactive stdin not supported for init summary review" で abort |
| 25 | Abort side-effect ordering | 5 edit → 8 edit → `n` で abort | **全 side-effect ゼロ確認**: no keychain set, no backup key change, no `.gitignore` append, no partial config write (file inode check) |

### 6.2 既存テスト互換性

- 既存 74 init test は `prompt(answers)` mock が呼ばれる度に同じ object を返す
- summary review はそれを **追加で 1 回呼ぶ**ので、`choice` プロパティを既存 fixture が持っていないと `undefined → "Invalid"` で無限ループ
- **採用方針**: 既存 `prompt(answers)` ヘルパーを拡張し、`choice` が answers に含まれない場合は **デフォルトで `'Y'` を返す** ようにする。既存テストは触らない
- 新規テスト（13 cases）は `promptSequence([...])` ヘルパーを別途定義し、配列を順次返す mock を使う
- これにより既存 74 test の修正は **0 件** で済む

### 6.2.1 Mock の限界（Codex Phase 2 S5）

`prompts` ライブラリの `validate` callback は production runtime でのみ走り、テスト mock では bypass される。つまり test #15 / #20 / #21 / #11 で「whitespace-only / control character / null edit value」が rejected されるのは、aiftp 側の `sanitizeFieldInput` 防衛層によるもの。**`prompts` の validate が「画面で再入力を促す」UX は単体テストで検証不能** (実機 smoke test or e2e 必要)。

v0.11 input validation framework で `@inquirer/prompts` 等に置き換える際、validate callback の動作を仮想 TTY 経由で test 可能にする予定。それまでは:

- 単体テストは aiftp 側の防衛層 (sanitizeFieldInput / parseInitAnswers / requirePort) を保証
- 実機検証は `aiftp init` の smoke test で 田中さん or CI 実行

### 6.3 Coverage 目標

- 新規 `runInitSummaryReview` 関数: Statements 100% / Branches 95%+
- 新規 `sanitizeFieldInput` / `parseSummaryChoice` ヘルパー: Statements 100% / Branches 100%
- 既存 init action 全体: Statements 90%+ 維持 / Branches 85%+
- 全体: Statements 90%+ 維持 / Branches 83%+ 維持

### 6.4 Codex Phase 1 review 結果

Codex (`task-mpjdgk27-6z9hps`, GPT-5 high effort, 53s) からの指摘を §6.1 #14-25 に取り込み済み。原文 review 結果は次の場所に保存:

- Codex session ID: `019e5895-3d1f-7103-850e-2de1da665313`
- Resume: `codex resume 019e5895-3d1f-7103-850e-2de1da665313`

主要指摘:
- **Critical**: cancel safety / strict choice parsing / `--force` collision
- **Should-add**: profile rename desync / whitespace / control char / very long string / non-Latin / non-TTY / abort side-effect ordering
- **Spec questions**: 全角数字 vs 半角 / whitespace trim 方針 → §4.5 で **半角 ASCII のみ accept、whitespace は trim** と決定

## 7. Codex ダブルチェック手順

田中さんからの明示的指示：「Codex にもテスト内容はダブルチェックさせて」

**Phase 1 (spec フェーズ、今)**:
- 本 spec doc を Codex (`codex:rescue` agent) に投げて「13 test cases で漏れている edge case は？」を問う
- Codex からの指摘は spec §6.1 に追加 → 再 review
- 田中さん承認得てから plan / 実装フェーズへ

**Phase 2 (実装フェーズ)**:
- Claude が TDD で実装（RED → GREEN → REFACTOR）
- 実装後 `codex:rescue` に「test 観点で抜けは？validation 順序の落とし穴は？」を問う
- 必要なら追加テスト / 実装修正

**Phase 3 (PR フェーズ)**:
- Claude が CHANGELOG + version bump
- `codex:rescue` で全体 PR review
- 田中さん最終承認 → commit / tag / release / npm publish

## 8. Out of scope（明示）

以下は v0.11 framework として別 spec で扱う：

- back/Esc ナビゲーション中 prompts
- provider-specific ヒント表示（serverKind 連動）
- init 以外のコマンドの prompts 強化
- CLI flag validation
- `@inquirer/prompts` 置き換え検討

## 9. Risks

| Risk | 影響 | Mitigation |
|---|---|---|
| 既存 74 test の prompt mock が summary review で無限ループ | CI 失敗 | mock を `choice: 'Y'` 含むよう拡張、既存テスト全部更新 |
| edit loop limit 10 がユーザ操作を不当に阻害 | UX | 10 回は事実上の安全弁、通常 1-3 回で済む。docs に明記 |
| summary 表示でパスワード長が漏れる | セキュリティ低 | 長さのみ、内容は hidden。OWASP 視点では低リスク |
| profile name 変更時に keychain service と乖離 | データ不整合 | 警告 stderr で明示 + docs 注意書き |
| 全角数字 `１０` 入力時、ユーザ困惑 | UX | エラー文に "Enter Y, n, or 1-10 (**half-width digits**)" と明示 |
| `init --force` で既存 backup key を edit 経由で誤って上書き | データ消失 (encrypted backups 復号不能) | 既存 confirm flow を **summary 確定後 / edit 直後も再発火**、test #17 で保証 |
| 50k char 入力で summary 表示が hang | UX | summary は **長すぎる field は preview truncate** (例: 80 char + "..."), TOML 自体は full | 
| non-TTY で summary が block | CI 失敗 | TTY 検出して **明示エラー abort**、test #24 で保証 |
| Ctrl+C が "yes default" と誤解釈されデフォルトで保存 | データ意図せず変更 | prompts の `onCancel` callback で **explicit cancel flag**、test #14/#15 で保証 |

## 10. Acceptance criteria

- [ ] 13 必須テストケース全 pass
- [ ] 既存 init 74 test 全 pass (mock 拡張後)
- [ ] coverage: 全体 Branches 83%+ 維持、新規関数 Branches 95%+
- [ ] biome lint clean
- [ ] pnpm build clean
- [ ] Codex Phase 1 + 2 review で指摘された edge case を追加 test 化
- [ ] CHANGELOG.md に v0.10.4 entry
- [ ] memory.md に design doc reference + 実装結果

## 11. Release plan

- v0.10.4 patch release
- npm publish: **3 package 揃えて 0.10.4 で publish**（core/mcp は変更なしだが、monorepo 依存整合性を優先・ユーザの version 把握しやすさのため）
- 田中さん最終承認後、本日中 or 翌日にリリース
- `pnpm publish -r --access public --no-git-checks` で 3 つ一気に
- GitHub Release v0.10.4 (Latest)、tag `v0.10.4`
