import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TaskItem, TaskPatch, TaskPrincipal } from './contracts'
import type { TaskStore } from './store'
import { reconcileGithubDelivery } from './github-api'
import { fail, object, parseGithubDelivery, string, type GithubCredentials } from './github'

export interface TasksHandlerOptions { githubCredentials?: () => GithubCredentials | null; publicOrigin?: string; githubFetch?: typeof fetch }
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 1_048_576) fail(413, 'Payload too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}
function parse(raw: Buffer): Record<string, unknown> { try { return object(JSON.parse(raw.toString('utf8'))) } catch { return fail(400, 'Invalid JSON object') } }
function optionalString(value: unknown): string | undefined { return value == null ? undefined : string(value) }
function limit(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) fail(400, 'limit must be between 1 and 100')
  return value
}
function keys(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'Unknown argument') }
function patch(value: Record<string, unknown>): TaskPatch {
  keys(value, ['title', 'description', 'statusId', 'priority', 'dueAt', 'assigneeIds', 'labelIds', 'parentTaskId'])
  const result: TaskPatch = {}
  for (const key of ['title', 'description', 'statusId'] as const) if (key in value) result[key] = string(value[key])
  for (const key of ['dueAt', 'parentTaskId'] as const) if (key in value) result[key] = value[key] === null ? null : string(value[key])
  for (const key of ['assigneeIds', 'labelIds'] as const) if (key in value) {
    const ids = value[key]; if (!Array.isArray(ids)) fail(400, 'Expected IDs'); result[key] = ids.map(string)
  }
  if ('priority' in value) {
    const priority = value.priority
    if (priority !== 'none' && priority !== 'low' && priority !== 'medium' && priority !== 'high' && priority !== 'urgent') fail(400, 'Invalid priority')
    result.priority = priority
  }
  return result
}
const stringSchema = { type: 'string' }
const paging = { cursor: stringSchema, limit: { type: 'integer', minimum: 1, maximum: 100 } }
const definitions = [
  { name: 'list_projects', description: 'List approved projects.', properties: {}, required: [] },
  { name: 'list_tasks', description: 'List tasks in approved projects.', properties: { project_id: stringSchema, query: stringSchema, parent_task_id: stringSchema, ...paging }, required: [] },
  { name: 'get_task', description: 'Read one task by ID or identifier.', properties: { task_id: stringSchema }, required: ['task_id'] },
  { name: 'list_task_statuses', description: 'List a project’s statuses.', properties: { project_id: stringSchema, ...paging }, required: ['project_id'] }
]
function wire(task: TaskItem, origin: string): unknown {
  return { id: task.id, project_id: task.projectId, number: Number(task.identifier.slice(task.identifier.lastIndexOf('-') + 1)), status_id: task.statusId, title: task.title, description: task.description, priority: task.priority, assignee_ids: task.assigneeIds, label_ids: task.labelIds, due_start_at: task.dueStartAt ?? null, due_at: task.dueAt, created_at: task.createdAt, updated_at: task.updatedAt, version: task.version, parent_task_id: task.parentTaskId, identifier: task.identifier, url: `${origin}/#tasks/${encodeURIComponent(task.id)}` }
}
function callTool(store: TaskStore, who: TaskPrincipal, name: string, args: Record<string, unknown>, origin: string): unknown {
  if (!who.scopes.includes('tasks:read') && !who.scopes.includes('tasks:write')) fail(400, 'Connection lacks the required permission')
  const definition = definitions.find(tool => tool.name === name)
  if (!definition) fail(400, 'Unknown tool')
  keys(args, Object.keys(definition.properties))
  if (name === 'list_projects') return { items: store.projects(who) }
  if (name === 'get_task') return wire(store.get(who, string(args.task_id)), origin)
  if (name === 'list_tasks') {
    const page = store.list(who, { projectId: optionalString(args.project_id), query: optionalString(args.query), parentTaskId: optionalString(args.parent_task_id), cursor: optionalString(args.cursor), limit: limit(args.limit) })
    return { items: page.items.map(task => wire(task, origin)), next_cursor: page.nextCursor }
  }
  const projectId = string(args.project_id)
  const statuses = store.projectData(who, projectId).statuses
  const cursor = optionalString(args.cursor)
  let start = 0
  if (cursor) {
    let decoded: Record<string, unknown>
    try { decoded = object(JSON.parse(Buffer.from(cursor, 'base64url').toString())) } catch { return fail(400, 'Invalid cursor') }
    if (decoded.projectId !== projectId || decoded.principalId !== who.id) fail(400, 'Invalid cursor')
    start = statuses.findIndex(status => status.id === decoded.id) + 1
    if (start === 0) fail(400, 'Invalid cursor')
  }
  const items = statuses.slice(start, start + (limit(args.limit) ?? 50))
  const last = items.at(-1)
  return { items: items.map(s => ({ id: s.id, project_id: s.projectId, name: s.name, color: s.color, category: s.category, position: s.position })), next_cursor: last && start + items.length < statuses.length ? Buffer.from(JSON.stringify({ projectId, principalId: who.id, id: last.id })).toString('base64url') : null }
}
async function mcp(req: IncomingMessage, res: ServerResponse, store: TaskStore, who: TaskPrincipal, origin: string): Promise<void> {
  if (req.method !== 'POST') { json(res, 405, { error: 'Method not allowed' }); return }
  const request = parse(await body(req))
  const id = request.id
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number')) { json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return }
  if (id === undefined) { res.writeHead(202); res.end(); return }
  try {
    let result: unknown
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'tucano-tasks', version: '1.0.0' } }
    else if (request.method === 'ping') result = {}
    else if (request.method === 'tools/list') result = { tools: definitions.filter(() => who.scopes.includes('tasks:read') || who.scopes.includes('tasks:write')).map(({ properties, required, ...tool }) => ({ ...tool, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) }
    else if (request.method === 'tools/call') {
      const params = object(request.params)
      try {
        const value = callTool(store, who, string(params.name), object(params.arguments ?? {}), origin)
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false }
      } catch (error) {
        if (errorStatus(error) === 400) throw error
        result = { content: [{ type: 'text', text: errorStatus(error) < 500 && error instanceof Error ? error.message : 'Internal error' }], isError: true }
      }
    } else { json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return }
    json(res, 200, { jsonrpc: '2.0', id, result })
  } catch { json(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid parameters' } }) }
}
function errorStatus(error: unknown): number { return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500 }
export function createTasksHandler(store: TaskStore, opts: TasksHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => boolean {
  let githubQueue = Promise.resolve()
  let githubPending = 0
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const webhook = url.pathname === '/api/tasks/v1/github/webhook' || url.pathname === '/api/v1/integrations/github/webhook'
    if (!webhook && url.pathname !== '/api/tasks/mcp' && !url.pathname.startsWith('/api/tasks/v1/')) return false
    void (async () => {
      if (webhook) {
        if (req.method !== 'POST') fail(405, 'Method not allowed')
        const credentials = opts.githubCredentials?.() ?? null
        const delivery = parseGithubDelivery(await body(req), req.headers, credentials)
        if (!delivery || !credentials) { json(res, 200, { status: 'ignored' }); return }
        if (githubPending >= 32) fail(503, 'GitHub reconciliation queue full')
        githubPending++
        const signal = AbortSignal.timeout(8_000)
        // Serialize the API read and SQLite write together so older reads cannot commit last.
        const work = githubQueue.then(async () => {
          signal.throwIfAborted()
          const current = await reconcileGithubDelivery(delivery, credentials, opts.githubFetch, signal)
          signal.throwIfAborted()
          return store.applyGithubDelivery(current)
        })
        githubQueue = work.then(() => {}, () => {}).finally(() => { githubPending-- })
        const result = await new Promise<Awaited<typeof work>>((resolve, reject) => {
          const timeout = () => reject(Object.assign(new Error('GitHub reconciliation timed out'), { status: 503 }))
          signal.addEventListener('abort', timeout, { once: true })
          void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', timeout))
        })
        json(res, 200, result); return
      }
      const auth = req.headers.authorization
      if (!auth?.startsWith('Bearer ')) fail(401, 'Bearer token required')
      const who = store.authenticate(auth.slice(7))
      if (url.pathname === '/api/tasks/mcp') { await mcp(req, res, store, who, opts.publicOrigin ?? ''); return }
      let path: string[]
      try { path = url.pathname.slice('/api/tasks/v1/'.length).split('/').map(decodeURIComponent) } catch { fail(400, 'Invalid path encoding') }
      if (req.method === 'GET') {
        if (path[0] === 'projects' && path.length === 1) { json(res, 200, { items: store.projects(who) }); return }
        if (path[0] === 'projects' && path.length === 3) {
          const data = store.projectData(who, string(path[1]))
          if (path[2] === 'statuses' || path[2] === 'labels' || path[2] === 'members') { json(res, 200, { items: data[path[2]] }); return }
        }
        if (path[0] === 'tasks' && path.length === 1) { json(res, 200, store.list(who, { projectId: url.searchParams.get('project_id'), query: url.searchParams.get('query') ?? undefined, parentTaskId: url.searchParams.get('parent_task_id') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined, limit: url.searchParams.has('limit') ? limit(Number(url.searchParams.get('limit'))) : undefined })); return }
        if (path[0] === 'tasks' && path.length === 2) { json(res, 200, store.get(who, string(path[1]))); return }
        if (path[0] === 'tasks' && path.length === 3 && path[2] === 'comments') { json(res, 200, store.comments(who, string(path[1]), url.searchParams.get('cursor') ?? undefined)); return }
      }
      if (req.method === 'POST' && path[0] === 'tasks' && path.length === 1) {
        const input = parse(await body(req)); const { projectId, ...fields } = input
        const values = patch(fields)
        json(res, 201, store.create(who, { ...values, projectId: string(projectId), title: string(values.title) })); return
      }
      if (req.method === 'PATCH' && path[0] === 'tasks' && path.length === 2) {
        const input = parse(await body(req)); keys(input, ['expectedVersion', 'patch'])
        if (typeof input.expectedVersion !== 'number' || !Number.isSafeInteger(input.expectedVersion)) fail(400, 'Expected version required')
        json(res, 200, store.update(who, string(path[1]), input.expectedVersion, patch(object(input.patch)))); return
      }
      if (req.method === 'POST' && path[0] === 'tasks' && path.length === 3 && path[2] === 'comments') {
        const input = parse(await body(req)); keys(input, ['body', 'parentId'])
        json(res, 201, store.addComment(who, { taskId: string(path[1]), body: string(input.body), parentId: optionalString(input.parentId) })); return
      }
      fail(404, 'Not found')
    })().catch(error => { if (!res.headersSent) json(res, errorStatus(error), { error: errorStatus(error) < 500 && error instanceof Error ? error.message : 'Internal error' }); else res.end() })
    return true
  }
}
