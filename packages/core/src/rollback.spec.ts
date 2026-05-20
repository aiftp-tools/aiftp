import { describe, expect, it } from 'vitest';
import type { SnapshotMeta } from './backup/store.js';
import { createExcluder } from './exclude.js';
import {
  type RollbackBackupStore,
  type RollbackUploader,
  resolveRollbackTarget,
  runRollback,
} from './rollback.js';

/**
 * Helper: build an in-memory backup store that returns Buffers from a
 * pre-populated map. `restoreFile` returns the pre-decrypted content so
 * tests focus on rollback semantics, not crypto.
 */
function makeStore(
  snapshots: SnapshotMeta[],
  files: Map<string, Map<string, Buffer>>,
): RollbackBackupStore {
  return {
    listSnapshots: async () => snapshots,
    restoreFile: async (id, path) => {
      const snap = files.get(id);
      if (!snap) throw new Error(`unknown snapshot: ${id}`);
      const content = snap.get(path);
      if (!content) throw new Error(`unknown path in ${id}: ${path}`);
      return content;
    },
  };
}

function snap(
  id: string,
  createdAt: string,
  type: 'auto' | 'full',
  files: Array<{ path: string; size?: number }>,
): SnapshotMeta {
  return {
    id,
    type,
    createdAt,
    fileCount: files.length,
    totalBytes: files.reduce((acc, f) => acc + (f.size ?? 16), 0),
    files: files.map((f) => ({
      path: f.path,
      storedName: `${f.path}.enc`,
      sizeOriginal: f.size ?? 16,
      sizeEncrypted: (f.size ?? 16) + 28,
      sha256Original: 'a'.repeat(64),
      sha256Encrypted: 'b'.repeat(64),
    })),
  };
}

describe('resolveRollbackTarget', () => {
  const a = snap('2026-05-19T00:00:00.000Z-auto-aaa', '2026-05-19T00:00:00.000Z', 'auto', [
    { path: 'index.html' },
  ]);
  const b = snap('2026-05-19T01:00:00.000Z-auto-bbb', '2026-05-19T01:00:00.000Z', 'auto', [
    { path: 'index.html' },
  ]);
  const c = snap('2026-05-19T02:00:00.000Z-full-ccc', '2026-05-19T02:00:00.000Z', 'full', [
    { path: 'index.html' },
  ]);

  it('picks the most recent auto snapshot for steps=1 (default)', async () => {
    const store = makeStore([a, b, c], new Map());
    const target = await resolveRollbackTarget({ store, steps: 1 });
    expect(target.id).toBe(b.id);
  });

  it('picks the N-th most recent auto snapshot for steps=N', async () => {
    const store = makeStore([a, b, c], new Map());
    const target = await resolveRollbackTarget({ store, steps: 2 });
    expect(target.id).toBe(a.id);
  });

  it('ignores full snapshots when counting steps (only push-time auto snapshots count)', async () => {
    // c is a full snapshot — it must NOT be considered for rollback steps
    // because "rollback by steps" means "undo the last N pushes".
    const store = makeStore([a, b, c], new Map());
    const target = await resolveRollbackTarget({ store, steps: 1 });
    expect(target.id).toBe(b.id);
    expect(target.type).toBe('auto');
  });

  it('honors an explicit snapshotId, regardless of type', async () => {
    const store = makeStore([a, b, c], new Map());
    const target = await resolveRollbackTarget({ store, snapshotId: c.id });
    expect(target.id).toBe(c.id);
    expect(target.type).toBe('full');
  });

  it('throws when steps exceeds the number of auto snapshots', async () => {
    const store = makeStore([a, b], new Map());
    await expect(resolveRollbackTarget({ store, steps: 5 })).rejects.toThrow(
      /only 2|not enough|too many steps/i,
    );
  });

  it('throws when both steps and snapshotId are omitted', async () => {
    const store = makeStore([a, b], new Map());
    await expect(resolveRollbackTarget({ store })).rejects.toThrow(/steps|snapshot/i);
  });

  it('throws when the explicit snapshotId does not exist', async () => {
    const store = makeStore([a, b], new Map());
    await expect(
      resolveRollbackTarget({
        store,
        snapshotId: '2026-05-19T99:99:99.999Z-auto-xxx',
      }),
    ).rejects.toThrow(/not found|unknown/i);
  });
});

