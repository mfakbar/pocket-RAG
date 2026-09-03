import { useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  CircleHelp,
  Cpu,
  Database,
  Download,
  FolderOpen,
  Loader2,
  ListTree,
  MessageSquare,
  RefreshCw,
  Settings,
  Wrench
} from 'lucide-react'
import {
  MODEL_PRESETS,
  type KnowledgeBase,
  type KnowledgeStaleness,
  type RuntimeStatus,
  type ModelPresetAssignments,
  type SyncProgress,
  type SyncResult
} from '../../../shared/contracts'
import { CreateKnowledgeBaseModal } from '../components/CreateKnowledgeBaseModal'
import { KnowledgeFilesModal } from '../components/KnowledgeFilesModal'
import { GradientButton, Panel } from '../components/ui'
import { BRAND, COLORS } from '../config/ui'
import { ThemeAwareAppIcon } from '../components/ui'
import { friendlyActionError } from '../lib/errors'

interface HomeScreenProps {
  onChat: () => void
  onResources: () => void
  onSettings: () => void
  onKnowledgeSettings: () => void
  onPrepareModels: () => void
  runtimeStatus: RuntimeStatus | null
  selectedModel: string
  modelPresets: ModelPresetAssignments
  knowledgeBases: KnowledgeBase[]
  activeKnowledgeBaseId: string
  onSynced: () => Promise<void>
  onModelSelected: () => Promise<void>
}

function runtimeStepLabel(step: string): string {
  if (step === 'rag-runtime') return 'RAG (Retrieval-Augmented Generation) Runtime'
  return step.replaceAll('-', ' ')
}

