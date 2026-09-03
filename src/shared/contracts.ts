export const PERFORMANCE_MODEL = 'qwen3.5:2b-q4_K_M'
export const CHAT_MODEL = 'qwen3.5:4b-q4_K_M'
export const HIGH_QUALITY_MODEL = 'qwen3.5:9b-q4_K_M'
export const EMBEDDING_MODEL = 'qwen3-embedding:4b'
export const RERANKER_MODEL = 'BAAI/bge-reranker-v2-m3'

export const EMBEDDING_MODEL_OPTIONS = [
  {
    id: EMBEDDING_MODEL,
    label: 'Best quality',
    description: 'Recommended for the most accurate document search.'
  },
  {
    id: 'qwen3-embedding:0.6b',
    label: 'Faster',
    description: 'Uses less memory and searches more quickly.'
  }
] as const

export const RERANKER_MODEL_OPTIONS = [
  {
    id: RERANKER_MODEL,
    label: 'Best quality',
    description: 'Multilingual matching with the highest retrieval quality.'
  },
  {
    id: 'BAAI/bge-reranker-base',
    label: 'Faster',
    description: 'A smaller English and Chinese model that uses less memory.'
  }
] as const

export type AppCommand =
  'new-chat' | 'home' | 'chat' | 'monitor' | 'settings' | 'about' | 'toggle-sidebar'
export type AppearanceMode = 'system' | 'light' | 'dark'

export type ModelPresetId = 'performance' | 'balanced' | 'high-quality'
export type ModelPresetAssignments = Record<ModelPresetId, string>

export const DEFAULT_MODEL_PRESETS: ModelPresetAssignments = {
  performance: PERFORMANCE_MODEL,
  balanced: CHAT_MODEL,
  'high-quality': HIGH_QUALITY_MODEL
}

export const MODEL_PRESETS = [
  {
    id: 'performance',
    label: 'Performance',
    model: PERFORMANCE_MODEL,
    description: 'Fastest answers for quick lookups.'
  },
  {
    id: 'balanced',
    label: 'Balanced',
    model: CHAT_MODEL,
    description: 'Best mix of speed and detail.'
  },
  {
    id: 'high-quality',
    label: 'High Quality',
    model: HIGH_QUALITY_MODEL,
    description: 'Most detailed answers. Uses more memory.'
  }
] as const

export interface RagSettings {
  topK: number
  improveDocumentMatching: boolean
  hybridSearch: boolean
  hybridKeywordWeight: number
  enrichedMetadata: boolean
  fullContext: boolean
  textSplitter: 'token' | 'character'
  preserveHeadings: boolean
  chunkSize: number
  chunkOverlap: number
  minimumChunkSize: number
  pdfOcr: boolean
}

export interface InferenceSettings {
  contextLength: 4096 | 8192 | 16384
  temperature: number
  topP: number
  maxOutputTokens: number
}

export const DEFAULT_RAG_SETTINGS: RagSettings = {
  topK: 4,
  improveDocumentMatching: false,
  hybridSearch: true,
  hybridKeywordWeight: 0.5,
  enrichedMetadata: true,
  fullContext: false,
  textSplitter: 'token',
  preserveHeadings: true,
  chunkSize: 1000,
  chunkOverlap: 100,
  minimumChunkSize: 500,
  pdfOcr: false
}

export const DEFAULT_INFERENCE_SETTINGS: InferenceSettings = {
  contextLength: 8192,
  temperature: 0.2,
  topP: 0.9,
  maxOutputTokens: 1024
}

export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  '.csv',
  '.txt',
  '.md',
  '.png',
  '.jpg',
  '.jpeg'
] as const

export type RuntimeStep =
  'ollama' | 'models' | 'rag-runtime' | 'knowledge-engine' | 'knowledge-base'

export type PrepareStep = RuntimeStep | 'documents'

export type ComponentState = 'ready' | 'missing' | 'stopped' | 'working' | 'error'

