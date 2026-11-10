import { DatabaseSync } from 'node:sqlite'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { TaskStore, TaskError, type SourceRow, type TaskSnapshot } from './store'

const TABLES = [
  'workspaces',
  'users',
  'memberships',
  'projects',
  'task_statuses',
  'labels',
  'label_name_aliases',
  'tasks',
  'task_assignees',
  'task_labels',
  'task_comments',
  'task_relations',
  'task_number_aliases',
  'task_collab_docs',
  'task_collab_updates',
  'audit_events',
  'service_accounts',
  'api_tokens',
  'api_token_projects',
  'github_apps',
  'github_installations',
  'github_installation_repositories',
  'github_project_connections',
  'github_issue_links',
  'github_pull_links',
]
export interface OrbitImportOptions {
  sourcePath: string
  targetPath: string
  sourceId: string
  workspaceId: string
  ownerTokenId: string
}
export interface OrbitImportReport {
  imported: boolean
  fingerprint: string
  counts: Record<string, number>
  excludedTables: Record<string, number>
}
export function importOrbit(options: OrbitImportOptions): OrbitImportReport {
  if (
    resolve(options.sourcePath) === resolve(options.targetPath) ||
    (existsSync(options.targetPath) &&
      realpathSync(options.sourcePath) === realpathSync(options.targetPath))
  )
    throw new TaskError(400, 'Source and target must differ')
  const db = new DatabaseSync(options.sourcePath, { readOnly: true })
  const tables: Record<string, SourceRow[]> = {},
    excludedTables: Record<string, number> = {}
  try {
    db.exec('BEGIN')
    if (
      db
        .prepare('PRAGMA integrity_check')
        .all()
        .some((r) => r.integrity_check !== 'ok')
    )
      throw new TaskError(400, 'Source integrity check failed')
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new TaskError(400, 'Source foreign key check failed')
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => String(r.name))
    for (const name of names) {
      if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw new TaskError(400, 'Unexpected source table')
      const count = Number(db.prepare(`SELECT count(*) AS n FROM "${name}"`).get()!.n)
      if (!TABLES.includes(name)) {
        if (count && /^(task_|attachment_|github_)/.test(name))
          throw new TaskError(400, `Unsupported populated task table: ${name}`)
        if (count) excludedTables[name] = count
        continue
      }
      const rows = db.prepare(`SELECT * FROM "${name}"`)
      rows.setReadBigInts(true)
      tables[name] = rows.all()
        .map((raw) => {
          const row: SourceRow = {}
          for (const [key, value] of Object.entries(raw)) {
            if (name === 'users' && key === 'password_hash') continue
            if (
              name === 'github_apps' &&
              (key === 'private_key_encrypted' || key === 'webhook_secret_encrypted')
            )
              continue
            if (value instanceof Uint8Array)
              row[key] = Buffer.from(value).toString(
                name === 'api_tokens' && key === 'token_hash' ? 'hex' : 'base64',
              )
            else if (typeof value === 'bigint')
              row[key] = value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString()
            else if (value === null || typeof value === 'string' || typeof value === 'number')
              row[key] = value
            else throw new TaskError(400, `Unsupported source value in ${name}.${key}`)
          }
          return row
        })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    }
    if (!tables.workspaces?.some((w) => w.id === options.workspaceId && w.deleted_at == null))
      throw new TaskError(400, 'Workspace missing')
    if (tables.workspaces.some((w) => w.id !== options.workspaceId))
      throw new TaskError(400, 'Multiple workspace import is not supported')
    const has = (table: string, id: string | number | null | undefined): boolean =>
      id != null && (tables[table] ?? []).some((row) => row.id === id)
    for (const [name, rows] of Object.entries(tables))
      for (const row of rows) {
        if (row.workspace_id != null && row.workspace_id !== options.workspaceId)
          throw new TaskError(400, `Foreign workspace in ${name}`)
        if (row.project_id != null && !has('projects', row.project_id))
          throw new TaskError(400, `Missing project in ${name}`)
        if (name.startsWith('task_') && row.task_id != null && !has('tasks', row.task_id))
          throw new TaskError(400, `Missing task in ${name}`)
      }
    for (const relation of tables.task_relations ?? [])
      if (
        !has('tasks', relation.related_task_id) ||
        !['blocks', 'related', 'duplicate'].includes(String(relation.type))
      )
        throw new TaskError(400, 'Invalid task relationship')
    for (const relation of tables.task_labels ?? []) {
      const task = tables.tasks?.find((t) => t.id === relation.task_id)
      const label = tables.labels?.find((l) => l.id === relation.label_id)
      if (!task || !label || task.project_id !== label.project_id)
        throw new TaskError(400, 'Task label project mismatch')
    }
    for (const assignment of tables.task_assignees ?? []) {
      const member = tables.memberships?.find(
        (m) => m.id === assignment.membership_id && m.user_id === assignment.user_id,
      )
      if (!member || !has('users', assignment.user_id))
        throw new TaskError(400, 'Invalid task assignee')
    }
    for (const comment of tables.task_comments ?? []) {
      if (!has('users', comment.author_id)) throw new TaskError(400, 'Invalid comment author')
      if (
        comment.parent_id != null &&
        !tables.task_comments?.some(
          (c) => c.id === comment.parent_id && c.task_id === comment.task_id,
        )
      )
        throw new TaskError(400, 'Invalid comment parent')
    }
    for (const link of tables.github_issue_links ?? [])
      if (!has('tasks', link.task_id)) throw new TaskError(400, 'Missing linked GitHub task')
    const numbers = new Set<string>()
    for (const task of tables.tasks ?? []) {
      if (task.number == null || Number(task.number) <= 0)
        throw new TaskError(400, 'Task number missing')
      const numberKey = `${task.project_id}:${task.number}`
      if (numbers.has(numberKey)) throw new TaskError(400, 'Duplicate task number')
      numbers.add(numberKey)
      const seen = new Set([task.id])
      let parent = task.parent_task_id
      while (parent != null) {
        if (seen.has(parent)) throw new TaskError(400, 'Task parent cycle')
        seen.add(parent)
        const row = tables.tasks?.find((t) => t.id === parent)
        if (!row) throw new TaskError(400, 'Missing task parent')
        parent = row.parent_task_id
      }
      const project = tables.projects?.find((p) => p.id === task.project_id)
      if (!project || Number(project.task_counter) < Number(task.number))
        throw new TaskError(400, 'Task counter is behind task number')
      if (
        !tables.task_statuses?.some(
          (s) => s.id === task.status_id && s.project_id === task.project_id,
        )
      )
        throw new TaskError(400, 'Task status mismatch')
    }
    for (const doc of tables.task_collab_docs ?? []) {
      if (
        Number(doc.projected_seq) !== Number(doc.snapshot_seq) ||
        (tables.task_collab_updates ?? []).some(
          (u) => u.task_id === doc.task_id && Number(u.seq) > Number(doc.projected_seq),
        )
      )
        throw new TaskError(
          409,
          'Collaborative task description is not fully projected; save it in Orbit before import',
        )
    }
    const token = tables.api_tokens?.find(
      (t) => t.id === options.ownerTokenId && t.workspace_id === options.workspaceId,
    )
    if (
      !token ||
      token.revoked_at != null ||
      (token.expires_at != null && Number(token.expires_at) <= Date.now())
    )
      throw new TaskError(400, 'Owner UI token missing or inactive')
    const ownerUser = tables.users?.find(
      (u) => u.id === token.created_by && u.deleted_at == null && u.suspended_at == null,
    )
    if (!ownerUser || token.service_account_id != null
      || !tables.memberships?.some(m => m.user_id === ownerUser.id && m.workspace_id === options.workspaceId)) {
      throw new TaskError(400, 'Owner UI token user inactive')
    }
    if (
      token.service_account_id != null &&
      !tables.service_accounts?.some(
        (a) => a.id === token.service_account_id && a.disabled_at == null,
      )
    )
      throw new TaskError(400, 'Owner UI token service account inactive')
    for (const credential of tables.api_tokens ?? [])
      if (
        typeof credential.token_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(credential.token_hash)
      )
        throw new TaskError(400, 'Invalid token hash')
    const scopes = String(token.scopes ?? '').split(/\s+/)
    if (!scopes.includes('tasks:read') && !scopes.includes('tasks:write'))
      throw new TaskError(400, 'Owner UI token cannot read tasks')
    const projectIds =
      Number(token.all_projects) === 1
        ? (tables.projects ?? [])
            .filter((p) => p.workspace_id === options.workspaceId)
            .map((p) => String(p.id))
        : (tables.api_token_projects ?? [])
            .filter((p) => p.token_id === token.id)
            .map((p) => String(p.project_id))
    const source = { id: options.sourceId, workspaceId: options.workspaceId }
    const owner = {
      id: String(token.created_by),
      workspaceId: options.workspaceId,
      projectIds,
      scopes: ['tasks:read', 'tasks:write'],
      serviceAccountId: null,
      owner: true,
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ source, owner, tables }))
      .digest('hex')
    const snapshot: TaskSnapshot = {
      source,
      owner,
      tables,
      fingerprint,
      ownerTokenId: options.ownerTokenId,
    }
    db.exec('COMMIT')
    const target = new TaskStore(options.targetPath)
    try {
      return {
        ...target.importSnapshot(snapshot),
        fingerprint,
        counts: Object.fromEntries(
          Object.entries(tables).map(([name, rows]) => [name, rows.length]),
        ),
        excludedTables,
      }
    } finally {
      target.close()
    }
  } finally {
    db.close()
  }
}
