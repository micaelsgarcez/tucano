import { createServer, type Server } from 'node:http'
import { createHmac, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskStore } from '../src/tasks/store'
import { createTasksHandler } from '../src/tasks/http'
import { reconcileGithubDelivery } from '../src/tasks/github-api'
import { parseGithubDelivery } from '../src/tasks/github'

const secret = 'fixture-webhook-secret'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const credentials = { appId: '10', webhookSecret: secret, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
let store: TaskStore, server: Server, api: Server, dir: string, origin: string
let installationState: 'active' | 'suspended' | 'deleted'
let repositories: { id: number; full_name: string }[]
let current: ReturnType<typeof item>
let apiError: number, itemRequests: number, apiRequests: number
let holdItem: (() => Promise<void>) | undefined
let membership: { id: number; app_id: number; suspended_at: string | null }
let metadata: { id: number; full_name: string } | undefined
let requestedPaths: string[]
function item(fields: Record<string, unknown> = {}) {
  return { id: 40, number: 1, title: 'Current title', body: 'Current body', html_url: 'https://github.com/owner/repo/issues/1', state: 'open', merged: false, labels: [{ name: 'sync' }], updated_at: '2026-11-10T12:00:10Z', ...fields }
}
function payload(fields: Record<string, unknown> = {}) {
  return { action: 'edited', installation: { id: 20 }, repository: { id: 30, full_name: 'owner/repo' }, issue: item({ title: 'Stale payload', updated_at: '2026-11-10T12:00:01Z', ...fields }) }
}
function headers(raw: string, id: string, event = 'issues') {
  return { 'x-github-event': event, 'x-github-delivery': id, 'x-github-hook-installation-target-type': 'integration', 'x-github-hook-installation-target-id': '10', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No address')
  return `http://127.0.0.1:${address.port}`
}
async function deliver(value: unknown = payload(), id = 'delivery', event = 'issues', path = '/api/tasks/v1/github/webhook') {
  const raw = JSON.stringify(value)
  return fetch(origin + path, { method: 'POST', body: raw, headers: headers(raw, id, event) })
}
const tasks = () => store.list(store.ownerPrincipal()).items
beforeEach(async () => {
  installationState = 'active'; repositories = [{ id: 30, full_name: 'owner/repo' }]
  membership = { id: 20, app_id: 10, suspended_at: null }; metadata = undefined; requestedPaths = []
  current = item(); apiError = 0; itemRequests = 0; apiRequests = 0; holdItem = undefined
  dir = mkdtempSync(join(tmpdir(), 'tasks-github-api-'))
  store = new TaskStore(join(dir, 'tasks.sqlite'))
  store.importSnapshot({ fingerprint: 'github-api-test', source: { id: 'source', workspaceId: 'w' }, owner: { id: 'u', workspaceId: 'w', projectIds: ['p'], scopes: ['tasks:write'], serviceAccountId: null, owner: true }, tables: {
    users: [{ id: 'u', display_name: 'User' }], projects: [{ id: 'p', workspace_id: 'w', project_key: 'APP', name: 'Project', color: '#fff', task_counter: 1 }],
    task_statuses: ['unstarted', 'completed', 'cancelled'].map((category, position) => ({ id: category, project_id: 'p', name: category, color: '#fff', category, position })),
    github_apps: [{ workspace_id: 'w', app_id: 10 }], github_installations: [{ installation_id: 20, workspace_id: 'w', account_login: 'owner' }],
    github_installation_repositories: [{ installation_id: 20, repository: 'owner/repo' }],
    github_project_connections: [{ project_id: 'p', workspace_id: 'w', installation_id: 20, repository: 'owner/repo', label: 'sync' }, { project_id: 'p', workspace_id: 'w', installation_id: 20, repository: 'owner/newrepo', label: 'sync' }],
    tasks: [{ id: 'imported', workspace_id: 'w', project_id: 'p', number: 1, status_id: 'unstarted', title: 'Imported title', description: '', priority: 'none', creator_id: 'u', version: 0, created_at: 1, updated_at: 1, deleted_at: null }],
    github_issue_links: [{ workspace_id: 'w', repository: 'owner/repo', issue_number: 1, task_id: 'imported', sync_paused: 0, kind: 'issue' }],
  } })
  api = createServer((req, res) => {
    void (async () => {
      apiRequests++
      const path = new URL(req.url!, 'http://localhost').pathname
      requestedPaths.push(path)
      res.setHeader('Content-Type', 'application/json')
      if (apiError) { res.writeHead(apiError); res.end('{}'); return }
      if (path.startsWith('/app/') || path.endsWith('/installation')) {
        const jwt = req.headers.authorization?.slice(7).split('.') ?? []
        expect(jwt).toHaveLength(3)
        expect(verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), publicKey, Buffer.from(jwt[2]!, 'base64url'))).toBe(true)
        const claims = JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString())
        expect(claims.iss).toBe('10'); expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
      } else expect(req.headers.authorization).toBe('Bearer installation-token')
      if (path === '/app/installations/20') {
        res.statusCode = installationState === 'deleted' ? 404 : 200
        res.end(JSON.stringify({ id: 20, app_id: 10, suspended_at: installationState === 'suspended' ? '2026-11-10T12:00:00Z' : null }))
      } else if (path === '/app/installations/20/access_tokens') {
        expect(req.method).toBe('POST'); res.end(JSON.stringify({ token: 'installation-token' }))
      } else if (/^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) {
        const found = repositories.find(repository => `/repos/${repository.full_name}/installation` === path)
        res.statusCode = found ? 200 : 404
        res.end(JSON.stringify(found ? membership : {}))
      } else if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
        const found = metadata ?? repositories.find(repository => `/repos/${repository.full_name}` === path)
        res.statusCode = found ? 200 : 404
        res.end(JSON.stringify(found ?? {}))
      } else if (path === '/repos/owner/repo/issues/1' || path === '/repos/owner/repo/pulls/2' || path === '/repos/owner/newrepo/issues/1') {
        itemRequests++
        const snapshot = current
        await holdItem?.()
        res.end(JSON.stringify(snapshot))
      } else { res.statusCode = 500; res.end('{}') }
    })().catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) })
  })
  const apiOrigin = await listen(api)
  const handler = createTasksHandler(store, { githubCredentials: () => credentials, githubFetch: (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://api.github.com'); expect(init?.redirect).toBe('error')
    return fetch(apiOrigin + url.pathname + url.search, init)
  } })
  server = createServer((req, res) => { if (!handler(req, res)) { res.statusCode = 404; res.end() } })
  origin = await listen(server)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([server, api].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  store.close(); rmSync(dir, { recursive: true, force: true })
})
it('reconciles an imported link with no watermark and same-second edits from the current API item', async () => {
  expect((await deliver()).status).toBe(200)
  expect(tasks()[0]).toMatchObject({ id: 'imported', title: 'Current title', statusId: 'unstarted' })
  current = item({ state: 'closed', title: 'Closed now' })
  expect((await deliver(payload(), 'same-second', 'issues', '/api/v1/integrations/github/webhook')).status).toBe(200)
  expect(tasks()[0]).toMatchObject({ title: 'Closed now', statusId: 'completed' })
  await deliver(payload({ title: 'Even older', updated_at: '2026-11-10T12:00:00Z' }), 'old-delivery')
  expect(tasks()[0]).toMatchObject({ title: 'Closed now', statusId: 'completed' })
})
it('does not fetch GitHub until raw signature verification succeeds', async () => {
  const raw = JSON.stringify(payload())
  const response = await fetch(origin + '/api/tasks/v1/github/webhook', { method: 'POST', body: raw + ' ', headers: headers(raw, 'bad') })
  expect(response.status).toBe(401); expect(apiRequests).toBe(0)
})
it('maps an unmerged canonical PR to cancelled and a merged PR to completed', async () => {
  current = item({ id: 41, number: 2, state: 'closed', merged: false, html_url: 'https://github.com/owner/repo/pull/2' })
  const value = { ...payload(), pull_request: current }
  expect((await deliver(value, 'closed-pr', 'pull_request')).status).toBe(200)
  expect(tasks().find(task => task.id !== 'imported')?.statusId).toBe('cancelled')
  current = { ...current, merged: true }
  await deliver(value, 'merged-pr', 'pull_request')
  expect(tasks().find(task => task.id !== 'imported')?.statusId).toBe('completed')
})
it('allows ignored GUIDs to retry after labels or access are fixed, but rejects changed payload reuse', async () => {
  current = item({ labels: [] })
  expect(await (await deliver()).json()).toEqual({ status: 'ignored' })
  current = item()
  expect(await (await deliver()).json()).toEqual({ status: 'applied' })
  expect(await (await deliver()).json()).toEqual({ status: 'duplicate' })
  expect((await deliver(payload({ title: 'Different content' }))).status).toBe(409)
  repositories = []
  expect(await (await deliver(payload(), 'denied')).json()).toEqual({ status: 'ignored' })
  repositories = [{ id: 30, full_name: 'owner/repo' }]; current = item({ title: 'Restored' })
  expect(await (await deliver(payload(), 'denied')).json()).toEqual({ status: 'applied' })
  expect(tasks()[0]?.title).toBe('Restored')
})
it('suspend/unsuspend and remove/add use current access rather than stale action names', async () => {
  const lifecycle = (action: string) => ({ action, installation: { id: 20 } })
  const repoChange = (action: string) => ({ ...lifecycle(action), [`repositories_${action}`]: [{ id: 30, full_name: 'owner/repo' }] })
  installationState = 'suspended'
  await deliver(lifecycle('suspend'), 'suspend', 'installation')
  await deliver(lifecycle('unsuspend'), 'stale-unsuspend', 'installation')
  expect(await (await deliver(payload(), 'suspended-item')).json()).toEqual({ status: 'ignored' })
  expect(tasks()[0]?.title).toBe('Imported title')
  installationState = 'active'
  await deliver(lifecycle('unsuspend'), 'unsuspend', 'installation')
  await deliver(payload(), 'suspended-item'); expect(tasks()[0]?.title).toBe('Current title')
  repositories = []
  await deliver(repoChange('removed'), 'removed', 'installation_repositories')
  await deliver(repoChange('added'), 'stale-add', 'installation_repositories')
  current = item({ title: 'Unavailable edit' })
  expect(await (await deliver(payload(), 'removed-item')).json()).toEqual({ status: 'ignored' })
  repositories = [{ id: 30, full_name: 'owner/repo' }]
  await deliver(repoChange('added'), 'added', 'installation_repositories')
  await deliver(payload(), 'removed-item'); expect(tasks()[0]?.title).toBe('Unavailable edit')
  current = item({ title: 'Still authorized' })
  await deliver(repoChange('removed'), 'stale-remove', 'installation_repositories')
  await deliver(payload(), 'after-stale-remove'); expect(tasks()[0]?.title).toBe('Still authorized')
})
it('refuses to resurrect a deleted installation from old creation deliveries', async () => {
  installationState = 'deleted'
  await deliver({ action: 'created', installation: { id: 20 } }, 'created', 'installation')
  expect(await (await deliver()).json()).toEqual({ status: 'ignored' })
  expect(tasks()[0]?.title).toBe('Imported title'); expect(itemRequests).toBe(0)
})
it('fails upstream errors without acknowledging or recording success, allowing retry', async () => {
  apiError = 403
  expect((await deliver()).status).toBe(502); expect(tasks()[0]?.title).toBe('Imported title')
  apiError = 0
  expect(await (await deliver()).json()).toEqual({ status: 'applied' })
})
it('checks one repository without enumerating thousands of unrelated repositories and refuses changed item identities', async () => {
  repositories = [...Array.from({ length: 2_000 }, (_, i) => ({ id: 100 + i, full_name: `owner/repo${i}` })), ...repositories]
  expect((await deliver()).status).toBe(200)
  expect(requestedPaths).toEqual(['/app/installations/20', '/repos/owner/repo/installation', '/app/installations/20/access_tokens', '/repos/owner/repo', '/repos/owner/repo/issues/1'])
  current = item({ id: 999, title: 'Wrong identity' })
  expect((await deliver(payload(), 'identity')).status).toBe(409)
  expect(tasks()[0]?.title).toBe('Current title')
})
it('serializes the canonical read and write across concurrent deliveries', async () => {
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const firstRead = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  holdItem = async () => { entered(); await held }
  const first = deliver(payload(), 'first')
  await firstRead
  current = item({ state: 'closed', title: 'Final title' })
  const second = deliver(payload(), 'second')
  release(); holdItem = undefined
  expect((await first).status).toBe(200); expect((await second).status).toBe(200)
  expect(tasks()[0]).toMatchObject({ title: 'Final title', statusId: 'completed' })
})
it('aborts before any API request when its total deadline has expired', async () => {
  const raw = JSON.stringify(payload())
  const delivery = parseGithubDelivery(Buffer.from(raw), headers(raw, 'aborted'), credentials)!
  await expect(reconcileGithubDelivery(delivery, credentials, fetch, AbortSignal.abort())).rejects.toThrow()
  expect(apiRequests).toBe(0)
})

