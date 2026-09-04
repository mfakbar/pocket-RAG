import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings } from '../../../shared/contracts'

const BACK_MESSAGE = 'ravndock:rag-explainer-back'

export default function RagExplainerView({
  settings,
  onBack
}: {
  settings: AppSettings
  onBack: () => void
}): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ||
    document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light'
  )
  const explainerUrl = useMemo(() => {
    const url = new URL('rag-behind-the-scenes.html', window.location.href)
    url.searchParams.set('embedded', 'true')
    url.searchParams.set('embeddingModel', settings.embeddingModel)
    url.searchParams.set('rerankerModel', settings.rerankerModel)
    url.searchParams.set('rerankerEnabled', settings.rag.improveDocumentMatching ? 'true' : 'false')
    return url.toString()
  }, [settings.embeddingModel, settings.rerankerModel, settings.rag.improveDocumentMatching])

  useEffect(() => {
    const root = document.documentElement
    const syncTheme = (): void => {
      setTheme(root.dataset.theme === 'dark' || root.classList.contains('dark') ? 'dark' : 'light')
    }
    const observer = new MutationObserver(syncTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    syncTheme()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: 'ravndock:theme', theme }, '*')
  }, [theme])

  useEffect(() => {
    const handleMessage = (event: MessageEvent): void => {
      if (event.source !== frameRef.current?.contentWindow) return
      if (event.data?.type === BACK_MESSAGE) onBack()
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [onBack])

  return (
    <iframe
      ref={frameRef}
      className="h-full w-full border-0 bg-background"
      src={explainerUrl}
      title="RAG Behind the Scenes"
      onLoad={() =>
        frameRef.current?.contentWindow?.postMessage({ type: 'ravndock:theme', theme }, '*')
      }
    />
  )
}
