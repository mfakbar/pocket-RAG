import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppCommand,
  AppearanceMode,
  AppSettings,
  ChatAttachment,
  ChatRequest,
  ChatStartResult,
  ChatStreamEvent,
  DeviceModelRecommendations,
  KnowledgeBaseInput,
  KnowledgeFile,
  KnowledgeStaleness,
  KnowledgeSyncStatus,
  ModelDeleteResult,
  ModelOption,
  ModelOperationProgress,
  ModelSizeAssessment,
  PrepareProgress,
  PrepareResult,
  PromptEnhancementResult,
  ResourceMetrics,
  RuntimeStatus,
  SettingsPatch,
  SettingsUpdateResult,
  SyncProgress,
  SyncResult
} from '../shared/contracts'

export interface AppAPI {
  onAppCommand: (listener: (command: AppCommand) => void) => () => void
  setAppearance: (mode: AppearanceMode) => Promise<boolean>
  copyText: (text: string) => Promise<boolean>
  confirmSensitiveAccess: () => Promise<boolean>
  selectFolder: () => Promise<string | null>
  selectChatFiles: () => Promise<ChatAttachment[]>
  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: SettingsPatch) => Promise<SettingsUpdateResult>
  listModels: () => Promise<ModelOption[]>
  warmSelectedModel: () => Promise<boolean>
  assessModel: (model: string) => Promise<ModelSizeAssessment>
  getDeviceModelRecommendations: () => Promise<DeviceModelRecommendations>
  downloadModel: (model: string) => Promise<ModelOption[]>
  cancelModelDownload: (model: string) => Promise<boolean>
  deleteModel: (model: string) => Promise<ModelDeleteResult>
  onModelProgress: (listener: (progress: ModelOperationProgress) => void) => () => void
  getResourceMetrics: () => Promise<ResourceMetrics>
  getRuntimeStatus: () => Promise<RuntimeStatus>
  prepareRuntime: (selectedModel?: string) => Promise<PrepareResult>
  cancelPreparation: () => Promise<boolean>
  restartLocalAI: () => Promise<boolean>
  onPrepareProgress: (listener: (progress: PrepareProgress) => void) => () => void
  createKnowledgeBase: (input: KnowledgeBaseInput) => Promise<AppSettings | null>
  updateKnowledgeBase: (id: string, details: Partial<KnowledgeBaseInput>) => Promise<AppSettings>
  selectKnowledgeBase: (id: string) => Promise<AppSettings>
  removeKnowledgeBase: (id: string) => Promise<AppSettings>
  syncKnowledgeBase: (knowledgeBaseId?: string) => Promise<SyncResult>
  getKnowledgeSyncStatus: () => Promise<KnowledgeSyncStatus>
  getKnowledgeStaleness: (knowledgeBaseId?: string) => Promise<KnowledgeStaleness>
  listKnowledgeFiles: (knowledgeBaseId?: string) => Promise<KnowledgeFile[]>
  openCitation: (knowledgeBaseId: string | undefined, file: string) => Promise<boolean>
  revealCitation: (knowledgeBaseId: string | undefined, file: string) => Promise<boolean>
  revealRagStageOutcome: (stageId: string) => Promise<boolean>
  rebuildKnowledgeBase: (knowledgeBaseId?: string) => Promise<SyncResult>
  onSyncProgress: (listener: (progress: SyncProgress) => void) => () => void
  startChat: (request: ChatRequest) => Promise<ChatStartResult>
  enhancePrompt: (prompt: string, knowledgeBaseIds: string[]) => Promise<PromptEnhancementResult>
  cancelChat: (requestId: string) => Promise<boolean>
  onChatEvent: (listener: (event: ChatStreamEvent) => void) => () => void
}

