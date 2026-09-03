import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  CHAT_MODEL,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_OPTIONS,
  RERANKER_MODEL,
  RERANKER_MODEL_OPTIONS,
  DEFAULT_MODEL_PRESETS,
  DEFAULT_INFERENCE_SETTINGS,
  DEFAULT_RAG_SETTINGS,
  type AppSettings,
  type ChatPerformanceMetrics,
  type InferenceSettings,
  type KnowledgeBase,
  type KnowledgeFile,
  type ModelPerformanceStats,
  type ModelPresetAssignments,
  type RagSettings,
  type SettingsPatch,
  type SyncError,
  type SyncStats
} from '../shared/contracts'

export interface ManifestEntry {
  checksum: string
  fileId: string
  size: number
  modifiedAt: number
  syncedAt: string | null
}

export interface StoredKnowledgeBase {
  id: string
  name: string
  folder: string
  bookmark: string
  description: string
  customInstructions: string
  ragBackendVersion: number
  manifest: Record<string, ManifestEntry>
  syncStats: SyncStats
  syncErrors: SyncError[]
}

export interface StoredConfig {
  knowledgeFolder: string
  knowledgeFolderBookmark: string
  selectedModel: string
  embeddingModel: string
  rerankerModel: string
  modelPresets: ModelPresetAssignments
  rag: RagSettings
  inference: InferenceSettings
  ragBackendVersion: number
  manifest: Record<string, ManifestEntry>
  syncStats: SyncStats
  modelPerformance: Record<string, ModelPerformanceStats>
  knowledgeBases: StoredKnowledgeBase[]
  activeKnowledgeBaseId: string
}

const emptySyncStats: SyncStats = {
  indexed: 0,
  added: 0,
  updated: 0,
  removed: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  lastSyncedAt: null
}

const defaultConfig: StoredConfig = {
  knowledgeFolder: '',
  knowledgeFolderBookmark: '',
  selectedModel: CHAT_MODEL,
  embeddingModel: EMBEDDING_MODEL,
  rerankerModel: RERANKER_MODEL,
  modelPresets: DEFAULT_MODEL_PRESETS,
  rag: DEFAULT_RAG_SETTINGS,
  inference: DEFAULT_INFERENCE_SETTINGS,
  ragBackendVersion: 1,
  manifest: {},
  syncStats: emptySyncStats,
  modelPerformance: {},
  knowledgeBases: [],
  activeKnowledgeBaseId: ''
}

const LEGACY_EMBEDDING_MODEL = 'qwen3-embedding:0.6b'

