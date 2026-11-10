import { beforeAll, expect, it } from 'vitest'
import type { Person } from '../src/shared/types'
import type { OrbitSource } from '../src/shared/orbit'
import { bootCore, type Client, type TestCore } from './helpers/core'

let core: TestCore, owner: Client, admin: Client, member: Client
beforeAll(async () => {
  core = await bootCore({ server: true })
  owner = core.connect()
  await owner.call('setMyName', { name: 'Owner' })
  async function join(role: 'admin' | 'member'): Promise<Client> {
    const { code } = await owner.call<{ code: string }>('createInvite', { role })
    const result = await core.ask<{ data: { person: Person } }>({ type: 'join', code, name: role }, 'join-result')
    return core.connect(result.data.person.id)
  }
  admin = await join('admin')
  member = await join('member')
}, 30000)

it('keeps the owner source out of snapshots and broadcasts, and denies non-owner RPCs at dispatch', async () => {
  const source = await owner.call<OrbitSource>('orbitSaveSource', { baseUrl: 'https://orbit.example.com', workspaceId: '11111111-1111-4111-8111-111111111111', token: 'private-fixture-orbit-token' })
  expect(await owner.call('orbitSource')).toEqual(source)
  const params = { sourceId: source.id, projectId: '22222222-2222-4222-8222-222222222222', taskId: '33333333-3333-4333-8333-333333333333', role: 'executor', agentId: null, baseUrl: 'https://orbit.example.com', workspaceId: source.workspaceId, token: 'another-token' }
  for (const client of [member, admin]) {
    for (const method of ['orbitSource', 'orbitSaveSource', 'orbitProjects', 'orbitProjectData', 'orbitTasks', 'orbitTask', 'orbitAssignAgent']) await expect(client.call(method, params)).rejects.toThrow()
  }
  for (const client of [owner, admin, member]) {
    const publicData = JSON.stringify({ snapshot: await client.call('snapshot'), events: client.events })
    expect(publicData).not.toMatch(/private-fixture-orbit-token|orbit\.example\.com|11111111-1111-4111-8111-111111111111/)
  }
  expect(await owner.call('orbitSource')).toEqual(source)
})
