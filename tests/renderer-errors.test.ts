import assert from 'node:assert/strict'
import test from 'node:test'
import { friendlyActionError, safeTechnicalDetails } from '../src/renderer/src/lib/errors'

test('keeps concise user-facing IPC errors and removes the Electron wrapper', () => {
  assert.equal(
    friendlyActionError(
      new Error(
        "Error invoking remote method 'knowledge:sync': Error: Another knowledge base is syncing."
      ),
      'Sync could not start.'
    ),
    'Another knowledge base is syncing.'
  )
})

test('uses a safe fallback for implementation errors while retaining redacted details', () => {
  const error = new Error(
    "Error invoking remote method 'knowledge:sync': Error: ConnectError at /Users/example/private/file.py"
  )
  assert.equal(friendlyActionError(error, 'Sync could not start.'), 'Sync could not start.')
  assert.equal(safeTechnicalDetails(error), 'ConnectError at [local path]')
})
