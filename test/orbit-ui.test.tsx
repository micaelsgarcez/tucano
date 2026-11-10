import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { State } from '../src/renderer/src/store'
import type { Agent, Person } from '../src/shared/types'
import { setLang } from '../src/shared/lang'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))
const { rpc, dm } = vi.hoisted(() => ({ rpc: vi.fn(), dm: vi.fn(async () => {}) }))
vi.mock('../src/renderer/src/rpc', () => ({ call: rpc }))
let fake: State
vi.mock('../src/renderer/src/store', async original => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), openDm: dm }
})
const { getState } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { OrbitPage } = await import('../src/renderer/src/components/Orbit')
const owner: Person = { id: 'owner', name: 'Owner', role: 'owner', about: '' }
const agent = (id: string, name: string, archived = false): Agent => ({ id, name, archived, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: {}, memory: 'auto', computer: false })
const source = { id: 'source', baseUrl: 'https://orbit.example.com', workspaceId: 'workspace' }
const detail = { task: { id: 'task', projectId: 'project', statusId: 'todo', identifier: 'APP-1', title: 'Review endpoint', description: '**Private description**', assigneeIds: ['human'] }, assignments: { executor: null, reviewer: 'archived' } }
let root: Root
beforeEach(() => {
  setLang('en')
  fake = { ...getState(), people: [owner], you: owner.id, agents: [agent('executor', 'Aster'), agent('archived', 'Retired agent', true)] }
  rpc.mockImplementation(async (method: string, params?: { cursor?: string; agentId?: string | null }) => {
    switch (method) {
      case 'orbitSource': return source
      case 'orbitProjects': return [{ id: 'project', name: 'Application', key: 'APP' }]
      case 'orbitProjectData': return { statuses: [{ id: 'todo', projectId: 'project', name: 'To do' }], members: [{ id: 'human', name: 'Alex Human' }] }
      case 'orbitTasks': return params?.cursor ? { items: [{ ...detail, task: { ...detail.task, id: 'next', identifier: 'APP-2', title: 'Second task' } }], nextCursor: null } : { items: [detail], nextCursor: 'page-two' }
      case 'orbitTask': return detail
      case 'orbitAssignAgent': return { ...detail, assignments: { ...detail.assignments, executor: params?.agentId ?? null } }
      default: throw new Error(`Unexpected call: ${method}`)
    }
  })
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
  setLang('pt')
})
async function click(text: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(button => button.textContent?.includes(text))
  if (!button) throw new Error(`Button not found: ${text}`)
  await act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })) })
}

it('shows live tasks, Markdown, human assignees and archived agent responsibility separately', async () => {
  await act(async () => root.render(<OrbitPage />))
  expect(document.body.textContent).toContain('Review endpoint')
  await click('Review endpoint')
  expect(document.body.textContent).toContain('Human assignees in Orbit: Alex Human')
  expect(document.querySelector('.md strong')?.textContent).toBe('Private description')
  expect(document.body.textContent).toContain('No execution is linked to this task')
  expect(document.querySelector('option[value="archived"]')?.hasAttribute('disabled')).toBe(true)
  await click('Load more')
  expect(document.body.textContent).toContain('Second task')
  expect(rpc).toHaveBeenCalledWith('orbitTasks', { sourceId: 'source', projectId: 'project', cursor: 'page-two' })
})

it('assigns the chosen Agent.id and opens its conversation without sending a message', async () => {
  await act(async () => root.render(<OrbitPage />))
  await click('Review endpoint')
  const select = document.querySelector('select[aria-label="Executor"]')
  if (!select) throw new Error('Missing executor selector')
  Object.defineProperty(select, 'value', { configurable: true, value: 'executor' })
  await act(async () => { select.dispatchEvent(new window.Event('change', { bubbles: true })) })
  expect(rpc).toHaveBeenCalledWith('orbitAssignAgent', { sourceId: 'source', taskId: 'task', role: 'executor', agentId: 'executor' })
  expect(document.querySelector('.orbit-task')?.textContent).toContain('Executor: Aster')
  await click('Open conversation')
  expect(dm).toHaveBeenCalledWith('executor')
  expect(rpc.mock.calls.some(call => call[0] === 'sendMessage')).toBe(false)
})

it('does not request private Orbit data for an admin', async () => {
  fake = { ...fake, people: [{ ...owner, role: 'admin' }] }
  await act(async () => root.render(<OrbitPage />))
  expect(document.body.textContent).toContain('only to the Tucano owner')
  expect(rpc).not.toHaveBeenCalled()
})

it('shows a revoked access error and removes the open task instead of presenting a successful assignment', async () => {
  await act(async () => root.render(<OrbitPage />))
  await click('Review endpoint')
  rpc.mockRejectedValueOnce(new Error('Access revoked'))
  const select = document.querySelector('select[aria-label="Executor"]')
  if (!select) throw new Error('Missing executor selector')
  Object.defineProperty(select, 'value', { configurable: true, value: 'executor' })
  await act(async () => { select.dispatchEvent(new window.Event('change', { bubbles: true })) })
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Access revoked')
  expect(document.querySelector('.md')).toBeNull()
})
