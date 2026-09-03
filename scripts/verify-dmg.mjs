import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/* eslint-disable @typescript-eslint/explicit-function-return-type */

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit' })
}

const distDirectory = 'dist'
const dmg = readdirSync(distDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /^RavnDock-.*\.dmg$/.test(entry.name))
  .map((entry) => join(distDirectory, entry.name))
  .sort()
  .at(-1)

if (!dmg) {
  console.error('No RavnDock DMG found in dist/. Build a release DMG first.')
  process.exit(1)
}

if (process.platform !== 'darwin') {
  console.error('DMG verification must run on macOS.')
  process.exit(1)
}

const imageInfo = run('hdiutil', ['imageinfo', dmg])
if (imageInfo.status !== 0) process.exit(imageInfo.status ?? 1)

console.log(
  'Unsigned DMG structure verified. Gatekeeper signing and notarization are intentionally not expected.'
)
console.log(`Verified ${dmg}.`)
