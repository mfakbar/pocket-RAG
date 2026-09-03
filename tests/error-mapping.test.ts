import assert from 'node:assert/strict'
import test from 'node:test'
import { PocketRagError, userFacingFailure } from '../src/main/lib/errors'

test('maps local AI failures to a friendly recovery action', () => {
  const failure = userFacingFailure(
    new PocketRagError('connect ECONNREFUSED 127.0.0.1', 'OLLAMA_START_FAILED')
  )
  assert.equal(failure.title, 'Local AI paused unexpectedly')
  assert.equal(failure.primaryAction?.id, 'restart-local-ai')
})

test('hides unexpected implementation details behind a safe message', () => {
  const failure = userFacingFailure(
    new Error('/Users/example/private/project/parser.py failed at internal_worker')
  )
  assert.equal(failure.title, 'Something interrupted this answer')
  assert.doesNotMatch(failure.message, /parser|private|worker/i)
  assert.match(failure.technicalDetails ?? '', /\[local path\]/)
})
