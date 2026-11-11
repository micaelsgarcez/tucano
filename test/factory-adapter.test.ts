import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { Skills } from '../src/core/skills'
import { Publisher } from '../src/factory/publisher'
import { Db } from '../src/core/db'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { Tasks } from '../src/core/tasks'
import { openFactory } from '../src/core/factory'
import { Store } from '../src/factory/store'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { factoryConfig, testPorts } from './helpers/factory'
import { seedTasks, taskFixture } from './helpers/tasks'

test('real owner-to-Leo adapter creates once, dispatches native task, records review and completes only after human gate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-adapter-')); const root = join(directory, 'factory'); mkdirSync(root)
  const db = new Db(join(directory, 'native.sqlite'))
  const taskPath = join(directory, 'tasks.sqlite'); const taskStore = seedTasks(taskPath); const tasks = new Tasks(db, taskStore)
  const fixtureDb = new DatabaseSync(taskPath)
  const completeStatus = '88888888-8888-4888-8888-888888888888'
  const otherTask = '99999999-9999-4999-8999-999999999999'
  fixtureDb.prepare('INSERT INTO task_module_rows VALUES(?,?,?)').run('task_statuses', completeStatus, JSON.stringify({ id: completeStatus, workspace_id: taskFixture.workspaceId, project_id: taskFixture.projectId, name: 'Done', category: 'completed', position: 1 }))
  fixtureDb.prepare('INSERT INTO task_module_rows VALUES(?,?,?)').run('tasks', otherTask, JSON.stringify({ id: otherTask, workspace_id: taskFixture.workspaceId, project_id: taskFixture.otherProjectId, status_id: taskFixture.statusId, title: 'Private', description: 'Private', priority: 'none', number: 1, creator_id: taskFixture.ownerId, created_at: 1, updated_at: 1, version: 0 }))
  fixtureDb.close()
  const skills = new Skills({ db, emit: () => {} })
  const connectors = { githubToken: async () => ({ waiting: 'permissions pending' }) }
  const publish = vi.spyOn(Publisher.prototype, 'publish').mockImplementation(testPorts(root).publish)
  const cfg = factoryConfig(root, db.ownerId())
  cfg.operationsPath = join(root, 'operations.py')
  writeFileSync(cfg.operationsPath, `import pathlib,json,sys\np=pathlib.Path(sys.argv[2])\nif sys.argv[1]=='export':\n (p/'candidate.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','baseSha':'${'b'.repeat(40)}'}))\n (p/'candidate.bundle').write_bytes(b'bundle')\n (p/'candidate.patch').write_text('candidate patch')\nif sys.argv[1]=='verify': (p/'verify.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','passed':True}))\n`)
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg))
  writeFileSync(join(root, 'publication.py'), `import json,pathlib,sys\np=pathlib.Path(sys.argv[2])\nif sys.argv[1]=='assess': (p/('assessment-'+sys.argv[5]+'.json')).write_text(json.dumps({'decision':'approved','review':{}}))\n`)
  const gateway = new Gateway(); await gateway.start()
  for (const id of [cfg.intakeAgentId, cfg.executorAgentId, cfg.helperAgentId, cfg.reviewerAgentId]) {
    const agent: Agent = { id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'gpt-5.6-luna', effort: 'medium', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
    db.saveAgent(agent)
  }
  db.createConversation({ id: 'leo-dm', kind: 'dm', name: cfg.intakeAgentId, members: [cfg.intakeAgentId], owner: db.ownerId() })
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Owner', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1_000_000, approvalTtlHours: 24, theme: 'system', language: 'en' }
  let bridge: ReturnType<typeof openFactory>
  const engine: Engine = { id: 'codex', run: async function* (turn: Turn): AsyncIterable<EngineEvent> {
    const client = new Client({ name: 'native-factory-adapter-test', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl!)))
    let text = 'done'
    try {
      const names = (await client.listTools()).tools.map(t => t.name)
      if (names.includes('factory_start')) {
        const args = { title: 'Native factory fix', instruction: 'Correct a small behavior', criteria: ['Observed result is correct'] }
        const first = await client.callTool({ name: 'factory_start', arguments: args }); const replay = await client.callTool({ name: 'factory_start', arguments: args })
        expect(first.isError).toBe(false); expect(replay.isError).toBe(false)
      } else if (names.includes('factory_delegate')) {
        await client.callTool({ name: 'ler_skill', arguments: { nome: 'pstack' } })
        expect(turn.model).toBe('gpt-5.6-luna'); expect(turn.effort).toBe('medium')
      } else {
        expect(names).toContain('factory_read'); expect(names).not.toContain('bash'); expect(turn.effort).toBe('medium')
        const packet = await client.callTool({ name: 'factory_read', arguments: { path: '@packet' } }); expect(packet.isError).toBe(false)
        text = 'Independent review recorded'
      }
    } finally { await client.close() }
    yield { type: 'done', text, usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 2 } }
  } }
  const engines: Record<EngineId, Engine> = { codex: engine, claude: fakeEngine('claude'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline') }
  const runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: join(directory, 'agents'), gateway, factory: () => bridge })
  let store: Store | undefined
  try {
    bridge = openFactory({ dataDir: directory, db, tasks, runner, skills, connectors, emitConversation: () => {} })
    expect(bridge).toBeDefined()
    db.saveMessage({ id: 'scope-message', conversationId: 'leo-dm', author: { kind: 'person', id: db.ownerId() }, at: Date.now(), text: 'Use private task' })
    await expect(bridge!.intake(cfg.intakeAgentId, 'leo-dm', 'scope-message')!.call('factory_start', { taskId: otherTask, criteria: ['Private'] })).rejects.toThrow()
    db.saveMessage({ id: 'outsider-message', conversationId: 'leo-dm', author: { kind: 'person', id: 'outsider' }, at: Date.now(), text: 'Start' })
    expect(bridge!.intake(cfg.intakeAgentId, 'leo-dm', 'outsider-message')).toBeUndefined()
    expect(bridge!.intake(cfg.executorAgentId, 'leo-dm', 'scope-message')).toBeUndefined()
    expect(bridge!.intake(cfg.intakeAgentId, 'another-conversation', 'scope-message')).toBeUndefined()
    await runner.send('leo-dm', 'Use the factory for this small Central change'); await runner.idle()
    store = new Store(join(directory, 'factory.sqlite')); const attempt = store.active()!
    expect((await tasks.tasks(taskFixture.sourceId, taskFixture.projectId)).items).toHaveLength(2)
    expect(attempt.stage).toBe('prepare'); expect(attempt.humanPrompt).toBe('Use the factory for this small Central change')
    const attemptDir = join(root, 'attempts', attempt.id); writeFileSync(join(attemptDir, 'prepared.json'), '{}')
    await bridge!.tick(); await runner.idle()
    expect(store.get(attempt.id)).toMatchObject({ stage: 'review', blocked: null, candidateSha: 'a'.repeat(40) })
    const build = store.jobs(attempt.id)[0]!
    expect(build.executionId).toBeTruthy(); expect(build.messageId).toBeTruthy()
    expect(db.receiptsForMessage(build.messageId!)).toHaveLength(1)
    const message = db.message(build.messageId!)!
    expect(bridge!.intake(cfg.intakeAgentId, message.conversationId, message.threadId)).toBeUndefined()
    const activity = await tasks.activity(taskFixture.sourceId, attempt.taskId, db.owner())
    expect(activity.executions.some(e => e.id === build.executionId)).toBe(true)
    expect(message.run?.steps.some(s => s.detail === 'pstack' && s.status === 'done')).toBe(true)
    writeFileSync(join(attemptDir, 'publication.json'), JSON.stringify({ state: 'published', candidateSha: 'a'.repeat(40), pr: 7, ci: { passed: true, source: 'controller' } }))
    await bridge!.tick(); await runner.idle()
    expect(store.get(attempt.id).stage).toBe('merge')
    const review = store.jobs(attempt.id).find(j => j.role === 'review')!
    expect(JSON.parse(readFileSync(join(attemptDir, 'review-message.json'), 'utf8')).id).toBe(review.messageId)
    expect((await tasks.detail(taskFixture.sourceId, attempt.taskId)).task.statusId).toBe(taskFixture.statusId)
    writeFileSync(join(attemptDir, 'gate.json'), JSON.stringify({ state: 'published', candidateSha: 'a'.repeat(40), reviewMessageId: review.messageId, ciPassed: true, reviewPassed: true, merged: true, mergedByType: 'User', mergedBy: cfg.humanMergeLogin }))
    await bridge!.tick()
    expect((await tasks.detail(taskFixture.sourceId, attempt.taskId)).task.statusId).toBe(completeStatus)
    expect(store.get(attempt.id).stage).toBe('completed')
    expect(db.agents().every(a => !a.computer)).toBe(true)
    bridge!.close(); bridge = undefined
    writeFileSync(join(root, 'config.json'), JSON.stringify({ ...cfg, enabled: false }))
    expect(openFactory({ dataDir: directory, db, tasks, runner, skills, connectors, emitConversation: () => {} })).toBeUndefined()
  } finally { publish.mockRestore(); await runner.idle(); store?.close(); bridge?.close(); await gateway.stop(); taskStore.close(); db.close(); rmSync(directory, { recursive: true, force: true }) }
}, 15_000)
