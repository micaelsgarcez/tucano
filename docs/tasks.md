# Task module

**Projects and tasks** uses the task module included in this fork. Task data lives in `tasks.sqlite` beside `tucano.db`. Orbit is an import source, not a running dependency. This release imports an existing workspace; it does not create an initial blank workspace or provide project administration. [Migrate an existing installation](tasks-migration.md) before opening its board.

## Code and data ownership

| File | Responsibility |
| --- | --- |
| `src/tasks/contracts.ts` | Projects, statuses, tasks, comments, principals, and mutation inputs. |
| `src/tasks/store.ts` | Task storage, project authorization, mutations, audit records, and GitHub delivery application. |
| `src/tasks/http.ts` | Bearer-authenticated REST and MCP endpoints, plus the signed GitHub webhook. |
| `src/tasks/github.ts`, `github-api.ts` | Webhook validation and reconciliation with current GitHub state. |
| `src/tasks/import-orbit.ts`, `cli.ts` | Snapshot import, native-reference checks, and token administration. |
| `src/core/tasks.ts` | Owner-only board adapter, agent assignments, and access to native task activity. |
| `src/server/task-module.ts` | Server routes and GitHub credentials opened through the existing vault. |
| `src/renderer/src/components/Tasks.tsx` | Board, task detail, edits, comments, and agent actions. |

`src/tasks` does not import the core, renderer, or shared host types. It uses Node's SQLite implementation and owns its schema version independently. The store records imported task rows and metadata in `task_module_rows` and `task_module_meta`.

Native `task_executions` and `task_activity` remain in `tucano.db`, in the existing schema 39. Their transactions with messages and runs remain in the core. The source, workspace, and task UUID identify an execution. The existing `orbit:assignment:` keys and source UUID remain unchanged so imported tasks retain their agent assignments and execution history.

## Board behavior

The owner can filter projects, search tasks, load more cards, read task details, create tasks, edit supported fields, and add comments. Status columns can group matching names and categories across projects while retaining distinct status IDs. Counts remain partial while another page is available.

Task properties include human assignees, labels, priority, dates, parent task, and visible relations. Imported audit records and collaborative snapshots remain in storage. The board does not present a complete audit viewer or collaborative editor. Markdown images render as alternative text without loading remote images.

The owner access list comes from the projects approved during import. It does not depend on the expiry of the old UI token. Imported external tokens retain their project grants, expiry, revocation, and service-account restrictions. The UI does not grant those tokens write access.

Each executor or reviewer slot identifies a Tucano agent separately from human assignees. Assigning an agent does not start work or grant tools. Starting work is explicit and uses the agent's existing permissions. Reports contain Action, Result, Evidence, and Next step. They remain agent claims, separate from observed execution state. A finished reply does not complete the task.

Updates require the current task version. A stale write returns a conflict instead of overwriting a newer edit. For GitHub-linked tasks, GitHub controls the title, description, and status. Other supported local properties and comments remain editable.

## HTTP and MCP contracts

REST requests use `Authorization: Bearer <token>` under `/api/tasks/v1`. Read tokens cannot mutate tasks. Task and comment bodies are JSON. Requests above 1 MiB are rejected.

| Method and path | Operation |
| --- | --- |
| `GET /projects` | List allowed projects. |
| `GET /projects/:id/statuses`, `/labels`, `/members` | Read project properties. |
| `GET /tasks` | List tasks with `project_id`, `query`, `parent_task_id`, `cursor`, and `limit`. |
| `GET /tasks/:id` | Read a task by UUID or identifier. |
| `POST /tasks` | Create a task with a `TaskCreate` JSON body. |
| `PATCH /tasks/:id` | Apply `{expectedVersion, patch}` using `TaskPatch` fields. |
| `GET /tasks/:id/comments` | Read paginated comments. |
| `POST /tasks/:id/comments` | Add `{body, parentId?}` as the authenticated author. |

Task list limits range from 1 to 100 and default to 50. REST pagination returns `nextCursor`. Task reads outside the principal's projects return 404.

The read-only MCP endpoint is `/api/tasks/mcp`. It retains `list_projects`, `list_tasks`, `get_task`, and `list_task_statuses`, with snake_case arguments and results, including `next_cursor`. It does not expose task mutations or task relations. Tucano connector IDs and agent grants remain the host's responsibility. Task links use the server origin and `/#tasks/<UUID>`.

## GitHub synchronization

The server opens `tasks-github.sealed` with the existing vault key. The sealed JSON contains `appId`, `privateKey`, and `webhookSecret`. Neither key is stored as plaintext in the task database or exposed through task RPCs.

Both `/api/tasks/v1/github/webhook` and the existing `/api/v1/integrations/github/webhook` accept signed deliveries. A public proxy can expose only the existing webhook path while keeping the board, REST, and MCP private.

The handler validates the raw-body HMAC and app identity before querying GitHub. Each event is a notification to read the current installation, repository access, and issue or pull request. The store applies that current state in a transaction. Existing project connections and label mappings control synchronization. This module does not register new installations through a setup UI.

Canonical reads handle delayed events and edits in the same second. Closing an unmerged pull request maps to the cancelled category. Merge maps to completed. An applied delivery is idempotent. An ignored item can be retried after its access returns. Reusing a delivery ID with different bytes is rejected.

Reconciliation has a total eight-second deadline, a queue limit of 32, and a maximum of 20 repository pages. API errors, timeouts, and exceeded bounds return non-success responses without committing partial item state. Operators must inspect failures and request redelivery. The module does not run a background catch-up job.

## Maintenance checks

The tests in `test/tasks-*.test.ts` and `test/tasks-ui.test.tsx` cover authorization, import, mutation conflicts, GitHub reconciliation, native references, and UI behavior. `test/task-activity.test.ts` covers native executions. `scripts/tasks-preview.mjs` starts a real server with invented task data and fake engines for browser checks.

[Maintain this fork](fork-maintenance.md) describes upstream merges and deployment verification. The module boundary reduces the files involved in a merge. It does not guarantee conflict-free upstream updates.
