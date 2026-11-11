import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { id, object, string, strings, type Profile, type Attempt, type Job, type Role, type Stage, type Usage } from './types'

function stage(value: unknown): Stage {
  switch (value) { case 'prepare': case 'build': case 'verify': case 'review': case 'merge': case 'completed': case 'cancelled': return value; default: throw new Error('Invalid persisted factory stage') }
}
function role(value: unknown): Role { if (value === 'build' || value === 'helper' || value === 'review') return value; throw new Error('Invalid factory role') }
function state(value: unknown): Job['state'] { if (value === 'reserved' || value === 'running' || value === 'done' || value === 'failed') return value; throw new Error('Invalid factory job state') }
function attempt(value: unknown): Attempt {
  const a = object(value); const list: unknown = JSON.parse(string(a.criteria))
  if (!Array.isArray(list)) throw new Error('Invalid stored criteria')
  return { version: 1, id: id(a.id), requestKey: string(a.request_key), taskId: string(a.task_id), requesterId: string(a.requester_id), title: string(a.title), instruction: string(a.instruction), humanPrompt: string(a.human_prompt), criteria: list.map(c => { const x = object(c); return { id: string(x.id), description: string(x.description) } }), createdAt: Number(a.created_at), stage: stage(a.stage), blocked: a.blocked === null ? null : string(a.blocked), waiting: a.waiting === null ? null : string(a.waiting), publishAuthorized: a.publish_authorized === 1, packageHash: string(a.package_hash), candidateSha: a.candidate_sha === null ? null : string(a.candidate_sha), helperRequested: a.helper_requested === 1 }
}
function profile(value: unknown): Profile {
  const p = object(value)
  if (p.engine !== 'codex' && p.engine !== 'claude') throw new Error('Invalid persisted factory engine')
  if (p.effort !== 'low' && p.effort !== 'medium' && p.effort !== 'high' && p.effort !== 'xhigh') throw new Error('Invalid persisted factory effort')
  return { modelId: string(p.modelId), model: string(p.model), engine: p.engine, effort: p.effort }
}
function job(value: unknown): Job {
  const j = object(value)
  return { id: id(j.id), attemptId: id(j.attempt_id), role: role(j.role), state: state(j.state), messageId: j.message_id === null ? null : string(j.message_id), executionId: j.execution_id === null ? null : string(j.execution_id), report: string(j.report), skillsRead: strings(JSON.parse(string(j.skills_read))), profile: j.profile === null ? null : profile(JSON.parse(string(j.profile))) }
}
export class Store {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) > 2) { this.db.close(); throw new Error('Factory database requires a newer application') }
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL, requester_id TEXT NOT NULL, title TEXT NOT NULL, instruction TEXT NOT NULL, human_prompt TEXT NOT NULL, criteria TEXT NOT NULL, created_at INTEGER NOT NULL, stage TEXT NOT NULL, blocked TEXT, package_hash TEXT NOT NULL, candidate_sha TEXT, helper_requested INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS factory_one_active ON attempts((1)) WHERE stage NOT IN ('completed','cancelled');
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), role TEXT NOT NULL, state TEXT NOT NULL, message_id TEXT, execution_id TEXT, report TEXT NOT NULL DEFAULT '', skills_read TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS evidence (id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, job_id TEXT NOT NULL, data TEXT NOT NULL); `)
    const columns = (table: string): string[] => this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => string(c.name))
    if (!columns('attempts').includes('waiting')) this.db.exec('ALTER TABLE attempts ADD COLUMN waiting TEXT')
    if (!columns('attempts').includes('publish_authorized')) this.db.exec('ALTER TABLE attempts ADD COLUMN publish_authorized INTEGER NOT NULL DEFAULT 0')
    if (!columns('jobs').includes('profile')) this.db.exec('ALTER TABLE jobs ADD COLUMN profile TEXT')
    this.db.exec('PRAGMA user_version=2')
  }
  close(): void { this.db.close() }
  get(id_: string): Attempt { const row = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id_); if (!row) throw new Error('Factory attempt unavailable'); return attempt(row) }
  latest(): Attempt | undefined { const row = this.db.prepare('SELECT * FROM attempts ORDER BY created_at DESC LIMIT 1').get(); return row && attempt(row) }
  active(): Attempt | undefined { const row = this.db.prepare("SELECT * FROM attempts WHERE stage NOT IN ('completed','cancelled')").get(); return row && attempt(row) }
  byRequest(key: string): Attempt | undefined { const row = this.db.prepare('SELECT * FROM attempts WHERE request_key=?').get(key); return row && attempt(row) }
  reserve(input: Omit<Attempt, 'id' | 'version' | 'stage' | 'blocked' | 'candidateSha' | 'helperRequested' | 'waiting' | 'publishAuthorized'>): Attempt {
    const old = this.byRequest(input.requestKey); if (old) return old
    const id_ = randomUUID()
    this.db.prepare("INSERT INTO attempts (id,request_key,task_id,requester_id,title,instruction,human_prompt,criteria,created_at,stage,blocked,package_hash) VALUES (?,?,?,?,?,?,?,?,?,'prepare',?,?)").run(id_, input.requestKey, input.taskId, input.requesterId, input.title, input.instruction, input.humanPrompt, JSON.stringify(input.criteria), input.createdAt, input.taskId ? null : 'creating task', input.packageHash)
    this.record(id_, 'reserved', { requestKey: input.requestKey }); return this.get(id_)
  }
  bindTask(id_: string, taskId: string): void { this.db.prepare('UPDATE attempts SET task_id=?,blocked=NULL WHERE id=?').run(taskId, id_) }
  transition(id_: string, next: Stage, blocked: string | null = null): void { const prior = this.get(id_); this.db.prepare('UPDATE attempts SET stage=?,blocked=? WHERE id=?').run(next, blocked, id_); this.record(id_, 'stage', { from: prior.stage, to: next, blocked }) }
  block(id_: string, reason: string): void { this.db.prepare('UPDATE attempts SET blocked=? WHERE id=?').run(reason, id_); this.record(id_, 'blocked', { reason }) }
  wait(id_: string, reason: string | null): void { if (this.get(id_).waiting === reason) return; this.db.prepare('UPDATE attempts SET waiting=? WHERE id=?').run(reason, id_); this.record(id_, 'waiting', { reason }) }
  authorizePublication(id_: string): void { this.db.prepare('UPDATE attempts SET publish_authorized=1 WHERE id=?').run(id_); this.record(id_, 'publication.authorized', {}) }
  profile(id_: string, profile: Profile): void { this.db.prepare('UPDATE jobs SET profile=? WHERE id=?').run(JSON.stringify(profile), id_) }
  candidate(id_: string, sha: string): void { this.db.prepare('UPDATE attempts SET candidate_sha=? WHERE id=?').run(sha, id_) }
  newJob(id_: string, role_: Role): Job {
    const requestId = randomUUID(); this.db.prepare("INSERT INTO jobs(id,attempt_id,role,state) VALUES(?,?,?,'reserved')").run(requestId, id_, role_)
    if (role_ === 'helper') this.db.prepare('UPDATE attempts SET helper_requested=1 WHERE id=?').run(id_)
    return this.job(requestId)!
  }
  job(id_: string): Job | undefined { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id_); return row && job(row) }
  jobs(id_: string): Job[] { return this.db.prepare('SELECT * FROM jobs WHERE attempt_id=? ORDER BY rowid').all(id_).map(job) }
  launched(id_: string, executionId: string): void { this.db.prepare("UPDATE jobs SET execution_id=?,state=CASE WHEN state='reserved' THEN 'running' ELSE state END WHERE id=?").run(executionId, id_) }
  attach(id_: string, messageId: string): void {
    const existing = this.job(id_)
    if (!existing || !['reserved', 'running'].includes(existing.state) || (existing.messageId && existing.messageId !== messageId)) throw new Error('Factory execution already consumed; start a new explicit attempt')
    this.db.prepare('UPDATE jobs SET message_id=? WHERE id=?').run(messageId, id_)
  }
  finish(id_: string, status: 'done' | 'failed', report: string): void { this.db.prepare('UPDATE jobs SET state=?,report=? WHERE id=?').run(status, report, id_) }
  readSkill(id_: string, path: string): void { const j = this.job(id_); if (!j) throw new Error('Unknown job'); this.db.prepare('UPDATE jobs SET skills_read=? WHERE id=?').run(JSON.stringify([...new Set([...j.skillsRead, path])]), id_) }
  stageStarted(id_: string): number { const row = this.db.prepare("SELECT at FROM evidence WHERE attempt_id=? AND kind IN ('reserved','stage') ORDER BY id DESC LIMIT 1").get(id_); return Number(row?.at ?? this.get(id_).createdAt) }
  record(id_: string, kind: string, data: unknown): void { this.db.prepare('INSERT INTO evidence(attempt_id,kind,data,at) VALUES(?,?,?,?)').run(id_, kind, JSON.stringify(data), Date.now()) }
  usage(id_: string, jobId: string, usage: Usage[]): void { for (const u of usage) this.db.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?)').run(u.id, id_, jobId, JSON.stringify(u)) }
  recover(): void {
    const a = this.active(); if (!a) return
    if (!a.taskId) this.block(a.id, 'Task creation interrupted. Reconcile the native task before resuming; replay cannot create another task.')
    if (a.stage === 'build' || this.jobs(a.id).some(j => j.state === 'running' || j.state === 'reserved')) this.block(a.id, 'Execution interrupted by restart. Worker remains reserved until operator verifies it is drained.')
  }
}
