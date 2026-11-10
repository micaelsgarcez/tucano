export interface OrbitSource {
  id: string
  baseUrl: string
  workspaceId: string
}

export interface OrbitProject {
  id: string
  name: string
  key: string
}

export interface OrbitStatus {
  id: string
  projectId: string
  name: string
}

export interface OrbitMember {
  id: string
  name: string
}

export interface OrbitTask {
  id: string
  projectId: string
  statusId: string
  identifier: string
  title: string
  description: string
  assigneeIds: string[]
}

export type OrbitAgentRole = 'executor' | 'reviewer'
export type OrbitAssignments = Record<OrbitAgentRole, string | null>
export interface OrbitTaskDetail {
  task: OrbitTask
  assignments: OrbitAssignments
}
export interface OrbitTaskPage {
  items: OrbitTaskDetail[]
  nextCursor: string | null
}
export interface OrbitProjectData {
  statuses: OrbitStatus[]
  members: OrbitMember[]
}
