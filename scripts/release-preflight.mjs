import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/* eslint-disable @typescript-eslint/explicit-function-return-type */

const strict = process.argv.includes('--strict')
const blockers = []
const warnings = []

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' })
}

function requireFile(file) {
  if (!existsSync(file)) blockers.push(`Missing ${file}.`)
}

for (const file of [
  'build/icon.icns',
  'build/icon.png',
  'build/PrivacyInfo.xcprivacy',
  'build/entitlements.mac.plist',
  'build/entitlements.mac.inherit.plist'
]) {
  requireFile(file)
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const builderConfig = readFileSync('electron-builder.yml', 'utf8')
if (packageJson.productName !== 'RavnDock') blockers.push('productName must be RavnDock.')
if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
  blockers.push('package.json version must use three parts, such as 1.1.0.')
}
if (!builderConfig.includes('entitlements: build/entitlements.mac.plist')) {
  blockers.push('Configure main-process macOS entitlements.')
}
if (!builderConfig.includes('entitlementsInherit: build/entitlements.mac.inherit.plist')) {
  blockers.push('Configure inherited macOS entitlements.')
}
if (builderConfig.includes('allow-dyld-environment-variables')) {
  blockers.push('Remove the debug-only DYLD entitlement from production configuration.')
}

if (process.platform !== 'darwin') {
  blockers.push('A distributable macOS release must be built on macOS.')
} else {
  if (run('hdiutil', ['help']).status !== 0) blockers.push('Install macOS disk image tools.')
}

warnings.push('This release is intentionally unsigned and will show a macOS first-launch warning.')

console.log('RavnDock unsigned public DMG preflight')
for (const warning of warnings) console.log(`WARN: ${warning}`)
for (const blocker of blockers) console.log(`BLOCKED: ${blocker}`)
if (blockers.length === 0) console.log('READY: Unsigned public DMG prerequisites are present.')
else console.log(`SUMMARY: ${blockers.length} blocking item(s) remain.`)

if (strict && blockers.length > 0) process.exit(1)
