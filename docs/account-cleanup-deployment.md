# Account cleanup and friend Realtime deployment

Apply `20260907000914_atomic_account_group_cleanup_and_profile_cascade.sql`
before deploying the account reset/delete API changes. It adds the
service-role-only `cleanup_account_groups(uuid)` RPC and corrects the
`profiles.id` foreign key to `auth.users(id) ON DELETE CASCADE`.
The APIs fail before Storage or account-data deletion if that RPC is unavailable.
Group cleanup checks membership under row locks and deletes parent groups in one
transaction; membership cleanup uses the existing `group_members.group_id`
cascade. Deploy the earlier `20260807133000_atomic_delete_group.sql` first if it
has not already been applied.

The API no longer deletes the profile before calling Auth `admin.deleteUser`.
If Auth deletion fails, its database transaction keeps the user and profile
together, and the same account can retry. Earlier Storage and per-table cleanup
steps remain idempotent, but are separate transactions: an error does not restore
data already removed by those steps. Long-term tasks/subtasks are removed by
their existing Auth foreign-key cascades after a successful hard deletion.

Apply `20260907001518_publish_friend_profile_and_study_session_updates.sql`
to provision the `profiles` and `study_sessions` Realtime publication membership
needed by friend status and study-total refresh. It preserves existing membership
and skips installations without a `supabase_realtime` publication. Validate both
memberships before enabling this flow on a new Supabase project.

Run `scripts/test-supabase-security.ps1` against its isolated local database.
The account cleanup tests cover RPC access, blocked shared groups, multi-group
rollback, retry, profile/Auth rollback, and long-term cascades. The publication
tests cover both friend update streams. Route tests additionally inject a
temporary Auth failure and a cleanup RPC failure.

## Production migration record — 2026-09-07

Both migrations were applied to the active production project `fomopomo`
(`pqfozgiprhizwavfhjgv`, PostgreSQL 17.6) before merging the application changes.
The project was confirmed against the public production site's Supabase host
and the repository's linked project. `.env.local` points to the separate,
inactive `fomopomo-dev` project and was not used to select the rollout target.

| Source migration | Recorded production version |
| --- | --- |
| `20260907000914_atomic_account_group_cleanup_and_profile_cascade.sql` | `20260907093048` |
| `20260907001518_publish_friend_profile_and_study_session_updates.sql` | `20260907093058` |

The migration API assigns the production version at application time. Match the
migration names and this record when checking history; do not replay the legacy
migration chain or reapply an equivalent migration solely because its source
filename has a different timestamp.

Read-only verification confirmed all 52 repository postflight checks, profile
and membership cascades, service-role-only access to the new cleanup RPC, its
empty search path, and both Realtime publication entries. No user cleanup RPC,
account deletion, or Storage mutation was executed to test the rollout.

The hosted security advisor still reports the existing authenticated
`SECURITY DEFINER` RPCs (covered by the exact allowlist), the intentionally
client-inaccessible `debug_logs` table, and disabled leaked-password protection.
The new cleanup RPC is not exposed to browser roles. References:
[RPC advisor](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable),
[password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
