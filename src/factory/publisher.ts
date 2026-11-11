import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { id, object, sha, string } from './types'

export interface PublishInput { attemptDir: string; attemptId: string; candidateSha: string; baseSha: string; title: string; body: string; signal?: AbortSignal }
export interface PublicationConfig { repository: { id: number; fullName: string }; base: string; requiredChecks: string[] }
export type Publication = { state: 'waiting' | 'conflict'; reason: string } | {
  state: 'published'; pr: number; url: string; candidateSha: string
  ci: { passed: boolean; checks: { name: string; state: string }[]; source: 'controller'; observedAt: number }
  merged: boolean; by: string | null; byType: string | null
}
export type PublicationCredentials = () => Promise<{ token: string } | { waiting: string }>
class Halt extends Error { constructor(readonly state: 'waiting' | 'conflict', message: string) { super(message) } }
const execute = promisify(execFile)
function integer(v: unknown): number { if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error('Invalid number'); return v }
function rows(v: unknown): unknown[] { if (!Array.isArray(v)) throw new Error('Invalid list'); return v }

export class Publisher {
  constructor(private readonly config: PublicationConfig, private readonly credentials: PublicationCredentials,
    private readonly dependencies: { fetch?: typeof fetch; remote?: string } = {}) {
    if (config.repository.id !== 1423677589 || config.repository.fullName !== 'micaelsgarcez/central' || config.base !== 'main' || !config.requiredChecks.length) throw new Error('Invalid publication repository')
  }

