import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { State } from '../src/renderer/src/store'
import type { Agent, Person } from '../src/shared/types'
import type { TaskActivityPage, TaskBoardData, TaskExecution, TaskDetail } from '../src/shared/tasks'
import { taskIdFromHash } from '../src/shared/links'
import { setLang } from '../src/shared/lang'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
window.HTMLElement.prototype.focus = vi.fn()
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))
const { rpc, dm, navigate, openThread } = vi.hoisted(() => ({ rpc: vi.fn(), dm: vi.fn(async () => {}), navigate: vi.fn(), openThread: vi.fn() }))
vi.mock('../src/renderer/src/rpc', () => ({ call: rpc }))
let fake: State
vi.mock('../src/renderer/src/store', async original => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), openDm: dm, navigate, openThread }
})
const { getState } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { TasksPage } = await import('../src/renderer/src/components/Tasks')
const owner: Person = { id: 'owner', name: 'Owner', role: 'owner', about: '' }
const agent = (id: string, name: string, archived = false): Agent => ({ id, name, archived, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: {}, memory: 'auto', computer: false })
const source = { id: 'source', workspaceId: 'workspace' }
const data: TaskBoardData = {
  projects: [{ id: 'project', name: 'Application', key: 'APP', color: '#7654ff' }, { id: 'other', name: 'Website', key: 'WEB', color: '#3675ff' }],
  statuses: [{ id: 'todo', projectId: 'project', name: 'To do', color: '#999999', category: 'unstarted', position: 1 }, { id: 'other-todo', projectId: 'other', name: 'to do', color: '#999999', category: 'unstarted', position: 1 }, { id: 'done', projectId: 'project', name: 'Done', color: '#00bb88', category: 'completed', position: 2 }],
  labels: [{ id: 'label', projectId: 'project', name: 'API', color: '#5678ee' }], members: [{ id: 'human', name: 'Alex Human' }]
}
const detail: TaskDetail = { task: { relations: [], version: 1, sourceUrl: null, parentTaskId: null, id: 'task', projectId: 'project', statusId: 'todo', identifier: 'APP-1', title: 'Review endpoint', description: '**Private description**', assigneeIds: ['human'], labelIds: ['label'], priority: 'high', dueAt: '2024-01-01T12:00:00Z', createdAt: '2024-01-01T10:00:00Z', updatedAt: '2024-01-01T11:00:00Z' }, assignments: { executor: null, reviewer: 'archived' } }
const execution: TaskExecution = { id: 'execution', sourceId: source.id, workspaceId: source.workspaceId, taskId: 'task', requestId: 'request', requesterId: owner.id, role: 'executor', agentId: 'executor', agentName: 'Aster', conversationId: 'private-dm', rootMessageId: 'task-root', createdAt: Date.parse('2024-01-01T12:00:00Z'), state: 'started' }
let history: TaskActivityPage
let root: Root
beforeEach(() => {
  setLang('en')
  history = { items: [], executions: [], nextCursor: null, headCursor: null }
  fake = { ...getState(), people: [owner], you: owner.id, agents: [agent('executor', 'Aster'), agent('archived', 'Retired agent', true)] }
  rpc.mockImplementation(async (method: string, params?: { cursor?: string; agentId?: string | null }) => {
    switch (method) {
      case 'tasksSource': return source
      case 'tasksBoardData': return data
      case 'tasksTasks': return params?.cursor ? { items: [{ ...detail, task: { ...detail.task, id: 'next', identifier: 'APP-2', title: 'Second task', statusId: 'done' } }], nextCursor: null } : { items: [detail, { ...detail, task: { ...detail.task, id: 'website', projectId: 'other', statusId: 'other-todo', identifier: 'WEB-1', title: 'Review website' } }], nextCursor: 'page-two' }
      case 'tasksTask': return detail
      case 'tasksComments': return { items: [{ id: 'comment', taskId: 'task', authorId: 'human', serviceAccount: { id: 'service', name: 'Build service' }, body: '**Build received**', parentId: null, createdAt: '2024-01-01T13:00:00Z', updatedAt: '2024-01-01T13:00:00Z' }], nextCursor: null }
      case 'tasksActivity': return history
      case 'tasksAssignAgent': return { ...detail, assignments: { ...detail.assignments, executor: params?.agentId ?? null } }
      case 'tasksStart': return execution
      default: throw new Error(`Unexpected call: ${method}`)
    }
  })
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
  vi.useRealTimers()
  setLang('pt')
})
async function click(text: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(button => button.textContent?.includes(text))
  if (!button) throw new Error(`Button not found: ${text}`)
  await act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })) })
}
async function choose(label: string, value: string): Promise<void> {
  const select = document.querySelector(`select[aria-label="${label}"]`)
  if (!select) throw new Error(`Missing selector ${label}`)
  Object.defineProperty(select, 'value', { configurable: true, value })
  await act(async () => { select.dispatchEvent(new window.Event('change', { bubbles: true })) })
}

