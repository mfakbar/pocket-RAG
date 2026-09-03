import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureMacOsTrustStore } from '../src/main/lib/macos-trust-store'

test('does not create a macOS trust store on non-macOS platforms', () => {
  if (process.platform === 'darwin') return
  assert.equal(ensureMacOsTrustStore('/tmp/pocketai-test-certificates'), undefined)
})
