import { AlertTriangle, CheckCircle, ChevronDown, Cpu, Loader2, Sparkles } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type {
  ComponentState,
  PrepareProgress,
  PrepareStep,
  SyncProgress,
  UserFacingFailure
} from '../../../shared/contracts'
import { CHAT_MODEL, MODEL_PRESETS } from '../../../shared/contracts'
import { HelpTooltip } from '../components/ui'

function folderName(folder: string): string {
  return folder.split('/').filter(Boolean).at(-1) ?? folder
}

interface SetupStep {
  id: PrepareStep
  label: string
  child?: boolean
}

function setupSteps(knowledgeFolder: string): SetupStep[] {
  return [
    { id: 'ollama', label: 'Prepare local AI' },
    { id: 'models', label: 'Download your AI model' },
    { id: 'rag-runtime', label: 'Prepare your private workspace' },
    { id: 'knowledge-engine', label: 'Prepare private document engine', child: true },
    { id: 'knowledge-base', label: 'Configure private document service', child: true },
    { id: 'documents', label: `Prepare documents from “${folderName(knowledgeFolder)}”` }
  ]
}

function createInitialStates(steps: Array<{ id: PrepareStep }>): Record<
  PrepareStep,
  {
    state: ComponentState
    message: string
    progress?: number
    downloadedBytes?: number
    totalBytes?: number
  }
> {
  return Object.fromEntries(
    steps.map((step) => [step.id, { state: 'stopped' as ComponentState, message: '' }])
  ) as Record<PrepareStep, { state: ComponentState; message: string }>
}

function StatusIcon({ state }: { state: ComponentState }): React.JSX.Element {
  if (state === 'ready') return <CheckCircle className="h-4 w-4 text-emerald-400" />
  if (state === 'error') return <AlertTriangle className="h-4 w-4 text-red-400" />
  if (state === 'missing') return <AlertTriangle className="h-4 w-4 text-amber-400" />
  if (state === 'working') return <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
  return <div className="h-2 w-2 rounded-full bg-white/20" />
}

