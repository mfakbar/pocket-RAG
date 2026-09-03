import { ArrowLeft, BookOpen, RotateCcw, Save, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import {
  DEFAULT_INFERENCE_SETTINGS,
  DEFAULT_RAG_SETTINGS,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_OPTIONS,
  RERANKER_MODEL,
  RERANKER_MODEL_OPTIONS,
  type AppSettings,
  type InferenceSettings,
  type RagSettings,
  type SyncProgress
} from '../../../shared/contracts'
import { HelpTooltip, Panel } from '../components/ui'
import { friendlyActionError } from '../lib/errors'
import RagExplainerView from './RagExplainerView'

function FieldLabel({
  children,
  help
}: {
  children: React.ReactNode
  help: string
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      {children}
      <HelpTooltip text={help} />
    </span>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  description,
  help
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description: string
  help?: string
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-5 py-2">
      <span>
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          {label}
          {help ? <HelpTooltip text={help} /> : null}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 flex-shrink-0 accent-primary"
      />
    </label>
  )
}

export default function AdvancedSettingsView({
  settings,
  onBack,
  onSaved
}: {
  settings: AppSettings
  onBack: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [rag, setRag] = useState<RagSettings>(settings.rag)
  const [inference, setInference] = useState<InferenceSettings>(settings.inference)
  const [embeddingModel, setEmbeddingModel] = useState(settings.embeddingModel)
  const [rerankerModel, setRerankerModel] = useState(settings.rerankerModel)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'info' | 'success' | 'error'>('info')
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [showExplainer, setShowExplainer] = useState(false)

  const save = async (): Promise<void> => {
    setBusy(true)
    setMessage(
      embeddingModel !== settings.embeddingModel
        ? 'Downloading the document search model...'
        : rag.improveDocumentMatching &&
            (!settings.rag.improveDocumentMatching || rerankerModel !== settings.rerankerModel)
          ? 'Downloading improved document matching for offline use...'
          : 'Saving settings...'
    )
    setMessageTone('info')
    setProgress(null)
    const unsubscribe = window.api.onSyncProgress(setProgress)
    try {
      const result = await window.api.updateSettings({
        rag,
        inference,
        embeddingModel,
        rerankerModel
      })
      if (result.rebuildRequired) {
        setMessage('Rebuilding your documents with the new settings...')
        const rebuilt = await window.api.rebuildKnowledgeBase()
        if (!rebuilt.ok) throw new Error(rebuilt.message)
        setMessage(
          `Settings saved. ${rebuilt.indexed} document${rebuilt.indexed === 1 ? '' : 's'} rebuilt.`
        )
      } else {
        setMessage(result.message)
      }
      setMessageTone('success')
      await onSaved()
    } catch (error) {
      setMessage(friendlyActionError(error, 'Settings could not be saved.'))
      setMessageTone('error')
    } finally {
      unsubscribe()
      setBusy(false)
    }
  }

  const reset = (): void => {
    setRag(DEFAULT_RAG_SETTINGS)
    setInference(DEFAULT_INFERENCE_SETTINGS)
    setEmbeddingModel(EMBEDDING_MODEL)
    setRerankerModel(RERANKER_MODEL)
    setMessage('Recommended settings restored. Select Save to apply them.')
    setMessageTone('info')
  }

  if (showExplainer) {
    return <RagExplainerView settings={settings} onBack={() => setShowExplainer(false)} />
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Back to settings"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Advanced Settings</h2>
            <p className="text-xs text-muted-foreground">Clear starting points for local answers</p>
          </div>
        </div>
        <button
          onClick={reset}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </button>
      </div>

      <div className="mx-auto w-full max-w-2xl space-y-3 pb-6">
        <nav aria-label="Advanced settings sections" className="native-surface flex gap-1 p-1.5">
          <button
            type="button"
            aria-current="page"
            className="selected-primary flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-foreground"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
            Fine-tune RAG
          </button>
          <button
            type="button"
            onClick={() => setShowExplainer(true)}
            className="control-quiet flex min-h-10 flex-1 items-center justify-center gap-2 px-3 py-2 text-xs"
          >
            <BookOpen className="h-3.5 w-3.5 text-primary" />
            How RAG works
          </button>
        </nav>

        <Panel className="p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-foreground">Search Models</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              These models organize and rank your documents. They are separate from the chat model
              and usually do not need to be changed.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-xs text-muted-foreground">
              <FieldLabel help="Creates the searchable representation of your files. Changing it rebuilds the active knowledge base and marks your other knowledge bases for resync so stored document vectors stay compatible.">
                Embedding model
              </FieldLabel>
              <select
                value={embeddingModel}
                onChange={(event) => setEmbeddingModel(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground"
              >
                {EMBEDDING_MODEL_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.id} - {option.label}
                  </option>
                ))}
              </select>
              <span className="mt-1.5 block text-[10px] leading-relaxed">
                {
                  EMBEDDING_MODEL_OPTIONS.find((option) => option.id === embeddingModel)
                    ?.description
                }
              </span>
            </label>
            <label className="text-xs text-muted-foreground">
              <FieldLabel help="Rechecks the best search matches before answering. It is used only when Improve document matching is turned on below.">
                Reranker model
              </FieldLabel>
              <select
                value={rerankerModel}
                onChange={(event) => setRerankerModel(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground"
              >
                {RERANKER_MODEL_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.id} - {option.label}
                  </option>
                ))}
              </select>
              <span className="mt-1.5 block text-[10px] leading-relaxed">
                {RERANKER_MODEL_OPTIONS.find((option) => option.id === rerankerModel)?.description}
              </span>
            </label>
          </div>
        </Panel>

        <Panel className="p-5">
          <h3 className="mb-4 text-sm font-semibold text-foreground">Answers</h3>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-xs text-muted-foreground">
              <FieldLabel help="How much of your question and document text the model can consider at once. 8K is a good everyday choice.">
                Context length
              </FieldLabel>
              <select
                value={inference.contextLength}
                onChange={(event) =>
                  setInference((current) => ({
                    ...current,
                    contextLength: Number(event.target.value) as InferenceSettings['contextLength']
                  }))
                }
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground"
              >
                <option value={4096}>4K - Faster</option>
                <option value={8192}>8K - Recommended</option>
                <option value={16384}>16K - More memory</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              <FieldLabel help="Limits how long each answer can be. Longer answers take more time and memory.">
                Maximum answer
              </FieldLabel>
              <select
                value={inference.maxOutputTokens}
                onChange={(event) =>
                  setInference((current) => ({
                    ...current,
                    maxOutputTokens: Number(event.target.value)
                  }))
                }
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground"
              >
                <option value={512}>Short</option>
                <option value={1024}>Standard</option>
                <option value={2048}>Long</option>
              </select>
            </label>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <label className="block text-xs text-muted-foreground">
              <FieldLabel help="Lower values keep answers consistent and grounded in your files. Higher values add variety.">
                Answer creativity: {inference.temperature.toFixed(1)}
              </FieldLabel>
              <input
                type="range"
                min="0"
                max="0.8"
                step="0.1"
                value={inference.temperature}
                onChange={(event) =>
                  setInference((current) => ({
                    ...current,
                    temperature: Number(event.target.value)
                  }))
                }
                className="mt-2 w-full accent-primary"
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              <FieldLabel help="Controls how narrowly the model chooses its words. The recommended value keeps answers natural and focused.">
                Answer focus: {inference.topP.toFixed(1)}
              </FieldLabel>
              <input
                type="range"
                min="0.5"
                max="1"
                step="0.1"
                value={inference.topP}
                onChange={(event) =>
                  setInference((current) => ({
                    ...current,
                    topP: Number(event.target.value)
                  }))
                }
                className="mt-2 w-full accent-primary"
              />
            </label>
          </div>
        </Panel>

        <Panel className="p-5">
          <h3 className="mb-3 text-sm font-semibold text-foreground">Document Retrieval</h3>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-xs text-muted-foreground">
              <FieldLabel help="How many matching parts of your documents are used for each answer. More can help broad questions but may add noise.">
                Retrieved sections
              </FieldLabel>
              <select
                value={rag.topK}
                onChange={(event) =>
                  setRag((current) => ({ ...current, topK: Number(event.target.value) }))
                }
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground"
              >
                {[3, 4, 5, 6, 8].map((value) => (
                  <option key={value} value={value}>
                    {value === 4 ? `${value} - Recommended` : value}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              <FieldLabel help="Balances exact word matches with matches based on meaning. 50% works well for most files.">
                Keyword balance: {Math.round(rag.hybridKeywordWeight * 100)}%
              </FieldLabel>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={rag.hybridKeywordWeight}
                disabled={!rag.hybridSearch}
                onChange={(event) =>
                  setRag((current) => ({
                    ...current,
                    hybridKeywordWeight: Number(event.target.value)
                  }))
                }
                className="mt-3 w-full accent-primary disabled:opacity-40"
              />
            </label>
          </div>
          <div className="mt-3 divide-y divide-white/5">
            <Toggle
              checked={rag.improveDocumentMatching}
              onChange={(improveDocumentMatching) =>
                setRag((current) => ({
                  ...current,
                  improveDocumentMatching,
                  fullContext: improveDocumentMatching ? false : current.fullContext
                }))
              }
              label="Improve document matching"
              description={`Checks ambiguous matches more carefully with ${rerankerModel}. The first setup downloads the model for offline use; answers may take slightly longer.`}
              help="Used for ambiguous and broad questions. Exact filenames and direct lookups stay fast and skip this step. Once downloaded, it works offline."
            />
            <Toggle
              checked={rag.hybridSearch}
              onChange={(hybridSearch) => setRag((current) => ({ ...current, hybridSearch }))}
              label="Keyword and meaning search"
              description="Combines exact terms with semantic matches."
            />
            <Toggle
              checked={rag.enrichedMetadata}
              onChange={(enrichedMetadata) =>
                setRag((current) => ({ ...current, enrichedMetadata }))
              }
              label="Include filenames and headings"
              description="Improves searches for named files, titles, and sections."
            />
            <Toggle
              checked={rag.fullContext}
              onChange={(fullContext) =>
                setRag((current) => ({
                  ...current,
                  fullContext,
                  improveDocumentMatching: fullContext ? false : current.improveDocumentMatching
                }))
              }
              label="Use complete documents"
              description="Best only for a few short documents; uses much more context and turns off improved matching."
            />
          </div>
        </Panel>

        <Panel className="p-5">
          <h3 className="mb-4 text-sm font-semibold text-foreground">Document Processing</h3>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-xs text-muted-foreground">
              <FieldLabel help="RavnDock reads documents in smaller sections. Medium sections usually preserve enough context without slowing search.">
                Section size
              </FieldLabel>
              <select
                value={rag.chunkSize}
                onChange={(event) =>
                  setRag((current) => ({ ...current, chunkSize: Number(event.target.value) }))
                }
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground"
              >
                <option value={750}>750 tokens</option>
                <option value={1000}>1,000 - Recommended</option>
                <option value={1500}>1,500 tokens</option>
                <option value={2000}>2,000 tokens</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              <FieldLabel help="Repeats a little text between sections so ideas are not cut off at the boundary.">
                Section overlap
              </FieldLabel>
              <select
                value={rag.chunkOverlap}
                onChange={(event) =>
                  setRag((current) => ({ ...current, chunkOverlap: Number(event.target.value) }))
                }
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground"
              >
                <option value={50}>50 tokens</option>
                <option value={100}>100 - Recommended</option>
                <option value={150}>150 tokens</option>
                <option value={200}>200 tokens</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              <FieldLabel help="Very small fragments are joined or ignored to reduce incomplete search results.">
                Minimum section
              </FieldLabel>
              <select
                value={rag.minimumChunkSize}
                onChange={(event) =>
                  setRag((current) => ({
                    ...current,
                    minimumChunkSize: Number(event.target.value)
                  }))
                }
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground"
              >
                <option value={0}>No minimum</option>
                <option value={250}>250 tokens</option>
                <option value={500}>500 - Recommended</option>
                <option value={750}>750 tokens</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              <FieldLabel help="Controls how documents are divided. Token splitting handles natural language best for most files.">
                Text splitting
              </FieldLabel>
              <select
                value={rag.textSplitter}
                onChange={(event) =>
                  setRag((current) => ({
                    ...current,
                    textSplitter: event.target.value as RagSettings['textSplitter']
                  }))
                }
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground"
              >
                <option value="token">Token - Recommended</option>
                <option value="character">Character</option>
              </select>
            </label>
          </div>
          <div className="mt-3 divide-y divide-white/5">
            <Toggle
              checked={rag.preserveHeadings}
              onChange={(preserveHeadings) =>
                setRag((current) => ({ ...current, preserveHeadings }))
              }
              label="Preserve document headings"
              description="Keeps related sections together when possible."
            />
            <Toggle
              checked={rag.pdfOcr}
              onChange={(pdfOcr) => setRag((current) => ({ ...current, pdfOcr }))}
              label="Read scanned PDFs"
              description="Uses OCR for image-based pages and makes syncing slower."
            />
          </div>
        </Panel>

        {(message || progress) && (
          <div
            className={`rounded-lg border px-4 py-3 text-xs ${
              messageTone === 'success' && !progress
                ? 'border-emerald-400/25 bg-emerald-400/[0.09] font-medium text-emerald-300'
                : messageTone === 'error'
                  ? 'border-red-400/20 bg-red-400/[0.08] text-red-300'
                  : 'border-primary/20 bg-primary/10 text-primary'
            }`}
            role={messageTone === 'error' ? 'alert' : 'status'}
          >
            {progress?.message || message}
            {progress && progress.total > 0 ? ` (${progress.current} of ${progress.total})` : ''}
            {progress && progress.total > 0 && (
              <div
                className="sr-only"
                role="progressbar"
                aria-label="Knowledge base rebuild progress"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.current}
              />
            )}
          </div>
        )}

        <button
          onClick={() => void save()}
          disabled={busy}
          className="primary-action flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {busy ? 'Applying settings...' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
