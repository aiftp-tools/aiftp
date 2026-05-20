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

  // ---------------------------------------------------------------------
  // v0.5.0 fix-1 (Codex BLOCK + Claude HIGH review):
  //   - per-file atomic 2-phase upload (tmp + rename)
  //   - mkdir parent dirs before first upload
  //   - rolledBack sorted by path
  //   - upload-failure cleans up the orphan tmp via unlink
  // ---------------------------------------------------------------------

  it('runRollback does a 2-phase atomic upload when uploader.rename is provided', async () => {
    const calls: Array<{ op: string; arg1: string; arg2?: string }> = [];
    const uploader: RollbackUploader = {
      upload: async (_localPath, remotePath, _content) => {
        calls.push({ op: 'upload', arg1: remotePath });
      },
      rename: async (src, dest) => {
        calls.push({ op: 'rename', arg1: src, arg2: dest });
      },
      mkdir: async (dir) => {
        calls.push({ op: 'mkdir', arg1: dir });
      },
    };
    const store = makeStore([targetSnap], targetFiles);
    await runRollback({
      snapshotId: targetSnap.id,
      backupStore: store,
      uploader,
      remoteRoot: '/public_html',
      excluder: createExcluder(),
      dryRun: false,
    });
    // Every upload goes to a tmp path containing `.aiftp-rb-`, then is
    // renamed to the final path.
    const uploadCalls = calls.filter((c) => c.op === 'upload');
    const renameCalls = calls.filter((c) => c.op === 'rename');
    expect(uploadCalls).toHaveLength(2);
    for (const u of uploadCalls) {
      expect(u.arg1).toMatch(/\.aiftp-rb-[0-9a-f-]+$/u);
    }
    expect(renameCalls).toHaveLength(2);
    // Rename pairs tmp → final; every final path must end with the
    // expected file name (no .aiftp-rb suffix on dest).
    for (const r of renameCalls) {
      expect(r.arg1).toMatch(/\.aiftp-rb-/u);
      expect(r.arg2).not.toMatch(/\.aiftp-rb-/u);
    }
  });

  it('runRollback pre-creates the parent directory only once per dir', async () => {
    const mkdirCalls: string[] = [];
    const uploader: RollbackUploader = {
      upload: async () => undefined,
      mkdir: async (dir) => {
        mkdirCalls.push(dir);
      },
    };
    const store = makeStore([targetSnap], targetFiles);
    await runRollback({
      snapshotId: targetSnap.id,
      backupStore: store,
      uploader,
      remoteRoot: '/public_html',
      excluder: createExcluder(),
      dryRun: false,
    });
    // Both files are under /public_html — mkdir should be called once.
    expect(mkdirCalls).toEqual(['/public_html']);
  });

  it('runRollback sorts the rolledBack array by path for deterministic output', async () => {
    const reverseSnap = snap(
      '2026-05-19T05:00:00.000Z-auto-rev',
      '2026-05-19T05:00:00.000Z',
      'auto',
      [{ path: 'z-last.html' }, { path: 'a-first.html' }, { path: 'm-middle.html' }],
    );
    const reverseFiles = new Map([
      [
        reverseSnap.id,
        new Map<string, Buffer>([
          ['z-last.html', Buffer.from('z')],
          ['a-first.html', Buffer.from('a')],
          ['m-middle.html', Buffer.from('m')],
        ]),
      ],
    ]);
    const uploader: RollbackUploader = {
      upload: async () => undefined,
      mkdir: async () => undefined,
    };
    const store = makeStore([reverseSnap], reverseFiles);
    const result = await runRollback({
      snapshotId: reverseSnap.id,
      backupStore: store,
      uploader,
      remoteRoot: '/public_html',
      excluder: createExcluder(),
      dryRun: false,
    });
    expect(result.rolledBack.map((r) => r.path)).toEqual([
      'a-first.html',
      'm-middle.html',
      'z-last.html',
    ]);
  });

  it('runRollback cleans up the orphan tmp via unlink when upload fails', async () => {
    let uploadCalls = 0;
    const unlinkCalls: string[] = [];
    const uploader: RollbackUploader = {
      upload: async (_local, remotePath, _content) => {
        uploadCalls++;
        if (uploadCalls === 1) {
          // First file uploads fine; second one explodes.
          return;
        }
        throw new Error(`simulated failure for ${remotePath}`);
      },
      rename: async () => undefined,
      unlink: async (path) => {
        unlinkCalls.push(path);
      },
    };
    const store = makeStore([targetSnap], targetFiles);
    await expect(
      runRollback({
        snapshotId: targetSnap.id,
        backupStore: store,
        uploader,
        remoteRoot: '/public_html',
        excluder: createExcluder(),
        dryRun: false,
      }),
    ).rejects.toThrow(/rollback failed/i);
    // Orphan tmp from the failed second upload must have been unlinked.
    expect(unlinkCalls).toHaveLength(1);
    expect(unlinkCalls[0]).toMatch(/\.aiftp-rb-/u);
  });
});
