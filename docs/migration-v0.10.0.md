# Migrating to aiftp v0.10.0

> **Breaking release** — Snapshot manifest schema 1 → 2, remote delete/prune semantics, and MCP rollback confirmation contract change.
>
> Read this entire document **before** upgrading. Downgrade is NOT supported once a v0.10.0 snapshot is written.

---

## 0. TL;DR

| Area | What changes |
|---|---|
| Snapshot format | Schema `1` → `2`. New per-file `operation` field (`added` / `modified` / `removed`) and manifest-level `counts`. |
| `added` files | Recorded as **tombstones** (no content stored) so rollback can issue a real `delete`. |
| Schema 1 reads | Still supported (read-only). Schema 2 is write-only. |
| Downgrade | **NOT supported**. Restore from a manual `.aiftp/` backup if you must return to v0.9.x. |
| `deletion_policy` (new) | Defaults to `"never"` — v0.9.x behavior preserved. Opt in to `"prune-auto"` or `"prune-with-confirm"`. |
| CLI `push` | dry-run output now shows planned deletes when `deletion_policy ≠ "never"`. For `"prune-with-confirm"`, CLI requires a typed `DELETE` prompt before mutation; there is no `--confirm-deletes` flag. |
| CLI `rollback` | dry-run output now shows planned deletes. Tombstones in target snapshot trigger remote `delete`. |
| MCP `aiftp_rollback_confirm` | **BREAKING**: when `plannedDeletes > 0`, the call MUST include `acknowledge_deletions: true`. |
| MCP `diff_hash` | New format `aiftp-rollback-plan-v2` / `aiftp-push-plan-v2` — includes both upload and delete sets. |

---

## 1. Before upgrading

1. Verify your current v0.9.x deployment is stable on production.
2. Take a manual full copy of `.aiftp/backups/` and `.aiftp/state.json` (in case downgrade is needed).
3. Confirm you have access to the Keychain entry for your backup key.
4. Read this document end-to-end.

---

## 2. Snapshot schema migration

### What changes in the manifest

- `schema` field bumped from `1` to `2`
- Each entry in `manifest.files[]` now carries an `operation` field: `"added" | "modified" | "removed"`
- New top-level `counts: { added, modified, removed }` field on the manifest
- For `operation: "added"` entries, the snapshot stores a **tombstone**: `storedName`, `sizeOriginal`, `hash` and friends are `null`, because there was no remote content to back up. The tombstone is sufficient for rollback to call `delete` on that path.

### What does NOT change

- Encryption (AES-256-GCM)
- Key derivation (PBKDF2 → snapshot key)
- Directory layout: `.aiftp/backups/<snapshot-id>/manifest.enc` + `files/<storedName>.enc`
- Keychain entry name for the backup key

### Read compatibility

- v0.10.0 reads schema 1 manifests for `verify` and `restore` (per-file). Existing v0.9.x backups remain usable.
- v0.10.0 only writes schema 2 manifests.
- v0.9.x **cannot** read schema 2 manifests. Mixed-version environments are not supported.

### Downgrade is NOT supported

Once aiftp v0.10.0 writes a single schema 2 snapshot to `.aiftp/backups/`, running v0.9.x against the same `.aiftp/` directory will fail to read newer snapshots.

If you must roll back to v0.9.x:

1. Stop all aiftp operations against the project.
2. Replace `.aiftp/` with the manual backup you took in §1.
3. Reinstall the desired v0.9.x version.
4. Confirm `.aiftp/backups/` contains only schema 1 manifests.

---

## 3. Config changes

### `[safety].deletion_policy` (new)

```toml
[safety]
# "never"             — never delete remote files (v0.9.x behavior, default)
# "prune-auto"        — delete remote files when the local copy is gone (no extra ack)
# "prune-with-confirm"— delete only after CLI typed DELETE / MCP acknowledge_deletions
deletion_policy = "never"
```

- **Default `"never"` preserves v0.9.x behavior.** No remote deletion happens unless you opt in.
- Use `"prune-with-confirm"` for a careful first try.
- `"prune-auto"` is for fully automated pipelines where ack is unnecessary.

### Other safety fields (unchanged)

`max_files_per_push`, `max_total_size_mb`, `verify_after_upload`, `require_tls`, etc. are unchanged. Note: `max_files_per_push` now counts **uploads + deletes** combined.

---

## 4. CLI changes

### `aiftp push`

- When `deletion_policy = "prune-with-confirm"` and at least one remote delete is planned, the CLI requires the operator to type `DELETE` at an interactive prompt before mutation. There is no `--confirm-deletes` CLI flag (typed-prompt is intentionally the only confirmation path).
- The existing `--yes` flag continues to skip only the production-profile confirmation prompt (it does NOT auto-approve deletions).
- Dry-run output now lists planned deletes separately:
  ```
  Planned uploads: 5
  Planned deletes: 2
    - foo/old.html
    - bar/deprecated.css
  ```

