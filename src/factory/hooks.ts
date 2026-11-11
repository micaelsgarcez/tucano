import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { object, sha, string } from './types'

export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export class Capabilities {
  readonly files: Record<string, string>
  readonly revisions: { pstack: string; ponytail: string }
  constructor(readonly root: string, readonly pin: string) {
    this.root = realpathSync(root)
    const bytes = readFileSync(join(this.root, 'manifest.json'))
    if (hash(bytes) !== pin) throw new Error('Factory package manifest changed')
    const manifest = object(JSON.parse(bytes.toString()))
    if (manifest.version !== 1) throw new Error('Unsupported capability package')
    this.revisions = { pstack: sha(manifest.pstackRevision), ponytail: sha(manifest.ponytailRevision) }
    this.files = Object.fromEntries(Object.entries(object(manifest.files)).map(([path, digest]) => [path, string(digest)]))
    this.verify()
  }
  verify(prefix = ''): void { for (const path of Object.keys(this.files)) if (path.startsWith(prefix)) this.read(path) }
  read(path: string): string {
    const expected = this.files[path]
    const full = resolve(this.root, path)
    if (!expected || !full.startsWith(resolve(this.root) + sep) || realpathSync(full) !== full) throw new Error('Unpinned capability file')
    const content = readFileSync(full)
    if (hash(content) !== expected) throw new Error(`Capability hash mismatch: ${path}`)
    return content.toString('utf8')
  }
}
const scripts = { SessionStart: 'ponytail-activate.js', UserPromptSubmit: 'ponytail-mode-tracker.js', SubagentStart: 'ponytail-subagent.js' }
type Event = keyof typeof scripts
export class Hooks {
  private context = ''
  private sequence = 0
  constructor(private readonly package_: Capabilities, private readonly dir: string, private readonly sessionId: string, private readonly defaultMode = 'full') {
    for (const path of ['home', 'config', 'xdg', 'data', 'project']) mkdirSync(join(dir, path), { recursive: true, mode: 0o700 })
  }
  invoke(event: Event, input: Record<string, unknown>): string {
    if (event === 'UserPromptSubmit' && /(?:^|\s)[/@$]ponytail(?::ponytail)?\s+(band|default)\b/i.test(string(input.prompt))) throw new Error('Ponytail band/default commands are unavailable in the headless factory')
    this.package_.verify('ponytail/')
    const path = `ponytail/hooks/${scripts[event]}`
    this.package_.read(path)
    const inputPath = join(this.dir, `input-${this.sequence}.json`)
    writeFileSync(inputPath, JSON.stringify({ ...input, session_id: this.sessionId, cwd: join(this.dir, 'project') }), { mode: 0o600 })
    const fd = openSync(inputPath, 'r')
    const env = { PATH: '/usr/bin:/bin', HOME: join(this.dir, 'home'), USERPROFILE: join(this.dir, 'home'), CLAUDE_CONFIG_DIR: join(this.dir, 'config'), XDG_CONFIG_HOME: join(this.dir, 'xdg'), CLAUDE_PROJECT_DIR: join(this.dir, 'project'), CLAUDE_PLUGIN_ROOT: join(this.package_.root, 'ponytail'), PLUGIN_DATA: join(this.dir, 'data'), PONYTAIL_DEFAULT_MODE: this.defaultMode, PONYTAIL_MAP: '0' }
    let result
    try { result = spawnSync(process.execPath, [join(this.package_.root, path)], { cwd: env.CLAUDE_PROJECT_DIR, env, stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 15_000, maxBuffer: 128 * 1024 }) }
    finally { closeSync(fd) }
    if (result.error || result.status !== 0 || result.stderr) throw new Error(`Ponytail ${event} failed: ${result.error?.message ?? result.stderr}`)
    let context = ''
    if (result.stdout.trim()) {
      const output = object(JSON.parse(result.stdout))
      if (output.hookSpecificOutput !== undefined) {
        const specific = object(output.hookSpecificOutput)
        if (specific.hookEventName !== event) throw new Error('Hook event mismatch')
        context = string(specific.additionalContext)
      } else if (Object.keys(output).length) throw new Error('Unexpected hook output')
    }
    const state = join(this.dir, 'data/.ponytail-active')
    const mode = existsSync(state) ? readFileSync(state, 'utf8').trim() : 'off'
    if (mode === 'off') this.context = ''
    else if (context) this.context = context
    if (event === 'SessionStart' && !this.context && (mode !== 'off' || (input.source === 'startup' && this.defaultMode !== 'off'))) throw new Error('Missing startup hook context')
    writeFileSync(join(this.dir, `receipt-${this.sequence++}.json`), JSON.stringify({ event, input, mode, protocol: 'adapted-codex-json', scriptSha256: hash(this.package_.read(path)), stdoutSha256: hash(result.stdout), contextSha256: hash(context), context, at: Date.now() }), { mode: 0o600 })
    return this.context
  }
  start(prompt: string | undefined, child: boolean): string {
    this.invoke('SessionStart', { source: 'startup' })
    if (prompt !== undefined) this.invoke('UserPromptSubmit', { prompt })
    if (child) this.invoke('SubagentStart', { agent_type: 'general', agent_id: this.sessionId })
    return this.context
  }
  delivered(system: string): void {
    if (this.context && !system.includes(this.context)) throw new Error('Hook context did not reach engine input')
    writeFileSync(join(this.dir, 'delivery.json'), JSON.stringify({ systemSha256: hash(system), contextSha256: hash(this.context), contextBytes: Buffer.byteLength(this.context), at: Date.now() }), { mode: 0o600 })
  }
}
