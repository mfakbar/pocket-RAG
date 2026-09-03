import type {
  ComponentStatus,
  PrepareProgress,
  PrepareResult,
  RuntimeStatus,
  RuntimeStep
} from '../../shared/contracts'
import { runtimeConfig } from '../config'
import { userFacingFailure } from '../lib/errors'
import { readConfig, updateConfig } from '../settings'
import { DependencyInstaller } from './dependency-installer'
import { LocalRagService } from './local-rag-service'
import { OllamaService } from './ollama-service'

function component(state: ComponentStatus['state'], message: string): ComponentStatus {
  return { state, message }
}

function modelInstalled(installed: string[], required: string): boolean {
  const normalized = required.toLowerCase()
  return installed.some((model) => model.toLowerCase() === normalized)
}

function configuredModels(config: Awaited<ReturnType<typeof readConfig>>): string[] {
  return [...new Set([config.selectedModel, config.embeddingModel])]
}

function availableProfileModels(config: Awaited<ReturnType<typeof readConfig>>): string[] {
  return [...new Set([config.selectedModel, ...Object.values(config.modelPresets)])]
}

export class RuntimeOrchestrator {
  constructor(
    private readonly ollama: OllamaService,
    private readonly rag: LocalRagService,
    private readonly installer: DependencyInstaller,
    private readonly ingestionRag?: LocalRagService
  ) {}

  private setPythonExecutable(executable: string): void {
    this.rag.setPythonExecutable(executable)
    this.ingestionRag?.setPythonExecutable(executable)
  }

  private setSearchModels(config: Awaited<ReturnType<typeof readConfig>>): void {
    this.rag.setSearchModels(config.embeddingModel, config.rerankerModel)
    this.ingestionRag?.setSearchModels(config.embeddingModel, config.rerankerModel)
  }

  async status(): Promise<RuntimeStatus> {
    const components: Record<RuntimeStep, ComponentStatus> = {
      ollama: component('missing', 'Local AI is not installed.'),
      models: component('missing', 'Required models are not downloaded.'),
      'rag-runtime': component('missing', 'The private document tools are not installed.'),
      'knowledge-engine': component('stopped', 'The document engine is stopped.'),
      'knowledge-base': component('stopped', 'The knowledge base is not ready.')
    }

    const ollamaExecutable = await this.ollama.findExecutable()
    const ollamaRunning = ollamaExecutable ? await this.ollama.isRunning() : false
    components.ollama = ollamaExecutable
      ? component(
          ollamaRunning ? 'ready' : 'stopped',
          ollamaRunning ? 'Local AI is running.' : 'Local AI is installed but stopped.'
        )
      : components.ollama

    let config = await readConfig()
    this.setSearchModels(config)
    const installedModels = ollamaRunning ? await this.ollama.listModels() : []
    const missingModels = availableProfileModels(config).filter(
      (model) => !modelInstalled(installedModels, model)
    )
    if (
      ollamaRunning &&
      !modelInstalled(installedModels, config.selectedModel) &&
      modelInstalled(installedModels, runtimeConfig.chatModel)
    ) {
      config = await updateConfig((current) => ({
        ...current,
        selectedModel: runtimeConfig.chatModel
      }))
    }
    const activeModelsReady =
      modelInstalled(installedModels, config.selectedModel) &&
      modelInstalled(installedModels, config.embeddingModel)
    components.models = component(
      activeModelsReady ? 'ready' : 'missing',
      activeModelsReady ? 'Your selected model is ready.' : 'Models need downloading.'
    )

    const ragPython = await this.installer.findRagPython()
    components['rag-runtime'] = component(
      ragPython ? 'ready' : 'missing',
      ragPython
        ? 'Private document tools are installed.'
        : 'Private document tools need installing.'
    )
    if (ragPython) this.setPythonExecutable(ragPython)
    const engineReady = Boolean(ragPython) && (await this.rag.isHealthy())
    components['knowledge-engine'] = component(
      engineReady ? 'ready' : 'stopped',
      engineReady ? 'The local document engine is ready.' : 'The local document engine is stopped.'
    )
    components['knowledge-base'] = component(
      engineReady ? 'ready' : 'stopped',
      engineReady ? 'Your private knowledge base is ready.' : 'The knowledge base is not ready.'
    )

    return {
      ready: Object.values(components).every((item) => item.state === 'ready'),
      components,
      installedModels,
      missingModels
    }
  }

