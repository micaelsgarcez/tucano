import type { Effort, EngineId } from '../shared/types'
import type { Publication, PublishInput } from './publisher'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export type FactoryTool = Tool & { description: string }
export type Stage = 'prepare' | 'build' | 'verify' | 'review' | 'merge' | 'completed' | 'cancelled'
export type Role = 'build' | 'helper' | 'review'
export interface Criterion { id: string; description: string }
export interface Request { version: 1; id: string; taskId: string; requesterId: string; title: string; instruction: string; humanPrompt: string; criteria: Criterion[]; createdAt: number }
export interface Attempt extends Request { requestKey: string; stage: Stage; blocked: string | null; waiting: string | null; publishAuthorized: boolean; packageHash: string; candidateSha: string | null; helperRequested: boolean }
export interface Profile { modelId: string; model: string; engine: EngineId; effort: Effort }
export interface Job { id: string; attemptId: string; role: Role; state: 'reserved' | 'running' | 'done' | 'failed'; messageId: string | null; executionId: string | null; report: string; skillsRead: string[]; profile: Profile | null }
export interface Config {
  version: 2; enabled: boolean; ownerId: string; projectId: string; intakeAgentId: string; executorAgentId: string; reviewerAgentId: string; helperAgentId: string
  publication: { repository: { id: number; fullName: string }; base: string; adoptAttempts: { attemptId: string; candidateSha: string }[] }; packageHash: string; operationsPath: string; container: string; workerHostRoot: string; workerControllerRoot: string
  verification: string[][]; verificationFiles: string[]; requiredChecks: string[]; humanMergeLogin: string
}
export interface Usage { id: string; messageId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; ms: number; apiCostUsd?: number }
export interface Completion { id: string; author: { kind: 'agent'; id: string }; text: string; run: { status: string; error?: string; errorDetail?: string }; usage: Usage[] }
export interface Ports {
  assertSkills(agentId: string): void
  readSkill(agentId: string, args: Record<string, unknown>): { content: string; path: string }
  publish(input: PublishInput): Promise<Publication>
  createTask(input: { title: string; description: string; projectId: string }): Promise<{ id: string }>
  task(id: string): Promise<{ id: string; title: string; description: string; projectId: string }>
  launch(input: { requestId: string; taskId: string; requesterId: string; agentId: string; role: 'executor' | 'reviewer'; instructions: string }): Promise<{ id: string }>
  stop(messageId: string): void
  completeTask(taskId: string): Promise<void>
  comment(taskId: string, body: string): Promise<void>
}
export interface Turn {
  jobId: string; tools: FactoryTool[]
  context(prompt: string): string
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>
  delivered(system: string, profile: Profile): void
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return Object.fromEntries(Object.entries(value))
}
export function string(value: unknown): string { if (typeof value !== 'string') throw new Error('Expected a string'); return value }
export function strings(value: unknown): string[] { if (!Array.isArray(value)) throw new Error('Expected strings'); return value.map(string) }
export function id(value: unknown): string { const s = string(value); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) throw new Error('Invalid identifier'); return s }
export function sha(value: unknown): string { const s = string(value); if (!/^[0-9a-f]{40}$/.test(s)) throw new Error('Invalid commit'); return s }
export function criteria(value: unknown): Criterion[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error('Provide 1–20 acceptance criteria')
  return value.map((item, i) => ({ id: `C${i + 1}`, description: string(item).trim() })).map(c => { if (!c.description || c.description.length > 2000) throw new Error('Invalid criterion'); return c })
}
export function config(value: unknown): Config {
  const v = object(value)
  if (v.version !== 2 || typeof v.enabled !== 'boolean') throw new Error('Invalid factory configuration')
  if (!Array.isArray(v.verification) || !v.verification.length) throw new Error('Verification commands required')
  const verificationFiles = strings(v.verificationFiles); if (!verificationFiles.length) throw new Error('Trusted verification files must be pinned')
  const checks = strings(v.requiredChecks); if (!checks.length || checks.some(c => !c.trim())) throw new Error('Required CI checks must be explicit')
  const hash = string(v.packageHash); if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid package pin')
  const executorAgentId = id(v.executorAgentId), reviewerAgentId = id(v.reviewerAgentId), helperAgentId = id(v.helperAgentId)
  if (reviewerAgentId === executorAgentId || reviewerAgentId === helperAgentId) throw new Error('Factory reviewer must be independent from implementation and exploration')
  const p = object(v.publication), repository = object(p.repository)
  if (repository.id !== 1423677589 || repository.fullName !== 'micaelsgarcez/central' || p.base !== 'main' || !Array.isArray(p.adoptAttempts)) throw new Error('Invalid publication configuration')
  const publication = { repository: { id: repository.id, fullName: repository.fullName }, base: p.base, adoptAttempts: p.adoptAttempts.map(value => { const a = object(value); return { attemptId: id(a.attemptId), candidateSha: sha(a.candidateSha) } }) }
  return { version: 2, enabled: v.enabled, ownerId: string(v.ownerId), projectId: id(v.projectId), intakeAgentId: id(v.intakeAgentId), executorAgentId, reviewerAgentId, helperAgentId, publication, packageHash: hash, operationsPath: string(v.operationsPath), container: string(v.container), workerHostRoot: string(v.workerHostRoot), workerControllerRoot: string(v.workerControllerRoot), verification: v.verification.map(strings), verificationFiles, requiredChecks: checks, humanMergeLogin: string(v.humanMergeLogin) }
}
