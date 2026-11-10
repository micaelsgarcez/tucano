import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Factory, intakeTools } from '../factory/controller'
import { config, type Turn } from '../factory/types'
import type { Message } from '../shared/types'
import type { Db } from './db'
import type { Tasks } from './tasks'
import type { Runner } from './runs'
import { dmOwner } from './people'
import type { ToolDef } from './gateway'

export interface FactoryBridge {
  bind(agentId: string, conversationId: string, threadId: string | undefined, messageId: string): Turn | undefined
  intake(agentId: string, conversationId: string, trigger: string | undefined): { tools: ToolDef[]; call(name: string, args: Record<string, unknown>): Promise<string> } | undefined
  completed(message: Message): Promise<void>
  computerAllowed(agentId: string): boolean
  close(): void
}
export function openFactory(deps: { dataDir: string; db: Db; tasks: Tasks; runner: Runner; emitConversation(id: string): void }): (FactoryBridge & Pick<Factory, 'tick'>) | undefined {
  const root = join(deps.dataDir, 'factory'); const file = join(root, 'config.json')
  if (!existsSync(file)) return undefined
  const configured = config(JSON.parse(readFileSync(file, 'utf8')))
  if (!configured.enabled) return undefined
  const { db, tasks, runner } = deps
  if (configured.ownerId !== db.ownerId()) throw new Error('Factory owner does not match workspace owner')
  const source = tasks.source(); if (!source) throw new Error('Factory requires native tasks')
  const factory = new Factory(root, configured, {
    createTask: async input => (await tasks.create({ sourceId: source.id, ...input })).task,
    task: async taskId => (await tasks.detail(source.id, taskId)).task,
    stop: messageId => runner.stop(messageId),
    completeTask: async taskId => {
      const detail = await tasks.detail(source.id, taskId)
      if (detail.task.sourceUrl) return
      const project = await tasks.projectData(source.id, detail.task.projectId)
      const completed = project.statuses.find(status => status.category === 'completed')
      if (!completed) throw new Error('Central project has no completed task status')
      await tasks.update({ sourceId: source.id, taskId, expectedVersion: detail.task.version, patch: { statusId: completed.id } })
    },
    comment: async (taskId, body) => { await tasks.addComment({ sourceId: source.id, taskId, body }) },
    launch: async input => {
      const person = db.person(input.requesterId); if (!person || person.id !== configured.ownerId) throw new Error('Factory requester unavailable')
      await tasks.assign({ sourceId: source.id, taskId: input.taskId, role: input.role, agentId: input.agentId })
      return tasks.start({ sourceId: source.id, taskId: input.taskId, role: input.role, requestId: input.requestId }, (taskSource, detail, agent) => {
        let conversation = db.conversations().find(c => c.kind === 'dm' && c.name === agent.id && dmOwner(c, db.ownerId()) === person.id)
        if (!conversation) { const id = randomUUID(); db.createConversation({ id, kind: 'dm', name: agent.id, members: [agent.id], owner: person.id }); deps.emitConversation(id); conversation = db.conversation(id) }
        if (!conversation) throw new Error('Factory conversation unavailable')
        return runner.startTask({ source: taskSource, detail, agent, conversation, requester: person, role: input.role, requestId: input.requestId, instructions: input.instructions })
      })
    }
  })
  factory.startTimer()
  return {
    close: () => factory.close(),
    tick: () => factory.tick(),
    bind: (agentId, conversationId, threadId, messageId) => {
      const execution = db.taskExecution(conversationId, threadId)
      return execution ? factory.bind(execution.requestId, agentId, messageId) : undefined
    },
    intake: (agentId, conversationId, trigger) => {
      if (agentId !== configured.intakeAgentId || !trigger) return undefined
      const triggerMessage = db.message(trigger)
      if (!triggerMessage || triggerMessage.conversationId !== conversationId || triggerMessage.author.kind !== 'person' || triggerMessage.author.id !== configured.ownerId) return undefined
      if (db.taskExecution(conversationId, triggerMessage.threadId ?? triggerMessage.id)) return undefined
      return { tools: intakeTools, call: async (name, args) => {
        if (name === 'factory_status') return factory.status()
        if (name !== 'factory_start') throw new Error('Unknown factory intake tool')
        return factory.start(args, { personId: configured.ownerId, messageId: triggerMessage.id, conversationId, prompt: triggerMessage.text })
      } }
    },
    completed: async message => {
      const execution = db.taskExecution(message.conversationId, message.threadId)
      if (!execution || message.author.kind !== 'agent' || !message.run) return
      const usage = db.receiptsForMessage(message.id).map(r => ({ ...r, id: String(r.receiptId) }))
      await factory.completed(execution.requestId, { id: message.id, author: message.author, text: message.text, run: { status: message.run.status, error: message.run.error, errorDetail: message.run.errorDetail }, usage })
    },
    computerAllowed: (agentId: string) => ![configured.executorAgentId, configured.reviewerAgentId, configured.helperAgentId].includes(agentId)
  }
}