### `aiftp rollback`

- For target snapshots that contain `operation: "added"` tombstones, rollback now issues a real `delete` on the remote path (v0.9.x silently no-op'd).
- Dry-run output now shows planned deletes alongside planned uploads.
- Hard-excluded paths (`wp-config.php`, `.env*`, `db.php`, etc.) are skipped from both upload and delete.
- `FtpNotFoundError` (FTP 550) during delete is **NOT** silently swallowed: 550 can also mean permission denied on some Japanese shared-hosting providers (Sakura / Lolipop), so the error is surfaced to the caller.

### `aiftp backup`

No behavioral change. Listing and verification work for both schema 1 and schema 2 manifests.

---

## 5. MCP changes (BREAKING for clients)

### `aiftp_push_confirm`

Already accepted (and required, for prune policies) `acknowledge_deletions: true`. No new required field, but the planned-delete drift check now also re-runs the dry-run and rejects if the upload set OR delete set drifted between `prepare` and `confirm`.

### `aiftp_rollback_confirm` — REQUIREMENT CHANGE

When the corresponding `aiftp_rollback_prepare` returns `plannedDeletes.length > 0`, the `aiftp_rollback_confirm` call **MUST** include `acknowledge_deletions: true`.

```jsonc
// before (v0.9.x):
{
  "profile": "production",
  "plan_id": "...",
  "diff_hash": "...",
  "confirm_token": "..."
}

// after (v0.10.0):
{
  "profile": "production",
  "plan_id": "...",
  "diff_hash": "...",
  "confirm_token": "...",
  "acknowledge_deletions": true  // ← REQUIRED when plannedDeletes > 0
}
```

If omitted, the call is rejected with:

```
Deletion rollback refused: N remote delete(s) were planned. Re-call aiftp_rollback_confirm with acknowledge_deletions: true.
```

This brings rollback in line with the push side's 2-factor approval (diff_hash + acknowledge_deletions).

### `diff_hash` format

The hash semantic marker is now `aiftp-rollback-plan-v2` / `aiftp-push-plan-v2`. The hash input includes both the upload set and the delete set, plus profile, remote_root, and `VERSION`. Hashes generated by older clients will not match.

### `aiftp_push` (direct dry-run tool)

The `safety` block passed into the underlying `runPush` now includes `deletion_policy`. Direct dry-run callers will see accurate `plannedDeletes` in the preview (previously always empty).

---

## 6. Safety boundaries (unchanged but reinforced)

- Hard-exclude patterns (`wp-config.php`, `.env*`, `db.php`, etc.) apply to **both** upload AND delete. Auth-bearing files are never deleted or rolled back.
- Snapshot creation happens BEFORE any remote mutation (upload or delete), so every push remains reversible.
- Encryption is mandatory and cannot be disabled.

---

## 7. Recommended upgrade procedure

```sh
# 1. Take a manual backup
cp -R .aiftp .aiftp.pre-v0100.bak

# 2. Upgrade
npm install -g aiftp@0.10.0   # or pnpm/yarn equivalent

# 3. Sanity check
aiftp doctor --profile production

# 4. Verify config (deletion_policy is "never" by default)
cat .aiftp.toml
# Optionally: aiftp doctor --profile production
#   - doctor will surface a warning if deletion_policy is set to a non-default value.

# 5. Dry-run a push
aiftp push --profile production --dry-run

# 6. (Optional) Try rollback dry-run against a recent snapshot
aiftp rollback --profile production --to <snapshot-id> --dry-run

# 7. Real push only after verifying steps 3-5
aiftp push --profile production
```

Keep `deletion_policy = "never"` until you are comfortable. Opt in per profile when ready.

---

## 8. Troubleshooting

### "Schema 2 manifest has invalid operation metadata"

A schema 2 manifest was hand-edited or corrupted. Restore from a previous snapshot or recreate the snapshot via a fresh push.

### "Cannot restore added file tombstone"

You called `BackupStore.restoreAll()` against a schema 2 snapshot that includes tombstones. `restoreAll()` does not silently skip tombstones; iterate `manifest.files` and call `restoreFile()` selectively for `modified`/`removed` operations. (Currently `restoreAll()` has no production callers — this surface is reserved for future runtime adapters.)

### MCP rollback rejects with "Deletion rollback refused"

Re-call `aiftp_rollback_confirm` with `acknowledge_deletions: true`. See §5.

### `diff_hash` mismatch on a re-issued confirm

The underlying remote state changed between `prepare` and `confirm`. Re-run `prepare`, review the new plan, then `confirm`.

---

## 9. Where to file issues

- GitHub: <https://github.com/aiftp-tools/aiftp/issues>
- Tag breaking-change concerns with `v0.10.0`.

---

_Last updated: v0.10.0 release preparation._
