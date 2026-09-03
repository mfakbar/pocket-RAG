import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  AlertTriangle,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  FileText,
  ExternalLink,
  FolderSearch,
  FolderKanban,
  GripVertical,
  Library,
  Loader2,
  MemoryStick,
  MessageSquare,
  Microchip,
  MoreHorizontal,
  Pencil,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Send,
  Settings as SettingsIcon,
  Square,
  Trash2,
  WandSparkles,
  X
} from 'lucide-react'
import type {
  Citation,
  KnowledgeBase,
  ModelOption,
  RecoveryActionId
} from '../../../shared/contracts'
import { shouldWarnAboutTwoBModel } from '../../../shared/model-routing'
import { GradientButton, Modal, ThemeAwareAppIcon } from '../components/ui'
import {
  ChoiceHelp,
  PromptTemplateRow,
  ResourceMiniMetric,
  SessionRow
} from '../components/chat/ChatPrimitives'
import { MarkdownAnswer } from '../components/chat/MarkdownAnswer'
import { normalizeModelText } from '../../../shared/model-text'
import { DEFAULT_PROMPT_TEMPLATES, type PromptTemplate } from '../config/promptTemplates'
import { BRAND, COLORS } from '../config/ui'
import type { ChatController } from '../hooks/useChat'
import type { ResourceHistoryPoint } from '../hooks/useResourceHistory'
import { groupSources } from '../lib/group-sources'
import { friendlyActionError } from '../lib/errors'
import { readLocalJson, readLocalValue, writeLocalJson, writeLocalValue } from '../lib/storage'

const CUSTOM_TEMPLATES_KEY = 'pocketrag.prompt-templates.v1'
const SIDEBAR_WIDTH_KEY = 'pocketrag.chat-sidebar-width.v1'
const COLLAPSED_PROJECTS_KEY = 'pocketrag.collapsed-projects.v1'

const CHAT_USE_IDEAS = [
  { label: 'Direct answer', description: 'Ask a specific question about any document.' },
  {
    label: 'Find insights',
    description: 'Explore patterns, risks, or key differences in your files.'
  },
  { label: 'Concise summary', description: 'Get a short summary of any document or topic.' }
] as const

function loadCustomTemplates(): PromptTemplate[] {
  try {
    const parsed = readLocalJson(CUSTOM_TEMPLATES_KEY, [])
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is PromptTemplate =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as PromptTemplate).id === 'string' &&
            typeof (item as PromptTemplate).name === 'string' &&
            typeof (item as PromptTemplate).prompt === 'string'
        )
      : []
  } catch {
    return []
  }
}

function loadCollapsedProjects(): Set<string> {
  try {
    const parsed = readLocalJson(COLLAPSED_PROJECTS_KEY, [])
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    )
  } catch {
    return new Set()
  }
}

