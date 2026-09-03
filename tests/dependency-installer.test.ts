import assert from 'node:assert/strict'
import test from 'node:test'
import { codesignTeamIdentifier } from '../src/main/services/dependency-installer'

test('reads the signer team identifier from macOS code-signing output', () => {
  assert.equal(
    codesignTeamIdentifier('Identifier=com.electron.ollama\nTeamIdentifier=3MU9H2V9Y9\n'),
    '3MU9H2V9Y9'
  )
  assert.equal(codesignTeamIdentifier('TeamIdentifier=not set\n'), 'not set')
  assert.equal(codesignTeamIdentifier('Identifier=com.example.app\n'), null)
})
