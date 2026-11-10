// A disposable real-server preview. All tasks, people, reports and credentials are synthetic.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer as createSocket } from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const dataDir = mkdtempSync(join(tmpdir(), 'tucano-tasks-preview-'))
const workspace = randomUUID()
const source = randomUUID()
const human = randomUUID()
const now = Date.now()
const iso = offset => new Date(now + offset).toISOString()
const projects = [
  { id: randomUUID(), name: 'Atlas', key: 'ATL', color: '#8b5cf6' },
  { id: randomUUID(), name: 'Portal', key: 'POR', color: '#3b82f6' },
  { id: randomUUID(), name: 'Dados', key: 'DAT', color: '#14b8a6' }
]
const definitions = [
  { name: 'Backlog', color: '#9197a1', category: 'unstarted', position: 0 },
  { name: 'Todo', color: '#9197a1', category: 'unstarted', position: 1 },
  { name: 'In Progress', color: '#eab308', category: 'started', position: 2 },
  { name: 'Done', color: '#22c55e', category: 'completed', position: 3 }
]
const statuses = projects.flatMap(project => definitions.map(status => ({ ...status, id: randomUUID(), project_id: project.id })))
const labels = projects.map(project => ({ id: randomUUID(), project_id: project.id, name: 'GitHub', color: '#94a3b8' }))
const titles = ['Revisar o contrato da API de pagamentos', 'Conferir atualização das dependências', 'Validar cadastro pelo celular', 'Preparar revisão da documentação', 'Confirmar recuperação do backup', 'Revisar testes do fluxo de acesso', 'Conferir indicadores do projeto', 'Organizar próximos tickets']
const tasks = Array.from({ length: 30 }, (_, index) => {
  const project = projects[index % projects.length]
  const status = statuses.find(status => status.project_id === project.id && status.position === (index === 0 ? 2 : index % 4))
  return { id: randomUUID(), project_id: project.id, status_id: status.id, identifier: `${project.key}-${index + 1}`, title: titles[index % titles.length], description: index === 0 ? 'Conferir o contrato público da API e registrar os resultados da revisão.\n\n**Critérios de aceite**\n\n- Validar o caminho de sucesso e a resposta de erro.\n- Executar os testes relevantes.\n- Solicitar a revisão antes de publicar.' : 'Tarefa de demonstração para conferir o quadro, as propriedades e a atividade dos agentes.', priority: ['high', 'medium', 'low', 'none'][index % 4], assignee_ids: index % 3 === 0 ? [human] : [], label_ids: index % 2 === 0 ? [labels[index % projects.length].id] : [], due_at: index % 3 === 0 ? iso((index === 0 ? 2 : -1) * 86400000) : null, created_at: iso(-index * 60000), updated_at: iso(-index * 30000) }
})
const storeModule = join(dataDir, 'task-store.mjs')
writeFileSync(storeModule, stripTypeScriptTypes(readFileSync(resolve('src/tasks/store.ts'), 'utf8'), { mode: 'transform' }))
const { TaskStore } = await import(pathToFileURL(storeModule).href)
const reservation = createSocket()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const origin = `http://127.0.0.1:${port}`
const log = createWriteStream(join(dataDir, 'server.log'), { mode: 0o600 })
const env = { ...process.env, TUCANO_DATA: dataDir, TUCANO_HOST: '127.0.0.1', TUCANO_PORT: String(port), TUCANO_URL: origin, TUCANO_FAKE_ENGINES: '1', TUCANO_SEED: '1', TUCANO_LOCALE: 'pt-BR' }
for (const name of ['CODEX_HOME', 'TUCANO_TOKEN', 'TUCANO_TRUST_PROXY', 'TUCANO_FAKE_NO_AI', 'TUCANO_FAKE_BROKEN_PI', 'TUCANO_FAKE_BROKEN_OPENCODE']) delete env[name]
const server = spawn(process.execPath, [resolve('out/main/server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.pipe(log); server.stderr.pipe(log)
let cleaning = false
async function cleanup() {
  if (cleaning) return
  cleaning = true
  server.kill('SIGTERM')
  await new Promise(resolve => server.exitCode !== null || server.signalCode !== null ? resolve() : server.once('exit', resolve))
  log.end()
  rmSync(dataDir, { recursive: true, force: true })
}
process.once('SIGINT', () => void cleanup().then(() => process.exit(0)))
process.once('SIGTERM', () => void cleanup().then(() => process.exit(0)))
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start; inspect ${join(dataDir, 'server.log')}`)), 30000)
    server.once('error', reject)
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)) })
    server.stdout.on('data', chunk => { if (String(chunk).includes('Tucano server:')) { clearTimeout(timeout); resolve() } })
  })
  const db = new DatabaseSync(join(dataDir, 'tucano.db'))
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE')
  try {
    const owner = db.prepare("SELECT id FROM people WHERE role='owner'").get().id
    const agents = db.prepare("SELECT id,name FROM agents WHERE kind IS NULL ORDER BY created_at LIMIT 2").all()
    if (agents.length !== 2) throw new Error('The demo seed requires two agents')
    agents[0].name = 'Aster'; agents[1].name = 'Nilo'
    agents.forEach((agent, index) => db.prepare('UPDATE agents SET name=?, handle=?, role=?, computer=0, browser=0, web=0, grants=? WHERE id=?').run(agent.name, agent.name.toLowerCase(), index ? 'Revisão independente' : 'Engenharia', '{}', agent.id))
    const setting = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)')
    setting.run('workspaceName', JSON.stringify('Alex Demo'))
    setting.run('workspaceLabel', JSON.stringify('Workspace de demonstração'))
    setting.run('theme', JSON.stringify('dark'))
    setting.run('onboarding', JSON.stringify({ done: true }))
    db.prepare('UPDATE people SET name=? WHERE id=?').run('Alex Demo', owner)
    const meta = db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)')
    const store = new TaskStore(join(dataDir, 'tasks.sqlite'))
    try {
      store.importSnapshot({
        source: { id: source, workspaceId: workspace },
        owner: { id: owner, workspaceId: workspace, projectIds: projects.map(project => project.id), scopes: ['tasks:read', 'tasks:write'], serviceAccountId: null, owner: true },
        fingerprint: 'synthetic-preview-v1',
        tables: {
          projects: projects.map(project => ({ id: project.id, name: project.name, project_key: project.key, color: project.color, workspace_id: workspace, task_counter: 30, deleted_at: null })),
          task_statuses: statuses,
          labels,
          users: [{ id: human, display_name: 'Alex Demo', deleted_at: null, suspended_at: null }, { id: owner, display_name: 'Alex Demo', deleted_at: null, suspended_at: null }],
          memberships: [human, owner].map(id => ({ id: randomUUID(), workspace_id: workspace, user_id: id })),
          tasks: tasks.map((task, index) => ({ id: task.id, workspace_id: workspace, project_id: task.project_id, status_id: task.status_id, number: index + 1, title: task.title, description: task.description, priority: task.priority, due_at: task.due_at ? Date.parse(task.due_at) : null, created_at: Date.parse(task.created_at), updated_at: Date.parse(task.updated_at), version: 1, source_url: null, parent_task_id: null, deleted_at: null, creator_id: owner, creator_service_account_id: null })),
          task_assignees: tasks.flatMap(task => task.assignee_ids.map(id => ({ id: randomUUID(), task_id: task.id, user_id: id }))),
          task_labels: tasks.flatMap(task => task.label_ids.map(id => ({ id: randomUUID(), task_id: task.id, label_id: id })))
        }
      })
      store.addComment(store.ownerPrincipal(), { taskId: tasks[0].id, body: 'Escopo confirmado. Registrar evidências e solicitar revisão ao terminar.' })
      if (store.list(store.ownerPrincipal()).items.length !== tasks.length) throw new Error('Preview task seed is incomplete')
    } finally { store.close() }
    tasks.forEach((task, index) => {
      for (const [role, agent] of [['executor', agents[index % 2]], ['reviewer', agents[(index + 1) % 2]]]) meta.run(`orbit:assignment:${JSON.stringify([source, workspace, task.id, role])}`, agent.id)
    })
    const conversation = randomUUID(), root = randomUUID(), message = randomUUID(), executionId = randomUUID(), attemptId = randomUUID(), stepId = randomUUID()
    db.prepare('INSERT INTO conversations(id,kind,name,created_at,owner) VALUES (?,?,?,?,?)').run(conversation, 'dm', agents[0].id, now - 600000, owner)
    db.prepare('INSERT INTO members(conversation_id,agent_id) VALUES (?,?)').run(conversation, agents[0].id)
    const saveMessage = db.prepare('INSERT INTO messages(id,conversation_id,author_kind,author_id,text,at,run,thread_id) VALUES (?,?,?,?,?,?,?,?)')
    saveMessage.run(root, conversation, 'person', owner, 'Revisar o contrato da API de pagamentos e registrar as evidências.', now - 600000, null, null)
    saveMessage.run(message, conversation, 'agent', agents[0].id, 'Revisei o contrato e os testes. A mudança está pronta para revisão.', now - 590000, JSON.stringify({ status: 'done', attemptId, steps: [{ id: stepId, label: 'Conferiu os testes', status: 'done' }], endedAt: now - 500000 }), root)
    const execution = { id: executionId, sourceId: source, workspaceId: workspace, taskId: tasks[0].id, requestId: randomUUID(), requesterId: owner, role: 'executor', agentId: agents[0].id, agentName: agents[0].name, conversationId: conversation, rootMessageId: root, createdAt: now - 600000, state: 'started' }
    db.prepare('INSERT INTO task_executions(id,source_id,workspace_id,task_id,requester_id,request_id,role,conversation_id,root_message_id,created_at,state,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(executionId, source, workspace, tasks[0].id, owner, execution.requestId, 'executor', conversation, root, execution.createdAt, execution.state, JSON.stringify(execution))
    const evidence = { conversationId: conversation, rootMessageId: root, messageId: message, stepIds: [stepId] }
    const base = { executionId, at: now - 500000, agentId: agents[0].id, agentName: agents[0].name, role: 'executor', evidence, attemptId }
    for (const entry of [
      { ...base, id: `attempt:${attemptId}`, kind: 'attempt', status: 'done', steps: [{ id: stepId, status: 'done' }] },
      { ...base, id: `report:${attemptId}:review`, at: now - 480000, kind: 'report', action: 'Conferiu o contrato e executou os testes da API.', result: 'Os testes passaram; a alteração está pronta para revisão.', nextStep: 'Nilo revisará o diff antes da publicação.' }
    ]) db.prepare('INSERT INTO task_activity(id,execution_id,data) VALUES (?,?,?)').run(entry.id, executionId, JSON.stringify(entry))
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error } finally { db.close() }
  const token = readFileSync(join(dataDir, 'server-token'), 'utf8').trim()
  writeFileSync(join(dataDir, 'preview.json'), JSON.stringify({ origin, link: `${origin}/?token=${encodeURIComponent(token)}`, dataDir, taskId: tasks[0].id }, null, 2), { mode: 0o600 })
  console.log(`Synthetic preview ready. Private access details: ${join(dataDir, 'preview.json')}`)
  console.log('Press Ctrl+C to stop the server and remove the temporary database.')
} catch (error) {
  console.error(error.message)
  await cleanup()
  process.exitCode = 1
}
