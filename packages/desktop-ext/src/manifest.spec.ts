import { describe, expect, it } from 'vitest';
import { buildManifest } from './manifest.js';

describe('buildManifest', () => {
  const manifest = buildManifest('0.13.0');

  it('carries the version it was given', () => {
    expect(manifest.version).toBe('0.13.0');
  });

  it('declares both target platforms and the Node floor', () => {
    expect(manifest.compatibility.platforms).toEqual(['darwin', 'win32']);
    expect(manifest.compatibility.runtimes.node).toBe('>=22.0.0');
  });

  it('passes every user_config value to the server through env', () => {
    const env = manifest.server.mcp_config.env;
    expect(Object.keys(env).sort()).toEqual([
      'AIFTP_BOOTSTRAP_CREDENTIAL',
      'AIFTP_BOOTSTRAP_HOST',
      'AIFTP_BOOTSTRAP_PROTOCOL',
      'AIFTP_BOOTSTRAP_REMOTE_ROOT',
      'AIFTP_BOOTSTRAP_SITE',
      'AIFTP_BOOTSTRAP_USER',
      'AIFTP_CONFIRM_PHRASE',
      'AIFTP_PROJECT_DIR',
    ]);
    expect(env.AIFTP_PROJECT_DIR).toBe('${user_config.local_root}');
    expect(env.AIFTP_BOOTSTRAP_SITE).toBe('${user_config.site_name}');
    expect(env.AIFTP_BOOTSTRAP_HOST).toBe('${user_config.host}');
    expect(env.AIFTP_BOOTSTRAP_PROTOCOL).toBe('${user_config.protocol}');
    expect(env.AIFTP_BOOTSTRAP_USER).toBe('${user_config.username}');
    expect(env.AIFTP_BOOTSTRAP_REMOTE_ROOT).toBe('${user_config.remote_root}');
    expect(env.AIFTP_BOOTSTRAP_CREDENTIAL).toBe('${user_config.password}');
    expect(env.AIFTP_CONFIRM_PHRASE).toBe('${user_config.confirm_phrase}');
  });

  it('marks exactly the two secrets as sensitive', () => {
    const sensitive = Object.entries(manifest.user_config)
      .filter(([, field]) => field.sensitive === true)
      .map(([key]) => key)
      .sort();
    expect(sensitive).toEqual(['confirm_phrase', 'password']);
  });

  it('states the confirm-phrase strength rule in the settings UI (v0.13 H2)', () => {
    // The instructor sets the phrase here, so the requirement has to be
    // visible at the moment they type it -- not only in an error later.
    const description = manifest.user_config.confirm_phrase?.description ?? '';
    expect(description).toContain('12文字以上・4種類以上の文字が必要です');
    expect(description).toContain('条件を満たさない合言葉は本番反映が拒否されます');
    // How to make one, never one to copy: no field of the shipped manifest
    // may contain something a trainee could paste in as their phrase. The
    // generator is the recommended path, so it is named here, where the
    // instructor is standing when they need it.
    expect(description).toContain('aiftp confirm-phrase generate');
    expect(description).toContain('パスワード管理ツールで生成した20文字以上でも可');
    expect(description).not.toMatch(/例[:：]/u);
  });

  it('uses a directory picker for the site folder', () => {
    expect(manifest.user_config.local_root?.type).toBe('directory');
  });

  it('lists the allowed protocol values in the description because user_config has no enum type', () => {
    expect(manifest.user_config.protocol?.type).toBe('string');
    expect(manifest.user_config.protocol?.description).toContain('ftps');
    expect(manifest.user_config.protocol?.description).toContain('sftp');
    expect(manifest.user_config.protocol?.description).toContain('ftp');
  });

  it('reserves the free identity name', () => {
    expect(manifest.name).toBe('aiftp');
  });

  it('points at the packed entry point', () => {
    expect(manifest.server.entry_point).toBe('server/index.js');
    expect(manifest.server.mcp_config.args).toEqual(['${__dirname}/server/index.js']);
  });
});
