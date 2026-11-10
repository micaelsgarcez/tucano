import { People } from './people'
import type { Agent, Person } from '../shared/types'
import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import type { Secrets } from './secrets'
import { L } from '../shared/lang'
import type { OrbitAgentRole, OrbitAssignments, OrbitMember, OrbitProject, OrbitProjectData, OrbitSource, OrbitStatus, OrbitTask, OrbitTaskDetail, OrbitTaskPage, OrbitBoardData, OrbitComment, OrbitCommentPage, OrbitActivityPage, OrbitStartInput, OrbitExecution } from '../shared/orbit'

type StoredSource = OrbitSource & { revision: string }
type Page<T> = { items: T[]; nextCursor: string | null }
const SOURCE_KEY = 'orbit:source'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const invalid = (): Error => new Error(L('Resposta inválida do Orbit.', 'Invalid response from Orbit.'))
const changed = (): Error => new Error(L('A conexão Orbit mudou. Atualize a página.', 'The Orbit connection changed. Refresh the page.'))

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid()
  return value
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw invalid()
  return value
}
function uuid(value: unknown): string {
  const id = string(value)
  if (!uuidPattern.test(id)) throw new Error(L('Identificador Orbit inválido.', 'Invalid Orbit identifier.'))
  return id.toLowerCase()
}
function cursor(value: unknown): string | null {
  if (value === null) return null
  const text = string(value)
  if (!text || text.length > 4096) throw invalid()
  return text
}
function page<T>(value: unknown, parse: (value: unknown) => T): Page<T> {
  const data = record(value)
  if (!Array.isArray(data.items)) throw invalid()
  return { items: data.items.map(parse), nextCursor: cursor(data.next_cursor) }
}
function project(value: unknown): OrbitProject {
  const data = record(value)
  return { id: uuid(data.id), name: string(data.name), key: string(data.key), color: string(data.color) }
}
function status(value: unknown): OrbitStatus {
  const data = record(value)
  if (!['unstarted', 'started', 'completed', 'cancelled', 'duplicate'].includes(string(data.category)) || typeof data.position !== 'number' || !Number.isFinite(data.position)) throw invalid()
  const category = data.category
  if (category !== 'unstarted' && category !== 'started' && category !== 'completed' && category !== 'cancelled' && category !== 'duplicate') throw invalid()
  return { id: uuid(data.id), projectId: uuid(data.project_id), name: string(data.name), color: string(data.color), category, position: data.position }
}
function member(value: unknown): OrbitMember {
  const data = record(value)
  return { id: uuid(data.user_id), name: string(data.display_name) }
}
function date(value: unknown): string {
  const text = string(value)
  if (!Number.isFinite(Date.parse(text))) throw invalid()
  return text
}
function comment(value: unknown): OrbitComment {
  const data = record(value)
  const service = data.author_service_account === null ? null : record(data.author_service_account)
  return { id: uuid(data.id), taskId: uuid(data.task_id), authorId: uuid(data.author_id),
    serviceAccount: service ? { id: uuid(service.id), name: string(service.name) } : null,
    body: string(data.body), parentId: data.parent_id === null ? null : uuid(data.parent_id), createdAt: date(data.created_at), updatedAt: date(data.updated_at) }
}
function task(value: unknown): OrbitTask {
  const data = record(value)
  if (!Array.isArray(data.assignee_ids) || !Array.isArray(data.label_ids)) throw invalid()
  const priority = data.priority
  if (priority !== 'urgent' && priority !== 'high' && priority !== 'medium' && priority !== 'low' && priority !== 'none') throw invalid()
  return { id: uuid(data.id), projectId: uuid(data.project_id), statusId: uuid(data.status_id), identifier: string(data.identifier), title: string(data.title), description: string(data.description), assigneeIds: data.assignee_ids.map(uuid), labelIds: data.label_ids.map(uuid), priority, dueAt: data.due_at === null ? null : date(data.due_at), createdAt: date(data.created_at), updatedAt: date(data.updated_at) }
}
function baseUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(L('Endereço Orbit inválido.', 'Invalid Orbit address.')) }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(L('Use a origem HTTPS do Orbit, sem caminho, usuário ou parâmetros.', 'Use the Orbit HTTPS origin, without a path, user or parameters.'))
  }
  return url.origin
}

export class Orbit {
  private configuring = false
  constructor(private readonly db: Db, private readonly secrets: Secrets) {}

