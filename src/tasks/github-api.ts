import { sign } from 'node:crypto'
import { fail, githubId, object, parseGithubItem, string, type GithubCredentials, type GithubDelivery } from './github'

// Resolve signed notifications to current state; payload timestamps cannot order GitHub's same-second edits.
export async function reconcileGithubDelivery(
  delivery: GithubDelivery,
  credentials: GithubCredentials,
  fetchApi: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(8_000),
): Promise<GithubDelivery> {
  if (!credentials.privateKey) return delivery
  const now = Math.floor(Date.now() / 1000)
  const jwtBody = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: credentials.appId })).toString('base64url')}`
  const jwt = `${jwtBody}.${sign('RSA-SHA256', Buffer.from(jwtBody), credentials.privateKey).toString('base64url')}`
  async function request(path: string, token: string, method = 'GET', allowMissing = false): Promise<Record<string, unknown> | null> {
    signal.throwIfAborted()
    const response = await fetchApi(`https://api.github.com${path}`, {
      method, signal, redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tucano-tasks' },
    })
    if (allowMissing && response.status === 404) return null
    if (!response.ok) fail(502, `GitHub reconciliation failed (${response.status})`)
    return object(await response.json())
  }
  const common = { deliveryId: delivery.deliveryId, digest: delivery.digest, appId: delivery.appId, installationId: delivery.installationId, authoritative: true as const }
  const retryable = delivery.kind === 'item' ? { retryable: true as const } : {}
  const installation = await request(`/app/installations/${delivery.installationId}`, jwt, 'GET', true)
  if (!installation) return { ...common, ...retryable, kind: 'access', installationState: 'deleted', repositories: [] }
  if (githubId(installation.id) !== delivery.installationId || githubId(installation.app_id) !== delivery.appId) fail(502, 'GitHub installation mismatch')
  if (installation.suspended_at !== null) {
    if (typeof installation.suspended_at !== 'string') fail(502, 'Invalid GitHub installation state')
    return { ...common, ...retryable, kind: 'access', installationState: 'suspended', repositories: [] }
  }
  if (delivery.kind === 'installation' || delivery.kind === 'access') return { ...common, kind: 'access', installationState: 'active', repositories: [] }
  let token: string | undefined
  async function repositoryAccess(repositoryId: string, repositoryFullName: string) {
    const parts = repositoryFullName.split('/')
    if (parts.length !== 2 || parts.some(part => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')) fail(502, 'Invalid GitHub repository name')
    const path = `/repos/${parts.map(encodeURIComponent).join('/')}`
    const denied = { repositoryId, repositoryFullName, accessible: false }
    // Public repository metadata alone does not prove access by this installation.
    const membership = await request(`${path}/installation`, jwt, 'GET', true)
    if (!membership) return denied
    if (githubId(membership.app_id) !== delivery.appId) fail(502, 'GitHub app mismatch')
    if (membership.suspended_at !== null && typeof membership.suspended_at !== 'string') fail(502, 'Invalid GitHub installation state')
    if (githubId(membership.id) !== delivery.installationId || membership.suspended_at !== null) return denied
    if (!token) {
      const issued = await request(`/app/installations/${delivery.installationId}/access_tokens`, jwt, 'POST')
      token = string(issued?.token)
      if (!token) fail(502, 'Missing GitHub installation token')
    }
    const repository = await request(path, token, 'GET', true)
    if (!repository || githubId(repository.id) !== repositoryId || string(repository.full_name).toLowerCase() !== repositoryFullName.toLowerCase()) return denied
    return { repositoryId, repositoryFullName, accessible: true }
  }
  if (delivery.kind === 'repositories') {
    const repositories = []
    for (const [index, repositoryId] of delivery.repositoryIds.entries()) {
      repositories.push(await repositoryAccess(repositoryId, delivery.repositoryFullNames[index]!))
    }
    return { ...common, kind: 'access', installationState: 'active', repositories }
  }
  const repository = await repositoryAccess(delivery.repositoryId, delivery.repositoryFullName)
  if (!repository.accessible) return { ...common, retryable: true, kind: 'access', installationState: 'active', repositories: [repository] }
  const path = `/repos/${repository.repositoryFullName.split('/').map(encodeURIComponent).join('/')}/${delivery.itemType === 'issue' ? 'issues' : 'pulls'}/${delivery.number}`
  const current = await request(path, string(token))
  const item = parseGithubItem(common, delivery.action, delivery.itemType, { id: repository.repositoryId, full_name: repository.repositoryFullName }, current)
  if (!item || item.itemId !== delivery.itemId || item.number !== delivery.number) fail(409, 'GitHub item identity changed')
  signal.throwIfAborted()
  return item
}