let updateQueue: Promise<void> = Promise.resolve()

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function getConfigBackupPath(): string {
  return `${getConfigPath()}.bak`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function supportedModel(
  value: unknown,
  options: ReadonlyArray<{ id: string }>,
  fallback: string
): string {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const requested = value.trim()
  return options.some((option) => option.id === requested) ? requested : fallback
}

function numberInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

function parseRagSettings(value: unknown): RagSettings {
  const rag = isRecord(value) ? value : {}
  return {
    topK: Math.round(numberInRange(rag.topK, DEFAULT_RAG_SETTINGS.topK, 1, 20)),
    improveDocumentMatching:
      typeof rag.improveDocumentMatching === 'boolean'
        ? rag.improveDocumentMatching
        : DEFAULT_RAG_SETTINGS.improveDocumentMatching,
    hybridSearch:
      typeof rag.hybridSearch === 'boolean' ? rag.hybridSearch : DEFAULT_RAG_SETTINGS.hybridSearch,
    hybridKeywordWeight: numberInRange(
      rag.hybridKeywordWeight,
      DEFAULT_RAG_SETTINGS.hybridKeywordWeight,
      0,
      1
    ),
    enrichedMetadata:
      typeof rag.enrichedMetadata === 'boolean'
        ? rag.enrichedMetadata
        : DEFAULT_RAG_SETTINGS.enrichedMetadata,
    fullContext:
      typeof rag.fullContext === 'boolean' ? rag.fullContext : DEFAULT_RAG_SETTINGS.fullContext,
    textSplitter: rag.textSplitter === 'character' ? 'character' : 'token',
    preserveHeadings:
      typeof rag.preserveHeadings === 'boolean'
        ? rag.preserveHeadings
        : DEFAULT_RAG_SETTINGS.preserveHeadings,
    chunkSize: Math.round(numberInRange(rag.chunkSize, DEFAULT_RAG_SETTINGS.chunkSize, 300, 3000)),
    chunkOverlap: Math.round(
      numberInRange(rag.chunkOverlap, DEFAULT_RAG_SETTINGS.chunkOverlap, 0, 500)
    ),
    minimumChunkSize: Math.round(
      numberInRange(rag.minimumChunkSize, DEFAULT_RAG_SETTINGS.minimumChunkSize, 0, 1500)
    ),
    pdfOcr: typeof rag.pdfOcr === 'boolean' ? rag.pdfOcr : DEFAULT_RAG_SETTINGS.pdfOcr
  }
}

function parseInferenceSettings(value: unknown): InferenceSettings {
  const inference = isRecord(value) ? value : {}
  const contextLength = [4096, 8192, 16384].includes(Number(inference.contextLength))
    ? (Number(inference.contextLength) as InferenceSettings['contextLength'])
    : DEFAULT_INFERENCE_SETTINGS.contextLength
  return {
    contextLength,
    temperature: numberInRange(inference.temperature, DEFAULT_INFERENCE_SETTINGS.temperature, 0, 1),
    topP: numberInRange(inference.topP, DEFAULT_INFERENCE_SETTINGS.topP, 0.1, 1),
    maxOutputTokens: Math.round(
      numberInRange(
        inference.maxOutputTokens,
        DEFAULT_INFERENCE_SETTINGS.maxOutputTokens,
        256,
        4096
      )
    )
  }
}

function parseModelPresets(value: unknown): ModelPresetAssignments {
  const presets = isRecord(value) ? value : {}
  return {
    performance:
      typeof presets.performance === 'string' && presets.performance.trim()
        ? presets.performance.trim()
        : DEFAULT_MODEL_PRESETS.performance,
    balanced:
      typeof presets.balanced === 'string' && presets.balanced.trim()
        ? presets.balanced.trim()
        : DEFAULT_MODEL_PRESETS.balanced,
    'high-quality':
      typeof presets['high-quality'] === 'string' && presets['high-quality'].trim()
        ? presets['high-quality'].trim()
        : DEFAULT_MODEL_PRESETS['high-quality']
  }
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function latencyFromSpeed(speed: number | null): number | null {
  return speed !== null && speed > 0 ? 1000 / speed : null
}

function parseModelPerformance(value: unknown): Record<string, ModelPerformanceStats> {
  if (!isRecord(value)) return {}
  const parsed: Record<string, ModelPerformanceStats> = {}
  for (const [model, item] of Object.entries(value)) {
    if (!isRecord(item)) continue
    const speedSamples = Math.max(0, Math.round(nullableNumber(item.speedSamples) ?? 0))
    const speedMin = nullableNumber(item.tokensPerSecondMin)
    const speedAverage = nullableNumber(item.tokensPerSecondAverage)
    const speedMax = nullableNumber(item.tokensPerSecondMax)
    parsed[model] = {
      model,
      responses: Math.max(0, Math.round(nullableNumber(item.responses) ?? 0)),
      ttftSamples: Math.max(0, Math.round(nullableNumber(item.ttftSamples) ?? 0)),
      ttftMinMs: nullableNumber(item.ttftMinMs),
      ttftAverageMs: nullableNumber(item.ttftAverageMs),
      ttftMaxMs: nullableNumber(item.ttftMaxMs),
      speedSamples,
      tokensPerSecondMin: speedMin,
      tokensPerSecondAverage: speedAverage,
      tokensPerSecondMax: speedMax,
      itlSamples: Math.max(0, Math.round(nullableNumber(item.itlSamples) ?? speedSamples)),
      interTokenLatencyMinMs:
        nullableNumber(item.interTokenLatencyMinMs) ?? latencyFromSpeed(speedMax),
      interTokenLatencyAverageMs:
        nullableNumber(item.interTokenLatencyAverageMs) ?? latencyFromSpeed(speedAverage),
      interTokenLatencyMaxMs:
        nullableNumber(item.interTokenLatencyMaxMs) ?? latencyFromSpeed(speedMin),
      e2eSamples: Math.max(0, Math.round(nullableNumber(item.e2eSamples) ?? 0)),
      endToEndLatencyMinMs: nullableNumber(item.endToEndLatencyMinMs),
      endToEndLatencyAverageMs: nullableNumber(item.endToEndLatencyAverageMs),
      endToEndLatencyMaxMs: nullableNumber(item.endToEndLatencyMaxMs),
      lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : ''
    }
  }
  return parsed
}

function parseManifest(value: unknown): Record<string, ManifestEntry> {
  if (!isRecord(value)) return {}

  const entries: Array<[string, ManifestEntry]> = []
  for (const [relativePath, item] of Object.entries(value)) {
    if (
      !isRecord(item) ||
      typeof item.checksum !== 'string' ||
      typeof item.fileId !== 'string' ||
      typeof item.size !== 'number' ||
      typeof item.modifiedAt !== 'number'
    ) {
      continue
    }
    entries.push([
      relativePath,
      {
        checksum: item.checksum,
        fileId: item.fileId,
        size: item.size,
        modifiedAt: item.modifiedAt,
        syncedAt: typeof item.syncedAt === 'string' ? item.syncedAt : null
      }
    ])
  }
  return Object.fromEntries(entries)
}

function parseSyncStats(value: unknown): SyncStats {
  const stats = isRecord(value) ? value : {}
  return {
    indexed: typeof stats.indexed === 'number' ? stats.indexed : 0,
    added: typeof stats.added === 'number' ? stats.added : 0,
    updated: typeof stats.updated === 'number' ? stats.updated : 0,
    removed: typeof stats.removed === 'number' ? stats.removed : 0,
    unchanged: typeof stats.unchanged === 'number' ? stats.unchanged : 0,
    skipped: typeof stats.skipped === 'number' ? stats.skipped : 0,
    failed: typeof stats.failed === 'number' ? stats.failed : 0,
    lastSyncedAt: typeof stats.lastSyncedAt === 'string' ? stats.lastSyncedAt : null
  }
}

function parseSyncErrors(value: unknown): SyncError[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.message !== 'string') {
      return []
    }
    const message = item.message.trim()
    return message
      ? [
          {
            path: item.path,
            message,
            technicalDetails:
              typeof item.technicalDetails === 'string'
                ? item.technicalDetails.trim().slice(0, 800)
                : undefined
          }
        ]
      : []
  })
}

