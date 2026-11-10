import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { packageFixture } from './helpers/factory'
import { Capabilities, hash, Hooks } from '../src/factory/hooks'
const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const packagePath = process.env.FACTORY_TEST_PACKAGE
const integration = packagePath ? test : test.skip
integration('real pinned hooks deliver exact context, replace level and isolate reviewer state for either engine transport', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-hooks-')); temporary.push(root)
  const path = packagePath!
  const capabilities = new Capabilities(path, hash(readFileSync(join(path, 'manifest.json'))))
  const builder = new Hooks(capabilities, join(root, 'build'), 'build')
  const reviewer = new Hooks(capabilities, join(root, 'review'), 'review')
  const original = builder.start('Implement the acceptance criteria', false)
  expect(original).toMatch(/level: full/)
  expect(reviewer.start('Review independently', false)).toMatch(/level: full/)
  const lite = builder.invoke('UserPromptSubmit', { prompt: '$ponytail lite' })
  expect(lite).toMatch(/level: lite/)
  expect(lite).not.toContain('level: full')
  expect(() => builder.delivered('missing')).toThrow('did not reach')
  builder.delivered(`system\n${lite}`)
  const delivery = JSON.parse(readFileSync(join(root, 'build/delivery.json'), 'utf8'))
  expect(delivery.contextSha256).toBe(hash(lite))
  expect(builder.invoke('UserPromptSubmit', { prompt: 'stop ponytail' })).toBe('')
  expect(builder.invoke('SubagentStart', { agent_type: 'general', agent_id: 'off-child' })).toBe('')
  const child = new Hooks(capabilities, join(root, 'off-child'), 'off-child', 'off')
  expect(child.start(undefined, true)).toBe('')
  expect(reviewer.invoke('SubagentStart', { agent_type: 'general', agent_id: 'child' })).toMatch(/level: full/)
  expect(() => builder.invoke('UserPromptSubmit', { prompt: '/ponytail default off' })).toThrow('unavailable')
})

test('an empty startup cannot masquerade as disabled mode when full was configured', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-empty-hook-')); temporary.push(root); packageFixture(root)
  const packageRoot = join(root, 'package'), manifestPath = join(packageRoot, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const script = 'ponytail/hooks/ponytail-activate.js'
  writeFileSync(join(packageRoot, script), '')
  manifest.files[script] = hash('')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const capabilities = new Capabilities(packageRoot, hash(readFileSync(manifestPath)))
  expect(() => new Hooks(capabilities, join(root, 'session'), 'session').start('Implement', false)).toThrow('Missing startup')
})
