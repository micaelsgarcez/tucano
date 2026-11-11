import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Db } from '../src/core/db'
import { ConnectorManager } from '../src/core/connectors'
import { plainCipher, Secrets } from '../src/core/secrets'
import type { Agent } from '../src/shared/types'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture(readOp?: (ref: string) => Promise<string>) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-credential-'))
  const db = new Db(join(directory, 'native.sqlite'))
  cleanups.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
  const agent: Agent = { id: 'caio', name: 'Caio', handle: 'caio', role: '', color: 'sky', instructions: '', modelId: 'gpt-6-astra', effort: 'low', limit: 100, used: 0, grants: { github: 'read_write' }, memory: 'auto', computer: false, archived: false }
  db.saveAgent(agent)
  db.saveConnector({ id: 'github', name: 'GitHub', kind: 'remote', url: 'https://api.githubcopilot.com/mcp/', auth: 'token' })
  const secrets = new Secrets(db, plainCipher)
  const connectors = new ConnectorManager({ db, secrets, readOp, emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => '' })
  return { db, agent, secrets, connectors }
}
test('trusted publisher reads the existing native token only with the live read/write grant', async () => {
  const f = fixture(); await f.secrets.set('connector:github:token', 'native-token')
  expect(await f.connectors.githubToken(f.agent.id)).toEqual({ token: 'native-token' })
  f.db.saveAgent({ ...f.agent, grants: { github: 'read' } })
  expect(await f.connectors.githubToken(f.agent.id)).toHaveProperty('waiting')
  f.db.saveAgent({ ...f.agent, archived: true })
  expect(await f.connectors.githubToken(f.agent.id)).toHaveProperty('waiting')
})
test('grant revocation during native secret resolution prevents publication', async () => {
  let revoke = (): void => {}
  const f = fixture(async () => { revoke(); return 'resolved-token' })
  revoke = () => f.db.saveAgent({ ...f.agent, grants: {} })
  await f.secrets.set('connector:github:token', 'op://vault/item/token')
  expect(await f.connectors.githubToken(f.agent.id)).toHaveProperty('waiting')
})
test('ambiguous connectors and a lookalike URL cannot supply credentials', async () => {
  const f = fixture(); await f.secrets.set('connector:github:token', 'native-token')
  f.db.saveConnector({ id: 'other', name: 'GitHub', kind: 'remote', url: 'https://api.githubcopilot.com/mcp/', auth: 'token' })
  f.db.saveAgent({ ...f.agent, grants: { github: 'read_write', other: 'read_write' } })
  expect(await f.connectors.githubToken(f.agent.id)).toHaveProperty('waiting')
  f.db.saveAgent(f.agent)
  f.db.saveConnector({ id: 'github', name: 'GitHub', kind: 'remote', url: 'https://api.githubcopilot.com.evil/mcp/', auth: 'token' })
  expect(await f.connectors.githubToken(f.agent.id)).toHaveProperty('waiting')
})