function parseKnowledgeBases(value: unknown): StoredKnowledgeBase[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.folder !== 'string' || !item.folder.trim()) return []
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : randomUUID()
    return [
      {
        id,
        name:
          typeof item.name === 'string' && item.name.trim()
            ? item.name.trim()
            : path.basename(item.folder),
        folder: item.folder,
        bookmark: typeof item.bookmark === 'string' ? item.bookmark : '',
        description: typeof item.description === 'string' ? item.description.trim() : '',
        customInstructions:
          typeof item.customInstructions === 'string' ? item.customInstructions.trim() : '',
        ragBackendVersion:
          typeof item.ragBackendVersion === 'number' ? Math.max(0, item.ragBackendVersion) : 0,
        manifest: parseManifest(item.manifest),
        syncStats: parseSyncStats(item.syncStats),
        syncErrors: parseSyncErrors(item.syncErrors)
      }
    ]
  })
}

function parseConfig(value: unknown): StoredConfig {
  if (!isRecord(value)) return structuredClone(defaultConfig)
  const legacyFolder = typeof value.knowledgeFolder === 'string' ? value.knowledgeFolder : ''
  const legacyBookmark =
    typeof value.knowledgeFolderBookmark === 'string' ? value.knowledgeFolderBookmark : ''
  const legacyStats = parseSyncStats(value.syncStats)
  const legacyManifest = parseManifest(value.manifest)
  const legacyBackendVersion =
    typeof value.ragBackendVersion === 'number' ? Math.max(0, value.ragBackendVersion) : 0
  const parsedKnowledgeBases = parseKnowledgeBases(value.knowledgeBases)
  const knowledgeBases =
    parsedKnowledgeBases.length > 0
      ? parsedKnowledgeBases
      : legacyFolder
        ? [
            {
              id: 'default',
              name: path.basename(legacyFolder) || 'My knowledge base',
              folder: legacyFolder,
              bookmark: legacyBookmark,
              description: '',
              customInstructions: '',
              ragBackendVersion: legacyBackendVersion,
              manifest: legacyManifest,
              syncStats: legacyStats,
              syncErrors: []
            }
          ]
        : []
  const requestedActiveId =
    typeof value.activeKnowledgeBaseId === 'string' ? value.activeKnowledgeBaseId : ''
  const active =
    knowledgeBases.find((item) => item.id === requestedActiveId) ?? knowledgeBases[0] ?? null

  return {
    knowledgeFolder: active?.folder ?? '',
    knowledgeFolderBookmark: active?.bookmark ?? '',
    selectedModel:
      typeof value.selectedModel === 'string' &&
      value.selectedModel.trim() &&
      value.selectedModel !== 'balanced'
        ? value.selectedModel.trim()
        : CHAT_MODEL,
    embeddingModel: supportedModel(
      value.embeddingModel,
      EMBEDDING_MODEL_OPTIONS,
      LEGACY_EMBEDDING_MODEL
    ),
    rerankerModel: supportedModel(value.rerankerModel, RERANKER_MODEL_OPTIONS, RERANKER_MODEL),
    modelPresets: parseModelPresets(value.modelPresets),
    rag: parseRagSettings(value.rag),
    inference: parseInferenceSettings(value.inference),
    ragBackendVersion: active?.ragBackendVersion ?? 0,
    manifest: active?.manifest ?? {},
    syncStats: active?.syncStats ?? structuredClone(emptySyncStats),
    modelPerformance: parseModelPerformance(value.modelPerformance),
    knowledgeBases,
    activeKnowledgeBaseId: active?.id ?? ''
  }
}

