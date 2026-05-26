import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandTilde } from './path-utils.ts';

describe('expandTilde', () => {
  const HOME = homedir();

  it('expands bare ~ to homedir', () => {
    expect(expandTilde('~')).toBe(HOME);
  });

  it('expands ~/x to <home>/x', () => {
    expect(expandTilde('~/.ssh/id_ed25519')).toBe(join(HOME, '.ssh/id_ed25519'));
  });

  it('does not expand ~user/x (POSIX user-name form intentionally unsupported)', () => {
    expect(expandTilde('~alice/keys/id_rsa')).toBe('~alice/keys/id_rsa');
  });

  it('returns absolute paths unchanged', () => {
    expect(expandTilde('/etc/ssh/keys/id_rsa')).toBe('/etc/ssh/keys/id_rsa');
  });

  it('returns relative paths unchanged', () => {
    expect(expandTilde('./keys/id')).toBe('./keys/id');
    expect(expandTilde('keys/id')).toBe('keys/id');
  });

  it('handles empty string and tilde-prefix-without-slash', () => {
    expect(expandTilde('')).toBe('');
    expect(expandTilde('~not-a-user')).toBe('~not-a-user');
  });
});
