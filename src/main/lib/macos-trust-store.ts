import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const KEYCHAINS = [
  '/Library/Keychains/System.keychain',
  '/System/Library/Keychains/SystemRootCertificates.keychain'
]

export function ensureMacOsTrustStore(cacheDirectory: string): string | undefined {
  if (process.platform !== 'darwin') return undefined

  const certificatePath = path.join(cacheDirectory, 'macos-trusted-certificates.pem')
  if (existsSync(certificatePath)) return certificatePath

  try {
    const certificates = KEYCHAINS.flatMap((keychain) => {
      try {
        return [
          execFileSync('security', ['find-certificate', '-a', '-p', keychain], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          })
        ]
      } catch {
        return []
      }
    }).filter(Boolean)
    if (certificates.length === 0) return undefined

    mkdirSync(cacheDirectory, { recursive: true })
    writeFileSync(certificatePath, certificates.join('\n'), { mode: 0o600 })
    return certificatePath
  } catch {
    return undefined
  }
}
