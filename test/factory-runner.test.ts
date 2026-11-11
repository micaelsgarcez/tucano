import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Factory } from '../src/factory/controller'
import { hash } from '../src/factory/hooks'
import { Db } from '../src/core/db'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { Tasks } from '../src/core/tasks'
import type { Ports } from '../src/factory/types'
import type { FactoryBridge } from '../src/core/factory'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'
import { fakeEngine } from '../src/core/engines/fake'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { factoryConfig, testPorts } from './helpers/factory'
import { seedTasks, taskFixture } from './helpers/tasks'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup(run: (turn: Turn) => AsyncIterable<EngineEvent>, packagePath?: string, engine: 'codex' | 'claude' = 'codex', humanPrompt = 'Fix the bug', extra: Partial<Ports> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-runner-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'factory'); mkdirSync(root)
  const db = new Db(join(dir, 'native.sqlite')); cleanups.push(() => db.close())
  const cfg = factoryConfig(root, db.ownerId())
  if (packagePath) { rmSync(join(root, 'package'), { recursive: true }); cpSync(packagePath, join(root, 'package'), { recursive: true }); cfg.packageHash = hash(readFileSync(join(root, 'package/manifest.json'))) }
  const store = seedTasks(join(dir, 'tasks.sqlite')); cleanups.push(() => store.close()); const tasks = new Tasks(db, store)
  const gateway = new Gateway(); await gateway.start(); cleanups.push(() => gateway.stop())
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Owner', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1_000_000, approvalTtlHours: 24, theme: 'system', language: 'en' }
  const agents = [cfg.executorAgentId, cfg.helperAgentId, cfg.reviewerAgentId, 'ordinary1', 'ordinary2', 'ordinary3']
  for (const id of agents) {
    const agent: Agent = { id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: engine === 'codex' ? 'gpt-5.6-luna' : 'sonnet', fallbackModelId: 'sonnet', effort: 'medium', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
    db.saveAgent(agent); db.createConversation({ id: `dm-${id}`, kind: 'dm', name: id, members: [id], owner: db.ownerId() })
  }
  let factory: Factory; let fallbackCalls = 0
  const engines: Record<EngineId, Engine> = { codex: { id: 'codex', run }, claude: { id: 'claude', run: turn => { if (engine === 'claude') return run(turn); fallbackCalls++; return fakeEngine('claude').run(turn) } }, opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline') }
  const bridge: FactoryBridge = {
    bind: (agentId, conversationId, threadId, messageId) => { const execution = db.taskExecution(conversationId, threadId); return execution && factory.bind(execution.requestId, agentId, messageId) },
    intake: () => undefined,
    computerAllowed: () => false,
    close: () => {},
    completed: async message => { const execution = db.taskExecution(message.conversationId, message.threadId); if (execution && message.author.kind === 'agent' && message.run) await factory.completed(execution.requestId, { id: message.id, author: message.author, text: message.text, run: { status: message.run.status, error: message.run.error, errorDetail: message.run.errorDetail }, usage: db.receiptsSince(0).filter(r => r.messageId === message.id).map(r => ({ ...r, id: String(r.receiptId) })) }) }
  }
  const runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: join(dir, 'agents'), gateway, factory: () => bridge })
  factory = new Factory(root, cfg, {
    ...testPorts(root),
    createTask: async input => (await tasks.create({ sourceId: taskFixture.sourceId, ...input })).task,
    task: async id => (await tasks.detail(taskFixture.sourceId, id)).task,
    stop: () => {}, completeTask: async () => {}, comment: async () => {}, ...extra,
    launch: async input => {
      const detail = await tasks.detail(taskFixture.sourceId, input.taskId); const agent = db.agent(input.agentId)!; const conversation = db.conversation(`dm-${agent.id}`)!
      return runner.startTask({ source: store.source()!, detail, agent, conversation, requester: db.owner(), role: input.role, requestId: input.requestId, instructions: input.instructions })
    }
  }); cleanups.push(() => factory.close())
  await factory.start({ taskId: taskFixture.taskId, criteria: ['Correct behavior'] }, { personId: db.ownerId(), messageId: 'human', conversationId: 'leo', prompt: humanPrompt })
  const attempt = factory.store.active()!; factory.store.transition(attempt.id, 'build')
  const launchBuild = async () => {
    const job = factory.store.newJob(attempt.id, 'build'); const detail = await tasks.detail(taskFixture.sourceId, attempt.taskId)
    const execution = runner.startTask({ source: store.source()!, detail, agent: db.agent(cfg.executorAgentId)!, conversation: db.conversation(`dm-${cfg.executorAgentId}`)!, requester: db.owner(), role: 'executor', requestId: job.id })
    factory.store.launched(job.id, execution.id); return job
  }
  return { dir, root, db, cfg, factory, runner, attempt, launchBuild, fallbackCalls: () => fallbackCalls }
}
const done = (text: string): EngineEvent => ({ type: 'done', text, usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 3 } })
test.each(['build-first', 'helper-first'])('native queue completes readonly child and continuation (%s); exact hooks reach provider', async ordering => {
  let helperSettled!: () => void; const helperDone = new Promise<void>(resolve => { helperSettled = resolve })
  const seen: Turn[] = []; const roles: string[] = []; let buildCount = 0; let helperFinished!: () => void
  const completedHelper = new Promise<void>(resolve => { helperFinished = resolve })
  let releaseOrdinary!: () => void; const ordinaryWait = new Promise<void>(resolve => { releaseOrdinary = resolve })
  const f = await setup(async function* (turn) {
    seen.push(turn)
    if (!turn.system.includes('EXACT PINNED')) { await ordinaryWait; yield done('ordinary'); return }
    expect(turn.model).toBe('gpt-5.6-luna'); expect(turn.effort).toBe('medium'); expect(turn.web).toBe(false); expect(turn.session).toBeUndefined()
    const client = new Client({ name: 'factory-test', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl!)))
    try {
      const names = (await client.listTools()).tools.map(t => t.name)
      expect(names).not.toContain('propor_skill'); expect(names).not.toContain('ask_user'); expect(names).not.toContain('start_service')
      if (names.includes('factory_delegate')) {
        roles.push('build'); buildCount++
        if (buildCount === 1) {
          const denied = await client.callTool({ name: 'bash', arguments: { command: 'echo not allowed yet' } }); expect(denied.isError).toBe(true)
          const queued = await client.callTool({ name: 'factory_delegate', arguments: { instruction: 'Read the baseline and report' } }); expect(queued.isError).toBe(false)
          if (ordering === 'helper-first') await helperDone
        } else { expect(turn.prompt).toContain('HELPER EVIDENCE'); helperFinished() }
      } else {
        roles.push('helper'); expect(turn.system).toContain('EXACT PINNED CHILD CONTEXT')
        expect(names).not.toContain('bash'); expect(names).not.toContain('factory_delegate')
        const denied = await client.callTool({ name: 'bash', arguments: { command: 'echo denied' } }); expect(denied.isError).toBe(true)
      }
    } finally { await client.close() }
    if (roles.at(-1) === 'helper') setTimeout(helperSettled, 10)
    yield done(roles.at(-1) === 'helper' ? 'HELPER EVIDENCE' : 'build done')
  })
  try {
    for (const id of ordering === 'build-first' ? ['ordinary1', 'ordinary2', 'ordinary3'] : []) await f.runner.send(`dm-${id}`, 'Wait')
    await f.launchBuild()
    await Promise.race([completedHelper, new Promise((_, reject) => setTimeout(() => reject(new Error('Child deadlocked behind parent')), 5000))])
  } finally { releaseOrdinary(); await f.runner.idle() }
  expect(roles).toEqual(['build', 'helper', 'build'])
  expect(f.fallbackCalls()).toBe(0)
  for (const j of f.factory.store.jobs(f.attempt.id)) {
    const delivery = JSON.parse(readFileSync(join(f.root, 'attempts', f.attempt.id, 'hooks', j.messageId!, 'delivery.json'), 'utf8'))
    expect(seen.some(t => hash(t.system) === delivery.systemSha256)).toBe(true)
  }
  expect(f.factory.store.get(f.attempt.id).blocked).toContain('export failed')
}, 15_000)
test('factory quota failures cannot call the configured reserve provider', async () => {
  let calls = 0
  const f = await setup(async function* () { calls++; yield { type: 'error', message: "You've hit your limit · resets 5pm" } })
  await f.launchBuild(); await f.runner.idle()
  expect(calls).toBe(1); expect(f.fallbackCalls()).toBe(0)
  expect(f.factory.store.get(f.attempt.id).blocked).toContain('ended failed')
})

