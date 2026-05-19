import { describe, expect, it } from 'vitest';
import type { ExecFn, ExecResult } from './keychain.js';
import { KeychainNotFoundError, createWindowsKeychainBackend } from './keychain.js';

interface ExecCall {
  cmd: string;
  args: readonly string[];
}

function makeExec(responses: Record<string, ExecResult | (() => ExecResult)>): {
  exec: ExecFn;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args[0] ?? ''}`;
    const candidate = responses[key] ?? responses[cmd];
    if (!candidate) {
      return { stdout: '', stderr: `unstubbed: ${cmd} ${args.join(' ')}`, code: 1 };
    }
    return typeof candidate === 'function' ? candidate() : candidate;
  };
  return { exec, calls };
}

const success: ExecResult = { stdout: '', stderr: '', code: 0 };

describe('createWindowsKeychainBackend: setPassword', () => {
  it('invokes cmdkey /generic with the joined target name and base64-encoded password', async () => {
    const { exec, calls } = makeExec({ cmdkey: success });
    const backend = createWindowsKeychainBackend(exec);

    await backend.setPassword('aiftp:production', 'deploy', 'p@ssw0rd!');

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.cmd.toLowerCase()).toContain('cmdkey');
    const args = call?.args ?? [];
    // Target name: <service>:<account>
    expect(args.some((a) => a.startsWith('/generic:aiftp:production:deploy'))).toBe(true);
    expect(args.some((a) => a.startsWith('/user:deploy'))).toBe(true);
    // Password stored using the aiftp-v1 base64 envelope, same as macOS.
    const passArg = args.find((a) => a.startsWith('/pass:'));
    expect(passArg).toBeDefined();
    expect(passArg).toContain('aiftp-v1:');
  });

  it('throws KeychainError on cmdkey non-zero exit', async () => {
    const { exec } = makeExec({
      cmdkey: { stdout: '', stderr: 'CMDKEY: Access denied', code: 1 },
    });
    const backend = createWindowsKeychainBackend(exec);
    await expect(backend.setPassword('svc', 'acc', 'pw')).rejects.toThrow(
      /Access denied|Failed to store/,
    );
  });
});

describe('createWindowsKeychainBackend: getPassword', () => {
  it('shells out to powershell with the joined target name and decodes the aiftp-v1 envelope', async () => {
    const encoded = `aiftp-v1:${Buffer.from('hello', 'utf8').toString('base64')}`;
    const { exec, calls } = makeExec({
      powershell: { stdout: `${encoded}\r\n`, stderr: '', code: 0 },
    });
    const backend = createWindowsKeychainBackend(exec);

    const password = await backend.getPassword('aiftp:production', 'deploy');

    expect(password).toBe('hello');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.cmd.toLowerCase()).toContain('powershell');
    // The target name must be passed somewhere in the args / stdin. We assert
    // it appears as a literal so the PS script binds it to CredRead.
    const allArgs = (call?.args ?? []).join(' ');
    expect(allArgs).toContain('aiftp:production:deploy');
  });

  it('maps "not found" output to KeychainNotFoundError', async () => {
    const { exec } = makeExec({
      powershell: { stdout: '', stderr: '', code: 0 },
    });
    const backend = createWindowsKeychainBackend(exec);
    await expect(backend.getPassword('svc', 'acc')).rejects.toBeInstanceOf(KeychainNotFoundError);
  });

  it('returns foreign (non-aiftp-v1) values verbatim', async () => {
    const { exec } = makeExec({
      powershell: { stdout: 'plain-text-from-elsewhere\r\n', stderr: '', code: 0 },
    });
    const backend = createWindowsKeychainBackend(exec);
    const pw = await backend.getPassword('svc', 'acc');
    expect(pw).toBe('plain-text-from-elsewhere');
  });
});

describe('createWindowsKeychainBackend: deletePassword', () => {
  it('invokes cmdkey /delete with the joined target name', async () => {
    const { exec, calls } = makeExec({ cmdkey: success });
    const backend = createWindowsKeychainBackend(exec);

    await backend.deletePassword('aiftp:production', 'deploy');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.some((a) => a.startsWith('/delete:aiftp:production:deploy'))).toBe(true);
  });

  it('maps "not found" stderr to KeychainNotFoundError', async () => {
    const { exec } = makeExec({
      cmdkey: { stdout: '', stderr: 'CMDKEY: Element not found.', code: 1 },
    });
    const backend = createWindowsKeychainBackend(exec);
    await expect(backend.deletePassword('svc', 'acc')).rejects.toBeInstanceOf(
      KeychainNotFoundError,
    );
  });
});

describe('createWindowsKeychainBackend: argument validation', () => {
  it('rejects empty service / account / password before shelling out', async () => {
    const { exec, calls } = makeExec({});
    const backend = createWindowsKeychainBackend(exec);
    await expect(backend.setPassword('', 'a', 'p')).rejects.toThrow(/service/);
    await expect(backend.setPassword('s', '', 'p')).rejects.toThrow(/account/);
    await expect(backend.getPassword('', 'a')).rejects.toThrow(/service/);
    expect(calls).toEqual([]);
  });
});