const api: AppAPI = {
  onAppCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: AppCommand): void =>
      listener(command)
    ipcRenderer.on('app:command', handler)
    return () => ipcRenderer.removeListener('app:command', handler)
  },
  setAppearance: (mode) => ipcRenderer.invoke('appearance:set', mode),
  copyText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  confirmSensitiveAccess: () => ipcRenderer.invoke('chat:confirm-sensitive-access'),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  selectChatFiles: () => ipcRenderer.invoke('dialog:select-chat-files'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  listModels: () => ipcRenderer.invoke('models:list'),
  warmSelectedModel: () => ipcRenderer.invoke('models:warm-selected'),
  assessModel: (model) => ipcRenderer.invoke('models:assess', model),
  getDeviceModelRecommendations: () => ipcRenderer.invoke('models:recommendations'),
  downloadModel: (model) => ipcRenderer.invoke('models:download', model),
  cancelModelDownload: (model) => ipcRenderer.invoke('models:cancel-download', model),
  deleteModel: (model) => ipcRenderer.invoke('models:delete', model),
  onModelProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ModelOperationProgress): void =>
      listener(progress)
    ipcRenderer.on('models:progress', handler)
    return () => ipcRenderer.removeListener('models:progress', handler)
  },
  getResourceMetrics: () => ipcRenderer.invoke('resources:get'),
  getRuntimeStatus: () => ipcRenderer.invoke('runtime:status'),
  prepareRuntime: (selectedModel) => ipcRenderer.invoke('runtime:prepare', selectedModel),
  cancelPreparation: () => ipcRenderer.invoke('runtime:cancel-prepare'),
  restartLocalAI: () => ipcRenderer.invoke('runtime:restart-local-ai'),
  onPrepareProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: PrepareProgress): void =>
      listener(progress)
    ipcRenderer.on('runtime:progress', handler)
    return () => ipcRenderer.removeListener('runtime:progress', handler)
  },
  createKnowledgeBase: (input) => ipcRenderer.invoke('knowledge:create', input),
  updateKnowledgeBase: (id, details) => ipcRenderer.invoke('knowledge:update', id, details),
  selectKnowledgeBase: (id) => ipcRenderer.invoke('knowledge:select', id),
  removeKnowledgeBase: (id) => ipcRenderer.invoke('knowledge:remove', id),
  syncKnowledgeBase: (knowledgeBaseId) => ipcRenderer.invoke('knowledge:sync', knowledgeBaseId),
  getKnowledgeSyncStatus: () => ipcRenderer.invoke('knowledge:sync-status'),
  getKnowledgeStaleness: (knowledgeBaseId) =>
    ipcRenderer.invoke('knowledge:staleness', knowledgeBaseId),
  listKnowledgeFiles: (knowledgeBaseId) =>
    ipcRenderer.invoke('knowledge:list-files', knowledgeBaseId),
  openCitation: (knowledgeBaseId, file) =>
    ipcRenderer.invoke('citation:open', knowledgeBaseId, file),
  revealCitation: (knowledgeBaseId, file) =>
    ipcRenderer.invoke('citation:reveal', knowledgeBaseId, file),
  revealRagStageOutcome: (stageId) => ipcRenderer.invoke('rag:reveal-stage-outcome', stageId),
  rebuildKnowledgeBase: (knowledgeBaseId) =>
    ipcRenderer.invoke('knowledge:rebuild', knowledgeBaseId),
  onSyncProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: SyncProgress): void =>
      listener(progress)
    ipcRenderer.on('knowledge:progress', handler)
    return () => ipcRenderer.removeListener('knowledge:progress', handler)
  },
  startChat: (request) => ipcRenderer.invoke('chat:start', request),
  enhancePrompt: (prompt, knowledgeBaseIds) =>
    ipcRenderer.invoke('chat:enhance-prompt', prompt, knowledgeBaseIds),
  cancelChat: (requestId) => ipcRenderer.invoke('chat:cancel', requestId),
  onChatEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, streamEvent: ChatStreamEvent): void =>
      listener(streamEvent)
    ipcRenderer.on('chat:event', handler)
    return () => ipcRenderer.removeListener('chat:event', handler)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  throw new Error('RavnDock requires Electron context isolation.')
}
