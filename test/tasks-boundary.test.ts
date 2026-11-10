import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('keeps the task domain independent of Tucano core, renderer and shared contracts', () => {
  const root = join(import.meta.dirname, '../src/tasks')
  for (const name of readdirSync(root).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(join(root, name), 'utf8')
    expect(source, name).not.toMatch(/(?:from|import)\s*[(]?['"][^'"]*\.\.\/(?:core|shared|renderer)\//)
  }
})
