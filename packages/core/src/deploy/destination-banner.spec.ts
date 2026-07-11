import { describe, expect, it } from 'vitest';
import { type DestinationBannerInput, formatDestinationBanner } from './destination-banner.js';

const baseInput: DestinationBannerInput = {
  profile: 'production',
  protocol: 'ftps',
  remoteRoot: '/public_html',
  serverKind: 'starserver',
  localRoot: 'dist',
};

describe('formatDestinationBanner', () => {
  it('formats a registered site heading with its label', () => {
    expect(
      formatDestinationBanner({
        ...baseInput,
        siteName: 'gwco',
        label: 'example-corp.co.jp',
      }),
    ).toBe(
      [
        '⛳ 宛先: gwco (example-corp.co.jp)',
        '   ftps://production → /public_html   [server: starserver]',
        '   local: dist',
      ].join('\n'),
    );
  });

  it('formats a registered site heading without a label', () => {
    expect(formatDestinationBanner({ ...baseInput, siteName: 'gwco' }).split('\n')[0]).toBe(
      '⛳ 宛先: gwco',
    );
  });

  it('falls back to the profile name for an unregistered site', () => {
    expect(formatDestinationBanner(baseInput).split('\n')[0]).toBe('⛳ 宛先: production');
  });

  it.each(['ftp', 'ftps', 'sftp'])('renders the %s protocol', (protocol) => {
    expect(formatDestinationBanner({ ...baseInput, protocol }).split('\n')[1]).toBe(
      `   ${protocol}://production → /public_html   [server: starserver]`,
    );
  });

  it('keeps destination, protocol, and local fields in order and round-trips values', () => {
    const banner = formatDestinationBanner({
      profile: 'staging',
      protocol: 'sftp',
      remoteRoot: '/srv/www',
      serverKind: 'generic',
      localRoot: 'build/output',
      siteName: 'docs',
      label: 'Documentation',
    });

    expect(banner.split('\n')).toEqual([
      '⛳ 宛先: docs (Documentation)',
      '   sftp://staging → /srv/www   [server: generic]',
      '   local: build/output',
    ]);
  });

  it('structurally excludes and never renders host data', () => {
    const host = 'ftp.secret.example.com';
    const banner = formatDestinationBanner({
      ...baseInput,
      // @ts-expect-error DestinationBannerInput intentionally excludes host.
      host,
    });

    expect(banner).not.toContain(host);
  });
});
