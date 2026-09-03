import { useCallback, useEffect, useState } from 'react'
import {
  CHAT_MODEL,
  EMBEDDING_MODEL,
  RERANKER_MODEL,
  DEFAULT_MODEL_PRESETS,
  DEFAULT_INFERENCE_SETTINGS,
  DEFAULT_RAG_SETTINGS,
  type AppSettings,
  type KnowledgeSyncStatus,
  type RuntimeStatus
} from '../../../shared/contracts'
import type { View } from '../types/ui'
import { safeTechnicalDetails } from '../lib/errors'

export function useAppState(): {
  initialized: boolean
  startupError: string | null
  startupProgress: { progress: number; title: string; description: string }
  view: View
  setView: (view: View) => void
  settings: AppSettings
  runtimeStatus: RuntimeStatus | null
  knowledgeSync: KnowledgeSyncStatus
  setKnowledgeFolder: (folder: string) => void
  refreshSettings: () => Promise<void>
  refreshRuntimeStatus: () => Promise<void>
} {
  const [initialized, setInitialized] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [startupProgress, setStartupProgress] = useState({
    progress: 12,
    title: 'Preparing your personal intelligence',
    description: 'Opening your private workspace on this Mac.'
  })
  const [view, setView] = useState<View>('welcome')
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null)
  const [knowledgeSync, setKnowledgeSync] = useState<KnowledgeSyncStatus>({
    active: false,
    knowledgeBaseId: null,
    progress: null
  })
  const [settings, setSettings] = useState<AppSettings>({
    knowledgeFolder: '',
    knowledgeBases: [],
    activeKnowledgeBaseId: '',
    selectedModel: CHAT_MODEL,
    embeddingModel: EMBEDDING_MODEL,
    rerankerModel: RERANKER_MODEL,
    modelPresets: DEFAULT_MODEL_PRESETS,
    rag: DEFAULT_RAG_SETTINGS,
    inference: DEFAULT_INFERENCE_SETTINGS,
    syncStats: {
      indexed: 0,
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      lastSyncedAt: null
    }
  })

  const refreshSettings = useCallback(async (): Promise<void> => {
    setSettings(await window.api.getSettings())
  }, [])

  const refreshRuntimeStatus = useCallback(async (): Promise<void> => {
    setRuntimeStatus(await window.api.getRuntimeStatus())
  }, [])

  useEffect(() => {
    let mounted = true
    let completionTimer: number | null = null
    void window.api
      .getKnowledgeSyncStatus()
      .then((status) => {
        if (mounted) setKnowledgeSync(status)
      })
      .catch(() => undefined)
    const unsubscribe = window.api.onSyncProgress((progress) => {
      setKnowledgeSync((current) => ({
        active: progress.phase !== 'complete' || current.active,
        knowledgeBaseId: current.knowledgeBaseId || null,
        progress
      }))
      if (progress.phase === 'complete') {
        if (completionTimer !== null) window.clearTimeout(completionTimer)
        completionTimer = window.setTimeout(() => {
          void window.api
            .getKnowledgeSyncStatus()
            .then((status) => {
              if (mounted) setKnowledgeSync(status)
            })
            .catch(() => undefined)
        }, 250)
      }
    })
    const settingsRequest = window.api.getSettings().then((saved) => {
      setStartupProgress({
        progress: 48,
        title: 'Preparing your personal intelligence',
        description: 'Loading your knowledge bases and preferences.'
      })
      return saved
    })
    const runtimeRequest = window.api.getRuntimeStatus().then((status) => {
      setStartupProgress({
        progress: 78,
        title: 'Preparing your personal intelligence',
        description: 'Checking the local AI tools that answer your questions.'
      })
      return status
    })
    void Promise.all([settingsRequest, runtimeRequest])
      .then(([savedSettings, status]) => {
        setSettings(savedSettings)
        setRuntimeStatus(status)
        setStartupProgress({
          progress: 100,
          title: 'Your workspace is ready',
          description: 'Everything is prepared on this Mac.'
        })
      })
      .catch((error: unknown) => {
        setStartupError(safeTechnicalDetails(error) ?? 'RavnDock could not start.')
      })
      .finally(() => setInitialized(true))
    return () => {
      mounted = false
      if (completionTimer !== null) window.clearTimeout(completionTimer)
      unsubscribe()
    }
  }, [])

  const setKnowledgeFolder = (folder: string): void => {
    setSettings((current) =>
      current.knowledgeFolder === folder
        ? current
        : {
            ...current,
            knowledgeFolder: folder,
            syncStats: {
              indexed: 0,
              added: 0,
              updated: 0,
              removed: 0,
              unchanged: 0,
              skipped: 0,
              failed: 0,
              lastSyncedAt: null
            }
          }
    )
  }

  return {
    initialized,
    startupError,
    startupProgress,
    view,
    setView,
    settings,
    runtimeStatus,
    knowledgeSync,
    setKnowledgeFolder,
    refreshSettings,
    refreshRuntimeStatus
  }
}
