import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L } from '../../../shared/lang'
import type { OrbitAgentRole, OrbitProject, OrbitProjectData, OrbitSource, OrbitTaskDetail } from '../../../shared/orbit'
import { call } from '../rpc'
import { safeUrl } from '../links'
import { amOwner, openDm, useStore } from '../store'
import { Card, Field, Sheet } from './Pages'

const failure = (error: unknown): string => error instanceof Error ? error.message : L('Não foi possível carregar o Orbit.', 'Could not load Orbit.')

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
  return <Sheet title={L('Projetos e tarefas', 'Projects and tasks')} lede={L('Tarefas do Orbit e responsabilidades dos agentes do Tucano.', 'Orbit tasks and responsibilities for Tucano agents.')} actions={source && <>
    <button className="btn" onClick={() => setEditing(!editing)}>{L('Conexão', 'Connection')}</button>
    <button className="btn" onClick={() => setRefresh(value => value + 1)}>{L('Atualizar', 'Refresh')}</button>
  </>}>
    {error && <p role="alert">{error}</p>}
    {!ready && !error && <p role="status">{L('Carregando…', 'Loading…')}</p>}
    {ready && (!source || editing) && <OrbitConfig source={source} onSave={value => { setSource(value); setEditing(false); setRefresh(value => value + 1) }} />}
    {source && <>
      <p className="orbit-source">Orbit · {source.baseUrl} · {L('Identidade de leitura do dono · atualização manual', 'Owner’s read identity · manual refresh')}</p>
      <OrbitProjects key={`${source.id}:${refresh}`} source={source} />
    </>}
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
  const [projects, setProjects] = useState<OrbitProject[]>([])
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    call('orbitProjects', { sourceId: source.id }).then(items => {
      if (active) { setProjects(items); setProjectId(items[0]?.id ?? '') }
    }).catch(error => { if (active) setError(failure(error)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [source.id])
  return <>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">{L('Carregando projetos…', 'Loading projects…')}</p>}
    {!loading && !error && !projects.length && <p>{L('Nenhum projeto disponível para este token.', 'No projects available to this token.')}</p>}
    {!!projects.length && <Field label={L('Projeto', 'Project')}><select aria-label={L('Projeto', 'Project')} value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.key} · {project.name}</option>)}</select></Field>}
    {projectId && <OrbitTasks key={projectId} source={source} projectId={projectId} />}
  </>
}