test.runIf(!!process.env.FACTORY_TEST_PACKAGE).each(['codex', 'claude'] as const)('original pinned Ponytail context reaches native %s provider boundary byte-for-byte', async engine => {
  let delivered = ''
  const f = await setup(async function* (turn) {
    delivered = turn.system
    expect(delivered).toMatch(/PONYTAIL MODE ACTIVE.*level: full/)
    yield { type: 'error', message: 'Stop after deterministic delivery proof; no paid provider' }
  }, process.env.FACTORY_TEST_PACKAGE, engine)
  const job = await f.launchBuild(); await f.runner.idle()
  const finished = f.factory.store.job(job.id)!
  const dir = join(f.root, 'attempts', f.attempt.id, 'hooks', finished.messageId!)
  const receipt = JSON.parse(readFileSync(join(dir, 'delivery.json'), 'utf8'))
  const activation = JSON.parse(readFileSync(join(dir, 'receipt-0.json'), 'utf8'))
  expect(delivered).toContain(activation.context)
  expect(receipt.systemSha256).toBe(hash(delivered))
  expect(receipt.contextSha256).toBe(hash(activation.context))
})

test('a rejected hook blocks visibly and completes native accounting without calling a provider', async () => {
  let calls = 0
  const f = await setup(async function* () { calls++; yield done('unexpected') }, undefined, 'codex', '/ponytail band')
  await f.launchBuild(); await f.runner.idle()
  expect(calls).toBe(0)
  expect(f.factory.store.get(f.attempt.id).blocked).toContain('ended failed')
  expect(f.db.messages().filter(m => m.author.kind === 'agent').at(-1)?.run?.status).toBe('failed')
})


