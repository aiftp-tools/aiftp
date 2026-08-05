/**
 * The onboarding prompt maps 1:1 onto the training curriculum
 * (training-product-v0.1.md §4, 午後1 / 午後2).
 */
export function buildSetupPromptText(): string {
  return [
    'aiftp の初回セットアップを、次の4ステップで順に進めてください。各ステップが終わるたびに、結果を日本語で1〜2文にまとめて報告してください。',
    '',
    '## ① 接続確認',
    '`aiftp_setup_status` を呼び、fail のチェックがあれば、その `hint` をそのまま日本語で伝えて、そこで止まってください（先へ進まないこと）。すべて pass なら `aiftp_profile_test` で実際の接続を確認します。',
    '',
    '## ② テスト領域へ push',
    'いきなり本番へは出しません。まず `remote_root` の下の**テスト用サブディレクトリ**を対象に `aiftp_push_prepare` を呼び、内容を日本語で要約して人間の同意を得ます。この拡張にはプロファイルが production の1つしかないため、テスト領域への push もここで説明する合言葉ゲートを通り、`confirmation_challenge` が返ってきます。**合言葉は AI には見えません。** チャレンジコードを提示し、「<チャレンジ> <合言葉>」の形で人間が入力するまで待ってください。合言葉を推測したり、人間の代わりに組み立てたりしてはいけません。受け取った行をそのまま `aiftp_push_confirm` の `confirmation` に渡します。',
    '',
    '## ③ 本番反映',
    '`aiftp_push_prepare` に `expected_site` を必ず指定します。プロファイルは production の1つだけなので、ここでも②と同じ合言葉ゲートが働き、`confirmation_challenge` が返ります（②の確認は、その回の push 1件だけに有効です）。**同じ会話内で2回目以降の本番反映を行うときも、以前に見た合言葉やチャレンジコードを AI が自力で組み合わせて `confirmation` を作ってはいけません。** 必ず新しいチャレンジコードを提示し、人間が改めて入力するまで待ってから `aiftp_push_confirm` を呼んでください。',
    '',
    '## ④ 戻す体験',
    '`aiftp_backup_list` で自動取得されたバックアップを見せ、`aiftp_rollback_prepare` → `aiftp_rollback_confirm` で1つ前の状態に戻せることを実演します。',
    '戻す操作もリモートを書き換えるため、`aiftp_rollback_confirm` には `acknowledge_production: true` が必要です（合言葉は不要です。復旧手段を合言葉に依存させないためです）。',
    '',
    '困ったときは `aiftp_setup_status` に戻ってください。設定の不足は必ず `hint` に日本語の対処法が入っています。',
  ].join('\n');
}
