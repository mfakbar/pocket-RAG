import assert from 'node:assert/strict'
import test from 'node:test'
import { validChatRequest, validModelName } from '../src/main/ipc/validation'

test('accepts a bounded chat request', () => {
  assert.equal(
    validChatRequest({
      messages: [{ role: 'user', content: 'Hello' }],
      useKnowledgeBase: false,
      knowledgeBaseIds: [],
      attachmentPaths: []
    }),
    true
  )
})

test('rejects oversized or malformed chat requests', () => {
  assert.equal(
    validChatRequest({
      messages: [{ role: 'system', content: 'Not allowed' }],
      useKnowledgeBase: false,
      knowledgeBaseIds: []
    }),
    false
  )
  assert.equal(
    validChatRequest({
      messages: [{ role: 'user', content: 'x'.repeat(100_001) }],
      useKnowledgeBase: false,
      knowledgeBaseIds: []
    }),
    false
  )
})

test('accepts Ollama model identifiers and rejects command-like input', () => {
  assert.equal(validModelName('qwen3.5:4b-q4_K_M'), true)
  assert.equal(validModelName('../model'), false)
  assert.equal(validModelName('model; rm -rf'), false)
})
