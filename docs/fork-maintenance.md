# Maintaining this fork

This fork keeps Tucano's server, agents, conversations and tool permissions. Its current additions are named GitHub connections, the read-only ai-memory view and the task board with executor/reviewer assignments and task-bound agent reports. ai-memory remains a separate service. The [task module](tasks.md) owns `tasks.sqlite` inside this fork and does not require Orbit at runtime.

The initial fork base is upstream v0.2.24 (`35db1c360e5178ee7daf6c8a635a79ae031fcf59`). Keep the upstream remote and license history intact. Deployment credentials, project inventories and private endpoints do not belong in this public repository.

## Update from upstream

1. Fetch upstream releases, then branch from the fork's current main. Merge the chosen release tag in that branch; do not reset the fork to upstream.
2. Review each conflict against both changes. Preserve named connector identities and grants; owner-only external source RPCs; vault storage; response validation; and source/credential removal during workspace copy.
3. Run typecheck, the full test suite and the build. Exercise two GitHub connections, the knowledge view and task board, project authorization failures, credential rotation, task edits and comments, GitHub reconciliation, and agent assignments in a disposable browser environment. Use synthetic data.
4. Open a pull request and wait for review and CI. Record the upstream tag and resulting fork commit.
5. Build a server image from that immutable commit and a verified archive checksum. Preserve the validated image artifact rather than rebuilding differently for production.
6. Back up the existing installation, then rehearse upgrade, restart and restoration of the pre-upgrade copy in isolated volumes. Verify conversations, credentials, grants, assignments and schema compatibility before deploying.

The ai-memory service can be updated independently. Recheck its adapter contract when updating it. Do not convert an authorization failure into an empty result.

Task changes belong in `src/tasks` unless they need a host capability. The host adapters are `src/core/tasks.ts` and `src/server/task-module.ts`; RPC declarations and the `Tasks.tsx` view connect them to Tucano. Keep execution transactions in the native core. `test/tasks-boundary.test.ts` rejects imports from host modules into the task module.

Preserve the task store schema and its imported source identity separately from native migrations. Exercise the built import CLI against a consistent snapshot and verify native links. Keep the existing `orbit:assignment:` keys until an explicit, tested data migration replaces them. A rename alone would disconnect assignments.

## Database migration history

Fork migration 39 adds `task_executions` and `task_activity`. Once deployed, migration positions are immutable: never replace or renumber this migration when upstream introduces its own migration 39. Reconcile new upstream migrations after the installed fork history, preserving their dependency order. Test the installed fork database through the candidate migration and restart, and test rollback with the untouched pre-upgrade copy and its matching executable. Do not infer compatibility from a clean-database test.

The task module has its own schema in `tasks.sqlite`. Restoring only `tucano.db` does not restore task edits, token state, or GitHub delivery state. Include both databases and the vault key in one consistent recovery set. See [task migration and recovery](tasks-migration.md).

## Server deployment boundary

The initial deployment is headless and uses an operator-managed image. No automatic production merge or upgrade is enabled by these integrations. Preserve the old image and encrypted backup until the candidate is verified. If migration compatibility is uncertain, restore the matching pre-upgrade image and data together; never try an older executable on an unreviewed migrated database.

Desktop distribution is a separate release task. Review updater repository, signing, packaging and release credentials before publishing desktop artifacts, so a desktop update cannot replace this fork with an upstream build.
