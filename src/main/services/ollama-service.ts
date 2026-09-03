import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import {
  CHAT_MODEL,
  HIGH_QUALITY_MODEL,
  PERFORMANCE_MODEL,
  type ChatMessage,
  type ChatPerformanceMetrics,
  type DeviceModelRecommendations,
  type InferenceSettings,
  type ModelOption,
  type ModelSizeAssessment,
  type RunningModelMetric,
  type SuggestedModel
} from '../../shared/contracts'
import { findExecutable } from '../lib/command'
import { errorMessage, PocketRagError } from '../lib/errors'
import { fetchWithTimeout, readJson, waitFor } from '../lib/http'

interface OllamaTagsResponse {
  models?: Array<{
    name?: string
    model?: string
    size?: number
    details?: {
      parameter_size?: string
      quantization_level?: string
    }
  }>
}

interface OllamaShowResponse {
  capabilities?: string[]
  model_info?: Record<string, unknown>
}

interface OllamaProcessesResponse {
  models?: Array<{
    name?: string
    model?: string
    size?: number
    size_vram?: number
    context_length?: number
  }>
}

interface PullProgress {
  status?: string
  completed?: number
  total?: number
  error?: string
}

interface OllamaChatResponse {
  message?: { content?: string }
}

export interface ModelDownloadProgress {
  progress: number
  message: string
  downloadedBytes?: number
  totalBytes?: number
}

function parameterCount(value: string): number | null {
  const match = value.toLowerCase().match(/([\d.]+)\s*b/)
  return match ? Number(match[1]) : null
}

function modelIdentity(model: string): string {
  return model.toLowerCase().replace(/:latest$/, '')
}

export function parameterCountFromModelName(model: string): number | null {
  const matches = [...model.toLowerCase().matchAll(/(?:^|[-_:])(\d+(?:\.\d+)?)b(?:[-_:]|$)/g)]
  return matches.length > 0 ? Number(matches.at(-1)?.[1]) : null
}

export function modelRecommendation(model: Pick<ModelOption, 'id' | 'parameterSize'>): string {
  if (model.id.toLowerCase() === PERFORMANCE_MODEL.toLowerCase()) {
    return 'Fastest answers for quick lookups.'
  }
  if (model.id.toLowerCase() === CHAT_MODEL.toLowerCase()) {
    return 'Best balance of speed and detail.'
  }
  if (model.id.toLowerCase() === HIGH_QUALITY_MODEL.toLowerCase()) {
    return 'Most detailed answers. Uses more memory.'
  }
  const parameters = parameterCount(model.parameterSize)
  if (parameters !== null && parameters <= 3) {
    return 'Ideal for fast summaries and simple questions.'
  }
  if (parameters !== null && parameters <= 7) {
    return 'Best for everyday document search, summaries, and analysis.'
  }
  if (parameters !== null && parameters <= 14) {
    return 'Ideal for deeper analysis, with slower answers and higher memory use.'
  }
  if (parameters !== null && parameters > 14) {
    return 'Best for complex work on Macs with more memory; may be slow here.'
  }
  return 'Best when you already know this model works well for your documents.'
}

interface RecommendationCandidate {
  model: string
  sizeGb: number
  estimatedSize: string
  description: string
}

const RECOMMENDATION_CATALOG: RecommendationCandidate[] = [
  {
    model: 'gemma3:1b',
    sizeGb: 0.8,
    estimatedSize: '815 MB',
    description: 'Best when speed and low memory use matter most.'
  },
  {
    model: 'qwen3.5:2b-q4_K_M',
    sizeGb: 1.9,
    estimatedSize: '1.9 GB',
    description: 'Best for quick questions, summaries, and everyday lookups.'
  },
  {
    model: 'llama3.2:3b',
    sizeGb: 2,
    estimatedSize: '2.0 GB',
    description: 'Best for fast, natural general conversation.'
  },
  {
    model: 'qwen3:4b',
    sizeGb: 2.5,
    estimatedSize: '2.5 GB',
    description: 'Best for structured analysis and multilingual content.'
  },
  {
    model: 'gemma3:4b',
    sizeGb: 3.3,
    estimatedSize: '3.3 GB',
    description: 'Best for clear summaries and general document questions.'
  },
  {
    model: 'qwen3.5:4b-q4_K_M',
    sizeGb: 3.4,
    estimatedSize: '3.4 GB',
    description: 'Best mix of speed, document understanding, and detail.'
  },
  {
    model: 'llama3.1:8b',
    sizeGb: 4.9,
    estimatedSize: '4.9 GB',
    description: 'Best for polished writing and broad business questions.'
  },
  {
    model: 'qwen3.5:9b-q4_K_M',
    sizeGb: 6.6,
    estimatedSize: '6.6 GB',
    description: 'Best for detailed analysis while keeping memory use practical.'
  },
  {
    model: 'gemma3:12b',
    sizeGb: 8.1,
    estimatedSize: '8.1 GB',
    description: 'Best for deeper reasoning when more memory is available.'
  }
]

