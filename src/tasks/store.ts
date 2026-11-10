import { DatabaseSync } from 'node:sqlite'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import type {
  TaskSource,
  TaskPrincipal,
  TaskProject,
  TaskProjectData,
  TaskBoardData,
  TaskItem,
  TaskComment,
  TaskCreate,
  TaskPatch,
  Page,
  TaskStatus,
} from './contracts'
import type { GithubDelivery } from './github'

export type SourceRow = Record<string, string | number | null>
export interface TaskSnapshot {
  source: TaskSource
  owner: TaskPrincipal
  tables: Record<string, SourceRow[]>
  fingerprint: string
  ownerTokenId?: string
}
export class TaskError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
function fail(status: number, message: string): never {
  throw new TaskError(status, message)
}
const str = (row: SourceRow, key: string): string => String(row[key] ?? '')
const date = (value: string | number | null | undefined): string =>
  new Date(Number(value)).toISOString()
const nullableDate = (value: string | number | null | undefined): string | null =>
  value == null ? null : date(value)

export class TaskStore {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
    if (version > 1) {
      this.db.close()
      fail(409, 'Task database requires a newer application')
    }
    const foreignTables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'task_module_%' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
    if (foreignTables.length) {
      this.db.close()
      fail(409, 'Not a task module database')
    }
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;')
    this.transaction(() => {
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS task_module_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS task_module_rows(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=1;',
      )
      if (!this.meta<string>('cursorKey'))
        this.setMeta('cursorKey', randomBytes(32).toString('hex'))
    })
  }
  close(): void {
    this.db.close()
  }
  private meta<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM task_module_meta WHERE key=?').get(key)
    return row ? (JSON.parse(String(row.value)) as T) : null
  }
  private setMeta(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO task_module_meta VALUES (?,?)')
      .run(key, JSON.stringify(value))
  }
  private rows(kind: string): SourceRow[] {
    return this.db
      .prepare('SELECT data FROM task_module_rows WHERE kind=? ORDER BY id')
      .all(kind)
      .map((row) => JSON.parse(String(row.data)) as SourceRow)
  }
  private put(kind: string, row: SourceRow, id = str(row, 'id')): void {
    this.db
      .prepare('INSERT OR REPLACE INTO task_module_rows VALUES (?,?,?)')
      .run(kind, id, JSON.stringify(row))
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  importSnapshot(snapshot: TaskSnapshot): { imported: boolean } {
    return this.transaction(() => {
      const existing = this.meta<string>('fingerprint')
      if (existing) {
        if (existing !== snapshot.fingerprint) fail(409, 'Target contains another snapshot')
        return { imported: false }
      }
      if (this.db.prepare('SELECT 1 FROM task_module_rows LIMIT 1').get())
        fail(409, 'Target is not empty')
      for (const [kind, rows] of Object.entries(snapshot.tables))
        rows.forEach((row, index) =>
          this.put(
            kind,
            row,
            str(row, 'id') ||
              (kind === 'github_issue_links'
                ? `${row.workspace_id}:${str(row, 'repository').toLowerCase()}:${row.issue_number}`
                : String(index)),
          ),
        )
      if (snapshot.ownerTokenId) this.setMeta('ownerTokenId', snapshot.ownerTokenId)
      this.setMeta('source', snapshot.source)
      this.setMeta('owner', snapshot.owner)
      this.setMeta('fingerprint', snapshot.fingerprint)
      return { imported: true }
    })
  }
  source(): TaskSource | null {
    return this.meta<TaskSource>('source')
  }
  ownerPrincipal(): TaskPrincipal {
    const owner = this.meta<TaskPrincipal>('owner') ?? fail(404, 'Tasks are not configured')
    return owner
  }
  issueToken(
    who: TaskPrincipal,
    input: {
      name: string
      projectIds: string[]
      scopes: ('tasks:read' | 'tasks:write')[]
      expiresAt?: string | null
    },
  ): { id: string; token: string } {
    return this.transaction(() => {
      this.authorize(who, undefined, true)
      if (!who.owner) fail(403, 'Owner required')
      if (
        !input.name.trim() ||
        !input.projectIds.length ||
        !input.scopes.length ||
        input.scopes.some((s) => !['tasks:read', 'tasks:write'].includes(s))
      )
        fail(400, 'Invalid token grant')
      for (const projectId of input.projectIds) this.authorize(who, projectId)
      const expires = input.expiresAt == null ? null : Date.parse(input.expiresAt)
      if (expires !== null && (!Number.isFinite(expires) || expires <= Date.now()))
        fail(400, 'Invalid expiry')
      const token = `tucano_tasks_${randomBytes(32).toString('base64url')}`,
        id = randomUUID()
      this.put('api_tokens', {
        id,
        workspace_id: who.workspaceId,
        name: input.name,
        created_by: who.id,
        created_at: Date.now(),
        token_hash: createHash('sha256').update(token).digest('hex'),
        token_prefix: token.slice(0, 20),
        scopes: [...new Set(input.scopes)].join(' '),
        all_projects: 0,
        revoked_at: null,
        expires_at: expires,
      })
      for (const projectId of new Set(input.projectIds))
        this.put(
          'api_token_projects',
          { token_id: id, project_id: projectId },
          `${id}:${projectId}`,
        )
      return { id, token }
    })
  }
  revokeToken(who: TaskPrincipal, id: string): void {
    this.transaction(() => {
      this.authorize(who, undefined, true)
      if (!who.owner) fail(403, 'Owner required')
      const row = this.rows('api_tokens').find(
        (t) => t.id === id && t.workspace_id === who.workspaceId,
      )
      if (!row) fail(404, 'Token not found')
      this.put('api_tokens', { ...row, revoked_at: Date.now() })
    })
  }
  private cursor(id: string, scope: string): string {
    const data = Buffer.from(JSON.stringify({ id, scope })).toString('base64url')
    return `${data}.${createHmac('sha256', this.meta<string>('cursorKey')!).update(data).digest('hex')}`
  }
  private cursorId(cursor: string, scope: string): string {
    const [data, signature] = cursor.split('.')
    if (
      !data ||
      !signature ||
      createHmac('sha256', this.meta<string>('cursorKey')!).update(data).digest('hex') !== signature
    )
      fail(400, 'Invalid cursor')
    let value: unknown
    try {
      value = JSON.parse(Buffer.from(data, 'base64url').toString())
    } catch {
      fail(400, 'Invalid cursor')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !('scope' in value) ||
      value.scope !== scope
    )
      fail(400, 'Invalid cursor')
    return value.id
  }
  private activeToken(row: SourceRow | undefined): void {
    if (
      !row ||
      row.revoked_at != null ||
      (row.expires_at != null && Number(row.expires_at) <= Date.now())
    )
      fail(401, 'Invalid token')
    if (row.service_account_id != null) {
      const account = this.rows('service_accounts').find((s) => s.id === row.service_account_id && s.workspace_id === row.workspace_id)
      if (!account || account.disabled_at != null) fail(401, 'Disabled service account')
      return
    }
    const user = this.rows('users').find((u) => u.id === row.created_by)
    if (!user || user.deleted_at != null || user.suspended_at != null
      || !this.rows('memberships').some((m) => m.user_id === row.created_by && m.workspace_id === row.workspace_id)) {
      fail(401, 'Inactive token owner')
    }
  }

  private tokenProjects(row: SourceRow): string[] {
    const ids =
      Number(row.all_projects) === 1
        ? this.rows('projects')
            .filter((p) => p.workspace_id === row.workspace_id)
            .map((p) => str(p, 'id'))
        : this.rows('api_token_projects')
            .filter((p) => p.token_id === row.id)
            .map((p) => str(p, 'project_id'))
    return ids
  }
  authenticate(token: string): TaskPrincipal {
    const hash = createHash('sha256').update(token).digest('hex')
    const row = this.rows('api_tokens').find((row) => row.token_hash === hash)
    this.activeToken(row)
    if (!row) fail(401, 'Invalid token')
    const projects = this.tokenProjects(row)
    const actor = row.service_account_id == null ? str(row, 'created_by')
      : str(this.rows('memberships').find((m) => m.workspace_id === row.workspace_id && m.role === 'owner') ?? {}, 'user_id')
    if (!actor) fail(401, 'Workspace owner missing')
    return {
      id: actor,
      workspaceId: str(row, 'workspace_id'),
      projectIds: projects,
      scopes: str(row, 'scopes').split(/\s+/).filter(Boolean),
      serviceAccountId: row.service_account_id == null ? null : str(row, 'service_account_id'),
      owner: false,
      tokenId: str(row, 'id'),
    }
  }
  private authorize(who: TaskPrincipal, projectId?: string, write = false): void {
    if (who.tokenId) {
      const token = this.rows('api_tokens').find((t) => t.id === who.tokenId)
      this.activeToken(token)
      if (!token) fail(401, 'Invalid token')
      if (projectId && !this.tokenProjects(token).includes(projectId)) fail(403, 'Project denied')
      if (!who.owner) {
        const scopes = str(token, 'scopes').split(/\s+/)
        if (!scopes.includes('tasks:write') && (write || !scopes.includes('tasks:read')))
          fail(403, 'Scope denied')
      }
    }
    if (who.workspaceId !== this.source()?.workspaceId) fail(403, 'Workspace denied')
    if (!who.scopes.includes('tasks:write') && (write || !who.scopes.includes('tasks:read')))
      fail(403, 'Scope denied')
    if (projectId && !who.projectIds.includes(projectId)) fail(403, 'Project denied')
    if (
      projectId &&
      !this.rows('projects').some(
        (p) => p.id === projectId && p.workspace_id === who.workspaceId && p.deleted_at == null,
      )
    )
      fail(404, 'Project not found')
  }
  projects(who: TaskPrincipal): TaskProject[] {
    this.authorize(who)
    return this.rows('projects')
      .filter(
        (p) =>
          p.workspace_id === who.workspaceId &&
          p.deleted_at == null &&
          who.projectIds.includes(str(p, 'id')),
      )
      .map((p) => ({
        id: str(p, 'id'),
        name: str(p, 'name'),
        key: str(p, 'project_key'),
        color: str(p, 'color'),
      }))
  }
  projectData(who: TaskPrincipal, projectId: string): TaskProjectData {
    this.authorize(who, projectId)
    return {
      statuses: this.rows('task_statuses')
        .filter((s) => s.project_id === projectId)
        .map((s) => ({
          id: str(s, 'id'),
          projectId,
          name: str(s, 'name'),
          color: str(s, 'color'),
          category: str(s, 'category') as TaskStatus['category'],
          position: Number(s.position),
        }))
        .sort((a, b) => a.position - b.position),
      labels: this.rows('labels')
        .filter((l) => l.project_id === projectId)
        .map((l) => ({
          id: str(l, 'id'),
          projectId,
          name: str(l, 'name'),
          color: str(l, 'color'),
        })),
      members: this.rows('memberships')
        .filter((m) => m.workspace_id === who.workspaceId)
        .flatMap((m) => {
          const u = this.rows('users').find(
            (u) => u.id === m.user_id && u.deleted_at == null && u.suspended_at == null,
          )
          return u ? [{ id: str(u, 'id'), name: str(u, 'display_name') }] : []
        }),
    }
  }
  board(who: TaskPrincipal): TaskBoardData {
    const projects = this.projects(who)
    const data = projects.map((p) => this.projectData(who, p.id))
    return {
      projects,
      statuses: data.flatMap((d) => d.statuses),
      labels: data.flatMap((d) => d.labels),
      members: data[0]?.members ?? [],
    }
  }
  private taskViews(who: TaskPrincipal): Map<string, TaskItem> {
    const projects = new Map(this.projects(who).map(project => [project.id, project]))
    const assignees = new Map<string, string[]>()
    const labels = new Map<string, string[]>()
    for (const [kind, field, grouped] of [
      ['task_assignees', 'user_id', assignees],
      ['task_labels', 'label_id', labels],
    ] as const) {
      for (const row of this.rows(kind)) {
        const id = str(row, 'task_id')
        const values = grouped.get(id) ?? []
        values.push(str(row, field))
        grouped.set(id, values)
      }
    }
    const items = new Map<string, TaskItem>()
    for (const row of this.rows('tasks')) {
      const project = projects.get(str(row, 'project_id'))
      if (row.deleted_at != null || !project) continue
      const id = str(row, 'id')
      items.set(id, {
        id, projectId: project.id, statusId: str(row, 'status_id'),
        identifier: `${project.key}-${row.number}`, title: str(row, 'title'),
        description: str(row, 'description'), assigneeIds: assignees.get(id) ?? [],
        labelIds: labels.get(id) ?? [], priority: str(row, 'priority') as TaskItem['priority'],
        dueAt: nullableDate(row.due_at), dueStartAt: nullableDate(row.due_start_at),
        createdAt: date(row.created_at), updatedAt: date(row.updated_at), version: Number(row.version),
        sourceUrl: row.source_url == null ? null : str(row, 'source_url'),
        parentTaskId: row.parent_task_id == null ? null : str(row, 'parent_task_id'), relations: [],
      })
    }
    for (const item of items.values()) {
      if (item.parentTaskId && !items.has(item.parentTaskId)) item.parentTaskId = null
    }
    for (const row of this.rows('task_relations')) {
      const from = items.get(str(row, 'task_id'))
      const to = items.get(str(row, 'related_task_id'))
      const type = str(row, 'type')
      if (!from || !to || (type !== 'blocks' && type !== 'related' && type !== 'duplicate')) continue
      from.relations!.push({ type, taskId: to.id, identifier: to.identifier, direction: 'outgoing' })
      to.relations!.push({ type, taskId: from.id, identifier: from.identifier, direction: 'incoming' })
    }
    return items
  }
  get(who: TaskPrincipal, id: string): TaskItem {
    const items = this.taskViews(who)
    return items.get(id) ?? [...items.values()].find(task => task.identifier === id) ?? fail(404, 'Task not found')
  }
  list(
    who: TaskPrincipal,
    options: {
      projectId?: string | null
      cursor?: string
      limit?: number
      query?: string
      parentTaskId?: string
    } = {},
  ): Page<TaskItem> {
    this.authorize(who, options.projectId ?? undefined)
    if (options.parentTaskId)
      options = { ...options, parentTaskId: this.get(who, options.parentTaskId).id }
    const cursorScope = JSON.stringify({
      who: who.tokenId ?? who.id,
      projects: this.projects(who)
        .map((p) => p.id)
        .sort(),
      projectId: options.projectId ?? null,
      query: options.query ?? null,
      parent: options.parentTaskId ?? null,
    })
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'Invalid limit')
    let items = [...this.taskViews(who).values()]
      .filter(
        (t) =>
          (!options.projectId || t.projectId === options.projectId) &&
          (!options.parentTaskId || t.parentTaskId === options.parentTaskId) &&
          (!options.query ||
            `${t.title} ${t.description} ${t.identifier}`
              .toLowerCase()
              .includes(options.query.toLowerCase())),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    if (options.cursor) {
      const cursorId = this.cursorId(options.cursor, cursorScope)
      const index = items.findIndex((t) => t.id === cursorId)
      if (index < 0) fail(400, 'Invalid cursor')
      items = items.slice(index + 1)
    }
    return {
      items: items.slice(0, limit),
      nextCursor: items.length > limit ? this.cursor(items[limit - 1]!.id, cursorScope) : null,
    }
  }
  private validate(who: TaskPrincipal, projectId: string, patch: TaskPatch): void {
    this.authorize(who, projectId, true)
    if (
      Object.keys(patch).some(
        (key) =>
          ![
            'projectId',
            'title',
            'description',
            'statusId',
            'priority',
            'dueAt',
            'assigneeIds',
            'labelIds',
            'parentTaskId',
          ].includes(key),
      )
    )
      fail(400, 'Unknown task field')
    if (
      patch.title !== undefined &&
      (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 500)
    )
      fail(400, 'Invalid title')
    if (
      patch.description !== undefined &&
      (typeof patch.description !== 'string' || patch.description.length > 1000000)
    )
      fail(400, 'Invalid description')
    if (
      patch.priority !== undefined &&
      !['none', 'low', 'medium', 'high', 'urgent'].includes(patch.priority)
    )
      fail(400, 'Invalid priority')
    if (
      patch.dueAt !== undefined &&
      patch.dueAt !== null &&
      !Number.isFinite(Date.parse(patch.dueAt))
    )
      fail(400, 'Invalid due date')
    const data = this.projectData(who, projectId)
    if (patch.statusId !== undefined && !data.statuses.some((s) => s.id === patch.statusId))
      fail(400, 'Invalid status')
    if (
      patch.labelIds !== undefined &&
      (!Array.isArray(patch.labelIds) ||
        patch.labelIds.some((id) => !data.labels.some((l) => l.id === id)))
    )
      fail(400, 'Invalid labels')
    if (
      patch.assigneeIds !== undefined &&
      (!Array.isArray(patch.assigneeIds) ||
        patch.assigneeIds.some((id) => !data.members.some((m) => m.id === id)))
    )
      fail(400, 'Invalid assignees')
    if (patch.parentTaskId != null) {
      const parent = this.get(who, patch.parentTaskId)
      if (parent.id !== patch.parentTaskId || parent.projectId !== projectId) fail(400, 'Invalid parent')
    }
  }
  private associations(taskId: string, patch: TaskPatch): void {
    for (const [kind, key, values] of [
      ['task_assignees', 'user_id', patch.assigneeIds],
      ['task_labels', 'label_id', patch.labelIds],
    ] as const) {
      if (values === undefined) continue
      this.db
        .prepare("DELETE FROM task_module_rows WHERE kind=? AND json_extract(data,'$.task_id')=?")
        .run(kind, taskId)
      for (const value of new Set(values)) {
        const member = this.rows('memberships').find((m) => m.user_id === value)
        this.put(
          kind,
          {
            task_id: taskId,
            [key]: value,
            ...(kind === 'task_assignees' ? { membership_id: str(member ?? {}, 'id') } : {}),
          },
          `${taskId}:${value}`,
        )
      }
    }
  }
  private audit(who: TaskPrincipal, taskId: string, action: string): void {
    const id = randomUUID()
    this.put('audit_events', {
      id,
      workspace_id: who.workspaceId,
      actor_id: who.id,
      action,
      outcome: 'success',
      resource_type: 'task',
      resource_id: taskId,
      request_id: id,
      metadata_json: JSON.stringify({ service_account_id: who.serviceAccountId }),
      occurred_at: Date.now(),
    })
  }
  create(who: TaskPrincipal, input: TaskCreate): TaskItem {
    return this.transaction(() => {
      if (typeof input.title !== 'string') fail(400, 'Invalid title')
      this.validate(who, input.projectId, input)
      const project = this.rows('projects').find((p) => p.id === input.projectId)!
      const status =
        input.statusId ??
        this.projectData(who, input.projectId).statuses.find((s) => s.category === 'unstarted')?.id
      if (!status) fail(400, 'Project has no initial status')
      const id = randomUUID(),
        now = Date.now(),
        number = Number(project.task_counter ?? 0) + 1
      this.put('projects', { ...project, task_counter: number })
      this.put('tasks', {
        id,
        workspace_id: who.workspaceId,
        project_id: input.projectId,
        status_id: status,
        title: input.title,
        description: input.description ?? '',
        priority: input.priority ?? 'none',
        creator_id: who.id,
        creator_service_account_id: who.serviceAccountId,
        version: 0,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        due_at: input.dueAt ? Date.parse(input.dueAt) : null,
        parent_task_id: input.parentTaskId ?? null,
        source_url: null,
        number,
      })
      this.associations(id, input)
      this.audit(who, id, 'task.create')
      return this.get(who, id)
    })
  }
  update(who: TaskPrincipal, id: string, expectedVersion: number, patch: TaskPatch): TaskItem {
    return this.transaction(() => {
      if ('projectId' in patch) fail(400, 'Cannot change project')
      const task = this.get(who, id)
      this.validate(who, task.projectId, patch)
      if (!Number.isInteger(expectedVersion) || task.version !== expectedVersion)
        fail(409, 'Task changed; reload before saving')
      if (
        this.rows('github_issue_links').some((l) => l.task_id === task.id) &&
        (patch.title !== undefined ||
          patch.description !== undefined ||
          patch.statusId !== undefined)
      )
        fail(409, 'GitHub owns title, description and status')
      let parent = patch.parentTaskId
      const seen = new Set([task.id])
      while (parent) {
        if (seen.has(parent)) fail(400, 'Parent cycle')
        seen.add(parent)
        parent = this.get(who, parent).parentTaskId
      }
      const row = this.rows('tasks').find((t) => t.id === task.id)!
      for (const [key, column] of [
        ['title', 'title'],
        ['description', 'description'],
        ['statusId', 'status_id'],
        ['priority', 'priority'],
        ['parentTaskId', 'parent_task_id'],
      ] as const) {
        if (patch[key] !== undefined) row[column] = patch[key] ?? null
      }
      if (patch.dueAt !== undefined)
        row.due_at = patch.dueAt === null ? null : Date.parse(patch.dueAt)
      row.version = task.version + 1
      row.updated_at = Date.now()
      this.put('tasks', row)
      this.associations(task.id, patch)
      this.audit(who, task.id, 'task.update')
      return this.get(who, task.id)
    })
  }
  comments(who: TaskPrincipal, taskId: string, cursor?: string): Page<TaskComment> {
    const task = this.get(who, taskId)
    let rows = this.rows('task_comments')
      .filter((c) => c.task_id === task.id)
      .sort(
        (a, b) =>
          Number(a.created_at) - Number(b.created_at) || str(a, 'id').localeCompare(str(b, 'id')),
      )
    if (cursor) {
      const cursorId = this.cursorId(cursor, `${who.tokenId ?? who.id}:${task.id}`)
      const i = rows.findIndex((c) => c.id === cursorId)
      if (i < 0) fail(400, 'Invalid cursor')
      rows = rows.slice(i + 1)
    }
    return {
      items: rows.slice(0, 50).map((c) => {
        const s = this.rows('service_accounts').find((s) => s.id === c.author_service_account_id)
        return {
          id: str(c, 'id'),
          taskId: task.id,
          authorId: str(c, 'author_id'),
          serviceAccount: s ? { id: str(s, 'id'), name: str(s, 'name') } : null,
          body: str(c, 'body'),
          parentId: c.parent_id == null ? null : str(c, 'parent_id'),
          createdAt: date(c.created_at),
          updatedAt: date(c.updated_at),
        }
      }),
      nextCursor:
        rows.length > 50
          ? this.cursor(str(rows[49]!, 'id'), `${who.tokenId ?? who.id}:${task.id}`)
          : null,
    }
  }
  addComment(
    who: TaskPrincipal,
    input: { taskId: string; body: string; parentId?: string | null; authorId?: string },
  ): TaskComment {
    return this.transaction(() => {
      const task = this.get(who, input.taskId)
      this.authorize(who, task.projectId, true)
      if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 100000)
        fail(400, 'Invalid comment')
      if (input.authorId && input.authorId !== who.id) fail(403, 'Author denied')
      if (
        input.parentId &&
        !this.rows('task_comments').some((c) => c.id === input.parentId && c.task_id === task.id)
      )
        fail(400, 'Invalid parent comment')
      const id = randomUUID(),
        now = Date.now()
      this.put('task_comments', {
        id,
        workspace_id: who.workspaceId,
        task_id: task.id,
        author_id: who.id,
        author_service_account_id: who.serviceAccountId,
        parent_id: input.parentId ?? null,
        body: input.body,
        created_at: now,
        updated_at: now,
        version: 0,
      })
      this.audit(who, task.id, 'comment.create')
      return {
        id,
        taskId: task.id,
        authorId: who.id,
        serviceAccount: who.serviceAccountId
          ? {
              id: who.serviceAccountId,
              name: str(
                this.rows('service_accounts').find((s) => s.id === who.serviceAccountId) ?? {},
                'name',
              ),
            }
          : null,
        body: input.body,
        parentId: input.parentId ?? null,
        createdAt: date(now),
        updatedAt: date(now),
      }
    })
  }
  applyGithubDelivery(delivery: GithubDelivery): { status: 'applied' | 'ignored' | 'duplicate' } {
    return this.transaction(() => {
      const prior = this.meta<string>(`github:delivery:${delivery.deliveryId}`)
      if (prior) {
        if (prior !== delivery.digest) fail(409, 'Delivery ID reused with different content')
        if (this.meta<boolean>(`github:applied:${delivery.deliveryId}`)) return { status: 'duplicate' }
      }
      this.setMeta(`github:delivery:${delivery.deliveryId}`, delivery.digest)
      const applied = (): { status: 'applied' } => {
        this.setMeta(`github:applied:${delivery.deliveryId}`, true)
        return { status: 'applied' }
      }
      const source = this.source()
      const app = this.rows('github_apps').find(
        (a) => a.workspace_id === source?.workspaceId && String(a.app_id) === delivery.appId,
      )
      const installation = this.rows('github_installations').find(
        (i) =>
          String(i.installation_id) === delivery.installationId &&
          i.workspace_id === source?.workspaceId,
      )
      if (!app || !installation) return { status: 'ignored' }
      const installKey = `github:installation:${delivery.installationId}`
      const setRepository = (name: string, accessible: boolean): void => {
        const repository = name.toLowerCase()
        this.setMeta(`github:removed:${delivery.installationId}:${repository}`, !accessible)
        if (accessible && !this.rows('github_installation_repositories').some(
          row => String(row.installation_id) === delivery.installationId && str(row, 'repository').toLowerCase() === repository,
        )) {
          this.put('github_installation_repositories', { installation_id: delivery.installationId, repository: name }, `${delivery.installationId}:${repository}`)
        }
      }
      if (delivery.kind === 'access') {
        if (!delivery.authoritative) fail(400, 'Verified GitHub access required')
        this.setMeta(installKey, delivery.installationState === 'active' ? null : delivery.installationState)
        for (const repository of delivery.repositories) setRepository(repository.repositoryFullName, repository.accessible)
        return delivery.retryable ? { status: 'ignored' } : applied()
      }
      if (delivery.kind === 'item' && delivery.authoritative) {
        this.setMeta(installKey, null)
        setRepository(delivery.repositoryFullName, true)
      }
      if (delivery.kind === 'installation') {
        if (delivery.action === 'deleted' || delivery.action === 'suspend') {
          this.setMeta(installKey, delivery.action)
          return applied()
        }
        return { status: 'ignored' }
      }
      if (this.meta<string>(installKey)) return { status: 'ignored' }
      if (delivery.kind === 'repositories') {
        if (delivery.action === 'removed') {
          for (const name of delivery.repositoryFullNames)
            this.setMeta(`github:removed:${delivery.installationId}:${name.toLowerCase()}`, true)
          return applied()
        }
        return { status: 'ignored' }
      }
      const repository = delivery.repositoryFullName.toLowerCase()
      if (this.meta<boolean>(`github:removed:${delivery.installationId}:${repository}`))
        return { status: 'ignored' }
      if (
        !this.rows('github_installation_repositories').some(
          (r) =>
            String(r.installation_id) === delivery.installationId &&
            str(r, 'repository').toLowerCase() === repository,
        )
      )
        return { status: 'ignored' }
      const existingLink = this.rows('github_issue_links').find(
        (l) =>
          l.workspace_id === source?.workspaceId &&
          str(l, 'repository').toLowerCase() === repository &&
          Number(l.issue_number) === delivery.number,
      )
      const linkedTask = existingLink
        ? this.rows('tasks').find((t) => t.id === existingLink.task_id)
        : undefined
      const connections = this.rows('github_project_connections').filter(
        (c) =>
          c.workspace_id === source?.workspaceId &&
          String(c.installation_id) === delivery.installationId &&
          str(c, 'repository').toLowerCase() === repository &&
          this.rows('projects').some((p) => p.id === c.project_id && p.deleted_at == null),
      )
      const matching = connections.filter((c) =>
        linkedTask
          ? c.project_id === linkedTask.project_id
          : delivery.labels.includes(str(c, 'label')),
      )
      if (matching.length > 1) fail(409, 'Ambiguous GitHub project labels')
      const connection = matching[0]
      if (!connection) return { status: 'ignored' }
      const key = `github:item:${repository}:${delivery.number}`
      const previous = this.meta<{ updatedAt: string; repositoryId: string; itemId: string }>(key)
      if (
        previous &&
        (previous.repositoryId !== delivery.repositoryId || previous.itemId !== delivery.itemId)
      )
        fail(409, 'GitHub item identity changed')
      if (previous && (Date.parse(previous.updatedAt) > Date.parse(delivery.updatedAt)
        || (previous.updatedAt === delivery.updatedAt && !delivery.authoritative)))
        return { status: 'ignored' }
      this.setMeta(key, {
        updatedAt: delivery.updatedAt,
        repositoryId: delivery.repositoryId,
        itemId: delivery.itemId,
      })
      let link = this.rows('github_issue_links').find(
        (l) =>
          l.workspace_id === source?.workspaceId &&
          str(l, 'repository').toLowerCase() === repository &&
          Number(l.issue_number) === delivery.number,
      )
      const matches = delivery.labels.includes(str(connection, 'label'))
      if (!matches) {
        if (link) {
          link.sync_paused = 1
          this.put(
            'github_issue_links',
            link,
            `${source!.workspaceId}:${repository}:${delivery.number}`,
          )
        }
        return { status: 'ignored' }
      }
      const projectId = str(connection, 'project_id')
      const status = this.rows('task_statuses')
        .filter((s) => s.project_id === projectId)
        .sort((a, b) => Number(a.position) - Number(b.position))
        .find((s) => s.category === (delivery.state === 'open' ? 'unstarted'
          : delivery.itemType === 'pull_request' && !delivery.merged ? 'cancelled' : 'completed'))
      if (!status) fail(409, 'GitHub project status missing')
      let row = link ? this.rows('tasks').find((t) => t.id === link!.task_id) : undefined
      if (link && (!row || row.deleted_at != null)) return { status: 'ignored' }
      if (!row) {
        const project = this.rows('projects').find((p) => p.id === projectId)!
        const owner = this.ownerPrincipal(),
          number = Number(project.task_counter ?? 0) + 1,
          now = Date.now()
        row = {
          id: randomUUID(),
          workspace_id: source!.workspaceId,
          project_id: projectId,
          status_id: str(status, 'id'),
          title: delivery.title,
          description: delivery.body,
          priority: 'none',
          creator_id: owner.id,
          creator_service_account_id: null,
          version: 0,
          deleted_at: null,
          created_at: now,
          updated_at: now,
          due_at: null,
          parent_task_id: null,
          source_url: delivery.url,
          number,
        }
        this.put('projects', { ...project, task_counter: number })
      } else {
        row = {
          ...row,
          title: delivery.title,
          description: delivery.body,
          status_id: str(status, 'id'),
          source_url: delivery.url,
          version: Number(row.version) + 1,
          updated_at: Date.now(),
        }
      }
      this.put('tasks', row)
      link = {
        ...(link ?? {}),
        workspace_id: source!.workspaceId,
        repository: delivery.repositoryFullName,
        issue_number: delivery.number,
        task_id: str(row, 'id'),
        sync_paused: 0,
        kind: delivery.itemType,
        pull_state: delivery.merged ? 'merged' : delivery.state,
      }
      this.put(
        'github_issue_links',
        link,
        `${source!.workspaceId}:${repository}:${delivery.number}`,
      )
      this.audit(this.ownerPrincipal(), str(row, 'id'), 'github.sync')
      return applied()
    })
  }
}
