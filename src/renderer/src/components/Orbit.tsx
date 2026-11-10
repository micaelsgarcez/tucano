import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L, locale } from '../../../shared/lang'
import type { OrbitActivity, OrbitActivityPage, OrbitAgentRole, OrbitBoardData, OrbitComment, OrbitExecution, OrbitProject, OrbitSource, OrbitStatus, OrbitTask, OrbitTaskDetail } from '../../../shared/orbit'
import type { Agent, RunStatus } from '../../../shared/types'
import { call } from '../rpc'
import { safeUrl } from '../links'
import { amOwner, navigate, openDm, openThread, useStore } from '../store'
import { Card, Field, Sheet } from './Pages'

const failure = (error: unknown): string => error instanceof Error ? error.message : L('Não foi possível carregar o Orbit.', 'Could not load Orbit.')
const roleName = (role: OrbitAgentRole): string => role === 'executor' ? L('Executor', 'Executor') : L('Revisor', 'Reviewer')
const agentName = (agents: Agent[], id: string | null): string => id ? agents.find(agent => agent.id === id)?.name ?? L('Agente indisponível', 'Unavailable agent') : L('Sem atribuição', 'Unassigned')
const dateText = (value: string | number): string => new Date(value).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })
const closed = (status?: OrbitStatus): boolean => !!status && ['completed', 'cancelled', 'duplicate'].includes(status.category)
const categoryOrder = ['unstarted', 'started', 'completed', 'cancelled', 'duplicate']

export function OrbitPage(): ReactNode {
  const owner = useStore(amOwner)
  return owner ? <OrbitConnection /> : <Sheet title={L('Projetos e tarefas', 'Projects and tasks')}><p>{L('Esta conexão está disponível apenas para o dono do Tucano.', 'This connection is available only to the Tucano owner.')}</p></Sheet>
}

function OrbitConnection(): ReactNode {
  const [source, setSource] = useState<OrbitSource | null>(null)
  const [ready, setReady] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    call('orbitSource').then(value => { if (active) { setSource(value); setReady(true) } }).catch(error => { if (active) setError(failure(error)) })
    return () => { active = false }
  }, [])
  return <Sheet fill title={L('Projetos e tarefas', 'Projects and tasks')} actions={source && <>
    <button className="btn" onClick={() => setEditing(!editing)}>{L('Conexão', 'Connection')}</button>
    <button className="btn" onClick={() => setRefresh(value => value + 1)}>{L('Atualizar', 'Refresh')}</button>
  </>}>
    <div className="orbit-workspace">
      {error && <p role="alert">{error}</p>}
      {!ready && !error && <p role="status">{L('Carregando…', 'Loading…')}</p>}
      {ready && (!source || editing) && <div className="orbit-connection"><OrbitConfig source={source} onSave={value => { setSource(value); setEditing(false); setRefresh(value => value + 1) }} /></div>}
      {source && <OrbitProjects key={`${source.id}:${refresh}`} source={source} />}
    </div>
  </Sheet>
}
function OrbitConfig({ source, onSave }: { source: OrbitSource | null; onSave: (source: OrbitSource) => void }): ReactNode {
  const [baseUrl, setBaseUrl] = useState(source?.baseUrl ?? '')
  const [workspaceId, setWorkspaceId] = useState(source?.workspaceId ?? '')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true); setError('')
    try { onSave(await call('orbitSaveSource', { baseUrl, workspaceId, token })) } catch (error) { setError(failure(error)) } finally { setToken(''); setBusy(false) }
  }
  return <Card title={L('Conectar ao Orbit', 'Connect to Orbit')} lead={L('Use um token com tasks:read e acesso aos projetos desejados. A conexão é somente sua; os agentes não recebem esse token.', 'Use a token with tasks:read and access to the desired projects. This connection is yours; agents do not receive this token.')}>
    <form className="orbit-config" onSubmit={event => void save(event)}>
      <Field label={L('Endereço do Orbit', 'Orbit address')}><input aria-label={L('Endereço do Orbit', 'Orbit address')} type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://orbit.example.com" required disabled={busy} /></Field>
      <Field label={L('UUID do workspace', 'Workspace UUID')}><input aria-label={L('UUID do workspace', 'Workspace UUID')} value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} required disabled={busy} /></Field>
      <Field label={L('Token de leitura', 'Read token')} hint={L('Informe o token ao salvar, inclusive ao trocar a conexão.', 'Enter the token when saving, including when changing the connection.')}><input aria-label={L('Token de leitura', 'Read token')} type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} required disabled={busy} /></Field>
      {error && <p role="alert">{error}</p>}
      <button className="btn btn--primary" disabled={busy}>{busy ? L('Salvando…', 'Saving…') : L('Salvar conexão', 'Save connection')}</button>
    </form>
  </Card>
}

