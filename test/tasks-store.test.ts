import { afterEach, expect, it } from 'vitest'
import { TaskStore, type TaskSnapshot } from '../src/tasks/store'
import { createHash } from 'node:crypto'
const opened: TaskStore[] = []
afterEach(() => opened.splice(0).forEach((s) => s.close()))
function fixture(change?: (snapshot: TaskSnapshot) => void): TaskStore {
  const store = new TaskStore(':memory:')
  opened.push(store)
  const snapshot: TaskSnapshot = {
    source: { id: 'source', workspaceId: 'w' },
    owner: {
      id: 'u',
      workspaceId: 'w',
      projectIds: ['p'],
      scopes: ['tasks:write'],
      serviceAccountId: null,
      owner: true,
    },
    fingerprint: 'fixture',
    tables: {
      users: [{ id: 'u', display_name: 'Owner' }],
      memberships: [{ id: 'm', workspace_id: 'w', user_id: 'u' }],
      projects: [
        { id: 'p', workspace_id: 'w', name: 'P', project_key: 'P', color: 'red', task_counter: 12 },
        { id: 'q', workspace_id: 'w', name: 'Q', project_key: 'Q', color: 'blue', task_counter: 1 },
      ],
      task_statuses: [
        {
          id: 's',
          project_id: 'p',
          name: 'Todo',
          category: 'unstarted',
          color: 'red',
          position: 0,
        },
        {
          id: 'qs',
          project_id: 'q',
          name: 'Todo',
          category: 'unstarted',
          color: 'blue',
          position: 0,
        },
      ],
      labels: [{ id: 'label', project_id: 'p', name: 'Label', color: 'red' }],
      tasks: [
        {
          id: 'a',
          workspace_id: 'w',
          project_id: 'p',
          status_id: 's',
          number: 1,
          title: 'First',
          description: 'Text',
          priority: 'none',
          version: 0,
          created_at: 1,
          updated_at: 1,
          parent_task_id: 'secret',
        },
        {
          id: 'b',
          workspace_id: 'w',
          project_id: 'p',
          status_id: 's',
          number: 2,
          title: 'Second',
          description: '',
          priority: 'none',
          version: 0,
          created_at: 2,
          updated_at: 2,
        },
        {
          id: 'secret',
          workspace_id: 'w',
          project_id: 'q',
          status_id: 'qs',
          number: 1,
          title: 'Secret',
          description: '',
          priority: 'none',
          version: 0,
          created_at: 1,
          updated_at: 1,
        },
      ],
      task_relations: [
        { id: 'r1', task_id: 'a', related_task_id: 'secret', type: 'related' },
        { id: 'r2', task_id: 'a', related_task_id: 'b', type: 'blocks' },
      ],
      api_tokens: [
        {
          id: 'read',
          token_hash: createHash('sha256').update('read').digest('hex'),
          created_by: 'u',
          workspace_id: 'w',
          scopes: 'tasks:read',
        },
      ],
      api_token_projects: [{ token_id: 'read', project_id: 'p' }],
    },
  }
  change?.(snapshot)
  store.importSnapshot(snapshot)
  return store
}
it('keeps counters, rejects stale versions and validates project-owned references', () => {
  const s = fixture(),
    who = s.ownerPrincipal()
  const task = s.create(who, {
    projectId: 'p',
    title: 'New',
    assigneeIds: ['u'],
    labelIds: ['label'],
  })
  expect(task.identifier).toBe('P-13')
  expect(task.assigneeIds).toEqual(['u'])
  expect(s.update(who, task.id, 0, { title: 'Updated' }).version).toBe(1)
  expect(() => s.update(who, task.id, 0, { title: 'Lost' })).toThrow('Task changed')
  expect(() => s.update(who, task.id, 1, { statusId: 'qs' })).toThrow('Invalid status')
  expect(() => s.create(who, { projectId: 'p', title: 'bad', labelIds: ['foreign'] })).toThrow(
    'Invalid labels',
  )
  expect(s.create(who, { projectId: 'p', title: 'Next' }).identifier).toBe('P-14')
})
it('filters relationship and parent identifiers and rejects forged cursors', () => {
  const s = fixture(),
    who = s.ownerPrincipal(),
    a = s.get(who, 'P-1')
  expect(a.parentTaskId).toBeNull()
  expect(a.relations).toEqual([
    { type: 'blocks', taskId: 'b', identifier: 'P-2', direction: 'outgoing' },
  ])
  const first = s.list(who, { limit: 1 })
  expect(first.items[0]?.id).toBe('b')
  expect(s.list(who, { cursor: first.nextCursor!, limit: 1 }).items[0]?.id).toBe('a')
  expect(() => s.list(who, { cursor: 'secret' })).toThrow('Invalid cursor')
  expect(() => s.get(who, 'secret')).toThrow('Task not found')
})
it('enforces read-only tokens, parent cycles, and comment authorship', () => {
  const s = fixture(),
    owner = s.ownerPrincipal(),
    read = s.authenticate('read')
  expect(() => s.create(read, { projectId: 'p', title: 'No' })).toThrow('Scope denied')
  s.update(owner, 'b', 0, { parentTaskId: 'a' })
  expect(() => s.update(owner, 'a', 0, { parentTaskId: 'b' })).toThrow('Parent cycle')
  expect(() => s.addComment(owner, { taskId: 'a', body: 'Hi', authorId: 'other' })).toThrow(
    'Author denied',
  )
  const c = s.addComment(owner, { taskId: 'a', body: 'Hi' })
  expect(s.comments(owner, 'a').items).toEqual([c])
})
it('issues hashed scoped credentials and revokes already-authenticated principals', () => {
  const s = fixture(),
    owner = s.ownerPrincipal()
  const issued = s.issueToken(owner, { name: 'Reader', projectIds: ['p'], scopes: ['tasks:read'] })
  const principal = s.authenticate(issued.token)
  expect(s.list(principal).items).toHaveLength(2)
  expect(() =>
    s.issueToken(principal, { name: 'No', projectIds: ['p'], scopes: ['tasks:write'] }),
  ).toThrow('Scope denied')
  expect(() =>
    s.issueToken(owner, { name: 'No', projectIds: ['q'], scopes: ['tasks:read'] }),
  ).toThrow('Project denied')
  const page = s.list(owner, { limit: 1 })
  expect(() => s.list(principal, { limit: 1, cursor: page.nextCursor! })).toThrow('Invalid cursor')
  s.revokeToken(owner, issued.id)
  expect(() => s.list(principal)).toThrow('Invalid token')
  expect(() => s.authenticate(issued.token)).toThrow('Invalid token')
})

