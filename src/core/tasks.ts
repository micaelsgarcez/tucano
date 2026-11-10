import { People } from './people'
import type { Agent, Person } from '../shared/types'
import type { Db } from './db'
import { TaskError, type TaskStore } from '../tasks/store'
import { UserError } from '../shared/errors'
import type { TaskCreate, TaskPatch } from '../tasks/contracts'
import type { TaskAgentRole, TaskAssignments, TaskSource, TaskDetail, TaskStartInput, TaskExecution } from '../shared/tasks'
import { L } from '../shared/lang'

export function taskError(error: unknown): unknown {
  if (!(error instanceof TaskError)) return error
  if (error.status === 409) return new UserError(error.message.includes('GitHub')
    ? L('Edite o título, a descrição e o estado desta tarefa no GitHub.', 'Edit this task title, description and status in GitHub.')
    : L('Esta tarefa mudou. Atualize o detalhe antes de salvar novamente.', 'This task changed. Refresh its details before saving again.'))
  if (error.status === 401 || error.status === 403) return new UserError(L('Você não tem acesso a esta tarefa ou projeto.', 'You do not have access to this task or project.'))
  if (error.status === 404) return new UserError(L('Tarefa ou projeto indisponível.', 'Task or project unavailable.'))
  return new UserError(L('Confira os campos da tarefa e tente novamente.', 'Check the task fields and try again.'))
}

export class Tasks {
  constructor(private readonly db: Db, private readonly store: TaskStore) {}
  source(): TaskSource | null { return this.store.source() }
  private requireSource(id: string): TaskSource {
    const source = this.source()
    if (!source || source.id !== id) throw new Error(L('A origem das tarefas mudou. Atualize a página.', 'The task source changed. Refresh the page.'))
    return source
  }
  private assignmentKey(source: TaskSource, taskId: string, role: TaskAgentRole): string {
    // Deployed keys retain the task identity and keep the pre-migration rollback readable.
    return `orbit:assignment:${JSON.stringify([source.id, source.workspaceId, taskId, role])}`
  }
  private assignments(source: TaskSource, taskId: string): TaskAssignments {
    return { executor: this.db.meta(this.assignmentKey(source, taskId, 'executor')) || null, reviewer: this.db.meta(this.assignmentKey(source, taskId, 'reviewer')) || null }
  }
  async projects(sourceId: string) { this.requireSource(sourceId); return this.store.projects(this.store.ownerPrincipal()) }
  async projectData(sourceId: string, projectId: string) { this.requireSource(sourceId); return this.store.projectData(this.store.ownerPrincipal(), projectId) }
  async boardData(sourceId: string) { this.requireSource(sourceId); return this.store.board(this.store.ownerPrincipal()) }
  async tasks(sourceId: string, projectId: string | null, cursor?: string) {
    const source = this.requireSource(sourceId)
    const page = this.store.list(this.store.ownerPrincipal(), { projectId, cursor })
    return { ...page, items: page.items.map(task => ({ task, assignments: this.assignments(source, task.id) })) }
  }
  async detail(sourceId: string, taskId: string): Promise<TaskDetail> {
    const source = this.requireSource(sourceId)
    const task = this.store.get(this.store.ownerPrincipal(), taskId)
    return { task, assignments: this.assignments(source, task.id) }
  }
  async comments(sourceId: string, taskId: string, cursor?: string) {
    this.requireSource(sourceId)
    return this.store.comments(this.store.ownerPrincipal(), taskId, cursor)
  }
  async activity(sourceId: string, taskId: string, person: Person, cursor?: string) {
    const source = this.requireSource(sourceId)
    const task = this.store.get(this.store.ownerPrincipal(), taskId)
    const page = this.db.taskActivity(source.id, source.workspaceId, task.id, person.id, cursor)
    const people = new People(this.db)
    const visible = (conversationId: string, at: number): boolean => people.canSeeConversation(person, this.db.conversation(conversationId)) && people.visibleAt(person, { conversationId, at })
    return { ...page, items: page.items.filter(item => visible(item.evidence.conversationId, item.at)), executions: page.executions.filter(item => visible(item.conversationId, item.createdAt)) }
  }
  async assign(input: { sourceId: string; taskId: string; role: TaskAgentRole; agentId: string | null }): Promise<TaskDetail> {
    if (input.role !== 'executor' && input.role !== 'reviewer') throw new Error('Invalid task role')
    const source = this.requireSource(input.sourceId)
    const task = this.store.get(this.store.ownerPrincipal(), input.taskId)
    if (input.agentId !== null) {
      const agent = this.db.agent(input.agentId)
      if (!agent || agent.archived) throw new Error(L('Agente indisponível.', 'Agent unavailable.'))
    }
    this.db.setMeta(this.assignmentKey(source, task.id, input.role), input.agentId ?? '')
    return { task, assignments: this.assignments(source, task.id) }
  }
  async start(input: TaskStartInput, launch: (source: TaskSource, detail: TaskDetail, agent: Agent) => TaskExecution): Promise<TaskExecution> {
    if (input.role !== 'executor' && input.role !== 'reviewer') throw new Error('Invalid task role')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)) throw new Error('Invalid request id')
    const source = this.requireSource(input.sourceId)
    const task = this.store.get(this.store.ownerPrincipal(), input.taskId)
    const detail = { task, assignments: this.assignments(source, task.id) }
    const agentId = detail.assignments[input.role]
    const agent = agentId ? this.db.agent(agentId) : undefined
    if (!agent || agent.archived) throw new Error(L('Atribua um agente ativo antes de iniciar.', 'Assign an active agent before starting.'))
    return launch(source, detail, agent)
  }
  async create(input: TaskCreate & { sourceId: string }): Promise<TaskDetail> {
    const source = this.requireSource(input.sourceId)
    const { sourceId: _, ...create } = input
    const task = this.store.create(this.store.ownerPrincipal(), create)
    return { task, assignments: this.assignments(source, task.id) }
  }
  async update(input: { sourceId: string; taskId: string; expectedVersion: number; patch: TaskPatch }): Promise<TaskDetail> {
    const source = this.requireSource(input.sourceId)
    const task = this.store.update(this.store.ownerPrincipal(), input.taskId, input.expectedVersion, input.patch)
    return { task, assignments: this.assignments(source, task.id) }
  }
  async addComment(input: { sourceId: string; taskId: string; body: string; parentId?: string }) {
    this.requireSource(input.sourceId)
    return this.store.addComment(this.store.ownerPrincipal(), input)
  }
}
