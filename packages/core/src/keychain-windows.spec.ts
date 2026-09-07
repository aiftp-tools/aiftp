import { describe, expect, it } from 'vitest';
import type { ExecFn, ExecResult } from './keychain.js';
import { KeychainNotFoundError, createWindowsKeychainBackend } from './keychain.js';

interface ExecCall {
  cmd: string;
  args: readonly string[];
  stdin?: string;
}

function makeExec(responses: Record<string, ExecResult | (() => ExecResult)>): {
  exec: ExecFn;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args, options) => {
    calls.push({ cmd, args, ...(options?.stdin === undefined ? {} : { stdin: options.stdin }) });
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
  // Not a real credential — a fixture used to prove the value never reaches argv.
  const fixtureValue = 'fixture-only-not-real-p@ss';

  it('never puts the secret in the command line, and sends it on stdin instead', async () => {
    const { exec, calls } = makeExec({ powershell: success });
    const backend = createWindowsKeychainBackend(exec);

    await backend.setPassword('aiftp:production', 'deploy', fixtureValue);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    const args = call?.args ?? [];
    const encoded = `aiftp-v1:${Buffer.from(fixtureValue, 'utf8').toString('base64')}`;

    // Anything in argv is world-readable from the process list for as long as
    // the child lives. Neither the raw value nor its storage envelope may
    // appear there — the envelope is reversible base64, not a secret.
    for (const arg of args) {
      expect(arg).not.toContain(fixtureValue);
      expect(arg).not.toContain(encoded);
    }
    expect(args.some((a) => a.startsWith('/pass:'))).toBe(false);

    // It travels on stdin, in the same aiftp-v1 envelope as before, with no
    // trailing newline the reader would have to strip.
    expect(call?.stdin).toBe(encoded);
    // The target still has to reach the script somehow — via argv is fine,
    // it is not a credential.
    expect(args.join(' ')).toContain('aiftp:production:deploy');
  });

  it('reports a failed write as a KeychainError', async () => {
    const { exec } = makeExec({
      powershell: { stdout: '', stderr: 'CredWrite failed: 5', code: 1 },
    });
    const backend = createWindowsKeychainBackend(exec);

    await expect(backend.setPassword('aiftp:production', 'deploy', fixtureValue)).rejects.toThrow(
      /Failed to store Credential Manager entry/u,
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