export async function readConfig(): Promise<StoredConfig> {
  for (const filePath of [getConfigPath(), getConfigBackupPath()]) {
    try {
      return parseConfig(JSON.parse(await readFile(filePath, 'utf8')))
    } catch {
      // Try the last known-good copy before returning a clean configuration.
    }
  }
  return structuredClone(defaultConfig)
}

function activeSnapshot(config: StoredConfig): StoredKnowledgeBase | null {
  return (
    config.knowledgeBases.find((item) => item.id === config.activeKnowledgeBaseId) ??
    config.knowledgeBases[0] ??
    null
  )
}

function persistActiveSnapshot(config: StoredConfig): StoredConfig {
  if (!config.activeKnowledgeBaseId) return config
  return {
    ...config,
    knowledgeBases: config.knowledgeBases.map((item) =>
      item.id === config.activeKnowledgeBaseId
        ? {
            ...item,
            folder: config.knowledgeFolder,
            bookmark: config.knowledgeFolderBookmark,
            ragBackendVersion: config.ragBackendVersion,
            manifest: config.manifest,
            syncStats: config.syncStats
          }
        : item
    )
  }
}

async function writeConfig(config: StoredConfig): Promise<void> {
  const filePath = getConfigPath()
  const temporaryPath = `${filePath}.tmp`
  const backupPath = getConfigBackupPath()
  const backupTemporaryPath = `${backupPath}.tmp`
  const contents = JSON.stringify(config, null, 2)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(temporaryPath, contents, { mode: 0o600 })
  await rename(temporaryPath, filePath)
  try {
    await writeFile(backupTemporaryPath, contents, { mode: 0o600 })
    await rename(backupTemporaryPath, backupPath)
  } catch (error) {
    await rm(backupTemporaryPath, { force: true }).catch(() => undefined)
    console.warn('Could not update the settings backup:', error)
  }
}

export async function updateConfig(
  update: (current: StoredConfig) => StoredConfig
): Promise<StoredConfig> {
  const operation = updateQueue.then(async () => {
    const next = persistActiveSnapshot(update(await readConfig()))
    await writeConfig(next)
    return next
  })
  updateQueue = operation.then(
    () => undefined,
    () => undefined
  )
  return operation
}

export function publicSettings(config: StoredConfig): AppSettings {
  const bases: KnowledgeBase[] = config.knowledgeBases.map((item) => ({
    id: item.id,
    name: item.name,
    folder: item.folder,
    description: item.description,
    customInstructions: item.customInstructions,
    syncStats:
      item.ragBackendVersion >= 2
        ? item.syncStats
        : { ...item.syncStats, indexed: 0, lastSyncedAt: null },
    syncErrors: item.syncErrors
  }))
  return {
    knowledgeFolder: config.knowledgeFolder,
    knowledgeBases: bases,
    activeKnowledgeBaseId: config.activeKnowledgeBaseId,
    selectedModel: config.selectedModel,
    embeddingModel: config.embeddingModel,
    rerankerModel: config.rerankerModel,
    modelPresets: config.modelPresets,
    rag: config.rag,
    inference: config.inference,
    syncStats:
      config.ragBackendVersion >= 2
        ? config.syncStats
        : { ...config.syncStats, indexed: 0, lastSyncedAt: null }
  }
}

