import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { seedTasks } from './helpers/tasks'
import { vault } from '../src/server/vault'
import { verifyRecovery } from '../src/server/tasks-cli'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('verifies restored tasks and GitHub credentials together and rejects a different key or app', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-recovery-')); dirs.push(dir)
  seedTasks(join(dir, 'tasks.sqlite')).close()
  const db = new DatabaseSync(join(dir, 'tasks.sqlite'))
  db.prepare('INSERT INTO task_module_rows VALUES (?,?,?)').run('github_apps', 'app', JSON.stringify({ app_id: '123' }))
  db.close()
  const host = new DatabaseSync(join(dir, 'tucano.db'))
  host.exec('CREATE TABLE task_executions(source_id,workspace_id,task_id,data); CREATE TABLE meta(key,value); CREATE TABLE agents(id);')
  host.close()
  const key = randomBytes(32)
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  writeFileSync(join(dir, 'server.key'), key.toString('base64'))
  const sealed = (appId: string) => vault(key).seal(JSON.stringify({ appId, privateKey, webhookSecret: 'synthetic' }))
  writeFileSync(join(dir, 'tasks-github.sealed'), sealed('123'))
  expect(verifyRecovery(dir)).toEqual({ projects: 1, tasks: 1, native: { executions: 0, assignments: 0 }, githubCredentials: true })
  writeFileSync(join(dir, 'server.key'), randomBytes(32).toString('base64'))
  expect(() => verifyRecovery(dir)).toThrow()
  writeFileSync(join(dir, 'server.key'), key.toString('base64'))
  writeFileSync(join(dir, 'tasks-github.sealed'), sealed('456'))
  expect(() => verifyRecovery(dir)).toThrow('GitHub app does not match')
})
