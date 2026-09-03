import { useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  House,
  Info,
  Loader2,
  Lock,
  MessageSquare,
  Moon,
  Settings,
  Sun
} from 'lucide-react'
import { useAppState } from './hooks/useAppState'
import { useChat } from './hooks/useChat'
import { useResourceHistory } from './hooks/useResourceHistory'
import type { AppearanceMode } from '../../shared/contracts'
import { readLocalValue, writeLocalValue } from './lib/storage'
import { Modal, ThemeAwareAppIcon } from './components/ui'
import {
  ChatView,
  FolderSetupScreen,
  HomeScreen,
  PreparingScreen,
  ResourceMonitor,
  SettingsView,
  WelcomeScreen
} from './screens'

function loadAppearance(): AppearanceMode {
  const saved = readLocalValue('pocketai.theme')
  return saved === 'system' || saved === 'light' || saved === 'dark' ? saved : 'light'
}

export default function App(): React.JSX.Element {
  const [focusKnowledgeSettings, setFocusKnowledgeSettings] = useState(false)
  const [monitorReturn, setMonitorReturn] = useState<'home' | 'chat'>('home')
  const [settingsReturn, setSettingsReturn] = useState<'home' | 'chat'>('home')
  const [aboutOpen, setAboutOpen] = useState(false)
  const [, setChatTitle] = useState('New chat')
  const [readingMode, setReadingMode] = useState<'compact' | 'comfortable'>(
    () =>
      (readLocalValue('pocketai.reading-mode') as 'compact' | 'comfortable' | null) ?? 'comfortable'
  )
  const [theme, setTheme] = useState<AppearanceMode>(loadAppearance)
  const [syncCompletionMessage, setSyncCompletionMessage] = useState('')
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  const {
    initialized,
    startupError,
    startupProgress,
    view,
    setView,
    settings,
    runtimeStatus,
    knowledgeSync,
    setKnowledgeFolder,
    refreshSettings,
    refreshRuntimeStatus
  } = useAppState()
  const chat = useChat(settings.activeKnowledgeBaseId)
  const resources = useResourceHistory()

  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => setSystemDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
    document.documentElement.classList.toggle('light-mode', resolvedTheme === 'light')
    document.documentElement.classList.toggle('dark-mode', resolvedTheme === 'dark')
    document.documentElement.dataset.theme = resolvedTheme
    writeLocalValue('pocketai.theme', theme)
    void window.api.setAppearance(theme).catch(() => undefined)
  }, [resolvedTheme, theme])
  useEffect(() => {
    writeLocalValue('pocketai.reading-mode', readingMode)
  }, [readingMode])

  useEffect(() => {
    if (knowledgeSync.progress?.phase !== 'complete') return
    const showTimer = window.setTimeout(() => {
      setSyncCompletionMessage(
        knowledgeSync.progress?.message || 'Your documents are ready to use.'
      )
      void refreshSettings()
    }, 0)
    const hideTimer = window.setTimeout(() => setSyncCompletionMessage(''), 5_000)
    return () => {
      window.clearTimeout(showTimer)
      window.clearTimeout(hideTimer)
    }
  }, [knowledgeSync.progress?.message, knowledgeSync.progress?.phase, refreshSettings])

  useEffect(
    () =>
      window.api.onAppCommand((command) => {
        if (command === 'about') {
          setAboutOpen(true)
          return
        }
        if (!['home', 'chat', 'resources', 'settings'].includes(view)) return
        if (command === 'new-chat') {
          chat.newChat()
          setView('chat')
        } else if (command === 'home' || command === 'chat') {
          setView(command)
        } else if (command === 'monitor') {
          setMonitorReturn(view === 'chat' ? 'chat' : 'home')
          setView('resources')
        } else if (command === 'settings') {
          setSettingsReturn(view === 'chat' ? 'chat' : 'home')
          setFocusKnowledgeSettings(false)
          setView('settings')
        }
      }),
    [chat, setView, view]
  )

  const showNavigation = ['home', 'chat', 'resources', 'settings'].includes(view)
  const chatTitle = chat.activeSession?.title || 'New chat'
  const syncPercent =
    knowledgeSync.progress && knowledgeSync.progress.total > 0
      ? Math.min(
          100,
          Math.round((knowledgeSync.progress.current / knowledgeSync.progress.total) * 100)
        )
      : 33

  if (!initialized) {
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <div className="drag-region h-10 w-full flex-shrink-0" />
        <div className="flex flex-1 items-center justify-center px-8">
          <div className="w-full max-w-md text-center">
            <div className="soft-primary-card mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
            <h1 className="text-xl font-semibold text-foreground">{startupProgress.title}</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {startupProgress.description}
            </p>
            <div
              className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/10"
              role="progressbar"
              aria-label="RavnDock startup progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={startupProgress.progress}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${startupProgress.progress}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              RavnDock is checking what it needs to run privately on your Mac.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (startupError) {
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <div className="drag-region h-10 w-full flex-shrink-0" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <AlertTriangle className="h-7 w-7 text-amber-400" />
          <h1 className="text-lg font-semibold">RavnDock could not start</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            RavnDock could not finish opening its local tools.
          </p>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            Try again first. If it still does not open, restart RavnDock and check that you have
            free storage for local models.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
          >
            Try again
          </button>
          <details className="max-w-md text-left text-xs text-muted-foreground">
            <summary className="cursor-pointer">Technical details</summary>
            <p className="mt-1 break-words">{startupError}</p>
          </details>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`app-shell ${resolvedTheme === 'dark' ? 'dark-mode' : 'light-mode'} ${readingMode === 'comfortable' ? 'reading-comfortable' : 'reading-compact'} flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground`}
    >
      <div className="app-titlebar drag-region grid h-12 w-full flex-shrink-0 grid-cols-[260px_minmax(0,1fr)_auto] items-center px-3">
        <div />
        {view === 'chat' ? (
          <div className="chat-titlebar-title pointer-events-none min-w-0">
            <span className="max-w-[42vw] truncate text-xs font-semibold tracking-[0.01em] text-foreground">
              {chatTitle}
            </span>
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-2">
            <ThemeAwareAppIcon alt="RavnDock" className="h-4 w-4 rounded-[4px]" />
            <span className="text-xs font-semibold tracking-[0.01em] text-foreground">
              RavnDock
            </span>
          </div>
        )}
        <div className="no-drag flex items-center justify-end gap-1 pr-1">
          {showNavigation && (
            <>
              <button
                type="button"
                onClick={() => setView('home')}
                aria-label="Home"
                aria-current={view === 'home' ? 'page' : undefined}
                className="native-titlebar-button"
                data-active={view === 'home'}
              >
                <House className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setView('chat')}
                aria-label="Chat"
                aria-current={view === 'chat' ? 'page' : undefined}
                className="native-titlebar-button"
                data-active={view === 'chat'}
              >
                <MessageSquare className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setView('resources')}
                aria-label="Monitor"
                className="native-titlebar-button"
                data-active={view === 'resources'}
              >
                <Activity className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setView('settings')}
                aria-label="Settings"
                aria-current={view === 'settings' ? 'page' : undefined}
                className="native-titlebar-button"
                data-active={view === 'settings'}
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
              <span className="mx-1 h-4 w-px bg-border" />
            </>
          )}
          <button
            type="button"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="native-titlebar-button"
          >
            {resolvedTheme === 'dark' ? (
              <Sun className="h-3.5 w-3.5" />
            ) : (
              <Moon className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setAboutOpen(true)}
            aria-label="About RavnDock"
            className="native-titlebar-button"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          <div
            className="ml-1 flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground"
            title="Your documents and questions stay on this Mac."
            aria-label="Private: your documents and questions stay on this Mac"
          >
            <Lock className="h-3.5 w-3.5" />
            <span>Private</span>
          </div>
        </div>
      </div>

      {knowledgeSync.active && view !== 'preparing' && (
        <div
          className="no-drag flex-shrink-0 border-y border-primary/20 bg-primary/10 px-4 py-2"
          role="status"
          aria-live="polite"
        >
          <div className="mx-auto flex max-w-3xl items-center gap-3 text-[11px] text-primary">
            <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-primary" />
            <span className="min-w-0 flex-1 truncate">
              {knowledgeSync.progress?.message ?? 'Preparing your documents in the background...'}
            </span>
            {knowledgeSync.progress?.total ? (
              <span className="flex-shrink-0 tabular-nums text-primary">
                {knowledgeSync.progress.current} of {knowledgeSync.progress.total}
              </span>
            ) : null}
          </div>
          <div
            className="mx-auto mt-1.5 h-1 max-w-3xl overflow-hidden rounded-full bg-secondary"
            role="progressbar"
            aria-label="Document sync progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={syncPercent}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: syncPercent + '%' }}
            />
          </div>
        </div>
      )}

      {!knowledgeSync.active && syncCompletionMessage && view !== 'preparing' && (
        <div
          className="no-drag flex flex-shrink-0 items-center justify-center gap-2 border-b border-[color-mix(in_srgb,var(--status-success)_18%,transparent)] bg-[var(--status-success-surface)] px-4 py-2 text-[11px] text-[var(--status-success)]"
          role="status"
          aria-live="polite"
        >
          <CheckCircle className="h-3.5 w-3.5" />
          <span>{syncCompletionMessage}</span>
        </div>
      )}

      <div className="flex min-h-0 w-full flex-1 flex-col bg-background">
        <div
          key={view}
          className="screen-enter min-h-0 w-full flex-1 overflow-hidden bg-background"
        >
          {view === 'welcome' && (
            <WelcomeScreen
              workspaceReady={settings.knowledgeBases.length > 0}
              onBegin={() => setView(settings.knowledgeBases.length > 0 ? 'home' : 'folder-setup')}
            />
          )}
          {view === 'folder-setup' && (
            <FolderSetupScreen
              knowledgeFolder={settings.knowledgeFolder}
              hasKnowledgeBase={settings.knowledgeBases.length > 0}
              setKnowledgeFolder={setKnowledgeFolder}
              onCreated={refreshSettings}
              onBack={() => setView('welcome')}
              onContinue={() => setView('preparing')}
            />
          )}
          {view === 'preparing' && (
            <PreparingScreen
              knowledgeFolder={settings.knowledgeFolder}
              onChooseFolder={() => setView('folder-setup')}
              onReady={() => {
                void Promise.all([refreshSettings(), refreshRuntimeStatus()])
                setView('home')
              }}
            />
          )}
          {view === 'home' && (
            <HomeScreen
              onChat={() => {
                chat.newChat({
                  knowledgeBaseIds: settings.activeKnowledgeBaseId
                    ? [settings.activeKnowledgeBaseId]
                    : [],
                  useKnowledgeBase: Boolean(settings.activeKnowledgeBaseId),
                  projectId: null
                })
                setView('chat')
              }}
              onResources={() => {
                setMonitorReturn('home')
                setView('resources')
              }}
              onSettings={() => {
                setSettingsReturn('home')
                setFocusKnowledgeSettings(false)
                setView('settings')
              }}
              onKnowledgeSettings={() => {
                setSettingsReturn('home')
                setFocusKnowledgeSettings(true)
                setView('settings')
              }}
              onPrepareModels={() => setView('preparing')}
              runtimeStatus={runtimeStatus}
              selectedModel={settings.selectedModel}
              modelPresets={settings.modelPresets}
              knowledgeBases={settings.knowledgeBases}
              activeKnowledgeBaseId={settings.activeKnowledgeBaseId}
              onSynced={refreshSettings}
              onModelSelected={refreshSettings}
            />
          )}
          {view === 'chat' && (
            <ChatView
              onBack={() => setView('home')}
              onMonitor={() => {
                setMonitorReturn('chat')
                setView('resources')
              }}
              onSettings={() => {
                setSettingsReturn('chat')
                setFocusKnowledgeSettings(false)
                setView('settings')
              }}
              knowledgeBases={settings.knowledgeBases}
              activeKnowledgeBaseId={settings.activeKnowledgeBaseId}
              selectedModel={settings.selectedModel}
              onModelSelected={async (model) => {
                await window.api.updateSettings({ selectedModel: model })
                await refreshSettings()
              }}
              chat={chat}
              resourceHistory={resources.history}
              onTitleChange={setChatTitle}
            />
          )}
          {view === 'resources' && (
            <ResourceMonitor {...resources} onBack={() => setView(monitorReturn)} />
          )}
          {view === 'settings' && (
            <SettingsView
              onBack={() => setView(settingsReturn)}
              settings={settings}
              setKnowledgeFolder={setKnowledgeFolder}
              onSettingsChanged={refreshSettings}
              focusKnowledge={focusKnowledgeSettings}
              readingMode={readingMode}
              onReadingModeChange={setReadingMode}
            />
          )}
        </div>
      </div>
      <Modal
        open={aboutOpen}
        title="About RavnDock"
        onClose={() => setAboutOpen(false)}
        width="max-w-lg"
      >
        <div className="space-y-4 px-5 py-5 text-sm leading-relaxed text-muted-foreground">
          <div>
            <p className="font-medium text-foreground">Hi!</p>
            <p className="mt-2">
              I’m Akbar, a data center and AI infrastructure consultant based in Indonesia.
            </p>
          </div>
          <p>
            RavnDock was originally created as a showcase and conversation starter for my clients.
            It turns out there is a common need shared by family and friends: a private, local
            document chatbot that is simple and completely free to use. You do not need to be
            tech-savvy. Just select a folder and start chatting.
          </p>
          <p>
            Not every use case needs a frontier model. RavnDock is designed for everyday Macs,
            including my 2021 MacBook Pro M1, so you can chat with your own files without needing a
            high-end GPU.
          </p>
          <p>I hope RavnDock is useful to you. Any feedback is always welcome.</p>
          <div className="border-t border-border pt-3 text-xs">
            <p>
              Contact:{' '}
              <a className="text-primary hover:underline" href="mailto:muakbar@cisco.com">
                muakbar@cisco.com
              </a>{' '}
              ·{' '}
              <a className="text-primary hover:underline" href="mailto:mfa.akbar@gmail.com">
                mfa.akbar@gmail.com
              </a>
            </p>
            <p className="mt-1">© 2026 Muhammad Fadhillah Akbar · RavnDock 1.1.0</p>
          </div>
        </div>
      </Modal>
    </div>
  )
}