  async publish(input: PublishInput): Promise<Publication> {
    let temporary: string | undefined
    const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(120_000)])
    try {
      const candidate = sha(input.candidateSha), base = sha(input.baseSha), branch = `factory/${id(input.attemptId)}`
      const credential = async () => {
        signal.throwIfAborted()
        const c = await this.credentials()
        if ('waiting' in c) throw new Halt('waiting', c.waiting)
        if (!c.token || /[\r\n]/.test(c.token)) throw new Halt('waiting', 'GitHub credential unavailable')
        signal.throwIfAborted()
        return c.token
      }
      let token = await credential()
      const api = async (path: string, permission: string, body?: unknown): Promise<unknown> => {
        if (body !== undefined) token = await credential()
        const response = await (this.dependencies.fetch ?? fetch)(`https://api.github.com/repos/${this.config.repository.fullName}${path}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (response.status === 404 && path.startsWith('/git/ref/')) return null
        if (!response.ok) {
          const limited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
          throw new Halt('waiting', limited ? 'GitHub rate limit reached; retry later' : `GitHub ${permission}: HTTP ${response.status}; ${response.status === 401 || response.status === 403 ? 'check connector access' : 'retry required'}`)
        }
        return response.json()
      }
      const repository = object(await api('', 'repository read'))
      if (repository.id !== this.config.repository.id || repository.full_name !== this.config.repository.fullName) throw new Halt('conflict', 'GitHub repository identity mismatch')
      try {
        const receipt = object(JSON.parse(await readFile(join(input.attemptDir, 'candidate.json'), 'utf8')))
        const verified = object(JSON.parse(await readFile(join(input.attemptDir, 'verify.json'), 'utf8')))
        if (receipt.candidateSha !== candidate || receipt.baseSha !== base || verified.candidateSha !== candidate || verified.passed !== true) throw new Error('Mismatch')
      } catch { throw new Halt('conflict', 'Candidate verification receipt missing, invalid or mismatched') }
      temporary = await mkdtemp(join(tmpdir(), 'factory-publish-'))
      const directory = temporary
      const git = async (args: string[], secret?: string) => {
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: directory, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '4',
          GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
          GIT_CONFIG_KEY_2: 'http.followRedirects', GIT_CONFIG_VALUE_2: 'false', GIT_CONFIG_KEY_3: 'protocol.file.allow', GIT_CONFIG_VALUE_3: 'always' }
        if (secret) { env.GIT_CONFIG_COUNT = '5'; env.GIT_CONFIG_KEY_4 = 'http.https://github.com/.extraheader'; env.GIT_CONFIG_VALUE_4 = `Authorization: Basic ${Buffer.from(`x-access-token:${secret}`).toString('base64')}` }
        try { return (await execute('git', args, { cwd: directory, env, signal, timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout.trim() }
        catch {
          signal.throwIfAborted()
          throw args[0] === 'push' ? new Halt('waiting', 'Git push unavailable; check transport and contents write permission, then retry') : new Halt('conflict', 'Local candidate Git validation failed; inspect baseline and bundle')
        }
      }
      await git(['init', '--bare', '--template=', directory])
      // Shallow export bundles can require the trusted baseline's objects, never its configuration.
      const objects = join(input.attemptDir, 'baseline', '.git', 'objects')
      if (/[\r\n]/.test(objects)) throw new Halt('conflict', 'Invalid baseline path')
      await writeFile(join(directory, 'objects/info/alternates'), `${objects}\n`)
      const shallowPath = join(input.attemptDir, 'baseline', '.git', 'shallow')
      try {
        const stat = await lstat(shallowPath)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid boundary file')
        const shallow = await readFile(shallowPath, 'utf8')
        if (!/^(?:[0-9a-f]{40}\n)+$/.test(shallow)) throw new Error('Invalid boundary commits')
        await writeFile(join(directory, 'shallow'), shallow)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Halt('conflict', 'Invalid trusted baseline shallow boundary')
      }
      await git(['fetch', '--no-tags', join(input.attemptDir, 'candidate.bundle'), 'HEAD'])
      if (await git(['rev-parse', 'FETCH_HEAD']) !== candidate || await git(['show', '-s', '--format=%P', candidate]) !== base) throw new Halt('conflict', 'Bundle commit or parent differs from verified candidate')
      const list = async (path: string, permission: string, key?: string): Promise<unknown[]> => {
        const all: unknown[] = []
        for (let page = 1; page <= 100; page++) {
          const value = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, permission)
          const batch = rows(key ? object(value)[key] : value); all.push(...batch)
          if (batch.length < 100) return all
        }
        throw new Halt('waiting', 'GitHub pagination limit reached')
      }
      const query = `/pulls?state=all&head=${encodeURIComponent(`micaelsgarcez:${branch}`)}`
      let pulls = await list(query, 'pull requests read')
      if (pulls.length > 1) throw new Halt('conflict', 'Multiple publication pull requests')
      const readPr = async (number: number) => {
        const pr = object(await api(`/pulls/${number}`, 'pull requests read')), h = object(pr.head), b = object(pr.base)
        if (h.sha !== candidate || h.ref !== branch || b.ref !== this.config.base || object(h.repo).id !== this.config.repository.id || object(b.repo).id !== this.config.repository.id) throw new Halt('conflict', 'Pull request head or base differs from candidate')
        if (pr.state !== 'open' && pr.merged !== true) throw new Halt('conflict', 'Publication pull request is closed without merge')
        return pr
      }
      const existing = pulls.length ? await readPr(integer(object(pulls[0]).number)) : null
      const refPath = `/git/ref/heads/${branch}`
      const head = async () => { const value = await api(refPath, 'contents read'); return value === null ? null : string(object(object(value).object).sha) }
      let remoteHead = await head()
      if (remoteHead && remoteHead !== candidate) throw new Halt('conflict', 'Publication branch has a different head')
      if (!remoteHead && existing && existing.merged !== true) throw new Halt('conflict', 'Open publication pull request branch is missing')
      if (!remoteHead && !existing) {
        token = await credential()
        try { await git(['push', `--force-with-lease=refs/heads/${branch}:`, this.dependencies.remote ?? `https://github.com/${this.config.repository.fullName}.git`, `${candidate}:refs/heads/${branch}`], token) }
        catch (error) {
          remoteHead = await head()
          if (remoteHead && remoteHead !== candidate) throw new Halt('conflict', 'Publication branch was concurrently created at a different head')
          if (remoteHead !== candidate) throw error
        }
      }
      const before = await head()
      if (before !== candidate && !(before === null && existing?.merged === true)) throw new Halt('conflict', 'Publication branch changed')
      if (!pulls.length) {
        await api('/pulls', 'pull requests write', { head: branch, base: this.config.base, title: input.title, body: input.body })
        pulls = await list(query, 'pull requests read')
      }
      if (pulls.length !== 1) throw new Halt(pulls.length ? 'conflict' : 'waiting', 'Expected exactly one publication pull request')
      const number = integer(object(pulls[0]).number)
      await readPr(number)
      const checks = new Map<string, { id: number; name: string; state: string }>()
      const parseRun = (value: unknown) => {
        const r = object(value), repository = object(r.repository), headRepository = object(r.head_repository)
        if (r.head_sha !== candidate || r.head_branch !== branch || headRepository.id !== this.config.repository.id || repository.id !== this.config.repository.id || repository.full_name !== this.config.repository.fullName) throw new Halt('waiting', 'Actions run differs from candidate repository, branch or SHA')
        return { id: integer(r.id), workflow: integer(r.workflow_id), event: string(r.event), attempt: integer(r.run_attempt), status: string(r.status), conclusion: r.conclusion === null ? null : string(r.conclusion) }
      }
      const runs = new Map<string, ReturnType<typeof parseRun>>()
      for (const item of await list(`/actions/runs?head_sha=${candidate}&branch=${encodeURIComponent(branch)}`, 'actions read', 'workflow_runs')) {
        const run = parseRun(item), key = `${run.workflow}:${run.event}`, previous = runs.get(key)
        if (!previous || run.id > previous.id || (run.id === previous.id && run.attempt > previous.attempt)) runs.set(key, run)
      }
      let runsPassed = runs.size > 0
      for (const run of runs.values()) {
        const runPassed = run.status === 'completed' && run.conclusion === 'success'
        runsPassed &&= runPassed
        for (const item of await list(`/actions/runs/${run.id}/attempts/${run.attempt}/jobs`, 'actions read', 'jobs')) {
          const job = object(item), name = string(job.name)
          if (job.run_id !== run.id || job.run_attempt !== run.attempt || job.head_sha !== candidate) throw new Halt('waiting', 'Actions job differs from candidate run or attempt')
          const state = job.status !== 'completed' ? 'pending' : string(job.conclusion)
          checks.set(`job:${run.id}:${integer(job.id)}`, { id: integer(job.id), name, state: runPassed ? state : run.status === 'completed' ? run.conclusion ?? 'pending' : 'pending' })
        }
        const current = parseRun(await api(`/actions/runs/${run.id}`, 'actions read'))
        if (current.id !== run.id || current.workflow !== run.workflow || current.event !== run.event || current.attempt !== run.attempt || current.status !== run.status || current.conclusion !== run.conclusion) throw new Halt('waiting', 'Actions run changed during CI observation; retry required')
      }
      const actions = [...checks.values()]
      for (const item of await list(`/commits/${candidate}/statuses`, 'statuses read')) {
        const c = object(item), name = string(c.context), key = `status:${name}`, n = integer(c.id)
        if (n > (checks.get(key)?.id ?? -1)) checks.set(key, { id: n, name, state: string(c.state) })
      }
      const pr = await readPr(number)
      const after = await head()
      if (after !== candidate && !(after === null && pr.merged === true)) throw new Halt('conflict', 'Publication branch changed during CI observation')
      const observed = [...checks.values()].map(({ name, state }) => ({ name, state }))
      const passed = runsPassed && this.config.requiredChecks.every(name => actions.some(c => c.name === name)) && this.config.requiredChecks.every(name => { const matches = observed.filter(c => c.name === name); return matches.length > 0 && matches.every(c => c.state === 'success') })
      const merger = pr.merged_by === null || pr.merged_by === undefined ? null : object(pr.merged_by)
      return { state: 'published', pr: number, url: `https://github.com/${this.config.repository.fullName}/pull/${number}`, candidateSha: candidate,
        ci: { passed, checks: observed, source: 'controller', observedAt: Date.now() }, merged: pr.merged === true, by: merger ? string(merger.login) : null, byType: merger ? string(merger.type) : null }
    } catch (error) {
      return error instanceof Halt ? { state: error.state, reason: error.message } : { state: 'waiting', reason: signal.aborted ? 'Publication cancelled or timed out' : 'Publication could not be verified; retry required' }
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }) }
  }
}
