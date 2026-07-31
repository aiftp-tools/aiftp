export function sanitizeKeychainSiteName(siteName: string | undefined): string {
  if (siteName === undefined) return '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional keychain identifier sanitization
  const controlCharacters = /[\u0000-\u001f\u007f]+/gu;
  return siteName
    .trim()
    .replace(controlCharacters, '-')
    .replace(/[:/\\]+/gu, '-')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

export function buildKeychainService(siteName: string | undefined, profileName: string): string {
  const sanitizedSiteName = sanitizeKeychainSiteName(siteName);
  return sanitizedSiteName.length > 0
    ? `aiftp:${sanitizedSiteName}-${profileName}`
    : `aiftp:${profileName}`;
}
