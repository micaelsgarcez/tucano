import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Publisher, type PublishInput } from '../src/factory/publisher'

let root: string, remote: string, input: PublishInput, head: string | null, creates: number, prExists: boolean, denied: boolean, pending: boolean, race: boolean, changed: boolean, ambiguous: boolean
const attemptId = '11111111-1111-4111-8111-111111111111', branch = `factory/${attemptId}`, token = 'SENTINEL_PRIVATE_CREDENTIAL'
const config = { repository: { id: 1423677589, fullName: 'micaelsgarcez/central' }, base: 'main', requiredChecks: ['test'] }
function git(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function ref() { try { return git(remote, 'rev-parse', `refs/heads/${branch}`) } catch { return null } }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'publisher-test-')); remote = join(root, 'remote.git'); const baseline = join(root, 'baseline'); mkdirSync(baseline)
  git(root, 'init', '--bare', remote); git(baseline, 'init'); git(baseline, 'config', 'user.name', 'Test'); git(baseline, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(baseline, 'file'), 'base'); git(baseline, 'add', '.'); git(baseline, 'commit', '-m', 'base'); const baseSha = git(baseline, 'rev-parse', 'HEAD')
  writeFileSync(join(baseline, 'file'), 'candidate'); git(baseline, 'commit', '-am', 'candidate'); const candidateSha = git(baseline, 'rev-parse', 'HEAD')
  git(baseline, 'bundle', 'create', join(root, 'candidate.bundle'), 'HEAD', `^${baseSha}`)
  writeFileSync(join(root, 'candidate.json'), JSON.stringify({ baseSha, candidateSha })); writeFileSync(join(root, 'verify.json'), JSON.stringify({ candidateSha, passed: true }))
  input = { attemptDir: root, attemptId, baseSha, candidateSha, title: 'Test', body: 'Verified candidate' }
  head = null; creates = 0; prExists = false; denied = false; pending = false; race = false; changed = false; ambiguous = false
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const mockFetch: typeof fetch = async (url, init) => {
  const u = new URL(String(url)), path = u.pathname.replace('/repos/micaelsgarcez/central', '')
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
  if (!path) return json({ id: config.repository.id, full_name: config.repository.fullName })
  if (path.startsWith('/git/ref/')) {
    const current = ref()
    if (race && !current) { git(join(root, 'baseline'), 'push', remote, `${input.baseSha}:refs/heads/${branch}`); race = false; return json({}, 404) }
    return current ? json({ object: { sha: current } }) : json({}, 404)
  }
  if (path === '/pulls' && init?.method === 'POST') { creates++; prExists = true; if (ambiguous) { ambiguous = false; throw new Error(token) } return json({ number: 1 }) }
  if (path === '/pulls') return json(prExists ? [{ number: 1 }] : [])
  if (path === '/pulls/1') return json({ number: 1, state: 'open', merged: false, merged_by: null, head: { sha: head ?? input.candidateSha, ref: branch, repo: { id: config.repository.id } }, base: { ref: 'main', repo: { id: config.repository.id } } })
  if (path.endsWith('/check-runs')) {
    if (denied) return json({ message: token }, 403)
    if (changed) head = input.baseSha
    return json({ check_runs: [{ id: 2, name: 'test', status: pending ? 'in_progress' : 'completed', conclusion: 'success' }, { id: 1, name: 'test', status: 'completed', conclusion: 'failure' }] })
  }
  if (path.endsWith('/statuses')) return json([])
  throw new Error(`Unexpected path ${path}`)
}
function publisher(credentials = async () => ({ token })) { return new Publisher(config, credentials, { fetch: mockFetch, remote }) }
it('imports a prerequisite bundle and publishes exact SHA once across retries', async () => {
  expect(await publisher().publish(input)).toMatchObject({ state: 'published', candidateSha: input.candidateSha, ci: { passed: true, source: 'controller' } })
  expect(ref()).toBe(input.candidateSha); expect(await publisher().publish(input)).toMatchObject({ state: 'published' }); expect(creates).toBe(1)
})
it('recovers a PR creation whose response was lost without creating a duplicate', async () => {
  ambiguous = true; const first = await publisher().publish(input); expect(first.state).toBe('waiting'); expect(JSON.stringify(first)).not.toContain(token)
  expect((await publisher().publish(input)).state).toBe('published'); expect(creates).toBe(1)
})
it('waits on missing permissions then recovers', async () => {
  denied = true; const first = await publisher().publish(input); expect(first).toMatchObject({ state: 'waiting' }); expect(JSON.stringify(first)).not.toContain(token)
  denied = false; expect((await publisher().publish(input)).state).toBe('published'); expect(creates).toBe(1)
})
it('does not move an existing or racing branch even when push would fast forward', async () => {
  race = true; expect((await publisher().publish(input)).state).toBe('conflict'); expect(ref()).toBe(input.baseSha)
  expect((await publisher().publish(input)).state).toBe('conflict'); expect(ref()).toBe(input.baseSha); expect(creates).toBe(0)
})
it('reports pending CI and refuses a head changed during observation', async () => {
  pending = true; expect(await publisher().publish(input)).toMatchObject({ state: 'published', ci: { passed: false } })
  pending = false; changed = true; expect((await publisher().publish(input)).state).toBe('conflict')
})
it('rechecks the native grant immediately before writing', async () => {
  let calls = 0
  const p = new Publisher(config, async () => ++calls === 1 ? { token } : { waiting: 'Grant revoked' }, { fetch: mockFetch, remote })
  expect(await p.publish(input)).toEqual({ state: 'waiting', reason: 'Grant revoked' }); expect(ref()).toBeNull(); expect(creates).toBe(0)
})
it('rejects an unverified candidate before any write', async () => {
  writeFileSync(join(root, 'verify.json'), JSON.stringify({ candidateSha: input.baseSha, passed: true }))
  expect((await publisher().publish(input)).state).toBe('conflict'); expect(ref()).toBeNull()
})
it('requires both the latest check and latest status with the same name to pass', async () => {
  const fetchBoth: typeof fetch = async (url, init) => String(url).includes('/statuses')
    ? Response.json([{ id: 8, context: 'test', state: 'failure' }, { id: 7, context: 'test', state: 'success' }]) : mockFetch(url, init)
  const p = new Publisher(config, async () => ({ token }), { fetch: fetchBoth, remote })
  expect(await p.publish(input)).toMatchObject({ state: 'published', ci: { passed: false, checks: [{ name: 'test', state: 'success' }, { name: 'test', state: 'failure' }] } })
})
it('reads all check pages and uses the latest ID even across pages', async () => {
  const paginated: typeof fetch = async (url, init) => {
    if (!String(url).includes('/check-runs')) return mockFetch(url, init)
    const page = new URL(String(url)).searchParams.get('page')
    return Response.json({ check_runs: page === '1' ? Array.from({ length: 100 }, (_, i) => ({ id: i, name: 'test', status: 'completed', conclusion: 'failure' })) : [{ id: 101, name: 'test', status: 'completed', conclusion: 'success' }] })
  }
  expect(await new Publisher(config, async () => ({ token }), { fetch: paginated, remote }).publish(input)).toMatchObject({ state: 'published', ci: { passed: true } })
})
it('refuses wrong-base and closed-unmerged PRs and observes merge identity from detail', async () => {
  let mode = 'wrong-base'
  const detail: typeof fetch = async (url, init) => {
    const response = await mockFetch(url, init)
    if (!new URL(String(url)).pathname.endsWith('/pulls/1')) return response
    const value = await response.json()
    if (mode === 'wrong-base') value.base.ref = 'elsewhere'
    else { value.state = 'closed'; value.merged = mode === 'merged'; value.merged_by = { login: 'human', type: 'User' } }
    return Response.json(value)
  }
  const p = new Publisher(config, async () => ({ token }), { fetch: detail, remote })
  expect((await p.publish(input)).state).toBe('conflict'); mode = 'closed'; expect((await p.publish(input)).state).toBe('conflict')
  mode = 'merged'; expect(await p.publish(input)).toMatchObject({ state: 'published', merged: true, by: 'human', byType: 'User' }); expect(creates).toBe(1)
})
it('does no work after cancellation', async () => {
  const abort = new AbortController(); abort.abort()
  expect(await publisher().publish({ ...input, signal: abort.signal })).toEqual({ state: 'waiting', reason: 'Publication cancelled or timed out' })
  expect(ref()).toBeNull()
})
it('observes a merged PR after automatic branch deletion without recreating it', async () => {
  await publisher().publish(input); git(remote, 'update-ref', '-d', `refs/heads/${branch}`)
  const merged: typeof fetch = async (url, init) => {
    const response = await mockFetch(url, init)
    if (!new URL(String(url)).pathname.endsWith('/pulls/1')) return response
    const value = await response.json(); value.state = 'closed'; value.merged = true; value.merged_by = { login: 'human', type: 'User' }; return Response.json(value)
  }
  expect(await new Publisher(config, async () => ({ token }), { fetch: merged, remote }).publish(input)).toMatchObject({ state: 'published', merged: true, by: 'human', ci: { passed: true } })
  expect(ref()).toBeNull(); expect(creates).toBe(1)
})
it('does not recreate a missing branch for an open or closed-unmerged PR', async () => {
  await publisher().publish(input); git(remote, 'update-ref', '-d', `refs/heads/${branch}`)
  expect((await publisher().publish(input)).state).toBe('conflict'); expect(ref()).toBeNull()
  const closed: typeof fetch = async (url, init) => {
    const response = await mockFetch(url, init)
    if (!new URL(String(url)).pathname.endsWith('/pulls/1')) return response
    const value = await response.json(); value.state = 'closed'; return Response.json(value)
  }
  expect((await new Publisher(config, async () => ({ token }), { fetch: closed, remote }).publish(input)).state).toBe('conflict')
  expect(ref()).toBeNull(); expect(creates).toBe(1)
})