export default function ChatView({
  onBack,
  onMonitor,
  onSettings,
  knowledgeBases,
  activeKnowledgeBaseId,
  selectedModel,
  onModelSelected,
  chat,
  resourceHistory,
  onTitleChange
}: {
  onBack: () => void
  onMonitor: () => void
  onSettings: () => void
  knowledgeBases: KnowledgeBase[]
  activeKnowledgeBaseId: string
  selectedModel: string
  onModelSelected: (model: string) => Promise<void>
  chat: ChatController
  resourceHistory: ResourceHistoryPoint[]
  onTitleChange: (title: string) => void
}): React.JSX.Element {
  const {
    sessions,
    projects,
    activeSession,
    input,
    setInput,
    attachments,
    addAttachments,
    removeAttachment,
    loading,
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
    moveSessionToProject
  } = chat
  const messages = activeSession.messages
  const showBalancedModelWarning = shouldWarnAboutTwoBModel(selectedModel, input)
  useEffect(() => {
    onTitleChange(activeSession.title || 'New chat')
  }, [activeSession.title, onTitleChange])

  useEffect(() => {
    void window.api.warmSelectedModel().catch(() => false)
  }, [selectedModel])

  const bottomRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [switchingModel, setSwitchingModel] = useState(false)
  const [showKnowledgeBases, setShowKnowledgeBases] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [enhancing, setEnhancing] = useState(false)
  const [enhancedPrompt, setEnhancedPrompt] = useState<string | null>(null)
  const [enhancementModel, setEnhancementModel] = useState('')
  const [recoveryBusy, setRecoveryBusy] = useState<string | null>(null)
  const [recoveryFeedback, setRecoveryFeedback] = useState<{
    messageId: string
    text: string
  } | null>(null)
  const [chatAnnouncement, setChatAnnouncement] = useState('')
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const wasLoading = useRef(false)
  const [citationActionMessage, setCitationActionMessage] = useState('')
  const [showTemplates, setShowTemplates] = useState(false)
  const [showWritingTools, setShowWritingTools] = useState(false)
  const [customTemplates, setCustomTemplates] = useState<PromptTemplate[]>(loadCustomTemplates)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(readLocalValue(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= 176 && saved <= 380 ? saved : 208
  })
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(loadCollapsedProjects)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null)
  const [citationPreview, setCitationPreview] = useState<Citation | null>(null)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [copyFailureMessageId, setCopyFailureMessageId] = useState<string | null>(null)
  const [sessionMenu, setSessionMenu] = useState<{
    sessionId: string
    x: number
    y: number
  } | null>(null)
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--chat-sidebar-width',
      `${sidebarCollapsed ? 84 : sidebarWidth}px`
    )
    return () => {
      document.documentElement.style.removeProperty('--chat-sidebar-width')
    }
  }, [sidebarCollapsed, sidebarWidth])
  const [projectMenu, setProjectMenu] = useState<{
    projectId: string
    x: number
    y: number
  } | null>(null)
  useEffect(
    () =>
      window.api.onAppCommand((command) => {
        if (command === 'toggle-sidebar') setSidebarCollapsed((current) => !current)
      }),
    []
  )
  const chatResourceHistory = resourceHistory.slice(-15)
  const selectedKnowledgeBases = knowledgeBases.filter((knowledgeBase) =>
    activeSession.knowledgeBaseIds.includes(knowledgeBase.id)
  )
  const activeProjects = projects.filter((project) => !project.archivedAt)
  const archivedProjects = projects.filter((project) => Boolean(project.archivedAt))
  const sessionsByProject = useMemo(
    () =>
      activeProjects.map((project) => ({
        project,
        sessions: sessions.filter(
          (session) => session.projectId === project.id && !session.archivedAt
        )
      })),
    [activeProjects, sessions]
  )
  const archivedProjectGroups = archivedProjects.map((project) => ({
    project,
    sessions: sessions.filter((session) => session.projectId === project.id && !session.archivedAt)
  }))
  const ungroupedSessions = sessions.filter((session) => !session.projectId && !session.archivedAt)

  const handleRecovery = async (
    action: RecoveryActionId,
    assistantMessageId: string
  ): Promise<void> => {
    setRecoveryFeedback(null)
    if (action === 'open-settings' || action === 'sync-files') {
      onSettings()
      return
    }
    if (action === 'edit-question' || action === 'retry-chat') {
      prepareRetry(assistantMessageId)
      window.setTimeout(() => composerRef.current?.focus(), 0)
      return
    }
    setRecoveryBusy(assistantMessageId)
    try {
      if (action === 'restart-local-ai') {
        await window.api.restartLocalAI()
        prepareRetry(assistantMessageId)
        window.setTimeout(() => composerRef.current?.focus(), 0)
      } else if (action === 'choose-files') {
        const chosen = await window.api.selectChatFiles()
        if (chosen.length > 0) {
          addAttachments(chosen)
          prepareRetry(assistantMessageId)
          window.setTimeout(() => composerRef.current?.focus(), 0)
        }
      }
    } catch {
      setRecoveryFeedback({
        messageId: assistantMessageId,
        text: 'That action did not finish. Open Settings to review the local setup.'
      })
    } finally {
      setRecoveryBusy(null)
    }
  }
  const archivedSessions = sessions.filter((session) => Boolean(session.archivedAt))
  const menuSession = sessionMenu
    ? sessions.find((session) => session.id === sessionMenu.sessionId)
    : undefined
  const menuProject = projectMenu
    ? projects.find((project) => project.id === projectMenu.projectId)
    : undefined

  const openSessionMenu = (sessionId: string, event: React.MouseEvent): void => {
    setProjectMenu(null)
    setSessionMenu({
      sessionId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 360))
    })
  }

  const openProjectMenu = (projectId: string, event: React.MouseEvent): void => {
    setSessionMenu(null)
    setProjectMenu({
      projectId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 260))
    })
  }

  const dropSession = (event: React.DragEvent, projectId: string | null): void => {
    event.preventDefault()
    const sessionId = event.dataTransfer.getData('application/x-pocketrag-chat')
    if (sessionId) moveSessionToProject(sessionId, projectId)
    setDragOverProjectId(null)
  }

  useEffect(() => {
    void window.api
      .listModels()
      .then(setModels)
      .catch(() => setModels([]))
  }, [])

  useEffect(() => {
    writeLocalJson(CUSTOM_TEMPLATES_KEY, customTemplates)
  }, [customTemplates])

  useEffect(() => {
    writeLocalValue(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    writeLocalJson(COLLAPSED_PROJECTS_KEY, [...collapsedProjects])
  }, [collapsedProjects])

  useEffect(() => {
    if (!sessionMenu) return
    const close = (event?: Event): void => {
      if (event?.target instanceof Element && event.target.closest('[data-session-menu]')) return
      setSessionMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [sessionMenu])

  useEffect(() => {
    if (!projectMenu) return
    const close = (event?: Event): void => {
      if (event?.target instanceof Element && event.target.closest('[data-project-menu]')) return
      setProjectMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [projectMenu])

  useEffect(() => {
    if (!resizingSidebar) return
    const resize = (event: PointerEvent): void => {
      setSidebarWidth(Math.min(380, Math.max(176, event.clientX)))
    }
    const finish = (): void => setResizingSidebar(false)
    document.addEventListener('pointermove', resize)
    document.addEventListener('pointerup', finish)
    return () => {
      document.removeEventListener('pointermove', resize)
      document.removeEventListener('pointerup', finish)
    }
  }, [resizingSidebar])

  useEffect(() => {
    if (!autoScrollRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [messages])

  useEffect(() => {
    autoScrollRef.current = true
    const timer = window.setTimeout(() => {
      setShowJumpToLatest(false)
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeSession.id])

  useEffect(() => {
    if (loading && !wasLoading.current) {
      setChatAnnouncement('RavnDock is answering.')
    } else if (!loading && wasLoading.current) {
      const latestAssistant = [...messages]
        .reverse()
        .find((message) => message.role === 'assistant')
      setChatAnnouncement(
        latestAssistant?.error
          ? 'The answer needs your attention. Review the available next steps.'
          : latestAssistant?.notice?.startsWith('Stopped')
            ? 'Response stopped. The partial answer may be incomplete.'
            : 'Answer ready.'
      )
    }
    wasLoading.current = loading
  }, [loading, messages])

  useLayoutEffect(() => {
    const composer = composerRef.current
    if (!composer) return
    composer.style.height = 'auto'
    composer.style.height = `${Math.min(composer.scrollHeight, Math.max(160, window.innerHeight * 0.4))}px`
  }, [input])

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {chatAnnouncement}
      </div>
      <aside
        className={`chat-sidebar relative ${sidebarCollapsed ? 'hidden' : 'flex'} h-full flex-shrink-0 flex-col border-r border-border p-3`}
        style={{ width: sidebarWidth }}
      >
        <div className="mb-3 flex items-center gap-2.5 px-1">
          <ThemeAwareAppIcon alt="" className="h-7 w-7 rounded-[7px]" />
          <span className="text-base font-semibold tracking-[0.01em] text-foreground">
            RavnDock
          </span>
        </div>
        <div className="flex items-center gap-1">
          <GradientButton
            onClick={() => newChat()}
            className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium"
          >
            <Plus className="h-4 w-4" />
            New Chat
          </GradientButton>
          <button
            type="button"
            onClick={() => setSidebarCollapsed(true)}
            title="Hide sidebar"
            className="native-titlebar-button flex-shrink-0"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <div className="mb-2 flex items-center justify-between px-2">
            <p className="text-[10px] font-semibold uppercase text-muted-foreground">Projects</p>
            <button
              type="button"
              onClick={() => setCreatingProject(true)}
              title="Create project"
              className="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
          {creatingProject && (
            <div className="mb-3 flex gap-1 px-1">
              <input
                autoFocus
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && projectName.trim()) {
                    createProject(projectName)
                    setProjectName('')
                    setCreatingProject(false)
                  }
                }}
                placeholder="Project name"
                className="min-w-0 flex-1 rounded-md border border-border bg-white/[0.04] px-2 py-1.5 text-[11px] text-foreground outline-none"
              />
              <button
                type="button"
                onClick={() => setCreatingProject(false)}
                title="Cancel"
                className="rounded p-1.5 text-muted-foreground hover:bg-white/5"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <div className="space-y-3">
            {sessionsByProject.map(({ project, sessions: projectSessions }) => (
              <section
                key={project.id}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDragOverProjectId(project.id)
                }}
                onDragLeave={() => setDragOverProjectId(null)}
                onDrop={(event) => dropSession(event, project.id)}
                className={`rounded-md transition-colors ${
                  dragOverProjectId === project.id ? 'bg-primary/10 ring-1 ring-primary/30' : ''
                }`}
              >
                <div className="group/project mb-1 flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedProjects((current) => {
                        const next = new Set(current)
                        if (next.has(project.id)) next.delete(project.id)
                        else next.add(project.id)
                        return next
                      })
                    }
                    title={collapsedProjects.has(project.id) ? 'Show chats' : 'Hide chats'}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-white/[0.04]"
                  >
                    {collapsedProjects.has(project.id) ? (
                      <ChevronRight className="h-3 w-3 flex-shrink-0" />
                    ) : (
                      <ChevronDown className="h-3 w-3 flex-shrink-0" />
                    )}
                    <FolderKanban className="h-3 w-3 flex-shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    <span className="text-[9px]">{projectSessions.length}</span>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => openProjectMenu(project.id, event)}
                    title="Project options"
                    className="hidden rounded p-0.5 hover:bg-white/[0.06] hover:text-foreground group-hover/project:block group-focus-within/project:block"
                  >
                    <MoreHorizontal className="h-3 w-3" />
                  </button>
                </div>
                {!collapsedProjects.has(project.id) && (
                  <div className="space-y-1">
                    {projectSessions.length === 0 ? (
                      <p className="px-3 py-1.5 text-[10px] text-muted-foreground/70">
                        Drag a chat here
                      </p>
                    ) : (
                      projectSessions.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          active={session.id === activeSession.id}
                          onSelect={() => selectSession(session.id)}
                          onMenu={(event) => openSessionMenu(session.id, event)}
                        />
                      ))
                    )}
                  </div>
                )}
              </section>
            ))}
            {ungroupedSessions.length > 0 && (
              <section
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDragOverProjectId('ungrouped')
                }}
                onDragLeave={() => setDragOverProjectId(null)}
                onDrop={(event) => dropSession(event, null)}
                className={`rounded-md ${dragOverProjectId === 'ungrouped' ? 'bg-primary/10' : ''}`}
              >
                <p className="mb-1 px-2 text-[10px] font-semibold uppercase text-muted-foreground">
                  Chats
                </p>
                <div className="space-y-1">
                  {ungroupedSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={session.id === activeSession.id}
                      onSelect={() => selectSession(session.id)}
                      onMenu={(event) => openSessionMenu(session.id, event)}
                    />
                  ))}
                </div>
              </section>
            )}
            {(archivedSessions.length > 0 || archivedProjectGroups.length > 0) && (
              <section>
                <button
                  type="button"
                  onClick={() => setArchivedOpen((current) => !current)}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground hover:bg-white/[0.04]"
                >
                  {archivedOpen ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  <Archive className="h-3 w-3" />
                  <span className="flex-1 text-left">Archived</span>
                  <span className="text-[9px]">
                    {archivedSessions.length + archivedProjectGroups.length}
                  </span>
                </button>
                {archivedOpen && (
                  <div className="mt-1 space-y-1 opacity-75">
                    {archivedProjectGroups.map(({ project, sessions: projectSessions }) => (
                      <section key={project.id} className="rounded-md bg-white/[0.015] px-1 py-1">
                        <div className="group/project flex items-center gap-1 text-[11px] text-muted-foreground">
                          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1">
                            <Archive className="h-3 w-3 flex-shrink-0" />
                            <FolderKanban className="h-3 w-3 flex-shrink-0 text-primary" />
                            <span className="min-w-0 flex-1 truncate">{project.name}</span>
                            <span className="text-[9px]">{projectSessions.length}</span>
                          </div>
                          <button
                            type="button"
                            onClick={(event) => openProjectMenu(project.id, event)}
                            title="Project options"
                            className="rounded p-0.5 hover:bg-white/[0.06] hover:text-foreground"
                          >
                            <MoreHorizontal className="h-3 w-3" />
                          </button>
                        </div>
                        <div className="space-y-1">
                          {projectSessions.map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              active={session.id === activeSession.id}
                              onSelect={() => selectSession(session.id)}
                              onMenu={(event) => openSessionMenu(session.id, event)}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                    {archivedSessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === activeSession.id}
                        onSelect={() => selectSession(session.id)}
                        onMenu={(event) => openSessionMenu(session.id, event)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
        <div className="mt-auto border-t border-border pt-3">
          <button
            type="button"
            onClick={onMonitor}
            className="mb-3 w-full space-y-1.5 rounded-md text-left transition-colors hover:bg-white/[0.035] focus:outline-none focus:ring-1 focus:ring-cyan-400/40"
            title="Open Monitor"
          >
            <ResourceMiniMetric
              icon={<MemoryStick className="h-3 w-3" />}
              label="Memory"
              value={chatResourceHistory.at(-1)?.memory ?? null}
              history={chatResourceHistory.map((point) => point.memory)}
              normalColor="var(--metric-memory)"
            />
            <ResourceMiniMetric
              icon={<Microchip className="h-3 w-3" />}
              label="GPU"
              value={chatResourceHistory.at(-1)?.gpu ?? null}
              history={chatResourceHistory.map((point) => point.gpu ?? 0)}
              normalColor="var(--metric-gpu)"
            />
          </button>
          <div className="flex items-center gap-1">
            <button
              onClick={onBack}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back to Home
            </button>
            <button
              type="button"
              onClick={onSettings}
              title="Open Settings"
              aria-label="Open Settings"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <SettingsIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <button
          type="button"
          onPointerDown={(event) => {
            event.preventDefault()
            setResizingSidebar(true)
          }}
          className={`absolute -right-1 top-0 z-20 flex h-full w-2 cursor-col-resize items-center justify-center ${
            resizingSidebar ? 'bg-primary/10' : 'hover:bg-primary/5'
          }`}
          title="Drag to resize chat history"
          aria-label="Resize chat history"
        >
          <GripVertical className="h-4 w-4 text-white/20" />
        </button>
      </aside>

      <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {sidebarCollapsed && (
          <button
            type="button"
            onClick={() => setSidebarCollapsed(false)}
            title="Show sidebar"
            className="native-titlebar-button absolute left-3 top-3 z-10"
          >
            <PanelLeftOpen className="h-3.5 w-3.5" />
          </button>
        )}

        <div
          ref={threadRef}
          className="chat-thread min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4"
          onScroll={() => {
            const thread = threadRef.current
            if (!thread) return
            const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120
            autoScrollRef.current = nearBottom
            setShowJumpToLatest(!nearBottom)
          }}
        >
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
              <div
                className="flex h-12 w-12 items-center justify-center rounded-xl"
                style={{ background: BRAND.gradient }}
              >
                <MessageSquare className="h-6 w-6 text-primary-foreground" />
              </div>
              <div>
                <h3 className="mb-1 text-base font-semibold text-foreground">
                  {activeSession.useKnowledgeBase
                    ? 'Ask your documents anything'
                    : 'Start a conversation'}
                </h3>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {activeSession.useKnowledgeBase
                    ? 'Ask a direct question, find insights, or get a concise summary.'
                    : 'Ask a question, explore an idea, or request a concise summary.'}
                </p>
              </div>
              <div className="flex w-full max-w-xl flex-wrap justify-center gap-x-6 gap-y-3 text-left">
                {CHAT_USE_IDEAS.map((idea) => (
                  <div key={idea.label} className="w-36">
                    <p className="text-xs font-medium text-foreground">{idea.label}</p>
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                      {idea.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {messages.map((message, messageIndex) => {
            const messageDate = message.createdAt ?? activeSession.createdAt
            const previousDate =
              messageIndex > 0
                ? (messages[messageIndex - 1]?.createdAt ?? activeSession.createdAt)
                : undefined
            const dateKey = new Date(messageDate).toLocaleDateString()
            const previousDateKey = previousDate
              ? new Date(previousDate).toLocaleDateString()
              : undefined
            return (
              <div key={message.id} className="contents">
                {dateKey !== previousDateKey && (
                  <div className="my-2 text-center text-[10px] font-medium text-muted-foreground">
                    {new Date(messageDate).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric'
                    })}
                  </div>
                )}
                <div
                  className={`chat-message-group flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={message.role === 'assistant' ? 'w-full max-w-[90%]' : 'max-w-[72%]'}
                  >
                    {message.role === 'user' ? (
                      <div
                        className="chat-user-message whitespace-pre-wrap rounded-xl rounded-tr-sm px-4 py-3 text-[12px] leading-6 text-primary-foreground"
                        style={{ background: BRAND.gradient }}
                      >
                        {message.content}
                        {message.attachments && message.attachments.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-white/20 pt-2">
                            {message.attachments.map((attachment) => (
                              <span
                                key={attachment.path}
                                className="flex max-w-48 items-center gap-1 rounded bg-white/15 px-2 py-1 text-[10px]"
                                title={attachment.name}
                              >
                                <FileText className="h-3 w-3 flex-shrink-0" />
                                <span className="truncate">{attachment.name}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        className={`px-1 text-sm leading-relaxed ${
                          message.error ? 'chat-error-text' : 'text-foreground'
                        }`}
                      >
                        {message.error ? (
                          message.failure ? (
                            <div
                              className="rounded-lg border border-destructive/20 bg-destructive/[0.045] p-3 text-[12px]"
                              role="alert"
                            >
                              <p className="font-semibold text-foreground">
                                {message.failure.title}
                              </p>
                              <p className="mt-1 leading-relaxed text-muted-foreground">
                                {message.failure.message}
                              </p>
                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                {message.failure.primaryAction && (
                                  <button
                                    type="button"
                                    disabled={recoveryBusy === message.id}
                                    onClick={() =>
                                      void handleRecovery(
                                        message.failure!.primaryAction!.id,
                                        message.id
                                      )
                                    }
                                    className="rounded-md bg-foreground px-2.5 py-1.5 text-[11px] font-medium text-background disabled:opacity-50"
                                  >
                                    {recoveryBusy === message.id
                                      ? 'Working…'
                                      : message.failure.primaryAction.label}
                                  </button>
                                )}
                                {message.failure.secondaryAction && (
                                  <button
                                    type="button"
                                    disabled={recoveryBusy === message.id}
                                    onClick={() =>
                                      void handleRecovery(
                                        message.failure!.secondaryAction!.id,
                                        message.id
                                      )
                                    }
                                    className="rounded-md px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                                  >
                                    {message.failure.secondaryAction.label}
                                  </button>
                                )}
                              </div>
                              {message.failure.technicalDetails && (
                                <details className="mt-2 text-[10px] text-muted-foreground">
                                  <summary className="cursor-pointer">Technical details</summary>
                                  <p className="mt-1 whitespace-pre-wrap break-words">
                                    {message.failure.technicalDetails}
                                  </p>
                                </details>
                              )}
                              {recoveryFeedback?.messageId === message.id && (
                                <p className="mt-2 text-[10px] text-destructive" role="status">
                                  {recoveryFeedback.text}
                                </p>
                              )}
                            </div>
                          ) : (
                            <div className="whitespace-pre-wrap text-[13px]">{message.content}</div>
                          )
                        ) : (
                          <MarkdownAnswer
                            content={message.content}
                            citationPrefix={`source-${message.id}`}
                            sourceCount={message.sources?.length ?? 0}
                          />
                        )}
                        {message.status && (
                          <p className="mt-2 text-[10px] text-muted-foreground" role="status">
                            {message.status}
                          </p>
                        )}
                        {message.notice && (
                          <p className="mt-2 text-[10px] text-muted-foreground" role="status">
                            {message.notice}
                          </p>
                        )}
                        {message.sensitiveAction && !message.streaming && (
                          <button
                            type="button"
                            onClick={() => void revealSensitiveValue(message.id)}
                            className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-[11px] font-medium text-amber-200 hover:bg-amber-400/15"
                          >
                            Reveal sensitive value
                          </button>
                        )}
                        {message.streaming && !message.status && (
                          <span className="ml-0.5 inline-block h-4 w-1 animate-pulse rounded-sm bg-primary" />
                        )}

                        {message.performance && (
                          <div className="mt-1.5 space-y-0.5 text-[10px] text-muted-foreground">
                            {message.performance.cached && (
                              <p className="font-medium text-foreground/70">
                                Cached verified answer
                              </p>
                            )}
                            {message.performance.retrievalScope?.files[0] && (
                              <p>
                                Using {message.performance.retrievalScope.files.join(', ')}
                                {message.performance.retrievalScope.sheets.length > 0
                                  ? ` › ${message.performance.retrievalScope.sheets.join(', ')}`
                                  : ''}
                              </p>
                            )}
                            {!message.performance.cached && (
                              <p>
                                First token{' '}
                                {message.performance.timeToFirstTokenMs === null
                                  ? 'not measured'
                                  : `${(message.performance.timeToFirstTokenMs / 1000).toFixed(2)}s`}
                                {message.performance.tokensPerSecond !== null
                                  ? ` · ${message.performance.tokensPerSecond.toFixed(1)} tokens/sec`
                                  : ''}
                              </p>
                            )}
                          </div>
                        )}

                        {message.sources && message.sources.length > 0 && (
                          <div className="mt-3 rounded-lg border border-border bg-white/[0.025] p-3">
                            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
                              <FileText className="h-3.5 w-3.5 text-primary" />
                              Sources
                            </div>
                            <div className="space-y-1.5">
                              {groupSources(message.sources).map((group) => (
                                <div
                                  key={group.file}
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => {
                                    const firstLocation = group.locations[0]?.location
                                    const source = message.sources?.find(
                                      (item) =>
                                        item.file === group.file && item.location === firstLocation
                                    )
                                    if (source) {
                                      setCitationActionMessage('')
                                      setCitationPreview(source)
                                    }
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ')
                                      event.currentTarget.click()
                                  }}
                                  className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  style={{ background: COLORS.chipBg, border: COLORS.chipBorder }}
                                  title="Preview cited passage"
                                >
                                  <FileText className="h-3 w-3 text-primary" />
                                  <span
                                    className="citation-source max-w-[42%] truncate font-medium"
                                    title={group.file}
                                  >
                                    {group.file}
                                  </span>
                                  <span className="text-white/15">|</span>
                                  <span className="min-w-0 flex-1 text-muted-foreground">
                                    {group.locations.map((location, locationIndex) => (
                                      <button
                                        key={location.location}
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          const source = message.sources?.find(
                                            (item) =>
                                              item.file === group.file &&
                                              item.location === location.location
                                          )
                                          if (source) {
                                            setCitationActionMessage('')
                                            setCitationPreview(source)
                                          }
                                        }}
                                        className="citation-location inline-flex items-center"
                                        title="Preview this retrieved passage"
                                      >
                                        {locationIndex > 0 && (
                                          <span className="mx-1.5 text-white/20">•</span>
                                        )}
                                        {location.indexes.map((index) => (
                                          <span
                                            id={`source-${message.id}-${index}`}
                                            key={index}
                                            className="citation-marker mr-1 text-[10px] font-semibold"
                                          >
                                            [{index}]
                                          </span>
                                        ))}
                                        {location.location}
                                      </button>
                                    ))}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    <div
                      className={`chat-message-meta ${
                        message.role === 'user'
                          ? 'chat-message-meta-user'
                          : 'chat-message-meta-assistant'
                      }`}
                    >
                      <span>
                        {new Date(messageDate).toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit'
                        })}
                      </span>
                      <button
                        type="button"
                        title={copiedMessageId === message.id ? 'Copied' : 'Copy message'}
                        aria-label={copiedMessageId === message.id ? 'Copied' : 'Copy message'}
                        onClick={() => {
                          setCopyFailureMessageId(null)
                          void window.api
                            .copyText(
                              message.role === 'assistant'
                                ? normalizeModelText(message.content)
                                : message.content
                            )
                            .then(() => {
                              setCopiedMessageId(message.id)
                              window.setTimeout(() => setCopiedMessageId(null), 1200)
                            })
                            .catch(() => {
                              setCopyFailureMessageId(message.id)
                              window.setTimeout(() => setCopyFailureMessageId(null), 2200)
                            })
                        }}
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                      {copyFailureMessageId === message.id && (
                        <span className="text-destructive">Could not copy</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>

        {showJumpToLatest && (
          <button
            type="button"
            onClick={() => {
              autoScrollRef.current = true
              setShowJumpToLatest(false)
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
            }}
            className="native-popover absolute bottom-32 left-1/2 z-20 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full px-3 text-[11px] text-foreground"
            aria-label="Jump to the latest message"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            Latest
          </button>
        )}

        <footer className="chat-footer flex-shrink-0 px-4 pb-3 pt-1">
          {enhancedPrompt && (
            <div className="mb-2 rounded-lg border border-violet-400/20 bg-violet-400/[0.07] p-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-violet-200">
                <WandSparkles className="h-3.5 w-3.5" />
                Improved prompt
                {enhancementModel && (
                  <span className="ml-auto font-mono text-[9px] font-normal text-muted-foreground">
                    {enhancementModel}
                  </span>
                )}
              </div>
              <p className="max-h-24 overflow-y-auto text-xs leading-relaxed text-foreground">
                {enhancedPrompt}
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEnhancedPrompt(null)}
                  className="rounded-md px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-white/5"
                >
                  Keep mine
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInput(enhancedPrompt)
                    setEnhancedPrompt(null)
                  }}
                  className="skill-action rounded-md px-2.5 py-1.5 text-[11px] font-medium"
                >
                  Use improved prompt
                </button>
              </div>
            </div>
          )}
          {showTemplates && (
            <div className="mb-2 rounded-lg border border-border bg-popover p-3 shadow-xl">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-foreground">Prompt templates</p>
                  <p className="text-[10px] text-muted-foreground">
                    Pick a useful starting point and make it yours.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowTemplates(false)}
                  title="Close templates"
                  className="rounded p-1 text-muted-foreground hover:bg-white/5"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
                {[...DEFAULT_PROMPT_TEMPLATES, ...customTemplates].map((template) => (
                  <PromptTemplateRow
                    key={template.id}
                    template={template}
                    onSelect={() => {
                      setInput(template.prompt)
                      setShowTemplates(false)
                    }}
                    onDelete={() =>
                      setCustomTemplates((current) =>
                        current.filter((item) => item.id !== template.id)
                      )
                    }
                  />
                ))}
              </div>
              {input.trim() && (
                <div className="mt-2 flex gap-2 border-t border-white/[0.07] pt-2">
                  <input
                    value={newTemplateName}
                    onChange={(event) => setNewTemplateName(event.target.value)}
                    placeholder="Name this prompt"
                    className="min-w-0 flex-1 rounded-md border border-border bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-foreground outline-none"
                  />
                  <button
                    type="button"
                    disabled={!newTemplateName.trim()}
                    onClick={() => {
                      setCustomTemplates((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          name: newTemplateName.trim(),
                          prompt: input.trim(),
                          custom: true
                        }
                      ])
                      setNewTemplateName('')
                    }}
                    className="primary-action rounded-md px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((attachment) => (
                <span
                  key={attachment.path}
                  className="soft-primary-card flex max-w-56 items-center gap-1.5 rounded-md px-2 py-1 text-[10px] text-primary"
                  title={attachment.name}
                >
                  <FileText className="h-3 w-3 flex-shrink-0 text-primary" />
                  <span className="truncate">{attachment.name}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.path)}
                    title="Remove attachment"
                    className="rounded p-0.5 text-primary hover:bg-white/10"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {showBalancedModelWarning && (
            <div
              className="mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px]"
              style={{
                borderColor: 'color-mix(in srgb, var(--status-warning) 24%, transparent)',
                background: 'var(--status-warning-surface)',
                color: 'var(--status-warning)'
              }}
            >
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              <span>This question may be more reliable with Balanced.</span>
            </div>
          )}
          <div className="chat-composer flex items-center gap-2 px-3 py-2">
            <button
              type="button"
              disabled={loading || attachments.length >= 10}
              onClick={() => void window.api.selectChatFiles().then(addAttachments)}
              title="Attach files to this message"
              className="chat-composer-action flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-white/[0.08] hover:text-foreground disabled:opacity-40"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <textarea
              ref={composerRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  autoScrollRef.current = true
                  setShowJumpToLatest(false)
                  void sendMessage()
                }
              }}
              placeholder={
                activeSession.useKnowledgeBase
                  ? 'Ask your documents anything...'
                  : 'Message your local model...'
              }
              rows={1}
              className="chat-composer-input max-h-[40vh] flex-1 resize-none overflow-y-auto border-0 bg-transparent text-foreground shadow-none outline-none placeholder:text-muted-foreground"
            />
            {loading ? (
              <button
                type="button"
                onClick={() => void stopResponse()}
                className="chat-composer-action flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-red-400/15 text-red-300 hover:bg-red-400/25"
                title="Stop response"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  autoScrollRef.current = true
                  setShowJumpToLatest(false)
                  void sendMessage()
                }}
                disabled={!input.trim() && attachments.length === 0}
                className="chat-composer-action primary-action flex h-10 w-10 items-center justify-center rounded-full p-0 disabled:cursor-not-allowed disabled:opacity-40"
                title="Send message"
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-2 px-1">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowWritingTools((current) => !current)}
                aria-haspopup="menu"
                aria-expanded={showWritingTools}
                className="control-quiet flex min-h-8 items-center gap-1.5 px-2 py-1"
              >
                <WandSparkles className="h-3.5 w-3.5 text-violet-400" />
                Writing tools
                <ChevronDown className="h-3 w-3" />
              </button>
              {showWritingTools && (
                <div
                  className="native-popover absolute bottom-full left-0 z-40 mb-2 w-52 p-1.5"
                  role="menu"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowTemplates(true)
                      setShowWritingTools(false)
                    }}
                    className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-foreground hover:bg-secondary"
                  >
                    <Library className="h-4 w-4 text-muted-foreground" />
                    Prompt templates
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!input.trim() || enhancing || loading}
                    onClick={() => {
                      setShowWritingTools(false)
                      setEnhancing(true)
                      setEnhancedPrompt(null)
                      setEnhancementModel('')
                      void window.api
                        .enhancePrompt(
                          input,
                          activeSession.useKnowledgeBase ? activeSession.knowledgeBaseIds : []
                        )
                        .then((result) => {
                          setEnhancedPrompt(result.enhanced)
                          setEnhancementModel(result.model)
                        })
                        .finally(() => setEnhancing(false))
                    }}
                    className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-foreground hover:bg-secondary disabled:opacity-40"
                  >
                    {enhancing ? (
                      <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
                    ) : (
                      <WandSparkles className="h-4 w-4 text-violet-400" />
                    )}
                    Improve prompt
                  </button>
                </div>
              )}
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-1.5">
              {activeSession.useKnowledgeBase && (
                <div className="relative min-w-0">
                  <button
                    type="button"
                    onClick={() => setShowKnowledgeBases((current) => !current)}
                    className="chat-context-chip flex min-h-8 max-w-36 items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px]"
                    title="Choose knowledge bases"
                  >
                    <Database className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">
                      {selectedKnowledgeBases.length === knowledgeBases.length &&
                      knowledgeBases.length > 1
                        ? 'All knowledge bases'
                        : selectedKnowledgeBases.length === 1
                          ? selectedKnowledgeBases[0].name
                          : `${selectedKnowledgeBases.length} knowledge bases`}
                    </span>
                  </button>
                  {showKnowledgeBases && (
                    <div className="absolute bottom-full right-0 z-40 mb-2 w-64 rounded-lg border border-border bg-popover p-2 shadow-2xl">
                      <div className="flex items-start justify-between gap-3 px-2 pb-2">
                        <p className="text-[10px] text-muted-foreground">
                          Choose where RavnDock should look.
                        </p>
                        <button
                          type="button"
                          onClick={() => setShowKnowledgeBases(false)}
                          title="Close knowledge bases"
                          className="rounded p-0.5 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="max-h-48 space-y-1 overflow-y-auto">
                        {knowledgeBases.map((knowledgeBase) => {
                          const checked = activeSession.knowledgeBaseIds.includes(knowledgeBase.id)
                          return (
                            <button
                              key={knowledgeBase.id}
                              type="button"
                              onClick={() => {
                                const ids = checked
                                  ? activeSession.knowledgeBaseIds.filter(
                                      (id) => id !== knowledgeBase.id
                                    )
                                  : [...activeSession.knowledgeBaseIds, knowledgeBase.id]
                                if (ids.length > 0) setKnowledgeBaseIds(ids)
                              }}
                              className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-secondary"
                            >
                              <span
                                className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                                  checked ? 'selected-primary text-foreground' : 'border-white/20'
                                }`}
                              >
                                {checked && <Check className="h-3 w-3" />}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-xs text-foreground">
                                  {knowledgeBase.name}
                                </span>
                                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                                  {knowledgeBase.description || knowledgeBase.folder}
                                </span>
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="grid min-h-8 flex-shrink-0 grid-cols-2 rounded-md bg-white/[0.04] p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => {
                    setUseKnowledgeBase(false)
                    setShowKnowledgeBases(false)
                  }}
                  className={`rounded px-2.5 py-1 ${
                    !activeSession.useKnowledgeBase
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    Model only
                    <ChoiceHelp text="Chat with the AI without searching your files." />
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUseKnowledgeBase(true)
                    if (activeSession.knowledgeBaseIds.length === 0 && activeKnowledgeBaseId) {
                      setKnowledgeBaseIds([activeKnowledgeBaseId])
                    }
                  }}
                  className={`rounded px-2.5 py-1 ${
                    activeSession.useKnowledgeBase
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    Use files
                    <ChoiceHelp text="Search your selected knowledge bases and cite matching files." />
                  </span>
                </button>
              </div>
              <label className="flex min-h-8 min-w-0 items-center gap-1.5 rounded-md bg-white/[0.04] px-2.5 py-1">
                {switchingModel ? (
                  <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-primary" />
                ) : (
                  <BrainCircuit className="h-3 w-3 flex-shrink-0 text-primary" />
                )}
                <span className="sr-only">AI model</span>
                <select
                  value={selectedModel}
                  disabled={loading || switchingModel}
                  onChange={(event) => {
                    const model = event.target.value
                    setSwitchingModel(true)
                    void onModelSelected(model)
                      .catch(() => undefined)
                      .finally(() => setSwitchingModel(false))
                  }}
                  className="max-w-36 border-0 bg-transparent text-[11px] font-medium text-foreground shadow-none outline-none disabled:opacity-50"
                  title="Choose an installed model"
                >
                  {!models.some((model) => model.id === selectedModel) && (
                    <option value={selectedModel}>{selectedModel}</option>
                  )}
                  {models.map((model) => (
                    <option key={model.id} value={model.id} className="bg-card">
                      {model.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </footer>
      </main>
      {projectMenu && menuProject && (
        <div
          data-project-menu
          role="menu"
          className="fixed z-[90] w-52 overflow-hidden rounded-lg border border-border bg-popover p-1.5 text-[11px] shadow-2xl"
          style={{ left: projectMenu.x, top: projectMenu.y }}
        >
          <p className="truncate px-2 py-1.5 font-medium text-foreground" title={menuProject.name}>
            {menuProject.name}
          </p>
          {!menuProject.archivedAt && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                newChat({
                  projectId: menuProject.id,
                  knowledgeBaseIds: activeSession.knowledgeBaseIds,
                  useKnowledgeBase: activeSession.useKnowledgeBase
                })
                setCollapsedProjects((current) => {
                  const next = new Set(current)
                  next.delete(menuProject.id)
                  return next
                })
                setProjectMenu(null)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              New chat here
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const name = window.prompt('Rename this project', menuProject.name)
              if (name) renameProject(menuProject.id, name)
              setProjectMenu(null)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </button>
          <div className="my-1 border-t border-white/[0.07]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (menuProject.archivedAt) restoreProject(menuProject.id)
              else archiveProject(menuProject.id)
              setProjectMenu(null)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            {menuProject.archivedAt ? (
              <ArchiveRestore className="h-3.5 w-3.5" />
            ) : (
              <Archive className="h-3.5 w-3.5" />
            )}
            {menuProject.archivedAt ? 'Restore' : 'Archive'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (
                window.confirm(
                  `Delete the project "${menuProject.name}"? Its chats will move to Chats.`
                )
              ) {
                deleteProject(menuProject.id)
              }
              setProjectMenu(null)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-red-300 hover:bg-red-400/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete project
          </button>
        </div>
      )}
      {citationPreview && (
        <Modal
          open
          title={citationPreview.file}
          description={citationPreview.location}
          onClose={() => setCitationPreview(null)}
          width="max-w-xl"
        >
          <div className="p-4">
            <p className="mb-2 text-[11px] font-medium text-muted-foreground">
              Retrieved passage used for this response
            </p>
            <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {citationPreview.excerpt ||
                'This citation identifies the source location. A passage preview is available for new responses.'}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => {
                  setCitationActionMessage('')
                  void window.api
                    .openCitation(citationPreview.knowledgeBaseId, citationPreview.file)
                    .catch((error: unknown) =>
                      setCitationActionMessage(
                        friendlyActionError(error, 'macOS could not open this file.')
                      )
                    )
                }}
                className="flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-[11px] font-medium text-background"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open original
              </button>
              <button
                type="button"
                onClick={() => {
                  setCitationActionMessage('')
                  void window.api
                    .revealCitation(citationPreview.knowledgeBaseId, citationPreview.file)
                    .catch((error: unknown) =>
                      setCitationActionMessage(
                        friendlyActionError(error, 'macOS could not show this file.')
                      )
                    )
                }}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <FolderSearch className="h-3.5 w-3.5" />
                Show in Finder
              </button>
              {citationActionMessage && (
                <p className="w-full text-[10px] text-destructive" role="alert">
                  {citationActionMessage}
                </p>
              )}
            </div>
          </div>
        </Modal>
      )}
      {sessionMenu && menuSession && (
        <div
          data-session-menu
          role="menu"
          className="fixed z-[90] w-52 overflow-hidden rounded-lg border border-border bg-popover p-1.5 text-[11px] shadow-2xl"
          style={{ left: sessionMenu.x, top: sessionMenu.y }}
        >
          <p className="truncate px-2 py-1.5 font-medium text-foreground" title={menuSession.title}>
            {menuSession.title}
          </p>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const title = window.prompt('Rename this chat', menuSession.title)
              if (title) renameSession(menuSession.id, title)
              setSessionMenu(null)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </button>
          {!menuSession.archivedAt && (
            <>
              <div className="my-1 border-t border-white/[0.07]" />
              <p className="px-2 py-1 text-[9px] font-semibold uppercase text-muted-foreground/70">
                Move to project
              </p>
              <div className="max-h-32 overflow-y-auto">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    moveSessionToProject(menuSession.id, null)
                    setSessionMenu(null)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  Chats
                  {!menuSession.projectId && <Check className="ml-auto h-3 w-3 text-primary" />}
                </button>
                {activeProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      moveSessionToProject(menuSession.id, project.id)
                      setCollapsedProjects((current) => {
                        const next = new Set(current)
                        next.delete(project.id)
                        return next
                      })
                      setSessionMenu(null)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                  >
                    <FolderKanban className="h-3.5 w-3.5 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {menuSession.projectId === project.id && (
                      <Check className="h-3 w-3 text-primary" />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="my-1 border-t border-white/[0.07]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (menuSession.archivedAt) restoreSession(menuSession.id)
              else archiveSession(menuSession.id)
              setSessionMenu(null)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            {menuSession.archivedAt ? (
              <ArchiveRestore className="h-3.5 w-3.5" />
            ) : (
              <Archive className="h-3.5 w-3.5" />
            )}
            {menuSession.archivedAt ? 'Restore' : 'Archive'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (window.confirm(`Delete "${menuSession.title}"? This cannot be undone.`)) {
                deleteSession(menuSession.id)
              }
              setSessionMenu(null)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-red-300 hover:bg-red-400/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