export function knowledgeFiles(config: StoredConfig, knowledgeBaseId?: string): KnowledgeFile[] {
  const base = knowledgeBaseId
    ? config.knowledgeBases.find((item) => item.id === knowledgeBaseId)
    : activeSnapshot(config)
  if (!base) return []
  return Object.entries(base.manifest)
    .map(([relativePath, entry]) => ({
      path: relativePath,
      name: path.basename(relativePath),
      sizeBytes: entry.size,
      modifiedAt: new Date(entry.modifiedAt).toISOString(),
      syncedAt: entry.syncedAt ?? base.syncStats.lastSyncedAt
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

export function applySettingsPatch(config: StoredConfig, patch: SettingsPatch): StoredConfig {
  const selected =
    typeof patch.activeKnowledgeBaseId === 'string' && patch.activeKnowledgeBaseId
      ? selectKnowledgeBase(config, patch.activeKnowledgeBaseId)
      : config
  return {
    ...selected,
    selectedModel:
      typeof patch.selectedModel === 'string' && patch.selectedModel.trim()
        ? patch.selectedModel.trim()
        : selected.selectedModel,
    embeddingModel:
      typeof patch.embeddingModel === 'string' && patch.embeddingModel.trim()
        ? patch.embeddingModel.trim()
        : selected.embeddingModel,
    rerankerModel:
      typeof patch.rerankerModel === 'string' && patch.rerankerModel.trim()
        ? patch.rerankerModel.trim()
        : selected.rerankerModel,
    modelPresets: parseModelPresets({ ...selected.modelPresets, ...patch.modelPresets }),
    rag: parseRagSettings({ ...selected.rag, ...patch.rag }),
    inference: parseInferenceSettings({ ...selected.inference, ...patch.inference })
  }
}

export function selectKnowledgeBase(config: StoredConfig, id: string): StoredConfig {
  const base = config.knowledgeBases.find((item) => item.id === id)
  if (!base) return config
  return {
    ...config,
    activeKnowledgeBaseId: base.id,
    knowledgeFolder: base.folder,
    knowledgeFolderBookmark: base.bookmark,
    ragBackendVersion: base.ragBackendVersion,
    manifest: base.manifest,
    syncStats: base.syncStats
  }
}

export function addKnowledgeBase(
  config: StoredConfig,
  input: {
    name: string
    folder: string
    bookmark: string
    description: string
    customInstructions: string
  }
): StoredConfig {
  const base: StoredKnowledgeBase = {
    id: randomUUID(),
    name: input.name.trim() || path.basename(input.folder) || 'My knowledge base',
    folder: input.folder,
    bookmark: input.bookmark,
    description: input.description.trim(),
    customInstructions: input.customInstructions.trim(),
    ragBackendVersion: 0,
    manifest: {},
    syncStats: structuredClone(emptySyncStats),
    syncErrors: []
  }
  return selectKnowledgeBase(
    { ...config, knowledgeBases: [...config.knowledgeBases, base] },
    base.id
  )
}

export function updateKnowledgeBaseDetails(
  config: StoredConfig,
  id: string,
  details: { name?: string; description?: string; customInstructions?: string }
): StoredConfig {
  return {
    ...config,
    knowledgeBases: config.knowledgeBases.map((item) =>
      item.id === id
        ? {
            ...item,
            name: details.name?.trim() || item.name,
            description:
              typeof details.description === 'string'
                ? details.description.trim()
                : item.description,
            customInstructions:
              typeof details.customInstructions === 'string'
                ? details.customInstructions.trim()
                : item.customInstructions
          }
        : item
    )
  }
}

export function removeKnowledgeBase(config: StoredConfig, id: string): StoredConfig {
  const remaining = config.knowledgeBases.filter((item) => item.id !== id)
  if (remaining.length === 0) {
    return {
      ...config,
      knowledgeBases: [],
      activeKnowledgeBaseId: '',
      knowledgeFolder: '',
      knowledgeFolderBookmark: '',
      ragBackendVersion: 0,
      manifest: {},
      syncStats: structuredClone(emptySyncStats)
    }
  }
  return selectKnowledgeBase(
    { ...config, knowledgeBases: remaining },
    config.activeKnowledgeBaseId === id ? remaining[0].id : config.activeKnowledgeBaseId
  )
}

export function ingestionSettingsChanged(before: RagSettings, after: RagSettings): boolean {
  return (
    before.textSplitter !== after.textSplitter ||
    before.preserveHeadings !== after.preserveHeadings ||
    before.chunkSize !== after.chunkSize ||
    before.chunkOverlap !== after.chunkOverlap ||
    before.minimumChunkSize !== after.minimumChunkSize ||
    before.pdfOcr !== after.pdfOcr ||
    before.enrichedMetadata !== after.enrichedMetadata
  )
}

function updatedAverage(
  currentAverage: number | null,
  currentCount: number,
  sample: number
): number {
  return ((currentAverage ?? 0) * currentCount + sample) / (currentCount + 1)
}

export async function recordModelPerformance(
  model: string,
  metrics: ChatPerformanceMetrics
): Promise<void> {
  await updateConfig((current) => {
    const previous = current.modelPerformance[model] ?? {
      model,
      responses: 0,
      ttftSamples: 0,
      ttftMinMs: null,
      ttftAverageMs: null,
      ttftMaxMs: null,
      speedSamples: 0,
      tokensPerSecondMin: null,
      tokensPerSecondAverage: null,
      tokensPerSecondMax: null,
      itlSamples: 0,
      interTokenLatencyMinMs: null,
      interTokenLatencyAverageMs: null,
      interTokenLatencyMaxMs: null,
      e2eSamples: 0,
      endToEndLatencyMinMs: null,
      endToEndLatencyAverageMs: null,
      endToEndLatencyMaxMs: null,
      lastUsedAt: ''
    }
    const next = {
      ...previous,
      responses: previous.responses + 1,
      lastUsedAt: new Date().toISOString()
    }

    if (metrics.timeToFirstTokenMs !== null) {
      const sample = metrics.timeToFirstTokenMs
      next.ttftAverageMs = updatedAverage(previous.ttftAverageMs, previous.ttftSamples, sample)
      next.ttftSamples = previous.ttftSamples + 1
      next.ttftMinMs = previous.ttftMinMs === null ? sample : Math.min(previous.ttftMinMs, sample)
      next.ttftMaxMs = previous.ttftMaxMs === null ? sample : Math.max(previous.ttftMaxMs, sample)
    }
    if (metrics.tokensPerSecond !== null) {
      const sample = metrics.tokensPerSecond
      next.tokensPerSecondAverage = updatedAverage(
        previous.tokensPerSecondAverage,
        previous.speedSamples,
        sample
      )
      next.speedSamples = previous.speedSamples + 1
      next.tokensPerSecondMin =
        previous.tokensPerSecondMin === null
          ? sample
          : Math.min(previous.tokensPerSecondMin, sample)
      next.tokensPerSecondMax =
        previous.tokensPerSecondMax === null
          ? sample
          : Math.max(previous.tokensPerSecondMax, sample)
    }
    if (metrics.interTokenLatencyMs !== null) {
      const sample = metrics.interTokenLatencyMs
      next.interTokenLatencyAverageMs = updatedAverage(
        previous.interTokenLatencyAverageMs,
        previous.itlSamples,
        sample
      )
      next.itlSamples = previous.itlSamples + 1
      next.interTokenLatencyMinMs =
        previous.interTokenLatencyMinMs === null
          ? sample
          : Math.min(previous.interTokenLatencyMinMs, sample)
      next.interTokenLatencyMaxMs =
        previous.interTokenLatencyMaxMs === null
          ? sample
          : Math.max(previous.interTokenLatencyMaxMs, sample)
    }
    if (Number.isFinite(metrics.totalDurationMs) && metrics.totalDurationMs >= 0) {
      const sample = metrics.totalDurationMs
      next.endToEndLatencyAverageMs = updatedAverage(
        previous.endToEndLatencyAverageMs,
        previous.e2eSamples,
        sample
      )
      next.e2eSamples = previous.e2eSamples + 1
      next.endToEndLatencyMinMs =
        previous.endToEndLatencyMinMs === null
          ? sample
          : Math.min(previous.endToEndLatencyMinMs, sample)
      next.endToEndLatencyMaxMs =
        previous.endToEndLatencyMaxMs === null
          ? sample
          : Math.max(previous.endToEndLatencyMaxMs, sample)
    }

    return {
      ...current,
      modelPerformance: { ...current.modelPerformance, [model]: next }
    }
  })
}
