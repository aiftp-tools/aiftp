export interface MigrateResult {
  source: string;
  changed: boolean;
}

const ENCODING_SECTION = ['[encoding]', 'file_name = "auto"'].join('\n');

const QUIRKS_SECTION = [
  '[quirks]',
  'ignore_pasv_address = false',
  'use_mlsd = true',
  'tls_check_hostname = true',
  'noop_interval_sec = 0',
].join('\n');

function appendSection(source: string, section: string): string {
  const newline = source.endsWith('\n') ? '' : '\n';
  return `${source}${newline}\n${section}\n`;
}

export function migrateV1ToV2Source(source: string): MigrateResult {
  const schemaMatch = source.match(/^\s*schema\s*=\s*([^\s#]+)(?:\s*#.*)?$/mu);
  if (!schemaMatch) {
    throw new Error('Cannot migrate config: schema field is missing.');
  }

  const schema = schemaMatch[1];
  if (schema === '2') {
    return { source, changed: false };
  }
  if (schema !== '1') {
    throw new Error(`Cannot migrate config: unsupported schema ${schema}.`);
  }

  let migrated = source.replace(
    /^(\s*schema\s*=\s*)1(\s*(?:#.*)?$)/mu,
    (_match, prefix: string, suffix: string) => `${prefix}2${suffix}`,
  );

  if (!/^\[encoding\]/mu.test(migrated)) {
    migrated = appendSection(migrated, ENCODING_SECTION);
  }
  if (!/^\[quirks\]/mu.test(migrated)) {
    migrated = appendSection(migrated, QUIRKS_SECTION);
  }

  return { source: migrated, changed: true };
}