function recommendationsNear(
  memoryGb: number,
  targetRatio: number,
  maximumRatio: number
): SuggestedModel[] {
  const targetSize = Math.max(0.8, memoryGb * targetRatio)
  const maximumSize = Math.max(1, memoryGb * maximumRatio)
  const fitting = RECOMMENDATION_CATALOG.filter((candidate) => candidate.sizeGb <= maximumSize)
  const pool = fitting.length >= 3 ? fitting : RECOMMENDATION_CATALOG
  return [...pool]
    .sort(
      (left, right) =>
        Math.abs(left.sizeGb - targetSize) - Math.abs(right.sizeGb - targetSize) ||
        left.sizeGb - right.sizeGb
    )
    .slice(0, 3)
    .map(({ model, estimatedSize, description }) => ({ model, estimatedSize, description }))
}

export function buildDeviceModelRecommendations(
  memoryBytes: number,
  logicalCores: number,
  architecture: string
): DeviceModelRecommendations {
  const memoryGb = Math.max(1, memoryBytes / 1024 ** 3)
  const processor = architecture === 'arm64' ? 'Apple silicon' : architecture
  return {
    deviceMemoryBytes: memoryBytes,
    deviceSummary:
      `Detected ${Math.round(memoryGb)} GB memory, ${logicalCores} processor cores, and ${processor}. ` +
      'Recommendations balance model quality with enough room for your files and other apps',
    performance: recommendationsNear(memoryGb, 0.1, 0.22),
    balanced: recommendationsNear(memoryGb, 0.21, 0.38),
    highQuality: recommendationsNear(memoryGb, 0.4, 0.55)
  }
}

