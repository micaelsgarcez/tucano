import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Db } from '../src/core/db'
import { Orbit } from '../src/core/orbit'
import { plainCipher, Secrets } from '../src/core/secrets'
import { admit, NEEDS } from '../src/core/policy-people'
import type { Agent, Person } from '../src/shared/types'
import type { OrbitSource } from '../src/shared/orbit'
import type { Method } from '../src/shared/rpc'
import { setLang } from '../src/shared/lang'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const secondProject = '33333333-3333-4333-8333-333333333333'
const taskId = '44444444-4444-4444-8444-444444444444'
const statusId = '55555555-5555-4555-8555-555555555555'
const memberId = '66666666-6666-4666-8666-666666666666'
const taskWire = () => ({ id: taskId, project_id: projectId, status_id: statusId, identifier: 'APP-1', title: 'Review endpoint', description: '# Task\nPrivate task body', assignee_ids: [memberId], label_ids: [], priority: 'medium', due_at: null, created_at: '2026-11-10T12:00:00Z', updated_at: '2026-11-10T13:00:00Z' })
const agent = (id: string, archived = false): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 10000, used: 0, grants: {}, memory: 'auto', computer: false, archived })
const list = (items: unknown[], next_cursor: string | null = null): unknown => ({ items, next_cursor })
const json = (res: ServerResponse, value: unknown): void => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
let dir: string, db: Db, orbit: Orbit, secrets: Secrets, server: Server, baseUrl: string, source: OrbitSource
let requests: { method: string | undefined; path: string; auth: string | undefined }[]
let reply: (req: IncomingMessage, res: ServerResponse) => void

