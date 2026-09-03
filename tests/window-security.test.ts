import assert from 'node:assert/strict'
import test from 'node:test'
import { isTrustedRendererUrl, safeExternalUrl } from '../src/main/lib/window-security'

test('allows only user-facing web and email links outside RavenDock', () => {
  assert.equal(safeExternalUrl('https://example.com/docs'), 'https://example.com/docs')
  assert.equal(safeExternalUrl('mailto:hello@example.com'), 'mailto:hello@example.com')
  assert.equal(safeExternalUrl('javascript:alert(1)'), null)
  assert.equal(safeExternalUrl('file:///Users/example/private.txt'), null)
  assert.equal(safeExternalUrl('data:text/html,hello'), null)
})

test('trusts only the packaged renderer or the configured development origin', () => {
  assert.equal(isTrustedRendererUrl('file:///Applications/RavnDock.app/index.html'), true)
  assert.equal(isTrustedRendererUrl('https://example.com'), false)
  assert.equal(isTrustedRendererUrl('http://localhost:5173/chat', 'http://localhost:5173'), true)
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/chat', 'http://localhost:5173'), false)
})
