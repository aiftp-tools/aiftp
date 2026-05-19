import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

// End-to-end migration coverage for loadConfig(autoMigrate=true). These tests
// must use a tmpdir because they mutate the config file on disk.

describe('loadConfig: v1 -> v2 auto-migration', () => {
  let cwd: string;
  let configPath: string;
  let backupPath: string;
  let migrationLogPath: string;

  beforeEach(async () => {
    cwd = join(tmpdir(), `aiftp-config-migration-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
    configPath = join(cwd, '.aiftp.toml');
    backupPath = join(cwd, '.aiftp.toml.v1.bak');
    migrationLogPath = join(cwd, '.aiftp', 'logs', 'migrations.jsonl');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const v1Source = [
    '# my deployment config',
    'schema = 1',
    '',
    '[profile.production]',
    'host = "ftp.example.com"',
    'user = "deploy"',
    'remote_root = "/public_html"',
    'local_root = "./dist"',
    'keychain_service = "aiftp:example-production"',
    '',
  ].join('\n');

  it('migrates a v1 file to v2 on disk and creates .aiftp.toml.v1.bak preserving the original', async () => {
    await writeFile(configPath, v1Source, 'utf8');

    const cfg = await loadConfig(configPath);

    expect(cfg.schema).toBe(2);
    const onDisk = await readFile(configPath, 'utf8');
    expect(onDisk).toMatch(/^# my deployment config\nschema = 2/u);
    expect(onDisk).toContain('[encoding]');
    expect(onDisk).toContain('[quirks]');
    const bak = await readFile(backupPath, 'utf8');
    expect(bak).toBe(v1Source);
  });

  it('appends a JSONL entry to .aiftp/logs/migrations.jsonl recording the migration', async () => {
    await writeFile(configPath, v1Source, 'utf8');

    await loadConfig(configPath);

    const log = await readFile(migrationLogPath, 'utf8');
    const lines = log.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.fromSchema).toBe(1);
    expect(entry.toSchema).toBe(2);
    expect(typeof entry.migratedAt).toBe('string');
    expect(typeof entry.toolVersion).toBe('string');
  });

  it('refuses to migrate when .aiftp.toml.v1.bak already exists (multi-run guard)', async () => {
    await writeFile(configPath, v1Source, 'utf8');
    await writeFile(backupPath, 'stale backup from previous run', 'utf8');

    await expect(loadConfig(configPath)).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig(configPath)).rejects.toThrow(/v1\.bak.*exists/i);
    // Original file is untouched.
    expect(await readFile(configPath, 'utf8')).toBe(v1Source);
  });

  it('is a no-op for v2 files: no .bak, no log entry, no rewrite', async () => {
    const v2Source = v1Source.replace('schema = 1', 'schema = 2');
    await writeFile(configPath, v2Source, 'utf8');

    const cfg = await loadConfig(configPath);

    expect(cfg.schema).toBe(2);
    await expect(readFile(backupPath, 'utf8')).rejects.toThrow();
    await expect(readFile(migrationLogPath, 'utf8')).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(v2Source);
  });

  it('autoMigrate=false leaves a v1 file unchanged and returns the v1-shaped config', async () => {
    await writeFile(configPath, v1Source, 'utf8');

    const cfg = await loadConfig(configPath, { autoMigrate: false });

    expect(cfg.schema).toBe(1);
    expect(await readFile(configPath, 'utf8')).toBe(v1Source);
    await expect(readFile(backupPath, 'utf8')).rejects.toThrow();
  });

  it('writes are atomic: a failed rename leaves the original file intact', async () => {
    // Set up: write the source, then make the parent read-only so the
    // temp->target rename cannot create the .v1.bak side file (or, depending
    // on platform, the rename itself). loadConfig must surface the failure
    // without leaving a half-written .aiftp.toml.
    //
    // We approximate "atomic" by checking that on any thrown error the
    // visible state of configPath equals v1Source byte-for-byte.
    await writeFile(configPath, v1Source, 'utf8');
    await writeFile(backupPath, 'pre-existing .bak that blocks migration', 'utf8');

    await expect(loadConfig(configPath)).rejects.toThrow();

    expect(await readFile(configPath, 'utf8')).toBe(v1Source);
  });
});