it('groups configured statuses across projects and shows card metadata with honest paging', async () => {
  await act(async () => root.render(<TasksPage />))
  expect(rpc).toHaveBeenCalledWith('tasksTasks', { sourceId: 'source', projectId: null })
  expect(document.querySelectorAll('.tasks-column')).toHaveLength(2)
  expect(document.querySelector('.tasks-column')?.querySelectorAll('.tasks-task')).toHaveLength(2)
  expect(document.body.textContent).toContain('partial counts')
  expect(document.querySelector('.tasks-task')?.textContent).toContain('Application')
  expect(document.querySelector('.tasks-task')?.textContent).toContain('API')
  expect(document.querySelector('.tasks-task [aria-label="High"]')).not.toBeNull()
  expect(document.querySelector('.tasks-task [aria-label="Alex Human"]')).not.toBeNull()
  expect(document.querySelector('.tasks-task .is-overdue')).not.toBeNull()
  await click('Load more tasks')
  expect(document.body.textContent).toContain('Second task')
  expect(document.body.textContent).not.toContain('partial counts')
  expect(document.querySelector('.tasks-column[aria-label="Done"] .is-overdue')).toBeNull()
  expect(rpc).toHaveBeenCalledWith('tasksTasks', { sourceId: 'source', projectId: null, cursor: 'page-two' })
  await choose('Project', 'other')
  expect(rpc).toHaveBeenCalledWith('tasksTasks', { sourceId: 'source', projectId: 'other' })
})

it('opens a full detail with Markdown, properties, service comments and archived responsibility', async () => {
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint')
  expect(document.querySelector('.tasks-detail-main h2')?.textContent).toBe('Review endpoint')
  expect(document.querySelector('.tasks-properties')?.textContent).toContain('Alex Human')
  expect(document.querySelector('.md strong')?.textContent).toBe('Private description')
  expect(document.body.textContent).toContain('No execution is linked to this task')
  expect(document.querySelector('option[value="archived"]')?.hasAttribute('disabled')).toBe(true)
  expect(document.body.textContent).toContain('Build service')
  expect(document.body.textContent).toContain('Comment · service account')
  expect(document.querySelector('.tasks-timeline .md strong')?.textContent).toBe('Build received')
  await click('Back to board')
  expect(document.querySelector('.tasks-board')).not.toBeNull()
})

it('assigns without starting work and starts explicitly with a stable retry request', async () => {
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint')
  await choose('Executor', 'executor')
  expect(rpc).toHaveBeenCalledWith('tasksAssignAgent', { sourceId: 'source', taskId: 'task', role: 'executor', agentId: 'executor' })
  expect(rpc.mock.calls.some(call => call[0] === 'tasksStart')).toBe(false)
  await click('Open conversation')
  expect(dm).toHaveBeenCalledWith('executor')
  rpc.mockRejectedValueOnce(new Error('Connection interrupted'))
  await click('Start execution')
  const first = rpc.mock.calls.filter(call => call[0] === 'tasksStart')[0]?.[1]
  expect(document.body.textContent).toContain('Connection interrupted')
  await click('Start execution')
  const second = rpc.mock.calls.filter(call => call[0] === 'tasksStart')[1]?.[1]
  expect(second).toEqual(first)
  expect(second).toMatchObject({ sourceId: 'source', taskId: 'task', role: 'executor' })
  await click('Open thread')
  expect(navigate).toHaveBeenCalledWith({ kind: 'conversation', id: 'private-dm' })
  expect(openThread).toHaveBeenCalledWith('task-root')
  expect(rpc.mock.calls.some(call => call[0] === 'sendMessage')).toBe(false)
})