it('does not accept a public repository outside the installation even if its metadata is readable', async () => {
  repositories = []
  metadata = { id: 30, full_name: 'owner/repo' }
  expect(await (await deliver()).json()).toEqual({ status: 'ignored' })
  expect(tasks()[0]?.title).toBe('Imported title')
  expect(requestedPaths).toEqual(['/app/installations/20', '/repos/owner/repo/installation'])
  repositories = [metadata]
  expect(await (await deliver()).json()).toEqual({ status: 'applied' })
})
it('denies membership belonging to another installation and permits retry after access returns', async () => {
  membership.id = 21
  expect(await (await deliver()).json()).toEqual({ status: 'ignored' })
  expect(itemRequests).toBe(0)
  membership.id = 20
  expect(await (await deliver()).json()).toEqual({ status: 'applied' })
})
it('rejects membership for another app and denies suspended repository membership', async () => {
  membership.app_id = 11
  expect((await deliver()).status).toBe(502)
  membership.app_id = 10; membership.suspended_at = '2026-11-10T12:00:00Z'
  expect(await (await deliver()).json()).toEqual({ status: 'ignored' })
  expect(itemRequests).toBe(0)
  membership.suspended_at = null
  expect(await (await deliver()).json()).toEqual({ status: 'applied' })
})
it('denies recreated repositories and changed canonical names before fetching their items', async () => {
  metadata = { id: 99, full_name: 'owner/repo' }
  expect(await (await deliver()).json()).toEqual({ status: 'ignored' })
  metadata = { id: 30, full_name: 'owner/other' }
  expect(await (await deliver()).json()).toEqual({ status: 'ignored' })
  expect(itemRequests).toBe(0); expect(tasks()[0]?.title).toBe('Imported title')
  metadata = undefined
  expect(await (await deliver()).json()).toEqual({ status: 'applied' })
})
it('reads only installation state for lifecycle notifications', async () => {
  expect((await deliver({ action: 'created', installation: { id: 20 } }, 'created', 'installation')).status).toBe(200)
  expect(requestedPaths).toEqual(['/app/installations/20'])
})
it('rejects invalid repository URL segments before requesting repository access', async () => {
  for (const repository of ['owner/..', 'owner/repo?x', '../repo', 'owner/repo/other']) {
    const value = { ...payload(), repository: { id: 30, full_name: repository } }
    expect((await deliver(value, repository)).status).toBe(502)
  }
  expect(requestedPaths).toEqual(Array(4).fill('/app/installations/20'))
})
it('returns a deadline failure and never writes an API read that finishes afterward', async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(Math.min(ms, 100)))
  holdItem = () => new Promise(resolve => setTimeout(resolve, 200))
  expect((await deliver()).status).toBe(503)
  await new Promise(resolve => setTimeout(resolve, 220))
  expect(tasks()[0]?.title).toBe('Imported title')
})

