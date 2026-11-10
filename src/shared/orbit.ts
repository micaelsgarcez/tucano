import type { Run, StepStatus } from './types'

export interface OrbitSource { id: string; baseUrl: string; workspaceId: string }
export interface OrbitProject { id: string; name: string; key: string; color: string }
export type OrbitStatusCategory = 'unstarted' | 'started' | 'completed' | 'cancelled' | 'duplicate'
export interface OrbitStatus { id: string; projectId: string; name: string; color: string; category: OrbitStatusCategory; position: number }
export interface OrbitLabel { id: string; projectId: string; name: string; color: string }
export interface OrbitMember { id: string; name: string }
export interface OrbitTask {
  id: string; projectId: string; statusId: string; identifier: string; title: string; description: string
  assigneeIds: string[]; labelIds: string[]; priority: 'urgent' | 'high' | 'medium' | 'low' | 'none'
  dueAt: string | null; createdAt: string; updatedAt: string
}
export type OrbitAgentRole = 'executor' | 'reviewer'
export type OrbitAssignments = Record<OrbitAgentRole, string | null>
export interface OrbitTaskDetail { task: OrbitTask; assignments: OrbitAssignments }
export interface OrbitTaskPage { items: OrbitTaskDetail[]; nextCursor: string | null }
export interface OrbitProjectData { statuses: OrbitStatus[]; labels: OrbitLabel[]; members: OrbitMember[] }
export interface OrbitBoardData extends OrbitProjectData { projects: OrbitProject[] }
export interface OrbitComment {
  id: string; taskId: string; authorId: string; serviceAccount: { id: string; name: string } | null
  body: string; parentId: string | null; createdAt: string; updatedAt: string
}
export interface OrbitCommentPage { items: OrbitComment[]; nextCursor: string | null }
export interface OrbitExecution {
  id: string; sourceId: string; workspaceId: string; taskId: string; requestId: string
  requesterId: string; role: OrbitAgentRole; agentId: string; agentName: string
  conversationId: string; rootMessageId: string; createdAt: number; state: 'queued' | 'started' | 'interrupted'
}
export interface OrbitEvidence { conversationId: string; rootMessageId: string; messageId: string; stepIds: string[] }
interface ActivityBase {
  id: string; executionId: string; at: number; agentId: string; agentName: string; role: OrbitAgentRole; evidence: OrbitEvidence
}
export type OrbitActivity =
  | (ActivityBase & { kind: 'attempt'; attemptId: string; status: Run['status']; steps: { id: string; status: StepStatus }[] })
  | (ActivityBase & { kind: 'report'; attemptId: string; action: string; result: string; nextStep: string })
export interface OrbitActivityPage { items: OrbitActivity[]; executions: OrbitExecution[]; nextCursor: string | null; headCursor: string | null }
export interface OrbitStartInput { sourceId: string; taskId: string; role: OrbitAgentRole; requestId: string }
