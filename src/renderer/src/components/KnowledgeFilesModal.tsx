import { ChevronLeft, ChevronRight, FileText, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { KnowledgeBase, KnowledgeFile } from '../../../shared/contracts'
import { formatBytes, formatDateTime } from '../lib/format'
import { Modal } from './ui/Modal'

export function KnowledgeFilesModal({
  open,
  knowledgeBase,
  onClose
}: {
  open: boolean
  knowledgeBase: KnowledgeBase | null
  onClose: () => void
}): React.JSX.Element {
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [loadedKnowledgeBaseId, setLoadedKnowledgeBaseId] = useState('')
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(0)

  useEffect(() => {
    if (!open || !knowledgeBase) return
    let current = true
    void window.api
      .listKnowledgeFiles(knowledgeBase.id)
      .then((next) => {
        if (current) setFiles(next)
      })
      .catch(() => {
        if (current) setFiles([])
      })
      .finally(() => {
        if (current) setLoadedKnowledgeBaseId(knowledgeBase.id)
      })
    return () => {
      current = false
    }
  }, [knowledgeBase, open])

  const loading = Boolean(open && knowledgeBase && loadedKnowledgeBaseId !== knowledgeBase.id)
  const pageCount = Math.max(1, Math.ceil(files.length / pageSize))
  const visiblePage = Math.min(page, pageCount - 1)
  const visibleFiles = useMemo(
    () => files.slice(visiblePage * pageSize, (visiblePage + 1) * pageSize),
    [files, pageSize, visiblePage]
  )

  const close = (): void => {
    setPage(0)
    onClose()
  }

  return (
    <Modal
      open={open}
      title={knowledgeBase ? `Files in ${knowledgeBase.name}` : 'Knowledge-base files'}
      description="These are the local files RavnDock can search and cite."
      onClose={close}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading your files...
          </div>
        ) : visibleFiles.length === 0 ? (
          <p className="py-12 text-center text-xs text-muted-foreground">
            No documents are ready yet.
          </p>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {visibleFiles.map((file) => (
              <div key={file.path} className="flex items-center gap-3 py-3">
                <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground" title={file.path}>
                    {file.name}
                  </p>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                    {file.path === file.name ? 'Selected folder' : file.path}
                  </p>
                </div>
                <div className="flex-shrink-0 text-right text-[10px] text-muted-foreground">
                  <p>
                    {formatBytes(file.sizeBytes, {
                      unavailable: 'Size unavailable',
                      zero: 'Size unavailable'
                    })}
                  </p>
                  <p className="mt-0.5">Synced {formatDateTime(file.syncedAt)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <footer className="flex flex-shrink-0 items-center justify-between gap-4 border-t border-white/[0.08] px-5 py-3">
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          Show
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value))
              setPage(0)
            }}
            className="rounded-md border border-white/10 bg-input px-2 py-1 text-xs text-foreground"
          >
            {[10, 20, 30].map((amount) => (
              <option key={amount} value={amount}>
                {amount}
              </option>
            ))}
          </select>
          of {files.length}
        </label>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            Page {visiblePage + 1} of {pageCount}
          </span>
          <button
            type="button"
            disabled={visiblePage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            title="Previous page"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={visiblePage >= pageCount - 1}
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            title="Next page"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </footer>
    </Modal>
  )
}
