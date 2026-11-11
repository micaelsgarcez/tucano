import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as childProcess from 'node:child_process'
import { afterEach, expect, test, vi } from 'vitest'
import { Factory } from '../src/factory/controller'
import { factoryConfig, nativeProfile, testPorts } from './helpers/factory'
import type { Ports } from '../src/factory/types'
vi.mock('node:child_process', { spy: true })
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture(extra: Partial<Ports> = {}) {
  const outer = mkdtempSync(join(tmpdir(), 'factory-controller-')); const root = join(outer, 'factory'); mkdirSync(root); cleanups.push(() => rmSync(outer, { recursive: true, force: true }))
  const cfg = factoryConfig(root); let created = 0; const launched: Parameters<Ports['launch']>[0][] = []
  const factory = new Factory(root, cfg, { ...testPorts(root), createTask: async () => { created++; return { id: '66666666-6666-4666-8666-666666666666' } }, task: async id => ({ id, projectId: cfg.projectId, title: 'Bug', description: 'Fix' }), launch: async input => { launched.push(input); return { id: input.requestId } }, stop: () => {}, completeTask: async () => {}, comment: async () => {}, ...extra }); cleanups.push(() => factory.close())
  const human = { personId: cfg.ownerId, messageId: 'human-message', conversationId: 'dm', prompt: 'Fix the bug' }
  return { root, cfg, factory, human, launched, created: () => created }
}
test('owner intake replay creates one native task, single writer blocks another instruction, crash marker never recreates', async () => {
  const f = fixture(); const input = { title: 'Fix', instruction: 'Make correct', criteria: ['Works'] }
  await f.factory.start(input, f.human); await f.factory.start(input, f.human)
  expect(f.created()).toBe(1)
  await expect(f.factory.start(input, { ...f.human, messageId: 'second' })).rejects.toThrow()
  await expect(f.factory.start(input, { ...f.human, personId: 'wrong' })).rejects.toThrow('owner')
  const failed = fixture({ createTask: async () => { throw new Error('crashed after native create') } })
  await expect(failed.factory.start(input, failed.human)).rejects.toThrow('crashed')
  expect(JSON.parse(await failed.factory.start(input, failed.human)).blocked).toContain('crashed')
  expect(existsSync(join(failed.root, 'attempts', failed.factory.store.active()!.id, 'request.json'))).toBe(true)
})
test('readonly helper cannot write, stale writer loses dispatch, helpers return immediately and resume exactly once', async () => {
  const f = fixture(); await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; f.factory.store.transition(a.id, 'build')
  const build = f.factory.store.newJob(a.id, 'build'); f.factory.store.launched(build.id, 'exec-build')
  const turn = f.factory.bind(build.id, f.cfg.executorAgentId, 'build-message')!
  turn.context('Implement'); turn.delivered('EXACT PINNED HOOK CONTEXT', nativeProfile)
  expect(await turn.call('factory_delegate', { instruction: 'Explore the relevant source' })).toContain('queued')
  expect(f.launched).toHaveLength(1)
  const helper = f.factory.store.jobs(a.id).find(j => j.role === 'helper')!
  const readonly = f.factory.bind(helper.id, f.cfg.helperAgentId, 'helper-message')!
  readonly.context('Child'); readonly.delivered('EXACT PINNED CHILD CONTEXT', nativeProfile)
  expect(readonly.tools.map(t => t.name)).toEqual(['ler_skill', 'factory_read'])
  await expect(readonly.call('bash', { command: 'echo unsafe' })).rejects.toThrow('Readonly')
  await f.factory.completed(build.id, { id: 'build-message', author: { kind: 'agent', id: f.cfg.executorAgentId }, text: 'Waiting', run: { status: 'done' }, usage: [] })
  expect(f.launched).toHaveLength(1)
  await expect(turn.call('bash', { command: 'echo stale' })).rejects.toThrow('Stale')
  await f.factory.completed(helper.id, { id: 'helper-message', author: { kind: 'agent', id: f.cfg.helperAgentId }, text: 'Relevant source found', run: { status: 'done' }, usage: [] })
  expect(f.launched).toHaveLength(2)
  await f.factory.completed(helper.id, { id: 'helper-message', author: { kind: 'agent', id: f.cfg.helperAgentId }, text: 'Duplicate', run: { status: 'done' }, usage: [] })
  expect(f.launched).toHaveLength(2)
  expect(f.launched[1]?.instructions).toContain('Relevant source found')
})
test('changed candidate publication and missing gates block instead of advancing', async () => {
  const f = fixture(); await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; f.factory.store.candidate(a.id, 'a'.repeat(40)); f.factory.store.transition(a.id, 'review')
  const dir = join(f.root, 'attempts', a.id)
  writeFileSync(join(dir, 'candidate.json'), JSON.stringify({ candidateSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }))
  writeFileSync(join(dir, 'publication.json'), JSON.stringify({ state: 'published', candidateSha: 'b'.repeat(40), pr: 1, ci: { passed: true, source: 'controller' } }))
  await f.factory.tick(); expect(f.factory.store.get(a.id).blocked).toContain('exact candidate')
  expect(f.launched).toHaveLength(0)
})
test('restart preserves ownership and requires explicit operator recovery', async () => {
  const f = fixture(); await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const j = f.factory.store.newJob(a.id, 'build'); f.factory.store.launched(j.id, 'execution')
  f.factory.store.recover()
  expect(f.factory.store.active()?.id).toBe(a.id)
  expect(f.factory.store.get(a.id).blocked).toContain('restart')
  expect(() => f.factory.bind(j.id, f.cfg.executorAgentId, 'new')).toThrow('authorized')
})
test.each([true, false])('passing candidate automatically publishes, packet read=%s and exact-head human gate', async readsPacket => {
  let completed = 0; const comments: string[] = []
  const f = fixture({ completeTask: async () => { completed++ }, comment: async (_, text) => { comments.push(text) } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const dir = join(f.root, 'attempts', a.id)
  const operations = join(f.root, 'operations.py')
  writeFileSync(operations, `import json,pathlib,sys\np=pathlib.Path(sys.argv[2])\na=sys.argv[1]\nif a=='export':\n (p/'candidate.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','baseSha':'${'b'.repeat(40)}'}))\n (p/'candidate.patch').write_text('safe patch')\nif a=='verify': (p/'verify.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','passed':True}))\n`)
  writeFileSync(join(f.root, 'publication.py'), '')
  f.cfg.operationsPath = operations
  f.factory.store.transition(a.id, 'verify'); await f.factory.tick()
  expect(f.factory.store.get(a.id).stage).toBe('review'); expect(f.launched).toHaveLength(0); expect(completed).toBe(0)
  writeFileSync(join(dir, 'publication.json'), JSON.stringify({ state: 'published', candidateSha: 'a'.repeat(40), pr: 7, ci: { passed: false, source: 'controller' } }))
  await f.factory.tick(); expect(f.factory.store.get(a.id).blocked).toBeNull(); expect(f.launched).toHaveLength(0)
  writeFileSync(join(dir, 'publication.json'), JSON.stringify({ state: 'published', candidateSha: 'a'.repeat(40), pr: 7, ci: { passed: true, source: 'controller' } }))
  await f.factory.tick(); expect(f.launched).toHaveLength(1)
  const job = f.factory.store.jobs(a.id).find(j => j.role === 'review')!
  const turn = f.factory.bind(job.id, f.cfg.reviewerAgentId, 'review-message')!
  expect(turn.tools.map(t => t.name)).toEqual(['ler_skill', 'factory_read'])
  const context = turn.context('Review'); turn.delivered(context, nativeProfile)
  if (readsPacket) { const packet = await turn.call('factory_read', { path: '@packet' }); expect(packet).toContain('safe patch') }
  await f.factory.completed(job.id, { id: 'review-message', author: { kind: 'agent', id: f.cfg.reviewerAgentId }, text: 'review recorded', run: { status: 'done' }, usage: [] })
  if (!readsPacket) { expect(f.factory.store.get(a.id).blocked).toContain('did not read'); expect(completed).toBe(0); return }
  expect(f.factory.store.get(a.id).stage).toBe('merge'); expect(completed).toBe(0)
  writeFileSync(join(dir, 'publication.json'), JSON.stringify({ state: 'published', candidateSha: 'a'.repeat(40), pr: 7, ci: { passed: false, source: 'controller' } }))
  await f.factory.tick(); expect(f.factory.store.get(a.id).blocked).toBeNull(); expect(completed).toBe(0)
  writeFileSync(join(dir, 'publication.json'), JSON.stringify({ state: 'published', candidateSha: 'a'.repeat(40), pr: 7, ci: { passed: true, source: 'controller' } }))
  writeFileSync(join(dir, 'gate.json'), JSON.stringify({ candidateSha: 'a'.repeat(40), reviewMessageId: 'review-message', ciPassed: true, reviewPassed: true, merged: false }))
  await f.factory.tick(); await f.factory.tick()
  expect(comments.filter(c => c.includes('Waiting for merge'))).toHaveLength(1)
  writeFileSync(join(dir, 'gate.json'), JSON.stringify({ state: 'published', candidateSha: 'a'.repeat(40), reviewMessageId: 'review-message', ciPassed: true, reviewPassed: true, merged: true, mergedByType: 'User', mergedBy: 'owner' }))
  await f.factory.tick(); expect(f.factory.store.get(a.id).stage).toBe('completed'); expect(completed).toBe(1)
})
test('failed clean verification preserves the reservation and never dispatches review', async () => {
  const f = fixture(); await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const operations = join(f.root, 'operations.py')
  writeFileSync(operations, `import json,pathlib,sys\np=pathlib.Path(sys.argv[2])\n(p/'candidate.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','baseSha':'${'b'.repeat(40)}'}))\n(p/'verify.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','passed':False}))\n`)
  f.cfg.operationsPath = operations; f.factory.store.transition(a.id, 'verify'); await f.factory.tick()
  expect(f.factory.store.active()?.id).toBe(a.id); expect(f.factory.store.get(a.id).blocked).toContain('did not pass'); expect(f.launched).toHaveLength(0)
})
test.each([false, true])('cancelled pending execution cannot reopen the attempt (new attempt=%s)', async newAttempt => {
  const f = fixture(); const input = { title: 'Fix', instruction: 'Fix', criteria: ['Works'] }
  await f.factory.start(input, f.human)
  const a = f.factory.store.active()!; f.factory.store.transition(a.id, 'build')
  const job = f.factory.store.newJob(a.id, 'build'); f.factory.store.launched(job.id, 'execution')
  f.factory.bind(job.id, f.cfg.executorAgentId, 'pending-message')
  f.factory.store.transition(a.id, 'cancelled')
  if (newAttempt) await f.factory.start(input, { ...f.human, messageId: 'new-instruction' })
  await f.factory.completed(job.id, { id: 'pending-message', author: { kind: 'agent', id: f.cfg.executorAgentId }, text: 'late completion', run: { status: 'done' }, usage: [] })
  expect(f.factory.store.get(a.id).stage).toBe('cancelled'); expect(f.launched).toHaveLength(0)
  expect(f.factory.store.active()?.stage).toBe(newAttempt ? 'prepare' : undefined)
})
test('native launch result cannot resurrect a job that already completed', async () => {
  const f = fixture(); await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const job = f.factory.store.newJob(a.id, 'build')
  f.factory.store.finish(job.id, 'done', 'fast completion')
  f.factory.store.launched(job.id, 'execution-after-completion')
  expect(f.factory.store.job(job.id)).toMatchObject({ state: 'done', executionId: 'execution-after-completion' })
})

test('oversized packet blocks before publishing', async () => {
  const comments: string[] = []
  const f = fixture({ comment: async (_, body) => { comments.push(body) } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const operations = join(f.root, 'operations.py')
  writeFileSync(operations, `import json,pathlib,sys
p=pathlib.Path(sys.argv[2])
(p/'candidate.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','baseSha':'${'b'.repeat(40)}'}))
(p/'candidate.patch').write_text('x'*31000)
(p/'verify.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','passed':True}))
`)
  f.cfg.operationsPath = operations; f.factory.store.transition(a.id, 'verify'); await f.factory.tick()
  expect(f.factory.store.get(a.id).blocked).toContain('packet limit')
  expect(comments.some(c => c.includes('Publique manualmente'))).toBe(false)
})
test('helper launch failure blocks visibly instead of leaving a reserved job hanging', async () => {
  const f = fixture({ launch: async () => { throw new Error('native execution unavailable') } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; f.factory.store.transition(a.id, 'build')
  const job = f.factory.store.newJob(a.id, 'build'); f.factory.store.launched(job.id, 'execution')
  const turn = f.factory.bind(job.id, f.cfg.executorAgentId, 'message')!
  await expect(turn.call('factory_delegate', { instruction: 'Explore' })).rejects.toThrow('native execution unavailable')
  expect(f.factory.store.get(a.id).blocked).toContain('native execution unavailable')
  expect(f.factory.store.jobs(a.id).find(j => j.role === 'helper')?.state).toBe('failed')
})

test('operator control cancellation waits for observed drainage, stops native runs and preserves evidence', async () => {
  const stopped: string[] = []
  const f = fixture({ stop: messageId => { stopped.push(messageId) } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; f.factory.store.transition(a.id, 'build')
  const job = f.factory.store.newJob(a.id, 'build'); f.factory.store.launched(job.id, 'execution')
  f.factory.bind(job.id, f.cfg.executorAgentId, 'pending-message')
  const { spawn } = await vi.importActual<typeof childProcess>('node:child_process')
  const inspect = vi.spyOn(childProcess, 'spawn')
  let status = 'running 42'
  inspect.mockImplementation((executable, args, options) => {
    expect(executable).toBe('docker')
    expect(args).toEqual(['inspect', '-f', '{{.State.Status}} {{.State.Pid}}', f.cfg.container])
    return spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(status)})`], options)
  })
  try {
    writeFileSync(join(f.root, 'attempts', a.id, 'control.json'), JSON.stringify({ action: 'cancel', attemptId: a.id, observedDrained: true }))
    await f.factory.tick(); expect(f.factory.store.active()?.id).toBe(a.id); expect(stopped).toEqual([])
    status = 'exited 0'
    await f.factory.tick(); expect(f.factory.store.get(a.id).stage).toBe('cancelled'); expect(stopped).toEqual(['pending-message'])
    await f.factory.completed(job.id, { id: 'pending-message', author: { kind: 'agent', id: f.cfg.executorAgentId }, text: 'late', run: { status: 'done' }, usage: [] })
    expect(f.factory.store.get(a.id).stage).toBe('cancelled')
    expect(existsSync(join(f.root, 'attempts', a.id, 'message-pending-message.json'))).toBe(true)
  } finally { inspect.mockRestore() }
})
test('restart reconstructs the cancellation request after reserve-to-file crash and blocks an interrupted build gap', async () => {
  const f = fixture()
  const a = f.factory.store.reserve({ requestKey: 'crashed-before-request-file', taskId: '', requesterId: f.cfg.ownerId, title: 'Fix', instruction: 'Fix', humanPrompt: 'Fix', criteria: [{ id: 'C1', description: 'Works' }], createdAt: Date.now(), packageHash: f.cfg.packageHash })
  f.factory.close()
  const fail = async (): Promise<never> => { throw new Error('No work may be recreated during recovery') }
  const recovered = new Factory(f.root, f.cfg, { ...testPorts(f.root), createTask: fail, task: fail, launch: fail, stop: () => {}, completeTask: async () => {}, comment: async () => {} }); cleanups.push(() => recovered.close())
  expect(existsSync(join(f.root, 'attempts', a.id, 'request.json'))).toBe(true)
  expect(recovered.store.get(a.id).blocked).toContain('Task creation interrupted')
  recovered.store.bindTask(a.id, '66666666-6666-4666-8666-666666666666')
  recovered.store.transition(a.id, 'build'); recovered.store.recover()
  expect(recovered.store.get(a.id).blocked).toContain('restart')
})

test('permissions and CI recover without another export or duplicate review, with deduplicated native comments', async () => {
  const comments: string[] = []; let state: 'permissions' | 'ci' | 'ready' = 'permissions'; let published = 0
  const f = fixture({
    comment: async (_, text) => { comments.push(text) },
    publish: async input => { published++; return state === 'permissions' ? { state: 'waiting', reason: 'Grant checks read access in the native GitHub token' } : { state: 'published', pr: 7, url: 'https://github.com/micaelsgarcez/central/pull/7', candidateSha: input.candidateSha, ci: { passed: state === 'ready', checks: [{ name: 'test', state: state === 'ready' ? 'success' : 'pending' }], source: 'controller', observedAt: Date.now() }, merged: false, by: null, byType: null } }
  })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const dir = join(f.root, 'attempts', a.id)
  const operations = join(f.root, 'operations.py')
  writeFileSync(operations, `import json,pathlib,sys\np=pathlib.Path(sys.argv[2])\nassert sys.argv[1]=='verify', 'Candidate must never be exported twice'\n(p/'verify.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','passed':True}))`)
  f.cfg.operationsPath = operations
  writeFileSync(join(dir, 'candidate.json'), JSON.stringify({ candidateSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }))
  writeFileSync(join(dir, 'candidate.patch'), 'original candidate bytes')
  f.factory.store.transition(a.id, 'verify'); await f.factory.tick()
  expect(f.factory.store.get(a.id).stage).toBe('review')
  await f.factory.tick(); await f.factory.tick()
  expect(f.factory.store.get(a.id)).toMatchObject({ blocked: null, waiting: 'Grant checks read access in the native GitHub token' })
  expect(comments.filter(c => c.includes('Grant checks'))).toHaveLength(1)
  state = 'ci'; await f.factory.tick(); await f.factory.tick()
  expect(comments.filter(c => c.includes('/pull/7'))).toHaveLength(1)
  expect(f.launched).toHaveLength(0)
  state = 'ready'; await f.factory.tick(); await f.factory.tick()
  expect(f.launched).toHaveLength(1); expect(published).toBe(6)
  expect(f.factory.store.get(a.id)).toMatchObject({ blocked: null, waiting: null })
  expect(readFileSync(join(dir, 'candidate.patch'), 'utf8')).toBe('original candidate bytes')
})

test('native skill revocation denies binding, hook invocation, and a previously bound privileged dispatch', async () => {
  let active = true
  const f = fixture({ assertSkills: () => { if (!active) throw new Error('Pinned skills not assigned') } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; f.factory.store.transition(a.id, 'build')
  const j = f.factory.store.newJob(a.id, 'build')
  const turn = f.factory.bind(j.id, f.cfg.executorAgentId, 'message')!
  active = false
  expect(() => turn.context('Fix')).toThrow('not assigned')
  await expect(turn.call('factory_delegate', { instruction: 'Explore' })).rejects.toThrow('not assigned')
  expect(() => f.factory.bind(j.id, f.cfg.executorAgentId, 'message')).toThrow('not assigned')
  expect(f.launched).toHaveLength(0)
})

test('a pending publication is ignored after cancellation', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const f = fixture({ publish: async input => { await pending; return { state: 'published', candidateSha: input.candidateSha, pr: 7, url: 'https://github.com/micaelsgarcez/central/pull/7', ci: { passed: true, source: 'controller', checks: [], observedAt: Date.now() }, merged: false, by: null, byType: null } } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const dir = join(f.root, 'attempts', a.id)
  f.factory.store.candidate(a.id, 'a'.repeat(40)); f.factory.store.transition(a.id, 'review')
  writeFileSync(join(dir, 'candidate.json'), JSON.stringify({ candidateSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }))
  const ticking = f.factory.tick()
  f.factory.store.transition(a.id, 'cancelled'); release(); await ticking
  expect(f.launched).toHaveLength(0)
  expect(existsSync(join(dir, 'publication.json'))).toBe(false)
})

test('recovery retains a completed review without launching Nina twice', async () => {
  const f = fixture(); await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const job = f.factory.store.newJob(a.id, 'review')
  f.factory.store.finish(job.id, 'done', 'review recorded'); f.factory.store.transition(a.id, 'merge')
  f.factory.store.recover()
  expect(f.factory.store.get(a.id)).toMatchObject({ stage: 'merge', blocked: null })
  expect(f.factory.store.jobs(a.id)).toHaveLength(1)
})


test('legacy database migration preserves the candidate and requires exact explicit adoption', async () => {
  const f = fixture(); await f.factory.start({ title: 'Legacy', instruction: 'Review existing bytes', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const candidateSha = 'a'.repeat(40)
  f.factory.store.candidate(a.id, candidateSha); f.factory.store.transition(a.id, 'review')
  const job = f.factory.store.newJob(a.id, 'build'); f.factory.store.finish(job.id, 'done', 'Original build')
  const dir = join(f.root, 'attempts', a.id)
  writeFileSync(join(dir, 'candidate.json'), JSON.stringify({ candidateSha, baseSha: 'b'.repeat(40) }))
  f.factory.close()
  const legacy = new DatabaseSync(join(f.root, '../factory.sqlite'))
  legacy.exec('ALTER TABLE attempts DROP COLUMN waiting; ALTER TABLE attempts DROP COLUMN publish_authorized; ALTER TABLE jobs DROP COLUMN profile; PRAGMA user_version=1')
  legacy.close()
  let publications = 0
  const recovered = new Factory(f.root, f.cfg, { ...testPorts(f.root), publish: async () => { publications++; return { state: 'waiting', reason: 'Permissions pending' } }, createTask: async () => { throw new Error('Must not recreate') }, task: async () => { throw new Error('Must not recreate') }, launch: async () => { throw new Error('Must not rerun build') }, stop: () => {}, completeTask: async () => {}, comment: async () => {} })
  cleanups.push(() => recovered.close())
  expect(recovered.store.get(a.id)).toMatchObject({ candidateSha, stage: 'review', blocked: null, publishAuthorized: false, waiting: null })
  expect(recovered.store.job(job.id)).toMatchObject({ report: 'Original build', profile: null })
  await recovered.tick(); expect(publications).toBe(0)
  expect(recovered.store.get(a.id).waiting).toContain('explicit owner adoption')
  f.cfg.publication.adoptAttempts = [{ attemptId: a.id, candidateSha: 'b'.repeat(40) }]
  await recovered.tick(); expect(publications).toBe(0)
  f.cfg.publication.adoptAttempts = [{ attemptId: a.id, candidateSha }]
  await recovered.tick(); expect(publications).toBe(1)
  expect(recovered.store.get(a.id)).toMatchObject({ publishAuthorized: true, waiting: 'Permissions pending', candidateSha })
})
