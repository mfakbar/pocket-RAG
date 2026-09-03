import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_OPTIONS,
  RERANKER_MODEL,
  RERANKER_MODEL_OPTIONS
} from '../src/shared/contracts'

test('uses qwen3 embedding 4b as the new-install default', () => {
  assert.equal(EMBEDDING_MODEL, 'qwen3-embedding:4b')
  assert.equal(EMBEDDING_MODEL_OPTIONS[0].id, EMBEDDING_MODEL)
})

test('keeps embedding and reranker choices in separate supported lists', () => {
  assert.ok(EMBEDDING_MODEL_OPTIONS.length > 1)
  assert.ok(RERANKER_MODEL_OPTIONS.length > 1)
  assert.equal(RERANKER_MODEL_OPTIONS[0].id, RERANKER_MODEL)
  const rerankerIds = new Set<string>(RERANKER_MODEL_OPTIONS.map((option) => option.id))
  assert.equal(
    EMBEDDING_MODEL_OPTIONS.some((embedding) => rerankerIds.has(embedding.id)),
    false
  )
})
