export interface DestinationBannerInput {
  readonly profile: string;
  readonly protocol: string;
  readonly remoteRoot: string;
  readonly serverKind: string;
  readonly localRoot: string;
  readonly siteName?: string;
  readonly label?: string;
}

export function formatDestinationBanner(input: DestinationBannerInput): string {
  const heading = input.siteName
    ? input.label
      ? `${input.siteName} (${input.label})`
      : input.siteName
    : input.profile;

  return [
    `⛳ 宛先: ${heading}`,
    `   ${input.protocol}://${input.profile} → ${input.remoteRoot}   [server: ${input.serverKind}]`,
    `   local: ${input.localRoot}`,
  ].join('\n');
}
