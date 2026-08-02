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
    'いきなり本番へ出しません。まず `remote_root` の下の**テスト用サブディレクトリ**を対象に、`aiftp_push_prepare` → 内容を日本語で要約 → 人間の同意を得てから `aiftp_push_confirm` を呼びます。',
    '',
    '## ③ 本番反映',
    '`aiftp_push_prepare` に `expected_site` を必ず指定します。本番プロファイルなら `confirmation_challenge` が返ります。**合言葉は AI には見えません。** チャレンジコードを提示し、「<チャレンジ> <合言葉>」の形で人間が入力するまで待ってください。合言葉を推測したり、人間の代わりに組み立てたりしてはいけません。受け取った行をそのまま `confirmation` に渡します。',
    '',
    '## ④ 戻す体験',
    '`aiftp_backup_list` で自動取得されたバックアップを見せ、`aiftp_rollback_prepare` → `aiftp_rollback_confirm` で1つ前の状態に戻せることを実演します。',
    '',
    '困ったときは `aiftp_setup_status` に戻ってください。設定の不足は必ず `hint` に日本語の対処法が入っています。',
  ].join('\n');
}
