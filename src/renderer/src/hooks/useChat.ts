import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatAttachment, ChatMessage, ChatStreamEvent } from '../../../shared/contracts'
import { normalizeModelText } from '../../../shared/model-text'
import type { ChatProject, ChatSession, Message } from '../types/ui'
import { readLocalJson, readLocalValue, writeLocalJson, writeLocalValue } from '../lib/storage'

const STORAGE_KEY = 'pocketrag.chat-sessions.v1'
const ACTIVE_KEY = 'pocketrag.active-chat.v1'
const PROJECTS_KEY = 'pocketrag.chat-projects.v1'

function newSession(defaultKnowledgeBaseId = '', useKnowledgeBase = true): ChatSession {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    messages: [],
    useKnowledgeBase,
    knowledgeBaseIds: defaultKnowledgeBaseId ? [defaultKnowledgeBaseId] : [],
    projectId: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now
  }
}

function loadSessions(): ChatSession[] {
  try {
    const parsed = readLocalJson(STORAGE_KEY, [])
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (session): session is ChatSession =>
          typeof session === 'object' &&
          session !== null &&
          typeof (session as ChatSession).id === 'string' &&
          Array.isArray((session as ChatSession).messages)
      )
      .map((session) => ({
        ...session,
        knowledgeBaseIds: Array.isArray(session.knowledgeBaseIds)
          ? session.knowledgeBaseIds.filter((id): id is string => typeof id === 'string')
          : [],
        projectId: typeof session.projectId === 'string' ? session.projectId : null,
        archivedAt: typeof session.archivedAt === 'string' ? session.archivedAt : null,
        messages: session.messages.map((message) => {
          const normalized =
            message.role === 'assistant'
              ? { ...message, content: normalizeModelText(message.content) }
              : message
          return normalized.streaming
            ? {
                ...normalized,
                content: normalized.content || 'This response stopped when RavnDock closed.',
                streaming: false,
                status: undefined,
                error: true
              }
            : normalized
        })
      }))
      .slice(0, 50)
  } catch {
    return []
  }
}

function loadProjects(): ChatProject[] {
  try {
    const parsed = readLocalJson(PROJECTS_KEY, [])
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (project): project is ChatProject =>
          typeof project === 'object' &&
          project !== null &&
          typeof (project as ChatProject).id === 'string' &&
          typeof (project as ChatProject).name === 'string'
      )
      .map((project) => ({
        ...project,
        archivedAt: typeof project.archivedAt === 'string' ? project.archivedAt : null
      }))
  } catch {
    return []
  }
}

export interface ChatController {
  sessions: ChatSession[]
  projects: ChatProject[]
  activeSession: ChatSession
  input: string
  setInput: (input: string) => void
  attachments: ChatAttachment[]
  addAttachments: (attachments: ChatAttachment[]) => void
  removeAttachment: (path: string) => void
  loading: boolean
  sendMessage: () => Promise<void>
  stopResponse: () => Promise<void>
  prepareRetry: (assistantMessageId: string) => void
  revealSensitiveValue: (assistantMessageId: string) => Promise<void>
  newChat: (options?: NewChatOptions) => void
  selectSession: (sessionId: string) => void
  deleteSession: (sessionId: string) => void
  renameSession: (sessionId: string, title: string) => void
  archiveSession: (sessionId: string) => void
  restoreSession: (sessionId: string) => void
  setUseKnowledgeBase: (enabled: boolean) => void
  setKnowledgeBaseIds: (ids: string[]) => void
  createProject: (name: string) => void
  renameProject: (projectId: string, name: string) => void
  archiveProject: (projectId: string) => void
  restoreProject: (projectId: string) => void
  deleteProject: (projectId: string) => void
  moveToProject: (projectId: string | null) => void
  moveSessionToProject: (sessionId: string, projectId: string | null) => void
}

export interface NewChatOptions {
  knowledgeBaseIds?: string[]
  useKnowledgeBase?: boolean
  projectId?: string | null
}

