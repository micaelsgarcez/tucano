# Maintaining this fork

This fork keeps Tucano's server, agents, conversations and tool permissions. Its current additions are named GitHub connections, the read-only ai-memory view and the Orbit task view with local executor/reviewer assignments. ai-memory and Orbit remain separate services and sources of truth.

The initial fork base is upstream v0.2.24 (`35db1c360e5178ee7daf6c8a635a79ae031fcf59`). Keep the upstream remote and license history intact. Deployment credentials, project inventories and private endpoints do not belong in this public repository.

## Update from upstream

1. Fetch upstream releases, then branch from the fork's current main. Merge the chosen release tag in that branch; do not reset the fork to upstream.
2. Review each conflict against both changes. Preserve named connector identities and grants; owner-only external source RPCs; vault storage; response validation; and source/credential removal during workspace copy.
3. Run typecheck, the full test suite and the build. Exercise two GitHub connections, both external views, project authorization failures, credential rotation and agent assignments in a disposable browser environment. Use synthetic data.
4. Open a pull request and wait for review and CI. Record the upstream tag and resulting fork commit.
5. Build a server image from that immutable commit and a verified archive checksum. Preserve the validated image artifact rather than rebuilding differently for production.
6. Back up the existing installation, then rehearse upgrade, restart and restoration of the pre-upgrade copy in isolated volumes. Verify conversations, credentials, grants, assignments and schema compatibility before deploying.

Each external service can be updated independently. Recheck the adapter contract when updating ai-memory or Orbit; do not silently convert an authorization failure into an empty result.

## Server deployment boundary

The initial deployment is headless and uses an operator-managed image. No automatic production merge or upgrade is enabled by these integrations. Preserve the old image and encrypted backup until the candidate is verified. If migration compatibility is uncertain, restore the matching pre-upgrade image and data together; never try an older executable on an unreviewed migrated database.

Desktop distribution is a separate release task. Review updater repository, signing, packaging and release credentials before publishing desktop artifacts, so a desktop update cannot replace this fork with an upstream build.