  async prepare(
    onProgress: (progress: PrepareProgress) => void,
    signal?: AbortSignal
  ): Promise<PrepareResult> {
    try {
      const initialConfig = await readConfig()
      this.setSearchModels(initialConfig)
      if (!initialConfig.knowledgeFolder) {
        throw new Error('Choose your knowledge folder before preparing RavnDock.')
      }

      if (!(await this.ollama.findExecutable())) {
        onProgress({
          step: 'ollama',
          state: 'working',
          message: 'Downloading the local AI engine...'
        })
        const executable = await this.installer.installOllama((download) => {
          onProgress({
            step: 'ollama',
            state: 'working',
            message: 'Downloading the local AI engine...',
            ...download
          })
        }, signal)
        this.ollama.setExecutable(executable)
      }
      onProgress({ step: 'ollama', state: 'working', message: 'Starting local AI...' })
      await this.ollama.ensureRunning()
      onProgress({ step: 'ollama', state: 'ready', message: 'Local AI is ready.' })

      const installed = await this.ollama.listModels()
      const missing = configuredModels(initialConfig).filter(
        (model) => !modelInstalled(installed, model)
      )
      for (const model of missing) {
        if (signal?.aborted) throw new DOMException('Preparation paused.', 'AbortError')
        const modelLabel =
          model === initialConfig.modelPresets.performance
            ? 'Performance model'
            : model === initialConfig.modelPresets.balanced
              ? 'Balanced model'
              : model === initialConfig.modelPresets['high-quality']
                ? 'High Quality model'
                : model === initialConfig.embeddingModel
                  ? 'Document search model'
                  : 'Selected chat model'
        await this.ollama.pullModel(
          model,
          (download) => {
            onProgress({
              step: 'models',
              state: 'working',
              message: `${modelLabel}: ${download.message}`,
              progress: download.progress,
              downloadedBytes: download.downloadedBytes,
              totalBytes: download.totalBytes
            })
          },
          signal
        )
      }
      onProgress({ step: 'models', state: 'ready', message: 'Local AI models are ready.' })

      let ragPython = await this.installer.findRagPython()
      if (!ragPython) {
        onProgress({
          step: 'rag-runtime',
          state: 'working',
          message: 'Downloading private document tools...'
        })
        ragPython = await this.installer.installRagBackend((download) => {
          onProgress({
            step: 'rag-runtime',
            state: 'working',
            message: 'Downloading private document tools...',
            ...download
          })
        }, signal)
      }
      this.setPythonExecutable(ragPython)
      onProgress({
        step: 'rag-runtime',
        state: 'ready',
        message: 'Private document tools are ready.'
      })

      onProgress({
        step: 'knowledge-engine',
        state: 'working',
        message: 'Starting your private document engine...'
      })
      await this.rag.ensureStarted()
      const health = await this.rag.health()
      if (!health.ready) throw new Error('The private document engine did not become ready.')
      onProgress({
        step: 'knowledge-engine',
        state: 'ready',
        message: 'Private document engine is ready.'
      })
      onProgress({
        step: 'knowledge-base',
        state: 'ready',
        message: 'Your private knowledge base is ready.'
      })

      return { ok: true, status: await this.status(), message: 'RavnDock is ready.' }
    } catch (error) {
      const status = await this.status()
      const failure = signal?.aborted
        ? {
            title: 'Preparation paused',
            message: 'Your download progress is saved. Continue whenever you are ready.',
            code: 'PREPARATION_PAUSED',
            retryable: true,
            primaryAction: { id: 'open-settings' as const, label: 'Continue later' }
          }
        : userFacingFailure(error)
      const activeStep = (Object.entries(status.components).find(
        ([, value]) => value.state !== 'ready'
      )?.[0] ?? 'ollama') as RuntimeStep
      onProgress({ step: activeStep, state: 'error', message: failure.message })
      return { ok: false, status, message: failure.message, failure }
    }
  }
}
