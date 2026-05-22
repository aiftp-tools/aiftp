import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type State,
  StateError,
  computeHash,
  loadState,
  removeFileEntry,
  saveState,
  updateFileEntry,
} from './state.js';

describe('state management', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `aiftp-state-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('computeHash', () => {
    it('computes SHA-256 for a file using streaming reads', async () => {
      const filePath = join(tempDir, 'index.html');
      await writeFile(filePath, '<h1>aiftp</h1>\n', 'utf8');

      await expect(computeHash(filePath)).resolves.toBe(
        '99ba9319f33853a4e2a3dfce92e0cb1389b8597e2c062499c3f45032b8505804',
      );
    });
  });

  describe('loadState', () => {
    it('returns an empty schema v1 state when state.json does not exist', async () => {
      await expect(loadState(tempDir)).resolves.toEqual({
        schema: 1,
        files: {},
      });
    });

    it('loads an existing state file', async () => {
      const state: State = {
        schema: 1,
        files: {
          'index.html': {
            hash: 'abc123',
            size: 42,
            updatedAt: '2026-05-18T09:00:00.000Z',
          },
        },
      };
      await writeFile(join(tempDir, 'state.json'), JSON.stringify(state), 'utf8');

      await expect(loadState(tempDir)).resolves.toEqual(state);
    });

    it('rejects corrupted JSON with a StateError', async () => {
      await writeFile(join(tempDir, 'state.json'), '{not-json', 'utf8');

      await expect(loadState(tempDir)).rejects.toThrow(StateError);
    });

    it('rejects unsupported schemas', async () => {
      await writeFile(join(tempDir, 'state.json'), JSON.stringify({ schema: 999, files: {} }));

      await expect(loadState(tempDir)).rejects.toThrow(StateError);
    });
  });

  describe('saveState', () => {
    it('writes state.json atomically and creates the profile directory', async () => {
      const profileDir = join(tempDir, 'profiles', 'production');
      const state: State = {
        schema: 1,
        files: {
          'assets/app.css': {
            hash: 'def456',
            size: 128,
            updatedAt: '2026-05-18T10:00:00.000Z',
          },
        },
      };

      await saveState(profileDir, state);

      await expect(loadState(profileDir)).resolves.toEqual(state);
      await expect(stat(join(profileDir, 'state.json.tmp'))).rejects.toThrow();
      const source = await readFile(join(profileDir, 'state.json'), 'utf8');
      expect(source.endsWith('\n')).toBe(true);
    });
  });

  describe('updateFileEntry', () => {
    it('returns a new state with an updated file entry', () => {
      const state: State = {
        schema: 1,
        files: {
          'old.html': {
            hash: 'old-hash',
            size: 10,
            updatedAt: '2026-05-18T08:00:00.000Z',
          },
        },
      };

      const next = updateFileEntry(state, 'index.html', 'new-hash', 20, {
        updatedAt: '2026-05-18T11:00:00.000Z',
      });

      expect(next).toEqual({
        schema: 1,
        files: {
          'old.html': {
            hash: 'old-hash',
            size: 10,
            updatedAt: '2026-05-18T08:00:00.000Z',
          },
          'index.html': {
            hash: 'new-hash',
            size: 20,
            updatedAt: '2026-05-18T11:00:00.000Z',
          },
        },
      });
      expect(next).not.toBe(state);
      expect(next.files).not.toBe(state.files);
      expect(state.files['index.html']).toBeUndefined();
    });
  });

  describe('removeFileEntry', () => {
    it('returns a new state without the normalized file entry', () => {
      const state: State = {
        schema: 1,
        files: {
          'old.html': {
            hash: 'old-hash',
            size: 10,
            updatedAt: '2026-05-18T08:00:00.000Z',
          },
          'nested/index.html': {
            hash: 'nested-hash',
            size: 20,
            updatedAt: '2026-05-18T09:00:00.000Z',
          },
        },
      };

      const next = removeFileEntry(state, './nested/index.html');

      expect(next).toEqual({
        schema: 1,
        files: {
          'old.html': {
            hash: 'old-hash',
            size: 10,
            updatedAt: '2026-05-18T08:00:00.000Z',
          },
        },
      });
      expect(next).not.toBe(state);
      expect(next.files).not.toBe(state.files);
      expect(state.files['nested/index.html']).toBeDefined();
    });
  });
});
