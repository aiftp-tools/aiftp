import { describe, expect, it, vi } from 'vitest';
import { PromptFlow } from './prompt-flow.ts';
import { BACK_KEYWORD, type PromptField } from './types.ts';

describe('PromptFlow', () => {
  it('runs a single field and returns the answer', async () => {
    const fields: PromptField[] = [{ name: 'host', label: 'FTP host', type: 'text' }];
    const prompt = vi.fn().mockResolvedValueOnce({ host: 'ftp.example.com' });
    const stderr = vi.fn();
    const flow = new PromptFlow(fields, { prompt, stderr });
    const result = await flow.run();
    expect(result).toEqual({
      kind: 'completed',
      answers: { host: 'ftp.example.com' },
    });
  });

  it('runs multiple fields in order and accumulates answers', async () => {
    const fields: PromptField[] = [
      { name: 'host', label: 'FTP host', type: 'text' },
      { name: 'user', label: 'FTP user', type: 'text' },
    ];
    const prompt = vi
      .fn()
      .mockResolvedValueOnce({ host: 'ftp.example.com' })
      .mockResolvedValueOnce({ user: 'deploy' });
    const stderr = vi.fn();
    const flow = new PromptFlow(fields, { prompt, stderr });
    const result = await flow.run();
    expect(result).toEqual({
      kind: 'completed',
      answers: { host: 'ftp.example.com', user: 'deploy' },
    });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  describe('A: input hint display', () => {
    it('prints hint and example to stderr before prompting', async () => {
      const fields: PromptField[] = [
        {
          name: 'port',
          label: 'FTP port',
          type: 'number',
          hint: '標準: 21 (FTP), 990 (FTPS implicit)。それ以外は確認画面が出ます。',
          example: '21',
        },
      ];
      const stderr = vi.fn();
      const prompt = vi.fn().mockResolvedValueOnce({ port: 21 });
      await new PromptFlow(fields, { prompt, stderr }).run();
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      expect(calls.some((m) => m.includes('💡') && m.includes('標準: 21'))).toBe(true);
      expect(calls.some((m) => m.includes('例: 21'))).toBe(true);
    });

    it('skips hint when neither hint nor example is defined', async () => {
      const fields: PromptField[] = [{ name: 'user', label: 'FTP user', type: 'text' }];
      const stderr = vi.fn();
      const prompt = vi.fn().mockResolvedValueOnce({ user: 'deploy' });
      await new PromptFlow(fields, { prompt, stderr }).run();
      expect(stderr).not.toHaveBeenCalled();
    });

    it('prints example only when hint is undefined', async () => {
      const fields: PromptField[] = [
        { name: 'localRoot', label: 'Local root', type: 'text', example: '.' },
      ];
      const stderr = vi.fn();
      const prompt = vi.fn().mockResolvedValueOnce({ localRoot: '.' });
      await new PromptFlow(fields, { prompt, stderr }).run();
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      expect(calls.some((m) => m.includes('💡'))).toBe(false);
      expect(calls.some((m) => m.includes('例: .'))).toBe(true);
    });
  });

  describe('B: :back navigation', () => {
    it(':back keyword moves cursor to the previous field and re-prompts it', async () => {
      const fields: PromptField[] = [
        { name: 'host', label: 'host', type: 'text' },
        { name: 'user', label: 'user', type: 'text' },
      ];
      const prompt = vi
        .fn()
        .mockResolvedValueOnce({ host: 'ftp.example.com' })
        .mockResolvedValueOnce({ user: BACK_KEYWORD })
        .mockResolvedValueOnce({ host: 'ftp.example2.com' })
        .mockResolvedValueOnce({ user: 'deploy' });
      const result = await new PromptFlow(fields, { prompt, stderr: vi.fn() }).run();
      expect(result).toEqual({
        kind: 'completed',
        answers: { host: 'ftp.example2.com', user: 'deploy' },
      });
      expect(prompt).toHaveBeenCalledTimes(4);
    });

    it(':back on the first field stays put and warns the user', async () => {
      const fields: PromptField[] = [{ name: 'host', label: 'host', type: 'text' }];
      const stderr = vi.fn();
      const prompt = vi
        .fn()
        .mockResolvedValueOnce({ host: BACK_KEYWORD })
        .mockResolvedValueOnce({ host: 'ftp.example.com' });
      const result = await new PromptFlow(fields, { prompt, stderr }).run();
      expect(result.kind).toBe('completed');
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      expect(calls.some((m) => m.includes('もう戻れません'))).toBe(true);
      expect(prompt).toHaveBeenCalledTimes(2);
    });

    it('returns cancelled when prompt returns null (Ctrl+C / EOF signal)', async () => {
      const fields: PromptField[] = [{ name: 'host', label: 'host', type: 'text' }];
      const prompt = vi.fn().mockResolvedValueOnce({ host: null });
      const result = await new PromptFlow(fields, { prompt, stderr: vi.fn() }).run();
      expect(result).toEqual({ kind: 'cancelled' });
    });

    it('returns cancelled when prompt returns undefined for the field', async () => {
      const fields: PromptField[] = [{ name: 'host', label: 'host', type: 'text' }];
      const prompt = vi.fn().mockResolvedValueOnce({});
      const result = await new PromptFlow(fields, { prompt, stderr: vi.fn() }).run();
      expect(result).toEqual({ kind: 'cancelled' });
    });

    it('treats full-width :back (：ｂａｃｋ) as a normal string, not a back command', async () => {
      const fields: PromptField[] = [
        { name: 'host', label: 'host', type: 'text' },
        { name: 'user', label: 'user', type: 'text' },
      ];
      const prompt = vi
        .fn()
        .mockResolvedValueOnce({ host: 'ftp.example.com' })
        .mockResolvedValueOnce({ user: '：ｂａｃｋ' });
      const result = await new PromptFlow(fields, { prompt, stderr: vi.fn() }).run();
      expect(result.kind).toBe('completed');
      if (result.kind === 'completed') {
        expect(result.answers.user).toBe('：ｂａｃｋ');
      }
    });
  });
});
