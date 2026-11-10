import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hash } from '../../src/factory/hooks'
import { STAGE_GATES } from '../../src/factory/contract'
import type { Config } from '../../src/factory/types'
export function packageFixture(root: string): string {
  const files: Record<string, string> = {
    'stages.yaml': JSON.stringify({ version: 1, publication: 'manual', stages: STAGE_GATES }),
    'HEADLESS.md': 'Only the factory tools are available. Helpers are readonly.',
    'pstack/skills/poteto-mode/SKILL.md': 'Read first, implement and verify.',
    'ponytail/hooks/ponytail-activate.js': `const fs=require('node:fs');fs.writeFileSync(process.env.PLUGIN_DATA+'/.ponytail-active','full');process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'EXACT PINNED HOOK CONTEXT'}}))`,
    'ponytail/hooks/ponytail-mode-tracker.js': '',
    'ponytail/hooks/ponytail-subagent.js': `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SubagentStart',additionalContext:'EXACT PINNED CHILD CONTEXT'}}))`
  }
  for (const [path, content] of Object.entries(files)) { const full = join(root, 'package', path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, content) }
  const manifest = JSON.stringify({ version: 1, files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, hash(content)])) })
  writeFileSync(join(root, 'package/manifest.json'), manifest); return hash(manifest)
}
export function factoryConfig(root: string, ownerId = '77777777-7777-4777-8777-777777777777'): Config {
  return { version: 1, enabled: true, ownerId, projectId: '33333333-3333-4333-8333-333333333333', intakeAgentId: '11111111-1111-4111-8111-111111111111', executorAgentId: '22222222-2222-4222-8222-222222222222', reviewerAgentId: '44444444-4444-4444-8444-444444444444', helperAgentId: '55555555-5555-4555-8555-555555555555', engine: 'codex', model: 'gpt-6-astra', packageHash: packageFixture(root), operationsPath: '/missing/operator.py', container: 'tucano-303ef4-b606616a', workerHostRoot: '/var/lib/central-executor/work', workerControllerRoot: '/tmp/unused-worker', verification: [['python3', 'test.py']], verificationFiles: ['test.py'], requiredChecks: ['test'], humanMergeLogin: 'owner' }
}