export interface ComponentStatus {
  state: ComponentState
  message: string
}

export interface RuntimeStatus {
  ready: boolean
  components: Record<RuntimeStep, ComponentStatus>
  installedModels: string[]
  missingModels: string[]
}

export interface PrepareProgress {
  step: PrepareStep
  state: ComponentState
  message: string
  progress?: number
  downloadedBytes?: number
  totalBytes?: number
}

export interface PrepareResult {
  ok: boolean
  status: RuntimeStatus
  message: string
  failure?: UserFacingFailure
}

export interface SyncStats {
  indexed: number
  added: number
  updated: number
  removed: number
  unchanged: number
  skipped: number
  failed: number
  lastSyncedAt: string | null
}

export interface SyncResult extends SyncStats {
  ok: boolean
  message: string
  errors: SyncError[]
}

export interface SyncError {
  path: string
  message: string
  technicalDetails?: string
}

export interface SyncProgress {
  phase: 'scanning' | 'uploading' | 'removing' | 'suggesting' | 'complete'
  current: number
  total: number
  path?: string
  message: string
}

export interface KnowledgeSyncStatus {
  active: boolean
  knowledgeBaseId: string | null
  progress: SyncProgress | null
}

export interface KnowledgeStaleness {
  stale: boolean
  changedFiles: number
  checkedAt: string
}

export interface KnowledgeFile {
  path: string
  name: string
  sizeBytes: number
  modifiedAt: string
  syncedAt: string | null
}

export interface KnowledgeBase {
  id: string
  name: string
  folder: string
  description: string
  customInstructions: string
  syncStats: SyncStats
  syncErrors: SyncError[]
}

export interface KnowledgeBaseInput {
  name: string
  description: string
  customInstructions?: string
}

export interface AppSettings {
  knowledgeFolder: string
  knowledgeBases: KnowledgeBase[]
  activeKnowledgeBaseId: string
  selectedModel: string
  embeddingModel: string
  rerankerModel: string
  modelPresets: ModelPresetAssignments
  rag: RagSettings
  inference: InferenceSettings
  syncStats: SyncStats
}

export interface ModelOption {
  id: string
  sizeBytes: number
  parameterSize: string
  quantization: string
  contextLength?: number
  capabilities: string[]
  recommendation: string
  recommended: boolean
}

export interface ModelOperationProgress {
  model: string
  state: 'working' | 'ready' | 'error' | 'cancelled'
  message: string
  progress: number
  downloadedBytes?: number
  totalBytes?: number
}

export interface ModelSizeAssessment {
  model: string
  parameterBillions: number | null
  level: 'ok' | 'caution' | 'high'
  message: string
}

export interface ModelDeleteResult {
  settings: AppSettings
  message: string
}

export interface RunningModelMetric {
  name: string
  sizeBytes: number
  acceleratorBytes: number
  contextLength: number | null
}

export interface ResourceMetrics {
  sampledAt: string
  system: {
    cpuPercent: number
    memoryUsedBytes: number
    memoryTotalBytes: number
    memoryPercent: number
    swapUsedBytes: number | null
    swapTotalBytes: number | null
    swapInBytesPerSecond: number | null
    swapOutBytesPerSecond: number | null
    logicalCores: number
    uptimeSeconds: number
    diskAvailableBytes: number | null
    diskTotalBytes: number | null
    temperatureC: number | null
    temperatureLabel: string
  }
  app: {
    cpuPercent: number
    memoryBytes: number
    memoryPercent: number
    processCount: number
    processes: AppProcessMetric[]
    uptimeSeconds: number
    gpuProcessMemoryBytes: number
  }
  gpu: {
    available: boolean
    percent: number | null
    model: string
    coreCount: number | null
    note: string
  }
  localAi: {
    running: boolean
    totalModelBytes: number
    acceleratorBytes: number
    models: RunningModelMetric[]
  }
  modelPerformance: ModelPerformanceStats[]
}

