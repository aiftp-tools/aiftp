import { describe, expect, it } from 'vitest';
import { BootstrapValidationError } from './types.js';
import { validateBootstrapInput } from './validate.js';

const valid = {
  siteName: 'gwco',
  localRoot: '/abs/site',
  host: 'ftp.example.test',
  protocol: 'ftps' as const,
  username: 'deployer',
  remoteRoot: '/public_html',
};

describe('validateBootstrapInput', () => {
  it('defaults the profile name to production', () => {
    expect(validateBootstrapInput(valid).profileName).toBe('production');
  });

  it('defaults the protocol to ftps when omitted', () => {
    const { protocol, ...withoutProtocol } = valid;
    expect(validateBootstrapInput(withoutProtocol).protocol).toBe('ftps');
  });

  it('rejects an unknown protocol with a Japanese hint', () => {
    let thrown: unknown;
    try {
      validateBootstrapInput({ ...valid, protocol: 'sftps' as never });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BootstrapValidationError);
    expect((thrown as BootstrapValidationError).message).toBe(
      'bootstrap-invalid: protocol must be one of ftps, sftp, ftp (got "sftps")',
    );
    expect((thrown as BootstrapValidationError).hint).toBe(
      'Claude Desktop の設定 → 拡張機能 → aiftp で「プロトコル」欄に ftps / sftp / ftp のいずれかを入力し、Claude Desktop を再起動してください。',
    );
  });

  it('rejects a site name containing a path separator', () => {
    expect(() => validateBootstrapInput({ ...valid, siteName: 'a/b' })).toThrow(
      'bootstrap-invalid: site_name must contain only letters, digits, dot, underscore, or hyphen',
    );
  });

  it('rejects a relative local_root', () => {
    expect(() => validateBootstrapInput({ ...valid, localRoot: './site' })).toThrow(
      'bootstrap-invalid: local_root must be an absolute path',
    );
  });

  it('rejects an empty host', () => {
    expect(() => validateBootstrapInput({ ...valid, host: '   ' })).toThrow(
      'bootstrap-invalid: host must not be empty',
    );
  });

  it('trims surrounding whitespace from text fields', () => {
    expect(validateBootstrapInput({ ...valid, host: '  ftp.example.test  ' }).host).toBe(
      'ftp.example.test',
    );
  });
});
