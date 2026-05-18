import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupKeyService, createDefaultBackupStore } from './default-store.js';

describe('createDefaultBackupStore', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = join(tmpdir(), `aiftp-default-backup-store-test-${randomUUID()}`);
    await mkdir(join(cwd, 'site'), { recursive: true });
    await writeFile(
      join(cwd, '.aiftp.toml'),
      [
        'schema = 1',
        '',
        '[profile.production]',
        'host = "ftp.example.com"',
        'port = 21',
        'protocol = "ftps"',
        'user = "deploy-user"',
        'remote_root = "/public_html"',
        'local_root = "site"',
        'keychain_service = "aiftp:production"',
        'server_kind = "starserver"',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('loads the profile backup key and creates restorable encrypted snapshots', async () => {
    const key = Buffer.alloc(32, 7);
    await writeFile(join(cwd, 'site', 'index.html'), '<h1>backup</h1>\n', 'utf8');

    const store = await createDefaultBackupStore({
      cwd,
      profileName: 'production',
      keychain: {
        getPassword: async (service, account) => {
          expect(service).toBe(backupKeyService('aiftp:production'));
          expect(account).toBe('production');
          return key.toString('base64');
        },
      },
    });
    const snapshot = await store.createAutoSnapshot([
      'index.html',
      '.aiftp/state/production/state.json',
      '.aiftp.toml',
    ]);

    expect(snapshot.files.map((file) => file.path)).toEqual(['index.html']);
    expect((await store.restoreFile(snapshot.id, 'index.html')).toString('utf8')).toBe(
      '<h1>backup</h1>\n',
    );
  });
});
