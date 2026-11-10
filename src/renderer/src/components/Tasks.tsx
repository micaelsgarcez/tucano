import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L, locale } from '../../../shared/lang'
import type { TaskActivity, TaskActivityPage, TaskAgentRole, TaskBoardData, TaskComment, TaskExecution, TaskProject, TaskSource, TaskStatus, TaskItem, TaskDetail } from '../../../shared/tasks'
import type { Agent, RunStatus } from '../../../shared/types'
import { call } from '../rpc'
import { safeUrl } from '../links'
import { amOwner, navigate, openDm, openThread, useStore } from '../store'
import { Field, Sheet } from './Pages'

const failure = (error: unknown): string => error instanceof Error ? error.message : L('Não foi possível carregar as tarefas.', 'Could not load tasks.')
const roleName = (role: TaskAgentRole): string => role === 'executor' ? L('Executor', 'Executor') : L('Revisor', 'Reviewer')
const agentName = (agents: Agent[], id: string | null): string => id ? agents.find(agent => agent.id === id)?.name ?? L('Agente indisponível', 'Unavailable agent') : L('Sem atribuição', 'Unassigned')
const dateText = (value: string | number): string => new Date(value).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })
const closed = (status?: TaskStatus): boolean => !!status && ['completed', 'cancelled', 'duplicate'].includes(status.category)
const categoryOrder = ['unstarted', 'started', 'completed', 'cancelled', 'duplicate']

export function TasksPage(): ReactNode {
  const owner = useStore(amOwner)
  return owner ? <TaskWorkspace /> : <Sheet title={L('Projetos e tarefas', 'Projects and tasks')}><p>{L('Esta área está disponível apenas para o dono do Tucano.', 'This area is available only to the Tucano owner.')}</p></Sheet>
}

function TaskWorkspace(): ReactNode {
  const [source, setSource] = useState<TaskSource | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    call('tasksSource').then(value => { if (active) { setSource(value); setReady(true) } }).catch(error => { if (active) setError(failure(error)) })
    return () => { active = false }
  }, [])
  return <Sheet fill title={L('Projetos e tarefas', 'Projects and tasks')} actions={source && <>
    <button className="btn" onClick={() => setRefresh(value => value + 1)}>{L('Atualizar', 'Refresh')}</button>
  </>}>
    <div className="tasks-workspace">
      {error && <p role="alert">{error}</p>}
      {!ready && !error && <p role="status">{L('Carregando…', 'Loading…')}</p>}
      {ready && !source && <p>{L('Configure o workspace de tarefas antes de continuar.', 'Set up the task workspace before continuing.')}</p>}
      {source && <TaskProjects key={`${source.id}:${refresh}`} source={source} />}
    </div>
  </Sheet>
}
function TaskProjects({ source }: { source: TaskSource }): ReactNode {
  const [data, setData] = useState<TaskBoardData | null>(null)
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    call('tasksBoardData', { sourceId: source.id }).then(value => { if (active) setData(value) }).catch(error => { if (active) setError(failure(error)) })
    return () => { active = false }
  }, [source.id])
  if (error) return <p role="alert">{error}</p>
  if (!data) return <p role="status">{L('Carregando projetos…', 'Loading projects…')}</p>
  if (!data.projects.length) return <p>{L('Nenhum projeto disponível.', 'No projects available.')}</p>
  return <TaskItems key={projectId} source={source} data={data} projectId={projectId} onProject={setProjectId} />
}

