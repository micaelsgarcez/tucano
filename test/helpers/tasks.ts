import { createHash } from 'node:crypto'
import { TaskStore } from '../../src/tasks/store'

export const taskFixture = {
  sourceId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  taskId: '44444444-4444-4444-8444-444444444444',
  statusId: '55555555-5555-4555-8555-555555555555',
  otherProjectId: '66666666-6666-4666-8666-666666666666',
  ownerId: '77777777-7777-4777-8777-777777777777'
}
export function seedTasks(file: string): TaskStore {
  const f = taskFixture
  const store = new TaskStore(file)
  store.importSnapshot({
    source: { id: f.sourceId, workspaceId: f.workspaceId },
    owner: { id: f.ownerId, workspaceId: f.workspaceId, projectIds: [f.projectId], scopes: ['tasks:read', 'tasks:write'], serviceAccountId: null, owner: true },
    fingerprint: 'test-tasks-v1',
    tables: {
      workspaces: [{ id: f.workspaceId, name: 'Test' }],
      users: [{ id: f.ownerId, display_name: 'Owner' }],
      memberships: [{ id: 'member', user_id: f.ownerId, workspace_id: f.workspaceId, role: 'owner' }],
      projects: [
        { id: f.projectId, workspace_id: f.workspaceId, name: 'App', project_key: 'APP', color: '#123456', task_counter: 1 },
        { id: f.otherProjectId, workspace_id: f.workspaceId, name: 'Private', project_key: 'PRIVATE', color: '#654321', task_counter: 0 }
      ],
      task_statuses: [{ id: f.statusId, workspace_id: f.workspaceId, project_id: f.projectId, name: 'Todo', color: '#123456', category: 'unstarted', position: 0 }],
      tasks: [{ id: f.taskId, workspace_id: f.workspaceId, project_id: f.projectId, status_id: f.statusId, title: 'Existing task', description: 'Preserved task', priority: 'none', number: 1, creator_id: f.ownerId, created_at: 1794326400000, updated_at: 1794326400000, version: 0 }],
      api_tokens: [{ id: 'reader-token', workspace_id: f.workspaceId, created_by: f.ownerId, token_hash: createHash('sha256').update('read-only-test-token').digest('hex'), scopes: 'tasks:read', all_projects: 0 }],
      api_token_projects: [{ token_id: 'reader-token', project_id: f.projectId }]
    }
  })
  return store
}
