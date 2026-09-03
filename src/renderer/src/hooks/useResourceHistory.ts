import { useCallback, useEffect, useRef, useState } from 'react'
import type { ResourceMetrics } from '../../../shared/contracts'
import { friendlyActionError } from '../lib/errors'

export interface ResourceHistoryPoint {
  sampledAt: string
  cpu: number
  memory: number
  gpu: number
}

const MAX_HISTORY = 30

export function useResourceHistory(): {
  metrics: ResourceMetrics | null
  history: ResourceHistoryPoint[]
  error: string | null
  refreshing: boolean
  refresh: () => Promise<void>
} {
  const [metrics, setMetrics] = useState<ResourceMetrics | null>(null)
  const [history, setHistory] = useState<ResourceHistoryPoint[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const refreshInFlight = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    try {
      const next = await window.api.getResourceMetrics()
      setMetrics(next)
      setHistory((current) => [
        ...current.slice(-(MAX_HISTORY - 1)),
        {
          sampledAt: next.sampledAt,
          cpu: next.system.cpuPercent,
          memory: next.system.memoryPercent,
          gpu: next.gpu.percent ?? 0
        }
      ])
      setError(null)
    } catch (reason) {
      setError(friendlyActionError(reason, 'Resource data is not available.'))
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const interval = window.setInterval(() => void refresh(), 2_000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [refresh])

  return { metrics, history, error, refreshing, refresh }
}
