import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/* eslint-disable @typescript-eslint/explicit-function-return-type */

const strict = process.argv.includes('--strict')
const development = process.argv.includes('--development')
const blockers = []
const warnings = []

function command(commandName, args) {
  return spawnSync(commandName, args, { encoding: 'utf8' })
}

function requireFile(file) {
  if (!existsSync(file)) blockers.push(`Missing ${file}`)
}

for (const file of [
  'build/icon.icns',
  'build/icon.png',
  'build/PrivacyInfo.xcprivacy',
  'build/entitlements.mas.plist',
  'build/entitlements.mas.inherit.plist'
]) {
  requireFile(file)
}

if (existsSync('build/icon.png') && process.platform === 'darwin') {
  const iconSize = command('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', 'build/icon.png'])
  if (
    !iconSize.stdout.includes('pixelWidth: 1024') ||
    !iconSize.stdout.includes('pixelHeight: 1024')
  ) {
    blockers.push(
      'Replace build/icon.png and build/icon.icns with a complete 1024x1024 App Store icon set.'
    )
  }
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const builderConfig = readFileSync('electron-builder.yml', 'utf8')
const appId = builderConfig.match(/^appId:\s*(.+)$/m)?.[1]?.trim() ?? ''
if (!appId || ['com.pocketrag.app', 'com.pocketai.app'].includes(appId)) {
  blockers.push(
    'Replace the placeholder Bundle ID with the explicit App ID registered to your Apple team.'
  )
}
if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
  blockers.push('package.json version must use three parts, such as 1.0.0.')
}

if (!existsSync('build/runtime/ollama') || !existsSync('build/runtime/rag-backend')) {
  blockers.push(
    'Bundle the pinned Ollama and RAG executables under build/runtime; App Store builds cannot download executable code at first run.'
  )
}

if (process.platform !== 'darwin') {
  blockers.push('Mac App Store packages must be built on macOS.')
} else {
  if (command('xcrun', ['--find', 'productbuild']).status !== 0) {
    blockers.push('Install the current Xcode command-line tools.')
  }
  const identities = command('security', ['find-identity', '-v', '-p', 'codesigning'])
  const identityText = `${identities.stdout}\n${identities.stderr}`
  const expected = development ? 'Apple Development' : 'Apple Distribution'
  if (!identityText.includes(expected)) {
    blockers.push(`Install an ${expected} signing certificate.`)
  }
}

if (!process.env.CSC_NAME) {
  warnings.push('CSC_NAME is not set; electron-builder will try certificate auto-discovery.')
}
const profile = development
  ? 'build/RavenDock-Development.provisionprofile'
  : 'build/RavenDock.provisionprofile'
if (!existsSync(profile)) {
  blockers.push(`Install the matching profile at ${profile}.`)
}

console.log('RavenDock Mac App Store preflight')
for (const warning of warnings) console.log(`WARN: ${warning}`)
for (const blocker of blockers) console.log(`BLOCKED: ${blocker}`)
if (blockers.length === 0) console.log('READY: Packaging prerequisites are present.')
else console.log(`SUMMARY: ${blockers.length} blocking item(s) remain.`)

if (strict && blockers.length > 0) process.exit(1)
