import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { Tasks } from '../src/core/tasks'
import { TaskStore } from '../src/tasks/store'
import { seedTasks, taskFixture as f } from './helpers/tasks'
import type { Agent } from '../src/shared/types'

let dir: string, db: Db, store: TaskStore, tasks: Tasks
const agent: Agent = { id: 'agent', name: 'Aster', handle: 'aster', role: '', color: 'sky', instructions: '', modelId: 'gpt-6-astra', effort: 'low', limit: 100, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tasks-adapter-'))
  db = new Db(join(dir, 'tucano.db'))
  store = seedTasks(join(dir, 'tasks.sqlite'))
  tasks = new Tasks(db, store)
  db.saveAgent(agent)
})
afterEach(() => { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })

it('retains deployed responsibility keys across restart without changing grants or starting work', async () => {
  const source = store.source()!
  db.setMeta(`orbit:assignment:${JSON.stringify([source.id, source.workspaceId, f.taskId, 'executor'])}`, agent.id)
  expect(await tasks.detail(source.id, f.taskId)).toMatchObject({ assignments: { executor: agent.id, reviewer: null } })
  await tasks.assign({ sourceId: source.id, taskId: f.taskId, role: 'reviewer', agentId: agent.id })
  expect(db.agent(agent.id)?.grants).toEqual({})
  expect(db.taskActivity(source.id, source.workspaceId, f.taskId, db.ownerId()).executions).toEqual([])
  store.close(); store = new TaskStore(join(dir, 'tasks.sqlite')); tasks = new Tasks(db, store)
  expect(await tasks.detail(source.id, f.taskId)).toMatchObject({ assignments: { executor: agent.id, reviewer: agent.id } })
  db.saveAgent({ ...agent, archived: true })
  await expect(tasks.start({ sourceId: source.id, taskId: f.taskId, role: 'executor', requestId: randomUUID() }, () => { throw new Error('must not launch') })).rejects.toThrow()
})

it('keeps task evidence private even when the owner can read the task', async () => {
  const source = store.source()!
  const owner = db.owner()
  db.createConversation({ id: 'private-dm', kind: 'dm', name: agent.id, members: [agent.id], owner: owner.id })
  const root = { id: 'root', conversationId: 'private-dm', author: { kind: 'person' as const, id: owner.id }, at: 1, text: 'private' }
  db.createTaskExecution({ id: 'execution', sourceId: source.id, workspaceId: source.workspaceId, taskId: f.taskId, requestId: 'request', requesterId: owner.id, role: 'executor', agentId: agent.id, agentName: agent.name, conversationId: root.conversationId, rootMessageId: root.id, createdAt: 1, state: 'queued' }, root)
  expect((await tasks.activity(source.id, f.taskId, owner)).executions).toHaveLength(1)
  expect((await tasks.activity(source.id, f.taskId, { ...owner, id: 'someone-else', role: 'member' })).executions).toEqual([])
  await expect(tasks.activity('another-source', f.taskId, owner)).rejects.toThrow()
})
