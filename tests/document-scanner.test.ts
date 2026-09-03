import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { scanDocumentFolder, scanDocumentMetadata } from '../src/main/lib/document-scanner'

test('scans supported files recursively and skips hidden, temporary, and unsupported files', async (): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), 'pocketrag-scanner-'))
  await mkdir(path.join(root, 'nested'))
  await mkdir(path.join(root, '.hidden'))
  await writeFile(path.join(root, 'policy.pdf'), 'pdf fixture')
  await writeFile(path.join(root, 'nested', 'notes.MD'), 'notes fixture')
  await writeFile(path.join(root, 'image.png'), 'image fixture')
  await writeFile(path.join(root, 'archive.zip'), 'unsupported')
  await writeFile(path.join(root, '~$draft.docx'), 'temporary')
  await writeFile(path.join(root, '.hidden', 'secret.txt'), 'hidden')
  await symlink(path.join(root, 'policy.pdf'), path.join(root, 'linked.pdf'))

  const result = await scanDocumentFolder(root)

  assert.deepEqual(
    result.files.map((file) => file.relativePath),
    ['image.png', 'nested/notes.MD', 'policy.pdf']
  )
  assert.equal(result.skipped, 4)
  assert.match(result.files[0].checksum, /^[a-f0-9]{64}$/)

  const metadata = await scanDocumentMetadata(root)
  assert.deepEqual(metadata.map((file) => file.relativePath).sort(), [
    'image.png',
    'nested/notes.MD',
    'policy.pdf'
  ])
  assert.ok(metadata.every((file) => file.size > 0 && file.modifiedAt > 0))
})
