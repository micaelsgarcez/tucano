import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import type { KnowledgeEntry, KnowledgePage, KnowledgeProject, KnowledgeRef, KnowledgeScope, KnowledgeSource } from '../shared/knowledge'
import type { Db } from './db'
import type { Secrets } from './secrets'

const SOURCE = 'knowledge:source'
const MAX_BYTES = 4 * 1024 * 1024
const badData = (): Error => new Error(L('O ai-memory enviou uma resposta inválida.', 'ai-memory returned an invalid response.'))
const changed = (): Error => new Error(L('A fonte mudou. Atualize para continuar.', 'The source changed. Refresh to continue.'))
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badData()
  return Object.fromEntries(Object.entries(value))
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw badData()
  return value
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10000) throw badData()
  return value
}
function segment(value: string): string {
  if (!value || value === '.' || value === '..' || /[/\\%\x00-\x1f\x7f]/.test(value)) throw badData()
  return encodeURIComponent(value)
}
function pagePath(value: string): string {
  return value.split('/').map(segment).join('/')
}
function sourceUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(L('Informe a URL do serviço ai-memory.', 'Enter the ai-memory service URL.')) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(L('Use somente a origem HTTP(S), sem credenciais ou caminho.', 'Use only the HTTP(S) origin, without credentials or a path.'))
  return url.origin
}
function ref(scope: KnowledgeScope, path: unknown): KnowledgeRef {
  const value = text(path)
  pagePath(value)
  return { sourceId: scope.sourceId, workspace: scope.workspace, project: scope.project, path: value }
}
function scoped(scope: KnowledgeScope, value: Record<string, unknown>): KnowledgeRef {
  if (value.workspace !== scope.workspace || value.project !== scope.project) throw badData()
  return ref(scope, value.path)
}

export class Knowledge {
  constructor(private db: Db, private secrets: Secrets) {}

  source(): KnowledgeSource | null {
    const saved = this.db.meta(SOURCE)
    if (!saved) return null
    try {
      const data = record(JSON.parse(saved))
      return { id: text(data.id), name: text(data.name), baseUrl: sourceUrl(text(data.baseUrl)) }
    } catch { throw new Error(L('A configuração do ai-memory está inválida. Configure novamente.', 'The ai-memory configuration is invalid. Configure it again.')) }
  }

  async save(input: { name: string; baseUrl: string; token: string }): Promise<KnowledgeSource> {
    const name = input.name.trim()
    if (!name || name.length > 120 || !input.token || input.token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(input.token)) throw new Error(L('Informe o nome e um token válido.', 'Enter a name and a valid token.'))
    const source = { id: randomUUID(), name, baseUrl: sourceUrl(input.baseUrl) }
    const previous = this.db.meta(SOURCE)
    const old = previous ? this.source() : null
    try { await this.secrets.set(`knowledge:${source.id}`, input.token) } catch { throw new Error(L('Não foi possível guardar a credencial do ai-memory.', 'Could not save the ai-memory credential.')) }
    if (this.db.meta(SOURCE) !== previous) {
      await this.secrets.set(`knowledge:${source.id}`, undefined)
      throw changed()
    }
    this.db.setMeta(SOURCE, JSON.stringify(source))
    if (old) await this.secrets.set(`knowledge:${old.id}`, undefined)
    return source
  }

  async remove(sourceId: string): Promise<void> {
    this.current(sourceId)
    this.db.setMeta(SOURCE, '')
    await this.secrets.set(`knowledge:${sourceId}`, undefined)
  }

  private current(sourceId: string): KnowledgeSource {
    const source = this.source()
    if (!source || source.id !== sourceId) throw changed()
    return source
  }

  private async get(sourceId: string, path: string): Promise<unknown> {
    const source = this.current(sourceId)
    let token: string | undefined
    try { token = await this.secrets.get(`knowledge:${source.id}`) } catch { throw new Error(L('Não foi possível abrir a credencial do ai-memory.', 'Could not open the ai-memory credential.')) }
    if (!token) throw changed()
    this.current(sourceId)
    let response: Response
    let body: string
    try {
      response = await fetch(`${source.baseUrl}/api/v1/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 401 || response.status === 403) throw new Error('denied')
        if (response.status === 404) throw new Error('missing')
        throw new Error('unavailable')
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('invalid')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > MAX_BYTES) throw new Error('invalid')
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel() }
      body = Buffer.concat(chunks).toString('utf8')
    } catch (error) {
      this.current(sourceId)
      if (error instanceof Error && error.message === 'denied') throw new Error(L('Acesso negado pelo ai-memory. Confira o token e as permissões.', 'ai-memory denied access. Check the token and permissions.'))
      if (error instanceof Error && error.message === 'missing') throw new Error(L('Projeto ou página não encontrado no ai-memory.', 'Project or page not found in ai-memory.'))
      if (error instanceof Error && error.message === 'invalid') throw badData()
      throw new Error(L('ai-memory indisponível. Tente atualizar.', 'ai-memory is unavailable. Try refreshing.'))
    }
    this.current(sourceId)
    // Never return a credential echoed by an upstream error or a misconfigured endpoint.
    try {
      const value: unknown = JSON.parse(body)
      if (JSON.stringify(value).includes(token)) throw badData()
      return value
    } catch { throw badData() }
  }

  async projects(sourceId: string): Promise<KnowledgeProject[]> {
    return list(await this.get(sourceId, 'projects')).map((item) => {
      const data = record(item)
      const workspace = text(data.workspace_name)
      const project = text(data.project_name)
      segment(workspace)
      segment(project)
      if (typeof data.page_count !== 'number' || !Number.isSafeInteger(data.page_count) || data.page_count < 0) throw badData()
      return { sourceId, workspace, project, pages: data.page_count }
    })
  }

  async pages(scope: KnowledgeScope): Promise<KnowledgeEntry[]> {
    const path = `workspaces/${segment(scope.workspace)}/projects/${segment(scope.project)}/pages`
    return list(await this.get(scope.sourceId, path)).map((item) => {
      const data = record(item)
      return { ref: ref(scope, data.path), title: text(data.title), kind: text(data.kind), snippet: '' }
    })
  }

  async search(scope: KnowledgeScope, query: string): Promise<KnowledgeEntry[]> {
    segment(scope.workspace)
    segment(scope.project)
    if (!query.trim() || query.length > 500) throw new Error(L('Busque de 1 a 500 caracteres.', 'Search with 1 to 500 characters.'))
    const params = new URLSearchParams({ q: query, workspace: scope.workspace, project: scope.project, limit: '50' })
    return list(await this.get(scope.sourceId, `search?${params}`)).map((item) => {
      const data = record(item)
      return { ref: scoped(scope, data), title: text(data.title), kind: text(data.kind), snippet: text(data.snippet) }
    })
  }

  async page(scope: KnowledgeRef): Promise<KnowledgePage> {
    const path = `workspaces/${segment(scope.workspace)}/projects/${segment(scope.project)}/pages/${pagePath(scope.path)}`
    const data = record(await this.get(scope.sourceId, path))
    const pageRef = scoped(scope, data)
    if (pageRef.path !== scope.path) throw badData()
    return { ref: pageRef, id: text(data.id), title: text(data.title), kind: text(data.kind), tier: text(data.tier), updatedAt: text(data.updated_at), markdown: text(data.body_markdown), snippet: '' }
  }
}