function TaskForm({ source, data, task, projectId: initialProject, onSave, onCancel }: { source: TaskSource; data: TaskBoardData; task?: TaskItem; projectId: string; onSave: (detail: TaskDetail) => void; onCancel: () => void }): ReactNode {
  const [projectId, setProjectId] = useState(task?.projectId ?? (initialProject || data.projects[0]?.id || ''))
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [statusId, setStatusId] = useState(task?.statusId ?? '')
  const [priority, setPriority] = useState<TaskItem['priority']>(task?.priority ?? 'none')
  const [dueAt, setDueAt] = useState(task?.dueAt?.slice(0, 10) ?? '')
  const [assigneeIds, setAssigneeIds] = useState(task?.assigneeIds ?? [])
  const [labelIds, setLabelIds] = useState(task?.labelIds ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const linked = !!task?.sourceUrl
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setError('')
    const fields = { priority, dueAt: dueAt ? (dueAt === task?.dueAt?.slice(0, 10) ? task.dueAt : new Date(`${dueAt}T12:00:00Z`).toISOString()) : null, assigneeIds, labelIds }
    const content = linked ? {} : { title: title.trim(), description, ...(statusId ? { statusId } : {}) }
    try {
      const value = task
        ? await call('tasksUpdate', { sourceId: source.id, taskId: task.id, expectedVersion: task.version, patch: { ...fields, ...content } })
        : await call('tasksCreate', { sourceId: source.id, projectId, title: title.trim(), description, ...(statusId ? { statusId } : {}), ...fields })
      if (active.current) onSave(value)
    } catch (error) {
      if (active.current) setError(`${failure(error)} ${L('Seu texto foi mantido. Se a tarefa mudou, cancele e reabra a edição para revisar a versão atual.', 'Your input was kept. If the task changed, cancel and reopen the editor to review the current version.')}`)
    } finally { if (active.current) setBusy(false) }
  }
  return <form className="tasks-form" aria-label={task ? L('Editar tarefa', 'Edit task') : L('Nova tarefa', 'New task')} onSubmit={event => void save(event)}>
    {!task && <Field label={L('Projeto da tarefa', 'Task project')}><select aria-label={L('Projeto da tarefa', 'Task project')} value={projectId} disabled={busy} required onChange={event => { setProjectId(event.target.value); setStatusId(''); setLabelIds([]) }}>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>}
    {linked && <p>{L('Título, descrição e status são atualizados pelo GitHub.', 'Title, description and status are managed by GitHub.')}</p>}
    <Field label={L('Título', 'Title')}><input aria-label={L('Título', 'Title')} value={title} onInput={event => setTitle(event.currentTarget.value)} required disabled={busy || linked} autoFocus /></Field>
    <Field label={L('Descrição', 'Description')}><textarea aria-label={L('Descrição', 'Description')} value={description} onInput={event => setDescription(event.currentTarget.value)} rows={5} disabled={busy || linked} /></Field>
    <Field label="Status"><select aria-label="Status" value={statusId} onChange={event => setStatusId(event.target.value)} disabled={busy || linked}><option value="">{L('Padrão do projeto', 'Project default')}</option>{data.statuses.filter(status => status.projectId === projectId).map(status => <option key={status.id} value={status.id}>{status.name}</option>)}</select></Field>
    <Field label={L('Prioridade', 'Priority')}><select aria-label={L('Prioridade', 'Priority')} value={priority} disabled={busy} onChange={event => { const value = event.target.value; if (value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'urgent') setPriority(value) }}>{(['none', 'low', 'medium', 'high', 'urgent'] satisfies TaskItem['priority'][]).map(value => <option value={value} key={value}>{({ none: L('Sem prioridade', 'No priority'), low: L('Baixa', 'Low'), medium: L('Média', 'Medium'), high: L('Alta', 'High'), urgent: L('Urgente', 'Urgent') })[value]}</option>)}</select></Field>
    <Field label={L('Prazo', 'Due date')}><input type="date" aria-label={L('Prazo', 'Due date')} value={dueAt} disabled={busy} onInput={event => setDueAt(event.currentTarget.value)} /></Field>
    <fieldset disabled={busy}><legend>{L('Responsáveis humanos', 'Human assignees')}</legend>{data.members.map(member => <label key={member.id}><input type="checkbox" checked={assigneeIds.includes(member.id)} onChange={event => setAssigneeIds(ids => event.target.checked ? [...ids, member.id] : ids.filter(id => id !== member.id))} />{member.name}</label>)}</fieldset>
    <fieldset disabled={busy}><legend>{L('Etiquetas', 'Labels')}</legend>{data.labels.filter(label => label.projectId === projectId).map(label => <label key={label.id}><input type="checkbox" checked={labelIds.includes(label.id)} onChange={event => setLabelIds(ids => event.target.checked ? [...ids, label.id] : ids.filter(id => id !== label.id))} />{label.name}</label>)}</fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="tasks-form-actions"><button className="btn btn--primary" disabled={busy || !title.trim()}>{busy ? L('Salvando…', 'Saving…') : L('Salvar tarefa', 'Save task')}</button><button type="button" className="btn" disabled={busy} onClick={onCancel}>{L('Cancelar', 'Cancel')}</button></div>
  </form>
}

