import { useEffect, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L } from '../../../shared/lang'
import type { KnowledgeEntry, KnowledgePage, KnowledgeProject, KnowledgeRef, KnowledgeSource } from '../../../shared/knowledge'
import { safeUrl } from '../links'
import { call } from '../rpc'
import { Sheet } from './Pages'

type Read<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T }
const failure = (error: unknown): string => error instanceof Error ? error.message : L('Não foi possível carregar.', 'Could not load.')
const loading = (): ReactNode => <p role="status">{L('Carregando ai-memory…', 'Loading ai-memory…')}</p>

// This view owns only temporary display state. The source and its credential live in the core.
export function KnowledgeView({ back }: { back: () => void }): ReactNode {
  const [source, setSource] = useState<Read<KnowledgeSource | null>>({ state: 'loading' })
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    let live = true
    setSource({ state: 'loading' })
    void call('knowledgeSource').then((value) => { if (live) setSource({ state: 'ready', value }) }, (error: unknown) => { if (live) setSource({ state: 'error', message: failure(error) }) })
    return () => { live = false }
  }, [revision])
  const current = source.state === 'ready' ? source.value : null
  return <Sheet title={L('Conhecimento · ai-memory', 'Knowledge · ai-memory')} lede={L('Páginas e decisões por projeto, lidas direto do ai-memory.', 'Pages and decisions by project, read directly from ai-memory.')} back={{ label: L('Wiki do Tucano', 'Tucano Wiki'), onClick: back }} actions={<>
    <button className="btn btn--ghost" onClick={() => { setEditing(false); setSource({ state: 'loading' }); setRevision((r) => r + 1) }}>{L('Atualizar', 'Refresh')}</button>
    {current && !editing && <button className="btn btn--ghost" onClick={() => setEditing(true)}>{L('Configurar fonte', 'Configure source')}</button>}
  </>}>
    <div className="knowledge">
      {source.state === 'loading' ? loading() : source.state === 'error' ? <p role="alert">{source.message}</p> : editing || !source.value ? <SourceForm source={source.value} saved={(value) => { setSource({ state: 'ready', value }); setEditing(false) }} cancel={source.value ? () => setEditing(false) : undefined} /> : <Projects key={`${source.value.id}:${revision}`} source={source.value} />}
    </div>
  </Sheet>
}

function SourceForm({ source, saved, cancel }: { source: KnowledgeSource | null; saved: (source: KnowledgeSource | null) => void; cancel?: () => void }): ReactNode {
  const [name, setName] = useState(source?.name ?? 'ai-memory')
  const [baseUrl, setBaseUrl] = useState(source?.baseUrl ?? '')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <form className="knowledge__form" onSubmit={(event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    void call('saveKnowledgeSource', { name, baseUrl, token }).then((value) => { setToken(''); saved(value) }, (e: unknown) => setError(failure(e))).finally(() => setBusy(false))
  }}>
    <h2>{source ? L('Configurar fonte', 'Configure source') : L('Conectar ai-memory', 'Connect ai-memory')}</h2>
    <p>{L('Use a URL acessível pelo servidor do Tucano e um token de leitura do ai-memory. A API HTTP precisa estar habilitada. Salvar substitui a conexão anterior.', 'Use a URL reachable by the Tucano server and an ai-memory read token. The HTTP API must be enabled. Saving replaces the previous connection.')}</p>
    <label className="field">{L('Nome', 'Name')}<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} /></label>
    <label className="field">{L('URL do serviço', 'Service URL')}<input required type="url" maxLength={2048} placeholder="https://memory.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy} /></label>
    <label className="field">{L('Token de leitura', 'Read token')}<input required type="password" autoComplete="new-password" maxLength={8192} value={token} onChange={(e) => setToken(e.target.value)} disabled={busy} /></label>
    <p className="hint">{L('O token fica no cofre do Tucano. Não concede acesso aos agentes.', 'The token stays in the Tucano vault. It does not grant access to agents.')}</p>
    {error && <p role="alert" className="field__error">{error}</p>}
    <div className="knowledge__actions">
      <button className="btn" disabled={busy}>{busy ? L('Salvando…', 'Saving…') : L('Salvar conexão', 'Save connection')}</button>
      {cancel && <button type="button" className="btn btn--ghost" disabled={busy} onClick={cancel}>{L('Cancelar', 'Cancel')}</button>}
      {source && <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => {
        setBusy(true)
        setToken('')
        void call('removeKnowledgeSource', { sourceId: source.id }).then(() => saved(null), (e: unknown) => setError(failure(e))).finally(() => setBusy(false))
      }}>{L('Desconectar fonte', 'Disconnect source')}</button>}
    </div>
  </form>
}