export interface AppProcessMetric {
  type: string
  cpuPercent: number
  memoryBytes: number
}

export interface ChatPerformanceMetrics {
  timeToFirstTokenMs: number | null
  totalDurationMs: number
  completionTokens: number | null
  tokensPerSecond: number | null
  interTokenLatencyMs: number | null
  generationTokensPerSecond?: number | null
  repairDurationMs?: number
  repairTokensPerSecond?: number | null
  cached?: boolean
  retrievalScope?: RetrievalSourceScope
}

export interface RetrievalSourceScope {
  files: string[]
  sheets: string[]
  reason:
    'explicit_filename' | 'unique_metadata' | 'unique_sheet' | 'ambiguous_metadata' | 'unresolved'
  confidence: number
}

export interface ModelPerformanceStats {
  model: string
  responses: number
  ttftSamples: number
  ttftMinMs: number | null
  ttftAverageMs: number | null
  ttftMaxMs: number | null
  speedSamples: number
  tokensPerSecondMin: number | null
  tokensPerSecondAverage: number | null
  tokensPerSecondMax: number | null
  itlSamples: number
  interTokenLatencyMinMs: number | null
  interTokenLatencyAverageMs: number | null
  interTokenLatencyMaxMs: number | null
  e2eSamples: number
  endToEndLatencyMinMs: number | null
  endToEndLatencyAverageMs: number | null
  endToEndLatencyMaxMs: number | null
  lastUsedAt: string
}

export interface SettingsPatch {
  selectedModel?: string
  embeddingModel?: string
  rerankerModel?: string
  activeKnowledgeBaseId?: string
  modelPresets?: Partial<ModelPresetAssignments>
  rag?: Partial<RagSettings>
  inference?: Partial<InferenceSettings>
}

export interface SettingsUpdateResult {
  settings: AppSettings
  rebuildRequired: boolean
  message: string
}

export interface Citation {
  file: string
  location: string
  knowledgeBaseId?: string
  knowledgeBaseName?: string
  excerpt?: string
}

export type RecoveryActionId =
  | 'retry-chat'
  | 'restart-local-ai'
  | 'open-settings'
  | 'choose-files'
  | 'sync-files'
  | 'edit-question'

export interface RecoveryAction {
  id: RecoveryActionId
  label: string
}

export interface UserFacingFailure {
  title: string
  message: string
  code: string
  retryable: boolean
  primaryAction?: RecoveryAction
  secondaryAction?: RecoveryAction
  technicalDetails?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatAttachment {
  path: string
  name: string
  sizeBytes: number
}

export interface ChatRequest {
  messages: ChatMessage[]
  useKnowledgeBase: boolean
  knowledgeBaseIds: string[]
  attachmentPaths?: string[]
  sensitiveAccessConfirmed?: boolean
}

export interface PromptEnhancementResult {
  original: string
  enhanced: string
  model: string
}

export interface SuggestedModel {
  model: string
  description: string
  estimatedSize: string
}

export interface DeviceModelRecommendations {
  deviceMemoryBytes: number
  deviceSummary: string
  performance: SuggestedModel[]
  balanced: SuggestedModel[]
  highQuality: SuggestedModel[]
}

export type ChatStreamEvent =
  | { requestId: string; type: 'token'; content: string }
  | { requestId: string; type: 'replace'; content: string }
  | { requestId: string; type: 'citations'; citations: Citation[] }
  | { requestId: string; type: 'status'; message: string }
  | { requestId: string; type: 'notice'; message: string }
  | { requestId: string; type: 'sensitive-action'; available: boolean }
  | { requestId: string; type: 'done'; metrics?: ChatPerformanceMetrics }
  | { requestId: string; type: 'error'; message: string; failure?: UserFacingFailure }

export interface ChatStartResult {
  ok: boolean
  requestId: string
  message?: string
  failure?: UserFacingFailure
}
