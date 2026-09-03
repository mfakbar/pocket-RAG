const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

export function safeExternalUrl(value: string): string | null {
  if (!value || value.length > 2_048) return null
  try {
    const url = new URL(value)
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

export function isTrustedRendererUrl(value: string, developmentUrl?: string): boolean {
  try {
    const url = new URL(value)
    if (!developmentUrl) return url.protocol === 'file:'
    const developmentOrigin = new URL(developmentUrl).origin
    return url.origin === developmentOrigin
  } catch {
    return false
  }
}
