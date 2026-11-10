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
  const issued = await request(`/app/installations/${delivery.installationId}/access_tokens`, jwt, 'POST')
  const token = string(issued?.token)
  if (!token) fail(502, 'Missing GitHub installation token')
  const repositories: { repositoryId: string; repositoryFullName: string; accessible: boolean }[] = []
  // Bound work and ignore API-provided pagination URLs, which must never become fetch targets.
  for (let page = 1; ; page++) {
    const result = await request(`/installation/repositories?per_page=100&page=${page}`, token)
    if (!Array.isArray(result?.repositories)) fail(502, 'Invalid GitHub repositories')
    for (const value of result.repositories) {
      const repository = object(value)
      repositories.push({ repositoryId: githubId(repository.id), repositoryFullName: string(repository.full_name), accessible: true })
    }
    if (result.repositories.length < 100) break
    if (page === 20) fail(502, 'GitHub repository pagination limit exceeded')
  }
  if (delivery.kind === 'installation' || delivery.kind === 'access') return { ...common, kind: 'access', installationState: 'active', repositories }
  if (delivery.kind === 'repositories') {
    return { ...common, kind: 'access', installationState: 'active', repositories: delivery.repositoryIds.map((repositoryId, index) => {
      const repositoryFullName = delivery.repositoryFullNames[index]!
      const found = repositories.find(repository => repository.repositoryId === repositoryId && repository.repositoryFullName.toLowerCase() === repositoryFullName.toLowerCase())
      return found ?? { repositoryId, repositoryFullName, accessible: false }
    }) }
  }
  const repository = repositories.find(value => value.repositoryId === delivery.repositoryId && value.repositoryFullName.toLowerCase() === delivery.repositoryFullName.toLowerCase())
  if (!repository) return { ...common, retryable: true, kind: 'access', installationState: 'active', repositories: [{ repositoryId: delivery.repositoryId, repositoryFullName: delivery.repositoryFullName, accessible: false }] }
  const parts = repository.repositoryFullName.split('/')
  if (parts.length !== 2 || parts.some(part => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')) fail(502, 'Invalid GitHub repository name')
  const path = `/repos/${parts.map(encodeURIComponent).join('/')}/${delivery.itemType === 'issue' ? 'issues' : 'pulls'}/${delivery.number}`
  const current = await request(path, token)
  const item = parseGithubItem(common, delivery.action, delivery.itemType, { id: repository.repositoryId, full_name: repository.repositoryFullName }, current)
  if (!item || item.itemId !== delivery.itemId || item.number !== delivery.number) fail(409, 'GitHub item identity changed')
  signal.throwIfAborted()
  return item
}