function workspaceState(states: Record<PrepareStep, { state: ComponentState }>): ComponentState {
  const workspaceStates = [
    states['rag-runtime'].state,
    states['knowledge-engine'].state,
    states['knowledge-base'].state
  ]
  if (workspaceStates.some((state) => state === 'error')) return 'error'
  if (workspaceStates.every((state) => state === 'ready')) return 'ready'
  if (workspaceStates.some((state) => state === 'working' || state === 'ready')) return 'working'
  return 'stopped'
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export default function PreparingScreen({
  knowledgeFolder,
  onChooseFolder,
  onReady
}: {
  knowledgeFolder: string
  onChooseFolder: () => void
  onReady: () => void
}): React.JSX.Element {
  const steps = useMemo(() => setupSteps(knowledgeFolder), [knowledgeFolder])
  const [states, setStates] = useState(() => createInitialStates(steps))
  const [errorText, setErrorText] = useState<string | null>(null)
  const [setupFailure, setSetupFailure] = useState<UserFacingFailure | null>(null)
  const [folderWarning, setFolderWarning] = useState<string | null>(null)
  const [folderWarningDetails, setFolderWarningDetails] = useState<string | null>(null)
  const [allDone, setAllDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [canPause, setCanPause] = useState(false)
  const [hasStarted, setHasStarted] = useState(false)
  const [selectedModel, setSelectedModel] = useState(CHAT_MODEL)
  const [customModel, setCustomModel] = useState('')

  const requestedModel = customModel.trim() || selectedModel
  const customModelIsValid =
    customModel.trim().length === 0 || /^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$/.test(customModel.trim())

  const runPrepare = useCallback(async (): Promise<void> => {
    setBusy(true)
    setAllDone(false)
    setErrorText(null)
    setSetupFailure(null)
    setFolderWarning(null)
    setFolderWarningDetails(null)
    setStates(createInitialStates(steps))

    const unsubscribeRuntime = window.api.onPrepareProgress((progress: PrepareProgress) => {
      setStates((current) => ({
        ...current,
        [progress.step]: {
          state: progress.state,
          message: progress.message,
          progress: progress.progress,
          downloadedBytes: progress.downloadedBytes,
          totalBytes: progress.totalBytes
        }
      }))
    })
    const unsubscribeSync = window.api.onSyncProgress((progress: SyncProgress) => {
      const percentage =
        progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : undefined
      setStates((current) => ({
        ...current,
        documents: {
          state: 'working',
          message: progress.message,
          progress: percentage
        }
      }))
    })

    try {
      setCanPause(true)
      const result = await window.api.prepareRuntime(requestedModel)
      setCanPause(false)
      if (!result.ok) {
        setErrorText(result.message)
        setSetupFailure(result.failure ?? null)
        return
      }

      setStates((current) => ({
        ...current,
        documents: { state: 'working', message: 'Scanning your selected folder...' }
      }))
      const sync = await window.api.syncKnowledgeBase()
      if (!sync.ok) {
        const errorDetails = sync.errors.map((item) => `${item.path}: ${item.message}`).join('\n')
        if (sync.indexed > 0) {
          const message = `${sync.indexed} document${sync.indexed === 1 ? '' : 's'} ready. ${sync.failed} file${sync.failed === 1 ? '' : 's'} still needs attention.`
          setStates((current) => ({
            ...current,
            documents: { state: 'ready', message, progress: 100 }
          }))
          setFolderWarning(
            `${sync.failed} file${sync.failed === 1 ? '' : 's'} could not be added yet. You can use the documents that are ready now. Open Settings later to review the file and retry.`
          )
          setFolderWarningDetails(errorDetails || null)
          setAllDone(true)
          return
        }
        setStates((current) => ({
          ...current,
          documents: { state: 'error', message: sync.message }
        }))
        setErrorText(errorDetails || sync.message)
        return
      }
      if (sync.indexed === 0) {
        const message =
          'No supported documents here yet. Choose a folder with PDF, Word, PowerPoint, Excel, CSV, text, or Markdown files.'
        setStates((current) => ({
          ...current,
          documents: { state: 'missing', message }
        }))
        setFolderWarning(message)
        return
      }
      setStates((current) => ({
        ...current,
        documents: {
          state: 'ready',
          message: `${sync.indexed} document${sync.indexed === 1 ? '' : 's'} ready.`,
          progress: 100
        }
      }))
      setAllDone(true)
    } catch (error) {
      setErrorText(
        'Your setup is safe. Try again, or continue later if a download was interrupted.'
      )
      setSetupFailure({
        title: 'RavnDock could not finish this step',
        message: 'Your setup is safe. Try again when you are ready.',
        code: 'PREPARATION_FAILED',
        retryable: true,
        technicalDetails:
          error instanceof Error
            ? error.message.replace(/\/(?:Users|home)\/[^\s:]+/g, '[local path]').slice(0, 500)
            : undefined
      })
    } finally {
      unsubscribeRuntime()
      unsubscribeSync()
      setBusy(false)
      setCanPause(false)
    }
  }, [requestedModel, steps])

  const beginPreparation = (): void => {
    if (!customModelIsValid) {
      setErrorText('Use the model name exactly as it appears in the Ollama library.')
      return
    }
    setHasStarted(true)
    void runPrepare()
  }

  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-8 py-8 text-center">
      <div
        className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl"
        style={{
          background:
            'linear-gradient(135deg, color-mix(in srgb, var(--primary) 82%, white) 0%, var(--skill) 100%)'
        }}
      >
        <Cpu className="h-8 w-8 text-white" />
      </div>
      <div className="mb-3 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
        Preparing · 3 of 4
      </div>
      <h2 className="mb-2 text-2xl font-semibold text-foreground">
        Preparing your personal intelligence
      </h2>
      <p className="mb-6 text-sm text-muted-foreground">
        We’ll handle the local setup and keep everything on this Mac.
      </p>

      {!hasStarted ? (
        <div className="mb-5 w-full max-w-[560px] rounded-xl border border-white/10 bg-white/[0.02] p-4 text-left">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-foreground">Choose your first AI model</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Download one now. You can add or change models later in Settings.
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              We’ll also download the private document-search model RavnDock needs for your files.
            </p>
          </div>
          <div className="space-y-2">
            {MODEL_PRESETS.map((preset) => {
              const active = !customModel.trim() && selectedModel === preset.model
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    setSelectedModel(preset.model)
                    setCustomModel('')
                  }}
                  className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                    active
                      ? 'border-primary/45 bg-primary/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
                      : 'border-white/10 bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.05]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-foreground">{preset.label}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{preset.description}</p>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {preset.model}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>

          <details className="mt-3 border-t border-white/10 pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
              <ChevronDown className="h-3.5 w-3.5" />
              Use a different Ollama model
              <HelpTooltip
                label="Finding an Ollama model name"
                text={
                  'Open ollama.com/library, choose a model, then copy the name shown in its command. For example: llama3.2:3b. Paste only that model name here.'
                }
                iconClassName="h-3.5 w-3.5"
              />
            </summary>
            <label className="mt-3 block text-xs text-muted-foreground">
              Ollama model name
              <input
                value={customModel}
                onChange={(event) => setCustomModel(event.target.value)}
                placeholder="For example: llama3.2:3b"
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
              />
            </label>
            {!customModelIsValid && (
              <p className="mt-1.5 text-[11px] text-red-300">Use the model name shown in Ollama.</p>
            )}
          </details>
        </div>
      ) : (
        <div className="mb-5 w-full max-w-[560px] rounded-xl border border-white/10 bg-white/[0.02] p-4 text-left">
          <div className="space-y-3">
            {steps.map((step) => {
              const status = states[step.id]
              const displayState = step.id === 'rag-runtime' ? workspaceState(states) : status.state
              return (
                <div
                  key={step.id}
                  className={`relative flex min-h-9 items-start gap-3 ${step.child ? 'ml-8 pl-3' : ''}`}
                >
                  {step.child && (
                    <div className="absolute bottom-2 left-0 top-0 w-px bg-white/10" aria-hidden />
                  )}
                  <div className="mt-0.5 flex h-5 w-5 items-center justify-center">
                    <StatusIcon state={displayState} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`${step.child ? 'text-xs' : 'text-sm'} font-medium text-foreground`}
                    >
                      {step.label}
                    </p>
                    {status.message && (
                      <>
                        <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">
                          {status.message}
                          {status.downloadedBytes && status.totalBytes
                            ? ` (${formatGigabytes(status.downloadedBytes)} / ${formatGigabytes(
                                status.totalBytes
                              )}, ${status.progress ?? 0}%)`
                            : typeof status.progress === 'number' && status.progress > 0
                              ? ` (${status.progress}%)`
                              : ''}
                        </p>
                        {status.state === 'working' && typeof status.progress === 'number' && (
                          <div
                            className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10"
                            role="progressbar"
                            aria-label={`${step.label} progress`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.min(100, Math.max(0, status.progress))}
                          >
                            <div
                              className="h-full rounded-full bg-primary transition-[width] duration-200"
                              style={{ width: `${Math.min(100, Math.max(0, status.progress))}%` }}
                            />
                          </div>
                        )}
                        {status.state === 'working' && typeof status.progress !== 'number' && (
                          <div
                            className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10"
                            role="progressbar"
                            aria-label={`${step.label} progress`}
                          >
                            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {errorText && (
        <div
          className="mb-4 w-full max-w-[560px] rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-left"
          role="alert"
        >
          <p className="text-xs font-medium text-foreground">
            {setupFailure?.title ?? 'RavnDock could not finish this step.'}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {setupFailure?.message ??
              'Try again. If the issue continues, choose another folder or review Settings.'}
          </p>
          {(setupFailure?.technicalDetails || errorText !== setupFailure?.message) && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Technical details</summary>
              <p className="mt-1 break-words">{setupFailure?.technicalDetails ?? errorText}</p>
            </details>
          )}
        </div>
      )}

      {folderWarning && (
        <div
          className="mb-4 flex w-full max-w-[560px] items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-500/10 p-3 text-left"
          role="status"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
          <div>
            <p className="text-xs leading-relaxed text-amber-100">{folderWarning}</p>
            {folderWarningDetails && (
              <details className="mt-2 text-[11px] text-muted-foreground">
                <summary className="cursor-pointer">File details</summary>
                <p className="mt-1 whitespace-pre-wrap break-words">{folderWarningDetails}</p>
              </details>
            )}
          </div>
        </div>
      )}

      {!hasStarted ? (
        <div className="flex items-center gap-3">
          <button
            onClick={onChooseFolder}
            className="rounded-xl border border-white/10 px-5 py-2.5 text-sm font-medium text-foreground"
          >
            Change Folder
          </button>
          <button
            onClick={beginPreparation}
            disabled={!customModelIsValid}
            className="primary-action rounded-xl px-6 py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            Prepare RavnDock
          </button>
        </div>
      ) : !allDone ? (
        <div className="flex items-center gap-3">
          {busy && canPause && (
            <button
              type="button"
              onClick={() => void window.api.cancelPreparation()}
              className="rounded-xl border border-white/10 px-5 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Pause setup
            </button>
          )}
          {!busy && (
            <button
              onClick={onChooseFolder}
              className="rounded-xl border border-white/10 px-5 py-2.5 text-sm font-medium text-foreground"
            >
              Change Folder
            </button>
          )}
          <button
            onClick={() => void runPrepare()}
            disabled={busy}
            className="primary-action rounded-xl px-6 py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {busy ? 'Preparing...' : 'Try Again'}
          </button>
        </div>
      ) : (
        <button
          onClick={onReady}
          className="primary-action flex items-center gap-2 rounded-xl px-8 py-3 text-sm font-semibold"
        >
          <Sparkles className="h-4 w-4" />
          Open RavnDock
        </button>
      )}
    </div>
  )
}
