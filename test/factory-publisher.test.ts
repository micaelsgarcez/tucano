import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
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
  if (path.startsWith('/actions/')) {
    if (denied) return json({ message: token }, 403)
    if (changed) head = input.baseSha
    if (path === '/actions/runs') { expect(u.searchParams.get('branch')).toBe(branch); return json({ workflow_runs: [workflow(), workflow({ id: 1, conclusion: 'failure' })] }) }
    if (path.endsWith('/jobs')) return json({ jobs: [job()] })
    if (path === '/actions/runs/2') return json(workflow())
  }
  if (path.endsWith('/statuses')) return json([])
  throw new Error(`Unexpected path ${path}`)
}
function workflow(overrides = {}) { return { id: 2, workflow_id: 10, event: 'pull_request', run_attempt: 1, head_sha: input.candidateSha, head_branch: branch, head_repository: { id: config.repository.id }, repository: { id: config.repository.id, full_name: config.repository.fullName }, status: pending ? 'in_progress' : 'completed', conclusion: 'success', ...overrides } }
function job(overrides = {}) { return { id: 20, run_id: 2, run_attempt: 1, head_sha: input.candidateSha, name: 'test', status: 'completed', conclusion: 'success', ...overrides } }
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
it('reads all run and job pages, selecting the latest workflow run across pages', async () => {
  const paginated: typeof fetch = async (url, init) => {
    const u = new URL(String(url)), page = u.searchParams.get('page')
    if (u.pathname.endsWith('/actions/runs')) return Response.json({ workflow_runs: page === '1' ? Array.from({ length: 100 }, () => workflow({ id: 1, conclusion: 'failure' })) : [workflow()] })
    if (u.pathname.endsWith('/jobs')) return Response.json({ jobs: page === '1' ? Array.from({ length: 100 }, (_, i) => job({ id: i, name: `other-${i}` })) : [job({ id: 101 })] })
    return mockFetch(url, init)
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
it('publishes from a depth-one baseline after remote main advances with complete remote connectivity', async () => {
  const source = join(root, 'source'), baseline = join(root, 'baseline')
  git(baseline, 'push', remote, 'HEAD:refs/heads/main'); git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(root, 'clone', remote, source); rmSync(baseline, { recursive: true }); git(root, 'clone', '--depth=1', `file://${remote}`, baseline)
  expect(git(baseline, 'rev-parse', '--is-shallow-repository')).toBe('true')
  git(baseline, 'config', 'user.name', 'Test'); git(baseline, 'config', 'user.email', 'test@example.com')
  input.baseSha = git(baseline, 'rev-parse', 'HEAD'); writeFileSync(join(baseline, 'candidate'), 'new'); git(baseline, 'add', '.'); git(baseline, 'commit', '-m', 'candidate from shallow base')
  input.candidateSha = git(baseline, 'rev-parse', 'HEAD'); git(baseline, 'bundle', 'create', join(root, 'candidate.bundle'), 'HEAD')
  writeFileSync(join(root, 'candidate.json'), JSON.stringify(input)); writeFileSync(join(root, 'verify.json'), JSON.stringify({ candidateSha: input.candidateSha, passed: true }))
  git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.com'); writeFileSync(join(source, 'advanced'), 'remote advancement'); git(source, 'add', '.'); git(source, 'commit', '-m', 'advance main'); git(source, 'push', 'origin', 'main')
  expect(await publisher().publish(input)).toMatchObject({ state: 'published', candidateSha: input.candidateSha })
  expect(ref()).toBe(input.candidateSha); expect(() => git(remote, 'fsck', '--connectivity-only')).not.toThrow()
})
it('reports corrupt bundles and receipts as local conflicts without token permission advice', async () => {
  writeFileSync(join(root, 'candidate.bundle'), 'corrupt')
  const bundle = await publisher().publish(input); expect(bundle).toEqual({ state: 'conflict', reason: 'Local candidate Git validation failed; inspect baseline and bundle' }); expect(ref()).toBeNull()
  writeFileSync(join(root, 'candidate.json'), '{broken')
  expect(await publisher().publish(input)).toMatchObject({ state: 'conflict', reason: 'Candidate verification receipt missing, invalid or mismatched' })
})
it('rejects malformed shallow boundaries before a write', async () => {
  writeFileSync(join(root, 'baseline/.git/shallow'), 'not-a-commit\n')
  expect(await publisher().publish(input)).toEqual({ state: 'conflict', reason: 'Invalid trusted baseline shallow boundary' }); expect(ref()).toBeNull()
})
it('reports rate limiting from safe headers without exposing response bodies', async () => {
  const limited: typeof fetch = async () => new Response(token, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
  expect(await new Publisher(config, async () => ({ token }), { fetch: limited, remote }).publish(input)).toEqual({ state: 'waiting', reason: 'GitHub rate limit reached; retry later' })
})

it('rejects a symlinked shallow boundary and keeps push failures recoverable', async () => {
  symlinkSync(join(root, 'candidate.json'), join(root, 'baseline/.git/shallow'))
  expect(await publisher().publish(input)).toEqual({ state: 'conflict', reason: 'Invalid trusted baseline shallow boundary' })
  rmSync(join(root, 'baseline/.git/shallow'))
  const unavailable = new Publisher(config, async () => ({ token }), { fetch: mockFetch, remote: join(root, 'absent.git') })
  expect(await unavailable.publish(input)).toEqual({ state: 'waiting', reason: 'Git push unavailable; check transport and contents write permission, then retry' }); expect(ref()).toBeNull()
})

it.each(['missing required job', 'pending job'])('does not accept a successful status with %s', async scenario => {
  const fetchMissing: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/jobs')) return Response.json({ jobs: scenario === 'missing required job' ? [] : [job({ status: 'queued', conclusion: null })] })
    if (path.endsWith('/statuses')) return Response.json([{ id: 1, context: 'test', state: 'success' }])
    return mockFetch(url, init)
  }
  expect(await new Publisher(config, async () => ({ token }), { fetch: fetchMissing, remote }).publish(input)).toMatchObject({ state: 'published', ci: { passed: false } })
})
it.each(['queued', 'failure', 'changed', 'old-sha', 'wrong-repository', 'wrong-branch', 'fork', 'old-attempt', 'wrong-run', 'old-job-sha', 'duplicate-name'])('rejects stale or unsuccessful Actions evidence: %s', async mode => {
  const evidence: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    const run = workflow(mode === 'queued' ? { run_attempt: 2, status: 'queued', conclusion: null }
      : mode === 'failure' ? { conclusion: 'failure' }
      : mode === 'old-sha' ? { head_sha: input.baseSha }
      : mode === 'wrong-branch' ? { head_branch: 'another-branch' }
      : mode === 'fork' ? { head_repository: { id: 1 } }
      : mode === 'wrong-repository' ? { repository: { id: 1, full_name: 'other/repo' } } : {})
    if (path.endsWith('/actions/runs')) return Response.json({ workflow_runs: mode === 'duplicate-name' ? [run, workflow({ id: 3, workflow_id: 11 })] : [run] })
    if (path.endsWith('/jobs')) return Response.json({ jobs: [job(mode === 'old-attempt' ? { run_attempt: 0 }
      : mode === 'wrong-run' ? { run_id: 1 } : mode === 'old-job-sha' ? { head_sha: input.baseSha }
      : path.includes('/runs/3/') ? { id: 30, run_id: 3, conclusion: 'failure' }
      : mode === 'queued' ? { run_attempt: 2 } : {})] })
    if (path.endsWith('/actions/runs/2')) return Response.json(mode === 'changed' ? workflow({ run_attempt: 2, status: 'queued', conclusion: null }) : run)
    if (path.endsWith('/actions/runs/3')) return Response.json(workflow({ id: 3, workflow_id: 11 }))
    return mockFetch(url, init)
  }
  const result = await new Publisher(config, async () => ({ token }), { fetch: evidence, remote }).publish(input)
  if (['queued', 'failure', 'duplicate-name'].includes(mode)) expect(result).toMatchObject({ state: 'published', ci: { passed: false } })
  else expect(result.state).toBe('waiting')
})
it('accepts a successful latest rerun and reads commit statuses across pages', async () => {
  const rerun: typeof fetch = async (url, init) => {
    const u = new URL(String(url)), path = u.pathname
    if (path.endsWith('/actions/runs')) return Response.json({ workflow_runs: [workflow({ run_attempt: 2 }), workflow({ run_attempt: 1, conclusion: 'failure' })] })
    if (path.endsWith('/actions/runs/2')) return Response.json(workflow({ run_attempt: 2 }))
    if (path.endsWith('/jobs')) {
      expect(path).toContain('/attempts/2/jobs')
      return Response.json({ jobs: [job({ run_attempt: 2 })] })
    }
    if (path.endsWith('/statuses')) return Response.json(u.searchParams.get('page') === '1'
      ? Array.from({ length: 100 }, (_, id) => ({ id, context: 'test', state: 'failure' })) : [{ id: 101, context: 'test', state: 'success' }])
    return mockFetch(url, init)
  }
  expect(await new Publisher(config, async () => ({ token }), { fetch: rerun, remote }).publish(input)).toMatchObject({ state: 'published', ci: { passed: true } })
})
