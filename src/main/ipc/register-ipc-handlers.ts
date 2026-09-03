import { randomUUID } from 'node:crypto'
import path, { basename, extname } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import {
  type ChatAttachment,
  type ChatStreamEvent,
  type KnowledgeBaseInput,
  type KnowledgeSyncStatus,
  type ModelOperationProgress,
  type PrepareProgress,
  type SettingsPatch,
  type SyncProgress,
  type SyncResult,
  EMBEDDING_MODEL_OPTIONS,
  RERANKER_MODEL_OPTIONS,
  SUPPORTED_DOCUMENT_EXTENSIONS
} from '../../shared/contracts'
import { normalizeModelText } from '../../shared/model-text'
import { routedModel } from '../../shared/model-routing'
import { PocketRagError, userFacingFailure } from '../lib/errors'
import { isTrustedRendererUrl } from '../lib/window-security'
import { fallbackEnhancedPrompt, isSemanticallySafeEnhancedPrompt } from '../lib/prompt-enhancement'
import { isFileInventoryQuestion, resolveConversationQuestion } from '../lib/rag-pipeline'
import {
  applySettingsPatch,
  addKnowledgeBase,
  ingestionSettingsChanged,
  knowledgeFiles,
  publicSettings,
  readConfig,
  recordModelPerformance,
  removeKnowledgeBase,
  selectKnowledgeBase,
  updateKnowledgeBaseDetails,
  updateConfig
} from '../settings'
import { KnowledgeService, RAG_BACKEND_VERSION } from '../services/knowledge-service'
import { LocalRagService } from '../services/local-rag-service'
import { OllamaService } from '../services/ollama-service'
import { ResourceMonitorService } from '../services/resource-monitor-service'
import { RuntimeOrchestrator } from '../services/runtime-orchestrator'
import { useKnowledgeFolderBookmark } from '../services/security-scoped-access'
import { validChatRequest, validModelName } from './validation'

const MAX_CHAT_ATTACHMENTS = 10
const MAX_CHAT_ATTACHMENT_BYTES = 100 * 1024 * 1024

function handleTrusted<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    const senderFrame = event.senderFrame
    const isMainFrame = Boolean(senderFrame && senderFrame === event.sender.mainFrame)
    const isTrustedUrl = isTrustedRendererUrl(
      senderFrame?.url ?? '',
      process.env.ELECTRON_RENDERER_URL
    )
    if (!senderWindow || senderWindow.isDestroyed() || !isMainFrame || !isTrustedUrl) {
      throw new Error('RavnDock blocked a request from an untrusted window.')
    }
    return listener(event, ...(args as Args))
  })
}

