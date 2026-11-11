import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hash } from '../../src/factory/hooks'
import { STAGE_GATES } from '../../src/factory/contract'
import type { Config, Ports, Profile } from '../../src/factory/types'
export function packageFixture(root: string): string {
  const files: Record<string, string> = {
    'stages.yaml': JSON.stringify({ version: 3, publication: 'controller', stages: STAGE_GATES, correction: { from: 'review', to: 'build', on: 'review.rejected' } }),
    'HEADLESS.md': 'Only the factory tools are available. Helpers are readonly.',
    'pstack/skills/poteto-mode/SKILL.md': 'Read first, implement and verify.',
    'ponytail/skills/ponytail/SKILL.md': 'Ponytail policy',
    'pstack/skills/poteto-mode/playbooks/feature.md': 'Feature playbook',
    'ponytail/hooks/ponytail-activate.js': `const fs=require('node:fs');fs.writeFileSync(process.env.PLUGIN_DATA+'/.ponytail-active',process.env.PONYTAIL_DEFAULT_MODE);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'EXACT PINNED HOOK CONTEXT'}}))`,
    'ponytail/hooks/ponytail-mode-tracker.js': '',
    'ponytail/hooks/ponytail-subagent.js': `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SubagentStart',additionalContext:'EXACT PINNED CHILD CONTEXT'}}))`
  }
  for (const [path, content] of Object.entries(files)) { const full = join(root, 'package', path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, content) }
  const manifest = JSON.stringify({ version: 1, pstackRevision: 'a'.repeat(40), ponytailRevision: 'b'.repeat(40), files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, hash(content)])) })
  writeFileSync(join(root, 'package/manifest.json'), manifest); return hash(manifest)
}
export function factoryConfig(root: string, ownerId = '77777777-7777-4777-8777-777777777777'): Config {
  return { version: 2, enabled: true, ownerId, projectId: '33333333-3333-4333-8333-333333333333', intakeAgentId: '11111111-1111-4111-8111-111111111111', executorAgentId: '22222222-2222-4222-8222-222222222222', reviewerAgentId: '44444444-4444-4444-8444-444444444444', helperAgentId: '55555555-5555-4555-8555-555555555555', publication: { repository: { id: 1423677589, fullName: 'micaelsgarcez/central' }, base: 'main', adoptAttempts: [] }, packageHash: packageFixture(root), operationsPath: '/missing/operator.py', container: 'tucano-303ef4-b606616a', workerHostRoot: '/var/lib/central-executor/work', workerControllerRoot: '/tmp/unused-worker', verification: [['python3', 'test.py']], verificationFiles: ['test.py'], requiredChecks: ['test'], humanMergeLogin: 'owner' }
}

export const nativeProfile: Profile = { modelId: 'gpt-5.6-luna', model: 'gpt-5.6-luna', engine: 'codex', effort: 'medium' }
export function testPorts(root: string): Pick<Ports, 'assertSkills' | 'readSkill' | 'publish'> {
  return {
    assertSkills: () => {},
    readSkill: (_agentId, args) => { const name = String(args.nome); const path = `${name}/${args.arquivo ?? (name === 'pstack' ? 'skills/poteto-mode/SKILL.md' : 'skills/ponytail/SKILL.md')}`; return { content: readFileSync(join(root, 'package', path), 'utf8'), path } },
    publish: async input => existsSync(join(input.attemptDir, 'publication.json')) ? JSON.parse(readFileSync(join(input.attemptDir, 'publication.json'), 'utf8')) : { state: 'waiting', reason: 'GitHub permissions pending' }
  }
}