function CommentComposer({ source, taskId, onSave }: { source: TaskSource; taskId: string; onSave: (comment: TaskComment) => void }): ReactNode {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const comment = await call('tasksAddComment', { sourceId: source.id, taskId, body: body.trim() })
      if (active.current) { onSave(comment); setBody('') }
    } catch (error) { if (active.current) setError(failure(error)) } finally { if (active.current) setBusy(false) }
  }
  return <form className="tasks-form" aria-label={L('Adicionar comentário', 'Add comment')} onSubmit={event => void save(event)}>
    <Field label={L('Comentário', 'Comment')}><textarea aria-label={L('Comentário', 'Comment')} value={body} rows={3} required disabled={busy} onInput={event => setBody(event.currentTarget.value)} /></Field>
    {error && <p role="alert">{error}</p>}
    <button className="btn" disabled={busy || !body.trim()}>{L('Enviar comentário', 'Post comment')}</button>
  </form>
}

function StatusIcon({ status }: { status?: TaskStatus }): ReactNode {
  return <span className={`tasks-status-icon ${status ? `is-${status.category}` : ''}`} style={{ color: status?.color }} aria-hidden="true">{status?.category === 'completed' ? '✓' : status?.category === 'cancelled' || status?.category === 'duplicate' ? '×' : status?.category === 'started' ? '◐' : '○'}</span>
}
function Priority({ priority }: { priority: TaskItem['priority'] }): ReactNode {
  const names = { urgent: L('Urgente', 'Urgent'), high: L('Alta', 'High'), medium: L('Média', 'Medium'), low: L('Baixa', 'Low'), none: L('Sem prioridade', 'No priority') }
  return <span className={`tasks-priority is-${priority}`} aria-label={names[priority]} title={names[priority]}>{priority === 'urgent' ? '!' : priority === 'none' ? '—' : <span aria-hidden="true">{[1, 2, 3].map(level => <i key={level} style={{ height: 3 + level * 3, opacity: level <= ({ low: 1, medium: 2, high: 3 }[priority]) ? 1 : .2 }} />)}</span>}</span>
}
function ProjectChip({ project }: { project?: TaskProject }): ReactNode {
  return <span className="tasks-project-chip"><i style={{ backgroundColor: project?.color }} />{project?.name ?? L('Projeto indisponível', 'Unavailable project')}</span>
}
function TaskMarkdown({ text }: { text: string }): ReactNode {
  return <div className="md tasks-markdown"><Markdown urlTransform={safeUrl} remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{alt}</span> }}>{text}</Markdown></div>
}

