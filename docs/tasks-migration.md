# Migrate tasks from Orbit

Use this procedure for an existing fork installation with an Orbit source and native task history. The CLI imports one workspace from a consistent Orbit SQLite snapshot. It does not modify either source database.

## Prepare recovery and an isolated rehearsal

1. Preserve the current executable or immutable image with complete backups of Orbit and Tucano. Include the Orbit application key, attachments, the Tucano vault key, connector credentials, and GitHub App credentials.
2. Close collaborative task editors and make a consistent Orbit SQLite backup. Copy the corresponding `tucano.db` for native-reference verification.
3. Build the candidate with `npm run build`. Use a disposable directory for the import and synthetic or isolated service connections for all rehearsal servers.
4. Identify the existing personal UI token's ID. The import uses its approved projects to establish owner access. It does not need the token secret.

## Import and verify

Run the built CLI against copies. Replace the sample paths and token ID with the installation's values.

```sh
node out/main/tasks.js import-orbit \
  --source /private/orbit-before.sqlite \
  --target /private/tasks.sqlite \
  --host-db /private/tucano-before.sqlite \
  --owner-token-id PERSONAL_UI_TOKEN_ID
node out/main/tasks.js verify-native \
  --database /private/tasks.sqlite \
  --host-db /private/tucano-before.sqlite
```

The receipt lists imported row counts, excluded populated tables, the snapshot fingerprint, and verified native assignments and executions. Inspect each excluded table against the source inventory. Keep the receipt private when it contains installation metadata.

The importer checks source integrity, foreign keys, references, task numbers, project counters, parents, and collaborative projections. Unsupported populated task, attachment, or GitHub tables stop the import. Finish projecting collaborative edits in Orbit before retrying a projection failure. Resolve unsupported data before switching services.

Repeating the same snapshot import is idempotent. A different snapshot cannot replace an initialized target. For the final snapshot, use a new target path. This prevents a later import from overwriting tasks edited in the new module.

Import preserves task UUIDs, identifiers, statuses, assignments, labels, comments, relations, audit records, token hashes and grants, and GitHub mappings. User password hashes are omitted. Orbit-encrypted GitHub keys are omitted because they require separate decryption and resealing with the Tucano vault key.

## Switch the installation

1. Prevent new Orbit writes and webhook deliveries during the final snapshot. Pause Tucano task work and scheduled task consumers for the same window.
2. Back up both live services again. Import the final Orbit snapshot into a fresh task database and verify it against the final native database copy.
3. Compare task counts, UUIDs, project grants, relations, descriptions, GitHub links, assignments, and native execution links with the source. Test both allowed and forbidden projects.
4. Install `tasks.sqlite` in the Tucano data directory with the same owner and private permissions as its other databases.
5. Decrypt the existing GitHub App private key and webhook secret using the Orbit application key. Seal `{appId, privateKey, webhookSecret}` with the Tucano vault and write `tasks-github.sealed` beside `tasks.sqlite`. Do not write keys to logs or source control.
6. Update existing task connectors to the server's `/api/tasks/mcp` endpoint. Preserve each connector ID, token, agent grant, and read-only scope. Update active agent instructions and routine prompts to name the new source.
7. Point the existing GitHub webhook tunnel at the new server. Keep the same public webhook URL and restrict public routing to that exact path. Keep only one authoritative webhook backend active.
8. Start the candidate and verify owner reads and writes, agent reads, forbidden-project rejection, execution links, GitHub redelivery, and persistence after restart with Orbit stopped.
9. Produce and restore a new encrypted backup, including `tasks.sqlite`, `tasks-github.sealed`, `server.key`, connector credentials, and the tunnel's recovery files. Retire the old service's recurring checks only after the replacement backup checks pass.

Keep old volumes and snapshots until the recovery window ends. No import or task operation requires a running Orbit service after the switch.

## Rotate a task token

The administrative CLI issues read-only tokens scoped to approved project IDs. Prepare a private request file with this shape:

```json
{"name":"agent task reader","projectIds":["APPROVED_PROJECT_UUID"],"expiresAt":"2027-01-01T00:00:00.000Z"}
```

Choose a future expiry. Use a new output path.

```sh
node out/main/tasks.js issue-token \
  --database /private/tasks.sqlite \
  --request /private/token-request.json \
  --output /private/token-credential.json
node out/main/tasks.js revoke-token \
  --database /private/tasks.sqlite \
  --id OLD_TOKEN_ID
```

The credential file is created exclusively with mode 0600. The CLI prints its path and token ID, not the token. Update and verify the intended connector before revoking the old token.

## Restore after a failed switch

Stop task writes, webhook delivery, routines, and the candidate before restoring. Restore the matching old executable and complete pre-switch data copies together. Restore the old connector endpoints and webhook destination from the same recovery record. Do not start two live task backends.

Changes made after the recovery snapshot are absent from that snapshot. Export and reconcile any such changes before resuming the old service. Do not run the Orbit importer over the new store to attempt a reverse migration.