it('requires canonical parent IDs and rejects self-parent cycles', () => {
  const store = fixture()
  const who = store.ownerPrincipal()
  expect(() => store.create(who, { projectId: 'p', title: 'Child', parentTaskId: 'P-2' })).toThrow('Invalid parent')
  expect(() => store.update(who, 'a', 0, { parentTaskId: 'P-1' })).toThrow('Invalid parent')
  expect(() => store.update(who, 'a', 0, { parentTaskId: 'a' })).toThrow('Parent cycle')
  const child = store.create(who, { projectId: 'p', title: 'Child', parentTaskId: 'b' })
  expect(child.parentTaskId).toBe('b')
})

it('requires personal-token membership while service accounts survive creator departure', () => {
  const personal = fixture(snapshot => { snapshot.tables.memberships = [] })
  expect(() => personal.authenticate('read')).toThrow('Inactive token owner')
  const service = fixture(snapshot => {
    snapshot.tables.users!.push({ id: 'former', display_name: 'Former', suspended_at: 1 })
    snapshot.tables.memberships![0]!.role = 'owner'
    snapshot.tables.service_accounts = [{ id: 'service', workspace_id: 'w', name: 'Reader', created_by: 'former', disabled_at: null }]
    snapshot.tables.api_tokens![0]!.created_by = 'former'
    snapshot.tables.api_tokens![0]!.service_account_id = 'service'
  })
  expect(service.authenticate('read')).toMatchObject({ id: 'u', serviceAccountId: 'service', projectIds: ['p'] })
})
