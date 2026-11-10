import { createPrivateKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { main, verifyNative } from '../tasks/cli'
import { TaskStore } from '../tasks/store'
import { readTaskGithubCredentials } from './task-module'
import { vault } from './vault'

export function verifyRecovery(dataDir: string) {
  const database = join(dataDir, 'tasks.sqlite')
  const raw = new DatabaseSync(database, { readOnly: true })
  try {
    if (raw.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('Task database integrity failed')
    const credentials = readTaskGithubCredentials(dataDir, vault(Buffer.from(readFileSync(join(dataDir, 'server.key'), 'utf8').trim(), 'base64')).open)
    if (!credentials || createPrivateKey(credentials.privateKey).asymmetricKeyType !== 'rsa') throw new Error('GitHub credentials missing or invalid')
    const apps = raw.prepare("SELECT data FROM task_module_rows WHERE kind='github_apps'").all()
    if (!apps.some(row => String(JSON.parse(String(row.data)).app_id) === credentials.appId)) throw new Error('GitHub app does not match task data')
    const store = new TaskStore(database)
    try {
      const owner = store.ownerPrincipal()
      const tasks = Number(raw.prepare("SELECT count(*) AS n FROM task_module_rows WHERE kind='tasks'").get()!.n)
      return { projects: store.projects(owner).length, tasks, native: verifyNative(join(dataDir, 'tucano.db'), store), githubCredentials: true }
    } finally { store.close() }
  } finally { raw.close() }
}

if (basename(process.argv[1] ?? '') === 'tasks.js') {
  try {
    const args = process.argv.slice(2)
    if (args[0] === 'verify-recovery') {
      if (args.length !== 3 || args[1] !== '--data-dir' || !args[2]) throw new Error('Use verify-recovery --data-dir <directory>')
      console.log(JSON.stringify(verifyRecovery(args[2])))
    } else main(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Task command failed')
    process.exitCode = 1
  }
}