it('reconciles mixed repository access and permits a configured repository missing from the imported membership list', async () => {
  repositories = [{ id: 31, full_name: 'owner/newrepo' }]
  const apply = vi.spyOn(store, 'applyGithubDelivery')
  expect((await deliver({ action: 'added', installation: { id: 20 }, repositories_added: [{ id: 30, full_name: 'owner/repo' }, ...repositories] }, 'mixed', 'installation_repositories')).status).toBe(200)
  const expected = { kind: 'access', installationState: 'active', repositories: [
    { repositoryId: '30', repositoryFullName: 'owner/repo', accessible: false },
    { repositoryId: '31', repositoryFullName: 'owner/newrepo', accessible: true },
  ] }
  expect(apply).toHaveBeenLastCalledWith(expect.objectContaining(expected))
  expect(requestedPaths).toEqual(['/app/installations/20', '/repos/owner/repo/installation', '/repos/owner/newrepo/installation', '/app/installations/20/access_tokens', '/repos/owner/newrepo'])
  expect((await deliver({ action: 'removed', installation: { id: 20 }, repositories_removed: [{ id: 30, full_name: 'owner/repo' }, ...repositories] }, 'stale-mixed-remove', 'installation_repositories')).status).toBe(200)
  expect(apply).toHaveBeenLastCalledWith(expect.objectContaining(expected))
  expect(await (await deliver()).json()).toEqual({ status: 'ignored' })
  current = item({ id: 41, title: 'New repository issue', html_url: 'https://github.com/owner/newrepo/issues/1' })
  const value = { ...payload(), repository: repositories[0], issue: current }
  expect(await (await deliver(value, 'new-repository')).json()).toEqual({ status: 'applied' })
  expect(tasks()).toHaveLength(2)
  expect(tasks().find(task => task.id !== 'imported')?.title).toBe('New repository issue')
})
