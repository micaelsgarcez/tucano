import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { Knowledge } from '../src/core/knowledge'
import { Secrets, plainCipher } from '../src/core/secrets'
import { setLang } from '../src/shared/lang'
import type { KnowledgeSource } from '../src/shared/knowledge'

const token = 'aim_fixture_read_credential'
const json = (res: ServerResponse, data: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
let server: Server
let db: Db
let secrets: Secrets
let knowledge: Knowledge
let source: KnowledgeSource
let baseUrl: string
let handler: (req: IncomingMessage, res: ServerResponse) => void
let requests: string[]
let revoked: boolean
let root: string
const scope = () => ({ sourceId: source.id, workspace: 'alpha', project: 'shared' })
const page = (workspace = 'alpha') => ({ id: 'version-2', workspace, project: 'shared', path: 'decisions/storage.md', title: 'Storage decision', kind: 'decision', tier: 'long', updated_at: '2026-01-02T00:00:00Z', body_markdown: '# Storage\n\nUse managed storage.' })

beforeEach(async () => {
  setLang('en')
  root = mkdtempSync(join(tmpdir(), 'tucano-knowledge-'))
  db = new Db(join(root, 'source.db'))
  secrets = new Secrets(db, plainCipher)
  knowledge = new Knowledge(db, secrets)
  requests = []
  revoked = false
  handler = (req, res) => {
    requests.push(req.url ?? '')
    if (revoked || req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 403; json(res, { message: token }); return }
    const url = new URL(req.url ?? '', baseUrl)
    if (url.pathname === '/api/v1/projects') { json(res, ['alpha', 'beta'].map((workspace_name) => ({ workspace_name, project_name: 'shared', page_count: 1 }))); return }
    const workspace = url.pathname.split('/')[4]
    if (workspace === 'forbidden') { res.statusCode = 403; json(res, { error: token }); return }
    if (url.pathname === '/api/v1/search') { json(res, [{ workspace: url.searchParams.get('workspace'), project: url.searchParams.get('project'), path: 'decisions/storage.md', title: 'Storage decision', kind: 'decision', snippet: 'Use managed storage.' }]); return }
    if (url.pathname.endsWith('/pages')) { json(res, [{ path: 'decisions/storage.md', title: 'Storage decision', kind: 'decision', tier: 'long', updated_at: '2026-01-02T00:00:00Z' }]); return }
    if (url.pathname.endsWith('/pages/decisions/storage.md')) { json(res, page(workspace)); return }
    res.statusCode = 404
    json(res, { error: token })
  }
  server = createServer((req, res) => handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP fixture')
  baseUrl = `http://127.0.0.1:${address.port}`
  source = await knowledge.save({ name: 'Reference memory', baseUrl, token })
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  rmSync(root, { recursive: true, force: true })
  setLang('pt')
})

describe('ai-memory live read adapter', () => {
  it('reads the real v1 array shapes and keeps identical paths in different namespaces separate', async () => {
    const projects = await knowledge.projects(source.id)
    expect(projects).toEqual(['alpha', 'beta'].map((workspace) => ({ sourceId: source.id, workspace, project: 'shared', pages: 1 })))
    const first = (await knowledge.pages(scope()))[0]
    expect(first?.ref).toEqual({ ...scope(), path: 'decisions/storage.md' })
    expect(await knowledge.page({ ...scope(), path: 'decisions/storage.md' })).toMatchObject({ id: 'version-2', markdown: '# Storage\n\nUse managed storage.' })
    const other = { ...scope(), workspace: 'beta', path: 'decisions/storage.md' }
    expect((await knowledge.page(other)).ref).toEqual(other)
    expect(await knowledge.search(scope(), 'storage & retention')).toHaveLength(1)
    expect(requests.at(-1)).toBe('/api/v1/search?q=storage+%26+retention&workspace=alpha&project=shared&limit=50')
  })

  it('uses current remote permissions on every read and never exposes a remote error body', async () => {
    await expect(knowledge.pages({ ...scope(), workspace: 'forbidden' })).rejects.toThrow('denied access')
    await knowledge.page({ ...scope(), path: 'decisions/storage.md' })
    revoked = true
    await expect(knowledge.page({ ...scope(), path: 'decisions/storage.md' })).rejects.toThrow('denied access')
    await expect(knowledge.projects(source.id)).rejects.not.toThrow(token)
    revoked = false
    await expect(knowledge.projects(source.id)).resolves.toHaveLength(2)
    expect(requests.filter((p) => p.endsWith('storage.md'))).toHaveLength(2)
  })

  it('reports absence, outages and malformed data instead of an empty successful view', async () => {
    await expect(knowledge.page({ ...scope(), path: 'missing.md' })).rejects.toThrow('not found')
    handler = (req) => req.socket.destroy()
    await expect(knowledge.projects(source.id)).rejects.toThrow('unavailable')
    for (const payload of ['invalid json', '{}', '[null]', '[{"workspace_name":"a","project_name":"b","page_count":-1}]']) {
      handler = (_req, res) => res.end(payload)
      await expect(knowledge.projects(source.id)).rejects.toThrow('invalid response')
    }
    handler = (_req, res) => json(res, { ...page(), workspace: 'other' })
    await expect(knowledge.page({ ...scope(), path: 'decisions/storage.md' })).rejects.toThrow('invalid response')
    handler = (_req, res) => json(res, [{ ...page(), project: 'other', snippet: '' }])
    await expect(knowledge.search(scope(), 'storage')).rejects.toThrow('invalid response')
    handler = (_req, res) => json(res, { ...page(), body_markdown: token })
    await expect(knowledge.page({ ...scope(), path: 'decisions/storage.md' })).rejects.not.toThrow(token)
    handler = (_req, res) => res.end(JSON.stringify({ ...page(), body_markdown: token }).replace('aim_', '\\u0061im_'))
    await expect(knowledge.page({ ...scope(), path: 'decisions/storage.md' })).rejects.toThrow('invalid response')
  })

  it('does not follow redirects or forward the credential to another origin', async () => {
    let leaked = false
    const other = createServer((_req, res) => { leaked = true; json(res, []) })
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
    try {
      const address = other.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP fixture')
      handler = (_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${address.port}/trap` }); res.end() }
      await expect(knowledge.projects(source.id)).rejects.toThrow('unavailable')
      expect(leaked).toBe(false)
    } finally { other.closeAllConnections(); await new Promise<void>((resolve) => other.close(() => resolve())) }
  })

  it('bounds responses and cancels a stalled upstream', async () => {
    handler = (_req, res) => res.end('x'.repeat(4 * 1024 * 1024 + 1))
    await expect(knowledge.projects(source.id)).rejects.toThrow('invalid response')
    handler = () => undefined
    await expect(knowledge.projects(source.id)).rejects.toThrow('unavailable')
  }, 15000)

  it('rejects traversal before transport and encodes a valid path by segment', async () => {
    for (const path of ['../secret', 'a/../secret', '/secret', 'a//b', 'a\\b', '%2e%2e/secret']) await expect(knowledge.page({ ...scope(), path })).rejects.toThrow('invalid response')
    await expect(knowledge.pages({ ...scope(), workspace: '../other' })).rejects.toThrow()
    expect(requests).toEqual([])
    handler = (req, res) => { requests.push(req.url ?? ''); json(res, { ...page(), path: 'decisions/storage plan.md' }) }
    await knowledge.page({ ...scope(), path: 'decisions/storage plan.md' })
    expect(requests).toEqual(['/api/v1/workspaces/alpha/projects/shared/pages/decisions/storage%20plan.md'])
  })

  it('rotates source identity, deletes the old credential, and refuses stale references', async () => {
    const oldId = source.id
    source = await knowledge.save({ name: 'Replacement', baseUrl, token })
    expect(source.id).not.toBe(oldId)
    expect(await secrets.get(`knowledge:${oldId}`)).toBeUndefined()
    await expect(knowledge.projects(oldId)).rejects.toThrow('source changed')
    await knowledge.remove(source.id)
    expect(knowledge.source()).toBeNull()
    expect(await secrets.get(`knowledge:${source.id}`)).toBeUndefined()
    await expect(knowledge.projects(source.id)).rejects.toThrow('source changed')
    expect(requests).toEqual([])
  })

  it('discards an in-flight response after the source is removed', async () => {
    let release = (): void => undefined
    let started = (): void => undefined
    const incoming = new Promise<void>((resolve) => { started = resolve })
    handler = (_req, res) => { release = () => json(res, []); started() }
    const result = knowledge.projects(source.id)
    await incoming
    await knowledge.remove(source.id)
    release()
    await expect(result).rejects.toThrow('source changed')
  })

  it('keeps credentials out of metadata and does not carry source access into a workspace copy', async () => {
    expect(JSON.stringify(knowledge.source())).not.toContain(token)
    expect(db.meta('knowledge:source')).not.toContain(token)
    expect(await secrets.get(`knowledge:${source.id}`)).toBe(token)
    const path = join(root, 'copy.db')
    db.duplicateTo(path, 'Independent workspace')
    const copy = new Db(path)
    try {
      expect(new Knowledge(copy, new Secrets(copy, plainCipher)).source()).toBeNull()
      expect(copy.getSecret(`knowledge:${source.id}`)).toBeUndefined()
      expect(knowledge.source()).toEqual(source)
    } finally { copy.close() }
  })

  it('does not expose vault errors containing secret material', async () => {
    const broken = new Knowledge(db, new Secrets(db, { encrypt: async () => { throw new Error(token) }, decrypt: async () => { throw new Error(token) } }))
    await expect(broken.save({ name: 'Reference', baseUrl, token })).rejects.toThrow('Could not save')
    await expect(broken.projects(source.id)).rejects.not.toThrow(token)
  })

  it('requires fresh credentials on save and forbids credentials, paths and query strings in the URL', async () => {
    for (const baseUrl of ['file:///tmp/memory', 'https://user:password@example.com', 'https://example.com/admin', 'https://example.com/?token=x', 'https://example.com/#x']) await expect(knowledge.save({ name: 'Memory', baseUrl, token })).rejects.toThrow()
    await expect(knowledge.save({ name: 'Memory', baseUrl, token: '' })).rejects.toThrow()
    expect(knowledge.source()).toEqual(source)
  })
})
