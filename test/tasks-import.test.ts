import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { importOrbit } from '../src/tasks/import-orbit'
import { TaskStore } from '../src/tasks/store'
let dir: string, source: string, target: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tasks-import-'))
  source = join(dir, 'orbit.sqlite')
  target = join(dir, 'tasks.sqlite')
  const db = new DatabaseSync(source)
  db.exec(`CREATE TABLE workspaces(id TEXT,deleted_at INTEGER); INSERT INTO workspaces VALUES('w',NULL);
 CREATE TABLE users(id TEXT,display_name TEXT,password_hash TEXT);INSERT INTO users VALUES('u','Owner','not-imported');
 CREATE TABLE memberships(id TEXT,workspace_id TEXT,user_id TEXT);INSERT INTO memberships VALUES('m','w','u');
 CREATE TABLE projects(id TEXT,workspace_id TEXT,project_key TEXT,name TEXT,color TEXT,task_counter INTEGER);INSERT INTO projects VALUES('p','w','P','Project','red',5),('q','w','Q','Hidden','red',1);
 CREATE TABLE task_statuses(id TEXT,project_id TEXT,category TEXT,position INTEGER,name TEXT,color TEXT);INSERT INTO task_statuses VALUES('s','p','unstarted',0,'Todo','red');
 CREATE TABLE tasks(id TEXT,workspace_id TEXT,project_id TEXT,status_id TEXT,number INTEGER,title TEXT,description TEXT,priority TEXT,version INTEGER,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);INSERT INTO tasks VALUES('a','w','p','s',1,'Task','Markdown','none',3,1,2,NULL),('deleted','w','p','s',2,'Deleted','','none',0,1,2,3);
 CREATE TABLE api_tokens(id TEXT,workspace_id TEXT,created_by TEXT,token_hash BLOB,scopes TEXT,revoked_at INTEGER,expires_at INTEGER,all_projects INTEGER);
 CREATE TABLE api_token_projects(token_id TEXT,project_id TEXT);INSERT INTO api_token_projects VALUES('ui','p');
 CREATE TABLE task_relations(id TEXT,task_id TEXT,related_task_id TEXT,type TEXT);INSERT INTO task_relations VALUES('relation','a','deleted','related');
 CREATE TABLE task_collab_docs(task_id TEXT,snapshot BLOB,snapshot_seq INTEGER,projected_seq INTEGER);INSERT INTO task_collab_docs VALUES('a',X'0102',4,4);
 CREATE TABLE audit_events(id TEXT,action TEXT);INSERT INTO audit_events VALUES('event','task.create');`)
  db.prepare('INSERT INTO api_tokens VALUES(?,?,?,?,?,NULL,NULL,0)').run(
    'ui',
    'w',
    'u',
    createHash('sha256').update('read-token').digest(),
    'tasks:read',
  )
  db.close()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
function run() {
  return importOrbit({
    sourcePath: source,
    targetPath: target,
    sourceId: 'native-source',
    workspaceId: 'w',
    ownerTokenId: 'ui',
  })
}
it('imports consistently, preserves source identity/auth/history/deletions and refuses a changed snapshot', () => {
  const report = run()
  expect(report.imported).toBe(true)
  expect(report.counts.tasks).toBe(2)
  expect(report.counts.task_relations).toBe(1)
  const store = new TaskStore(target)
  const who = store.ownerPrincipal()
  expect(who.projectIds).toEqual(['p'])
  expect(store.source()?.id).toBe('native-source')
  expect(store.list(who).items).toHaveLength(1)
  expect(store.get(who, 'a').description).toBe('Markdown')
  expect(() =>
    store.create(store.authenticate('read-token'), { projectId: 'p', title: 'no' }),
  ).toThrow('Scope denied')
  expect(store.create(who, { projectId: 'p', title: 'New' }).identifier).toBe('P-6')
  store.close()
  expect(run().imported).toBe(false)
  const db = new DatabaseSync(source)
  db.exec("UPDATE tasks SET title='Changed' WHERE id='a'")
  db.close()
  expect(run).toThrow('another snapshot')
  const targetDb = new DatabaseSync(target)
  expect(
    String(targetDb.prepare("SELECT data FROM task_module_rows WHERE kind='users'").get()?.data),
  ).not.toContain('password_hash')
  expect(
    targetDb.prepare("SELECT count(*) n FROM task_module_rows WHERE kind='task_collab_docs'").get()
      ?.n,
  ).toBe(1)
  targetDb.close()
})
it('refuses stale collab projections and unknown populated task features before target mutation', () => {
  const db = new DatabaseSync(source)
  db.exec('UPDATE task_collab_docs SET projected_seq=3')
  db.close()
  expect(run).toThrow('not fully projected')
  const db2 = new DatabaseSync(source)
  db2.exec(
    "UPDATE task_collab_docs SET projected_seq=4;CREATE TABLE task_new_feature(id TEXT);INSERT INTO task_new_feature VALUES('x')",
  )
  db2.close()
  expect(run).toThrow('Unsupported populated task table')
})
it('refuses broken counters and keeps native owner access independent of imported token expiry', () => {
  const db = new DatabaseSync(source)
  db.exec('UPDATE projects SET task_counter=0')
  db.close()
  expect(run).toThrow('counter')
  const db2 = new DatabaseSync(source)
  db2.exec('UPDATE projects SET task_counter=5')
  db2.close()
  run()
  const targetDb = new DatabaseSync(target)
  targetDb.exec(
    "UPDATE task_module_rows SET data=json_set(data,'$.revoked_at',1) WHERE kind='api_tokens'",
  )
  targetDb.close()
  const store = new TaskStore(target)
  expect(store.ownerPrincipal().projectIds).toEqual(['p'])
  expect(() => store.authenticate('read-token')).toThrow('Invalid token')
  store.close()
})
it('refuses future database versions without changing the version', () => {
  const db = new DatabaseSync(target)
  db.exec('PRAGMA user_version=2')
  db.close()
  expect(() => new TaskStore(target)).toThrow('newer application')
  const check = new DatabaseSync(target)
  expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
  check.close()
})
it('rejects missing relationship references before creating the target', () => {
  const db = new DatabaseSync(source)
  db.exec("UPDATE task_relations SET related_task_id='missing'")
  db.close()
  expect(run).toThrow('Invalid task relationship')
})

it('preserves 64-bit collaboration identifiers without numeric rounding and ignores retired token grants', () => {
  const sourceDb = new DatabaseSync(source)
  sourceDb.exec("ALTER TABLE task_collab_docs ADD COLUMN client_id INTEGER; UPDATE task_collab_docs SET client_id=7036123389894424313; ALTER TABLE api_tokens ADD COLUMN project_id TEXT; UPDATE api_tokens SET project_id='q'")
  sourceDb.close()
  run()
  const db = new DatabaseSync(target)
  const row = db.prepare("SELECT data FROM task_module_rows WHERE kind='task_collab_docs'").get()
  expect(JSON.parse(String(row?.data)).client_id).toBe('7036123389894424313')
  db.close()
  const store = new TaskStore(target)
  expect(store.ownerPrincipal().projectIds).toEqual(['p'])
  expect(store.authenticate('read-token').projectIds).toEqual(['p'])
  store.close()
})