  private stored(): StoredSource | null {
    const value = this.db.meta(SOURCE_KEY)
    if (!value) return null
    const data = record(JSON.parse(value))
    return { id: uuid(data.id), baseUrl: baseUrl(string(data.baseUrl)), workspaceId: uuid(data.workspaceId), revision: uuid(data.revision) }
  }
  source(): OrbitSource | null {
    const source = this.stored()
    return source ? { id: source.id, baseUrl: source.baseUrl, workspaceId: source.workspaceId } : null
  }
  async save(input: { baseUrl: string; workspaceId: string; token: string }): Promise<OrbitSource> {
    if (this.configuring) throw changed()
    const origin = baseUrl(input.baseUrl.trim())
    const workspaceId = uuid(input.workspaceId)
    const token = input.token.trim()
    if (!token || token.length > 16384 || /[\r\n]/.test(token)) throw new Error(L('Informe um token Orbit válido.', 'Enter a valid Orbit token.'))
    this.configuring = true
    try {
      const previous = this.stored()
      const id = previous?.baseUrl === origin && previous.workspaceId === workspaceId ? previous.id : randomUUID()
      const source: StoredSource = { id, baseUrl: origin, workspaceId, revision: randomUUID() }
      await this.secrets.set(`orbit:${source.revision}`, token)
      this.db.setMeta(SOURCE_KEY, JSON.stringify(source))
      if (previous) await this.secrets.set(`orbit:${previous.revision}`, undefined)
      return { id, baseUrl: origin, workspaceId }
    } catch {
      throw new Error(L('Não foi possível salvar a conexão Orbit.', 'Could not save the Orbit connection.'))
    } finally { this.configuring = false }
  }
  private requireSource(id: string): StoredSource {
    const source = this.stored()
    if (!source || source.id !== uuid(id)) throw changed()
    return source
  }
  private current(source: StoredSource): void {
    if (this.stored()?.revision !== source.revision) throw changed()
  }
  private async get(source: StoredSource, path: string, query = new URLSearchParams(), deadline = Date.now() + 15000): Promise<unknown> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(L('O Orbit demorou para responder.', 'Orbit took too long to respond.'))
    const url = new URL(`/api/public/v1/workspaces/${encodeURIComponent(source.workspaceId)}/${path}`, source.baseUrl)
    url.search = query.toString()
    let result: unknown
    try {
      const token = await this.secrets.get(`orbit:${source.revision}`)
      if (!token) throw new Error('Missing token')
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(Math.min(15000, remaining)) })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Orbit request failed')
      }
      const reader = response.body?.getReader()
      if (!reader) throw invalid()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 8 * 1024 * 1024) throw invalid()
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel() }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error(L('Não foi possível ler o Orbit. Confira a conexão e o token com tasks:read e acesso ao projeto.', 'Could not read Orbit. Check the connection and the token with tasks:read and project access.'))
    }
    this.current(source)
    return result
  }
  private async all<T>(source: StoredSource, path: string, parse: (value: unknown) => T): Promise<T[]> {
    const items: T[] = []
    const seen = new Set<string>()
    const deadline = Date.now() + 30000
    let next: string | null = null
    for (let count = 0; count < 20; count++) {
      const query = new URLSearchParams({ limit: '100' })
      if (next) query.set('cursor', next)
      const result = page(await this.get(source, path, query, deadline), parse)
      items.push(...result.items)
      if (result.nextCursor === null) return items
      if (seen.has(result.nextCursor)) throw invalid()
      seen.add(result.nextCursor)
      next = result.nextCursor
    }
    throw new Error(L('A lista do Orbit excedeu o limite de leitura.', 'The Orbit list exceeded the read limit.'))
  }
  async projects(sourceId: string): Promise<OrbitProject[]> {
    return this.all(this.requireSource(sourceId), 'projects', project)
  }
  async projectData(sourceId: string, projectId: string): Promise<OrbitProjectData> {
    const source = this.requireSource(sourceId)
    const id = uuid(projectId)
    const [statuses, members, labels] = await Promise.all([
      this.all(source, `projects/${encodeURIComponent(id)}/statuses`, status),
      this.all(source, 'members', member),
      this.labels(source, id)
    ])
    if (statuses.some(item => item.projectId !== id)) throw invalid()
    this.current(source)
    return { statuses, members, labels }
  }
  private async labels(source: StoredSource, projectId: string) {
    const labels = await this.all(source, `projects/${projectId}/labels`, value => {
      const data = record(value)
      return { id: uuid(data.id), projectId: uuid(data.project_id), name: string(data.name), color: string(data.color) }
    })
    if (labels.some(label => label.projectId !== projectId)) throw invalid()
    return labels
  }
  async boardData(sourceId: string): Promise<OrbitBoardData> {
    const source = this.requireSource(sourceId)
    const projects = await this.projects(sourceId)
    const members = await this.all(source, 'members', member)
    const definitions = await Promise.all(projects.map(async project => {
      const [statuses, labels] = await Promise.all([this.all(source, `projects/${project.id}/statuses`, status), this.labels(source, project.id)])
      if (statuses.some(status => status.projectId !== project.id)) throw invalid()
      return { statuses, labels }
    }))
    this.current(source)
    return { projects, members, statuses: definitions.flatMap(data => data.statuses), labels: definitions.flatMap(data => data.labels) }
  }
  async comments(sourceId: string, taskId: string, nextCursor?: string): Promise<OrbitCommentPage> {
    const source = this.requireSource(sourceId)
    const detail = await this.detail(sourceId, taskId)
    const query = new URLSearchParams({ limit: '25' })
    if (nextCursor !== undefined) query.set('cursor', string(cursor(nextCursor)))
    const result = page(await this.get(source, `tasks/${detail.task.id}/comments`, query), comment)
    if (result.items.some(item => item.taskId !== detail.task.id)) throw invalid()
    return result
  }
  async activity(sourceId: string, taskId: string, person: Person, nextCursor?: string): Promise<OrbitActivityPage> {
    const source = this.requireSource(sourceId)
    const detail = await this.detail(sourceId, taskId)
    this.current(source)
    const page = this.db.taskActivity(source.id, source.workspaceId, detail.task.id, person.id, nextCursor)
    const people = new People(this.db)
    const visible = (conversationId: string, at: number): boolean => people.canSeeConversation(person, this.db.conversation(conversationId)) && people.visibleAt(person, { conversationId, at })
    return { ...page, items: page.items.filter(item => visible(item.evidence.conversationId, item.at)), executions: page.executions.filter(item => visible(item.conversationId, item.createdAt)) }
  }
  async start(input: OrbitStartInput, launch: (source: OrbitSource, detail: OrbitTaskDetail, agent: Agent) => OrbitExecution): Promise<OrbitExecution> {
    if (input.role !== 'executor' && input.role !== 'reviewer') throw invalid()
    uuid(input.requestId)
    const source = this.requireSource(input.sourceId)
    const detail = await this.detail(input.sourceId, input.taskId)
    this.current(source)
    const agentId = detail.assignments[input.role]
    const agent = agentId ? this.db.agent(agentId) : undefined
    if (!agent || agent.archived) throw new Error(L('Atribua um agente ativo antes de iniciar.', 'Assign an active agent before starting.'))
    return launch(source, detail, agent)
  }
  private assignmentKey(source: OrbitSource, taskId: string, role: OrbitAgentRole): string {
    return `orbit:assignment:${JSON.stringify([source.id, source.workspaceId, taskId, role])}`
  }
  private assignments(source: OrbitSource, taskId: string): OrbitAssignments {
    return { executor: this.db.meta(this.assignmentKey(source, taskId, 'executor')) || null, reviewer: this.db.meta(this.assignmentKey(source, taskId, 'reviewer')) || null }
  }
  async tasks(sourceId: string, projectId: string | null, nextCursor?: string | null): Promise<OrbitTaskPage> {
    const source = this.requireSource(sourceId)
    const id = projectId === null ? null : uuid(projectId)
    const approved = id === null ? new Set((await this.projects(sourceId)).map(project => project.id)) : new Set([id])
    const query = new URLSearchParams({ limit: '25', sort: 'created_at', order: 'desc' })
    if (id) query.set('project_id', id)
    if (nextCursor != null) query.set('cursor', string(cursor(nextCursor)))
    const result = page(await this.get(source, 'tasks', query), task)
    if (result.items.some(item => !approved.has(item.projectId))) throw invalid()
    return { items: result.items.map(task => ({ task, assignments: this.assignments(source, task.id) })), nextCursor: result.nextCursor }
  }
  async detail(sourceId: string, taskId: string): Promise<OrbitTaskDetail> {
    const source = this.requireSource(sourceId)
    const id = uuid(taskId)
    const result = task(await this.get(source, `tasks/${encodeURIComponent(id)}`))
    if (result.id !== id) throw invalid()
    return { task: result, assignments: this.assignments(source, id) }
  }
  async assign(input: { sourceId: string; taskId: string; role: OrbitAgentRole; agentId: string | null }): Promise<OrbitTaskDetail> {
    if (input.role !== 'executor' && input.role !== 'reviewer') throw invalid()
    const source = this.requireSource(input.sourceId)
    const detail = await this.detail(input.sourceId, input.taskId)
    this.current(source)
    if (input.agentId !== null) {
      const agent = this.db.agent(input.agentId)
      if (!agent || agent.archived) throw new Error(L('Escolha um agente ativo.', 'Choose an active agent.'))
    }
    this.db.setMeta(this.assignmentKey(source, detail.task.id, input.role), input.agentId ?? '')
    return { task: detail.task, assignments: this.assignments(source, detail.task.id) }
  }
}
