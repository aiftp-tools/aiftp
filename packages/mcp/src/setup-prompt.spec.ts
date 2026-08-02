import { describe, expect, it } from 'vitest';
import { buildSetupPromptText } from './setup-prompt.js';

describe('buildSetupPromptText', () => {
  const text = buildSetupPromptText();

  it('names each tool the four onboarding steps use', () => {
    for (const tool of [
      'aiftp_setup_status',
      'aiftp_profile_test',
      'aiftp_push_prepare',
      'aiftp_push_confirm',
      'aiftp_backup_list',
      'aiftp_rollback_prepare',
      'aiftp_rollback_confirm',
    ]) {
      expect(text).toContain(tool);
    }
  });

  it('instructs the model to wait for the human to type the phrase', () => {
    expect(text).toContain('合言葉は AI には見えません');
    expect(text).toContain('人間が入力するまで待ってください');
  });

  it('tells the model to use a test subdirectory before production', () => {
    expect(text).toContain('テスト用サブディレクトリ');
  });

  it('is written in Japanese for the trainee-facing steps', () => {
    expect(text).toMatch(/[ぁ-んァ-ン一-龥]/u);
  });
});
