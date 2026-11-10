import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { importOrbit } from './import-orbit'
import { TaskStore } from './store'

function required(args: string[], key: string): string {
  const index = args.indexOf(key)
  const value = index < 0 ? undefined : args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing ${key}`)
  return value
}
function nativeSource(file: string): { id: string; workspaceId: string } {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='orbit:source'").get()
    const source: unknown = row ? JSON.parse(String(row.value)) : null
    if (!source || typeof source !== 'object' || !('id' in source) || !('workspaceId' in source)
      || typeof source.id !== 'string' || typeof source.workspaceId !== 'string') throw new Error('Native task identity missing')
    return { id: source.id, workspaceId: source.workspaceId }
  } finally { db.close() }
}
export function verifyNative(hostFile: string, store: TaskStore): { executions: number; assignments: number } {
  const db = new DatabaseSync(hostFile, { readOnly: true })
  try {
    const source = store.source()
    if (!source) throw new Error('Task source missing')
    const who = store.ownerPrincipal()
    const executions = db.prepare('SELECT source_id,workspace_id,task_id,data FROM task_executions').all()
    for (const row of executions) {
      if (row.source_id !== source.id || row.workspace_id !== source.workspaceId) throw new Error('Unmapped native execution source')
      store.get(who, String(row.task_id))
      const value: unknown = JSON.parse(String(row.data))
      if (!value || typeof value !== 'object' || !('sourceId' in value) || value.sourceId !== source.id
        || !('workspaceId' in value) || value.workspaceId !== source.workspaceId
        || !('taskId' in value) || value.taskId !== row.task_id) throw new Error('Native execution identity mismatch')
    }
    const assignments = db.prepare("SELECT key,value FROM meta WHERE key LIKE 'orbit:assignment:%'").all()
    for (const row of assignments) {
      const ref: unknown = JSON.parse(String(row.key).slice('orbit:assignment:'.length))
      if (!Array.isArray(ref) || ref.length !== 4 || ref[0] !== source.id || ref[1] !== source.workspaceId
        || typeof ref[2] !== 'string' || !['executor','reviewer'].includes(ref[3])) throw new Error('Unmapped native assignment')
      store.get(who, ref[2])
      if (row.value && !db.prepare('SELECT 1 FROM agents WHERE id=?').get(row.value)) throw new Error('Assigned agent missing')
    }
    return { executions: executions.length, assignments: assignments.length }
  } finally { db.close() }
}
export function main(args: string[]): void {
  const command = args[0]
  if (command === 'import-orbit') {
    const sourcePath = resolve(required(args, '--source'))
    const targetPath = resolve(required(args, '--target'))
    const hostFile = resolve(required(args, '--host-db'))
    if ([sourcePath, hostFile].includes(targetPath)) throw new Error('Import target must be separate')
    const source = nativeSource(hostFile)
    const result = importOrbit({ sourcePath, targetPath, sourceId: source.id, workspaceId: source.workspaceId, ownerTokenId: required(args, '--owner-token-id') })
    const store = new TaskStore(targetPath)
    try { console.log(JSON.stringify({ ...result, native: verifyNative(hostFile, store) })) }
    finally { store.close() }
    return
  }
  const store = new TaskStore(resolve(required(args, '--database')))
  try {
    if (command === 'verify-native') {
      console.log(JSON.stringify(verifyNative(required(args, '--host-db'), store)))
    } else if (command === 'issue-token') {
      const output = resolve(required(args, '--output'))
      if (existsSync(output)) throw new Error('Credential output already exists')
      const input: unknown = JSON.parse(readFileSync(required(args, '--request'), 'utf8'))
      if (!input || typeof input !== 'object' || !('name' in input) || typeof input.name !== 'string'
        || !('projectIds' in input) || !Array.isArray(input.projectIds) || !input.projectIds.every((p): p is string => typeof p === 'string')
        || !('expiresAt' in input) || typeof input.expiresAt !== 'string') throw new Error('Expected name, projectIds and expiresAt')
      const result = store.issueToken(store.ownerPrincipal(), { name: input.name, projectIds: input.projectIds, scopes: ['tasks:read'], expiresAt: input.expiresAt })
      try { writeFileSync(output, JSON.stringify(result), { mode: 0o600, flag: 'wx' }) }
      catch (error) { store.revokeToken(store.ownerPrincipal(), result.id); throw error }
      console.log(JSON.stringify({ id: result.id, credentialFile: output }))
    } else if (command === 'revoke-token') {
      store.revokeToken(store.ownerPrincipal(), required(args, '--id'))
      console.log(JSON.stringify({ revoked: true }))
    } else throw new Error('Use import-orbit, verify-native, issue-token or revoke-token')
  } finally { store.close() }
}
if (basename(process.argv[1] ?? '') === 'cli.ts') {
  try { main(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : 'Task command failed'); process.exitCode = 1 }
}
