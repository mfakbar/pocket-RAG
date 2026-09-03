import { useEffect, useMemo, useRef } from 'react'
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
  const explainerUrl = useMemo(() => {
    const url = new URL('rag-behind-the-scenes.html', window.location.href)
    url.searchParams.set('embedded', 'true')
    url.searchParams.set('embeddingModel', settings.embeddingModel)
    url.searchParams.set('rerankerModel', settings.rerankerModel)
    url.searchParams.set('rerankerEnabled', settings.rag.improveDocumentMatching ? 'true' : 'false')
    return url.toString()
  }, [settings.embeddingModel, settings.rerankerModel, settings.rag.improveDocumentMatching])

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
      allowFullScreen
    />
  )
}
