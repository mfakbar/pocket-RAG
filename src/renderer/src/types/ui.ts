import type {
  ChatAttachment,
  ChatPerformanceMetrics,
  Citation,
  UserFacingFailure
} from '../../../shared/contracts'

export type View =
  'welcome' | 'folder-setup' | 'preparing' | 'home' | 'chat' | 'resources' | 'settings'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: ChatAttachment[]
  sources?: Citation[]
  streaming?: boolean
  status?: string
  notice?: string
  sensitiveAction?: boolean
  error?: boolean
  failure?: UserFacingFailure
  performance?: ChatPerformanceMetrics
  createdAt?: string
}

export interface ChatSession {
  id: string
  title: string
  messages: Message[]
  useKnowledgeBase: boolean
  knowledgeBaseIds: string[]
  projectId: string | null
  archivedAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface ChatProject {
  id: string
  name: string
  createdAt: string
  archivedAt?: string | null
}
