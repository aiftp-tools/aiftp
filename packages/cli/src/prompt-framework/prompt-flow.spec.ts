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

  describe('sanitize and validate', () => {
    it('applies field.sanitize before storing answer', async () => {
      const fields: PromptField[] = [
        {
          name: 'host',
          label: 'host',
          type: 'text',
          sanitize: (r) => String(r).trim().toLowerCase(),
        },
      ];
      const prompt = vi.fn().mockResolvedValueOnce({ host: '  FTP.Example.COM  ' });
      const result = await new PromptFlow(fields, { prompt, stderr: vi.fn() }).run();
      expect(result).toEqual({ kind: 'completed', answers: { host: 'ftp.example.com' } });
    });

    it('rejects via validate(string) and re-prompts the same field', async () => {
      const fields: PromptField[] = [
        {
          name: 'port',
          label: 'port',
          type: 'text',
          validate: (v) => {
            const n = Number(v);
            return n >= 1 && n <= 65535 ? true : 'port must be 1-65535';
          },
        },
      ];
      const stderr = vi.fn();
      const prompt = vi
        .fn()
        .mockResolvedValueOnce({ port: '99999' })
        .mockResolvedValueOnce({ port: '21' });
      const result = await new PromptFlow(fields, { prompt, stderr }).run();
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      expect(calls.some((m) => m.includes('port must be 1-65535'))).toBe(true);
      if (result.kind === 'completed') expect(result.answers.port).toBe('21');
    });

    it('does not run sanitize for the :back keyword (back must reach the navigator first)', async () => {
      const sanitize = vi.fn().mockImplementation((raw) => String(raw).trim());
      const fields: PromptField[] = [
        { name: 'host', label: 'host', type: 'text', sanitize },
        { name: 'user', label: 'user', type: 'text', sanitize },
      ];
      const prompt = vi
        .fn()
        .mockResolvedValueOnce({ host: 'ftp.example.com' })
        .mockResolvedValueOnce({ user: ':back' })
        .mockResolvedValueOnce({ host: 'ftp.example.com' })
        .mockResolvedValueOnce({ user: 'deploy' });
      await new PromptFlow(fields, { prompt, stderr: vi.fn() }).run();
      // sanitize ran for host×2 + user×1 = 3 times; :back skipped sanitize.
      expect(sanitize).toHaveBeenCalledTimes(3);
    });

    it('passes prior answers to validate so cross-field rules can fire', async () => {
      const fields: PromptField[] = [
        { name: 'protocol', label: 'protocol', type: 'text' },
        {
          name: 'port',
          label: 'port',
          type: 'text',
          validate: (v, answers) => {
            if (answers.protocol === 'ftps' && Number(v) !== 990 && Number(v) !== 21) {
              return 'FTPS standard port is 21 or 990';
            }
            return true;
          },
        },
      ];
      const stderr = vi.fn();
      const prompt = vi
        .fn()
        .mockResolvedValueOnce({ protocol: 'ftps' })
        .mockResolvedValueOnce({ port: '8021' })
        .mockResolvedValueOnce({ port: '990' });
      await new PromptFlow(fields, { prompt, stderr }).run();
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      expect(calls.some((m) => m.includes('FTPS standard port'))).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('forwards select.choices and the initial value to the prompt library', async () => {
      const fields: PromptField[] = [
        {
          name: 'protocol',
          label: 'protocol',
          type: 'select',
          initial: 'ftps',
          choices: [
            { title: 'FTPS', value: 'ftps' },
            { title: 'FTP', value: 'ftp' },
            { title: 'SFTP', value: 'sftp' },
          ],
        },
      ];
      const prompt = vi.fn().mockResolvedValueOnce({ protocol: 'ftps' });
      await new PromptFlow(fields, { prompt, stderr: vi.fn() }).run();
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'protocol',
          type: 'select',
          message: 'protocol',
          choices: fields[0].choices,
          initial: 'ftps',
        }),
      );
    });

    it('resolves function-form initial with prior answers', async () => {
      const fields: PromptField[] = [
        { name: 'profile', label: 'profile', type: 'text' },
        {
          name: 'keychainService',
          label: 'keychainService',
          type: 'text',
          initial: (answers) => `aiftp:${String(answers.profile ?? 'default')}`,
        },
      ];
      const prompt = vi
        .fn()
        .mockResolvedValueOnce({ profile: 'production' })
        .mockResolvedValueOnce({ keychainService: 'aiftp:production' });
      await new PromptFlow(fields, { prompt, stderr: vi.fn() }).run();
      expect(prompt).toHaveBeenLastCalledWith(
        expect.objectContaining({ initial: 'aiftp:production' }),
      );
    });

    it('forwards number bounds (min/max) to the prompt library', async () => {
      const fields: PromptField[] = [
        { name: 'port', label: 'port', type: 'number', min: 1, max: 65535 },
      ];
      const prompt = vi.fn().mockResolvedValueOnce({ port: 21 });
      await new PromptFlow(fields, { prompt, stderr: vi.fn() }).run();
      expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ min: 1, max: 65535 }));
    });

    it('hint is shown once per fresh field arrival, suppressed on validate re-prompt', async () => {
      // S1 (Phase 1 self-review): printHint should not spam stderr when
      // the same field is re-prompted due to a validate failure. The user
      // already saw the hint; repeating it on every reject is noise.
      const fields: PromptField[] = [
        {
          name: 'port',
          label: 'port',
          type: 'text',
          hint: '標準: 21 (FTP), 990 (FTPS implicit)',
          validate: (v) => (v === '21' ? true : 'port must be 21 for this test'),
        },
      ];
      const stderr = vi.fn();
      const prompt = vi
        .fn()
        .mockResolvedValueOnce({ port: '99999' }) // first attempt: reject
        .mockResolvedValueOnce({ port: '50000' }) // second attempt: reject
        .mockResolvedValueOnce({ port: '21' }); // third attempt: accept
      await new PromptFlow(fields, { prompt, stderr }).run();
      const hintMessages = stderr.mock.calls
        .map((c) => c[0] as string)
        .filter((m) => m.includes('💡'));
      expect(hintMessages).toHaveLength(1);
    });

    it('hint is re-shown after :back navigation returns to a previously-seen field', async () => {
      // The reverse of the above: when the cursor *leaves* a field
      // (advance or back), the next arrival at that field is a fresh
      // arrival and the hint should print again.
      const fields: PromptField[] = [
        { name: 'host', label: 'host', type: 'text', hint: 'enter host' },
        { name: 'user', label: 'user', type: 'text', hint: 'enter user' },
      ];
      const stderr = vi.fn();
      const prompt = vi
        .fn()
        .mockResolvedValueOnce({ host: 'ftp.example.com' })
        .mockResolvedValueOnce({ user: BACK_KEYWORD }) // back to host
        .mockResolvedValueOnce({ host: 'ftp.example.com' })
        .mockResolvedValueOnce({ user: 'deploy' });
      await new PromptFlow(fields, { prompt, stderr }).run();
      const hostHints = stderr.mock.calls
        .map((c) => c[0] as string)
        .filter((m) => m.includes('enter host'));
      // host visited twice (initial + after :back) → hint shown twice
      expect(hostHints).toHaveLength(2);
    });

    it('aborts with cancelled after 100 iterations to prevent runaway loops', async () => {
      const fields: PromptField[] = [
        {
          name: 'host',
          label: 'host',
          type: 'text',
          // Always invalid — induces an infinite re-prompt without the cap.
          validate: () => 'always invalid',
        },
      ];
      const stderr = vi.fn();
      const prompt = vi.fn().mockResolvedValue({ host: 'anything' });
      const result = await new PromptFlow(fields, { prompt, stderr }).run();
      expect(result).toEqual({ kind: 'cancelled' });
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      expect(calls.some((m) => m.includes('100'))).toBe(true);
      expect(prompt).toHaveBeenCalledTimes(100);
    });
  });
});
