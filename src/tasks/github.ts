import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

interface Delivery { deliveryId: string; digest: string; appId: string; installationId: string; authoritative?: true }
export type GithubDelivery = Delivery & (
  | { kind: 'item'; repositoryId: string; repositoryFullName: string; itemId: string; number: number; itemType: 'issue' | 'pull_request'; title: string; body: string; url: string; state: 'open' | 'closed'; merged: boolean; labels: string[]; updatedAt: string; action: string }
  | { kind: 'access'; retryable?: true; installationState: 'active' | 'suspended' | 'deleted'; repositories: { repositoryId: string; repositoryFullName: string; accessible: boolean }[] }
  | { kind: 'installation'; action: 'deleted' | 'suspend' | 'unsuspend' | 'created' }
  | { kind: 'repositories'; action: 'added' | 'removed'; repositoryIds: string[]; repositoryFullNames: string[] }
)
export interface GithubCredentials { appId: string; webhookSecret: string; privateKey?: string }
export function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }) }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected an object')
  return value as Record<string, unknown>
}
export function string(value: unknown): string { if (typeof value !== 'string') fail(400, 'Expected a string'); return value }
export function githubId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  return fail(400, 'Invalid GitHub ID')
}
export function parseGithubDelivery(raw: Buffer, headers: IncomingHttpHeaders, credentials: GithubCredentials | null): GithubDelivery | null {
  const event = headers['x-github-event']
  if (event === 'ping') return null
  const signature = headers['x-hub-signature-256']
  if (!credentials || headers['x-github-hook-installation-target-type'] !== 'integration' || headers['x-github-hook-installation-target-id'] !== credentials.appId || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) fail(401, 'invalid_github_signature')
  const expected = createHmac('sha256', credentials.webhookSecret).update(raw).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) fail(401, 'invalid_github_signature')
  const deliveryId = string(headers['x-github-delivery'])
  if (!deliveryId || deliveryId.length > 200) fail(400, 'Invalid delivery ID')
  let parsed: unknown
  try { parsed = JSON.parse(raw.toString('utf8')) } catch { fail(400, 'Invalid JSON') }
  const payload = object(parsed)
  const common = { deliveryId, digest: createHash('sha256').update(raw).digest('hex'), appId: credentials.appId, installationId: githubId(object(payload.installation).id) }
  const action = string(payload.action)
  if (event === 'installation') {
    if (action !== 'deleted' && action !== 'suspend' && action !== 'unsuspend' && action !== 'created') return null
    return { ...common, kind: 'installation', action }
  }
  if (event === 'installation_repositories') {
    if (action !== 'added' && action !== 'removed') return null
    const repos = payload[action === 'added' ? 'repositories_added' : 'repositories_removed']
    if (!Array.isArray(repos)) fail(400, 'Invalid repositories')
    return { ...common, kind: 'repositories', action, repositoryIds: repos.map(value => githubId(object(value).id)), repositoryFullNames: repos.map(value => string(object(value).full_name)) }
  }
  if (event !== 'issues' && event !== 'pull_request') return null
  if (!['opened', 'edited', 'labeled', 'unlabeled', 'closed', 'reopened', 'synchronize'].includes(action)) return null
  return parseGithubItem(common, action, event === 'issues' ? 'issue' : 'pull_request', payload.repository, payload[event === 'issues' ? 'issue' : 'pull_request'])
}

export function parseGithubItem(common: Delivery, action: string, itemType: 'issue' | 'pull_request', repository: unknown, value: unknown): Extract<GithubDelivery, { kind: 'item' }> | null {
  const repo = object(repository)
  const item = object(value)
  if (itemType === 'issue' && item.pull_request) return null
  if (!Array.isArray(item.labels)) fail(400, 'Invalid labels')
  const state = item.state
  if (state !== 'open' && state !== 'closed') fail(400, 'Invalid item state')
  const updatedAt = string(item.updated_at)
  if (!Number.isFinite(Date.parse(updatedAt))) fail(400, 'Invalid update time')
  const number = Number(githubId(item.number))
  if (!Number.isSafeInteger(number)) fail(400, 'Invalid issue number')
  const url = string(item.html_url)
  if (!/^https:\/\/github\.com\//.test(url)) fail(400, 'Invalid GitHub URL')
  const title = string(item.title).trim()
  const description = item.body == null ? '' : string(item.body)
  if (!title || title.length > 500 || description.length > 1_000_000) fail(422, 'Invalid GitHub item')
  return { ...common, kind: 'item', action, repositoryId: githubId(repo.id), repositoryFullName: string(repo.full_name), itemId: githubId(item.id), number, itemType, title, body: description, url, state, merged: item.merged === true, labels: item.labels.map(value => string(object(value).name)), updatedAt }
}