test.each([
  { modelId: 'gpt-6-astra', model: 'gpt-6-astra', effort: 'high' as const, engine: 'codex' as const },
  { modelId: 'codex:custom-model', model: 'custom-model', effort: 'xhigh' as const, engine: 'codex' as const },
  { modelId: 'sonnet', model: 'sonnet', effort: 'medium' as const, engine: 'claude' as const }
])('saved native profile reaches the provider and job evidence: $modelId $effort', async profile => {
  const seen: Turn[] = []
  const f = await setup(async function* (turn) { seen.push(turn); yield done('done') }, undefined, profile.engine)
  f.db.saveAgent({ ...f.db.agent(f.cfg.executorAgentId)!, modelId: profile.modelId, effort: profile.effort })
  const job = await f.launchBuild(); await f.runner.idle()
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ model: profile.model, effort: profile.effort, web: false })
  expect(f.factory.store.job(job.id)?.profile).toEqual(profile)
  expect(f.fallbackCalls()).toBe(0)
})

test('an unknown native model fails visibly before any provider or reserve is called', async () => {
  let calls = 0
  const f = await setup(async function* () { calls++; yield done('unexpected') })
  f.db.saveAgent({ ...f.db.agent(f.cfg.executorAgentId)!, modelId: 'unknown-unprefixed-model' })
  const job = await f.launchBuild(); await f.runner.idle()
  expect(calls).toBe(0); expect(f.fallbackCalls()).toBe(0)
  expect(f.factory.store.job(job.id)?.profile).toBeNull()
  const run = f.db.messages().find(m => m.id === f.factory.store.job(job.id)?.messageId)?.run
  expect(run?.status).toBe('failed')
  expect(`${run?.error} ${run?.errorDetail}`).toContain('unknown model')
})


test('a known native model from an unsupported engine cannot escape the factory tool boundary', async () => {
  let calls = 0
  const f = await setup(async function* () { calls++; yield done('unexpected') })
  f.db.saveAgent({ ...f.db.agent(f.cfg.executorAgentId)!, modelId: 'opencode:some-model' })
  const job = await f.launchBuild(); await f.runner.idle()
  expect(calls).toBe(0); expect(f.fallbackCalls()).toBe(0)
  expect(f.factory.store.job(job.id)?.profile).toBeNull()
  const run = f.db.messages().find(m => m.id === f.factory.store.job(job.id)?.messageId)?.run
  expect(run?.status).toBe('failed')
  expect(`${run?.error} ${run?.errorDetail}`).toContain('Codex or Claude')
})


test('a native queue bind refusal fails visibly and releases accounting without calling a provider', async () => {
  let assigned = true; let providers = 0; const comments: string[] = []
  const f = await setup(async function* () { providers++; yield done('unexpected') }, undefined, 'codex', 'Fix', {
    assertSkills: () => { if (!assigned) throw new Error('Required pinned skill was unassigned before bind') },
    comment: async (_, text) => { comments.push(text) }
  })
  const pending = f.launchBuild(); assigned = false
  const job = await pending; await f.runner.idle()
  expect(providers).toBe(0); expect(f.fallbackCalls()).toBe(0)
  const settled = f.factory.store.job(job.id)!
  expect(settled.state).toBe('failed'); expect(settled.messageId).toBeTruthy()
  const message = f.db.message(settled.messageId!)!
  expect(message.run?.status).toBe('failed')
  expect(message.run?.endedAt).toBeTypeOf('number')
  expect(`${message.run?.error} ${message.run?.errorDetail}`).toContain('unassigned before bind')
  expect(f.factory.store.get(f.attempt.id).blocked).toContain('unassigned before bind')
  expect(comments.some(text => text.includes('unassigned before bind'))).toBe(true)
  expect(f.db.taskExecution(message.conversationId, message.threadId)?.state).toBe('started')
})
