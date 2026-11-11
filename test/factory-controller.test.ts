import { DatabaseSync } from 'node:sqlite'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  writeFileSync(operations, `import json,pathlib,sys\np=pathlib.Path(sys.argv[2])\na=sys.argv[1]\nif a=='export':\n (p/'candidate.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','baseSha':'${'b'.repeat(40)}'}))\n (p/'candidate.bundle').write_bytes(b'bundle')\n (p/'candidate.patch').write_text('safe patch')\nif a=='verify': (p/'verify.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','passed':True}))\n`)
  writeFileSync(join(f.root, 'publication.py'), `import json,pathlib,sys\np=pathlib.Path(sys.argv[2])\nif sys.argv[1]=='assess': (p/('assessment-'+sys.argv[5]+'.json')).write_text(json.dumps({'decision':'approved','review':{}}))\n`)
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
  await f.factory.tick(); expect(f.factory.store.get(a.id)).toMatchObject({ stage: 'completed', waiting: null }); expect(completed).toBe(1)
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

test('oversized packet blocks review after publication', async () => {
  const comments: string[] = []
  const f = fixture({ comment: async (_, body) => { comments.push(body) } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const operations = join(f.root, 'operations.py')
  writeFileSync(operations, `import json,pathlib,sys
p=pathlib.Path(sys.argv[2])
(p/'candidate.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','baseSha':'${'b'.repeat(40)}'}))
(p/'candidate.bundle').write_bytes(b'bundle')
(p/'candidate.patch').write_text('x'*81000)
(p/'verify.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','passed':True}))
`)
  f.cfg.operationsPath = operations; f.factory.store.transition(a.id, 'verify'); await f.factory.tick()
  writeFileSync(join(f.root, 'attempts', a.id, 'publication.json'), JSON.stringify({ state: 'published', candidateSha: 'a'.repeat(40), pr: 7, ci: { passed: true, source: 'controller' } }))
  await f.factory.tick()
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
  const stopped: string[] = []; const comments: string[] = []
  const f = fixture({ stop: messageId => { stopped.push(messageId) }, comment: async (_, text) => { comments.push(text) } })
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
    expect(f.factory.store.get(a.id).waiting).toContain('worker to stop and drain')
    status = 'exited 0'
    await f.factory.tick(); expect(f.factory.store.get(a.id).stage).toBe('cancelled'); expect(stopped).toEqual(['pending-message'])
    expect(f.factory.store.get(a.id).waiting).toBeNull()
    expect(comments.some(text => text.includes(`factory/${a.id}`) && text.includes('PR'))).toBe(true)
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
  expect(recovered.store.get(a.id).blocked).toBeNull()
})

test('permissions and CI recover without another export or duplicate review, with deduplicated native comments', async () => {
  const comments: string[] = []; let state: 'permissions' | 'ci' | 'ready' = 'permissions'; let published = 0
  const f = fixture({
    comment: async (_, text) => { comments.push(text) },
    publish: async input => { published++; return state === 'permissions' ? { state: 'waiting', reason: 'Grant checks read access in the native GitHub token' } : { state: 'published', pr: 7, url: 'https://github.com/micaelsgarcez/central/pull/7', candidateSha: input.candidateSha, ci: { passed: state === 'ready', checks: [{ name: 'test', state: state === 'ready' ? 'success' : 'pending' }], source: 'controller', observedAt: Date.now() + published }, merged: false, by: null, byType: null } }
  })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const dir = join(f.root, 'attempts', a.id)
  const operations = join(f.root, 'operations.py')
  writeFileSync(operations, `import json,pathlib,sys\np=pathlib.Path(sys.argv[2])\nassert sys.argv[1]=='verify', 'Candidate must never be exported twice'\n(p/'verify.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','passed':True}))`)
  f.cfg.operationsPath = operations
  writeFileSync(join(dir, 'candidate.json'), JSON.stringify({ candidateSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }))
  writeFileSync(join(dir, 'candidate.bundle'), 'bundle')
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
  const evidence = new DatabaseSync(join(f.root, '../factory.sqlite'))
  expect(evidence.prepare("SELECT COUNT(*) AS count FROM evidence WHERE kind='publication.observed'").get()?.count).toBe(3)
  evidence.close()
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


test.each(['skills', 'package'])('prelaunch rejects invalid %s before reserving any native job', async invalid => {
  const comments: string[] = []
  const f = fixture({ assertSkills: () => { if (invalid === 'skills') throw new Error('Required skill disabled') }, comment: async (_, text) => { comments.push(text) } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!
  if (invalid === 'package') {
    const db = new DatabaseSync(join(f.root, '../factory.sqlite'))
    db.prepare('UPDATE rounds SET package_hash=? WHERE attempt_id=? AND round=0').run('f'.repeat(64), a.id); db.close()
  }
  f.cfg.operationsPath = join(f.root, 'operations.py'); writeFileSync(f.cfg.operationsPath, '')
  writeFileSync(join(f.root, 'attempts', a.id, 'prepared.json'), '{}')
  await f.factory.tick()
  expect(f.factory.store.jobs(a.id)).toHaveLength(0); expect(f.launched).toHaveLength(0)
  const reason = invalid === 'skills' ? 'Required skill disabled' : 'package differs'
  expect(f.factory.store.get(a.id).blocked).toContain(reason)
  expect(comments.some(text => text.includes(reason))).toBe(true)
})

test('stray operator control reports a waiting reason and prevents publication', async () => {
  let publications = 0
  const f = fixture({ publish: async () => { publications++; return { state: 'waiting', reason: 'unexpected' } } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; f.factory.store.transition(a.id, 'review')
  writeFileSync(join(f.root, 'attempts', a.id, 'control.json'), '{}')
  await f.factory.tick()
  expect(f.factory.store.get(a.id).waiting).toContain('valid cancel request')
  expect(publications).toBe(0)
})

test('automatic reconciliation polls review every 30 seconds and merge every 120 seconds', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture(); await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
    const a = f.factory.store.active()!; f.factory.store.transition(a.id, 'review')
    const tick = vi.spyOn(f.factory, 'tick').mockResolvedValue()
    f.factory.startTimer()
    await vi.advanceTimersByTimeAsync(60_000); expect(tick).toHaveBeenCalledTimes(2)
    f.factory.store.transition(a.id, 'merge')
    await vi.advanceTimersByTimeAsync(30_000); expect(tick).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(90_000); expect(tick).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_000); expect(tick).toHaveBeenCalledTimes(4)
    f.factory.close()
  } finally { vi.useRealTimers() }
})

function loopOperations(f: ReturnType<typeof fixture>): void {
  const trusted = process.env.TUCANO_FACTORY_OPERATIONS_PATH
  if (trusted) { f.cfg.reviewerAgentId = '7950fa20-855b-42b6-bcc3-4ded989a3f9f'; cpSync(join(trusted, 'controller.py'), join(f.root, 'controller.py')); cpSync(join(trusted, '../review'), join(f.root, '../review'), { recursive: true }) }
  f.cfg.operationsPath = join(f.root, 'operations.py')
  writeFileSync(f.cfg.operationsPath, `import json,pathlib,sys
root=pathlib.Path(sys.argv[2]); n=int(sys.argv[4]); p=root if n==0 else root/'rounds'/str(n)
p.mkdir(parents=True,exist_ok=True)
a=sys.argv[1]; sha=('%040x'%(n+10)); parent=('%040x'%(n+9)) if n else 'b'*40
if a=='seed':
 assert (p/'round.json').exists()
 if not (p/'seed.json').exists(): (p/'seed.json').write_text(json.dumps({'parentSha':parent}))
if a=='export':
 (p/'candidate.json').write_text(json.dumps({'version':2,'candidateSha':sha,'baseSha':'b'*40,'parentSha':parent}))
 (p/'candidate.patch').write_text('patch round '+str(n))
 (p/'candidate.bundle').write_bytes(b'bundle'+str(n).encode())
if a=='verify': (p/'verify.json').write_text(json.dumps({'candidateSha':sha,'passed':True,'commands':[['test']]}))
`)
  writeFileSync(join(f.root, 'publication.py'), `import json,pathlib,sys
root=pathlib.Path(sys.argv[2]); n=int(sys.argv[4]); p=root if n==0 else root/'rounds'/str(n)
if sys.argv[1]=='assess':
 m=json.loads((p/('message-'+sys.argv[5]+'.json')).read_text()); manifest=json.loads((p/'review-manifest.json').read_text())
 try:
  r=json.loads(m['text']); assert r['head_sha']==manifest['head_sha']; assert r['packet_sha256']==manifest['packet_sha256']; assert r['verdict'] in ['approved','rejected']
  out={'decision':r['verdict'],'review':r}
 except Exception: out={'decision':'invalid','reason':'Review must be whole JSON bound to exact packet'}
 (p/('assessment-'+sys.argv[5]+'.json')).write_text(json.dumps(out))
`)
  if (trusted) cpSync(join(trusted, 'publication.py'), join(f.root, 'publication.py'))
  writeFileSync(join(f.root, 'config.json'), JSON.stringify(f.cfg))
}
function published(input: Parameters<Ports['publish']>[0]) {
  return { state: 'published' as const, candidateSha: input.candidateSha, pr: 7, url: 'https://github.com/micaelsgarcez/central/pull/7', ci: { passed: true, source: 'controller' as const, checks: [], observedAt: 1 }, merged: false, by: null, byType: null }
}
async function completeJob(f: ReturnType<typeof fixture>, role: 'build' | 'review', text: string | ((packet: Record<string, unknown>) => string)) {
  const a = f.factory.store.active()!; const job = f.factory.store.jobs(a.id).findLast(j => j.round === a.round && j.role === role && j.state === 'running')!
  expect(job).toBeDefined()
  const messageId = `message-${job.id}`; const agentId = role === 'build' ? f.cfg.executorAgentId : f.cfg.reviewerAgentId
  const turn = f.factory.bind(job.id, agentId, messageId)!; const context = turn.context('task'); turn.delivered(context, nativeProfile)
  const dir = join(f.root, 'attempts', a.id, ...(a.round ? ['rounds', String(a.round)] : []))
  if (role === 'review') await turn.call('factory_read', { path: '@packet' })
  if (a.round && role === 'build') {
    expect(await turn.call('factory_read', { path: '@feedback' })).toContain('rejected')
    await expect(turn.call('factory_delegate', { instruction: 'Explore' })).rejects.toThrow('cannot delegate')
  }
  const completion = { id: messageId, author: { kind: 'agent' as const, id: agentId }, text: typeof text === 'string' ? text : text(JSON.parse(readFileSync(join(dir, 'review-manifest.json'), 'utf8'))), run: { status: 'done' }, usage: [] }
  await f.factory.completed(job.id, completion)
  return { job, completion, turn }
}
const verdict = (decision: 'approved' | 'rejected') => (m: Record<string, unknown>) => JSON.stringify({ head_sha: m.head_sha, packet_sha256: m.packet_sha256, verdict: decision, criteria: [{ id: 'C1', met: decision === 'approved', evidence: 'Observed test receipt' }], findings: decision === 'rejected' ? ['Fix the failing behavior'] : [], limitations: [] })

test('repeated Nina rejections reserve distinct corrections, verify every round and retain one PR until exact approval', async () => {
  const publications: Parameters<Ports['publish']>[0][] = []
  const f = fixture({ publish: async input => { publications.push(input); return published(input) } }); loopOperations(f)
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const root = join(f.root, 'attempts', a.id)
  const original = readFileSync(join(root, 'request.json'), 'utf8')
  writeFileSync(join(root, 'prepared.json'), '{}'); await f.factory.tick()
  for (let round = 0; round < 3; round++) {
    const built = await completeJob(f, 'build', `Build ${round}`)
    const hooks = join(root, ...(round ? ['rounds', String(round)] : []), 'hooks', built.completion.id)
    if (round) {
      expect(existsSync(join(hooks, 'receipt-1.json'))).toBe(false)
      expect(readFileSync(join(hooks, 'data/.ponytail-active'), 'utf8')).toBe('lite')
    }
    writeFileSync(join(hooks, 'data/.ponytail-active'), 'lite')
    await f.factory.tick()
    expect(f.factory.store.get(a.id)).toMatchObject({ round, stage: 'review', blocked: null })
    const { job, completion, turn } = await completeJob(f, 'review', verdict(round < 2 ? 'rejected' : 'approved'))
    await f.factory.completed(job.id, completion)
    await expect(turn.call('factory_read', { path: '@packet' })).rejects.toThrow('Stale')
    if (round < 2) { expect(f.factory.store.get(a.id)).toMatchObject({ round: round + 1, stage: 'build' }); await f.factory.tick() }
  }
  expect(f.factory.store.get(a.id)).toMatchObject({ stage: 'merge', round: 2, pr: 7 })
  expect(f.launched.filter(j => j.role === 'executor')).toHaveLength(3)
  expect(f.launched.filter(j => j.role === 'reviewer')).toHaveLength(3)
  expect(new Set(f.launched.map(j => j.requestId)).size).toBe(6)
  expect(publications.map(p => p.round)).toEqual([0, 1, 2])
  expect(publications.slice(1).every(p => p.expectedPr === 7 && p.expectedHead && p.attemptDir === root)).toBe(true)
  expect(readFileSync(join(root, 'request.json'), 'utf8')).toBe(original)
  expect(readFileSync(join(root, 'candidate.patch'), 'utf8')).toBe('patch round 0')
  expect(readFileSync(join(root, 'rounds/2', `review-${f.factory.store.get(a.id).candidateSha}.md`), 'utf8')).toContain('Artifact SHA256')
})

test.each([false, true])('Nina gets one format repair on the same packet; second invalid=%s blocks precisely', async twiceInvalid => {
  const comments: string[] = []
  const f = fixture({ comment: async (_, text) => { comments.push(text) }, publish: async input => published(input) }); loopOperations(f)
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const dir = join(f.root, 'attempts', a.id)
  f.factory.store.transition(a.id, 'verify'); await f.factory.tick(); await f.factory.tick()
  const packet = readFileSync(join(dir, `review-${f.factory.store.get(a.id).candidateSha}.md`), 'utf8')
  await completeJob(f, 'review', '```json invalid```'); await f.factory.tick()
  expect(readFileSync(join(dir, `review-${f.factory.store.get(a.id).candidateSha}.md`), 'utf8')).toBe(packet)
  await completeJob(f, 'review', twiceInvalid ? 'Still invalid' : verdict('approved'))
  expect(f.launched).toHaveLength(2)
  expect(f.factory.store.get(a.id).round).toBe(0)
  if (twiceInvalid) { expect(f.factory.store.get(a.id).blocked).toContain('invalid after one repair:'); expect(comments.at(-1)).toContain('Factory bloqueada: Nina invalid') }
  else expect(f.factory.store.get(a.id).stage).toBe('merge')
})

test('pause preserves reservation and replays the same request after resume; native failure blocks', async () => {
  let paused = true; let waiting = false
  const requests: string[] = []; const comments: string[] = []
  const f = fixture({ comment: async (_, text) => { comments.push(text) }, paused: () => paused, launch: async input => { requests.push(input.requestId); if (waiting) return { waiting: 'Native agents are paused' }; throw new Error('native budget exhausted') } }); loopOperations(f)
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; writeFileSync(join(f.root, 'attempts', a.id, 'prepared.json'), '{}')
  await f.factory.tick(); expect(f.factory.store.jobs(a.id)).toHaveLength(1)
  paused = false; waiting = true; await f.factory.tick()
  expect(f.factory.store.jobs(a.id)).toHaveLength(1); expect(f.factory.store.get(a.id).blocked).toBeNull()
  waiting = false; await f.factory.tick()
  expect(requests).toHaveLength(2); expect(requests[0]).toBe(requests[1]); expect(f.factory.store.get(a.id).blocked).toContain('budget exhausted')
  expect(comments.some(text => text.includes('Factory bloqueada') && text.includes('budget exhausted'))).toBe(true)
})

test('restart consumes durable unassessed review completion and replays the reserved correction request', async () => {
  const f = fixture({ publish: async input => published(input) }); loopOperations(f)
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const dir = join(f.root, 'attempts', a.id)
  f.factory.store.transition(a.id, 'verify'); await f.factory.tick(); await f.factory.tick()
  const review = f.factory.store.jobs(a.id).findLast(j => j.role === 'review')!
  const messageId = 'durable-review'; const turn = f.factory.bind(review.id, f.cfg.reviewerAgentId, messageId)!
  const context = turn.context('review'); turn.delivered(context, nativeProfile); await turn.call('factory_read', { path: '@packet' })
  const completion = { id: messageId, author: { kind: 'agent', id: f.cfg.reviewerAgentId }, run: { status: 'done' }, usage: [], text: verdict('rejected')(JSON.parse(readFileSync(join(dir, 'review-manifest.json'), 'utf8'))) }
  writeFileSync(join(dir, `message-${messageId}.json`), JSON.stringify(completion))
  f.factory.close()
  const requests: string[] = []
  const ports: Ports = { ...testPorts(f.root), publish: async input => published(input), launch: async input => { requests.push(input.requestId); return { waiting: 'paused during native setup' } }, createTask: async () => { throw new Error('Cannot recreate') }, task: async () => { throw new Error('Cannot recreate') }, stop: () => {}, completeTask: async () => {}, comment: async () => {} }
  const recovered = new Factory(f.root, f.cfg, ports); cleanups.push(() => recovered.close())
  expect(recovered.store.get(a.id).blocked).toBeNull()
  await recovered.tick()
  expect(recovered.store.get(a.id)).toMatchObject({ round: 1, stage: 'build', blocked: null })
  const reserved = recovered.store.jobs(a.id).find(j => j.round === 1)!
  expect(reserved.state).toBe('reserved')
  await recovered.tick(); recovered.close()
  const again = new Factory(f.root, f.cfg, ports); cleanups.push(() => again.close())
  await again.tick(); await again.tick()
  expect(requests).toEqual([reserved.id, reserved.id, reserved.id])
  expect(again.store.jobs(a.id)).toHaveLength(2)
  expect(again.store.get(a.id).blocked).toBeNull()
  expect(JSON.parse(readFileSync(join(dir, 'rounds/1/round.json'), 'utf8'))).toMatchObject({ previousRound: 0, round: 1, origin: { jobId: review.id } })
})

test('owner pilot adoption preserves original request and package, starts same-candidate verification only once', async () => {
  const f = fixture(); await f.factory.start({ title: 'Legacy', instruction: 'Original manual publication policy', criteria: ['Original acceptance'] }, f.human)
  const a = f.factory.store.active()!; const candidateSha = 'a'.repeat(40)
  f.factory.store.candidate(a.id, candidateSha); f.factory.store.transition(a.id, 'merge', 'Malformed legacy review')
  const request = readFileSync(join(f.root, 'attempts', a.id, 'request.json'), 'utf8')
  const input = { attemptId: a.id, ownerId: f.cfg.ownerId, candidateSha, packageHash: 'f'.repeat(64), instruction: 'Automatic PR; human merge', criteria: [{ id: 'C1', description: 'Automatic PR; human merge' }], origin: { kind: 'owner-amendment', ownerId: f.cfg.ownerId, reason: 'Supersedes manual publication prohibition', source: 'owner request', at: 1 } }
  expect(() => f.factory.store.adoptPilot({ ...input, ownerId: 'outsider' })).toThrow('requires')
  expect(() => f.factory.store.adoptPilot(input)).toThrow('requires')
  expect(f.factory.store.get(a.id)).toMatchObject({ round: 0, stage: 'merge' })
  f.factory.store.publicationPr(a.id, 7); f.factory.store.adoptPilot(input)
  expect(f.factory.store.get(a.id)).toMatchObject({ round: 1, stage: 'verify', candidateSha, packageHash: input.packageHash, instruction: input.instruction, criteria: input.criteria, pr: 7 })
  expect(f.factory.store.round(a.id, 0)).toMatchObject({ instruction: a.instruction, packageHash: a.packageHash, candidateSha })
  expect(f.factory.store.jobs(a.id)).toHaveLength(0)
  expect(readFileSync(join(f.root, 'attempts', a.id, 'request.json'), 'utf8')).toBe(request)
  expect(() => f.factory.store.adoptPilot(input)).toThrow('requires')
})

test('reserved round0 helper restarts with its original instructions and no second helper request', async () => {
  let waiting = true; const requests: Parameters<Ports['launch']>[0][] = []
  const f = fixture({ launch: async input => { requests.push(input); return waiting ? { waiting: 'Native agents are paused' } : { id: input.requestId } } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; f.factory.store.transition(a.id, 'build')
  const build = f.factory.store.newJob(a.id, 'build'); f.factory.store.launched(build.id, 'execution')
  const turn = f.factory.bind(build.id, f.cfg.executorAgentId, 'build-message')!
  const context = turn.context('build'); turn.delivered(context, nativeProfile)
  await turn.call('factory_delegate', { instruction: 'Inspect ONLY the authentication caller' })
  await f.factory.completed(build.id, { id: 'build-message', author: { kind: 'agent', id: f.cfg.executorAgentId }, run: { status: 'done' }, text: 'Waiting for helper', usage: [] })
  f.factory.close(); waiting = false
  const recovered = new Factory(f.root, f.cfg, { ...testPorts(f.root), launch: async input => { requests.push(input); return { id: input.requestId } }, createTask: async () => { throw new Error('Cannot create') }, task: async () => { throw new Error('Cannot create') }, stop: () => {}, completeTask: async () => {}, comment: async () => {} }); cleanups.push(() => recovered.close())
  await recovered.tick()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0]); expect(requests[1]?.instructions).toBe('Inspect ONLY the authentication caller')
  expect(recovered.store.jobs(a.id).filter(j => j.role === 'helper')).toHaveLength(1)
})

test('pause between helper completion and continuation resumes once with durable helper findings', async () => {
  let paused = false
  const f = fixture({ paused: () => paused })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; f.factory.store.transition(a.id, 'build')
  const build = f.factory.store.newJob(a.id, 'build'); f.factory.store.launched(build.id, 'build')
  const turn = f.factory.bind(build.id, f.cfg.executorAgentId, 'build-message')!; turn.delivered(turn.context('build'), nativeProfile)
  await turn.call('factory_delegate', { instruction: 'Explore' })
  await f.factory.completed(build.id, { id: 'build-message', author: { kind: 'agent', id: f.cfg.executorAgentId }, run: { status: 'done' }, text: 'Waiting', usage: [] })
  const helper = f.factory.store.jobs(a.id).find(j => j.role === 'helper')!
  const child = f.factory.bind(helper.id, f.cfg.helperAgentId, 'helper-message')!; child.delivered(child.context('helper'), nativeProfile)
  paused = true
  await f.factory.completed(helper.id, { id: 'helper-message', author: { kind: 'agent', id: f.cfg.helperAgentId }, run: { status: 'done' }, text: 'Durable helper finding', usage: [] })
  expect(f.launched).toHaveLength(1)
  paused = false; await f.factory.tick(); await f.factory.tick()
  expect(f.launched).toHaveLength(2); expect(f.launched[1]?.instructions).toContain('Durable helper finding')
})

test('delegation while paused durably queues the helper and clears waiting after resume', async () => {
  let paused = false
  const f = fixture({ paused: () => paused })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; f.factory.store.transition(a.id, 'build')
  const build = f.factory.store.newJob(a.id, 'build'); f.factory.store.launched(build.id, 'build')
  const turn = f.factory.bind(build.id, f.cfg.executorAgentId, 'build-message')!; turn.delivered(turn.context('build'), nativeProfile)
  paused = true
  expect(await turn.call('factory_delegate', { instruction: 'Inspect authentication callers' })).toContain('queued')
  const helper = f.factory.store.jobs(a.id).find(j => j.role === 'helper')!
  expect(helper).toMatchObject({ state: 'reserved', instructions: 'Inspect authentication callers' })
  expect(f.launched).toHaveLength(0)
  await f.factory.completed(build.id, { id: 'build-message', author: { kind: 'agent', id: f.cfg.executorAgentId }, run: { status: 'done' }, text: 'Waiting', usage: [] })
  expect(f.factory.store.get(a.id).waiting).toContain('paused')
  paused = false; await f.factory.tick(); await f.factory.tick()
  expect(f.launched).toHaveLength(1); expect(f.launched[0]?.requestId).toBe(helper.id)
  expect(f.factory.store.get(a.id)).toMatchObject({ waiting: null, blocked: null, stage: 'build' })
})
