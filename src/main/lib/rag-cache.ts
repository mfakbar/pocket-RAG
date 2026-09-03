import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ChatPerformanceMetrics, Citation } from '../../shared/contracts'
import type { EvidenceChunk } from './rag-pipeline'

interface CacheEntry {
  answer: string
  citations: Citation[]
  metrics: ChatPerformanceMetrics
  storedAt: number
}

interface CacheFile {
  version: 1
  entries: Record<string, CacheEntry>
}

export function verifiedResponseCacheKey(input: {
  question: string
  model: string
  knowledgeBaseIds: string[]
  contextLength: number
  chunks: EvidenceChunk[]
  conversation?: unknown
  policy?: unknown
}): string {
  const evidence = input.chunks.map((chunk) => ({
    knowledgeBaseId: chunk.knowledgeBaseId ?? '',
    documentId: chunk.documentId ?? '',
    chunkIndex: chunk.chunkIndex ?? 0,
    file: chunk.file,
    location: chunk.location,
    text: createHash('sha256').update(chunk.text).digest('hex')
  }))
  return createHash('sha256')
    .update(
      JSON.stringify({
        question: input.question.trim().toLowerCase(),
        model: input.model,
        knowledgeBaseIds: [...input.knowledgeBaseIds].sort(),
        contextLength: input.contextLength,
        conversation: input.conversation,
        policy: input.policy,
        evidence
      })
    )
    .digest('hex')
}

export class VerifiedResponseCache {
  private readonly maxEntries = 100
  private readonly maxAgeMs = 30 * 24 * 60 * 60 * 1000

  constructor(private readonly dataDirectory: () => string) {}

  private filePath(): string | null {
    const root = this.dataDirectory()
    return root ? path.join(root, 'verified-response-cache.json') : null
  }

  private async load(): Promise<CacheFile> {
    const file = this.filePath()
    if (!file) return { version: 1, entries: {} }
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as CacheFile
      if (parsed.version !== 1 || typeof parsed.entries !== 'object')
        throw new Error('Invalid cache')
      return parsed
    } catch {
      return { version: 1, entries: {} }
    }
  }

  async get(key: string): Promise<CacheEntry | null> {
    const payload = await this.load()
    const entry = payload.entries[key]
    if (!entry || Date.now() - entry.storedAt > this.maxAgeMs) return null
    return entry
  }

  async set(key: string, entry: Omit<CacheEntry, 'storedAt'>): Promise<void> {
    const file = this.filePath()
    if (!file) return
    const payload = await this.load()
    payload.entries[key] = { ...entry, storedAt: Date.now() }
    const ordered = Object.entries(payload.entries)
      .sort((left, right) => right[1].storedAt - left[1].storedAt)
      .slice(0, this.maxEntries)
    payload.entries = Object.fromEntries(ordered)
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    await writeFile(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  }
}