function OrbitProjects({ source }: { source: OrbitSource }): ReactNode {
  const [data, setData] = useState<OrbitBoardData | null>(null)
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    call('orbitBoardData', { sourceId: source.id }).then(value => { if (active) setData(value) }).catch(error => { if (active) setError(failure(error)) })
    return () => { active = false }
  }, [source.id])
  if (error) return <p role="alert">{error}</p>
  if (!data) return <p role="status">{L('Carregando projetos…', 'Loading projects…')}</p>
  if (!data.projects.length) return <p>{L('Nenhum projeto disponível para este token.', 'No projects available to this token.')}</p>
  return <OrbitTasks key={projectId} source={source} data={data} projectId={projectId} onProject={setProjectId} />
}

function StatusIcon({ status }: { status?: OrbitStatus }): ReactNode {
  return <span className={`orbit-status-icon ${status ? `is-${status.category}` : ''}`} style={{ color: status?.color }} aria-hidden="true">{status?.category === 'completed' ? '✓' : status?.category === 'cancelled' || status?.category === 'duplicate' ? '×' : status?.category === 'started' ? '◐' : '○'}</span>
}
function Priority({ priority }: { priority: OrbitTask['priority'] }): ReactNode {
  const names = { urgent: L('Urgente', 'Urgent'), high: L('Alta', 'High'), medium: L('Média', 'Medium'), low: L('Baixa', 'Low'), none: L('Sem prioridade', 'No priority') }
  return <span className={`orbit-priority is-${priority}`} aria-label={names[priority]} title={names[priority]}>{priority === 'urgent' ? '!' : priority === 'none' ? '—' : <span aria-hidden="true">{[1, 2, 3].map(level => <i key={level} style={{ height: 3 + level * 3, opacity: level <= ({ low: 1, medium: 2, high: 3 }[priority]) ? 1 : .2 }} />)}</span>}</span>
}
function ProjectChip({ project }: { project?: OrbitProject }): ReactNode {
  return <span className="orbit-project-chip"><i style={{ backgroundColor: project?.color }} />{project?.name ?? L('Projeto indisponível', 'Unavailable project')}</span>
}
function TaskMarkdown({ text }: { text: string }): ReactNode {
  return <div className="md orbit-markdown"><Markdown urlTransform={safeUrl} remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{alt}</span> }}>{text}</Markdown></div>
}

