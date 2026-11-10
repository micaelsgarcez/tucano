import { beforeAll, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Person } from '../src/shared/types'
import type { TaskDetail, TaskSource } from '../src/shared/tasks'
import { bootCore, type Client, type TestCore } from './helpers/core'
import { seedTasks, taskFixture as f } from './helpers/tasks'

let core: TestCore, owner: Client, admin: Client, member: Client
beforeAll(async () => {
  core = await bootCore({ server: true })
  seedTasks(join(core.dataDir, 'tasks.sqlite')).close()
  owner = core.connect()
  await owner.call('setMyName', { name: 'Owner' })
  async function joinPerson(role: 'admin' | 'member'): Promise<Client> {
    const { code } = await owner.call<{ code: string }>('createInvite', { role })
    const result = await core.ask<{ data: { person: Person } }>({ type: 'join', code, name: role }, 'join-result')
    return core.connect(result.data.person.id)
  }
  admin = await joinPerson('admin')
  member = await joinPerson('member')
}, 30000)

it('keeps task identity out of snapshots and denies every task RPC to non-owners', async () => {
  const source = await owner.call<TaskSource>('tasksSource')
  expect(source).toEqual({ id: f.sourceId, workspaceId: f.workspaceId })
  const params = { sourceId: source.id, projectId: f.projectId, taskId: f.taskId, role: 'executor', agentId: null, title: 'Test', expectedVersion: 0, patch: { title: 'Test' }, body: 'Test' }
  for (const client of [member, admin]) {
    for (const method of ['tasksSource', 'tasksProjects', 'tasksProjectData', 'tasksTasks', 'tasksTask', 'tasksAssignAgent', 'tasksBoardData', 'tasksComments', 'tasksActivity', 'tasksStart', 'tasksCreate', 'tasksUpdate', 'tasksAddComment']) await expect(client.call(method, params)).rejects.toThrow()
  }
  for (const client of [owner, admin, member]) {
    const publicData = JSON.stringify({ snapshot: await client.call('snapshot'), events: client.events })
    expect(publicData).not.toContain(f.workspaceId)
    expect(publicData).not.toContain('read-only-test-token')
  }
})

it('creates, edits and comments through the real owner RPC and preserves project scope', async () => {
  const created = await owner.call<TaskDetail>('tasksCreate', { sourceId: f.sourceId, projectId: f.projectId, title: 'Native task' })
  expect(created.task.identifier).toBe('APP-2')
  const changed = await owner.call<TaskDetail>('tasksUpdate', { sourceId: f.sourceId, taskId: created.task.id, expectedVersion: created.task.version, patch: { title: 'Edited native task' } })
  expect(changed.task.title).toBe('Edited native task')
  await expect(owner.call('tasksUpdate', { sourceId: f.sourceId, taskId: created.task.id, expectedVersion: created.task.version, patch: { title: 'Stale edit' } })).rejects.toThrow()
  await owner.call('tasksAddComment', { sourceId: f.sourceId, taskId: created.task.id, body: 'Owner note' })
  expect(await owner.call('tasksComments', { sourceId: f.sourceId, taskId: created.task.id })).toMatchObject({ items: [{ body: 'Owner note' }] })
  await expect(owner.call('tasksTasks', { sourceId: f.sourceId, projectId: f.otherProjectId })).rejects.toThrow()
  await expect(owner.call('tasksTask', { sourceId: 'other-source', taskId: f.taskId })).rejects.toThrow()
})