export class OllamaService {
  private executable: string | null = null
  private process: ChildProcess | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly managedExecutable?: () => string
  ) {}

  setExecutable(executable: string): void {
    this.executable = executable
  }

  async findExecutable(): Promise<string | null> {
    if (this.executable) return this.executable
    this.executable = await findExecutable(
      [
        this.managedExecutable?.(),
        '/opt/homebrew/bin/ollama',
        '/usr/local/bin/ollama',
        'ollama'
      ].filter((candidate): candidate is string => Boolean(candidate))
    )
    return this.executable
  }

  async isRunning(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/api/version`, {}, 2_000)
      return response.ok
    } catch {
      return false
    }
  }

  async ensureRunning(): Promise<void> {
    if (await this.isRunning()) return
    const executable = await this.findExecutable()
    if (!executable) {
      throw new PocketRagError('Local AI is not installed yet.', 'OLLAMA_NOT_INSTALLED')
    }

    try {
      this.process = spawn(executable, ['serve'], {
        detached: true,
        stdio: 'ignore'
      })
      this.process.on('error', () => undefined)
      this.process.unref()
    } catch (error) {
      throw new PocketRagError('Local AI could not be started.', 'OLLAMA_START_FAILED', error)
    }

    const ready = await waitFor(() => this.isRunning(), 30_000)
    if (!ready) {
      throw new PocketRagError(
        'Local AI took too long to start. Please try again.',
        'OLLAMA_START_TIMEOUT'
      )
    }
  }

  async listModels(): Promise<string[]> {
    if (!(await this.isRunning())) return []
    const response = await fetchWithTimeout(`${this.baseUrl}/api/tags`)
    const body = await readJson<OllamaTagsResponse>(response)
    return (body.models ?? [])
      .map((model) => model.name ?? model.model ?? '')
      .filter((name) => name.length > 0)
  }

  async listModelOptions(): Promise<ModelOption[]> {
    if (!(await this.isRunning())) return []
    const response = await fetchWithTimeout(`${this.baseUrl}/api/tags`)
    const body = await readJson<OllamaTagsResponse>(response)
    const options = await Promise.all(
      (body.models ?? []).map(async (model): Promise<ModelOption | null> => {
        const id = model.name ?? model.model ?? ''
        if (!id) return null

        let show: OllamaShowResponse = {}
        try {
          const detailsResponse = await fetchWithTimeout(
            `${this.baseUrl}/api/show`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: id, verbose: false })
            },
            10_000
          )
          show = await readJson<OllamaShowResponse>(detailsResponse)
        } catch {
          // Basic tag metadata is still enough to offer most local chat models.
        }

        const capabilities = show.capabilities ?? []
        if (
          (capabilities.includes('embedding') && !capabilities.includes('completion')) ||
          (capabilities.length === 0 && /(^|[-_:])embed(ding)?($|[-_:])/i.test(id))
        ) {
          return null
        }

        const contextEntry = Object.entries(show.model_info ?? {}).find(
          ([key, value]) => key.endsWith('.context_length') && typeof value === 'number'
        )
        const option: ModelOption = {
          id,
          sizeBytes: model.size ?? 0,
          parameterSize: model.details?.parameter_size ?? 'Unknown size',
          quantization: model.details?.quantization_level ?? 'Unknown',
          contextLength:
            contextEntry && typeof contextEntry[1] === 'number' ? contextEntry[1] : undefined,
          capabilities,
          recommendation: '',
          recommended: id.toLowerCase() === CHAT_MODEL.toLowerCase()
        }
        option.recommendation = modelRecommendation(option)
        return option
      })
    )

    return options
      .filter((option): option is ModelOption => option !== null)
      .sort(
        (left, right) =>
          Number(right.recommended) - Number(left.recommended) || left.id.localeCompare(right.id)
      )
  }

  async listRunningModels(): Promise<RunningModelMetric[]> {
    if (!(await this.isRunning())) return []

    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/api/ps`, {}, 3_000)
      const body = await readJson<OllamaProcessesResponse>(response)
      return (body.models ?? [])
        .map((model) => ({
          name: model.name ?? model.model ?? 'Local model',
          sizeBytes: model.size ?? 0,
          acceleratorBytes: model.size_vram ?? 0,
          contextLength: model.context_length ?? null
        }))
        .filter((model) => model.name.length > 0)
    } catch {
      return []
    }
  }

  assessModel(model: string): ModelSizeAssessment {
    const parameterBillions = parameterCountFromModelName(model)
    if (parameterBillions === null) {
      return {
        model,
        parameterBillions: null,
        level: 'caution',
        message: 'The model size is not in its name. Check the model page before downloading.'
      }
    }

    const estimatedBytes = (parameterBillions * 0.75 + 4) * 1024 ** 3
    const ratio = estimatedBytes / os.totalmem()
    if (ratio > 0.9) {
      return {
        model,
        parameterBillions,
        level: 'high',
        message: `This ${parameterBillions}B model is likely too large for this Mac and may be very slow or fail to load.`
      }
    }
    if (ratio > 0.7) {
      return {
        model,
        parameterBillions,
        level: 'caution',
        message: `This ${parameterBillions}B model may use most of your memory and slow down other apps.`
      }
    }
    return {
      model,
      parameterBillions,
      level: 'ok',
      message: `This ${parameterBillions}B model should fit within this Mac's memory.`
    }
  }

  deviceRecommendations(): DeviceModelRecommendations {
    return buildDeviceModelRecommendations(os.totalmem(), os.cpus().length, os.arch())
  }

  async deleteModel(model: string): Promise<void> {
    const response = await fetchWithTimeout(`${this.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    })
    if (!response.ok) {
      throw new PocketRagError(`Could not delete ${model}.`, 'MODEL_DELETE_FAILED')
    }
  }

  async warmModel(model: string, contextLength: number): Promise<void> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: '10m',
          options: { num_ctx: Math.min(contextLength, 8192) }
        })
      },
      120_000
    )
    if (!response.ok) throw new Error('The selected model could not be prepared.')
  }

  async unloadModel(model: string): Promise<void> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 })
      },
      30_000
    )
    if (!response.ok) throw new Error(`Could not release ${model} from memory.`)
  }

  async unloadModelsExcept(modelsToKeep: string[]): Promise<void> {
    const keep = new Set(modelsToKeep.map(modelIdentity))
    const running = await this.listRunningModels()
    await Promise.all(
      running
        .filter((model) => !keep.has(modelIdentity(model.name)))
        .map((model) => this.unloadModel(model.name))
    )
  }

  async activateModel(
    model: string,
    contextLength: number,
    transientHelpers: string[] = []
  ): Promise<void> {
    await this.unloadModelsExcept([model, ...transientHelpers])
    await this.warmModel(model, contextLength)
  }

  async streamChat(
    model: string,
    messages: ChatMessage[],
    inference: InferenceSettings,
    onToken: (content: string) => void,
    signal: AbortSignal,
    allowContinuation = true
  ): Promise<ChatPerformanceMetrics> {
    const startedAt = performance.now()
    let firstTokenAt: number | null = null
    let completionTokens: number | null = null
    let evaluationDurationNs: number | null = null
    let generated = ''
    let requestMessages = messages
    const maximumTotalTokens = Math.min(
      2048,
      Math.max(768, inference.maxOutputTokens + Math.min(1024, inference.maxOutputTokens))
    )
    const maximumAttempts = 3

    // Continue a capped number of times when a complete answer reaches the per-request limit.
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      if (signal.aborted) throw new DOMException('The request was stopped.', 'AbortError')
      let doneReason: string | undefined
      let attemptTokens = 0
      let attemptHasContent = false
      const usedTokens = completionTokens ?? Math.ceil(generated.length / 4)
      const remainingTokens = Math.max(1, maximumTotalTokens - usedTokens)
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: requestMessages,
          stream: true,
          think: false,
          options: {
            num_ctx: inference.contextLength,
            temperature: inference.temperature,
            top_p: inference.topP,
            num_predict: Math.min(inference.maxOutputTokens, remainingTokens)
          }
        }),
        signal
      })
      if (!response.ok || !response.body) {
        throw new PocketRagError(
          'I could not start your answer. Please try again.',
          'OLLAMA_CHAT_FAILED'
        )
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        if (done && buffer.trim()) lines.push(buffer)
        for (const line of lines) {
          if (!line.trim()) continue
          const update = JSON.parse(line) as {
            message?: { content?: string }
            done_reason?: string
            eval_count?: number
            eval_duration?: number
          }
          let content = update.message?.content ?? ''
          if (content) {
            if (
              attempt > 0 &&
              !attemptHasContent &&
              generated &&
              !/\s$/.test(generated) &&
              /^\s*(?:#{1,6}(?:\s|(?=[A-Z0-9]))|[-*]\s|\d+[.)]\s)/.test(content)
            ) {
              content = `\n\n${content.trimStart()}`
            }
            attemptHasContent = true
            firstTokenAt ??= performance.now()
            generated += content
            onToken(content)
          }
          if (update.done_reason) doneReason = update.done_reason
          if (typeof update.eval_count === 'number') {
            attemptTokens = update.eval_count
            completionTokens = (completionTokens ?? 0) + update.eval_count
          }
          if (typeof update.eval_duration === 'number') {
            evaluationDurationNs = (evaluationDurationNs ?? 0) + update.eval_duration
          }
        }
        if (done) break
      }

      const totalTokens = completionTokens ?? Math.ceil(generated.length / 4)
      if (
        !allowContinuation ||
        doneReason !== 'length' ||
        attempt === maximumAttempts - 1 ||
        totalTokens >= maximumTotalTokens ||
        !generated.trim() ||
        attemptTokens === 0
      ) {
        break
      }
      requestMessages = [
        ...messages,
        { role: 'assistant', content: generated },
        {
          role: 'user',
          content:
            'Continue exactly where the answer stopped. Do not repeat anything or start a new section unless it is required to finish the current answer. Prioritize completing the remaining points and end with a complete sentence using the same Markdown style.' +
            ' Never write "Continued", "(Continued)", or a continuation heading.'
        }
      ]
    }

    const totalDurationMs = performance.now() - startedAt
    const tokensPerSecond =
      completionTokens !== null && evaluationDurationNs && evaluationDurationNs > 0
        ? completionTokens / (evaluationDurationNs / 1_000_000_000)
        : null
    const interTokenLatencyMs =
      completionTokens !== null && completionTokens > 0 && evaluationDurationNs
        ? evaluationDurationNs / 1_000_000 / completionTokens
        : null
    return {
      timeToFirstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
      totalDurationMs,
      completionTokens,
      tokensPerSecond,
      interTokenLatencyMs
    }
  }

  async complete(
    model: string,
    messages: ChatMessage[],
    inference: InferenceSettings,
    signal?: AbortSignal,
    keepAlive?: string | number
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        think: false,
        ...(keepAlive === undefined ? {} : { keep_alive: keepAlive }),
        options: {
          num_ctx: Math.min(inference.contextLength, 8192),
          temperature: inference.temperature,
          top_p: inference.topP,
          num_predict: Math.min(inference.maxOutputTokens, 512)
        }
      }),
      signal
    })
    const body = await readJson<OllamaChatResponse>(response)
    const content = body.message?.content?.trim()
    if (!content) throw new Error('The local model did not return a response.')
    return content
  }

  async pullModel(
    model: string,
    onProgress: (progress: ModelDownloadProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal
    })

    if (!response.ok || !response.body) {
      await readJson(response)
      throw new PocketRagError(`Could not download ${model}.`, 'MODEL_PULL_FAILED')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const update = JSON.parse(line) as PullProgress
          if (update.error) throw new Error(update.error)
          const progress =
            update.total && update.completed
              ? Math.round((update.completed / update.total) * 100)
              : 0
          onProgress({
            progress,
            message:
              progress > 0
                ? 'Downloading...'
                : update.status === 'success'
                  ? 'Finishing...'
                  : 'Preparing download...',
            downloadedBytes: update.completed,
            totalBytes: update.total
          })
        } catch (error) {
          if (error instanceof SyntaxError) continue
          throw new PocketRagError(
            `Could not download ${model}: ${errorMessage(error)}`,
            'MODEL_PULL_FAILED',
            error
          )
        }
      }

      if (done) break
    }
  }
}