function OrbitTasks({ source, data, projectId, onProject }: { source: OrbitSource; data: OrbitBoardData; projectId: string; onProject: (id: string) => void }): ReactNode {
  const [items, setItems] = useState<OrbitTaskDetail[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState('')
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
    call('orbitTasks', { sourceId: source.id, projectId: projectId || null }).then(page => {
      if (active.current) { setItems(page.items); setCursor(page.nextCursor) }
    }).catch(error => { if (active.current) setError(failure(error)) }).finally(() => { if (active.current) setLoading(false) })
    return () => { active.current = false }
  }, [source.id, projectId])
  async function more(): Promise<void> {
    if (!cursor || loading) return
    setLoading(true); setError('')
    try {
      const page = await call('orbitTasks', { sourceId: source.id, projectId: projectId || null, cursor })
      if (!active.current) return
      seen.current.add(cursor)
      if (page.nextCursor && seen.current.has(page.nextCursor)) throw new Error(L('O Orbit repetiu uma página. Atualize para tentar novamente.', 'Orbit repeated a page. Refresh to try again.'))
      setItems(previous => [...previous.filter(item => !page.items.some(next => next.task.id === item.task.id)), ...page.items])
      setCursor(page.nextCursor)
    } catch (error) { if (active.current) { setError(failure(error)); setItems([]); setCursor(null) } } finally { if (active.current) setLoading(false) }
  }
  if (selected) return <OrbitDetail key={selected} source={source} taskId={selected} data={data} onBack={() => setSelected('')} onChange={detail => setItems(previous => previous.map(item => item.task.id === detail.task.id ? detail : item))} />
  const statuses = data.statuses.filter(status => !projectId || status.projectId === projectId).toSorted((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) || a.position - b.position)
  const groups = new Map<string, { status?: OrbitStatus; statusIds: string[]; tasks: OrbitTaskDetail[] }>()
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
    <div className="orbit-toolbar">
      <select aria-label={L('Projeto', 'Project')} value={projectId} onChange={event => onProject(event.target.value)}><option value="">{L('Todos os projetos', 'All projects')}</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <input className="orbit-search" type="search" aria-label={L('Buscar nas tarefas carregadas', 'Search loaded tasks')} placeholder={L('Buscar tarefas…', 'Search tasks…')} value={query} onChange={event => setQuery(event.target.value)} />
      <span>{L('Mais recentes primeiro', 'Newest first')}</span>
    </div>
    <div className="orbit-board-state" aria-live="polite">{cursor ? L(`${items.length} tarefas carregadas · contagens parciais`, `${items.length} tasks loaded · partial counts`) : L(`${items.length} tarefas`, `${items.length} tasks`)}{query && ` · ${L(`${shown.length} encontradas`, `${shown.length} matches`)}`}</div>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">{L('Carregando tarefas…', 'Loading tasks…')}</p>}
    {!loading && !error && !shown.length && <p className="orbit-empty">{L('Nenhuma tarefa encontrada.', 'No tasks found.')}</p>}
    <div className="orbit-board" aria-label={L('Quadro de tarefas', 'Task board')} tabIndex={0}>
      {[...groups].map(([key, group]) => <section className="orbit-column" key={key} aria-label={group.status?.name ?? L('Status indisponível', 'Unavailable status')}>
        <header><StatusIcon status={group.status} /><h2>{group.status?.name ?? L('Status indisponível', 'Unavailable status')}</h2><span title={cursor ? L('Tarefas carregadas nesta coluna', 'Loaded tasks in this column') : undefined}>{group.tasks.length}</span></header>
        <div className="orbit-column-cards">{group.tasks.map(({ task, assignments }) => {
          const project = data.projects.find(project => project.id === task.projectId)
          const status = data.statuses.find(status => status.id === task.statusId)
          const due = task.dueAt && new Date(task.dueAt)
          const overdue = due && due.getTime() < Date.now() && !closed(status)
          return <button className="orbit-task" key={task.id} ref={node => { if (node) cards.current.set(task.id, node); else cards.current.delete(task.id) }} onClick={() => { lastSelected.current = task.id; setSelected(task.id) }}>
            <span className="orbit-card-head"><span><StatusIcon status={status} />{task.identifier}</span><span className="orbit-card-people">{task.assigneeIds.map(id => { const name = data.members.find(member => member.id === id)?.name ?? L('Responsável indisponível', 'Unavailable assignee'); return <span className="orbit-human-avatar" key={id} title={name} aria-label={name}>{name.slice(0, 1)}</span> })}<Priority priority={task.priority} /></span></span>
            <strong>{task.title}</strong>
            {!!task.labelIds.length && <span className="orbit-labels">{task.labelIds.map(id => { const label = data.labels.find(label => label.id === id); return label && <span className="orbit-label" key={id}><i style={{ backgroundColor: label.color }} />{label.name}</span> })}</span>}
            <span className="orbit-card-footer"><ProjectChip project={project} />{due && <time dateTime={task.dueAt ?? undefined} title={dateText(task.dueAt ?? '')} className={overdue ? 'is-overdue' : ''}>▦ {due.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })}</time>}</span>
            <span className="orbit-card-agents">{(['executor', 'reviewer'] satisfies OrbitAgentRole[]).map(role => <span key={role}><span>{roleName(role)}</span><b>{agentName(agents, assignments[role])}</b></span>)}</span>
          </button>
        })}</div>
      </section>)}
    </div>
    {cursor && <div className="orbit-more"><button className="btn" onClick={() => void more()} disabled={loading}>{L('Carregar mais tarefas', 'Load more tasks')}</button></div>}
  </>
}

