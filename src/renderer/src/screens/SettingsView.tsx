import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  Download,
  FolderPlus,
  FileText,
  Loader2,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  MODEL_PRESETS,
  type AppSettings,
  type DeviceModelRecommendations,
  type KnowledgeStaleness,
  type ModelOption,
  type ModelOperationProgress,
  type ModelPresetId,
  type ModelSizeAssessment,
  type SyncProgress
} from '../../../shared/contracts'
import { CreateKnowledgeBaseModal } from '../components/CreateKnowledgeBaseModal'
import { InstalledModelsModal } from '../components/InstalledModelsModal'
import { KnowledgeFilesModal } from '../components/KnowledgeFilesModal'
import { Panel } from '../components/ui'
import { formatBytes, formatDateTime } from '../lib/format'
import { friendlyActionError } from '../lib/errors'
import AdvancedSettingsView from './AdvancedSettingsView'

export default function SettingsView({
  onBack,
  settings,
  setKnowledgeFolder,
  onSettingsChanged,
  focusKnowledge,
  readingMode,
  onReadingModeChange
}: {
  onBack: () => void
  settings: AppSettings
  setKnowledgeFolder: (folder: string) => void
  onSettingsChanged: () => Promise<void>
  focusKnowledge: boolean
  readingMode: 'compact' | 'comfortable'
  onReadingModeChange: (mode: 'compact' | 'comfortable') => void
}): React.JSX.Element {
  const [advanced, setAdvanced] = useState(false)
  const [showKnowledgeAdvanced, setShowKnowledgeAdvanced] = useState(false)
  const [showCreateKnowledgeBase, setShowCreateKnowledgeBase] = useState(false)
  const [showKnowledgeFiles, setShowKnowledgeFiles] = useState(false)
  const [showInstalledModels, setShowInstalledModels] = useState(false)
  const [knowledgeName, setKnowledgeName] = useState('')
  const [knowledgeDescription, setKnowledgeDescription] = useState('')
  const [knowledgeInstructions, setKnowledgeInstructions] = useState('')
  const [knowledgeMessage, setKnowledgeMessage] = useState('')
  const [recommendations, setRecommendations] = useState<DeviceModelRecommendations | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [modelMessage, setModelMessage] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [assessment, setAssessment] = useState<ModelSizeAssessment | null>(null)
  const [approvedWarning, setApprovedWarning] = useState('')
  const [modelProgress, setModelProgress] = useState<ModelOperationProgress | null>(null)
  const [modelBusy, setModelBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  const [syncMessage, setSyncMessage] = useState<{
    text: string
    state: 'success' | 'error'
  } | null>(null)
  const [staleness, setStaleness] = useState<KnowledgeStaleness | null>(null)
  const [stalenessKnowledgeBaseId, setStalenessKnowledgeBaseId] = useState('')
  const knowledgeRef = useRef<HTMLDivElement>(null)
  const activeKnowledgeBase = settings.knowledgeBases.find(
    (knowledgeBase) => knowledgeBase.id === settings.activeKnowledgeBaseId
  )

  useEffect(() => {
    if (!settings.activeKnowledgeBaseId) return
    let active = true
    void window.api
      .getKnowledgeStaleness(settings.activeKnowledgeBaseId)
      .then((result) => {
        if (active) {
          setStaleness(result)
          setStalenessKnowledgeBaseId(settings.activeKnowledgeBaseId)
        }
      })
      .catch(() => {
        if (active) setStaleness(null)
      })
    return () => {
      active = false
    }
  }, [settings.activeKnowledgeBaseId, activeKnowledgeBase?.syncStats.lastSyncedAt])

  useEffect(() => {
    void window.api
      .listModels()
      .then(setModels)
      .catch((error: unknown) =>
        setModelMessage(friendlyActionError(error, 'Models could not be loaded.'))
      )
      .finally(() => setLoadingModels(false))
  }, [])

  useEffect(() => {
    void window.api
      .getDeviceModelRecommendations()
      .then(setRecommendations)
      .catch(() => setRecommendations(null))
  }, [])

  useEffect(() => {
    let current = true
    queueMicrotask(() => {
      if (!current) return
      setKnowledgeName(activeKnowledgeBase?.name ?? '')
      setKnowledgeDescription(activeKnowledgeBase?.description ?? '')
      setKnowledgeInstructions(activeKnowledgeBase?.customInstructions ?? '')
      setShowKnowledgeAdvanced(false)
    })
    return () => {
      current = false
    }
  }, [
    activeKnowledgeBase?.customInstructions,
    activeKnowledgeBase?.description,
    activeKnowledgeBase?.id,
    activeKnowledgeBase?.name
  ])

  useEffect(() => {
    if (focusKnowledge && !advanced) {
      window.setTimeout(() => knowledgeRef.current?.scrollIntoView({ behavior: 'smooth' }), 0)
    }
  }, [advanced, focusKnowledge])

  const selectFolder = async (): Promise<void> => {
    try {
      const selected = await window.api.selectFolder()
      if (selected) {
        setKnowledgeFolder(selected)
        setKnowledgeMessage('Folder updated. Sync when you are ready.')
        await onSettingsChanged()
      }
    } catch (error) {
      setKnowledgeMessage(friendlyActionError(error, 'The folder could not be opened.'))
    }
  }

  const selectKnowledgeBase = async (id: string): Promise<void> => {
    if (id === settings.activeKnowledgeBaseId) return
    try {
      await window.api.selectKnowledgeBase(id)
      setKnowledgeMessage('')
      await onSettingsChanged()
    } catch (error) {
      setKnowledgeMessage(friendlyActionError(error, 'This knowledge base could not be opened.'))
    }
  }

  const saveKnowledgeDetails = async (): Promise<void> => {
    if (!activeKnowledgeBase) return
    if (!knowledgeDescription.trim()) {
      setKnowledgeMessage('Add a short description so RavnDock understands these files.')
      return
    }
    try {
      await window.api.updateKnowledgeBase(activeKnowledgeBase.id, {
        name: knowledgeName.trim(),
        description: knowledgeDescription.trim(),
        customInstructions: knowledgeInstructions.trim()
      })
      setKnowledgeMessage('Knowledge base details saved.')
      await onSettingsChanged()
    } catch (error) {
      setKnowledgeMessage(friendlyActionError(error, 'These details could not be saved.'))
    }
  }

  const removeKnowledgeBase = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`Remove "${name}" from RavnDock? Your original files will not change.`)) {
      return
    }
    try {
      await window.api.removeKnowledgeBase(id)
      setKnowledgeMessage(`${name} was removed. Your original files were not changed.`)
      await onSettingsChanged()
    } catch (error) {
      setKnowledgeMessage(friendlyActionError(error, 'This knowledge base could not be removed.'))
    }
  }

  const syncKnowledgeBase = async (): Promise<void> => {
    if (!activeKnowledgeBase || syncing) return
    setSyncing(true)
    setSyncProgress(null)
    setSyncMessage(null)
    const unsubscribe = window.api.onSyncProgress(setSyncProgress)
    try {
      const result = await window.api.syncKnowledgeBase(settings.activeKnowledgeBaseId)
      setSyncMessage({
        text: result.ok
          ? result.added +
            ' added · ' +
            result.updated +
            ' updated · ' +
            result.unchanged +
            ' unchanged'
          : `${result.failed} file${result.failed === 1 ? '' : 's'} could not be synced. Review the file details below, then retry.`,
        state: result.ok ? 'success' : 'error'
      })
      await onSettingsChanged()
    } catch (error) {
      setSyncMessage({
        text: friendlyActionError(error, 'Your documents could not be synced.'),
        state: 'error'
      })
    } finally {
      unsubscribe()
      setSyncing(false)
    }
  }

  const selectModel = async (model: string): Promise<void> => {
    if (!model || model === settings.selectedModel) return
    setModelMessage('Switching model...')
    try {
      const result = await window.api.updateSettings({ selectedModel: model })
      setModelMessage(result.message)
      await onSettingsChanged()
    } catch (error) {
      setModelMessage(friendlyActionError(error, 'The model could not be selected.'))
    }
  }

  const assignPreset = async (presetId: ModelPresetId, model: string): Promise<void> => {
    const previous = settings.modelPresets[presetId]
    setModelMessage('Saving model choice...')
    try {
      const result = await window.api.updateSettings({
        modelPresets: { [presetId]: model },
        selectedModel:
          settings.selectedModel.toLowerCase() === previous.toLowerCase() ? model : undefined
      })
      setModelMessage(result.message)
      await onSettingsChanged()
    } catch (error) {
      setModelMessage(friendlyActionError(error, 'This choice could not be saved.'))
    }
  }

  const downloadCustomModel = async (): Promise<void> => {
    const model = customModel.trim()
    if (!model) return
    setModelBusy(true)
    setModelMessage('Checking this model...')
    try {
      const nextAssessment = await window.api.assessModel(model)
      setAssessment(nextAssessment)
      if (nextAssessment.level !== 'ok' && approvedWarning !== model) {
        setApprovedWarning(model)
        setModelMessage('Review the size warning, then choose Download anyway.')
        return
      }

      const unsubscribe = window.api.onModelProgress(setModelProgress)
      try {
        setModels(await window.api.downloadModel(model))
        setModelMessage(`${model} is ready.`)
        setCustomModel('')
        setAssessment(null)
        setApprovedWarning('')
      } finally {
        unsubscribe()
      }
    } catch (error) {
      setModelMessage(friendlyActionError(error, 'The model could not be downloaded.'))
    } finally {
      setModelBusy(false)
    }
  }

  const deleteModel = async (model: string): Promise<void> => {
    if (!window.confirm(`Delete ${model} from this Mac? You can download it again later.`)) return
    setModelMessage(`Deleting ${model}...`)
    try {
      const result = await window.api.deleteModel(model)
      setModels((current) => current.filter((item) => item.id !== model))
      setModelMessage(result.message)
      await onSettingsChanged()
    } catch (error) {
      setModelMessage(friendlyActionError(error, 'The model could not be deleted.'))
    }
  }

  const cancelModelDownload = async (): Promise<void> => {
    const model = modelProgress?.model ?? customModel.trim()
    if (!model) return
    const cancelled = await window.api.cancelModelDownload(model)
    if (cancelled) {
      setModelMessage('Download cancelled. You can start it again whenever you are ready.')
      setModelProgress((current) =>
        current ? { ...current, state: 'cancelled', message: 'Download cancelled.' } : current
      )
    }
  }

  if (advanced) {
    return (
      <AdvancedSettingsView
        settings={settings}
        onBack={() => setAdvanced(false)}
        onSaved={onSettingsChanged}
      />
    )
  }

  const syncPercent =
    syncProgress && syncProgress.total > 0
      ? Math.min(100, Math.round((syncProgress.current / syncProgress.total) * 100))
      : null

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-6 flex items-center gap-3">
        <button onClick={onBack} className="native-titlebar-button" title="Close settings">
          <X className="h-4 w-4" />
        </button>
        <h2 className="text-lg font-semibold text-foreground">Settings</h2>
      </div>

      <div className="mx-auto w-full max-w-2xl space-y-3 pb-6">
        <nav
          aria-label="Settings categories"
          className="native-surface sticky top-0 z-20 flex gap-1 p-1.5"
        >
          {[
            ['settings-knowledge', 'Knowledge'],
            ['settings-chat', 'Chat'],
            ['settings-models', 'Models'],
            ['settings-advanced', 'Advanced']
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })}
              className="control-quiet min-h-9 flex-1 px-3 py-1.5"
            >
              {label}
            </button>
          ))}
        </nav>

        <Panel id="settings-knowledge" ref={knowledgeRef} className="scroll-mt-16 p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Knowledge Bases</h3>
            </div>
            <button
              type="button"
              onClick={() => setShowCreateKnowledgeBase(true)}
              className="flex items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-xs font-medium text-primary"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>

          <div className="space-y-2">
            {settings.knowledgeBases.map((knowledgeBase) => (
              <div
                key={knowledgeBase.id}
                className={`flex items-center gap-3 rounded-lg border p-3 ${
                  knowledgeBase.id === settings.activeKnowledgeBaseId
                    ? 'selected-primary'
                    : 'border-white/[0.07] bg-white/[0.02]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => void selectKnowledgeBase(knowledgeBase.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-medium text-foreground">
                      {knowledgeBase.name}
                    </span>
                    {knowledgeBase.id === settings.activeKnowledgeBaseId && (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
                        Selected
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-[10px] text-muted-foreground">
                    {knowledgeBase.description || 'Add a description to improve answers.'}
                  </p>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70">
                    {knowledgeBase.folder}
                  </p>
                </button>
                <span className="text-[10px] text-muted-foreground">
                  {knowledgeBase.syncStats.indexed} files
                </span>
                {settings.knowledgeBases.length > 1 && (
                  <button
                    type="button"
                    onClick={() => void removeKnowledgeBase(knowledgeBase.id, knowledgeBase.name)}
                    title={`Remove ${knowledgeBase.name}`}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-red-400/10 hover:text-red-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {activeKnowledgeBase && (
            <div className="mt-4 border-t border-white/[0.07] pt-3">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-muted-foreground">
                  {activeKnowledgeBase.folder}
                </div>
                <button
                  type="button"
                  onClick={() => void selectFolder()}
                  className="secondary-action rounded-lg px-3 py-2 text-xs font-medium"
                >
                  Change folder
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowKnowledgeAdvanced((current) => !current)}
                className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <SlidersHorizontal className="h-3 w-3" />
                {showKnowledgeAdvanced ? 'Hide details' : 'Description and instructions'}
              </button>
              {showKnowledgeAdvanced && (
                <div className="mt-3 space-y-2">
                  <input
                    value={knowledgeName}
                    onChange={(event) => setKnowledgeName(event.target.value)}
                    placeholder="Knowledge base name"
                    className="w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-xs text-foreground outline-none"
                  />
                  <textarea
                    value={knowledgeDescription}
                    onChange={(event) => setKnowledgeDescription(event.target.value)}
                    placeholder="Example: Customer proposals, pricing, and partnership documents for my sales work."
                    rows={2}
                    className="w-full resize-none rounded-lg border border-white/10 bg-input px-3 py-2 text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  <textarea
                    value={knowledgeInstructions}
                    onChange={(event) => setKnowledgeInstructions(event.target.value)}
                    placeholder="Optional: Be concise, explain business terms simply, and always mention the source."
                    rows={2}
                    className="w-full resize-none rounded-lg border border-white/10 bg-input px-3 py-2 text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => void saveKnowledgeDetails()}
                      className="primary-action rounded-md px-3 py-1.5 text-[11px] font-medium"
                    >
                      Save details
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {knowledgeMessage && (
            <p className="status-message status-message-success mt-3">{knowledgeMessage}</p>
          )}

          {activeKnowledgeBase && (
            <div className="mt-4 border-t border-white/[0.07] pt-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-foreground">Status and files</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    Sync and review what RavnDock can use from this knowledge base.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={syncing}
                  onClick={() => void syncKnowledgeBase()}
                  className="flex items-center gap-1.5 secondary-action rounded-lg px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                  {syncing
                    ? 'Syncing...'
                    : activeKnowledgeBase.syncErrors.length > 0
                      ? 'Retry files'
                      : 'Sync now'}
                </button>
              </div>
              <div className="mb-4 grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg bg-white/[0.03] p-3">
                  <p className="text-muted-foreground">Documents ready</p>
                  <p className="mt-1 text-base font-semibold text-foreground">
                    {activeKnowledgeBase.syncStats.indexed}
                  </p>
                </div>
                <div className="rounded-lg bg-white/[0.03] p-3">
                  <p className="text-muted-foreground">Last sync</p>
                  <p className="mt-1 leading-snug text-foreground">
                    {formatDateTime(activeKnowledgeBase.syncStats.lastSyncedAt)}
                  </p>
                </div>
              </div>
              {staleness?.stale &&
                stalenessKnowledgeBaseId === settings.activeKnowledgeBaseId &&
                !syncing && (
                  <div className="mb-4 flex items-center gap-2 rounded-lg bg-amber-500/8 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                    This folder may have changed. Sync to use the latest files.
                  </div>
                )}

              {syncing && (
                <div className="mb-4 rounded-lg bg-white/[0.025] px-3 py-2.5">
                  <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                    <span className="truncate">
                      {syncProgress?.message ?? 'Scanning your selected folder...'}
                    </span>
                    {syncProgress && syncProgress.total > 0 && (
                      <span className="flex-shrink-0 tabular-nums">
                        {syncProgress.current} of {syncProgress.total}
                      </span>
                    )}
                  </div>
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-white/10"
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
                </div>
              )}
              {syncMessage && !syncing && (
                <p
                  role={syncMessage.state === 'error' ? 'alert' : 'status'}
                  className={`status-message mb-4 whitespace-pre-line ${
                    syncMessage.state === 'success'
                      ? 'status-message-success'
                      : 'status-message-danger'
                  }`}
                >
                  {syncMessage.text}
                </p>
              )}
              {!syncing && activeKnowledgeBase.syncErrors.length > 0 && (
                <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5">
                  <p className="text-[11px] font-medium text-destructive">
                    {activeKnowledgeBase.syncErrors.length} document
                    {activeKnowledgeBase.syncErrors.length === 1 ? '' : 's'} could not be synced.
                  </p>
                  <ul className="mt-1.5 space-y-1 text-[10px] text-muted-foreground">
                    {activeKnowledgeBase.syncErrors.map((item) => (
                      <li key={`${item.path}:${item.message}`}>
                        <span className="font-medium text-foreground">{item.path}:</span>{' '}
                        {item.message}
                        {item.technicalDetails && (
                          <details className="mt-0.5">
                            <summary className="cursor-pointer">Technical details</summary>
                            <p className="mt-0.5 break-words">{item.technicalDetails}</p>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowKnowledgeFiles(true)}
                className="mt-3 flex w-full items-center justify-between rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2.5 text-left hover:bg-white/[0.045]"
              >
                <span className="flex items-center gap-2">
                  <FileText className="h-3.5 w-3.5 text-primary" />
                  <span>
                    <span className="block text-xs font-medium text-foreground">Browse files</span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      {activeKnowledgeBase.syncStats.indexed} document
                      {activeKnowledgeBase.syncStats.indexed === 1 ? '' : 's'} available
                    </span>
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
          )}
        </Panel>

        <Panel id="settings-chat" className="scroll-mt-16 p-5">
          <div className="mb-3 flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            <div>
              <h3 className="text-sm font-semibold text-foreground">Chat reading</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Choose how spacious chat responses feel.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onReadingModeChange('compact')}
              className={
                'rounded-lg border px-3 py-2.5 text-left ' +
                (readingMode === 'compact' ? 'selected-primary' : 'border-border bg-secondary/40')
              }
            >
              <span className="block text-xs font-medium text-foreground">
                Compact professional
              </span>
              <span className="mt-0.5 block text-[10px] text-muted-foreground">
                More information on screen.
              </span>
            </button>
            <button
              type="button"
              onClick={() => onReadingModeChange('comfortable')}
              className={
                'rounded-lg border px-3 py-2.5 text-left ' +
                (readingMode === 'comfortable'
                  ? 'selected-primary'
                  : 'border-border bg-secondary/40')
              }
            >
              <span className="block text-xs font-medium text-foreground">
                Comfortable everyday
              </span>
              <span className="mt-0.5 block text-[10px] text-muted-foreground">
                Larger text for longer reading.
              </span>
            </button>
          </div>
        </Panel>

        <Panel id="settings-models" className="scroll-mt-16 p-0">
          <details className="section-disclosure">
            <summary className="flex cursor-pointer items-center justify-between gap-3 px-5 py-4 hover:bg-secondary/60">
              <span className="flex items-center gap-3">
                <Cpu className="h-4 w-4 text-primary" />
                <span>
                  <span className="block text-sm font-semibold text-foreground">Models</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Choose, download, and manage local AI models
                  </span>
                </span>
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </summary>
            <div className="border-t border-border p-5">
              {recommendations && (
                <details className="mb-4 rounded-lg border border-primary/20 bg-primary/10 p-3">
                  <summary className="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-primary">
                    <span>Models that fit this Mac</span>
                    <ChevronDown className="native-disclosure-chevron h-3.5 w-3.5 flex-shrink-0" />
                  </summary>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {recommendations.deviceSummary}. These are suggestions; you can still use
                    another Ollama model.
                  </p>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {[
                      ['Performance', recommendations.performance],
                      ['Balanced', recommendations.balanced],
                      ['High quality', recommendations.highQuality]
                    ].map(([label, suggestions]) => (
                      <div
                        key={label as string}
                        className="min-w-0 rounded-md bg-white/[0.03] p-2.5"
                      >
                        <p className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">
                          {label as string}
                        </p>
                        <div className="space-y-2">
                          {(suggestions as DeviceModelRecommendations['performance']).map(
                            (suggestion) => (
                              <div key={suggestion.model}>
                                <p className="truncate text-[11px] font-medium text-foreground">
                                  {suggestion.model}
                                </p>
                                <p className="mt-0.5 text-[9px] leading-snug text-muted-foreground">
                                  {suggestion.description} {suggestion.estimatedSize}
                                </p>
                              </div>
                            )
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {loadingModels ? (
                <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Checking your models...
                </div>
              ) : (
                <>
                  {models.length === 0 && (
                    <div className="mb-3 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2.5 text-xs">
                      <p className="font-medium text-foreground">No local chat models yet.</p>
                      <p className="mt-0.5 text-muted-foreground">
                        Download a model below, then RavnDock will be ready to chat.
                      </p>
                    </div>
                  )}
                  <div className="space-y-2">
                    {MODEL_PRESETS.map((preset) => {
                      const assigned = settings.modelPresets[preset.id]
                      const available = models.some(
                        (model) => model.id.toLowerCase() === assigned.toLowerCase()
                      )
                      return (
                        <div
                          key={preset.id}
                          className="grid grid-cols-[120px_1fr] items-center gap-3 rounded-lg bg-white/[0.03] px-3 py-2.5"
                        >
                          <div>
                            <p className="text-xs font-medium text-foreground">{preset.label}</p>
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              {preset.description}
                            </p>
                          </div>
                          <select
                            value={available ? assigned : ''}
                            onChange={(event) => void assignPreset(preset.id, event.target.value)}
                            className="min-w-0 rounded-md border border-white/10 bg-input px-2.5 py-2 text-xs text-foreground"
                          >
                            {!available && <option value="">{assigned} - not installed</option>}
                            {models.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.id}
                              </option>
                            ))}
                          </select>
                        </div>
                      )
                    })}
                  </div>
                  <label className="mt-4 block border-t border-white/[0.07] pt-3 text-xs text-muted-foreground">
                    Active model
                    <select
                      value={settings.selectedModel}
                      onChange={(event) => void selectModel(event.target.value)}
                      className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground"
                    >
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.id} - {model.recommendation}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="mt-4 border-t border-white/[0.07] pt-3">
                    <p className="text-xs font-medium text-foreground">
                      Download another Ollama model
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Enter a model name such as llama3.2:3b or gemma3:4b.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <input
                        value={customModel}
                        onChange={(event) => {
                          setCustomModel(event.target.value)
                          setAssessment(null)
                          setApprovedWarning('')
                        }}
                        placeholder="Model name"
                        className="min-w-0 flex-1 rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                      />
                      <button
                        type="button"
                        disabled={modelBusy || !customModel.trim()}
                        onClick={() => void downloadCustomModel()}
                        className="primary-action flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-40"
                      >
                        {modelBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        {assessment?.level !== 'ok' && approvedWarning === customModel.trim()
                          ? 'Download anyway'
                          : 'Download'}
                      </button>
                    </div>
                    {assessment && (
                      <div
                        className={`mt-2 flex items-start gap-2 rounded-md px-3 py-2 text-[11px] ${
                          assessment.level === 'ok'
                            ? 'bg-emerald-400/[0.08] text-emerald-200'
                            : 'bg-amber-400/[0.08] text-amber-100'
                        }`}
                      >
                        {assessment.level !== 'ok' && (
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                        )}
                        {assessment.message}
                      </div>
                    )}
                    {modelProgress && modelProgress.state === 'working' && (
                      <div className="mt-2">
                        <div className="mb-1 flex justify-between text-[10px] text-muted-foreground">
                          <span>{modelProgress.message}</span>
                          <span className="flex items-center gap-2">
                            <span>
                              {modelProgress.downloadedBytes && modelProgress.totalBytes
                                ? `${formatBytes(modelProgress.downloadedBytes, { unavailable: 'Size unavailable', zero: 'Size unavailable' })} / ${formatBytes(modelProgress.totalBytes, { unavailable: 'Size unavailable', zero: 'Size unavailable' })} - `
                                : ''}
                              {modelProgress.progress}%
                            </span>
                            <button
                              type="button"
                              onClick={() => void cancelModelDownload()}
                              className="rounded px-1.5 py-0.5 text-red-300 hover:bg-red-400/10"
                            >
                              Cancel
                            </button>
                          </span>
                        </div>
                        <div
                          className="h-1.5 overflow-hidden rounded-full bg-white/10"
                          role="progressbar"
                          aria-label={`${modelProgress.model} download progress`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={modelProgress.progress}
                        >
                          <div
                            className="h-full rounded-full bg-primary transition-[width]"
                            style={{ width: `${modelProgress.progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 border-t border-white/[0.07] pt-3">
                    <button
                      type="button"
                      onClick={() => setShowInstalledModels(true)}
                      className="flex w-full items-center justify-between rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2.5 text-left hover:bg-white/[0.045]"
                    >
                      <span>
                        <span className="block text-xs font-medium text-foreground">
                          Installed chat models
                        </span>
                        <span className="mt-0.5 block text-[10px] text-muted-foreground">
                          {models.length} model{models.length === 1 ? '' : 's'} stored on this Mac
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </div>
                </>
              )}
              {modelMessage && <p className="mt-2 text-xs text-primary">{modelMessage}</p>}
            </div>
          </details>
        </Panel>

        <button
          id="settings-advanced"
          onClick={() => setAdvanced(true)}
          className="native-surface scroll-mt-16 flex min-h-14 w-full items-center justify-between px-5 py-4 text-left hover:bg-secondary/60"
        >
          <div className="flex items-center gap-3">
            <SlidersHorizontal className="h-4 w-4 text-primary" />
            <div>
              <p className="text-sm font-medium text-foreground">Advanced Settings</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Fine-tune RavnDock or explore how local RAG works
              </p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>

        <div className="flex items-start gap-3 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.08] px-4 py-3">
          <Shield className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-400" />
          <div className="space-y-1 text-xs leading-relaxed text-emerald-300">
            <p>Your questions and documents stay on this Mac.</p>
            <p>Internet is used only when you approve a model or software download.</p>
          </div>
        </div>
      </div>
      <CreateKnowledgeBaseModal
        open={showCreateKnowledgeBase}
        onClose={() => setShowCreateKnowledgeBase(false)}
        onCreated={async () => {
          setKnowledgeMessage('Your new knowledge base is ready to sync.')
          await onSettingsChanged()
        }}
      />
      <KnowledgeFilesModal
        open={showKnowledgeFiles}
        knowledgeBase={activeKnowledgeBase ?? null}
        onClose={() => setShowKnowledgeFiles(false)}
      />
      <InstalledModelsModal
        open={showInstalledModels}
        models={models}
        onClose={() => setShowInstalledModels(false)}
        onDelete={deleteModel}
      />
    </div>
  )
}