it('keeps observed execution separate from standardized agent claims and links real evidence', async () => {
  const evidence = { conversationId: 'private-dm', rootMessageId: 'task-root', messageId: 'reply', stepIds: ['step'] }
  const base = { executionId: 'execution', at: Date.parse('2024-01-01T12:00:00Z'), agentId: 'executor', agentName: 'Aster', role: 'executor' as const, evidence, attemptId: 'attempt' }
  history = { executions: [execution], nextCursor: null, headCursor: '2', items: [{ ...base, id: 'observed', kind: 'attempt', status: 'waiting_approval', steps: [{ id: 'step', status: 'done' }] }, { ...base, id: 'report', kind: 'report', action: 'Checked endpoint', result: 'Change proposed', nextStep: 'Await approval' }] }
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint')
  expect(document.body.textContent).toContain('Observed execution')
  expect(document.body.textContent).toContain('Waiting for approval')
  expect(document.body.textContent).toContain('Agent report')
  expect([...document.querySelectorAll('.tasks-report dt')].map(node => node.textContent)).toEqual(['Action', 'Result', 'Evidence', 'Next step'])
  expect(document.querySelector('.tasks-report')?.textContent).toContain('Checked endpoint')
  await click('View execution')
  expect(openThread).toHaveBeenCalledWith('task-root')
})

it('keeps equal names in different status categories in separate columns', async () => {
  const original = rpc.getMockImplementation()!
  rpc.mockImplementation((method, params) => method === 'tasksBoardData' ? Promise.resolve({ ...data, statuses: [...data.statuses, { id: 'other-done', projectId: 'other', name: 'To do', color: '#00bb88', category: 'completed', position: 3 }] }) : original(method, params))
  await act(async () => root.render(<TasksPage />))
  expect(document.querySelectorAll('.tasks-column')).toHaveLength(3)
})

it('does not request private Task data for an admin', async () => {
  fake = { ...fake, view: { kind: 'tasks', taskId: 'private-task' }, people: [{ ...owner, role: 'admin' }] }
  await act(async () => root.render(<TasksPage />))
  expect(document.body.textContent).toContain('only to the Tucano owner')
  expect(rpc).not.toHaveBeenCalled()
})

it('removes detail and history after revoked assignment access', async () => {
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint')
  rpc.mockRejectedValueOnce(new Error('Access revoked'))
  await choose('Executor', 'executor')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Access revoked')
  expect(document.querySelector('.tasks-detail-main')).toBeNull()
  expect(document.querySelector('.tasks-timeline')).toBeNull()
})

it('clears history on failed authorization refresh and stops polling after leaving the card', async () => {
  vi.useFakeTimers()
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint')
  rpc.mockRejectedValueOnce(new Error('Source revoked'))
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Source revoked')
  expect(document.querySelector('.tasks-detail-main')).toBeNull()
  await click('Back to board')
  const calls = rpc.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  expect(rpc.mock.calls).toHaveLength(calls)
})

it('paginates comments without replacing earlier activity or losing service authors', async () => {
  const original = rpc.getMockImplementation()!
  rpc.mockImplementation((method, params) => {
    if (method !== 'tasksComments') return original(method, params)
    return Promise.resolve(params?.cursor ? { items: [{ id: 'reply', taskId: 'task', authorId: 'human', serviceAccount: null, body: 'Reviewed the build.', parentId: 'comment', createdAt: '2024-01-01T14:00:00Z', updatedAt: '2024-01-01T14:00:00Z' }], nextCursor: null } : { items: [{ id: 'comment', taskId: 'task', authorId: 'human', serviceAccount: { id: 'service', name: 'Build service' }, body: 'Build received', parentId: null, createdAt: '2024-01-01T13:00:00Z', updatedAt: '2024-01-01T13:00:00Z' }], nextCursor: 'more-comments' })
  })
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint')
  await click('Load more comments')
  expect(rpc).toHaveBeenCalledWith('tasksComments', { sourceId: 'source', taskId: 'task', cursor: 'more-comments' })
  expect(document.querySelectorAll('.is-comment')).toHaveLength(2)
  expect(document.body.textContent).toContain('Reply to a comment')
  expect(document.body.textContent).toContain('Build service')
  expect(document.body.textContent).toContain('Alex Human')
})

it('ignores a late task response after returning to the board', async () => {
  const original = rpc.getMockImplementation()!
  let resolveTask: ((value: TaskDetail) => void) | undefined
  rpc.mockImplementation((method, params) => method === 'tasksTask' ? new Promise<TaskDetail>(resolve => { resolveTask = resolve }) : original(method, params))
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint')
  expect(document.body.textContent).toContain('Loading task')
  await click('Back to board')
  await act(async () => { resolveTask?.(detail) })
  expect(document.querySelector('.tasks-detail-page')).toBeNull()
  expect(document.querySelector('.tasks-board')).not.toBeNull()
})

