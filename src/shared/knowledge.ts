// ai-memory stays the source of truth. These are views, never local Wiki pages.
export interface KnowledgeSource {
  id: string
  name: string
  baseUrl: string
}
export interface KnowledgeScope {
  sourceId: string
  workspace: string
  project: string
}
export interface KnowledgeProject extends KnowledgeScope {
  pages: number
}
export interface KnowledgeRef extends KnowledgeScope {
  path: string
}
export interface KnowledgeEntry {
  ref: KnowledgeRef
  title: string
  kind: string
  snippet: string
}
export interface KnowledgePage extends KnowledgeEntry {
  id: string
  tier: string
  updatedAt: string
  markdown: string
}
