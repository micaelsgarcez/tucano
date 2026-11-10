import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { TaskStore } from '../src/tasks/store'
import { createTasksHandler } from '../src/tasks/http'
let store: TaskStore, server: Server, dir: string, origin: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tasks-http-')); store = new TaskStore(join(dir, 'tasks.sqlite'))
  store.importSnapshot({ fingerprint: 'test', source: { id: 'source', workspaceId: 'w' }, owner: { id: 'u', workspaceId: 'w', projectIds: ['p'], scopes: ['tasks:write'], serviceAccountId: null, owner: true }, tables: {
    users: [{ id: 'u', display_name: 'User' }], memberships: [{ id: 'm', user_id: 'u', workspace_id: 'w' }],
    projects: ['p', 'secret'].map(id => ({ id, workspace_id: 'w', project_key: id.toUpperCase(), name: id, color: '#fff', task_counter: 2 })),
    task_statuses: [{ id: 's', project_id: 'p', name: 'Todo', category: 'unstarted', color: '#fff', position: 0 }],
    tasks: ['p', 'secret'].map((project_id, index) => ({ id: `task${index}`, project_id, workspace_id: 'w', status_id: 's', title: 'Original', description: 'Details', priority: 'none', number: 1, version: 0, created_at: 1000, updated_at: 1000 })),
    api_tokens: ['read', 'write', 'revoked', 'expired'].map(token => ({ id: token, workspace_id: 'w', created_by: 'u', token_hash: createHash('sha256').update(token).digest('hex'), scopes: token === 'write' ? 'tasks:write' : 'tasks:read', revoked_at: token === 'revoked' ? 1 : null, expires_at: token === 'expired' ? 1 : null })),
    api_token_projects: ['read', 'write', 'revoked', 'expired'].map(token_id => ({ token_id, project_id: 'p' }))
  } })
  const handler = createTasksHandler(store)
  server = createServer((req,res) => { if (!handler(req,res)) { res.statusCode=404;res.end() } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address(); if (!addr || typeof addr === 'string') throw Error('No address')
  origin = `http://127.0.0.1:${addr.port}`
})
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve()));store.close();rmSync(dir,{recursive:true,force:true}) })
const request = (path: string, token = 'read', init: RequestInit = {}) => fetch(`${origin}/api/tasks/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type':'application/json' } })
it('denies missing, revoked, expired credentials and forbidden tasks/cursors', async () => {
  for (const token of ['', 'revoked', 'expired']) expect((await request('v1/tasks',token)).status).toBe(401)
  expect((await request('v1/tasks/task1')).status).toBe(404)
  expect((await request('v1/tasks/%E0%A4%A')).status).toBe(400)
  expect((await request('v1/tasks?project_id=secret')).status).toBe(403)
  expect((await request('v1/tasks?project_id=p&cursor=task1')).status).toBe(400)
  const response=await request('v1/tasks');expect((await response.json()).items.map((x:{id:string})=>x.id)).toEqual(['task0'])
})
it('enforces read-only grants and optimistic version conflicts over HTTP',async()=>{
  const update={method:'PATCH',body:JSON.stringify({expectedVersion:0,patch:{title:'Changed'}})}
  expect((await request('v1/tasks/task0','read',update)).status).toBe(403)
  expect((await request('v1/tasks/task0','write',update)).status).toBe(200)
  expect((await request('v1/tasks/task0','write',update)).status).toBe(409)
  expect((await request('v1/tasks/task0','write',{method:'PATCH',body:JSON.stringify({expectedVersion:1,patch:{statusId:'foreign'}})})).status).toBe(400)
})
it('keeps the four Orbit MCP read tools and snake_case request/result contracts',async()=>{
  const rpc=async(method:string,params?:unknown)=>(await (await request('mcp','read',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json())
  const tools=await rpc('tools/list');expect(tools.result.tools.map((t:{name:string})=>t.name).sort()).toEqual(['get_task','list_projects','list_task_statuses','list_tasks'])
  const task=await rpc('tools/call',{name:'get_task',arguments:{task_id:'P-1'}})
  expect(task.result.structuredContent).toMatchObject({id:'task0',project_id:'p',number:1,parent_task_id:null,identifier:'P-1',due_start_at:null})
  const forbidden=await rpc('tools/call',{name:'get_task',arguments:{task_id:'task1'}});expect(forbidden.result.isError).toBe(true)
  const bad=await rpc('tools/call',{name:'list_tasks',arguments:{project_id:'p',bogus:true}});expect(bad.error.code).toBe(-32602)
  const searched=await rpc('tools/call',{name:'list_tasks',arguments:{query:'Details'}});expect(searched.result.structuredContent.items).toHaveLength(1)
})
it('creates tasks and comments without accepting a forged author',async()=>{
  const response=await request('v1/tasks','write',{method:'POST',body:JSON.stringify({projectId:'p',title:'New task',description:'Local',priority:'high'})})
  expect(response.status).toBe(201)
  const created=await response.json();expect(created.identifier).toBe('P-3')
  const comment=await request(`v1/tasks/${created.id}/comments`,'write',{method:'POST',body:JSON.stringify({body:'A comment'})});expect(comment.status).toBe(201)
  expect((await comment.json()).authorId).toBe('u')
  const forged=await request(`v1/tasks/${created.id}/comments`,'write',{method:'POST',body:JSON.stringify({body:'Forged',authorId:'other'})});expect(forged.status).toBe(400)
  expect((await (await request(`v1/tasks/${created.id}/comments`)).json()).items).toHaveLength(1)
})
