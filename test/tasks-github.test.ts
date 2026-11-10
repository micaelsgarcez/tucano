import { createServer, type Server } from 'node:http'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { TaskStore } from '../src/tasks/store'
import { createTasksHandler } from '../src/tasks/http'
let store: TaskStore, server: Server, dir: string, origin: string
const secret = 'fixture-only-webhook-secret'
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tasks-github-')); store = new TaskStore(join(dir, 'tasks.sqlite'))
  store.importSnapshot({ fingerprint: 'github-test', source: { id: 'source', workspaceId: 'w' }, owner: { id: 'u', workspaceId: 'w', projectIds: ['p'], scopes: ['tasks:write'], serviceAccountId: null, owner: true }, tables: {
    users:[{id:'u',display_name:'User'}],projects:[{id:'p',workspace_id:'w',project_key:'APP',name:'Project',color:'#fff',task_counter:0}],
    task_statuses:['unstarted','completed','cancelled'].map((category,position)=>({id:category,project_id:'p',name:category,color:'#fff',category,position})),
    github_apps:[{workspace_id:'w',app_id:10}], github_installations:[{installation_id:20,workspace_id:'w',account_login:'owner'}],
    github_installation_repositories:[{installation_id:20,repository:'owner/repo'}],
    github_project_connections:[{project_id:'p',workspace_id:'w',installation_id:20,repository:'owner/repo',label:'sync'}]
  } })
  const handler=createTasksHandler(store,{githubCredentials:()=>({appId:'10',webhookSecret:secret})})
  server=createServer((req,res)=>{if(!handler(req,res)){res.statusCode=404;res.end()}})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();if(!addr||typeof addr==='string')throw Error('No address');origin=`http://127.0.0.1:${addr.port}`
})
afterEach(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(dir,{recursive:true,force:true})})
function payload(second:number, fields:Record<string,unknown>={}) {return {action:'edited',installation:{id:20},repository:{id:30,full_name:'owner/repo'},issue:{id:40,number:1,title:`Title ${second}`,body:'Body',html_url:'https://github.com/owner/repo/issues/1',state:'open',labels:[{name:'sync'}],updated_at:`2026-11-10T12:00:${String(second).padStart(2,'0')}Z`,...fields}}}
async function deliver(value:unknown, delivery='delivery', event='issues', headers:Record<string,string>={}, path='/api/tasks/v1/github/webhook'){
  const body=JSON.stringify(value)
  return fetch(origin+path,{method:'POST',body,headers:{'x-github-event':event,'x-github-delivery':delivery,'x-github-hook-installation-target-type':'integration','x-github-hook-installation-target-id':'10','x-hub-signature-256':`sha256=${createHmac('sha256',secret).update(body).digest('hex')}`,...headers}})
}
const tasks=()=>store.list(store.ownerPrincipal()).items
it('checks exact raw HMAC, app ID and size on both webhook paths',async()=>{
  expect((await deliver(payload(1),'bad','issues',{'x-hub-signature-256':`sha256=${'0'.repeat(64)}`})).status).toBe(401)
  expect((await deliver(payload(1),'app','issues',{'x-github-hook-installation-target-id':'11'},'/api/v1/integrations/github/webhook')).status).toBe(401)
  expect((await deliver({padding:'x'.repeat(1_048_576)})).status).toBe(413)
  expect(tasks()).toHaveLength(0)
  expect((await fetch(origin+'/api/tasks/v1/tasks')).status).toBe(401)
  expect((await fetch(origin+'/api/v1/tasks')).status).toBe(404)
})
it('deduplicates delivery, rejects changed replay and ignores older item state',async()=>{
  expect((await deliver(payload(10))).status).toBe(200);const first=tasks()[0];expect(first?.title).toBe('Title 10')
  expect((await deliver(payload(10))).status).toBe(200);expect(tasks()).toHaveLength(1)
  expect((await deliver(payload(11))).status).toBe(409)
  expect((await deliver(payload(5),'older')).status).toBe(200);expect(tasks()[0]?.title).toBe('Title 10')
  await deliver(payload(12,{state:'closed'}),'closed');expect(tasks()[0]?.statusId).toBe('completed');expect(tasks()[0]?.id).toBe(first?.id)
})
it('pauses on label removal and resumes same task without stale resurrection',async()=>{
  await deliver(payload(1),'first');const id=tasks()[0]?.id
  await deliver({...payload(3,{labels:[],title:'No sync'}),action:'unlabeled'},'unlabel')
  await deliver(payload(2,{title:'Stale labeled'}),'stale');expect(tasks()[0]?.title).toBe('Title 1')
  await deliver({...payload(4),action:'labeled'},'relabel');expect(tasks()[0]?.id).toBe(id);expect(tasks()[0]?.title).toBe('Title 4')
})
it('syncs PR merge and denies repository removal and deleted installation replays',async()=>{
  const issue=payload(1).issue
  await deliver({action:'closed',installation:{id:20},repository:{id:30,full_name:'owner/repo'},pull_request:{...issue,id:41,number:2,state:'closed',merged:true,html_url:'https://github.com/owner/repo/pull/2'}},'pr','pull_request')
  expect(tasks()[0]?.statusId).toBe('completed')
  await deliver({action:'removed',installation:{id:20},repositories_removed:[{id:30,full_name:'owner/repo'}]},'remove','installation_repositories')
  await deliver(payload(3),'after-remove');expect(tasks()).toHaveLength(1)
  await deliver({action:'deleted',installation:{id:20}},'deleted','installation')
  await deliver({action:'created',installation:{id:20}},'old-created','installation')
  await deliver(payload(4),'after-delete');expect(tasks()).toHaveLength(1)
})
