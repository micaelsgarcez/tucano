import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Factory } from '../src/factory/controller'
import { factoryConfig } from './helpers/factory'
import type { Ports } from '../src/factory/types'
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture(extra: Partial<Ports> = {}) {
  const outer = mkdtempSync(join(tmpdir(), 'factory-controller-')); const root = join(outer, 'factory'); mkdirSync(root); cleanups.push(() => rmSync(outer, { recursive: true, force: true }))
  const cfg = factoryConfig(root); let created = 0; const launched: Parameters<Ports['launch']>[0][] = []
  const factory = new Factory(root, cfg, { createTask: async () => { created++; return { id: '66666666-6666-4666-8666-666666666666' } }, task: async id => ({ id, projectId: cfg.projectId, title: 'Bug', description: 'Fix' }), launch: async input => { launched.push(input); return { id: input.requestId } }, stop: () => {}, completeTask: async () => {}, comment: async () => {}, ...extra }); cleanups.push(() => factory.close())
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
  turn.context('Implement'); turn.delivered('EXACT PINNED HOOK CONTEXT')
  expect(await turn.call('factory_delegate', { instruction: 'Explore the relevant source' })).toContain('queued')
  expect(f.launched).toHaveLength(1)
  const helper = f.factory.store.jobs(a.id).find(j => j.role === 'helper')!
  const readonly = f.factory.bind(helper.id, f.cfg.helperAgentId, 'helper-message')!
  readonly.context('Child'); readonly.delivered('EXACT PINNED CHILD CONTEXT')
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
  writeFileSync(join(dir, 'publication.json'), JSON.stringify({ candidateSha: 'b'.repeat(40), pr: 1, ci: { passed: true, source: 'gh' } }))
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
test.each([true, false])('passing candidate requires manual publication, packet read=%s and exact-head human gate', async readsPacket => {
  let completed = 0
  const f = fixture({ completeTask: async () => { completed++ } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const dir = join(f.root, 'attempts', a.id)
  const operations = join(f.root, 'operations.py')
  writeFileSync(operations, `import json,pathlib,sys\np=pathlib.Path(sys.argv[2])\na=sys.argv[1]\nif a=='export':\n (p/'candidate.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}'}))\n (p/'candidate.patch').write_text('safe patch')\nif a=='verify': (p/'verify.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','passed':True}))\n`)
  f.cfg.operationsPath = operations
  f.factory.store.transition(a.id, 'verify'); await f.factory.tick()
  expect(f.factory.store.get(a.id).stage).toBe('review'); expect(f.launched).toHaveLength(0); expect(completed).toBe(0)
  writeFileSync(join(dir, 'publication.json'), JSON.stringify({ candidateSha: 'a'.repeat(40), pr: 7, ci: { passed: false, source: 'gh' } }))
  await f.factory.tick(); expect(f.factory.store.get(a.id).blocked).toBeNull(); expect(f.launched).toHaveLength(0)
  writeFileSync(join(dir, 'publication.json'), JSON.stringify({ candidateSha: 'a'.repeat(40), pr: 7, ci: { passed: true, source: 'gh' } }))
  await f.factory.tick(); expect(f.launched).toHaveLength(1)
  const job = f.factory.store.jobs(a.id).find(j => j.role === 'review')!
  const turn = f.factory.bind(job.id, f.cfg.reviewerAgentId, 'review-message')!
  expect(turn.effort).toBe('high'); expect(turn.tools.map(t => t.name)).toEqual(['ler_skill', 'factory_read'])
  const context = turn.context('Review'); turn.delivered(context)
  if (readsPacket) { const packet = await turn.call('factory_read', { path: '@packet' }); expect(packet).toContain('safe patch') }
  await f.factory.completed(job.id, { id: 'review-message', author: { kind: 'agent', id: f.cfg.reviewerAgentId }, text: 'review recorded', run: { status: 'done' }, usage: [] })
  if (!readsPacket) { expect(f.factory.store.get(a.id).blocked).toContain('did not read'); expect(completed).toBe(0); return }
  expect(f.factory.store.get(a.id).stage).toBe('merge'); expect(completed).toBe(0)
  writeFileSync(join(dir, 'gate.json'), JSON.stringify({ candidateSha: 'a'.repeat(40), reviewMessageId: 'review-message', ciPassed: false, reviewPassed: true, merged: false }))
  await f.factory.tick(); expect(f.factory.store.get(a.id).blocked).toBeNull(); expect(completed).toBe(0)
  writeFileSync(join(dir, 'gate.json'), JSON.stringify({ candidateSha: 'a'.repeat(40), reviewMessageId: 'review-message', ciPassed: true, reviewPassed: true, merged: true, mergedByType: 'User', mergedBy: 'owner' }))
  await f.factory.tick(); expect(f.factory.store.get(a.id).stage).toBe('completed'); expect(completed).toBe(1)
})
test('failed clean verification preserves the reservation and never dispatches review', async () => {
  const f = fixture(); await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const operations = join(f.root, 'operations.py')
  writeFileSync(operations, `import json,pathlib,sys\np=pathlib.Path(sys.argv[2])\n(p/'candidate.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}'}))\n(p/'verify.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}','passed':False}))\n`)
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

test('oversized packet blocks before asking for manual publication', async () => {
  const comments: string[] = []
  const f = fixture({ comment: async (_, body) => { comments.push(body) } })
  await f.factory.start({ title: 'Fix', instruction: 'Fix', criteria: ['Works'] }, f.human)
  const a = f.factory.store.active()!; const operations = join(f.root, 'operations.py')
  writeFileSync(operations, `import json,pathlib,sys
p=pathlib.Path(sys.argv[2])
(p/'candidate.json').write_text(json.dumps({'candidateSha':'${'a'.repeat(40)}'}))
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
  const bin = join(f.root, 'bin'); mkdirSync(bin)
  const docker = join(bin, 'docker'); writeFileSync(docker, '#!/bin/sh\nprintf "running 42\\n"\n'); chmodSync(docker, 0o755)
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`
  try {
    writeFileSync(join(f.root, 'attempts', a.id, 'control.json'), JSON.stringify({ action: 'cancel', attemptId: a.id, observedDrained: true }))
    await f.factory.tick(); expect(f.factory.store.active()?.id).toBe(a.id); expect(stopped).toEqual([])
    writeFileSync(docker, '#!/bin/sh\nprintf "exited 0\\n"\n')
    await f.factory.tick(); expect(f.factory.store.get(a.id).stage).toBe('cancelled'); expect(stopped).toEqual(['pending-message'])
    await f.factory.completed(job.id, { id: 'pending-message', author: { kind: 'agent', id: f.cfg.executorAgentId }, text: 'late', run: { status: 'done' }, usage: [] })
    expect(f.factory.store.get(a.id).stage).toBe('cancelled')
    expect(existsSync(join(f.root, 'attempts', a.id, 'message-pending-message.json'))).toBe(true)
  } finally { process.env.PATH = path }
})
test('restart reconstructs the cancellation request after reserve-to-file crash and blocks an interrupted build gap', async () => {
  const f = fixture()
  const a = f.factory.store.reserve({ requestKey: 'crashed-before-request-file', taskId: '', requesterId: f.cfg.ownerId, title: 'Fix', instruction: 'Fix', humanPrompt: 'Fix', criteria: [{ id: 'C1', description: 'Works' }], createdAt: Date.now(), packageHash: f.cfg.packageHash })
  f.factory.close()
  const fail = async (): Promise<never> => { throw new Error('No work may be recreated during recovery') }
  const recovered = new Factory(f.root, f.cfg, { createTask: fail, task: fail, launch: fail, stop: () => {}, completeTask: async () => {}, comment: async () => {} }); cleanups.push(() => recovered.close())
  expect(existsSync(join(f.root, 'attempts', a.id, 'request.json'))).toBe(true)
  expect(recovered.store.get(a.id).blocked).toContain('Task creation interrupted')
  recovered.store.bindTask(a.id, '66666666-6666-4666-8666-666666666666')
  recovered.store.transition(a.id, 'build'); recovered.store.recover()
  expect(recovered.store.get(a.id).blocked).toContain('restart')
})