it('does not resurrect exhausted activity pagination when the newest page refreshes', async () => {
  vi.useFakeTimers()
  const original = rpc.getMockImplementation()!
  const entries = Array.from({ length: 26 }, (_, index) => ({ id: `report-${index}`, executionId: 'execution', at: index + 1000, agentId: 'executor', agentName: 'Aster', role: 'executor' as const, evidence: { conversationId: 'private-dm', rootMessageId: 'task-root', messageId: 'reply', stepIds: [] }, attemptId: 'attempt', kind: 'report' as const, action: `Action ${index}`, result: 'Recorded', nextStep: 'Continue' }))
  rpc.mockImplementation((method, params) => method === 'tasksActivity' ? Promise.resolve({ executions: [execution], items: params?.cursor ? entries.slice(0, 1) : entries.slice(1).reverse(), nextCursor: params?.cursor ? null : '2', headCursor: '26' }) : original(method, params))
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint')
  await click('Load earlier activity')
  expect(document.querySelectorAll('.is-report')).toHaveLength(26)
  expect(document.body.textContent).not.toContain('Load earlier activity')
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(document.querySelectorAll('.is-report')).toHaveLength(26)
  expect(document.body.textContent).not.toContain('Load earlier activity')
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

it('opens a paging gap when more than one page of new activity arrives between refreshes', async () => {
  vi.useFakeTimers()
  const original = rpc.getMockImplementation()!
  let total = 26
  rpc.mockImplementation((method, params) => {
    if (method !== 'tasksActivity') return original(method, params)
    const entries = Array.from({ length: total }, (_, index) => ({ id: `report-${index + 1}`, executionId: 'execution', at: index + 1000, agentId: 'executor', agentName: 'Aster', role: 'executor' as const, evidence: { conversationId: 'private-dm', rootMessageId: 'task-root', messageId: 'reply', stepIds: [] }, attemptId: 'attempt', kind: 'report' as const, action: `Action ${index + 1}`, result: 'Recorded', nextStep: 'Continue' })).filter((_, index) => index + 1 < Number(params?.cursor ?? Number.MAX_SAFE_INTEGER)).reverse()
    return Promise.resolve({ executions: [execution], items: entries.slice(0, 25), nextCursor: entries.length > 25 ? entries[24]?.id.replace('report-', '') ?? null : null, headCursor: String(total) })
  })
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint')
  await click('Load earlier activity')
  expect(document.querySelectorAll('.is-report')).toHaveLength(26)
  total = 57
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(document.body.textContent).toContain('Load earlier activity')
  await click('Load earlier activity')
  await click('Load earlier activity')
  expect(document.querySelectorAll('.is-report')).toHaveLength(57)
  expect(document.body.textContent).toContain('Action 27')
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(document.body.textContent).not.toContain('Load earlier activity')
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

async function type(label: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
  if (!input) throw new Error(`Missing input ${label}`)
  await act(async () => {
    input.value = value
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function submit(label: string): Promise<void> {
  const form = document.querySelector(`form[aria-label="${label}"]`)
  if (!form) throw new Error(`Missing form ${label}`)
  await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) })
}

it('shows local setup instead of requesting remote credentials', async () => {
  rpc.mockResolvedValueOnce(null)
  await act(async () => root.render(<TasksPage />))
  expect(document.body.textContent).toContain('Set up the task workspace')
  expect(document.querySelector('input[type="password"]')).toBeNull()
  expect(rpc).toHaveBeenCalledTimes(1)
})

it('creates a local task and opens it without assigning or starting an agent', async () => {
  const original = rpc.getMockImplementation()!
  const created = { ...detail, task: { ...detail.task, id: 'created', title: 'New local task' } }
  rpc.mockImplementation((method, params) => method === 'tasksCreate' || method === 'tasksTask' ? Promise.resolve(created) : original(method, params))
  await act(async () => root.render(<TasksPage />))
  await click('New task')
  await type('Title', 'New local task')
  await type('Description', 'Acceptance criteria')
  await submit('New task')
  expect(rpc).toHaveBeenCalledWith('tasksCreate', expect.objectContaining({ sourceId: source.id, projectId: 'project', title: 'New local task', description: 'Acceptance criteria' }))
  expect(document.querySelector('.tasks-detail-main h2')?.textContent).toBe('New local task')
  expect(rpc.mock.calls.some(([method]) => method === 'tasksAssignAgent' || method === 'tasksStart')).toBe(false)
})

it('keeps edits on optimistic conflict and saves the selected status with the expected version', async () => {
  const original = rpc.getMockImplementation()!
  rpc.mockImplementation((method, params) => method === 'tasksUpdate' ? Promise.reject(new Error('409: Task changed')) : original(method, params))
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint'); await click('Edit task')
  await type('Title', 'Keep this draft'); await choose('Status', 'done')
  await submit('Edit task')
  expect(rpc).toHaveBeenCalledWith('tasksUpdate', expect.objectContaining({ taskId: 'task', expectedVersion: 1, patch: expect.objectContaining({ title: 'Keep this draft', statusId: 'done' }) }))
  expect(document.querySelector<HTMLInputElement>('[aria-label="Title"]')?.value).toBe('Keep this draft')
  expect(document.body.textContent).toContain('Your input was kept')
  expect(document.querySelector('.tasks-detail-main')).not.toBeNull()
})

it('keeps GitHub content readonly while allowing local priority updates', async () => {
  const original = rpc.getMockImplementation()!
  const linked = { ...detail, task: { ...detail.task, sourceUrl: 'https://github.com/example/repo/issues/1' } }
  rpc.mockImplementation((method, params) => method === 'tasksTask' || method === 'tasksUpdate' ? Promise.resolve(linked) : original(method, params))
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint'); await click('Edit task')
  for (const label of ['Title', 'Description', 'Status']) expect(document.querySelector(`[aria-label="${label}"]`)?.hasAttribute('disabled')).toBe(true)
  expect(document.querySelector('a[href="https://github.com/example/repo/issues/1"]')).not.toBeNull()
  await choose('Priority', 'low'); await submit('Edit task')
  const update = rpc.mock.calls.find(([method]) => method === 'tasksUpdate')?.[1]
  expect(update.patch.priority).toBe('low')
  expect(update.patch).not.toHaveProperty('title')
  expect(update.patch).not.toHaveProperty('description')
  expect(update.patch).not.toHaveProperty('statusId')
})

it('preserves a failed comment draft and appends it after a successful retry', async () => {
  const original = rpc.getMockImplementation()!
  let reject = true
  rpc.mockImplementation((method, params) => method === 'tasksAddComment' ? reject ? Promise.reject(new Error('Temporary failure')) : Promise.resolve({ id: 'new-comment', taskId: 'task', authorId: 'human', body: params.body, serviceAccount: null, parentId: null, createdAt: '2024-01-01T14:00:00Z', updatedAt: '2024-01-01T14:00:00Z' }) : original(method, params))
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint'); await type('Comment', 'A local comment'); await submit('Add comment')
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value).toBe('A local comment')
  expect(document.body.textContent).toContain('Temporary failure')
  reject = false
  await submit('Add comment')
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value).toBe('')
  expect(document.querySelector('.tasks-timeline')?.textContent).toContain('A local comment')
})


it('shows preserved dependencies and parenthood with direction', async () => {
  const original = rpc.getMockImplementation()!
  rpc.mockImplementation((method, params) => method === 'tasksTask' ? Promise.resolve({ ...detail, task: { ...detail.task, parentTaskId: 'parent-task', relations: [{ type: 'blocks', direction: 'outgoing', taskId: 'a', identifier: 'APP-2' }, { type: 'blocks', direction: 'incoming', taskId: 'b', identifier: 'APP-3' }, { type: 'related', direction: 'outgoing', taskId: 'c', identifier: 'APP-4' }] } }) : original(method, params))
  await act(async () => root.render(<TasksPage />))
  await click('Review endpoint')
  expect([...document.querySelectorAll('.tasks-relations li')].map(node => node.textContent)).toEqual(['Blocks APP-2', 'Blocked by APP-3', 'Related to APP-4'])
  expect(document.querySelector('.tasks-properties')?.textContent).toContain('parent-task')
})

it('opens a linked task directly even when absent from the first board page', async () => {
  const taskId = taskIdFromHash('#tasks/off-page-task')!
  fake = { ...fake, view: { kind: 'tasks', taskId } }
  const original = rpc.getMockImplementation()!
  rpc.mockImplementation((method, params) => method === 'tasksTask'
    ? Promise.resolve({ ...detail, task: { ...detail.task, id: taskId, title: 'Linked task outside first page' } })
    : original(method, params))
  await act(async () => root.render(<TasksPage />))
  expect(rpc).toHaveBeenCalledWith('tasksTask', { sourceId: source.id, taskId })
  expect(document.querySelector('.tasks-detail-main h2')?.textContent).toBe('Linked task outside first page')
  await click('Back to board')
  expect(document.querySelector('.tasks-board')).not.toBeNull()
  expect(navigate).toHaveBeenCalledWith({ kind: 'tasks' })
})
