# Orbit projects and tasks

The Tucano owner can read one Orbit workspace from **Projects and tasks**. Orbit remains the source for projects, statuses, task descriptions and human assignees. Tucano keeps only the executor and reviewer agent IDs for each task.

## Connect

1. In Orbit, create an API token with `tasks:read` and access to the projects you want to display. This scope also permits reading project statuses and member display names in Orbit v0.2.1.
2. In Tucano, open **Projects and tasks**. Enter the Orbit HTTPS origin (for example, `https://orbit.example.com`), the workspace UUID and the token. Origins with credentials, paths or query parameters are refused. Local development can use HTTP on loopback.
3. Save the connection and select a project. Use **Load more** for additional tasks and **Refresh** to reload live data.

The token belongs to this owner's read connection. It stays in Tucano's encrypted secret store and is not given to agents or other people. Only the owner can use these RPCs, including reads. The source is not part of snapshots, team exports or workspace copies.

To rotate the token, open **Connection** and save the same origin and workspace UUID with the new token. Existing assignments remain. Changing either origin or workspace creates a new source identity so tasks with matching UUIDs cannot inherit unrelated assignments. Responses started before reconfiguration are discarded.

## Assign responsibility

Open a task and choose an active Tucano agent as executor or reviewer. Each role has one slot, identified by source, workspace and task UUID. Choosing again replaces that slot; selecting **Unassigned** clears it. Existing assignments to archived agents are labeled and can be removed or replaced.

Human assignees stay in Orbit. Assigning a Tucano agent does not create an Orbit member, update a task, start execution or grant repository access. **Open conversation** opens the agent's DM without sending a message. No execution status is inferred from unrelated agent activity.

Each assignment first fetches the task by UUID using the current read identity. If the task moves projects, the assignment follows its UUID only while Orbit still allows access. Revoked access and unavailable services produce an error rather than a cached task. Task text and human assignees are not stored locally. Markdown images are displayed as alternative text rather than loaded from remote servers.

## Read limits

Requests refuse redirects and have a 15-second timeout and an 8 MiB response limit. Project/status/member traversal allows up to 20 pages and 30 seconds; hitting a bound is reported as an error. Task pages contain up to 25 items and are loaded explicitly. The adapter uses the Orbit public v1 API as implemented in v0.2.1; other API versions need compatibility verification.
