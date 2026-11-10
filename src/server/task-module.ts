import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TaskStore } from '../tasks/store'
import { createTasksHandler } from '../tasks/http'

export function taskModule(dataDir: string, publicOrigin: string, open: (sealed: string) => string): ReturnType<typeof createTasksHandler> {
  const store = new TaskStore(join(dataDir, 'tasks.sqlite'))
  return createTasksHandler(store, {
    publicOrigin,
    githubCredentials: () => {
      return readTaskGithubCredentials(dataDir, open)
    }
  })
}

export function readTaskGithubCredentials(dataDir: string, open: (sealed: string) => string) {
  const file = join(dataDir, 'tasks-github.sealed')
  if (!existsSync(file)) return null
  const value: unknown = JSON.parse(open(readFileSync(file, 'utf8').trim()))
  if (!value || typeof value !== 'object' || !('appId' in value) || !('webhookSecret' in value)
    || typeof value.appId !== 'string' || typeof value.webhookSecret !== 'string'
    || !('privateKey' in value) || typeof value.privateKey !== 'string') {
    throw new Error('Invalid tasks GitHub credentials')
  }
  return { appId: value.appId, webhookSecret: value.webhookSecret, privateKey: value.privateKey }
}
