import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatPerformanceMetrics } from '../src/shared/contracts'
import { VerifiedResponseCache, verifiedResponseCacheKey } from '../src/main/lib/rag-cache'

const metrics: ChatPerformanceMetrics = {
  timeToFirstTokenMs: 100,
  totalDurationMs: 1000,
  completionTokens: 20,
  tokensPerSecond: 20,
  interTokenLatencyMs: 50
}

function key(text: string): string {
  return verifiedResponseCacheKey({
    question: 'What is the value?',
    model: 'qwen3.5:4b-q4_K_M',
    knowledgeBaseIds: ['kb'],
    contextLength: 8192,
    chunks: [
      {
        text,
        file: 'source.pdf',
        path: 'source.pdf',
        location: 'Page 1',
        heading: '',
        score: 1,
        knowledgeBaseId: 'kb',
        documentId: 'doc',
        chunkIndex: 0
      }
    ]
  })
}

test('verified response cache is local and invalidates when evidence changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ravndock-cache-'))
  const cache = new VerifiedResponseCache(() => directory)
  const originalKey = key('Original evidence')
  await cache.set(originalKey, {
    answer: 'Verified answer [1].',
    citations: [{ file: 'source.pdf', location: 'Page 1' }],
    metrics
  })

  assert.equal((await cache.get(originalKey))?.answer, 'Verified answer [1].')
  assert.notEqual(key('Updated evidence'), originalKey)
  assert.equal(await cache.get(key('Updated evidence')), null)
})