function evidence(execution: Pick<OrbitExecution, 'conversationId' | 'rootMessageId'>): void {
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
function ActivityEntry({ item }: { item: OrbitActivity }): ReactNode {
  return <article className={`orbit-event is-${item.kind}`}>
    <div className="orbit-event-heading"><strong>{item.agentName}</strong><span>{roleName(item.role)} · {item.kind === 'report' ? L('Relato do agente', 'Agent report') : L('Execução observada', 'Observed execution')}</span><time dateTime={new Date(item.at).toISOString()}>{dateText(item.at)}</time></div>
    {item.kind === 'report' ? <dl className="orbit-report">
      <dt>{L('Ação', 'Action')}</dt><dd>{item.action}</dd>
      <dt>{L('Resultado', 'Result')}</dt><dd>{item.result}</dd>
      <dt>{L('Evidência', 'Evidence')}</dt><dd>{item.evidence.stepIds.length ? L(`Passos vinculados ao relato: ${item.evidence.stepIds.length}`, `Steps linked to this report: ${item.evidence.stepIds.length}`) : L('Relato sem passos de ferramenta vinculados.', 'Report without linked tool steps.')} <button className="text-btn" onClick={() => evidence(item.evidence)} title={item.evidence.messageId}>{L('Ver execução', 'View execution')}</button></dd>
      <dt>{L('Próximo passo', 'Next step')}</dt><dd>{item.nextStep}</dd>
    </dl> : <>
      <p className="orbit-run-state">{runLabel(item.status)}</p>
      <p>{L(`Passos encerrados: ${item.steps.filter(step => step.status === 'done').length} · Com falha: ${item.steps.filter(step => step.status === 'error').length}`, `Finished steps: ${item.steps.filter(step => step.status === 'done').length} · Failed: ${item.steps.filter(step => step.status === 'error').length}`)}</p>
      <button className="text-btn" onClick={() => evidence(item.evidence)} title={item.evidence.messageId}>{L('Ver execução', 'View execution')}</button>
    </>}
  </article>
}

function OrbitDetail({ source, taskId, data, onBack, onChange }: { source: OrbitSource; taskId: string; data: OrbitBoardData; onBack: () => void; onChange: (detail: OrbitTaskDetail) => void }): ReactNode {
  const [detail, setDetail] = useState<OrbitTaskDetail | null>(null)
  const [comments, setComments] = useState<OrbitComment[]>([])
  const [commentCursor, setCommentCursor] = useState<string | null>(null)
  const [activity, setActivity] = useState<OrbitActivityPage>({ items: [], executions: [], nextCursor: null, headCursor: null })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef(true)
  const seenComments = useRef(new Set<string>())
  const seenActivity = useRef(new Set<string>())
  const readingActivity = useRef(false)
  const requests = useRef<Partial<Record<OrbitAgentRole, string>>>({})
  const heading = useRef<HTMLHeadingElement>(null)
  const agents = useStore(state => state.agents)
  function fail(error: unknown): void {
    if (active.current) { setError(failure(error)); setDetail(null); setComments([]); setActivity({ items: [], executions: [], nextCursor: null, headCursor: null }) }
  }
  function mergeActivity(page: OrbitActivityPage, older: boolean): void {
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
        const page = await call('orbitActivity', { sourceId: source.id, taskId })
        if (active.current) { mergeActivity(page, false); timer = setTimeout(() => void refresh(), 10000) }
      } catch (error) { fail(error) } finally { readingActivity.current = false }
    }
    Promise.all([call('orbitTask', { sourceId: source.id, taskId }), call('orbitComments', { sourceId: source.id, taskId }), call('orbitActivity', { sourceId: source.id, taskId })]).then(([value, comments, activity]) => {
      if (active.current) { setDetail(value); setComments(comments.items); setCommentCursor(comments.nextCursor); setActivity(activity); timer = setTimeout(() => void refresh(), 10000) }
    }).catch(fail)
    return () => { active.current = false; if (timer) clearTimeout(timer) }
  }, [source.id, taskId])
  useEffect(() => { heading.current?.focus() }, [detail?.task.id])
  async function assign(role: OrbitAgentRole, agentId: string): Promise<void> {
    setBusy(true); setError('')
    try {
      const value = await call('orbitAssignAgent', { sourceId: source.id, taskId, role, agentId: agentId || null })
      if (active.current) { delete requests.current[role]; setDetail(value); onChange(value) }
    } catch (error) { fail(error) } finally { if (active.current) setBusy(false) }
  }
  async function start(role: OrbitAgentRole): Promise<void> {
    setBusy(true); setError('')
    const requestId = requests.current[role] ?? crypto.randomUUID()
    requests.current[role] = requestId
    try {
      const execution = await call('orbitStart', { sourceId: source.id, taskId, role, requestId })
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
      const page = await call('orbitComments', { sourceId: source.id, taskId, cursor: commentCursor })
      if (!active.current) return
      seenComments.current.add(commentCursor)
      if (page.nextCursor && seenComments.current.has(page.nextCursor)) throw new Error(L('O Orbit repetiu uma página de comentários.', 'Orbit repeated a comment page.'))
      setComments(previous => [...previous.filter(item => !page.items.some(next => next.id === item.id)), ...page.items]); setCommentCursor(page.nextCursor)
    } catch (error) { fail(error) } finally { if (active.current) setBusy(false) }
  }
  async function moreActivity(): Promise<void> {
    if (!activity.nextCursor || busy || readingActivity.current) return
    setBusy(true); readingActivity.current = true
    try {
      const page = await call('orbitActivity', { sourceId: source.id, taskId, cursor: activity.nextCursor })
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
    ...comments.map(comment => ({ id: `comment:${comment.id}`, at: Date.parse(comment.createdAt), content: <article className="orbit-event is-comment"><div className="orbit-event-heading"><strong>{comment.serviceAccount?.name ?? data.members.find(member => member.id === comment.authorId)?.name ?? L('Autor indisponível', 'Unavailable author')}</strong><span>{L('Comentário do Orbit', 'Orbit comment')}{comment.serviceAccount && ` · ${L('conta de serviço', 'service account')}`}</span><time dateTime={comment.createdAt}>{dateText(comment.createdAt)}</time></div>{comment.parentId && <p className="orbit-reply-label">{L('Resposta a um comentário', 'Reply to a comment')}</p>}<TaskMarkdown text={comment.body} /></article> })),
    ...activity.items.map(item => ({ id: item.id, at: item.at, content: <ActivityEntry item={item} /> }))
  ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  return <div className="orbit-detail-page">
    <div className="orbit-detail-nav"><button className="text-btn" onClick={onBack}>← {L('Voltar ao quadro', 'Back to board')}</button>{task && <span><ProjectChip project={project} /> <span aria-hidden="true">›</span> {task.identifier}</span>}</div>
    {!detail || !task ? <p role={error ? 'alert' : 'status'}>{error || L('Carregando tarefa…', 'Loading task…')}</p> : <div className="orbit-detail-layout">
      <main className="orbit-detail-main">
        <h2 ref={heading} tabIndex={-1}>{task.title}</h2>
        <TaskMarkdown text={task.description || L('Sem descrição.', 'No description.')} />

      </main>
      <aside className="orbit-properties" aria-label={L('Propriedades da tarefa', 'Task properties')}>
        <h3>{L('Propriedades', 'Properties')}</h3>
        <p><StatusIcon status={status} /> {status?.name ?? L('Status indisponível', 'Unavailable status')}</p>
        <p><Priority priority={task.priority} /> {({ urgent: L('Urgente', 'Urgent'), high: L('Prioridade alta', 'High priority'), medium: L('Prioridade média', 'Medium priority'), low: L('Prioridade baixa', 'Low priority'), none: L('Sem prioridade', 'No priority') })[task.priority]}</p>
        <h3>{L('Responsáveis humanos no Orbit', 'Human assignees in Orbit')}</h3><p>{task.assigneeIds.map(id => data.members.find(member => member.id === id)?.name ?? L('Responsável indisponível', 'Unavailable assignee')).join(', ') || L('Nenhum', 'None')}</p>
        <h3>{L('Projeto', 'Project')}</h3><ProjectChip project={project} />
        <h3>{L('Etiquetas', 'Labels')}</h3><div className="orbit-labels">{task.labelIds.length ? task.labelIds.map(id => { const label = data.labels.find(label => label.id === id); return label && <span className="orbit-label" key={id}><i style={{ backgroundColor: label.color }} />{label.name}</span> }) : L('Nenhuma', 'None')}</div>
        <h3>{L('Prazo', 'Due date')}</h3><p>{task.dueAt ? <time dateTime={task.dueAt}>{dateText(task.dueAt)}</time> : L('Sem prazo', 'No due date')}</p>
        <h3>{L('Agentes do Tucano', 'Tucano agents')}</h3>
        {(['executor', 'reviewer'] satisfies OrbitAgentRole[]).map(role => {
          const assigned = detail.assignments[role]
          const current = agents.find(agent => agent.id === assigned)
          const unavailable = !!assigned && (!current || current.archived)
          return <div className="orbit-assignment" key={role}>
            <Field label={roleName(role)}><select aria-label={roleName(role)} value={assigned ?? ''} disabled={busy} onChange={event => void assign(role, event.target.value)}><option value="">{L('Sem atribuição', 'Unassigned')}</option>{unavailable && <option value={assigned} disabled>{current?.name ?? L('Agente indisponível', 'Unavailable agent')} · {L('indisponível', 'unavailable')}</option>}{agents.filter(agent => !agent.archived).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
            {current && !current.archived && <><button className="btn" disabled={busy} onClick={() => void start(role)}>{role === 'executor' ? L('Iniciar execução', 'Start execution') : L('Solicitar revisão', 'Request review')}</button><button className="text-btn" onClick={() => void openDm(current.id).catch(error => setError(failure(error)))}>{L('Abrir conversa', 'Open conversation')}</button></>}
          </div>
        })}
        <p className="orbit-activity-help">{L('Iniciar usa as permissões atuais do agente. Atribuir não muda acessos.', 'Starting uses the agent’s current permissions. Assignment does not change access.')}</p>
        {error && <p role="alert">{error}</p>}
        <div className="orbit-task-dates"><span>{L('Criada', 'Created')}: {dateText(task.createdAt)}</span><span>{L('Atualizada', 'Updated')}: {dateText(task.updatedAt)}</span></div>
      </aside>
        <section className="orbit-activity" aria-label={L('Atividade da tarefa', 'Task activity')}>
          <h3>{L('Atividade', 'Activity')}</h3>
          <p className="orbit-activity-help">{L('Comentários do Orbit e trabalho iniciado por esta tarefa no Tucano. Encerrar uma execução não conclui a tarefa no Orbit.', 'Orbit comments and work started from this task in Tucano. Finishing a run does not complete the Orbit task.')}</p>
          {!activity.executions.length && !activity.items.length && <p className="orbit-empty">{L('Nenhuma execução vinculada a esta tarefa. Atribuir um agente não inicia trabalho.', 'No execution is linked to this task. Assigning an agent does not start work.')}</p>}
          {activity.executions.filter(execution => !activity.items.some(item => item.executionId === execution.id)).map(execution => <article className="orbit-event" key={execution.id}><strong>{execution.agentName}</strong><p>{execution.state === 'queued' ? L('Solicitação registrada · aguardando execução', 'Request recorded · awaiting execution') : execution.state === 'interrupted' ? L('Solicitação interrompida antes de iniciar', 'Request interrupted before starting') : L('Execução registrada · carregue a atividade para ver os passos', 'Execution recorded · load activity to see its steps')}</p><time>{dateText(execution.createdAt)}</time> <button className="text-btn" onClick={() => evidence(execution)}>{L('Abrir thread', 'Open thread')}</button></article>)}
          <div className="orbit-timeline">{timeline.map(entry => <div key={entry.id}>{entry.content}</div>)}</div>
          {!!activity.items.length && !activity.items.some(item => item.kind === 'report') && <p className="orbit-activity-help">{L('Nenhum relato estruturado fornecido nos itens carregados.', 'No structured report supplied in the loaded items.')}</p>}
          <div className="orbit-activity-more">{commentCursor && <button className="btn" disabled={busy} onClick={() => void moreComments()}>{L('Carregar mais comentários', 'Load more comments')}</button>}{activity.nextCursor && <button className="btn" disabled={busy} onClick={() => void moreActivity()}>{L('Carregar atividade anterior', 'Load earlier activity')}</button>}</div>
          <p className="orbit-activity-help">{L('O histórico completo de alterações do Orbit não está disponível nesta conexão.', 'Orbit’s full change history is not available through this connection.')}</p>
        </section>
    </div>}
  </div>
}