function Projects({ source }: { source: KnowledgeSource }): ReactNode {
  const [projects, setProjects] = useState<Read<KnowledgeProject[]>>({ state: 'loading' })
  const [selected, setSelected] = useState('')
  useEffect(() => {
    let live = true
    void call('knowledgeProjects', { sourceId: source.id }).then((value) => { if (live) setProjects({ state: 'ready', value }) }, (e: unknown) => { if (live) setProjects({ state: 'error', message: failure(e) }) })
    return () => { live = false }
  }, [source.id])
  const projectKey = (project: KnowledgeProject): string => JSON.stringify([project.workspace, project.project])
  const current = projects.state === 'ready' ? projects.value.find((p) => projectKey(p) === selected) ?? projects.value[0] : undefined
  return <>
    <div className="knowledge__origin"><strong>{source.name}</strong><span>{source.baseUrl} · {L('Somente leitura', 'Read only')}</span></div>
    {projects.state === 'loading' ? loading() : projects.state === 'error' ? <p role="alert">{projects.message}</p> : !current ? <p>{L('Nenhum projeto visível para esta credencial.', 'No projects are visible to this credential.')}</p> : <>
      <label className="field">{L('Workspace / projeto', 'Workspace / project')}<select aria-label={L('Workspace / projeto', 'Workspace / project')} value={projectKey(current)} onChange={(e) => setSelected(e.target.value)}>{projects.value.map((project) => <option key={projectKey(project)} value={projectKey(project)}>{project.workspace} / {project.project} ({project.pages})</option>)}</select></label>
      <ProjectPages key={projectKey(current)} project={current} source={source} />
    </>}
  </>
}

function ProjectPages({ project, source }: { project: KnowledgeProject; source: KnowledgeSource }): ReactNode {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [revision, setRevision] = useState(0)
  const [entries, setEntries] = useState<Read<KnowledgeEntry[]>>({ state: 'loading' })
  const [page, setPage] = useState<KnowledgeRef | null>(null)
  useEffect(() => {
    let live = true
    setEntries({ state: 'loading' })
    setPage(null)
    const scope = { sourceId: project.sourceId, workspace: project.workspace, project: project.project }
    const request = search ? call('knowledgeSearch', { ...scope, query: search }) : call('knowledgePages', scope)
    void request.then((value) => { if (live) setEntries({ state: 'ready', value }) }, (e: unknown) => { if (live) setEntries({ state: 'error', message: failure(e) }) })
    return () => { live = false }
  }, [project.sourceId, project.workspace, project.project, search, revision])
  return <>
    <form className="knowledge__actions" onSubmit={(e) => { e.preventDefault(); setSearch(query.trim()); setRevision((r) => r + 1) }}>
      <label className="field knowledge__query">{L('Buscar neste projeto', 'Search this project')}<input type="search" maxLength={500} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <button className="btn">{L('Buscar', 'Search')}</button>
      {search && <button type="button" className="btn btn--ghost" onClick={() => { setQuery(''); setSearch('') }}>{L('Todas as páginas', 'All pages')}</button>}
    </form>
    {search && <p className="hint">{L('Até 50 resultados neste projeto.', 'Up to 50 results in this project.')}</p>}
    {entries.state === 'loading' ? loading() : entries.state === 'error' ? <p role="alert">{entries.message}</p> : page ? <Page key={JSON.stringify(page)} pageRef={page} source={source} back={() => setPage(null)} /> : entries.value.length === 0 ? <p>{search ? L('Nenhum resultado.', 'No results.') : L('Nenhuma página neste projeto.', 'No pages in this project.')}</p> : <ul className="knowledge__list">{entries.value.map((entry) => <li key={entry.ref.path}>
      <button className="knowledge__entry" onClick={() => setPage(entry.ref)}><strong>{entry.title}</strong><span>{entry.ref.path} · {entry.kind}</span>{entry.snippet && <p>{entry.snippet}</p>}</button>
    </li>)}</ul>}
  </>
}

function Page({ pageRef, source, back }: { pageRef: KnowledgeRef; source: KnowledgeSource; back: () => void }): ReactNode {
  const [page, setPage] = useState<Read<KnowledgePage>>({ state: 'loading' })
  useEffect(() => {
    let live = true
    void call('knowledgePage', pageRef).then((value) => { if (live) setPage({ state: 'ready', value }) }, (e: unknown) => { if (live) setPage({ state: 'error', message: failure(e) }) })
    return () => { live = false }
  }, [pageRef])
  return <article className="knowledge__page">
    <button className="text-btn" onClick={back}>← {L('Páginas', 'Pages')}</button>
    {page.state === 'loading' ? loading() : page.state === 'error' ? <p role="alert">{page.message}</p> : <>
      <h2>{page.value.title}</h2>
      <p className="knowledge__origin">{source.name} · {pageRef.workspace} / {pageRef.project} / {pageRef.path}<br />{page.value.kind} · {page.value.tier} · {page.value.updatedAt}<br />{L('Versão', 'Version')}: {page.value.id}</p>
      <div className="knowledge__markdown"><Markdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => key === 'href' && /^(https?:\/\/|mailto:)/i.test(url) ? safeUrl(url, key) : undefined} components={{ a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>, img: ({ alt }) => <span>{alt}</span> }}>{page.value.markdown}</Markdown></div>
    </>}
  </article>
}
