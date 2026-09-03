import { app } from 'electron'

let stopAccess: (() => void) | null = null

export function useKnowledgeFolderBookmark(bookmark: string): boolean {
  stopAccess?.()
  stopAccess = null
  if (!bookmark || process.platform !== 'darwin') return false

  try {
    const stop = app.startAccessingSecurityScopedResource(bookmark)
    stopAccess = typeof stop === 'function' ? () => stop() : null
    return true
  } catch {
    return false
  }
}

export function stopKnowledgeFolderAccess(): void {
  stopAccess?.()
  stopAccess = null
}