export function registerIpcHandlers(
  runtime: RuntimeOrchestrator,
  knowledge: KnowledgeService,
  rag: LocalRagService,
  ingestionRag: LocalRagService,
  ollama: OllamaService,
  resources: ResourceMonitorService
): void {
  const activeChats = new Map<string, AbortController>()
  const activeDownloads = new Map<string, AbortController>()
  let activeRuntimePreparation: AbortController | null = null
  const selectedChatAttachments = new Set<string>()

  handleTrusted('appearance:set', (_event, mode: unknown) => {
    if (mode !== 'system' && mode !== 'light' && mode !== 'dark') {
      throw new Error('Invalid appearance mode.')
    }
    nativeTheme.themeSource = mode
    return nativeTheme.shouldUseDarkColors
  })
  handleTrusted('clipboard:write-text', (_event, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Nothing to copy.')
    clipboard.writeText(text)
    return true
  })
  handleTrusted('chat:confirm-sensitive-access', async () => {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'Reveal sensitive value?',
      message: 'Reveal this sensitive value once?',
      detail:
        'It will be displayed in this chat and saved in local chat history. Make sure nobody else can see your screen.',
      buttons: ['Cancel', 'Reveal once'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    return result.response === 1
  })
  handleTrusted('runtime:restart-local-ai', async () => {
    await ollama.ensureRunning()
    return true
  })
  let activeKnowledgeSync: {
    knowledgeBaseId: string
    promise: Promise<SyncResult>
    progress: SyncProgress | null
  } | null = null

  const broadcastSyncProgress = (progress: SyncProgress): void => {
    if (activeKnowledgeSync) activeKnowledgeSync.progress = progress
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('knowledge:progress', progress)
    }
  }

  const knowledgeSyncStatus = (): KnowledgeSyncStatus => ({
    active: Boolean(activeKnowledgeSync),
    knowledgeBaseId: activeKnowledgeSync?.knowledgeBaseId ?? null,
    progress: activeKnowledgeSync?.progress ?? null
  })

  const protectActiveKnowledgeBase = (knowledgeBaseId: string): void => {
    if (activeKnowledgeSync?.knowledgeBaseId === knowledgeBaseId) {
      throw new Error(
        'This knowledge base is syncing. You can keep using RavnDock while it finishes.'
      )
    }
  }

  const runKnowledgeSync = async (
    knowledgeBaseId: string,
    rebuild = false
  ): Promise<SyncResult> => {
    if (activeKnowledgeSync) {
      if (activeKnowledgeSync.knowledgeBaseId === knowledgeBaseId) {
        return activeKnowledgeSync.promise
      }
      throw new Error('Another knowledge base is syncing. You can start this one when it finishes.')
    }

    const promise = (async (): Promise<SyncResult> => {
      await ollama.ensureRunning()
      if (activeChats.size === 0) await ollama.unloadModelsExcept([])
      try {
        const syncResult = rebuild
          ? await knowledge.rebuild(knowledgeBaseId, broadcastSyncProgress)
          : await knowledge.sync(knowledgeBaseId, broadcastSyncProgress)
        if (syncResult.ok) {
          broadcastSyncProgress({
            phase: 'complete',
            current: syncResult.indexed,
            total: syncResult.indexed,
            message: syncResult.message
          })
        }
        return syncResult
      } finally {
        if (activeChats.size === 0) {
          await ingestionRag.releaseEmbedding().catch(() => undefined)
        }
      }
    })()

    activeKnowledgeSync = { knowledgeBaseId, promise, progress: null }
    try {
      return await promise
    } finally {
      if (activeKnowledgeSync?.promise === promise) activeKnowledgeSync = null
    }
  }

  handleTrusted('dialog:select-folder', async () => {
    const existing = await readConfig()
    if (existing.activeKnowledgeBaseId) protectActiveKnowledgeBase(existing.activeKnowledgeBaseId)
    const result = await dialog.showOpenDialog({
      title: 'Choose Your Knowledge Folder',
      buttonLabel: 'Use This Folder',
      defaultPath: existing.knowledgeFolder || undefined,
      properties: ['openDirectory', 'createDirectory'],
      securityScopedBookmarks: true
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const folderPath = result.filePaths[0]
    const folderChanged = existing.knowledgeFolder !== folderPath
    const bookmark =
      result.bookmarks?.[0] ?? (folderChanged ? '' : existing.knowledgeFolderBookmark)
    await updateConfig((current) => {
      if (!current.activeKnowledgeBaseId) {
        return addKnowledgeBase(current, {
          name: folderPath.split('/').filter(Boolean).at(-1) || 'My knowledge base',
          folder: folderPath,
          bookmark,
          description: '',
          customInstructions: ''
        })
      }
      return {
        ...current,
        knowledgeFolder: folderPath,
        knowledgeFolderBookmark: bookmark,
        ragBackendVersion: folderChanged ? 0 : current.ragBackendVersion,
        manifest: folderChanged ? {} : current.manifest,
        syncStats: folderChanged
          ? {
              indexed: 0,
              added: 0,
              updated: 0,
              removed: 0,
              unchanged: 0,
              skipped: 0,
              failed: 0,
              lastSyncedAt: null
            }
          : current.syncStats
      }
    })
    useKnowledgeFolderBookmark(bookmark)
    return folderPath
  })

  handleTrusted('dialog:select-chat-files', async (): Promise<ChatAttachment[]> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose Files for This Message',
      buttonLabel: 'Attach Files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Supported files',
          extensions: SUPPORTED_DOCUMENT_EXTENSIONS.map((extension) => extension.slice(1))
        }
      ]
    })
    if (result.canceled) return []
    if (result.filePaths.length > MAX_CHAT_ATTACHMENTS) {
      throw new Error(`Choose up to ${MAX_CHAT_ATTACHMENTS} files at a time.`)
    }
    const attachments = await Promise.all(
      result.filePaths.map(async (filePath) => {
        const canonicalPath = await realpath(filePath)
        const info = await stat(canonicalPath)
        const extension = extname(canonicalPath).toLowerCase()
        if (!info.isFile() || !SUPPORTED_DOCUMENT_EXTENSIONS.includes(extension as never)) {
          throw new Error(`${basename(filePath)} is not a supported document.`)
        }
        if (info.size > MAX_CHAT_ATTACHMENT_BYTES) {
          throw new Error(`${basename(filePath)} is too large. Choose a file under 100 MB.`)
        }
        return { path: canonicalPath, name: basename(canonicalPath), sizeBytes: info.size }
      })
    )
    for (const attachment of attachments) selectedChatAttachments.add(attachment.path)
    return attachments
  })

  handleTrusted('settings:get', async () => publicSettings(await readConfig()))
  handleTrusted('settings:update', async (_event, patch: SettingsPatch) => {
    const before = await readConfig()
    const next = applySettingsPatch(before, patch ?? {})

    const searchModelsChanged =
      next.embeddingModel !== before.embeddingModel || next.rerankerModel !== before.rerankerModel
    if (
      (next.selectedModel !== before.selectedModel || searchModelsChanged) &&
      activeChats.size > 0
    ) {
      throw new Error('Stop the current answer before changing models.')
    }

    if (
      !EMBEDDING_MODEL_OPTIONS.some((option) => option.id === next.embeddingModel) ||
      !RERANKER_MODEL_OPTIONS.some((option) => option.id === next.rerankerModel)
    ) {
      throw new Error('Choose one of the supported search models.')
    }

    if (next.selectedModel !== before.selectedModel || patch.modelPresets) {
      const available = await ollama.listModelOptions()
      const availableIds = new Set(available.map((model) => model.id.toLowerCase()))
      const requested = [
        ...(next.selectedModel !== before.selectedModel ? [next.selectedModel] : []),
        ...Object.values(patch.modelPresets ?? {})
      ]
      if (requested.some((model) => !availableIds.has(model.toLowerCase()))) {
        throw new Error('Download this model before selecting it.')
      }
    }

    if (next.embeddingModel !== before.embeddingModel) {
      await ollama.ensureRunning()
      const available = await ollama.listModelOptions()
      if (
        !available.some((model) => model.id.toLowerCase() === next.embeddingModel.toLowerCase())
      ) {
        await ollama.pullModel(next.embeddingModel, () => undefined)
      }
    }

    if (searchModelsChanged) {
      rag.setSearchModels(next.embeddingModel, next.rerankerModel)
      ingestionRag.setSearchModels(next.embeddingModel, next.rerankerModel)
    }

    if (next.embeddingModel !== before.embeddingModel) {
      await ingestionRag.resetIndex()
    }

    if (
      next.rag.improveDocumentMatching &&
      (!before.rag.improveDocumentMatching || next.rerankerModel !== before.rerankerModel)
    ) {
      try {
        await rag.prepareReranker()
      } catch (error) {
        rag.setSearchModels(before.embeddingModel, before.rerankerModel)
        ingestionRag.setSearchModels(before.embeddingModel, before.rerankerModel)
        const detail = error instanceof Error ? error.message.trim() : ''
        if (
          detail &&
          detail.length <= 400 &&
          /reranker|document matching|Hugging Face/i.test(detail)
        ) {
          throw new Error(detail)
        }
        throw new Error(
          'Improved document matching could not be prepared. Connect to the internet and try again. The download is needed only once.'
        )
      }
    }

    const rebuildRequired =
      Object.keys(before.manifest).length > 0 &&
      (ingestionSettingsChanged(before.rag, next.rag) ||
        next.embeddingModel !== before.embeddingModel)
    const configToSave =
      next.embeddingModel !== before.embeddingModel
        ? {
            ...next,
            ragBackendVersion: 0,
            knowledgeBases: next.knowledgeBases.map((base) => ({
              ...base,
              ragBackendVersion: 0
            }))
          }
        : next
    const saved = await updateConfig(() => configToSave)
    if (saved.selectedModel !== before.selectedModel) {
      await ollama.ensureRunning()
      await ollama.unloadModelsExcept([saved.selectedModel])
    }
    return {
      settings: publicSettings(saved),
      rebuildRequired,
      message: rebuildRequired
        ? 'Settings saved. Rebuild your documents to apply the indexing changes.'
        : 'Settings saved.'
    }
  })
  handleTrusted('models:list', async () => ollama.listModelOptions())
  handleTrusted('models:warm-selected', async () => {
    const config = await readConfig()
    await ollama.ensureRunning()
    await rag.warm()
    await ollama.activateModel(
      config.selectedModel,
      config.inference.contextLength,
      activeKnowledgeSync ? [config.embeddingModel] : []
    )
    return true
  })
  handleTrusted('models:recommendations', () => ollama.deviceRecommendations())
  handleTrusted('models:assess', (_event, model: unknown) => {
    if (!validModelName(model)) throw new Error('Enter a valid Ollama model name.')
    return ollama.assessModel(model.trim())
  })
  handleTrusted('models:download', async (event, model: unknown) => {
    if (!validModelName(model)) throw new Error('Enter a valid Ollama model name.')
    const normalized = model.trim()
    const downloadKey = normalized.toLowerCase()
    const controller = new AbortController()
    activeDownloads.get(downloadKey)?.abort()
    activeDownloads.set(downloadKey, controller)
    try {
      await ollama.ensureRunning()
      await ollama.pullModel(
        normalized,
        (download) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('models:progress', {
              model: normalized,
              state: 'working',
              ...download
            } satisfies ModelOperationProgress)
          }
        },
        controller.signal
      )
      if (!event.sender.isDestroyed()) {
        event.sender.send('models:progress', {
          model: normalized,
          state: 'ready',
          message: 'Model ready.',
          progress: 100
        } satisfies ModelOperationProgress)
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
      if (!event.sender.isDestroyed()) {
        event.sender.send('models:progress', {
          model: normalized,
          state: 'cancelled',
          message: 'Download cancelled.',
          progress: 0
        } satisfies ModelOperationProgress)
      }
    } finally {
      if (activeDownloads.get(downloadKey) === controller) activeDownloads.delete(downloadKey)
    }
    return ollama.listModelOptions()
  })
  handleTrusted('models:cancel-download', (_event, model: unknown) => {
    if (typeof model !== 'string') return false
    const controller = activeDownloads.get(model.trim().toLowerCase())
    controller?.abort()
    return Boolean(controller)
  })
  handleTrusted('models:delete', async (_event, model: unknown) => {
    if (!validModelName(model)) throw new Error('Choose a valid model to delete.')
    const normalized = model.trim()
    await ollama.deleteModel(normalized)
    const remaining = await ollama.listModelOptions()
    const saved = await updateConfig((current) => ({
      ...current,
      selectedModel:
        current.selectedModel.toLowerCase() === normalized.toLowerCase()
          ? (remaining[0]?.id ?? current.selectedModel)
          : current.selectedModel
    }))
    return {
      settings: publicSettings(saved),
      message: `${normalized} was removed from this Mac.`
    }
  })
  handleTrusted('resources:get', async () => resources.metrics())
  handleTrusted('runtime:status', async () => runtime.status())
  handleTrusted('runtime:prepare', async (event, selectedModel: unknown) => {
    if (selectedModel !== undefined) {
      if (!validModelName(selectedModel)) {
        throw new Error('Enter a valid Ollama model name.')
      }
      await updateConfig((current) => ({ ...current, selectedModel: selectedModel.trim() }))
    }
    if (activeRuntimePreparation) {
      throw new Error('Preparation is already running.')
    }
    const controller = new AbortController()
    activeRuntimePreparation = controller
    try {
      return await runtime.prepare((progress: PrepareProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send('runtime:progress', progress)
      }, controller.signal)
    } finally {
      if (activeRuntimePreparation === controller) activeRuntimePreparation = null
    }
  })
  handleTrusted('runtime:cancel-prepare', () => {
    if (!activeRuntimePreparation) return false
    activeRuntimePreparation.abort()
    return true
  })
  handleTrusted('knowledge:create', async (_event, input: KnowledgeBaseInput) => {
    const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 80) : ''
    const description =
      typeof input?.description === 'string' ? input.description.trim().slice(0, 2_000) : ''
    const customInstructions =
      typeof input?.customInstructions === 'string'
        ? input.customInstructions.trim().slice(0, 4_000)
        : ''
    if (!description) throw new Error('Add a short description of what these files contain.')
    const result = await dialog.showOpenDialog({
      title: 'Choose a Folder for This Knowledge Base',
      buttonLabel: 'Use This Folder',
      properties: ['openDirectory', 'createDirectory'],
      securityScopedBookmarks: true
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folder = result.filePaths[0]
    const bookmark = result.bookmarks?.[0] ?? ''
    const saved = await updateConfig((current) =>
      addKnowledgeBase(current, {
        name: name || folder.split('/').filter(Boolean).at(-1) || 'My knowledge base',
        folder,
        bookmark,
        description,
        customInstructions
      })
    )
    useKnowledgeFolderBookmark(bookmark)
    return publicSettings(saved)
  })
  handleTrusted(
    'knowledge:update',
    async (
      _event,
      id: unknown,
      details: { name?: string; description?: string; customInstructions?: string }
    ) => {
      if (typeof id !== 'string') throw new Error('Choose a knowledge base to update.')
      protectActiveKnowledgeBase(id)
      const saved = await updateConfig((current) =>
        updateKnowledgeBaseDetails(current, id, details ?? {})
      )
      return publicSettings(saved)
    }
  )
  handleTrusted('knowledge:select', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Choose a knowledge base.')
    const saved = await updateConfig((current) => selectKnowledgeBase(current, id))
    useKnowledgeFolderBookmark(saved.knowledgeFolderBookmark)
    return publicSettings(saved)
  })
  handleTrusted('knowledge:remove', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Choose a knowledge base to remove.')
    protectActiveKnowledgeBase(id)
    await rag.clear(id)
    const saved = await updateConfig((current) => removeKnowledgeBase(current, id))
    return publicSettings(saved)
  })
  handleTrusted('knowledge:sync', async (_event, knowledgeBaseId?: string) => {
    const before = await readConfig()
    const targetId = knowledgeBaseId || before.activeKnowledgeBaseId
    if (!targetId) throw new Error('Choose a knowledge base first.')
    return runKnowledgeSync(targetId)
  })
  handleTrusted('knowledge:sync-status', () => knowledgeSyncStatus())
  handleTrusted('knowledge:staleness', async (_event, knowledgeBaseId?: string) =>
    knowledge.staleness(knowledgeBaseId)
  )
  handleTrusted('knowledge:list-files', async (_event, knowledgeBaseId?: string) =>
    knowledgeFiles(await readConfig(), knowledgeBaseId)
  )
  const resolveCitationPath = async (knowledgeBaseId: unknown, file: unknown): Promise<string> => {
    if (typeof file !== 'string' || !file.trim()) throw new Error('This source is unavailable.')
    const config = await readConfig()
    if (typeof knowledgeBaseId === 'string') {
      const base = config.knowledgeBases.find((item) => item.id === knowledgeBaseId)
      if (!base) throw new Error('This knowledge base is no longer available.')
      const entries = Object.keys(base.manifest)
      const exact = entries.find((entry) => entry === file)
      const basenameMatches = entries.filter((entry) => basename(entry) === basename(file))
      const manifestPath = exact ?? (basenameMatches.length === 1 ? basenameMatches[0] : undefined)
      if (!exact && basenameMatches.length > 1) {
        throw new Error('More than one synced file has this name. Open it from Browse files.')
      }
      if (!manifestPath) throw new Error('This file moved after the last sync. Sync to update it.')
      const [root, candidate] = await Promise.all([
        realpath(base.folder),
        realpath(path.resolve(base.folder, manifestPath))
      ]).catch(() => {
        throw new Error('This file moved after the last sync. Sync to update it.')
      })
      if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
        throw new Error('RavnDock blocked a source outside the selected folder.')
      }
      return candidate
    }
    const attached = [...selectedChatAttachments].find(
      (candidate) => candidate === file || basename(candidate) === basename(file)
    )
    if (!attached) throw new Error('This attached file is no longer available.')
    return realpath(attached).catch(() => {
      throw new Error('This attached file moved. Choose it again to continue.')
    })
  }
  handleTrusted('citation:open', async (_event, knowledgeBaseId: unknown, file: unknown) => {
    const sourcePath = await resolveCitationPath(knowledgeBaseId, file)
    const problem = await shell.openPath(sourcePath)
    if (problem) throw new Error('macOS could not open this file.')
    return true
  })
  handleTrusted('citation:reveal', async (_event, knowledgeBaseId: unknown, file: unknown) => {
    const sourcePath = await resolveCitationPath(knowledgeBaseId, file)
    shell.showItemInFolder(sourcePath)
    return true
  })
  handleTrusted('knowledge:rebuild', async (_event, knowledgeBaseId?: string) => {
    const before = await readConfig()
    const targetId = knowledgeBaseId || before.activeKnowledgeBaseId
    if (!targetId) throw new Error('Choose a knowledge base first.')
    return runKnowledgeSync(targetId, true)
  })

  handleTrusted('chat:enhance-prompt', async (_event, prompt: unknown, ids: unknown) => {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Write a prompt first.')
    if (prompt.length > 20_000) throw new Error('Shorten this prompt before improving it.')
    if (activeChats.size > 0) {
      throw new Error('Wait for the current answer or stop it before improving another prompt.')
    }
    await ollama.ensureRunning()
    const config = await readConfig()
    const requested = Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string')
      : []
    const bases = config.knowledgeBases.filter((base) => requested.includes(base.id))
    const guidance = bases
      .map((base) => {
        const instructions = base.customInstructions
          ? `\nInstructions: ${base.customInstructions}`
          : ''
        return `${base.name}: ${base.description || 'Local documents'}${instructions}`
      })
      .join('\n')
    const enhancementModel = config.selectedModel
    await ollama.activateModel(
      enhancementModel,
      config.inference.contextLength,
      activeKnowledgeSync ? [config.embeddingModel] : []
    )
    const enhanced = await ollama.complete(
      enhancementModel,
      [
        {
          role: 'system',
          content:
            'Rewrite the user question into one stronger prompt for a private local document ' +
            'assistant. Use the selected knowledge base titles, descriptions, and instructions ' +
            'only to make the question more focused, specific, and useful for finding insights. ' +
            'Preserve the original intent, action, topic, acronyms, numbers, quoted text, and scope. ' +
            'Never expand an acronym. Do not add facts, document names, people, owners, dates, ' +
            'deadlines, constraints, output requirements, or conclusions that are absent from the ' +
            'original question. ' +
            'Return exactly one enhanced prompt and nothing else. Do not answer the question, ' +
            'summarize documents, write a meta-prompt, explain your changes, add a heading, or use ' +
            'HTML or Markdown.'
        },
        {
          role: 'user',
          content: `Knowledge bases:\n${guidance}\n\nOriginal prompt:\n${prompt.trim()}`
        }
      ],
      {
        ...config.inference,
        contextLength: 4096,
        temperature: 0.1,
        maxOutputTokens: 256
      },
      undefined,
      '5m'
    )
    const normalizedEnhanced = normalizeModelText(enhanced)
    return {
      original: prompt.trim(),
      enhanced: isSemanticallySafeEnhancedPrompt(prompt, normalizedEnhanced, bases)
        ? normalizedEnhanced
        : fallbackEnhancedPrompt(prompt, bases),
      model: enhancementModel
    }
  })

  handleTrusted('chat:start', async (event, request: unknown) => {
    const requestId = randomUUID()
    if (!validChatRequest(request)) {
      const failure = userFacingFailure(
        new PocketRagError('The chat request was invalid.', 'INVALID_CHAT_REQUEST')
      )
      return { ok: false, requestId, message: failure.message, failure }
    }

    const config = await readConfig()
    const attachmentPaths: string[] = []
    for (const filePath of request.attachmentPaths ?? []) {
      try {
        const canonicalPath = await realpath(filePath)
        if (!selectedChatAttachments.has(canonicalPath)) continue
        const info = await stat(canonicalPath)
        if (
          info.isFile() &&
          info.size <= MAX_CHAT_ATTACHMENT_BYTES &&
          SUPPORTED_DOCUMENT_EXTENSIONS.includes(extname(canonicalPath).toLowerCase() as never)
        ) {
          attachmentPaths.push(canonicalPath)
        }
      } catch {
        selectedChatAttachments.delete(filePath)
      }
    }
    if ((request.attachmentPaths?.length ?? 0) !== attachmentPaths.length) {
      const failure = {
        title: 'An attached file moved',
        message: 'Choose the file again, then resend your question.',
        code: 'CHAT_ATTACHMENT_MISSING',
        retryable: true,
        primaryAction: { id: 'choose-files' as const, label: 'Choose files' }
      }
      return {
        ok: false,
        requestId,
        message: failure.message,
        failure
      }
    }
    const requestedBases = config.knowledgeBases.filter((base) =>
      request.knowledgeBaseIds.includes(base.id)
    )
    if (request.useKnowledgeBase && requestedBases.length === 0) {
      const failure = {
        title: 'Choose a knowledge base',
        message: 'Select the files you want RavnDock to use, then try again.',
        code: 'KNOWLEDGE_BASE_REQUIRED',
        retryable: true,
        primaryAction: { id: 'open-settings' as const, label: 'Choose knowledge base' }
      }
      return { ok: false, requestId, message: failure.message, failure }
    }
    if (
      request.useKnowledgeBase &&
      requestedBases.some((base) => base.ragBackendVersion < RAG_BACKEND_VERSION)
    ) {
      const failure = {
        title: 'Your files need one quick update',
        message: 'Sync this knowledge base once, then start the chat again.',
        code: 'KNOWLEDGE_BASE_UPGRADE_REQUIRED',
        retryable: true,
        primaryAction: { id: 'sync-files' as const, label: 'Open file settings' }
      }
      return {
        ok: false,
        requestId,
        message: failure.message,
        failure
      }
    }
    if (
      request.useKnowledgeBase &&
      requestedBases.every((base) => base.syncStats.indexed === 0) &&
      !activeKnowledgeSync
    ) {
      const failure = {
        title: 'No documents are ready yet',
        message: 'Choose a folder and sync at least one document before chatting with files.',
        code: 'KNOWLEDGE_BASE_EMPTY',
        retryable: true,
        primaryAction: { id: 'sync-files' as const, label: 'Open file settings' }
      }
      return {
        ok: false,
        requestId,
        message: failure.message,
        failure
      }
    }
    const controller = new AbortController()
    activeChats.set(requestId, controller)
    let usedModel = config.selectedModel
    setTimeout(() => {
      const stream = (async () => {
        const latestQuestion =
          [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
        const conversation = resolveConversationQuestion(request.messages)
        if (conversation.clarification) {
          if (!event.sender.isDestroyed()) {
            event.sender.send('chat:event', {
              requestId,
              type: 'token',
              content: conversation.clarification
            } satisfies ChatStreamEvent)
          }
          return {
            timeToFirstTokenMs: 0,
            totalDurationMs: 0,
            completionTokens: null,
            tokensPerSecond: null,
            interTokenLatencyMs: null
          }
        }
        if (
          activeKnowledgeSync &&
          requestedBases.some((base) => base.id === activeKnowledgeSync?.knowledgeBaseId) &&
          !event.sender.isDestroyed()
        ) {
          event.sender.send('chat:event', {
            requestId,
            type: 'status',
            message: 'Syncing continues. Answering from the last completed version…'
          } satisfies ChatStreamEvent)
        }
        // Re-start the local runtime on demand so an offline app restart remains usable.
        await ollama.ensureRunning()
        usedModel = routedModel(
          config.selectedModel,
          config.modelPresets,
          await ollama.listModels(),
          latestQuestion
        )
        if (
          usedModel !== config.selectedModel &&
          !request.useKnowledgeBase &&
          attachmentPaths.length === 0 &&
          !event.sender.isDestroyed()
        ) {
          event.sender.send('chat:event', {
            requestId,
            type: 'notice',
            message: /(?:^|[:/_-])9b(?:$|[:/_-])/i.test(usedModel)
              ? 'Using your High Quality model for this complex question.'
              : 'Using your Balanced model for this question.'
          } satisfies ChatStreamEvent)
        }
        if (request.useKnowledgeBase && isFileInventoryQuestion(latestQuestion)) {
          const groups = requestedBases.map((base) => ({
            name: base.name,
            files: knowledgeFiles(config, base.id)
          }))
          const content = groups
            .map(({ name, files }) =>
              [
                `## ${name}`,
                '',
                ...(files.length > 0
                  ? files.map((file) => `- ${file.name}`)
                  : ['No synchronized files are available.'])
              ].join('\n')
            )
            .join('\n\n')
          if (!event.sender.isDestroyed()) {
            event.sender.send('chat:event', {
              requestId,
              type: 'token',
              content
            } satisfies ChatStreamEvent)
          }
          return {
            timeToFirstTokenMs: 0,
            totalDurationMs: 0,
            completionTokens: null,
            tokensPerSecond: null,
            interTokenLatencyMs: null
          }
        }
        if (request.useKnowledgeBase || attachmentPaths.length > 0) {
          return rag.streamChat(
            usedModel,
            request.messages,
            config.rag,
            config.inference,
            requestedBases.map((base) => ({
              id: base.id,
              name: base.name,
              description: base.description,
              customInstructions: base.customInstructions
            })),
            attachmentPaths,
            request.sensitiveAccessConfirmed === true,
            (streamEvent) => {
              if (!event.sender.isDestroyed()) {
                event.sender.send('chat:event', {
                  requestId,
                  ...streamEvent
                } satisfies ChatStreamEvent)
              }
            },
            controller.signal
          )
        }
        await ollama.activateModel(
          usedModel,
          config.inference.contextLength,
          activeKnowledgeSync ? [config.embeddingModel] : []
        )
        const latestUserMessage = [...request.messages]
          .reverse()
          .find((message) => message.role === 'user')
        return ollama.streamChat(
          usedModel,
          [
            {
              role: 'system',
              content:
                'You are RavnDock. Answer clearly using Markdown. Do not output raw HTML tags ' +
                'such as <br>, <p>, or <div>.'
            },
            ...(conversation.usedPriorContext
              ? request.messages
              : latestUserMessage
                ? [latestUserMessage]
                : request.messages)
          ],
          config.inference,
          (content) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('chat:event', {
                requestId,
                type: 'token',
                content
              } satisfies ChatStreamEvent)
            }
          },
          controller.signal
        )
      })()

      void stream
        .then(async (metrics) => {
          if (metrics.totalDurationMs > 0 && !metrics.cached) {
            await recordModelPerformance(usedModel, metrics)
          }
          if (!event.sender.isDestroyed()) {
            event.sender.send('chat:event', {
              requestId,
              type: 'done',
              metrics
            } satisfies ChatStreamEvent)
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted && !event.sender.isDestroyed()) {
            const failure = userFacingFailure(error)
            event.sender.send('chat:event', {
              requestId,
              type: 'error',
              message: failure.message,
              failure
            } satisfies ChatStreamEvent)
          }
        })
        .finally(async () => {
          activeChats.delete(requestId)
          if (activeChats.size === 0 && !activeKnowledgeSync) {
            await ingestionRag.releaseEmbedding().catch(() => undefined)
          }
        })
    }, 0)

    return { ok: true, requestId }
  })

  handleTrusted('chat:cancel', (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') return false
    const controller = activeChats.get(requestId)
    controller?.abort()
    activeChats.delete(requestId)
    return Boolean(controller)
  })
}