function TaskItems({ source, data, projectId, onProject }: { source: TaskSource; data: TaskBoardData; projectId: string; onProject: (id: string) => void }): ReactNode {
  const [items, setItems] = useState<TaskDetail[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const linkedTask = useStore(state => state.view?.kind === 'tasks' ? state.view.taskId : undefined)
  const [selected, setSelected] = useState(linkedTask ?? '')
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const active = useRef(true)
  const seen = useRef(new Set<string>())
  const cards = useRef(new Map<string, HTMLButtonElement>())
  const lastSelected = useRef<string | null>(null)
  useEffect(() => { if (!selected && lastSelected.current) cards.current.get(lastSelected.current)?.focus() }, [selected])
  const agents = useStore(state => state.agents)
  useEffect(() => {
    active.current = true
    call('tasksTasks', { sourceId: source.id, projectId: projectId || null }).then(page => {
      if (active.current) { setItems(page.items); setCursor(page.nextCursor) }
    }).catch(error => { if (active.current) setError(failure(error)) }).finally(() => { if (active.current) setLoading(false) })
    return () => { active.current = false }
  }, [source.id, projectId])
  async function more(): Promise<void> {
    if (!cursor || loading) return
    setLoading(true); setError('')
    try {
      const page = await call('tasksTasks', { sourceId: source.id, projectId: projectId || null, cursor })
      if (!active.current) return
      seen.current.add(cursor)
      if (page.nextCursor && seen.current.has(page.nextCursor)) throw new Error(L('O servidor repetiu uma página. Atualize para tentar novamente.', 'The server repeated a page. Refresh to try again.'))
      setItems(previous => [...previous.filter(item => !page.items.some(next => next.task.id === item.task.id)), ...page.items])
      setCursor(page.nextCursor)
    } catch (error) { if (active.current) { setError(failure(error)); setItems([]); setCursor(null) } } finally { if (active.current) setLoading(false) }
  }
  if (creating) return <div className="tasks-create"><h2>{L('Nova tarefa', 'New task')}</h2><TaskForm source={source} data={data} projectId={projectId} onCancel={() => setCreating(false)} onSave={detail => { setItems(previous => [detail, ...previous]); setCreating(false); setSelected(detail.task.id) }} /></div>
  if (selected) return <TaskDetailView key={selected} source={source} taskId={selected} data={data} onBack={() => { setSelected(''); navigate({ kind: 'tasks' }) }} onChange={detail => setItems(previous => previous.map(item => item.task.id === detail.task.id ? detail : item))} />
  const statuses = data.statuses.filter(status => !projectId || status.projectId === projectId).toSorted((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) || a.position - b.position)
  const groups = new Map<string, { status?: TaskStatus; statusIds: string[]; tasks: TaskDetail[] }>()
  for (const status of statuses) {
    const key = `${status.category}:${status.name.trim().replace(/[A-Z]+/g, letters => letters.toLowerCase())}`
    const group = groups.get(key)
    if (group) group.statusIds.push(status.id)
    else groups.set(key, { status, statusIds: [status.id], tasks: [] })
  }
  const shown = items.filter(({ task }) => `${task.identifier} ${task.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  for (const item of shown) {
    let group = [...groups.values()].find(group => group.statusIds.includes(item.task.statusId))
    if (!group) {
      group = groups.get('unknown')
      if (!group) { group = { statusIds: [], tasks: [] }; groups.set('unknown', group) }
    }
    group.tasks.push(item)
  }
  return <>
    <div className="tasks-toolbar">
      <button className="btn btn--primary" onClick={() => setCreating(true)}>{L('Nova tarefa', 'New task')}</button>
      <select aria-label={L('Projeto', 'Project')} value={projectId} onChange={event => onProject(event.target.value)}><option value="">{L('Todos os projetos', 'All projects')}</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <input className="tasks-search" type="search" aria-label={L('Buscar nas tarefas carregadas', 'Search loaded tasks')} placeholder={L('Buscar tarefas…', 'Search tasks…')} value={query} onChange={event => setQuery(event.target.value)} />
      <span>{L('Mais recentes primeiro', 'Newest first')}</span>
    </div>
    <div className="tasks-board-state" aria-live="polite">{cursor ? L(`${items.length} tarefas carregadas · contagens parciais`, `${items.length} tasks loaded · partial counts`) : L(`${items.length} tarefas`, `${items.length} tasks`)}{query && ` · ${L(`${shown.length} encontradas`, `${shown.length} matches`)}`}</div>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">{L('Carregando tarefas…', 'Loading tasks…')}</p>}
    {!loading && !error && !shown.length && <p className="tasks-empty">{L('Nenhuma tarefa encontrada.', 'No tasks found.')}</p>}
    <div className="tasks-board" aria-label={L('Quadro de tarefas', 'Task board')} tabIndex={0}>
      {[...groups].map(([key, group]) => <section className="tasks-column" key={key} aria-label={group.status?.name ?? L('Status indisponível', 'Unavailable status')}>
        <header><StatusIcon status={group.status} /><h2>{group.status?.name ?? L('Status indisponível', 'Unavailable status')}</h2><span title={cursor ? L('Tarefas carregadas nesta coluna', 'Loaded tasks in this column') : undefined}>{group.tasks.length}</span></header>
        <div className="tasks-column-cards">{group.tasks.map(({ task, assignments }) => {
          const project = data.projects.find(project => project.id === task.projectId)
          const status = data.statuses.find(status => status.id === task.statusId)
          const due = task.dueAt && new Date(task.dueAt)
          const overdue = due && due.getTime() < Date.now() && !closed(status)
          return <button className="tasks-task" key={task.id} ref={node => { if (node) cards.current.set(task.id, node); else cards.current.delete(task.id) }} onClick={() => { lastSelected.current = task.id; setSelected(task.id) }}>
            <span className="tasks-card-head"><span><StatusIcon status={status} />{task.identifier}</span><span className="tasks-card-people">{task.assigneeIds.map(id => { const name = data.members.find(member => member.id === id)?.name ?? L('Responsável indisponível', 'Unavailable assignee'); return <span className="tasks-human-avatar" key={id} title={name} aria-label={name}>{name.slice(0, 1)}</span> })}<Priority priority={task.priority} /></span></span>
            <strong>{task.title}</strong>
            {!!task.labelIds.length && <span className="tasks-labels">{task.labelIds.map(id => { const label = data.labels.find(label => label.id === id); return label && <span className="tasks-label" key={id}><i style={{ backgroundColor: label.color }} />{label.name}</span> })}</span>}
            <span className="tasks-card-footer"><ProjectChip project={project} />{due && <time dateTime={task.dueAt ?? undefined} title={dateText(task.dueAt ?? '')} className={overdue ? 'is-overdue' : ''}>▦ {due.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })}</time>}</span>
            <span className="tasks-card-agents">{(['executor', 'reviewer'] satisfies TaskAgentRole[]).map(role => <span key={role}><span>{roleName(role)}</span><b>{agentName(agents, assignments[role])}</b></span>)}</span>
          </button>
        })}</div>
      </section>)}
    </div>
    {cursor && <div className="tasks-more"><button className="btn" onClick={() => void more()} disabled={loading}>{L('Carregar mais tarefas', 'Load more tasks')}</button></div>}
  </>
}

function evidence(execution: Pick<TaskExecution, 'conversationId' | 'rootMessageId'>): void {
  navigate({ kind: 'conversation', id: execution.conversationId })
  openThread(execution.rootMessageId)
}
function runLabel(status: RunStatus): string {
  const names: Record<RunStatus, string> = {
    working: L('Em execução', 'Running'), done: L('Execução encerrada', 'Run finished'), failed: L('Falhou', 'Failed'), stopped: L('Interrompida pelo usuário', 'Stopped by user'),
    interrupted: L('Interrompida', 'Interrupted'), paused: L('Pausada', 'Paused'), waiting_input: L('Aguardando resposta', 'Waiting for input'), waiting_approval: L('Aguardando aprovação', 'Waiting for approval'), limit_reached: L('Limite atingido', 'Limit reached')
  }
  return names[status]
}
function ActivityEntry({ item }: { item: TaskActivity }): ReactNode {
  return <article className={`tasks-event is-${item.kind}`}>
    <div className="tasks-event-heading"><strong>{item.agentName}</strong><span>{roleName(item.role)} · {item.kind === 'report' ? L('Relato do agente', 'Agent report') : L('Execução observada', 'Observed execution')}</span><time dateTime={new Date(item.at).toISOString()}>{dateText(item.at)}</time></div>
    {item.kind === 'report' ? <dl className="tasks-report">
      <dt>{L('Ação', 'Action')}</dt><dd>{item.action}</dd>
      <dt>{L('Resultado', 'Result')}</dt><dd>{item.result}</dd>
      <dt>{L('Evidência', 'Evidence')}</dt><dd>{item.evidence.stepIds.length ? L(`Passos vinculados ao relato: ${item.evidence.stepIds.length}`, `Steps linked to this report: ${item.evidence.stepIds.length}`) : L('Relato sem passos de ferramenta vinculados.', 'Report without linked tool steps.')} <button className="text-btn" onClick={() => evidence(item.evidence)} title={item.evidence.messageId}>{L('Ver execução', 'View execution')}</button></dd>
      <dt>{L('Próximo passo', 'Next step')}</dt><dd>{item.nextStep}</dd>
    </dl> : <>
      <p className="tasks-run-state">{runLabel(item.status)}</p>
      <p>{L(`Passos encerrados: ${item.steps.filter(step => step.status === 'done').length} · Com falha: ${item.steps.filter(step => step.status === 'error').length}`, `Finished steps: ${item.steps.filter(step => step.status === 'done').length} · Failed: ${item.steps.filter(step => step.status === 'error').length}`)}</p>
      <button className="text-btn" onClick={() => evidence(item.evidence)} title={item.evidence.messageId}>{L('Ver execução', 'View execution')}</button>
    </>}
  </article>
}

function TaskDetailView({ source, taskId, data, onBack, onChange }: { source: TaskSource; taskId: string; data: TaskBoardData; onBack: () => void; onChange: (detail: TaskDetail) => void }): ReactNode {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [editing, setEditing] = useState(false)
  const [comments, setComments] = useState<TaskComment[]>([])
  const [commentCursor, setCommentCursor] = useState<string | null>(null)
  const [activity, setActivity] = useState<TaskActivityPage>({ items: [], executions: [], nextCursor: null, headCursor: null })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef(true)
  const seenComments = useRef(new Set<string>())
  const seenActivity = useRef(new Set<string>())
  const readingActivity = useRef(false)
  const requests = useRef<Partial<Record<TaskAgentRole, string>>>({})
  const heading = useRef<HTMLHeadingElement>(null)
  const agents = useStore(state => state.agents)
  function fail(error: unknown): void {
    if (active.current) { setError(failure(error)); setDetail(null); setComments([]); setActivity({ items: [], executions: [], nextCursor: null, headCursor: null }) }
  }
  function mergeActivity(page: TaskActivityPage, older: boolean): void {
    setActivity(previous => {
      const gap = !older && page.nextCursor !== null && (previous.headCursor === null || Number(page.nextCursor) > Number(previous.headCursor))
      if (gap) seenActivity.current.clear()
      return {
        items: [...previous.items.filter(item => !page.items.some(next => next.id === item.id)), ...page.items],
        executions: [...previous.executions.filter(item => !page.executions.some(next => next.id === item.id)), ...page.executions],
        nextCursor: older || gap ? page.nextCursor : previous.nextCursor,
        headCursor: older ? previous.headCursor : page.headCursor
      }
    })
  }
  useEffect(() => {
    active.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      if (readingActivity.current) { timer = setTimeout(() => void refresh(), 10000); return }
      readingActivity.current = true
      try {
        const page = await call('tasksActivity', { sourceId: source.id, taskId })
        if (active.current) { mergeActivity(page, false); timer = setTimeout(() => void refresh(), 10000) }
      } catch (error) { fail(error) } finally { readingActivity.current = false }
    }
    Promise.all([call('tasksTask', { sourceId: source.id, taskId }), call('tasksComments', { sourceId: source.id, taskId }), call('tasksActivity', { sourceId: source.id, taskId })]).then(([value, comments, activity]) => {
      if (active.current) { setDetail(value); setComments(comments.items); setCommentCursor(comments.nextCursor); setActivity(activity); timer = setTimeout(() => void refresh(), 10000) }
    }).catch(fail)
    return () => { active.current = false; if (timer) clearTimeout(timer) }
  }, [source.id, taskId])
  useEffect(() => { heading.current?.focus() }, [detail?.task.id])
  async function assign(role: TaskAgentRole, agentId: string): Promise<void> {
    setBusy(true); setError('')
    try {
      const value = await call('tasksAssignAgent', { sourceId: source.id, taskId, role, agentId: agentId || null })
      if (active.current) { delete requests.current[role]; setDetail(value); onChange(value) }
    } catch (error) { fail(error) } finally { if (active.current) setBusy(false) }
  }
  async function start(role: TaskAgentRole): Promise<void> {
    setBusy(true); setError('')
    const requestId = requests.current[role] ?? crypto.randomUUID()
    requests.current[role] = requestId
    try {
      const execution = await call('tasksStart', { sourceId: source.id, taskId, role, requestId })
      if (active.current) {
        delete requests.current[role]
        setActivity(previous => ({ ...previous, executions: [...previous.executions.filter(item => item.id !== execution.id), execution] }))
      }
    } catch (error) { if (active.current) setError(failure(error)) } finally { if (active.current) setBusy(false) }
  }
  async function moreComments(): Promise<void> {
    if (!commentCursor || busy) return
    setBusy(true)
    try {
      const page = await call('tasksComments', { sourceId: source.id, taskId, cursor: commentCursor })
      if (!active.current) return
      seenComments.current.add(commentCursor)
      if (page.nextCursor && seenComments.current.has(page.nextCursor)) throw new Error(L('O servidor repetiu uma página de comentários.', 'The server repeated a comment page.'))
      setComments(previous => [...previous.filter(item => !page.items.some(next => next.id === item.id)), ...page.items]); setCommentCursor(page.nextCursor)
    } catch (error) { fail(error) } finally { if (active.current) setBusy(false) }
  }
  async function moreActivity(): Promise<void> {
    if (!activity.nextCursor || busy || readingActivity.current) return
    setBusy(true); readingActivity.current = true
    try {
      const page = await call('tasksActivity', { sourceId: source.id, taskId, cursor: activity.nextCursor })
      if (!active.current) return
      seenActivity.current.add(activity.nextCursor)
      if (page.nextCursor && seenActivity.current.has(page.nextCursor)) throw new Error(L('A atividade repetiu uma página.', 'Activity repeated a page.'))
      mergeActivity(page, true)
    } catch (error) { fail(error) } finally { readingActivity.current = false; if (active.current) setBusy(false) }
  }
  const task = detail?.task
  const project = data.projects.find(project => project.id === task?.projectId)
  const status = data.statuses.find(status => status.id === task?.statusId)
  const timeline = [
    ...comments.map(comment => ({ id: `comment:${comment.id}`, at: Date.parse(comment.createdAt), content: <article className="tasks-event is-comment"><div className="tasks-event-heading"><strong>{comment.serviceAccount?.name ?? data.members.find(member => member.id === comment.authorId)?.name ?? L('Autor indisponível', 'Unavailable author')}</strong><span>{L('Comentário', 'Comment')}{comment.serviceAccount && ` · ${L('conta de serviço', 'service account')}`}</span><time dateTime={comment.createdAt}>{dateText(comment.createdAt)}</time></div>{comment.parentId && <p className="tasks-reply-label">{L('Resposta a um comentário', 'Reply to a comment')}</p>}<TaskMarkdown text={comment.body} /></article> })),
    ...activity.items.map(item => ({ id: item.id, at: item.at, content: <ActivityEntry item={item} /> }))
  ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  return <div className="tasks-detail-page">
    <div className="tasks-detail-nav"><button className="text-btn" onClick={onBack}>← {L('Voltar ao quadro', 'Back to board')}</button>{task && <span><ProjectChip project={project} /> <span aria-hidden="true">›</span> {task.identifier}</span>}</div>
    {!detail || !task ? <p role={error ? 'alert' : 'status'}>{error || L('Carregando tarefa…', 'Loading task…')}</p> : <div className="tasks-detail-layout">
      <main className="tasks-detail-main">
        <h2 ref={heading} tabIndex={-1}>{task.title}</h2>
        {task.sourceUrl && safeUrl(task.sourceUrl, 'href') && <p><a href={safeUrl(task.sourceUrl, 'href')} target="_blank" rel="noreferrer">{L('Ver no GitHub', 'View on GitHub')}</a></p>}
        {editing ? <TaskForm source={source} data={data} task={task} projectId={task.projectId} onSave={value => { setDetail(value); onChange(value); setEditing(false) }} onCancel={() => { setEditing(false); void call('tasksTask', { sourceId: source.id, taskId }).then(value => { if (active.current) { setDetail(value); onChange(value) } }).catch(fail) }} /> : <button className="btn" onClick={() => setEditing(true)}>{L('Editar tarefa', 'Edit task')}</button>}
        <TaskMarkdown text={task.description || L('Sem descrição.', 'No description.')} />

      </main>
      <aside className="tasks-properties" aria-label={L('Propriedades da tarefa', 'Task properties')}>
        <h3>{L('Propriedades', 'Properties')}</h3>
        <p><StatusIcon status={status} /> {status?.name ?? L('Status indisponível', 'Unavailable status')}</p>
        <p><Priority priority={task.priority} /> {({ urgent: L('Urgente', 'Urgent'), high: L('Prioridade alta', 'High priority'), medium: L('Prioridade média', 'Medium priority'), low: L('Prioridade baixa', 'Low priority'), none: L('Sem prioridade', 'No priority') })[task.priority]}</p>
        <h3>{L('Responsáveis humanos', 'Human assignees')}</h3><p>{task.assigneeIds.map(id => data.members.find(member => member.id === id)?.name ?? L('Responsável indisponível', 'Unavailable assignee')).join(', ') || L('Nenhum', 'None')}</p>
        <h3>{L('Projeto', 'Project')}</h3><ProjectChip project={project} />
        <h3>{L('Etiquetas', 'Labels')}</h3><div className="tasks-labels">{task.labelIds.length ? task.labelIds.map(id => { const label = data.labels.find(label => label.id === id); return label && <span className="tasks-label" key={id}><i style={{ backgroundColor: label.color }} />{label.name}</span> }) : L('Nenhuma', 'None')}</div>
        <h3>{L('Prazo', 'Due date')}</h3><p>{task.dueAt ? <time dateTime={task.dueAt}>{dateText(task.dueAt)}</time> : L('Sem prazo', 'No due date')}</p>
        {task.parentTaskId && <><h3>{L('Tarefa pai', 'Parent task')}</h3><p>{task.parentTaskId}</p></>}
        {!!task.relations?.length && <><h3>{L('Relações', 'Relations')}</h3><ul className="tasks-relations">{task.relations?.map(relation => <li key={`${relation.type}:${relation.direction}:${relation.taskId}`}><span>{relation.type === 'blocks' ? relation.direction === 'outgoing' ? L('Bloqueia', 'Blocks') : L('Bloqueada por', 'Blocked by') : relation.type === 'duplicate' ? L('Duplicada de', 'Duplicate of') : L('Relacionada a', 'Related to')}</span> <strong>{relation.identifier}</strong></li>)}</ul></>}
        <h3>{L('Agentes do Tucano', 'Tucano agents')}</h3>
        {(['executor', 'reviewer'] satisfies TaskAgentRole[]).map(role => {
          const assigned = detail.assignments[role]
          const current = agents.find(agent => agent.id === assigned)
          const unavailable = !!assigned && (!current || current.archived)
          return <div className="tasks-assignment" key={role}>
            <Field label={roleName(role)}><select aria-label={roleName(role)} value={assigned ?? ''} disabled={busy} onChange={event => void assign(role, event.target.value)}><option value="">{L('Sem atribuição', 'Unassigned')}</option>{unavailable && <option value={assigned} disabled>{current?.name ?? L('Agente indisponível', 'Unavailable agent')} · {L('indisponível', 'unavailable')}</option>}{agents.filter(agent => !agent.archived).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
            {current && !current.archived && <><button className="btn" disabled={busy} onClick={() => void start(role)}>{role === 'executor' ? L('Iniciar execução', 'Start execution') : L('Solicitar revisão', 'Request review')}</button><button className="text-btn" onClick={() => void openDm(current.id).catch(error => setError(failure(error)))}>{L('Abrir conversa', 'Open conversation')}</button></>}
          </div>
        })}
        <p className="tasks-activity-help">{L('Iniciar usa as permissões atuais do agente. Atribuir não muda acessos.', 'Starting uses the agent’s current permissions. Assignment does not change access.')}</p>
        {error && <p role="alert">{error}</p>}
        <div className="tasks-task-dates"><span>{L('Criada', 'Created')}: {dateText(task.createdAt)}</span><span>{L('Atualizada', 'Updated')}: {dateText(task.updatedAt)}</span></div>
      </aside>
        <section className="tasks-activity" aria-label={L('Atividade da tarefa', 'Task activity')}>
          <h3>{L('Atividade', 'Activity')}</h3>
          <CommentComposer source={source} taskId={taskId} onSave={comment => setComments(previous => [...previous, comment])} />
          <p className="tasks-activity-help">{L('Comentários e trabalho iniciado por esta tarefa. Encerrar uma execução não conclui a tarefa.', 'Comments and work started from this task in Tucano. Finishing a run does not complete the Task task.')}</p>
          {!activity.executions.length && !activity.items.length && <p className="tasks-empty">{L('Nenhuma execução vinculada a esta tarefa. Atribuir um agente não inicia trabalho.', 'No execution is linked to this task. Assigning an agent does not start work.')}</p>}
          {activity.executions.filter(execution => !activity.items.some(item => item.executionId === execution.id)).map(execution => <article className="tasks-event" key={execution.id}><strong>{execution.agentName}</strong><p>{execution.state === 'queued' ? L('Solicitação registrada · aguardando execução', 'Request recorded · awaiting execution') : execution.state === 'interrupted' ? L('Solicitação interrompida antes de iniciar', 'Request interrupted before starting') : L('Execução registrada · carregue a atividade para ver os passos', 'Execution recorded · load activity to see its steps')}</p><time>{dateText(execution.createdAt)}</time> <button className="text-btn" onClick={() => evidence(execution)}>{L('Abrir thread', 'Open thread')}</button></article>)}
          <div className="tasks-timeline">{timeline.map(entry => <div key={entry.id}>{entry.content}</div>)}</div>
          {!!activity.items.length && !activity.items.some(item => item.kind === 'report') && <p className="tasks-activity-help">{L('Nenhum relato estruturado fornecido nos itens carregados.', 'No structured report supplied in the loaded items.')}</p>}
          <div className="tasks-activity-more">{commentCursor && <button className="btn" disabled={busy} onClick={() => void moreComments()}>{L('Carregar mais comentários', 'Load more comments')}</button>}{activity.nextCursor && <button className="btn" disabled={busy} onClick={() => void moreActivity()}>{L('Carregar atividade anterior', 'Load earlier activity')}</button>}</div>
        </section>
    </div>}
  </div>
}
