// Real core dispatch: an admin or member must not reach the source or its credential.
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { NEEDS } from '../src/core/policy-people'
import type { KnowledgeSource } from '../src/shared/knowledge'
import type { Method, Snapshot } from '../src/shared/rpc'
import type { Person } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

let core: TestCore
let owner: Client
let source: KnowledgeSource
let server: Server
let baseUrl: string
let reads = 0
const token = 'aim_core_fixture_secret'
const methods: Method[] = ['knowledgeSource', 'saveKnowledgeSource', 'removeKnowledgeSource', 'knowledgeProjects', 'knowledgePages', 'knowledgeSearch', 'knowledgePage']
beforeAll(async () => {
  server = createServer((req, res) => {
    reads++
    expect(req.headers.authorization).toBe(`Bearer ${token}`)
    res.setHeader('content-type', 'application/json')
    res.end('[]')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP fixture')
  baseUrl = `http://127.0.0.1:${address.port}`
  core = await bootCore({ server: true })
  owner = core.connect()
  source = await owner.call<KnowledgeSource>('saveKnowledgeSource', { name: 'Example knowledge', baseUrl, token })
}, 30000)
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

it('lets only the owner configure and read, before any upstream request or mutation', async () => {
  const params = { name: 'Denied', baseUrl, token, sourceId: source.id, workspace: 'alpha', project: 'shared', path: 'notes.md', query: 'test' }
  for (const method of methods) expect(NEEDS[method]).toBe('owner')
  for (const role of ['admin', 'member']) {
    const invite = await owner.call<{ code: string }>('createInvite', { role })
    const joined = await core.ask<{ data: { person?: Person } }>({ type: 'join', code: invite.code, name: role }, 'join-result')
    if (!joined.data.person) throw new Error('Fixture person failed to join')
    const client = core.connect(joined.data.person.id)
    for (const method of methods) await expect(client.call(method, params)).rejects.toThrow('dono')
    const snapshot = await client.call<Snapshot>('snapshot')
    expect(JSON.stringify(snapshot)).not.toContain(token)
    expect(JSON.stringify(snapshot)).not.toContain(baseUrl)
  }
  expect(reads).toBe(0)
  expect(await owner.call('knowledgeSource')).toEqual(source)
  expect(await owner.call('knowledgeProjects', { sourceId: source.id })).toEqual([])
  expect(reads).toBe(1)
})

it('never adds external source credentials to snapshots, events, native memory or the local Wiki', async () => {
  const before = await owner.call<Snapshot>('snapshot')
  await owner.call('knowledgeProjects', { sourceId: source.id })
  const after = await owner.call<Snapshot>('snapshot')
  expect(after.memories).toEqual(before.memories)
  expect(JSON.stringify(after)).not.toContain(token)
  expect(JSON.stringify(after)).not.toContain(source.id)
  expect(JSON.stringify(owner.events)).not.toContain(token)
  expect(JSON.stringify(await owner.call('wiki'))).not.toContain('Example knowledge')
})
