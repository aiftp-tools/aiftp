import { describe, expect, it, vi } from 'vitest';
import { PromptFlow } from './prompt-flow.ts';
import type { PromptField } from './types.ts';

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
});