beforeEach(async () => {
  setLang('en')
  dir = mkdtempSync(join(tmpdir(), 'tucano-orbit-'))
  db = new Db(join(dir, 'source.db'))
  secrets = new Secrets(db, plainCipher)
  orbit = new Orbit(db, secrets)
  db.saveAgent(agent('executor'))
  db.saveAgent(agent('reviewer'))
  requests = []
  reply = (req, res) => {
    const url = new URL(req.url ?? '/', baseUrl)
    if (url.pathname.endsWith('/projects')) json(res, list([{ id: projectId, name: 'Application', key: 'APP', color: '#aabbcc' }]))
    else if (url.pathname.endsWith('/statuses')) json(res, list([{ id: statusId, project_id: projectId, name: 'To do', color: '#aabbcc', category: 'unstarted', position: 1 }]))
    else if (url.pathname.endsWith('/labels')) json(res, list([]))
    else if (url.pathname.endsWith('/members')) json(res, list([{ user_id: memberId, display_name: 'Alex' }]))
    else if (url.pathname.endsWith('/tasks')) json(res, list([taskWire()]))
    else if (url.pathname.endsWith(`/tasks/${taskId}`)) json(res, taskWire())
    else { res.statusCode = 404; res.end() }
  }
  server = createServer((req, res) => { requests.push({ method: req.method, path: req.url ?? '', auth: req.headers.authorization }); reply(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected HTTP fixture address')
  baseUrl = `http://127.0.0.1:${address.port}`
  source = await orbit.save({ baseUrl, workspaceId, token: 'fixture-read-token' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
  rmSync(dir, { recursive: true, force: true })
  setLang('pt')
})

describe('Orbit projects and local agent responsibilities', () => {
  it('reads the public v1 wire format, cursor and members using only GET', async () => {
    expect(await orbit.projects(source.id)).toEqual([{ id: projectId, name: 'Application', key: 'APP', color: '#aabbcc' }])
    expect(await orbit.projectData(source.id, projectId)).toEqual({ statuses: [{ id: statusId, projectId, name: 'To do', color: '#aabbcc', category: 'unstarted', position: 1 }], members: [{ id: memberId, name: 'Alex' }], labels: [] })
    expect(await orbit.detail(source.id, taskId)).toMatchObject({ task: { id: taskId, assigneeIds: [memberId] }, assignments: { executor: null, reviewer: null } })
    reply = (_, res) => json(res, list([taskWire()], 'opaque /?=cursor'))
    expect((await orbit.tasks(source.id, projectId)).nextCursor).toBe('opaque /?=cursor')
    await orbit.tasks(source.id, projectId, 'opaque /?=cursor')
    const requested = new URL(requests.at(-1)!.path, baseUrl)
    expect(requested.searchParams.get('cursor')).toBe('opaque /?=cursor')
    expect(requested.searchParams.get('project_id')).toBe(projectId)
    expect(requests.every(request => request.method === 'GET' && request.auth === 'Bearer fixture-read-token')).toBe(true)
  })

  it('upserts one agent per role without changing grants, people, runs or Orbit', async () => {
    const people = db.people()
    const input = { sourceId: source.id, taskId, role: 'executor' as const, agentId: 'executor' }
    await orbit.assign(input)
    await orbit.assign(input)
    await orbit.assign({ ...input, agentId: 'reviewer' })
    await orbit.assign({ ...input, role: 'reviewer', agentId: 'executor' })
    expect((await orbit.detail(source.id, taskId)).assignments).toEqual({ executor: 'reviewer', reviewer: 'executor' })
    const raw = new DatabaseSync(join(dir, 'source.db'))
    expect(raw.prepare("SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'orbit:assignment:%'").get()?.count).toBe(2)
    const values = raw.prepare("SELECT value FROM meta WHERE key LIKE 'orbit:%'").all()
    expect(JSON.stringify(values)).not.toMatch(/fixture-read-token|Private task body|Review endpoint/)
    raw.close()
    expect(db.people()).toEqual(people)
    expect(db.agent('executor')?.grants).toEqual({})
    expect(db.agent('reviewer')?.grants).toEqual({})
    expect(db.messages()).toEqual([])
    expect(requests.every(request => request.method === 'GET')).toBe(true)
    await orbit.assign({ ...input, agentId: null })
    expect((await orbit.detail(source.id, taskId)).assignments.executor).toBeNull()
  })

  it('keeps assignments through project moves and rechecks the UUID grant on every write', async () => {
    const input = { sourceId: source.id, taskId, role: 'executor' as const, agentId: 'executor' }
    await orbit.assign(input)
    reply = (_, res) => json(res, { ...taskWire(), project_id: secondProject, identifier: 'NEW-5' })
    expect(await orbit.detail(source.id, taskId)).toMatchObject({ task: { projectId: secondProject, identifier: 'NEW-5' }, assignments: { executor: 'executor' } })
    reply = (_, res) => { res.statusCode = 403; res.end('fixture-read-token: permission revoked') }
    await expect(orbit.assign({ ...input, agentId: 'reviewer' })).rejects.toThrow('Could not read Orbit')
    await expect(orbit.detail(source.id, taskId)).rejects.not.toThrow('fixture-read-token')
    reply = (_, res) => json(res, taskWire())
    expect((await orbit.detail(source.id, taskId)).assignments.executor).toBe('executor')
  })

  it('preserves source identity during rotation and separates identical UUIDs in another workspace or origin', async () => {
    await orbit.assign({ sourceId: source.id, taskId, role: 'executor', agentId: 'executor' })
    const rotated = await orbit.save({ baseUrl: `${baseUrl}/`, workspaceId, token: 'rotated-token' })
    expect(rotated).toEqual(source)
    expect(JSON.stringify(orbit.source())).not.toContain('token')
    expect((await orbit.detail(source.id, taskId)).assignments.executor).toBe('executor')
    expect(requests.at(-1)?.auth).toBe('Bearer rotated-token')
    const otherWorkspace = await orbit.save({ baseUrl, workspaceId: secondProject, token: 'other-workspace' })
    expect(otherWorkspace.id).not.toBe(source.id)
    expect((await orbit.detail(otherWorkspace.id, taskId)).assignments.executor).toBeNull()
    await expect(orbit.detail(source.id, taskId)).rejects.toThrow('connection changed')
    const otherOrigin = await orbit.save({ baseUrl: 'https://orbit.example.com', workspaceId: secondProject, token: 'other-origin' })
    expect(otherOrigin.id).not.toBe(otherWorkspace.id)
  })

  it('keeps archived assignments visible but refuses assigning archived or missing agents', async () => {
    await orbit.assign({ sourceId: source.id, taskId, role: 'executor', agentId: 'executor' })
    db.saveAgent(agent('executor', true))
    expect((await orbit.detail(source.id, taskId)).assignments.executor).toBe('executor')
    for (const agentId of ['executor', 'missing']) await expect(orbit.assign({ sourceId: source.id, taskId, role: 'reviewer', agentId })).rejects.toThrow('active agent')
    expect((await orbit.detail(source.id, taskId)).assignments.reviewer).toBeNull()
  })

  it('rejects task and project mismatches, malformed JSON, malformed lists and missing cursors', async () => {
    reply = (_, res) => json(res, { ...taskWire(), id: memberId })
    await expect(orbit.detail(source.id, taskId)).rejects.toThrow('Invalid response')
    reply = (_, res) => json(res, list([{ ...taskWire(), project_id: secondProject }]))
    await expect(orbit.tasks(source.id, projectId)).rejects.toThrow('Invalid response')
    for (const body of [{ items: [] }, { items: {}, next_cursor: null }, list([{ ...taskWire(), assignee_ids: 'not-an-array' }]), list([taskWire()], '')]) {
      reply = (_, res) => json(res, body)
      await expect(orbit.tasks(source.id, projectId)).rejects.toThrow()
    }
    reply = (_, res) => res.end('{invalid fixture-read-token')
    await expect(orbit.tasks(source.id, projectId)).rejects.not.toThrow('fixture-read-token')
  })

  it('reads all metadata pages and refuses a repeated cursor', async () => {
    reply = (req, res) => {
      const url = new URL(req.url ?? '', baseUrl)
      json(res, url.searchParams.has('cursor') ? list([{ id: secondProject, name: 'Second', key: 'TWO', color: '#aabbcc' }]) : list([{ id: projectId, name: 'First', key: 'ONE', color: '#aabbcc' }], 'second'))
    }
    expect(await orbit.projects(source.id)).toHaveLength(2)
    reply = (_, res) => json(res, list([], 'repeat'))
    await expect(orbit.projects(source.id)).rejects.toThrow('Invalid response')
  })

  it('rejects traversal before issuing requests and accepts only an HTTPS origin or local HTTP', async () => {
    for (const invalidId of ['APP-1', '../members', '%2e%2e', `${taskId}/comments`]) {
      await expect(orbit.detail(source.id, invalidId)).rejects.toThrow('identifier')
      await expect(orbit.tasks(source.id, invalidId)).rejects.toThrow('identifier')
    }
    for (const url of ['http://orbit.example.com', 'https://user:pass@orbit.example.com', 'https://orbit.example.com/path', 'https://orbit.example.com/?token=x']) {
      await expect(orbit.save({ baseUrl: url, workspaceId, token: 'fixture-token' })).rejects.toThrow()
    }
    expect(requests).toEqual([])
  })

  it('refuses redirects without delivering the bearer token to the target', async () => {
    reply = (_, res) => { res.writeHead(302, { Location: `${baseUrl}/redirect-target` }); res.end() }
    await expect(orbit.projects(source.id)).rejects.toThrow('Could not read Orbit')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.path).toContain('/projects')
  })

  it('bounds response size, time and reports outages without remote payloads', async () => {
    reply = (_, res) => res.end('x'.repeat(8 * 1024 * 1024 + 1))
    await expect(orbit.projects(source.id)).rejects.toThrow('Could not read Orbit')
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(20))
    reply = () => {}
    await expect(orbit.projects(source.id)).rejects.toThrow('Could not read Orbit')
    reply = (_, res) => { res.statusCode = 503; res.end('fixture-read-token') }
    await expect(orbit.projects(source.id)).rejects.not.toThrow('fixture-read-token')
  })

  it('discards an old-token response that completes after rotation', async () => {
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const waiting = new Promise<void>(resolve => { started = resolve })
    reply = (_, res) => { release = () => json(res, taskWire()); started?.() }
    const reading = orbit.detail(source.id, taskId)
    const rejected = expect(reading).rejects.toThrow('connection changed')
    await waiting
    await orbit.save({ baseUrl, workspaceId, token: 'rotated-token' })
    release?.()
    await rejected
  })

  it('does not expose a cipher error or token on save failure', async () => {
    const broken = new Orbit(db, new Secrets(db, { ...plainCipher, encrypt: async value => { throw new Error(value) } }))
    await expect(broken.save({ baseUrl, workspaceId, token: 'private-save-token' })).rejects.toThrow('Could not save')
    expect(orbit.source()).toEqual(source)
  })

  it('limits every Orbit RPC to the owner, including reads', () => {
    const owner = db.owner()
    const admin: Person = { ...owner, id: 'admin', role: 'admin' }
    const member: Person = { ...owner, id: 'member', role: 'member' }
    const methods: Method[] = ['orbitSource', 'orbitSaveSource', 'orbitProjects', 'orbitProjectData', 'orbitTasks', 'orbitTask', 'orbitAssignAgent', 'orbitBoardData', 'orbitComments', 'orbitActivity', 'orbitStart']
    for (const method of methods) {
      expect(NEEDS[method]).toBe('owner')
      expect(() => admit(owner, method)).not.toThrow()
      expect(() => admit(admin, method)).toThrow()
      expect(() => admit(member, method)).toThrow()
    }
  })

  it('does not transfer the connection, token or assignments when copying a workspace', async () => {
    await orbit.assign({ sourceId: source.id, taskId, role: 'executor', agentId: 'executor' })
    const file = join(dir, 'copy.db')
    db.duplicateTo(file, 'Copy')
    const copy = new Db(file)
    const copyOrbit = new Orbit(copy, new Secrets(copy, plainCipher))
    expect(copyOrbit.source()).toBeNull()
    copy.close()
    const raw = new DatabaseSync(file)
    expect(raw.prepare("SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'orbit:%'").get()?.count).toBe(0)
    expect(raw.prepare("SELECT COUNT(*) AS count FROM secrets WHERE key LIKE 'orbit:%'").get()?.count).toBe(0)
    raw.close()
    expect(readFileSync(file).toString('utf8')).not.toContain('fixture-read-token')
    expect(orbit.source()).toEqual(source)
  })
})

it('loads board definitions and validates the approved project set in the all-project page', async () => {
  expect(await orbit.boardData(source.id)).toMatchObject({ projects: [{ id: projectId, color: '#aabbcc' }], labels: [], statuses: [{ category: 'unstarted', position: 1 }], members: [{ name: 'Alex' }] })
  const original = reply
  reply = (req, res) => req.url?.includes('/tasks?') ? json(res, list([taskWire(), { ...taskWire(), id: secondProject, project_id: secondProject }])) : original(req, res)
  await expect(orbit.tasks(source.id, null)).rejects.toThrow('Invalid response')
  reply = original
  expect((await orbit.tasks(source.id, null)).items[0]?.task.priority).toBe('medium')
  expect(new URL(requests.at(-1)!.path, baseUrl).searchParams.has('project_id')).toBe(false)
})

it('reads scoped paged comments and service authors without impersonating a Tucano agent', async () => {
  const original = reply
  const body = { id: secondProject, task_id: taskId, author_id: memberId, author_service_account: { id: memberId, name: 'External bot' }, parent_id: null, body: 'Verified report', created_at: '2026-11-10T12:00:00Z', updated_at: '2026-11-10T12:00:00Z' }
  reply = (req, res) => req.url?.includes('/comments') ? json(res, list([body], 'comments-next')) : original(req, res)
  expect(await orbit.comments(source.id, taskId)).toMatchObject({ items: [{ serviceAccount: { name: 'External bot' }, body: 'Verified report' }], nextCursor: 'comments-next' })
  await orbit.comments(source.id, taskId, 'comments-next')
  expect(new URL(requests.at(-1)!.path, baseUrl).searchParams.get('cursor')).toBe('comments-next')
  reply = (req, res) => req.url?.includes('/comments') ? json(res, list([{ ...body, task_id: secondProject }])) : original(req, res)
  await expect(orbit.comments(source.id, taskId)).rejects.toThrow('Invalid response')
})

it('reauthorizes activity on every read and never exposes another person’s DM', async () => {
  const owner = db.owner()
  db.createConversation({ id: 'foreign', kind: 'dm', name: 'executor', members: ['executor'], owner: 'someone-else' })
  const root = { id: 'root', conversationId: 'foreign', author: { kind: 'person' as const, id: owner.id }, at: 1, text: 'Request' }
  db.createTaskExecution({ id: 'execution', sourceId: source.id, workspaceId, taskId, requestId: 'request', requesterId: owner.id, role: 'executor', agentId: 'executor', agentName: 'Executor', conversationId: 'foreign', rootMessageId: 'root', createdAt: 1, state: 'queued' }, root)
  db.saveMessage({ id: 'message', conversationId: 'foreign', threadId: 'root', author: { kind: 'agent', id: 'executor' }, at: 2, text: 'private', run: { attemptId: 'attempt', status: 'done', steps: [] } })
  expect(await orbit.activity(source.id, taskId, owner)).toMatchObject({ items: [], executions: [] })
  reply = (_, res) => { res.statusCode = 403; res.end() }
  await expect(orbit.activity(source.id, taskId, owner)).rejects.toThrow('Could not read Orbit')
})
