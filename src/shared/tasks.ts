import type { Run, StepStatus } from './types'
import type { TaskItem, TaskComment, Page } from '../tasks/contracts'
export type { TaskSource, TaskProject, TaskStatus, TaskLabel, TaskMember, TaskItem, TaskComment, TaskProjectData, TaskBoardData, TaskCreate, TaskPatch } from '../tasks/contracts'
export type TaskAgentRole = 'executor' | 'reviewer'
export type TaskAssignments = Record<TaskAgentRole, string | null>
export interface TaskDetail { task: TaskItem; assignments: TaskAssignments }
export type TaskPage = Page<TaskDetail>
export type TaskCommentPage = Page<TaskComment>
export interface TaskExecution {
  id: string; sourceId: string; workspaceId: string; taskId: string; requestId: string
  requesterId: string; role: TaskAgentRole; agentId: string; agentName: string
  conversationId: string; rootMessageId: string; createdAt: number; state: 'queued' | 'started' | 'interrupted'
}
export interface TaskEvidence { conversationId: string; rootMessageId: string; messageId: string; stepIds: string[] }
interface ActivityBase {
  id: string; executionId: string; at: number; agentId: string; agentName: string; role: TaskAgentRole; evidence: TaskEvidence
}
export type TaskActivity =
  | (ActivityBase & { kind: 'attempt'; attemptId: string; status: Run['status']; steps: { id: string; status: StepStatus }[] })
  | (ActivityBase & { kind: 'report'; attemptId: string; action: string; result: string; nextStep: string })
export interface TaskActivityPage { items: TaskActivity[]; executions: TaskExecution[]; nextCursor: string | null; headCursor: string | null }
export interface TaskStartInput { sourceId: string; taskId: string; role: TaskAgentRole; requestId: string }