export function useChat(defaultKnowledgeBaseId: string): ChatController {
  const initial = useMemo(() => {
    const saved = loadSessions()
    return saved.length > 0 ? saved : [newSession(defaultKnowledgeBaseId)]
  }, [defaultKnowledgeBaseId])
  const [sessions, setSessions] = useState<ChatSession[]>(initial)
  const [projects, setProjects] = useState<ChatProject[]>(loadProjects)
  const [activeSessionId, setActiveSessionId] = useState(
    () => readLocalValue(ACTIVE_KEY) ?? initial[0].id
  )
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [loadingSessions, setLoadingSessions] = useState<Set<string>>(() => new Set())
  const activeRequests = useRef(new Map<string, { sessionId: string; assistantId: string }>())
  const bufferedChatEvents = useRef(new Map<string, ChatStreamEvent[]>())
  const processChatEvent = useRef<(event: ChatStreamEvent) => void>(() => undefined)
  const pendingStops = useRef(new Set<string>())

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0]

  useEffect(() => {
    writeLocalJson(STORAGE_KEY, sessions.slice(0, 50))
    writeLocalValue(ACTIVE_KEY, activeSessionId)
  }, [activeSessionId, sessions])

  useEffect(() => {
    writeLocalJson(PROJECTS_KEY, projects)
  }, [projects])

  useEffect(() => {
    if (!defaultKnowledgeBaseId) return
    let current = true
    queueMicrotask(() => {
      if (!current) return
      setSessions((storedSessions) =>
        storedSessions.map((session) =>
          session.knowledgeBaseIds.length === 0 && session.messages.length === 0
            ? { ...session, knowledgeBaseIds: [defaultKnowledgeBaseId] }
            : session
        )
      )
    })
    return () => {
      current = false
    }
  }, [defaultKnowledgeBaseId])

  useEffect(() => {
    const requests = activeRequests.current
    const bufferedEvents = bufferedChatEvents.current
    const pendingTokens = new Map<string, string>()
    let animationFrame: number | null = null

    const applyChatEvent = (event: ChatStreamEvent): void => {
      const active = requests.get(event.requestId)
      if (!active) return

      setSessions((current) =>
        current.map((session) => {
          if (session.id !== active.sessionId) return session
          const messages = session.messages.map((message) => {
            if (message.id !== active.assistantId) return message
            if (event.type === 'token') {
              return { ...message, content: message.content + event.content, status: undefined }
            }
            if (event.type === 'replace') {
              return {
                ...message,
                content: normalizeModelText(event.content),
                status: undefined
              }
            }
            if (event.type === 'citations') return { ...message, sources: event.citations }
            if (event.type === 'status') {
              return { ...message, status: event.message, streaming: true }
            }
            if (event.type === 'notice') {
              return { ...message, notice: event.message, status: undefined }
            }
            if (event.type === 'sensitive-action') {
              return { ...message, sensitiveAction: event.available, status: undefined }
            }
            if (event.type === 'error') {
              return {
                ...message,
                content: normalizeModelText(message.content || event.message),
                streaming: false,
                status: undefined,
                error: true,
                failure: event.failure
              }
            }
            return {
              ...message,
              content: normalizeModelText(message.content),
              streaming: false,
              status: undefined,
              performance: event.metrics
            }
          })
          return { ...session, messages, updatedAt: new Date().toISOString() }
        })
      )

      if (event.type === 'done' || event.type === 'error') {
        requests.delete(event.requestId)
        setLoadingSessions((current) => {
          const next = new Set(current)
          next.delete(active.sessionId)
          return next
        })
      }
    }

    const flushTokens = (requestId?: string): void => {
      const entries = requestId
        ? ([[requestId, pendingTokens.get(requestId) ?? '']] as const)
        : [...pendingTokens.entries()]
      for (const [id, content] of entries) {
        pendingTokens.delete(id)
        if (content) applyChatEvent({ requestId: id, type: 'token', content })
      }
    }

    const handleChatEvent = (event: ChatStreamEvent): void => {
      if (!requests.has(event.requestId)) {
        const buffered = bufferedEvents.get(event.requestId) ?? []
        buffered.push(event)
        if (buffered.length > 2_048) buffered.shift()
        bufferedEvents.set(event.requestId, buffered)
        if (bufferedEvents.size > 20) {
          const oldestRequestId = bufferedEvents.keys().next().value
          if (oldestRequestId) bufferedEvents.delete(oldestRequestId)
        }
        return
      }
      if (event.type === 'token') {
        pendingTokens.set(
          event.requestId,
          (pendingTokens.get(event.requestId) ?? '') + event.content
        )
        if (animationFrame === null) {
          animationFrame = window.requestAnimationFrame(() => {
            animationFrame = null
            flushTokens()
          })
        }
        return
      }
      flushTokens(event.requestId)
      applyChatEvent(event)
    }
    processChatEvent.current = handleChatEvent
    const unsubscribe = window.api.onChatEvent(handleChatEvent)

    return () => {
      processChatEvent.current = () => undefined
      unsubscribe()
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      pendingTokens.clear()
      for (const requestId of requests.keys()) {
        void window.api.cancelChat(requestId)
      }
      bufferedEvents.clear()
    }
  }, [])

  const updateActive = (update: (session: ChatSession) => ChatSession): void => {
    setSessions((current) =>
      current.map((session) => (session.id === activeSession.id ? update(session) : session))
    )
  }

  const newChat = (options: NewChatOptions = {}): void => {
    const knowledgeBaseIds = options.knowledgeBaseIds ??
      activeSession?.knowledgeBaseIds ?? [defaultKnowledgeBaseId]
    const session = newSession(
      knowledgeBaseIds[0] ?? '',
      options.useKnowledgeBase ?? activeSession?.useKnowledgeBase ?? true
    )
    session.knowledgeBaseIds = [...new Set(knowledgeBaseIds.filter(Boolean))]
    session.projectId =
      options.projectId !== undefined ? options.projectId : (activeSession?.projectId ?? null)
    setSessions((current) => [session, ...current])
    setActiveSessionId(session.id)
    setInput('')
    setAttachments([])
  }

  const selectSession = (sessionId: string): void => {
    setActiveSessionId(sessionId)
    setInput('')
    setAttachments([])
  }

  const deleteSession = (sessionId: string): void => {
    pendingStops.current.delete(sessionId)
    const request = [...activeRequests.current.entries()].find(
      ([, active]) => active.sessionId === sessionId
    )
    if (request) {
      void window.api.cancelChat(request[0])
      activeRequests.current.delete(request[0])
    }
    const next = sessions.filter((session) => session.id !== sessionId)
    const activeNext = next.find((session) => !session.archivedAt)
    const updated = activeNext ? next : [newSession(defaultKnowledgeBaseId), ...next]
    setSessions(updated)
    if (sessionId === activeSessionId) {
      setActiveSessionId(updated.find((session) => !session.archivedAt)?.id ?? updated[0].id)
    }
  }

  const renameSession = (sessionId: string, title: string): void => {
    const cleanTitle = title.trim().slice(0, 100)
    if (!cleanTitle) return
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? { ...session, title: cleanTitle, updatedAt: new Date().toISOString() }
          : session
      )
    )
  }

  const archiveSession = (sessionId: string): void => {
    const archivedAt = new Date().toISOString()
    let fallback = sessions.find((session) => session.id !== sessionId && !session.archivedAt)
    if (!fallback) fallback = newSession(defaultKnowledgeBaseId)
    setSessions((current) => {
      const next = current.map((session) =>
        session.id === sessionId ? { ...session, archivedAt } : session
      )
      return next.some((session) => session.id === fallback.id) ? next : [fallback, ...next]
    })
    if (sessionId === activeSessionId) setActiveSessionId(fallback.id)
  }

  const restoreSession = (sessionId: string): void => {
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? { ...session, archivedAt: null, updatedAt: new Date().toISOString() }
          : session
      )
    )
  }

  const setUseKnowledgeBase = (enabled: boolean): void => {
    updateActive((session) => ({ ...session, useKnowledgeBase: enabled }))
  }

  const setKnowledgeBaseIds = (ids: string[]): void => {
    updateActive((session) => ({ ...session, knowledgeBaseIds: [...new Set(ids)] }))
  }

  const createProject = (name: string): void => {
    const cleanName = name.trim()
    if (!cleanName) return
    const project: ChatProject = {
      id: crypto.randomUUID(),
      name: cleanName,
      createdAt: new Date().toISOString(),
      archivedAt: null
    }
    setProjects((current) => [...current, project])
    updateActive((session) => ({ ...session, projectId: project.id }))
  }

  const renameProject = (projectId: string, name: string): void => {
    const cleanName = name.trim().slice(0, 100)
    if (!cleanName) return
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId ? { ...project, name: cleanName } : project
      )
    )
  }

  const archiveProject = (projectId: string): void => {
    const archivedAt = new Date().toISOString()
    setProjects((current) =>
      current.map((project) => (project.id === projectId ? { ...project, archivedAt } : project))
    )
  }

  const restoreProject = (projectId: string): void => {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId ? { ...project, archivedAt: null } : project
      )
    )
  }

  const deleteProject = (projectId: string): void => {
    setProjects((current) => current.filter((project) => project.id !== projectId))
    setSessions((current) =>
      current.map((session) =>
        session.projectId === projectId ? { ...session, projectId: null } : session
      )
    )
  }

  const moveToProject = (projectId: string | null): void => {
    updateActive((session) => ({ ...session, projectId }))
  }

  const moveSessionToProject = (sessionId: string, projectId: string | null): void => {
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? { ...session, projectId, updatedAt: new Date().toISOString() }
          : session
      )
    )
  }

  const stopResponse = async (): Promise<void> => {
    const sessionId = activeSession.id
    const request = [...activeRequests.current.entries()].find(
      ([, active]) => active.sessionId === sessionId
    )
    if (!request && !loadingSessions.has(sessionId)) return

    if (request) activeRequests.current.delete(request[0])
    else pendingStops.current.add(sessionId)
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              messages: session.messages.map((message) =>
                message.streaming
                  ? {
                      ...message,
                      content: normalizeModelText(message.content || 'Response stopped.'),
                      streaming: false,
                      notice: message.content
                        ? 'Stopped. This answer may be incomplete.'
                        : undefined
                    }
                  : message
              ),
              updatedAt: new Date().toISOString()
            }
          : session
      )
    )
    setLoadingSessions((current) => {
      const next = new Set(current)
      next.delete(sessionId)
      return next
    })
    if (request) await window.api.cancelChat(request[0])
  }

  const addAttachments = (nextAttachments: ChatAttachment[]): void => {
    setAttachments((current) => {
      const paths = new Set(current.map((attachment) => attachment.path))
      return [
        ...current,
        ...nextAttachments.filter((attachment) => !paths.has(attachment.path))
      ].slice(0, 10)
    })
  }

  const removeAttachment = (path: string): void => {
    setAttachments((current) => current.filter((attachment) => attachment.path !== path))
  }

  const prepareRetry = (assistantMessageId: string): void => {
    const assistantIndex = activeSession.messages.findIndex(
      (message) => message.id === assistantMessageId && message.role === 'assistant'
    )
    if (assistantIndex < 1) return
    let userIndex = -1
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      if (activeSession.messages[index]?.role === 'user') {
        userIndex = index
        break
      }
    }
    const userMessage = userIndex >= 0 ? activeSession.messages[userIndex] : undefined
    if (!userMessage) return
    setInput(userMessage.content)
    setAttachments(userMessage.attachments ?? [])
    updateActive((session) => ({
      ...session,
      messages: session.messages.filter(
        (_message, index) => index !== assistantIndex && index !== userIndex
      ),
      updatedAt: new Date().toISOString()
    }))
  }

  const sendMessage = async (): Promise<void> => {
    const content = input.trim()
    if ((!content && attachments.length === 0) || loadingSessions.has(activeSession.id)) return
    const prompt = content || 'Please review the attached file and give me a clear summary.'

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      attachments,
      createdAt: new Date().toISOString()
    }
    const assistantId = crypto.randomUUID()
    const assistantCreatedAt = new Date().toISOString()
    const conversation: ChatMessage[] = [...activeSession.messages, userMessage]
      .filter((message) => !message.error && !message.streaming)
      .map((message) => ({ role: message.role, content: message.content }))
    const titleSource = prompt.replace(/\s+/g, ' ').trim()
    const title =
      activeSession.messages.length === 0
        ? titleSource.length > 52
          ? `${titleSource.slice(0, 52).trimEnd()}...`
          : titleSource
        : activeSession.title

    updateActive((session) => ({
      ...session,
      title,
      updatedAt: new Date().toISOString(),
      messages: [
        ...session.messages,
        userMessage,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          streaming: true,
          createdAt: assistantCreatedAt
        }
      ]
    }))
    setInput('')
    setAttachments([])
    setLoadingSessions((current) => new Set(current).add(activeSession.id))

    try {
      const result = await window.api.startChat({
        messages: conversation,
        useKnowledgeBase: activeSession.useKnowledgeBase,
        knowledgeBaseIds: activeSession.useKnowledgeBase ? activeSession.knowledgeBaseIds : [],
        attachmentPaths: attachments.map((attachment) => attachment.path)
      })
      if (!result.ok) {
        setSessions((current) =>
          current.map((session) =>
            session.id === activeSession.id
              ? {
                  ...session,
                  messages: session.messages.map((item) =>
                    item.id === assistantId
                      ? {
                          ...item,
                          content: result.message ?? 'Chat could not be started.',
                          streaming: false,
                          error: true,
                          failure: result.failure
                        }
                      : item
                  )
                }
              : session
          )
        )
        setLoadingSessions((current) => {
          const next = new Set(current)
          next.delete(activeSession.id)
          return next
        })
        return
      }
      if (pendingStops.current.delete(activeSession.id)) {
        await window.api.cancelChat(result.requestId)
        return
      }
      activeRequests.current.set(result.requestId, {
        sessionId: activeSession.id,
        assistantId
      })
      const buffered = bufferedChatEvents.current.get(result.requestId) ?? []
      bufferedChatEvents.current.delete(result.requestId)
      for (const event of buffered) processChatEvent.current(event)
    } catch (error) {
      pendingStops.current.delete(activeSession.id)
      const technicalDetails =
        error instanceof Error
          ? error.message.replace(/\/(?:Users|home)\/[^\s:]+/g, '[local path]').slice(0, 500)
          : undefined
      const message = 'Your chat is safe. Review the local setup, then try again.'
      setSessions((current) =>
        current.map((session) =>
          session.id === activeSession.id
            ? {
                ...session,
                messages: session.messages.map((item) =>
                  item.id === assistantId
                    ? {
                        ...item,
                        content: message,
                        streaming: false,
                        error: true,
                        failure: {
                          title: 'Chat could not start',
                          message,
                          code: 'CHAT_START_FAILED',
                          retryable: true,
                          primaryAction: { id: 'retry-chat', label: 'Review and retry' },
                          secondaryAction: { id: 'open-settings', label: 'Open Settings' },
                          technicalDetails
                        }
                      }
                    : item
                )
              }
            : session
        )
      )
      setLoadingSessions((current) => {
        const next = new Set(current)
        next.delete(activeSession.id)
        return next
      })
    }
  }

  const revealSensitiveValue = async (assistantMessageId: string): Promise<void> => {
    if (loadingSessions.has(activeSession.id)) return
    const assistantIndex = activeSession.messages.findIndex(
      (message) => message.id === assistantMessageId && message.role === 'assistant'
    )
    if (assistantIndex < 1 || !(await window.api.confirmSensitiveAccess())) return
    let userIndex = assistantIndex - 1
    while (userIndex >= 0 && activeSession.messages[userIndex]?.role !== 'user') userIndex -= 1
    const userMessage = activeSession.messages[userIndex]
    if (!userMessage || userMessage.role !== 'user') return
    const conversation: ChatMessage[] = activeSession.messages
      .slice(0, assistantIndex)
      .filter((message) => !message.error && !message.streaming)
      .map((message) => ({ role: message.role, content: message.content }))
    updateActive((session) => ({
      ...session,
      updatedAt: new Date().toISOString(),
      messages: session.messages.map((message) =>
        message.id === assistantMessageId
          ? {
              ...message,
              content: '',
              sources: undefined,
              notice: undefined,
              sensitiveAction: false,
              streaming: true
            }
          : message
      )
    }))
    setLoadingSessions((current) => new Set(current).add(activeSession.id))
    try {
      const result = await window.api.startChat({
        messages: conversation,
        useKnowledgeBase: activeSession.useKnowledgeBase,
        knowledgeBaseIds: activeSession.useKnowledgeBase ? activeSession.knowledgeBaseIds : [],
        attachmentPaths: userMessage.attachments?.map((attachment) => attachment.path) ?? [],
        sensitiveAccessConfirmed: true
      })
      if (!result.ok) throw new Error(result.message ?? 'Sensitive value could not be revealed.')
      activeRequests.current.set(result.requestId, {
        sessionId: activeSession.id,
        assistantId: assistantMessageId
      })
      const buffered = bufferedChatEvents.current.get(result.requestId) ?? []
      bufferedChatEvents.current.delete(result.requestId)
      for (const event of buffered) processChatEvent.current(event)
    } catch (error) {
      setSessions((current) =>
        current.map((session) =>
          session.id === activeSession.id
            ? {
                ...session,
                messages: session.messages.map((message) =>
                  message.id === assistantMessageId
                    ? {
                        ...message,
                        content:
                          error instanceof Error
                            ? error.message
                            : 'Sensitive value could not be revealed.',
                        streaming: false,
                        error: true
                      }
                    : message
                )
              }
            : session
        )
      )
      setLoadingSessions((current) => {
        const next = new Set(current)
        next.delete(activeSession.id)
        return next
      })
    }
  }

  return {
    sessions,
    projects,
    activeSession,
    input,
    setInput,
    attachments,
    addAttachments,
    removeAttachment,
    loading: loadingSessions.has(activeSession.id),
    sendMessage,
    stopResponse,
    prepareRetry,
    revealSensitiveValue,
    newChat,
    selectSession,
    deleteSession,
    renameSession,
    archiveSession,
    restoreSession,
    setUseKnowledgeBase,
    setKnowledgeBaseIds,
    createProject,
    renameProject,
    archiveProject,
    restoreProject,
    deleteProject,
    moveToProject,
    moveSessionToProject
  }
}
