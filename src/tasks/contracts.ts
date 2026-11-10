export interface TaskSource {
  id: string
  workspaceId: string
}
export interface TaskProject {
  id: string
  name: string
  key: string
  color: string
}
export interface TaskStatus {
  id: string
  projectId: string
  name: string
  color: string
  category: 'unstarted' | 'started' | 'completed' | 'cancelled' | 'duplicate'
  position: number
}
export interface TaskLabel {
  id: string
  projectId: string
  name: string
  color: string
}
export interface TaskMember {
  id: string
  name: string
}
export interface TaskItem {
  id: string
  projectId: string
  statusId: string
  identifier: string
  title: string
  description: string
  assigneeIds: string[]
  labelIds: string[]
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none'
  dueAt: string | null
  dueStartAt?: string | null
  createdAt: string
  updatedAt: string
  version: number
  sourceUrl: string | null
  relations?: {
    type: 'blocks' | 'related' | 'duplicate'
    taskId: string
    identifier: string
    direction: 'outgoing' | 'incoming'
  }[]
  parentTaskId: string | null
}
export interface TaskComment {
  id: string
  taskId: string
  authorId: string
  serviceAccount: { id: string; name: string } | null
  body: string
  parentId: string | null
  createdAt: string
  updatedAt: string
}
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}
export interface TaskProjectData {
  statuses: TaskStatus[]
  labels: TaskLabel[]
  members: TaskMember[]
}
export interface TaskBoardData extends TaskProjectData {
  projects: TaskProject[]
}
export interface TaskCreate {
  projectId: string
  title: string
  description?: string
  statusId?: string
  priority?: TaskItem['priority']
  dueAt?: string | null
  assigneeIds?: string[]
  labelIds?: string[]
  parentTaskId?: string | null
}
export type TaskPatch = Partial<
  Pick<
    TaskItem,
    | 'title'
    | 'description'
    | 'statusId'
    | 'priority'
    | 'dueAt'
    | 'assigneeIds'
    | 'labelIds'
    | 'parentTaskId'
  >
>
export interface TaskPrincipal {
  id: string
  workspaceId: string
  projectIds: string[]
  scopes: string[]
  serviceAccountId: string | null
  owner: boolean
  tokenId?: string
}
