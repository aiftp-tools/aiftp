# Pull request

## Summary

<!-- 1-3 bullets describing what this PR changes and why. Focus on the
"why" — the diff already shows the "what". -->

-
-
-

## Type of change

<!-- Tick all that apply -->

- [ ] `feat`: new feature
- [ ] `fix`: bug fix
- [ ] `refactor`: code restructuring without behavior change
- [ ] `docs`: documentation only
- [ ] `test`: tests only
- [ ] `chore`: build / tooling / dependencies
- [ ] `perf`: performance improvement
- [ ] `ci`: CI configuration

## Test plan

<!-- How did you verify this works? Include automated and manual steps. -->

- [ ] `pnpm vitest run` passes
- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm biome check packages` clean
- [ ] New tests added for new behavior
- [ ] Manually tested against real FTP server (describe below if applicable)

<!-- Manual test notes (if any) -->

## Safety review

If this PR touches any of the following, please confirm:

- [ ] Credentials handling (Keychain / DPAPI / process env) — passwords never end up in TOML, logs, or MCP responses
- [ ] Backup / restore — backup is taken before any destructive operation; restore is path-traversal-safe
- [ ] MCP `prepare → confirm` gate — `aiftp_push(dry_run=false)` cannot succeed without a fresh valid token
- [ ] Hard-exclude list — `.env`, `wp-config.php`, `*.pem`, `db.php` etc. remain untouched
- [ ] Schema migration — atomic write, idempotent, `.bak` preserved

If none of the above apply, write "N/A".

## Documentation

- [ ] README updated if user-visible behavior changed
- [ ] `docs/spec.md` updated if architectural behavior changed
- [ ] `docs/compatibility-matrix.md` updated if provider behavior changed
- [ ] `CHANGELOG.md` or release notes draft updated

## Related issues

<!-- Closes #N, Refs #N -->

-