describe('runRollback', () => {
  const targetSnap = snap('2026-05-19T01:00:00.000Z-auto-aaa', '2026-05-19T01:00:00.000Z', 'auto', [
    { path: 'index.html', size: 12 },
    { path: 'about.html', size: 9 },
  ]);
  const targetFiles = new Map([
    [
      targetSnap.id,
      new Map<string, Buffer>([
        ['index.html', Buffer.from('<h1>old</h1>')],
        ['about.html', Buffer.from('<p>old</p>')],
      ]),
    ],
  ]);

  it('uploads every file in the snapshot back to remoteRoot', async () => {
    const uploads: Array<{ remotePath: string; bytes: number }> = [];
    const uploader: RollbackUploader = {
      upload: async (_localPath, remotePath, content) => {
        uploads.push({ remotePath, bytes: content.length });
      },
      mkdir: async () => undefined,
    };
    const store = makeStore([targetSnap], targetFiles);
    const result = await runRollback({
      snapshotId: targetSnap.id,
      backupStore: store,
      uploader,
      remoteRoot: '/public_html',
      excluder: createExcluder(),
      dryRun: false,
    });
    expect(result.dryRun).toBe(false);
    expect(result.snapshotId).toBe(targetSnap.id);
    expect(result.rolledBack.map((r) => r.path).sort()).toEqual(['about.html', 'index.html']);
    expect(uploads.map((u) => u.remotePath).sort()).toEqual([
      '/public_html/about.html',
      '/public_html/index.html',
    ]);
  });

  it('honors dryRun by skipping uploads but still producing a plan', async () => {
    const uploader: RollbackUploader = {
      upload: async () => {
        throw new Error('upload must not be called in dry-run');
      },
      mkdir: async () => undefined,
    };
    const store = makeStore([targetSnap], targetFiles);
    const result = await runRollback({
      snapshotId: targetSnap.id,
      backupStore: store,
      uploader,
      remoteRoot: '/public_html',
      excluder: createExcluder(),
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.planned.sort()).toEqual(['about.html', 'index.html']);
    expect(result.rolledBack).toHaveLength(0);
  });

  it('NEVER uploads hard-excluded files (auth-bearing patterns)', async () => {
    const snapshotWithSecrets = snap(
      '2026-05-19T01:00:00.000Z-auto-sec',
      '2026-05-19T01:00:00.000Z',
      'auto',
      [
        { path: 'index.html', size: 12 },
        { path: 'wp-config.php', size: 50 },
        { path: '.env', size: 20 },
      ],
    );
    const filesMap = new Map([
      [
        snapshotWithSecrets.id,
        new Map<string, Buffer>([
          ['index.html', Buffer.from('<h1>x</h1>')],
          ['wp-config.php', Buffer.from('<?php $pass="secret";')],
          ['.env', Buffer.from('SECRET=1')],
        ]),
      ],
    ]);
    const uploads: string[] = [];
    const uploader: RollbackUploader = {
      upload: async (_l, remotePath) => {
        uploads.push(remotePath);
      },
      mkdir: async () => undefined,
    };
    const store = makeStore([snapshotWithSecrets], filesMap);
    const result = await runRollback({
      snapshotId: snapshotWithSecrets.id,
      backupStore: store,
      uploader,
      remoteRoot: '/public_html',
      excluder: createExcluder(),
      dryRun: false,
    });
    // index.html OK, the two auth-bearing files MUST be in skipped with reason=hard-exclude
    expect(uploads).toEqual(['/public_html/index.html']);
    const skipped = result.skipped.map((s) => s.path).sort();
    expect(skipped).toEqual(['.env', 'wp-config.php']);
    for (const entry of result.skipped) {
      expect(entry.status).toBe('skipped-hard-exclude');
    }
  });

  it('returns a verifiable diff_hash anchor: same snapshot id + same file set produces same uploads', async () => {
    // Determinism guarantee for MCP plan/confirm gating: the set of files
    // that runRollback would push is fully determined by snapshotId +
    // excluder, so the MCP layer can hash that set up-front and bind the
    // confirm step to it.
    const uploader: RollbackUploader = {
      upload: async () => undefined,
      mkdir: async () => undefined,
    };
    const store = makeStore([targetSnap], targetFiles);
    const first = await runRollback({
      snapshotId: targetSnap.id,
      backupStore: store,
      uploader,
      remoteRoot: '/public_html',
      excluder: createExcluder(),
      dryRun: true,
    });
    const second = await runRollback({
      snapshotId: targetSnap.id,
      backupStore: store,
      uploader,
      remoteRoot: '/public_html',
      excluder: createExcluder(),
      dryRun: true,
    });
    expect(first.planned).toEqual(second.planned);
  });
});