export default function HomeScreen({
  onChat,
  onResources,
  onSettings,
  onKnowledgeSettings,
  onPrepareModels,
  runtimeStatus,
  selectedModel,
  modelPresets,
  knowledgeBases,
  activeKnowledgeBaseId,
  onSynced,
  onModelSelected
}: HomeScreenProps): React.JSX.Element {
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  const [modelMessage, setModelMessage] = useState('')
  const [statusOpen, setStatusOpen] = useState(false)
  const [showAllKnowledgeBases, setShowAllKnowledgeBases] = useState(false)
  const [showCreateKnowledgeBase, setShowCreateKnowledgeBase] = useState(false)
  const [showKnowledgeFiles, setShowKnowledgeFiles] = useState(false)
  const [knowledgeMessage, setKnowledgeMessage] = useState('')
  const [staleness, setStaleness] = useState<KnowledgeStaleness | null>(null)
  const [stalenessKnowledgeBaseId, setStalenessKnowledgeBaseId] = useState('')
  const activeKnowledgeBase = knowledgeBases.find((item) => item.id === activeKnowledgeBaseId)
  const recentKnowledgeBases = [...knowledgeBases].sort((left, right) => {
    if (left.id === activeKnowledgeBaseId) return -1
    if (right.id === activeKnowledgeBaseId) return 1
    return (
      new Date(right.syncStats.lastSyncedAt ?? 0).getTime() -
      new Date(left.syncStats.lastSyncedAt ?? 0).getTime()
    )
  })
  const visibleKnowledgeBases = showAllKnowledgeBases
    ? recentKnowledgeBases
    : recentKnowledgeBases.slice(0, 3)

  useEffect(() => {
    if (!activeKnowledgeBaseId) return
    let active = true
    void window.api
      .getKnowledgeStaleness(activeKnowledgeBaseId)
      .then((result) => {
        if (active) {
          setStaleness(result)
          setStalenessKnowledgeBaseId(activeKnowledgeBaseId)
        }
      })
      .catch(() => {
        if (active) setStaleness(null)
      })
    return () => {
      active = false
    }
  }, [activeKnowledgeBaseId, activeKnowledgeBase?.syncStats.lastSyncedAt])

  const selectFolder = async (): Promise<void> => {
    try {
      const selected = await window.api.selectFolder()
      if (selected) {
        setSyncResult(null)
        await onSynced()
      }
    } catch (error) {
      setKnowledgeMessage(friendlyActionError(error, 'The folder could not be opened.'))
    }
  }

  const selectKnowledgeBase = async (id: string): Promise<void> => {
    if (id === activeKnowledgeBaseId) return
    try {
      await window.api.selectKnowledgeBase(id)
      setSyncResult(null)
      setKnowledgeMessage('')
      await onSynced()
    } catch (error) {
      setKnowledgeMessage(friendlyActionError(error, 'This knowledge base could not be opened.'))
    }
  }

  const handleSync = async (): Promise<void> => {
    if (!activeKnowledgeBase) {
      setKnowledgeMessage('Select a knowledge base before syncing.')
      return
    }
    setSyncing(true)
    setSyncResult(null)
    setSyncProgress(null)
    const unsubscribe = window.api.onSyncProgress(setSyncProgress)
    try {
      const result = await window.api.syncKnowledgeBase(activeKnowledgeBase.id)
      setSyncResult(result)
      await onSynced()
    } catch (error) {
      setSyncResult({
        ok: false,
        message: friendlyActionError(error, 'The folder could not be synced.'),
        indexed: activeKnowledgeBase.syncStats.indexed,
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: 0,
        skipped: 0,
        failed: 1,
        lastSyncedAt: activeKnowledgeBase.syncStats.lastSyncedAt,
        errors: []
      })
    } finally {
      unsubscribe()
      setSyncing(false)
    }
  }

  const selectModel = async (model: string): Promise<void> => {
    setModelMessage('Switching model...')
    try {
      await window.api.updateSettings({ selectedModel: model })
      await onModelSelected()
      setModelMessage('Model ready.')
    } catch (error) {
      setModelMessage(friendlyActionError(error, 'The model could not be changed.'))
    }
  }

  const documentsReady = (activeKnowledgeBase?.syncStats.indexed ?? 0) > 0
  const runtimeReady = runtimeStatus?.ready ?? false
  const aiReady =
    runtimeStatus?.components.ollama.state === 'ready' &&
    runtimeStatus.components.models.state === 'ready'
  const syncPercent =
    syncProgress && syncProgress.total > 0
      ? Math.min(100, Math.round((syncProgress.current / syncProgress.total) * 100))
      : null

  const primaryAction = !activeKnowledgeBase
    ? {
        title: 'Create knowledge base',
        description: 'Choose the folder you want RavnDock to use.',
        icon: FolderOpen,
        onClick: () => setShowCreateKnowledgeBase(true),
        disabled: false
      }
    : !aiReady
      ? {
          title: 'Prepare RavnDock',
          description: 'Finish preparing the local tools and model on this Mac.',
          icon: Download,
          onClick: onPrepareModels,
          disabled: false
        }
      : !documentsReady
        ? {
            title: syncing ? 'Syncing files' : 'Sync files',
            description: syncing
              ? 'RavnDock is preparing your selected documents.'
              : 'Prepare ' + activeKnowledgeBase.name + ' before you start chatting.',
            icon: syncing ? Loader2 : RefreshCw,
            onClick: () => void handleSync(),
            disabled: syncing || !runtimeReady
          }
        : {
            title: 'Start Chat',
            description: 'Chat with ' + activeKnowledgeBase.name + '.',
            icon: MessageSquare,
            onClick: onChat,
            disabled: false
          }
  const PrimaryIcon = primaryAction.icon

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto p-5">
      <div className="mb-6 flex items-start">
        <div>
          <div className="mb-1 flex items-center gap-3">
            <ThemeAwareAppIcon alt="RavnDock" className="h-8 w-8 rounded-lg" />
            <h1 className="text-xl font-semibold text-foreground">RavnDock</h1>
          </div>
          <p className="ml-11 text-xs text-muted-foreground">Your local knowledge assistant</p>
        </div>
      </div>

      <GradientButton
        onClick={primaryAction.onClick}
        disabled={primaryAction.disabled}
        className="home-primary-action group mb-4 w-full rounded-xl p-4 text-left disabled:cursor-not-allowed disabled:opacity-45"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="mb-1 text-base font-semibold text-primary-foreground">
              {primaryAction.title}
            </div>
            <div className="text-xs text-primary-foreground/75">{primaryAction.description}</div>
          </div>
          <div className="primary-icon-tile flex h-10 w-10 items-center justify-center rounded-lg">
            <PrimaryIcon className={'h-5 w-5 text-primary ' + (syncing ? 'animate-spin' : '')} />
          </div>
        </div>
      </GradientButton>

      <Panel className="mb-3 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Your Knowledge Base
            </span>
          </div>
          {knowledgeBases.length > 0 && (
            <button
              type="button"
              onClick={onKnowledgeSettings}
              className="text-[11px] font-medium text-primary hover:text-primary"
            >
              Manage
            </button>
          )}
        </div>

        {knowledgeBases.length === 0 ? (
          <div className="rounded-lg border border-primary/20 bg-primary/10 p-4 text-center">
            <p className="text-sm font-medium text-foreground">Add your first knowledge base</p>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
              Choose a folder and tell RavnDock what the files are about.
            </p>
            <button
              type="button"
              onClick={() => setShowCreateKnowledgeBase(true)}
              className="primary-action mx-auto mt-3 flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-xs font-medium"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Create knowledge base
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              {visibleKnowledgeBases.map((knowledgeBase) => {
                const selected = knowledgeBase.id === activeKnowledgeBaseId
                return (
                  <button
                    key={knowledgeBase.id}
                    type="button"
                    onClick={() => void selectKnowledgeBase(knowledgeBase.id)}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left ${
                      selected
                        ? 'selected-primary'
                        : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {knowledgeBase.name}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {knowledgeBase.description}
                      </span>
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {knowledgeBase.syncStats.indexed} files
                    </span>
                    {selected && <CheckCircle className="h-3.5 w-3.5 text-primary" />}
                  </button>
                )
              })}
            </div>
            {knowledgeBases.length > 3 && (
              <button
                type="button"
                onClick={() => setShowAllKnowledgeBases((current) => !current)}
                className="mt-2 text-[11px] font-medium text-primary hover:text-primary"
              >
                {showAllKnowledgeBases ? 'Show recent' : `More (${knowledgeBases.length - 3})`}
              </button>
            )}
            {activeKnowledgeBase ? (
              <div className="mt-3 border-t border-white/[0.07] pt-3">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1 truncate rounded-lg bg-white/[0.04] px-3 py-2 text-[11px] text-muted-foreground">
                    {activeKnowledgeBase.folder}
                  </div>
                  <button
                    type="button"
                    onClick={() => void selectFolder()}
                    className="secondary-action rounded-lg px-3 py-2 text-[11px] font-medium"
                  >
                    Change folder
                  </button>
                </div>
                {activeKnowledgeBase.syncStats.indexed > 0 && (
                  <div className="mt-2 flex items-center gap-2">
                    <CheckCircle className="h-3 w-3 status-success-icon" />
                    <span className="text-xs status-success-text">
                      {activeKnowledgeBase.syncStats.indexed} document
                      {activeKnowledgeBase.syncStats.indexed === 1 ? '' : 's'} ready
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowKnowledgeFiles(true)}
                      className="flex items-center gap-1 text-[11px] font-medium text-primary hover:text-primary"
                    >
                      <ListTree className="h-3 w-3" />
                      View files
                    </button>
                  </div>
                )}
                {staleness?.stale && stalenessKnowledgeBaseId === activeKnowledgeBaseId && (
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-300">
                    <AlertTriangle className="h-3 w-3" />
                    This folder may have changed. Sync to use the latest files.
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-3 text-xs text-amber-200">Select a knowledge base before syncing.</p>
            )}
          </>
        )}
        {knowledgeMessage && (
          <p role="status" className="status-message status-message-success mt-2">
            {knowledgeMessage}
          </p>
        )}
      </Panel>

      <button
        onClick={() => void handleSync()}
        disabled={syncing || !activeKnowledgeBase || !runtimeReady}
        className="mb-3 w-full rounded-xl p-4 text-left transition-all hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: BRAND.panel, border: COLORS.borderSoft }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {syncing ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : syncResult?.ok && syncResult.indexed > 0 ? (
              <CheckCircle className="h-4 w-4 status-success-icon" />
            ) : syncResult?.ok ? (
              <AlertTriangle className="h-4 w-4 text-amber-400" />
            ) : (
              <RefreshCw className="h-4 w-4 text-primary" />
            )}
            <span className="text-sm font-medium text-foreground">
              {syncing
                ? syncProgress?.message || 'Scanning the selected folder...'
                : syncResult?.message ||
                  (activeKnowledgeBase
                    ? `Sync ${activeKnowledgeBase.name}`
                    : 'Select a knowledge base')}
            </span>
          </div>
          {!syncing && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
        {!syncing && !syncResult && (
          <p className="ml-6 mt-1 text-xs text-muted-foreground">
            Process only new and changed files
          </p>
        )}
        {syncing && syncProgress && syncProgress.total > 0 && (
          <p className="ml-6 mt-1 text-xs text-muted-foreground">
            {syncProgress.current} of {syncProgress.total}
          </p>
        )}
        {syncing && (
          <div
            className="ml-6 mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-label="Document sync progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={syncPercent ?? undefined}
          >
            <div
              className={`h-full rounded-full bg-primary transition-[width] duration-300 ${
                syncPercent === null ? 'animate-pulse' : ''
              }`}
              style={{ width: `${syncPercent ?? 32}%` }}
            />
          </div>
        )}
        {syncResult?.ok && (
          <p className="ml-6 mt-1 text-xs text-muted-foreground">
            {syncResult.added} added · {syncResult.updated} updated · {syncResult.unchanged}{' '}
            unchanged
            {syncResult.lastSyncedAt ? ' · Last sync complete' : ''}
          </p>
        )}
        {syncResult && !syncResult.ok && (
          <p className="ml-6 mt-1 text-xs text-red-300" role="alert">
            {syncResult.errors[0]?.message ??
              'Check that the folder is available, then try syncing again.'}
          </p>
        )}
      </button>

      <Panel className="mb-3 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Cpu className="h-4 w-4 text-primary" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Model
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {MODEL_PRESETS.map((preset) => {
            const assignedModel = modelPresets[preset.id]
            const selected = selectedModel.toLowerCase() === assignedModel.toLowerCase()
            const missing = runtimeStatus?.missingModels.some(
              (model) => model.toLowerCase() === assignedModel.toLowerCase()
            )
            return (
              <button
                key={preset.id}
                type="button"
                disabled={missing}
                onClick={() => void selectModel(assignedModel)}
                title={missing ? 'Prepare this model before using it.' : preset.description}
                className={`min-w-0 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  selected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-white/[0.04] text-muted-foreground hover:bg-white/[0.07] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40'
                }`}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
        <div className="mt-3 flex items-center justify-between gap-4 text-xs">
          <span className="text-muted-foreground">
            {MODEL_PRESETS.find(
              (preset) => modelPresets[preset.id].toLowerCase() === selectedModel.toLowerCase()
            )?.description ?? 'Your chosen Ollama model.'}
          </span>
          <span className="max-w-[48%] truncate font-mono text-primary">{selectedModel}</span>
        </div>
        {modelMessage && (
          <p role="status" className="status-message native-subtle mt-2 text-muted-foreground">
            {modelMessage}
          </p>
        )}
        {runtimeStatus?.missingModels.some((model) =>
          MODEL_PRESETS.some(
            (preset) => modelPresets[preset.id].toLowerCase() === model.toLowerCase()
          )
        ) && (
          <button
            type="button"
            onClick={onPrepareModels}
            className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-primary hover:text-primary"
          >
            <Download className="h-3 w-3" />
            Add another model
          </button>
        )}
      </Panel>

      <div className="mt-1 flex items-center justify-center gap-2 border-t border-white/[0.07] pt-3">
        <button
          onClick={onResources}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
        >
          <Activity className="h-3.5 w-3.5 text-primary" />
          Monitor
        </button>
        <span className="h-4 w-px bg-white/10" />
        <button
          onClick={onSettings}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
        >
          <Settings className="h-3.5 w-3.5" />
          Settings
        </button>
      </div>

      {statusOpen && runtimeStatus && (
        <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] p-3">
          <div className="space-y-1.5">
            {Object.entries(runtimeStatus.components).map(([name, component]) => (
              <div key={name} className="flex items-start justify-between gap-4 text-[11px]">
                <span className="capitalize text-muted-foreground">{runtimeStepLabel(name)}</span>
                <span
                  className={`text-right ${component.state === 'ready' ? 'text-emerald-300' : 'text-amber-200'}`}
                >
                  {component.message}
                </span>
              </div>
            ))}
          </div>
          {!runtimeReady && (
            <button
              type="button"
              onClick={onPrepareModels}
              className="mt-3 flex items-center gap-1.5 rounded-md bg-amber-400/15 px-2.5 py-1.5 text-[11px] font-medium text-amber-100"
            >
              <Wrench className="h-3 w-3" />
              Repair setup
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setStatusOpen((current) => !current)}
        className="mt-auto flex items-center justify-center gap-2 rounded-md pt-3 text-xs text-muted-foreground hover:text-foreground"
      >
        <div
          className={`h-2 w-2 rounded-full ${runtimeReady ? 'status-ready-dot' : 'bg-amber-400'}`}
        />
        <span>{runtimeReady ? 'Ready on this Mac' : 'Setup needs attention'}</span>
        <CircleHelp className="h-3.5 w-3.5" />
      </button>
      <CreateKnowledgeBaseModal
        open={showCreateKnowledgeBase}
        onClose={() => setShowCreateKnowledgeBase(false)}
        onCreated={async () => {
          setKnowledgeMessage('Your knowledge base is ready. Select Sync to prepare the files.')
          await onSynced()
        }}
      />
      <KnowledgeFilesModal
        open={showKnowledgeFiles}
        knowledgeBase={activeKnowledgeBase ?? null}
        onClose={() => setShowKnowledgeFiles(false)}
      />
    </div>
  )
}