function OrbitTasks({ source, projectId }: { source: OrbitSource; projectId: string }): ReactNode {
  const [data, setData] = useState<OrbitProjectData>({ statuses: [], members: [] })
  const [items, setItems] = useState<OrbitTaskDetail[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const active = useRef(true)
  const seenCursors = useRef(new Set<string>())
  useEffect(() => {
    active.current = true
    Promise.all([call('orbitProjectData', { sourceId: source.id, projectId }), call('orbitTasks', { sourceId: source.id, projectId })]).then(([data, page]) => {
      if (active.current) { setData(data); setItems(page.items); setCursor(page.nextCursor) }
    }).catch(error => { if (active.current) setError(failure(error)) }).finally(() => { if (active.current) setLoading(false) })
    return () => { active.current = false }
  }, [source.id, projectId])
  async function more(): Promise<void> {
    if (!cursor || loading) return
    setLoading(true); setError('')
    try {
      const page = await call('orbitTasks', { sourceId: source.id, projectId, cursor })
      if (!active.current) return
      seenCursors.current.add(cursor)
      if (page.nextCursor && seenCursors.current.has(page.nextCursor)) throw new Error(L('O Orbit repetiu uma página. Atualize para tentar novamente.', 'Orbit repeated a page. Refresh to try again.'))
      setItems(previous => [...previous.filter(item => !page.items.some(next => next.task.id === item.task.id)), ...page.items])
      setCursor(page.nextCursor)
    } catch (error) { if (active.current) { setError(failure(error)); setCursor(null) } } finally { if (active.current) setLoading(false) }
  }
  const agents = useStore(state => state.agents)
  const agentName = (id: string | null): string => id ? agents.find(agent => agent.id === id)?.name ?? L('Agente indisponível', 'Unavailable agent') : L('Sem atribuição', 'Unassigned')
  return <>
    {error && <p role="alert">{error}</p>}
    <div className="orbit-columns">
      <section aria-label={L('Tarefas do projeto', 'Project tasks')} className="orbit-task-list">
        <div className="orbit-statuses">{data.statuses.map(status => <span key={status.id}>{status.name}</span>)}</div>
        {!items.length && !loading && !error && <p>{L('Nenhuma tarefa neste projeto.', 'No tasks in this project.')}</p>}
        {items.map(({ task, assignments }) => <button className={`orbit-task ${selected === task.id ? 'is-selected' : ''}`} key={task.id} onClick={() => setSelected(task.id)} aria-pressed={selected === task.id}>
          <span>{task.identifier} · {data.statuses.find(status => status.id === task.statusId)?.name ?? task.statusId}</span>
          <strong>{task.title}</strong>
          <span>{L('Executor', 'Executor')}: {agentName(assignments.executor)} · {L('Revisor', 'Reviewer')}: {agentName(assignments.reviewer)}</span>
        </button>)}
        {loading && <p role="status">{L('Carregando tarefas…', 'Loading tasks…')}</p>}
        {cursor && <button className="btn" onClick={() => void more()} disabled={loading}>{L('Carregar mais', 'Load more')}</button>}
      </section>
      <section className="orbit-detail" aria-label={L('Detalhes da tarefa', 'Task details')}>
        {selected ? <OrbitDetail key={selected} source={source} taskId={selected} projectId={projectId} data={data} onChange={detail => setItems(previous => previous.map(item => item.task.id === detail.task.id ? detail : item))} /> : <p>{L('Selecione uma tarefa para ver os detalhes e atribuir agentes.', 'Select a task to see its details and assign agents.')}</p>}
      </section>
    </div>
  </>
}

function OrbitDetail({ source, taskId, projectId, data, onChange }: { source: OrbitSource; taskId: string; projectId: string; data: OrbitProjectData; onChange: (detail: OrbitTaskDetail) => void }): ReactNode {
  const [detail, setDetail] = useState<OrbitTaskDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef(true)
  const agents = useStore(state => state.agents)
  useEffect(() => {
    active.current = true
    call('orbitTask', { sourceId: source.id, taskId }).then(value => { if (active.current) setDetail(value) }).catch(error => { if (active.current) setError(failure(error)) })
    return () => { active.current = false }
  }, [source.id, taskId])
  async function assign(role: OrbitAgentRole, agentId: string): Promise<void> {
    setBusy(true); setError('')
    try {
      const value = await call('orbitAssignAgent', { sourceId: source.id, taskId, role, agentId: agentId || null })
      if (active.current) { setDetail(value); onChange(value) }
    } catch (error) { if (active.current) { setError(failure(error)); setDetail(null) } } finally { if (active.current) setBusy(false) }
  }
  if (!detail) return <p role={error ? 'alert' : 'status'}>{error || L('Carregando tarefa…', 'Loading task…')}</p>
  const moved = detail.task.projectId !== projectId
  return <>
    <p>{detail.task.identifier} · {data.statuses.find(status => status.id === detail.task.statusId)?.name ?? detail.task.statusId}</p>
    <h2>{detail.task.title}</h2>
    {moved && <p role="status">{L('A tarefa mudou de projeto no Orbit. Atualize a lista para acompanhar a mudança.', 'The task moved to another Orbit project. Refresh the list to follow the change.')}</p>}
    <p><strong>{L('Responsáveis humanos no Orbit', 'Human assignees in Orbit')}: </strong>{detail.task.assigneeIds.map(id => data.members.find(member => member.id === id)?.name ?? id).join(', ') || L('Nenhum', 'None')}</p>
    <div className="md"><Markdown urlTransform={safeUrl} remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{alt}</span> }}>{detail.task.description || L('Sem descrição.', 'No description.')}</Markdown></div>
    <h3>{L('Agentes do Tucano', 'Tucano agents')}</h3>
    <p>{L('Atribuição de responsabilidade. Nenhuma execução vinculada a esta tarefa. Atribuir não inicia trabalho nem muda permissões.', 'Responsibility assignment. No execution is linked to this task. Assigning does not start work or change permissions.')}</p>
    {(['executor', 'reviewer'] satisfies OrbitAgentRole[]).map(role => {
      const assigned = detail.assignments[role]
      const current = agents.find(agent => agent.id === assigned)
      const unavailable = !!assigned && (!current || current.archived)
      const label = role === 'executor' ? L('Executor', 'Executor') : L('Revisor', 'Reviewer')
      return <div className="orbit-assignment" key={role}>
        <Field label={label}><select aria-label={label} value={assigned ?? ''} disabled={busy} onChange={event => void assign(role, event.target.value)}>
          <option value="">{L('Sem atribuição', 'Unassigned')}</option>
          {unavailable && <option value={assigned} disabled>{current?.name ?? assigned} · {current?.archived ? L('arquivado', 'archived') : L('indisponível', 'unavailable')}</option>}
          {agents.filter(agent => !agent.archived).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select></Field>
        {current && !current.archived && <button className="text-btn" onClick={() => void openDm(current.id).catch(error => setError(failure(error)))}>{L('Abrir conversa', 'Open conversation')}</button>}
      </div>
    })}
    {error && <p role="alert">{error}</p>}
  </>
}
